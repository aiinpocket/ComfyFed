"""Tests for `peer`: P2P grant issuance/verification and bandwidth booking
(Phase 3.1 addendum), plus the chunk-hash storage `model_manifest.record_hash`
gained alongside it.
"""

import asyncio
import hashlib
import json
import secrets
import threading
import time
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey, VerifyKey

from comfyfed_server import app as app_module
from comfyfed_server import agentws, bootstrap, db, model_manifest, peer, peerhealth, security


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
    peer_reachable=1,
    peer_lan_url=None,
    remote_ip=None,
):
    """Register a worker and, via a direct DB write (there's no HTTP surface
    for hello/heartbeat in these tests), give it the online/protocol/peer_url/
    inventory shape `peer.online_seeders` looks for.

    `peer_reachable` defaults to 1 (Phase 3.4 §4.2): the seeder predicate now
    requires a platform-verified endpoint, so "a normal, usable seeder" means
    one whose reachability check passed. Tests about the check itself pass
    None/0 explicitly.
    """
    sha256 = sha256 or _sha(name)
    worker_id, sk = _register_worker(client, csrf, name)
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = status
        worker.protocol = protocol
        worker.peer_url = peer_url
        worker.peer_lan_url = peer_lan_url
        worker.peer_reachable = peer_reachable
        worker.remote_ip = remote_ip
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


# --- Phase 3.4 Task 4: 可連性檢查與種子條件 --------------------------------


@pytest.mark.parametrize(
    "url,private",
    [
        ("http://10.1.2.3:8850", True),
        ("http://172.16.0.9:8850", True),
        ("http://172.32.0.9:8850", False),
        ("http://192.168.1.5:8850", True),
        ("http://169.254.169.254:80", True),
        ("http://127.0.0.1:8850", True),
        # 100.64/10 CGNAT：電信商級 NAT 的位址，對外一樣連不到（裁示：與
        # agent natmap 的私有判定逐條對齊）。100.128.0.0 已經出了這個範圍。
        ("http://100.64.0.1:8850", True),
        ("http://100.127.255.254:8850", True),
        ("http://100.128.0.1:8850", False),
        ("http://100.63.255.255:8850", False),
        ("http://[::1]:8850", True),
        ("http://[fc00::1]:8850", True),
        ("http://[fe80::1]:8850", True),
        ("http://203.0.113.7:8850", False),
        ("http://[2001:db8::1]:8850", False),
        ("http://seeder.example.com:8850", False),
    ],
)
def test_is_private_peer_url(url, private):
    assert peerhealth.is_private_peer_url(url) is private


def test_refresh_rejects_a_private_peer_url_without_probing(client, monkeypatch):
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-1")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)

    result = asyncio.run(peerhealth.refresh(worker_id, "http://192.168.1.5:8850"))

    assert result is False
    assert probed == []  # 靜態拒絕，不發請求
    with db.get_session() as session:
        w = session.get(db.Worker, worker_id)
        assert w.peer_reachable == 0
        assert w.peer_checked_at is not None


def test_refresh_marks_a_204_seeder_reachable(client, monkeypatch):
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-2")
    monkeypatch.setattr(peerhealth, "_probe", lambda url: True)

    assert asyncio.run(peerhealth.refresh(worker_id, "http://203.0.113.7:8850")) is True

    with db.get_session() as session:
        assert session.get(db.Worker, worker_id).peer_reachable == 1


def test_refresh_marks_a_timeout_unreachable(client, monkeypatch):
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-3")
    monkeypatch.setattr(peerhealth, "_probe", lambda url: False)

    assert asyncio.run(peerhealth.refresh(worker_id, "http://203.0.113.7:8850")) is False

    with db.get_session() as session:
        assert session.get(db.Worker, worker_id).peer_reachable == 0


def test_refresh_without_a_peer_url_clears_the_verdict(client, monkeypatch):
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-4")
    monkeypatch.setattr(peerhealth, "_probe", lambda url: True)

    assert asyncio.run(peerhealth.refresh(worker_id, None)) is None

    with db.get_session() as session:
        assert session.get(db.Worker, worker_id).peer_reachable is None


