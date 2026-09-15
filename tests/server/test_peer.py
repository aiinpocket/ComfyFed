"""Tests for `peer`: P2P grant issuance/verification and bandwidth booking
(Phase 3.1 addendum), plus the chunk-hash storage `model_manifest.record_hash`
gained alongside it.
"""

import hashlib
import json
import secrets
import threading
import time

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey, VerifyKey

from comfyfed_server import app as app_module
from comfyfed_server import agentws, bootstrap, db, model_manifest, peer, security


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


def test_verify_grant_rejects_an_expired_grant():
    sk = SigningKey.generate()
    grant = _grant_fields(expires_at=int(time.time()) - 1)
    sig = peer.sign_grant(sk, grant)
    assert peer.verify_grant(sk.verify_key, grant, sig) is False


def test_verify_grant_never_raises_on_malformed_input():
    sk = SigningKey.generate()
    # Missing required keys.
    assert peer.verify_grant(sk.verify_key, {"grant_id": "g1"}, "deadbeef") is False
    # Wrong type entirely.
    assert peer.verify_grant(sk.verify_key, "not-a-dict", "deadbeef") is False
    # int-shaped field holding a string.
    bad = _grant_fields(size_bytes="not-an-int")
    assert peer.verify_grant(sk.verify_key, bad, "deadbeef") is False
    # int-shaped field holding a bool (bool is technically an int subclass).
    bad_bool = _grant_fields(expires_at=True)
    assert peer.verify_grant(sk.verify_key, bad_bool, "deadbeef") is False


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


def test_online_seeders_excludes_offline_low_protocol_and_no_peer_url(client):
    csrf = _login(client)
    sha = _sha("model")
    _make_online_seeder(client, csrf, "s-offline", sha256=sha, status="offline")
    _make_online_seeder(client, csrf, "s-old-protocol", sha256=sha, protocol=3)
    _make_online_seeder(client, csrf, "s-no-peer-url", sha256=sha, peer_url=None)
    good_id, _ = _make_online_seeder(client, csrf, "s-good", sha256=sha)

    with db.get_session() as session:
        seeders = peer.online_seeders(session, "checkpoints/model.safetensors", _bytes(1.0))
    assert [w.id for w in seeders] == [good_id]


def test_online_seeders_includes_disabled_but_online_worker(client):
    """Spec: 種子資格與 worker 停用狀態脫鉤 -- disabling a worker (parking it from
    job dispatch) must NOT stop it from seeding models it already holds."""
    csrf = _login(client)
    sha = _sha("model")
    disabled_id, _ = _make_online_seeder(client, csrf, "s-disabled", sha256=sha, disabled=True)

    with db.get_session() as session:
        seeders = peer.online_seeders(session, "checkpoints/model.safetensors", _bytes(1.0))
    assert [w.id for w in seeders] == [disabled_id]


def test_peer_grant_issues_to_a_disabled_but_connected_seeder(client):
    csrf = _login(client)
    sha = _sha("model")
    seeder_id, _ = _make_online_seeder(client, csrf, "seeder", sha256=sha, disabled=True)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 200
    assert r.json()["grant"]["seeder_id"] == seeder_id


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


def test_peer_grant_rejects_requester_that_already_has_the_file(client):
    """Spec: the platform verifies the requester actually lacks the file
    before issuing a grant (拉方確缺此檔). Here the only worker with the file
    is the requester itself, so this is caught by the already-has-model
    check rather than by an empty seeder pool."""
    csrf = _login(client)
    sha = _sha("model")
    puller_id, puller_sk = _make_online_seeder(client, csrf, "puller", sha256=sha)

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "peer.already_has_model"


