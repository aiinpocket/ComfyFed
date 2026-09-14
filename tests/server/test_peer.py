"""Tests for `peer`: P2P grant issuance/verification and bandwidth booking
(Phase 3.1 addendum), plus the chunk-hash storage `model_manifest.record_hash`
gained alongside it.
"""

import hashlib
import json
import secrets
import time

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey, VerifyKey

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, db, model_manifest, peer, security


def _sha(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


def _bytes(gb: float) -> int:
    return round(gb * (1024 ** 3))


@pytest.fixture(autouse=True)
def _clear_grant_book():
    """`peer._grants` is module-level, process-lifetime state (same pattern
    as `workers._seen_nonces`) -- reset it so one test's grants can never
    leak into another's "fewest active grants" tiebreak."""
    peer._grants.clear()
    yield
    peer._grants.clear()


@pytest.fixture()
def client(tmp_path):
    d = str(tmp_path)
    result = bootstrap.ensure_installed(d, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(d)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = d
    return c


def _login(client):
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _register_worker(client, csrf, name):
    sk = SigningKey.generate()
    pubkey_hex = bytes(sk.verify_key).hex()
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post("/api/agent/register", json={"token": token, "name": name, "pubkey": pubkey_hex})
    return reg.json()["worker_id"], sk


def _agent_post(client, worker_id, signing_key, path, body: dict):
    body_bytes = json.dumps(body).encode()
    ts = str(int(time.time()))
    nonce = secrets.token_hex(8)
    message = f"POST\n{path}\n{ts}\n{nonce}\n".encode() + body_bytes
    sig = signing_key.sign(message).signature.hex()
    return client.post(
        path,
        content=body_bytes,
        headers={
            "Content-Type": "application/json",
            "X-Worker-Id": worker_id,
            "X-Ts": ts,
            "X-Nonce": nonce,
            "X-Sig": sig,
        },
    )


def _make_online_seeder(
    client,
    csrf,
    name,
    *,
    model_name="checkpoints/model.safetensors",
    size_bytes=_bytes(1.0),
    sha256=None,
    chunk_sha256s=None,
    protocol=4,
    peer_url="http://10.0.0.5:8850",
    status="online",
    disabled=False,
):
    """Register a worker and, via a direct DB write (there's no HTTP surface
    for hello/heartbeat in these tests), give it the online/protocol/peer_url/
    inventory shape `peer.online_seeders` looks for."""
    sha256 = sha256 or _sha(name)
    worker_id, sk = _register_worker(client, csrf, name)
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = status
        worker.protocol = protocol
        worker.peer_url = peer_url
        worker.disabled = disabled
        worker.model_inventory = json.dumps(
            [{"name": model_name, "size_bytes": size_bytes, "sha256": sha256}]
        )
        session.commit()
    model_manifest.record_hash(worker_id, model_name, size_bytes, sha256, chunk_sha256s)
    return worker_id, sk


# --- sign_grant / verify_grant ---------------------------------------------


def _grant_fields(**overrides):
    grant = {
        "grant_id": "g1",
        "name": "checkpoints/model.safetensors",
        "size_bytes": _bytes(1.0),
        "sha256": _sha("model"),
        "seeder_id": "seeder-1",
        "puller_id": "puller-1",
        "expires_at": int(time.time()) + peer.GRANT_TTL_SECONDS,
    }
    grant.update(overrides)
    return grant


def test_sign_grant_rejects_a_field_containing_the_delimiter():
    sk = SigningKey.generate()
    with pytest.raises(ValueError):
        peer.sign_grant(sk, _grant_fields(name="evil|name"))


def test_verify_grant_accepts_a_genuine_signature():
    sk = SigningKey.generate()
    grant = _grant_fields()
    sig = peer.sign_grant(sk, grant)
    assert peer.verify_grant(sk.verify_key, grant, sig) is True


def test_verify_grant_rejects_a_tampered_field():
    sk = SigningKey.generate()
    grant = _grant_fields()
    sig = peer.sign_grant(sk, grant)
    tampered = {**grant, "puller_id": "someone-else"}
    assert peer.verify_grant(sk.verify_key, tampered, sig) is False


def test_verify_grant_rejects_a_signature_from_the_wrong_key():
    sk = SigningKey.generate()
    other = SigningKey.generate()
    grant = _grant_fields()
    sig = peer.sign_grant(other, grant)
    assert peer.verify_grant(sk.verify_key, grant, sig) is False


def test_verify_grant_rejects_malformed_hex():
    sk = SigningKey.generate()
    grant = _grant_fields()
    assert peer.verify_grant(sk.verify_key, grant, "not-hex") is False


# --- online_seeders ----------------------------------------------------


def test_online_seeders_empty_when_no_consensus_hash(client):
    with db.get_session() as session:
        assert peer.online_seeders(session, "checkpoints/model.safetensors", _bytes(1.0)) == []


def test_online_seeders_excludes_conflicted_hash(client):
    csrf = _login(client)
    _make_online_seeder(client, csrf, "seeder-1", sha256=_sha("a"))
    model_manifest.record_hash("someone-else", "checkpoints/model.safetensors", _bytes(1.0), _sha("b"))

    with db.get_session() as session:
        assert peer.online_seeders(session, "checkpoints/model.safetensors", _bytes(1.0)) == []


def test_online_seeders_excludes_offline_disabled_low_protocol_and_no_peer_url(client):
    csrf = _login(client)
    sha = _sha("model")
    _make_online_seeder(client, csrf, "s-offline", sha256=sha, status="offline")
    _make_online_seeder(client, csrf, "s-disabled", sha256=sha, disabled=True)
    _make_online_seeder(client, csrf, "s-old-protocol", sha256=sha, protocol=3)
    _make_online_seeder(client, csrf, "s-no-peer-url", sha256=sha, peer_url=None)
    good_id, _ = _make_online_seeder(client, csrf, "s-good", sha256=sha)

    with db.get_session() as session:
        seeders = peer.online_seeders(session, "checkpoints/model.safetensors", _bytes(1.0))
    assert [w.id for w in seeders] == [good_id]


def test_online_seeders_excludes_worker_with_wrong_size_or_hash(client):
    """A worker whose OWN inventory entry disagrees with the learned
    consensus hash (without ever reporting that disagreement through
    `record_hash`, so the row itself is never conflicted) must not count as
    a seeder -- `online_seeders` checks each candidate's inventory entry
    against the consensus row, not just whether a (name, size_bytes) row
    exists.
    """
    csrf = _login(client)
    sha = _sha("model")
    good_id, _ = _make_online_seeder(client, csrf, "s-good", sha256=sha)

    wrong_id, _ = _register_worker(client, csrf, "s-wrong-hash")
    with db.get_session() as session:
        worker = session.get(db.Worker, wrong_id)
        worker.status = "online"
        worker.protocol = 4
        worker.peer_url = "http://9.9.9.9:8850"
        worker.model_inventory = json.dumps(
            [{"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0), "sha256": _sha("different")}]
        )
        session.commit()

    with db.get_session() as session:
        seeders = peer.online_seeders(session, "checkpoints/model.safetensors", _bytes(1.0))
    assert [w.id for w in seeders] == [good_id]


# --- POST /api/agent/peer-grant --------------------------------------------


def test_peer_grant_requires_agent_signature(client):
    r = client.post("/api/agent/peer-grant", json={"name": "x", "size_bytes": 1})
    assert r.status_code == 401


def test_peer_grant_404_no_model_when_no_consensus_hash(client):
    csrf = _login(client)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "peer.no_model"


def test_peer_grant_404_no_seeder_when_none_online(client):
    csrf = _login(client)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")
    model_manifest.record_hash("someone", "checkpoints/model.safetensors", _bytes(1.0), _sha("model"))

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "peer.no_seeder"


def test_peer_grant_excludes_the_requester_itself_as_seeder(client):
    """The only worker with the file is the requester itself: no seeder."""
    csrf = _login(client)
    sha = _sha("model")
    puller_id, puller_sk = _make_online_seeder(client, csrf, "puller", sha256=sha)

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "peer.no_seeder"


def test_peer_grant_happy_path_shape_and_signature(client):
    csrf = _login(client)
    sha = _sha("model")
    seeder_id, _ = _make_online_seeder(
        client, csrf, "seeder", sha256=sha, chunk_sha256s=[_sha("c0"), _sha("c1")], peer_url="http://1.2.3.4:9000"
    )
    puller_id, puller_sk = _register_worker(client, csrf, "puller")

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 200
    body = r.json()

    assert body["peer_url"] == "http://1.2.3.4:9000"
    assert body["chunk_sha256s"] == [_sha("c0"), _sha("c1")]

    grant = body["grant"]
    assert grant["name"] == "checkpoints/model.safetensors"
    assert grant["size_bytes"] == _bytes(1.0)
    assert grant["sha256"] == sha
    assert grant["seeder_id"] == seeder_id
    assert grant["puller_id"] == puller_id
    assert grant["expires_at"] > int(time.time())
    assert grant["grant_id"]

    _, verify_key = security.load_platform_keys(client.data_dir)
    fields = {k: grant[k] for k in peer._GRANT_FIELDS}
    assert peer.verify_grant(verify_key, fields, grant["sig"]) is True

    tampered = {**fields, "seeder_id": "someone-else"}
    assert peer.verify_grant(verify_key, tampered, grant["sig"]) is False


def test_peer_grant_chunk_sha256s_null_when_not_established(client):
    csrf = _login(client)
    sha = _sha("model")
    _make_online_seeder(client, csrf, "seeder", sha256=sha, chunk_sha256s=None)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 200
    assert r.json()["chunk_sha256s"] is None


def test_peer_grant_expiry_is_ttl_seconds_ahead(client):
    csrf = _login(client)
    sha = _sha("model")
    _make_online_seeder(client, csrf, "seeder", sha256=sha)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")

    before = int(time.time())
    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    after = int(time.time())
    expires_at = r.json()["grant"]["expires_at"]
    assert before + peer.GRANT_TTL_SECONDS <= expires_at <= after + peer.GRANT_TTL_SECONDS


def test_peer_grant_picks_seeder_with_fewest_active_grants_then_name(client):
    csrf = _login(client)
    sha = _sha("model")
    # Two seeders, same file. "seeder-a" sorts first by name but will carry
    # an active (unexpired, unbooked) grant already -- "seeder-b" must win.
    seeder_a, _ = _make_online_seeder(client, csrf, "seeder-a", sha256=sha)
    seeder_b, _ = _make_online_seeder(client, csrf, "seeder-b", sha256=sha)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")
    other_puller_id, other_puller_sk = _register_worker(client, csrf, "other-puller")

    first = _agent_post(
        client, other_puller_id, other_puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert first.status_code == 200
    assert first.json()["grant"]["seeder_id"] == seeder_a  # tiebreak by name first

    second = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert second.status_code == 200
    assert second.json()["grant"]["seeder_id"] == seeder_b  # seeder-a now has 1 active grant


# --- POST /api/agent/peer-served -------------------------------------------


def _issue_grant(client, csrf, *, size_bytes=_bytes(1.0)):
    sha = _sha("model")
    seeder_id, seeder_sk = _make_online_seeder(client, csrf, "seeder", sha256=sha, size_bytes=size_bytes)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")
    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": size_bytes},
    )
    assert r.status_code == 200
    return r.json()["grant"], seeder_id, seeder_sk, puller_id, puller_sk


def test_peer_served_requires_agent_signature(client):
    r = client.post("/api/agent/peer-served", json={"grant_id": "x", "bytes_served": 1})
    assert r.status_code == 401


def test_peer_served_happy_path_creates_a_p2p_upload_receipt(client):
    csrf = _login(client)
    grant, seeder_id, seeder_sk, _, _ = _issue_grant(client, csrf)

    r = _agent_post(
        client, seeder_id, seeder_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": _bytes(1.0)},
    )
    assert r.status_code == 200
    receipt_id = r.json()["receipt_id"]

    with db.get_session() as session:
        receipt = session.get(db.Receipt, receipt_id)
        assert receipt.kind == "p2p_upload"
        assert receipt.billable is False
        assert receipt.gpu_seconds == 0.0
        assert receipt.job_id is None
        assert receipt.worker_id == seeder_id
        assert receipt.bytes == _bytes(1.0)
        assert receipt.worker_sig is None
        assert receipt.platform_sig

    _, verify_key = security.load_platform_keys(client.data_dir)
    payload = f"p2p_upload|{grant['grant_id']}|{seeder_id}|{_bytes(1.0)}"
    verify_key.verify(payload.encode(), bytes.fromhex(receipt.platform_sig))


def test_peer_served_404_unknown_grant(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    r = _agent_post(
        client, worker_id, sk, "/api/agent/peer-served",
        {"grant_id": "does-not-exist", "bytes_served": 100},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "peer.no_grant"


def test_peer_served_403_wrong_seeder(client):
    csrf = _login(client)
    grant, seeder_id, seeder_sk, puller_id, puller_sk = _issue_grant(client, csrf)

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": _bytes(1.0)},
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "peer.not_seeder"


def test_peer_served_dedupe_already_booked(client):
    csrf = _login(client)
    grant, seeder_id, seeder_sk, _, _ = _issue_grant(client, csrf)

    first = _agent_post(
        client, seeder_id, seeder_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": _bytes(1.0)},
    )
    assert first.status_code == 200

    second = _agent_post(
        client, seeder_id, seeder_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": _bytes(1.0)},
    )
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "peer.already_booked"


def test_peer_served_rejects_zero_or_negative_bytes(client):
    csrf = _login(client)
    grant, seeder_id, seeder_sk, _, _ = _issue_grant(client, csrf)

    r = _agent_post(
        client, seeder_id, seeder_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": 0},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "peer.bad_bytes"


def test_peer_served_rejects_bytes_far_beyond_size_with_slack(client):
    csrf = _login(client)
    size_bytes = _bytes(1.0)
    grant, seeder_id, seeder_sk, _, _ = _issue_grant(client, csrf, size_bytes=size_bytes)

    within_slack = int(size_bytes * 1.05)
    ok = _agent_post(
        client, seeder_id, seeder_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": within_slack},
    )
    assert ok.status_code == 200


def test_peer_served_rejects_bytes_beyond_slack(client):
    csrf = _login(client)
    size_bytes = _bytes(1.0)
    grant, seeder_id, seeder_sk, _, _ = _issue_grant(client, csrf, size_bytes=size_bytes)

    r = _agent_post(
        client, seeder_id, seeder_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": size_bytes * 2},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "peer.bad_bytes"


# --- chunk_sha256s persistence (model_manifest.record_hash) ----------------


def test_record_hash_stores_chunk_list_on_first_report(client):
    model_manifest.record_hash(
        "w1", "checkpoints/a.safetensors", _bytes(1.0), _sha("a"), [_sha("c0"), _sha("c1")]
    )
    with db.get_session() as session:
        row = session.get(db.ModelHash, ("checkpoints/a.safetensors", _bytes(1.0)))
        assert json.loads(row.chunk_sha256s) == [_sha("c0"), _sha("c1")]


def test_record_hash_establishes_chunk_list_on_a_later_agreeing_report(client):
    model_manifest.record_hash("w1", "checkpoints/a.safetensors", _bytes(1.0), _sha("a"))
    model_manifest.record_hash(
        "w2", "checkpoints/a.safetensors", _bytes(1.0), _sha("a"), [_sha("c0"), _sha("c1")]
    )
    with db.get_session() as session:
        row = session.get(db.ModelHash, ("checkpoints/a.safetensors", _bytes(1.0)))
        assert json.loads(row.chunk_sha256s) == [_sha("c0"), _sha("c1")]


def test_record_hash_never_overwrites_an_existing_chunk_list(client, caplog):
    model_manifest.record_hash(
        "w1", "checkpoints/a.safetensors", _bytes(1.0), _sha("a"), [_sha("c0"), _sha("c1")]
    )
    import logging

    with caplog.at_level(logging.WARNING, logger="comfyfed_server.model_manifest"):
        model_manifest.record_hash(
            "w2", "checkpoints/a.safetensors", _bytes(1.0), _sha("a"), [_sha("different")]
        )

    with db.get_session() as session:
        row = session.get(db.ModelHash, ("checkpoints/a.safetensors", _bytes(1.0)))
        assert json.loads(row.chunk_sha256s) == [_sha("c0"), _sha("c1")]

    assert any("chunk_sha256s mismatch" in r.message for r in caplog.records)


def test_record_hash_conflicting_whole_file_hash_does_not_store_chunks(client):
    model_manifest.record_hash("w1", "checkpoints/a.safetensors", _bytes(1.0), _sha("a"))
    model_manifest.record_hash(
        "w2", "checkpoints/a.safetensors", _bytes(1.0), _sha("b"), [_sha("c0")]
    )
    with db.get_session() as session:
        row = session.get(db.ModelHash, ("checkpoints/a.safetensors", _bytes(1.0)))
        assert row.conflict is True
        assert row.chunk_sha256s is None