def test_refresh_probes_the_health_path_not_the_bare_peer_url(client, monkeypatch):
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-4b")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)

    asyncio.run(peerhealth.refresh(worker_id, "http://203.0.113.7:8850/"))

    assert probed == ["http://203.0.113.7:8850/peer/health"]


def test_refresh_notifies_every_time_after_hello(client, monkeypatch):
    """hello 觸發的檢查：每次檢查完成都推一次（spec §4.3「每次 hello 後檢查
    完成」），結論有沒有變都一樣。"""
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-5")
    monkeypatch.setattr(peerhealth, "_probe", lambda url: True)
    pushes = []

    async def notify(wid, reachable, checked_url):
        pushes.append((wid, reachable, checked_url))

    asyncio.run(peerhealth.refresh(worker_id, "http://203.0.113.7:8850", notify=notify))
    asyncio.run(peerhealth.refresh(worker_id, "http://203.0.113.7:8850", notify=notify))

    assert len(pushes) == 2
    assert pushes[0] == (worker_id, True, "http://203.0.113.7:8850/peer/health")


def test_refresh_notifies_only_when_the_verdict_changes(client, monkeypatch):
    """心跳觸發的重測（`notify_on_change_only=True`）：只有結論相對於庫裡
    存的 `peer_reachable` 真的變了才推（裁示）。"""
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-6")
    monkeypatch.setattr(peerhealth, "_probe", lambda url: True)
    pushes = []
    url = "http://203.0.113.7:8850"

    async def notify(wid, reachable, checked_url):
        pushes.append((wid, reachable, checked_url))

    def recheck():
        return asyncio.run(
            peerhealth.refresh(worker_id, url, notify=notify, notify_on_change_only=True)
        )

    # NULL -> True：變了，推。
    assert recheck() is True
    assert len(pushes) == 1
    # True -> True：沒變，不推。
    assert recheck() is True
    assert len(pushes) == 1
    # True -> False：變了，推。
    monkeypatch.setattr(peerhealth, "_probe", lambda url: False)
    assert recheck() is False
    assert pushes[-1] == (worker_id, False, url + "/peer/health")
    assert len(pushes) == 2
    # False -> False：沒變，不推。
    assert recheck() is False
    assert len(pushes) == 2


def test_needs_recheck_is_true_when_never_checked_or_older_than_ten_minutes():
    now = datetime(2026, 9, 16, 12, 0, 0, tzinfo=timezone.utc)
    assert peerhealth.needs_recheck(None, now) is True
    assert peerhealth.needs_recheck(now - timedelta(minutes=11), now) is True
    assert peerhealth.needs_recheck(now - timedelta(minutes=5), now) is False
    # SQLite 存回來的是 naive UTC（見 db.Worker.peer_checked_at）—— 當成 UTC。
    naive = (now - timedelta(minutes=11)).replace(tzinfo=None)
    assert peerhealth.needs_recheck(naive, now) is True


def test_refresh_never_raises_when_the_database_write_blows_up(client, monkeypatch):
    """檢查是背景工作：任何例外都吞掉（spec §8），不會弄爛 hello／heartbeat。"""
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-7")

    def _boom(url):
        raise RuntimeError("boom")

    monkeypatch.setattr(peerhealth, "_probe", _boom)
    assert asyncio.run(peerhealth.refresh(worker_id, "http://203.0.113.7:8850")) is None


# --- 種子條件與 grant 回應的 seeder_urls -----------------------------------


def test_online_seeders_requires_peer_reachable(client):
    csrf = _login(client)
    seeder_id, _ = _make_online_seeder(
        client, csrf, "seed-r1", peer_url="http://203.0.113.7:8850", peer_reachable=None
    )
    name, size_bytes = "checkpoints/model.safetensors", _bytes(1.0)

    with db.get_session() as session:
        assert peer.online_seeders(session, name, size_bytes) == []
        session.get(db.Worker, seeder_id).peer_reachable = 1
        session.commit()
    with db.get_session() as session:
        assert [w.id for w in peer.online_seeders(session, name, size_bytes)] == [seeder_id]