def test_peer_grant_rejects_requester_that_already_has_the_file_even_with_another_seeder(client):
    """The already-has-model check must fire even when a *different* worker
    is a perfectly valid seeder -- a requester that already has the file has
    no business asking for a grant to fetch it again, regardless of who else
    could serve it."""
    csrf = _login(client)
    sha = _sha("model")
    _make_online_seeder(client, csrf, "other-seeder", sha256=sha)
    puller_id, puller_sk = _make_online_seeder(client, csrf, "puller", sha256=sha)

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "peer.already_has_model"


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


def test_grant_ttl_scales_with_the_file_size():
    """一張授權單至少要撐得過「以 agent 預設上限 20 Mbps 傳完整個檔案」。

    At the agent's default active cap (20 Mbps = 2.5 MB/s) a 6.5 GB model
    takes ~43 min, so a flat 600 s TTL expired ~4x before the transfer ended:
    post-expiry bytes went unaccounted and resumes were refused. Small files
    keep the 600 s floor.
    """
    assert peer.MIN_ASSUMED_RATE_BYTES_PER_SEC == 20_000_000 // 8

    # 6.5 GB: 2600 s at 2.5 MB/s -> 3900 s of transfer slack + 600 s floor.
    big = peer.grant_ttl_seconds(round(6.5 * 1000 ** 3))
    assert big >= 3900

    # A 10 MB model stays at the 600 s baseline (its 4 s transfer estimate
    # adds only a rounding-level 6 s of slack on top of the floor).
    small = peer.grant_ttl_seconds(10 * 1000 ** 2)
    assert peer.GRANT_TTL_SECONDS <= small <= peer.GRANT_TTL_SECONDS + 10

    # Degenerate inputs never drop below the floor.
    assert peer.grant_ttl_seconds(0) == peer.GRANT_TTL_SECONDS
    assert peer.grant_ttl_seconds(-1) == peer.GRANT_TTL_SECONDS

    # Monotonic in size.
    assert peer.grant_ttl_seconds(2 * 1024 ** 3) > peer.grant_ttl_seconds(1024 ** 3)


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
    # Size-scaled now (`grant_ttl_seconds`), not a flat 600 s.
    ttl = peer.grant_ttl_seconds(_bytes(1.0))
    assert ttl > peer.GRANT_TTL_SECONDS
    assert before + ttl <= expires_at <= after + ttl


def test_peer_grant_rejects_a_name_containing_the_payload_delimiter(client):
    """A model name can't normally contain `|` via inventory scanning, but if
    one somehow did, issuance must refuse it with the module's typed 400
    error (matching `sign_grant`'s docstring) rather than let the ValueError
    escape as an unhandled 500."""
    csrf = _login(client)
    name = "checkpoints/evil|name.safetensors"
    sha = _sha("model")
    _make_online_seeder(client, csrf, "seeder", model_name=name, sha256=sha)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": name, "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "peer.invalid_field"


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


# --- M4: expiry-triggered reports must still book within the retention window


def test_peer_served_books_a_grant_reported_after_its_ttl_expired(client):
    """M4 final-review fix: `peerserve.due_for_report` fires an expiry-
    triggered report at/after `expires_at` -- the grant must still be found
    (and bookable) at that moment, not just up to the exact TTL boundary."""
    csrf = _login(client)
    grant, seeder_id, seeder_sk, _, _ = _issue_grant(client, csrf)

    with peer._grant_lock:
        peer._grants[grant["grant_id"]]["expires_at"] = int(time.time()) - 1

    r = _agent_post(
        client, seeder_id, seeder_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": _bytes(1.0)},
    )
    assert r.status_code == 200