def test_online_seeders_accepts_a_same_remote_ip_lan_neighbour(client):
    """不可連（peer_reachable = 0），但跟拉方同一個公網 IP 且有區網位址
    ⇒ 仍是合格種子（spec §4.2 最後一條）。"""
    csrf = _login(client)
    seeder_id, _ = _make_online_seeder(
        client,
        csrf,
        "seed-r2",
        peer_url="http://192.168.1.5:8850",
        peer_lan_url="http://192.168.1.5:8850",
        peer_reachable=0,
        remote_ip="203.0.113.7",
    )
    name, size_bytes = "checkpoints/model.safetensors", _bytes(1.0)

    with db.get_session() as session:
        assert peer.online_seeders(session, name, size_bytes) == []
        found = peer.online_seeders(session, name, size_bytes, puller_remote_ip="203.0.113.7")
        assert [w.id for w in found] == [seeder_id]
        # 同 IP 但沒有區網位址 ⇒ 還是不合格。
        session.get(db.Worker, seeder_id).peer_lan_url = None
        session.commit()
    with db.get_session() as session:
        assert peer.online_seeders(session, name, size_bytes, puller_remote_ip="203.0.113.7") == []


def _puller_with_remote_ip(client, csrf, name, remote_ip):
    worker_id, sk = _register_worker(client, csrf, name)
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = "online"
        worker.protocol = 4
        worker.remote_ip = remote_ip
        session.commit()
    return worker_id, sk


def test_peer_grant_returns_seeder_urls_lan_first_for_a_same_nat_puller(client):
    csrf = _login(client)
    _make_online_seeder(
        client,
        csrf,
        "seed-u1",
        peer_url="http://203.0.113.7:8850",
        peer_lan_url="http://192.168.1.5:8850",
        peer_reachable=1,
        remote_ip="203.0.113.7",
    )
    puller_id, puller_sk = _puller_with_remote_ip(client, csrf, "pull-u1", "203.0.113.7")

    resp = _agent_post(
        client,
        puller_id,
        puller_sk,
        "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    )

    assert resp.status_code == 200
    payload = resp.json()
    assert payload["seeder_urls"] == ["http://192.168.1.5:8850", "http://203.0.113.7:8850"]
    # 舊 agent 只看 peer_url，行為不變：它就是 seeder_urls 的第一個。
    assert payload["peer_url"] == payload["seeder_urls"][0]


def test_peer_grant_dedupes_identical_lan_and_public_urls(client):
    """`peer_nat = "lan"` 的種子兩欄同值（沒開埠，通告的就是區網位址）——
    去重後只剩一個，不然拉方會在同一個位址上白試兩次。"""
    csrf = _login(client)
    _make_online_seeder(
        client,
        csrf,
        "seed-u1b",
        peer_url="http://192.168.1.5:8850",
        peer_lan_url="http://192.168.1.5:8850",
        peer_reachable=0,
        remote_ip="203.0.113.7",
    )
    puller_id, puller_sk = _puller_with_remote_ip(client, csrf, "pull-u1b", "203.0.113.7")

    payload = _agent_post(
        client,
        puller_id,
        puller_sk,
        "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    ).json()

    assert payload["seeder_urls"] == ["http://192.168.1.5:8850"]
    assert payload["peer_url"] == "http://192.168.1.5:8850"


def test_peer_grant_returns_only_the_public_url_for_a_different_nat_puller(client):
    csrf = _login(client)
    _make_online_seeder(
        client,
        csrf,
        "seed-u2",
        peer_url="http://203.0.113.7:8850",
        peer_lan_url="http://192.168.1.5:8850",
        peer_reachable=1,
        remote_ip="203.0.113.7",
    )
    puller_id, puller_sk = _puller_with_remote_ip(client, csrf, "pull-u2", "198.51.100.9")

    payload = _agent_post(
        client,
        puller_id,
        puller_sk,
        "/api/agent/peer-grant",
        {"name": "checkpoints/model.safetensors", "size_bytes": _bytes(1.0)},
    ).json()

    assert payload["seeder_urls"] == ["http://203.0.113.7:8850"]


# --- Phase 3.4 Task 4 fix round 1 ------------------------------------------


@pytest.mark.parametrize(
    "url,private",
    [
        # 非四段十進位的 IPv4 寫法：`connect()` 認得，所以靜態拒絕也必須認得。
        ("http://2130706433:8850", True),      # 127.0.0.1
        ("http://0177.0.0.1:8850", True),      # 八進位的 127
        ("http://127.1:8850", True),           # 兩段寫法
        ("http://0x0a000001:8850", True),      # 十六進位的 10.0.0.1
        ("http://3232235781:8850", True),      # 192.168.1.5
        # IPv4-mapped IPv6：兩種寫法都要還原成內含的 IPv4 再判。
        ("http://[::ffff:10.0.0.1]:8850", True),
        ("http://[::ffff:a00:1]:8850", True),
        ("http://[::ffff:203.0.113.7]:8850", False),
        # `fc::1` 是 00fc::1，**不在** fc00::/7 裡（cloud 端的字面正則曾誤判
        # 這個，fix round 1 一併對齊）。fec0::/10 同樣在 fe80::/10 之外。
        ("http://[fc::1]:8850", False),
        ("http://[fd00::1]:8850", True),
        ("http://[febf::1]:8850", True),
        ("http://[fec0::1]:8850", False),
        # 公網的十進位寫法不該被誤殺（3405803527 = 203.0.113.7）。
        ("http://3405803527:8850", False),
    ],
)
def test_is_private_peer_url_normalizes_ip_literals(url, private):
    assert peerhealth.is_private_peer_url(url) is private


@pytest.mark.parametrize(
    "url,literal",
    [
        ("http://203.0.113.7:8850", True),
        ("http://2130706433:8850", True),
        ("http://[2001:db8::1]:8850", True),
        ("http://[::ffff:10.0.0.1]:8850", True),
        ("http://seeder.example.com:8850", False),
        ("http://localhost:8850", False),
    ],
)
def test_is_ip_literal_peer_url(url, literal):
    assert peerhealth.is_ip_literal_peer_url(url) is literal


def test_refresh_never_probes_a_hostname_peer_url(client, monkeypatch):
    """fix round 1 裁示：名稱型主機不驗 —— 不發請求、`peer_reachable` 留
    NULL，但時間戳有蓋（否則每一拍心跳都會白跑一次）。"""
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, "ph-host")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)
    pushes = []

    async def notify(wid, reachable, checked_url):
        pushes.append((wid, reachable, checked_url))

    result = asyncio.run(
        peerhealth.refresh(worker_id, "http://seeder.example.com:8850", notify=notify)
    )

    assert result is None
    assert probed == []
    assert pushes == []
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        assert worker.peer_reachable is None
        assert worker.peer_checked_at is not None
        assert peerhealth.needs_recheck(worker.peer_checked_at, datetime.now(timezone.utc)) is False


def _mock_probe_client(monkeypatch, handler):
    """把 `peerhealth._http_client` 換成一個走 `MockTransport` 的 AsyncClient
    （其餘設定與正式的一致：3 秒逾時、不跟 redirect）。"""
    import httpx

    monkeypatch.setattr(
        peerhealth,
        "_http_client",
        lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            timeout=httpx.Timeout(peerhealth.TIMEOUT_SECONDS),
            follow_redirects=False,
        ),
    )


def test_probe_reads_only_the_status(monkeypatch):
    """探針不讀 body —— 對面可能回一條無限長的回應。"""
    import httpx

    drip_chunks = []

    async def _drip():
        # 被讀到才會跑 —— 跑起來就代表我們讀了 body（測試要證明沒有）。
        for i in range(1000):
            drip_chunks.append(i)
            await asyncio.sleep(0.5)
            yield b"x"

    def handler(request):
        assert request.url.path == "/peer/health"
        return httpx.Response(204, content=_drip())

    _mock_probe_client(monkeypatch, handler)

    started = time.monotonic()
    assert asyncio.run(peerhealth._probe("http://203.0.113.7:8850/peer/health")) is True
    elapsed = time.monotonic() - started

    assert drip_chunks == []  # body 一個 byte 都沒讀
    assert elapsed < peerhealth.MAX_PROBE_SECONDS