def test_peer_served_404s_once_the_retention_window_has_passed(client):
    csrf = _login(client)
    grant, seeder_id, seeder_sk, _, _ = _issue_grant(client, csrf)

    with peer._grant_lock:
        peer._grants[grant["grant_id"]]["expires_at"] = (
            int(time.time()) - peer._GRANT_RETENTION_SECONDS - 1
        )

    r = _agent_post(
        client, seeder_id, seeder_sk, "/api/agent/peer-served",
        {"grant_id": grant["grant_id"], "bytes_served": _bytes(1.0)},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "peer.no_grant"


def test_grant_book_evicts_oldest_entries_beyond_the_cap(client, monkeypatch):
    monkeypatch.setattr(peer, "_MAX_GRANTS", 3)
    now = time.time()
    for i in range(3):
        peer._grants[f"old-{i}"] = {
            "grant_id": f"old-{i}", "name": "x", "size_bytes": 1, "sha256": "s",
            "seeder_id": "s1", "puller_id": "p1", "expires_at": int(now) + 600, "booked": False,
        }

    csrf = _login(client)
    sha = _sha("model")
    _make_online_seeder(client, csrf, "seeder", sha256=sha)
    puller_id, puller_sk = _register_worker(client, csrf, "puller")

    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )
    assert r.status_code == 200
    assert len(peer._grants) == 3
    assert "old-0" not in peer._grants  # oldest evicted first
    assert r.json()["grant"]["grant_id"] in peer._grants


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


def test_peer_served_concurrent_calls_race_only_one_claim_wins(client):
    """RACE: claim (check-not-booked + mark-booked) must be atomic under
    `peer._grant_lock`, taken BEFORE the DB insert -- otherwise two
    concurrent calls for the same grant_id (e.g. a client retry racing the
    original request across the threadpool dispatch) could both observe
    `booked is False` and both insert a receipt. Fire two real requests
    concurrently from separate threads against the same grant and confirm
    exactly one wins (200) and the other is rejected as already-booked
    (409) -- never both succeeding, never both failing.
    """
    csrf = _login(client)
    grant, seeder_id, seeder_sk, _, _ = _issue_grant(client, csrf)

    results = []
    barrier = threading.Barrier(2)

    def call():
        barrier.wait(timeout=5)
        r = _agent_post(
            client, seeder_id, seeder_sk, "/api/agent/peer-served",
            {"grant_id": grant["grant_id"], "bytes_served": _bytes(1.0)},
        )
        results.append(r.status_code)

    threads = [threading.Thread(target=call) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    assert sorted(results) == [200, 409]


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


# --- Grant TTL sized from the seeder's own reported upload cap --------------


class _FakeWorker:
    def __init__(self, hardware):
        self.hardware = hardware


def test_seeder_rate_falls_back_to_the_default_assumption():
    """No reported cap (old agent, both caps unlimited, malformed value) ->
    the 20 Mbps default, i.e. behavior unchanged."""
    for hardware in (
        None,
        "{}",
        "not json",
        json.dumps({"peer_upload_min_mbps": None}),
        json.dumps({"peer_upload_min_mbps": "20"}),
        json.dumps({"peer_upload_min_mbps": 0}),
        json.dumps({"peer_upload_min_mbps": -5}),
        json.dumps({"peer_upload_min_mbps": True}),
    ):
        assert (
            peer._seeder_rate_bytes_per_sec(_FakeWorker(hardware))
            == peer.MIN_ASSUMED_RATE_BYTES_PER_SEC
        )


def test_seeder_rate_uses_a_reported_cap():
    worker = _FakeWorker(json.dumps({"peer_upload_min_mbps": 5}))
    assert peer._seeder_rate_bytes_per_sec(worker) == 5 * 1_000_000 / 8


def test_grant_ttl_for_a_slow_seeder_is_proportionally_longer():
    """A 5 Mbps seeder moves a 6.5 GB model 4x slower than the 20 Mbps
    default the flat assumption was built for, so its grant must live ~4x as
    long or the transfer expires mid-file."""
    size = round(6.5 * 1000 ** 3)
    default_ttl = peer.grant_ttl_seconds(size)
    slow_ttl = peer.grant_ttl_seconds(size, 5 * 1_000_000 / 8)

    # Both carry the same flat 600 s of setup headroom; the size-scaled part
    # is what quadruples.
    scaled_default = default_ttl - peer.GRANT_TTL_SECONDS
    scaled_slow = slow_ttl - peer.GRANT_TTL_SECONDS
    assert 3.9 <= scaled_slow / scaled_default <= 4.1

    # An absent/invalid rate is exactly the pre-existing default.
    assert peer.grant_ttl_seconds(size, None) == default_ttl
    assert peer.grant_ttl_seconds(size, 0) == default_ttl
    assert peer.grant_ttl_seconds(size, -1) == default_ttl


def test_peer_grant_expiry_uses_the_seeders_reported_cap(client):
    """End to end: a seeder whose hello reported a 5 Mbps floor gets a
    proportionally longer grant than the default assumption would give."""
    csrf = _login(client)
    sha = _sha("model")
    size = _bytes(1.0)
    seeder_id, _ = _make_online_seeder(client, csrf, "seeder", sha256=sha, size_bytes=size)
    with db.get_session() as session:
        worker = session.get(db.Worker, seeder_id)
        worker.hardware = json.dumps({"cpu": "x", "peer_upload_min_mbps": 5})
        session.commit()

    puller_id, puller_sk = _register_worker(client, csrf, "puller")
    before = int(time.time())
    r = _agent_post(
        client, puller_id, puller_sk, "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": size},
    )
    after = int(time.time())

    expires_at = r.json()["grant"]["expires_at"]
    ttl = peer.grant_ttl_seconds(size, 5 * 1_000_000 / 8)
    assert ttl > peer.grant_ttl_seconds(size)
    assert before + ttl <= expires_at <= after + ttl