def test_probe_treats_a_non_204_as_unreachable(monkeypatch):
    import httpx

    _mock_probe_client(monkeypatch, lambda request: httpx.Response(200, text="hi"))
    assert asyncio.run(peerhealth._probe("http://203.0.113.7:8850/peer/health")) is False


def test_probe_does_not_follow_redirects(monkeypatch):
    """302 就是不可連：跟著走等於讓一個惡意種子把平台的請求導去第三方
    （而且第二段回什麼都不該算數）。"""
    import httpx

    requested = []

    def handler(request):
        requested.append(str(request.url))
        return httpx.Response(302, headers={"Location": "http://198.51.100.9:8850/peer/health"})

    _mock_probe_client(monkeypatch, handler)

    assert asyncio.run(peerhealth._probe("http://203.0.113.7:8850/peer/health")) is False
    assert requested == ["http://203.0.113.7:8850/peer/health"]  # 沒有第二發


def test_probe_treats_a_transport_error_as_unreachable(monkeypatch):
    import httpx

    def boom(request):
        raise httpx.ConnectError("refused", request=request)

    _mock_probe_client(monkeypatch, boom)
    assert asyncio.run(peerhealth._probe("http://203.0.113.7:8850/peer/health")) is False


def test_probe_cancels_the_request_at_the_deadline(monkeypatch):
    """fix round 3：上限是真的上限 —— 逾時會把整個請求取消掉，不是「跑完
    再回頭比時間」。handler 在 deadline 之後才會設旗標；取消成功的話那行
    永遠跑不到。"""
    import httpx

    late = {"finished": False}

    async def handler(request):
        await asyncio.sleep(peerhealth.MAX_PROBE_SECONDS + 0.2)
        late["finished"] = True
        return httpx.Response(204)

    _mock_probe_client(monkeypatch, handler)

    async def run():
        started = time.monotonic()
        result = await peerhealth._probe("http://203.0.113.7:8850/peer/health")
        elapsed = time.monotonic() - started
        # 讓被取消（或沒被取消）的 handler 有機會跑到設旗標那一行。
        await asyncio.sleep(0.5)
        return result, elapsed

    result, elapsed = asyncio.run(run())

    assert result is False
    # 上限 3.5 秒；5.0 是給慢機器／GC 停頓的餘裕。真正的判準是下面那一行
    # 旗標沒被設起來 —— 在剛好 3.6 秒的邊緣上 flaky 對誰都沒有幫助。
    assert elapsed < 5.0
    assert late["finished"] is False  # 請求真的被取消了，沒有殘留的工作


def _dribbling_server():
    """一台每 0.5 秒才吐一個 header byte 的「種子」。每次讀取都在 3 秒的 read
    timeout 之內，所以只有整趟的牆鐘上限擋得住它。"""
    import socket as _socket
    import threading

    listener = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    state = {"stop": False}

    def serve():
        try:
            conn, _ = listener.accept()
        except OSError:
            return
        try:
            conn.recv(4096)
            for byte in b"HTTP/1.1 204 No Content\r\n\r\n":
                if state["stop"]:
                    break
                conn.sendall(bytes([byte]))
                time.sleep(0.5)
        except OSError:
            pass  # 客戶端在 deadline 斷線 —— 正是我們要的
        finally:
            conn.close()

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    return port, state, thread, listener


def test_probe_is_bounded_when_a_peer_dribbles_headers():
    """fix round 3 的核心回歸：header 慢慢滴的對手撐不過 MAX_PROBE_SECONDS。
    （沒有上限的話這個請求會拖到約 13 秒。）"""
    port, state, thread, listener = _dribbling_server()
    try:
        started = time.monotonic()
        result = asyncio.run(peerhealth._probe(f"http://127.0.0.1:{port}/peer/health"))
        elapsed = time.monotonic() - started
    finally:
        state["stop"] = True
        listener.close()
        thread.join(timeout=2)

    assert result is False
    assert elapsed < 3.6


@pytest.mark.parametrize(
    "url",
    [
        "http://0",  # 未指定位址的極簡寫法
        "http://0.0.0.0:8850",
        "http://224.0.0.1",  # 多播
        "http://239.1.2.3:8850",
        "http://240.0.0.1",  # 保留
        "http://255.255.255.255",  # 廣播
        "http://[ff02::1]",  # IPv6 多播
        "http://[::]:8850",  # IPv6 未指定
    ],
)
def test_is_private_peer_url_rejects_non_host_addresses(url):
    """fix round 3：未指定／多播／保留／廣播位址根本不是一台種子。"""
    assert peerhealth.is_private_peer_url(url) is True


@pytest.mark.parametrize("url", ["http://0.0.0.0:8850", "http://224.0.0.1:8850", "http://[ff02::1]:8850"])
def test_refresh_never_probes_a_non_host_address(client, monkeypatch, url):
    csrf = _login(client)
    worker_id, _ = _register_worker(client, csrf, f"reject-{abs(hash(url)) % 1000}")
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda u: probed.append(u) or True)

    assert asyncio.run(peerhealth.refresh(worker_id, url)) is False

    assert probed == []
    with db.get_session() as session:
        assert session.get(db.Worker, worker_id).peer_reachable == 0


# --- Phase 3.4 Task 9: 端對端（真的 WS hello → 可連性 → grant） --------------
#
# 這一段刻意不用 `_make_online_seeder` 的直接 DB 寫入：整個 Task 9 的重點就是
# 「agent 真的握手、真的送 hello、平台真的排出可連性檢查、結論真的決定誰是
# 種子、grant 真的吐出正確順序的 `seeder_urls`」這條鏈接起來。單點行為的邊界
# 案例仍由 test_agent_ws.py（hello／peer_status）與上面的 peer 測試各自負責。
#
# `peerhealth._probe` 是唯一真的發請求的地方（見 peerhealth.py 的模組
# docstring），所以 mock 縫就開在它身上；名稱型主機那條路徑連 `_probe` 都不該
# 碰到，測試因此斷言「一次都沒被呼叫」。