# --- M2: the reported cap is clamped, and the TTL has a ceiling -------------


def test_seeder_rate_ignores_an_out_of_range_reported_cap():
    """A worker is authenticated but low-privilege and this value is the TTL
    DIVISOR: a denormal like 1e-300 would otherwise mint a grant whose
    expires_at is ~1e304, i.e. one that never expires. Out of range (and NaN
    /inf) is treated exactly like absent."""
    for value in (1e-300, 0.09, 1e300, 100001, float("nan"), float("inf"), -1):
        assert (
            peer._seeder_rate_bytes_per_sec(
                _FakeWorker(json.dumps({"peer_upload_min_mbps": value}))
            )
            == peer.MIN_ASSUMED_RATE_BYTES_PER_SEC
        ), value

    # ...and the range boundaries themselves are still accepted.
    assert peer._seeder_rate_bytes_per_sec(
        _FakeWorker(json.dumps({"peer_upload_min_mbps": peer.MIN_PEER_UPLOAD_MBPS}))
    ) == peer.MIN_PEER_UPLOAD_MBPS * 1_000_000 / 8


def test_hello_rejects_an_out_of_range_peer_upload_min_mbps():
    """Parity with the read-back clamp above: the value never even reaches
    the `hardware` blob (parity: hub.ts's `parsePeerUploadMinMbps`)."""
    for value in (1e-300, 1e300, float("nan"), float("inf"), -1, 0, "5", True, None):
        assert agentws._parse_peer_upload_min_mbps({"peer_upload_min_mbps": value}) is None, value
    assert agentws._parse_peer_upload_min_mbps({"peer_upload_min_mbps": 5}) == 5.0


def test_grant_ttl_never_exceeds_the_seven_day_ceiling():
    """Whatever rate/size arithmetic produced it, `expires_at` stays a sane
    integer -- 7 days is the hard ceiling."""
    assert peer.MAX_GRANT_TTL_SECONDS == 604800
    # A huge file at the slowest ACCEPTED rate still can't exceed the cap.
    assert (
        peer.grant_ttl_seconds(10 ** 15, peer.MIN_PEER_UPLOAD_MBPS * 1_000_000 / 8)
        == peer.MAX_GRANT_TTL_SECONDS
    )
    # ...and a rate that slipped past every other guard can't either.
    assert peer.grant_ttl_seconds(10 ** 9, 1e-300) == peer.MAX_GRANT_TTL_SECONDS