def _e2e_wait_until(predicate, timeout=5.0):
    """輪詢到 `predicate()` 回真（背景檢查任務是 `asyncio.create_task` 排出去
    的，沒有可等的 handle）。Parity: test_agent_ws.py 的 `_wait_until`。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    raise AssertionError("condition never became true")


def _peer_columns(worker_id):
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        return {
            "peer_url": worker.peer_url,
            "peer_lan_url": worker.peer_lan_url,
            "peer_nat": worker.peer_nat,
            "peer_reachable": worker.peer_reachable,
            "peer_checked_at": worker.peer_checked_at,
            "remote_ip": worker.remote_ip,
        }


def _hello_over_ws(client, worker_id, sk, hello, *, headers=None, expect_peer_status=True):
    """完整跑一次握手 + hello 走真的 WS route，回傳 `(ready, pushed)`。

    `expect_peer_status=True` 時把推回來的 `peer_status` 當同步點；名稱型
    `peer_url` 根本不會推（`peerhealth.refresh` 那條路連 notify 都不呼叫），
    此時改等 `peer_checked_at` 被蓋上去，`pushed` 回 None。
    """
    with client.websocket_connect("/api/agent/ws", headers=headers or {}) as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        ready = ws.receive_json()
        ws.send_json(hello)
        if expect_peer_status:
            pushed = ws.receive_json()
        else:
            pushed = None
            _e2e_wait_until(lambda: _peer_columns(worker_id)["peer_checked_at"] is not None)
    return ready, pushed


def _publish_inventory(worker_id, name, size_bytes, sha256):
    """種子宣告庫存並讓平台學到共識雜湊（hello 之後才做，免得 hello 的欄位
    覆寫把這裡設的 status 洗掉）。"""
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = "online"
        worker.model_inventory = json.dumps(
            [{"name": name, "size_bytes": size_bytes, "sha256": sha256}]
        )
        session.commit()
    model_manifest.record_hash(worker_id, name, size_bytes, sha256)


def _make_puller(client, csrf, name, remote_ip):
    """一台上線、protocol 4、有 `remote_ip` 的拉方（grant 路由是拿 worker 列
    上的 `remote_ip` 判斷同不同 NAT，不是看這次 HTTP 請求的來源）。"""
    worker_id, sk = _register_worker(client, csrf, name)
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = "online"
        worker.protocol = 4
        worker.remote_ip = remote_ip
        session.commit()
    return worker_id, sk


def _request_grant(client, puller_id, puller_sk, name, size_bytes):
    return _agent_post(
        client,
        puller_id,
        puller_sk,
        "/api/agent/peer-grant",
        {"name": name, "size_bytes": size_bytes},
    )


def _trust_proxy_on():
    """這組 e2e 用 `X-Forwarded-For` 注入來源 IP，所以要先把平台設定
    `trust_proxy` 打開（預設關 —— 最終審查 I2）。"""
    with db.get_session() as session:
        session.merge(db.Setting(key=agentws.TRUST_PROXY_SETTING_KEY, value="1"))
        session.commit()


def test_e2e_reachable_seeder_is_granted_with_seeder_urls(client, monkeypatch):
    _trust_proxy_on()
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)
    csrf = _login(client)
    seeder_id, seeder_sk = _register_worker(client, csrf, "e2e-seed")
    puller_id, puller_sk = _make_puller(client, csrf, "e2e-pull", "198.51.100.9")
    name, size_bytes, sha = "checkpoints/e2e.safetensors", 4096, _sha("e2e")

    ready, pushed = _hello_over_ws(
        client,
        seeder_id,
        seeder_sk,
        {
            "type": "hello",
            "protocol": 4,
            "peer_url": "http://203.0.113.7:8850",
            "peer_lan_url": "http://192.168.1.5:8850",
            "peer_nat": "upnp",
        },
        headers={"X-Forwarded-For": "203.0.113.7"},
    )

    # ready 帶回這次連線的來源 IP（測試以 X-Forwarded-For 注入）。
    assert ready["type"] == "ready"
    assert ready["remote_ip"] == "203.0.113.7"
    assert pushed == {
        "type": "peer_status",
        "reachable": True,
        "checked_url": "http://203.0.113.7:8850/peer/health",
    }
    assert probed == ["http://203.0.113.7:8850/peer/health"]
    columns = _peer_columns(seeder_id)
    assert columns["peer_reachable"] == 1
    assert columns["peer_nat"] == "upnp"
    assert columns["remote_ip"] == "203.0.113.7"

    _publish_inventory(seeder_id, name, size_bytes, sha)

    response = _request_grant(client, puller_id, puller_sk, name, size_bytes)

    assert response.status_code == 200
    payload = response.json()
    assert payload["seeder_urls"] == ["http://203.0.113.7:8850"]
    assert payload["peer_url"] == "http://203.0.113.7:8850"
    assert payload["grant"]["seeder_id"] == seeder_id
    assert payload["grant"]["puller_id"] == puller_id


def test_e2e_unreachable_seeder_is_never_chosen(client, monkeypatch):
    _trust_proxy_on()
    monkeypatch.setattr(peerhealth, "_probe", lambda url: False)
    csrf = _login(client)
    seeder_id, seeder_sk = _register_worker(client, csrf, "e2e-seed-bad")
    puller_id, puller_sk = _make_puller(client, csrf, "e2e-pull-bad", "198.51.100.9")
    name, size_bytes, sha = "checkpoints/bad.safetensors", 4096, _sha("bad")

    _, pushed = _hello_over_ws(
        client,
        seeder_id,
        seeder_sk,
        {
            "type": "hello",
            "protocol": 4,
            "peer_url": "http://203.0.113.7:8850",
            "peer_nat": "upnp",
        },
        headers={"X-Forwarded-For": "203.0.113.7"},
    )

    assert pushed == {
        "type": "peer_status",
        "reachable": False,
        "checked_url": "http://203.0.113.7:8850/peer/health",
    }
    assert _peer_columns(seeder_id)["peer_reachable"] == 0

    _publish_inventory(seeder_id, name, size_bytes, sha)

    response = _request_grant(client, puller_id, puller_sk, name, size_bytes)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "peer.no_seeder"


def test_e2e_same_remote_ip_gets_the_lan_address_first(client, monkeypatch):
    _trust_proxy_on()
    """不可連的種子，只要跟拉方同一個公網 IP 且有區網位址，仍然配得到，
    而且區網位址排第一（很多家用路由器不支援 hairpin）。"""
    monkeypatch.setattr(peerhealth, "_probe", lambda url: False)
    csrf = _login(client)
    seeder_id, seeder_sk = _register_worker(client, csrf, "e2e-seed-lan")
    puller_id, puller_sk = _make_puller(client, csrf, "e2e-pull-lan", "203.0.113.7")
    name, size_bytes, sha = "checkpoints/lan.safetensors", 4096, _sha("lan")

    _hello_over_ws(
        client,
        seeder_id,
        seeder_sk,
        {
            "type": "hello",
            "protocol": 4,
            "peer_url": "http://203.0.113.7:8850",
            "peer_lan_url": "http://192.168.1.5:8850",
            "peer_nat": "upnp",
        },
        headers={"X-Forwarded-For": "203.0.113.7"},  # 跟拉方同一個 NAT
    )
    assert _peer_columns(seeder_id)["peer_reachable"] == 0

    _publish_inventory(seeder_id, name, size_bytes, sha)

    response = _request_grant(client, puller_id, puller_sk, name, size_bytes)

    assert response.status_code == 200
    payload = response.json()
    assert payload["seeder_urls"] == ["http://192.168.1.5:8850", "http://203.0.113.7:8850"]
    assert payload["peer_url"] == "http://192.168.1.5:8850"


def test_e2e_a_hostname_peer_url_is_never_probed(client, monkeypatch):
    _trust_proxy_on()
    """名稱型主機一律不探（fix round 1）：`peer_reachable` 留 NULL，所以對
    不同 IP 的拉方不是種子；但對同一個公網 IP 的拉方，區網位址照樣配得出去。
    """
    probed = []
    monkeypatch.setattr(peerhealth, "_probe", lambda url: probed.append(url) or True)
    csrf = _login(client)
    seeder_id, seeder_sk = _register_worker(client, csrf, "e2e-seed-host")
    far_puller_id, far_puller_sk = _make_puller(client, csrf, "e2e-pull-far", "198.51.100.9")
    near_puller_id, near_puller_sk = _make_puller(client, csrf, "e2e-pull-near", "203.0.113.7")
    name, size_bytes, sha = "checkpoints/host.safetensors", 4096, _sha("host")

    ready, pushed = _hello_over_ws(
        client,
        seeder_id,
        seeder_sk,
        {
            "type": "hello",
            "protocol": 4,
            "peer_url": "http://seeder.example.com:8850",
            "peer_lan_url": "http://192.168.1.5:8850",
            "peer_nat": "manual",
        },
        headers={"X-Forwarded-For": "203.0.113.7"},
        expect_peer_status=False,
    )

    assert ready["remote_ip"] == "203.0.113.7"
    assert pushed is None
    assert probed == []  # 探針一次都沒被呼叫
    columns = _peer_columns(seeder_id)
    assert columns["peer_reachable"] is None
    assert columns["peer_url"] == "http://seeder.example.com:8850"

    _publish_inventory(seeder_id, name, size_bytes, sha)

    far = _request_grant(client, far_puller_id, far_puller_sk, name, size_bytes)
    assert far.status_code == 404
    assert far.json()["error"]["code"] == "peer.no_seeder"

    near = _request_grant(client, near_puller_id, near_puller_sk, name, size_bytes)
    assert near.status_code == 200
    near_payload = near.json()
    assert near_payload["seeder_urls"] == [
        "http://192.168.1.5:8850",
        "http://seeder.example.com:8850",
    ]
    assert near_payload["grant"]["seeder_id"] == seeder_id
    assert probed == []
