"""Server-side tests for the agent's full object_info upload + platform storage.

Covers: signed upload lands the gzip file and updates Worker.object_info_hash;
an unsigned request is rejected; a hash that doesn't match the payload is
rejected; an oversized decompressed payload is rejected; load_object_info
round-trips what was written; and a heartbeat reporting a stale/missing hash
makes the platform ask for a resend over the agent WebSocket.
"""

import asyncio
import gzip
import hashlib
import json
import os

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey

from comfyfed_agent import signing
from comfyfed_agent.config import PlatformEntry
from comfyfed_server import agentws, app as app_module
from comfyfed_server import bootstrap, db, workers


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    return c


def _login(client):
    r = client.post("/api/auth/login", json={"password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _register_worker(client, name="worker-1") -> PlatformEntry:
    csrf = _login(client)
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]

    signing_key = SigningKey.generate()
    pubkey_hex = bytes(signing_key.verify_key).hex()

    reg = client.post(
        "/api/agent/register",
        json={"token": token, "name": name, "pubkey": pubkey_hex},
    )
    assert reg.status_code == 200
    body = reg.json()

    return PlatformEntry(
        platform_url="http://h",
        platform_pubkey="",
        worker_id=body["worker_id"],
        certificate=body["certificate"],
        signing_key_hex=bytes(signing_key).hex(),
    )


def _object_info_payload() -> bytes:
    return json.dumps({"KSampler": {"input": {}}}, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _upload(client, entry, payload: bytes, *, hash_override: str = None):
    gz = gzip.compress(payload)
    oi_hash = hash_override if hash_override is not None else hashlib.sha256(payload).hexdigest()
    headers = signing.signed_headers(entry, "POST", "/api/agent/object_info", gz)
    headers["X-OI-Hash"] = oi_hash
    headers["Content-Encoding"] = "gzip"
    return client.post("/api/agent/object_info", headers=headers, content=gz)


def test_signed_upload_lands_file_and_updates_hash_column(client):
    entry = _register_worker(client)
    payload = _object_info_payload()
    expected_hash = hashlib.sha256(payload).hexdigest()

    r = _upload(client, entry, payload)
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    with db.get_session() as session:
        worker = session.get(db.Worker, entry.worker_id)
        assert worker.object_info_hash == expected_hash

    stored_path = os.path.join(client.data_dir, "object_info", f"{entry.worker_id}.json.gz")
    assert os.path.isfile(stored_path)
    with open(stored_path, "rb") as f:
        assert gzip.decompress(f.read()) == payload


def test_upload_without_signature_401(client):
    _register_worker(client)  # registered but not used: request is unsigned
    payload = _object_info_payload()
    gz = gzip.compress(payload)
    oi_hash = hashlib.sha256(payload).hexdigest()

    r = client.post("/api/agent/object_info", headers={"X-OI-Hash": oi_hash}, content=gz)
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "agent.bad_signature"


def test_upload_with_mismatched_hash_400(client):
    entry = _register_worker(client)
    payload = _object_info_payload()

    r = _upload(client, entry, payload, hash_override="00" * 32)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "agent.bad_object_info"

    with db.get_session() as session:
        worker = session.get(db.Worker, entry.worker_id)
        assert worker.object_info_hash == ""


def test_upload_with_invalid_gzip_400(client):
    entry = _register_worker(client)
    body = b"not actually gzip"
    fake_hash = hashlib.sha256(body).hexdigest()
    headers = signing.signed_headers(entry, "POST", "/api/agent/object_info", body)
    headers["X-OI-Hash"] = fake_hash

    r = client.post("/api/agent/object_info", headers=headers, content=body)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "agent.bad_object_info"


def test_upload_missing_hash_header_400(client):
    entry = _register_worker(client)
    payload = _object_info_payload()
    gz = gzip.compress(payload)
    headers = signing.signed_headers(entry, "POST", "/api/agent/object_info", gz)

    r = client.post("/api/agent/object_info", headers=headers, content=gz)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "agent.bad_object_info"


def test_oversized_decompressed_payload_413(client, monkeypatch):
    entry = _register_worker(client)
    monkeypatch.setattr(workers, "_MAX_OBJECT_INFO_BYTES", 8)

    payload = _object_info_payload()
    assert len(payload) > 8

    r = _upload(client, entry, payload)
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "agent.object_info_too_large"


def test_load_object_info_round_trip(client):
    entry = _register_worker(client)
    payload = {"KSampler": {"input": {"required": {}}}}
    gz = gzip.compress(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    oi_hash = hashlib.sha256(gzip.decompress(gz)).hexdigest()
    headers = signing.signed_headers(entry, "POST", "/api/agent/object_info", gz)
    headers["X-OI-Hash"] = oi_hash

    r = client.post("/api/agent/object_info", headers=headers, content=gz)
    assert r.status_code == 200

    loaded = workers.load_object_info(client.data_dir, entry.worker_id)
    assert loaded == payload


def test_load_object_info_missing_returns_none(client, tmp_path):
    assert workers.load_object_info(str(tmp_path), "no-such-worker") is None


def test_load_object_info_corrupt_file_returns_none(tmp_path):
    data_dir = str(tmp_path)
    path = workers.object_info_path(data_dir, "worker-x")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"not gzip at all")

    assert workers.load_object_info(data_dir, "worker-x") is None


def _connect(client, worker_id, sk):
    ws = client.websocket_connect("/api/agent/ws").__enter__()
    challenge = ws.receive_json()
    sig = sk.sign(challenge["nonce"].encode()).signature.hex()
    ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
    assert ws.receive_json()["type"] == "ready"
    return ws


def test_heartbeat_with_no_hash_drift_does_not_trigger_resend(client):
    """`_handle_heartbeat` returns False (no want_object_info) once the
    agent's reported hash matches the stored one and the file is present.

    Tested at the function level rather than over the real WebSocket: the
    positive case (drift -> a message arrives) is naturally verified by
    `ws.receive_json()` below, but there is no message to block on here for
    the negative case without a receive timeout the test client doesn't
    expose.
    """
    entry = _register_worker(client)
    payload = _object_info_payload()
    _upload(client, entry, payload)
    oi_hash = hashlib.sha256(payload).hexdigest()

    class _FakeConn:
        state = "idle"

    result = asyncio.run(
        agentws._handle_heartbeat(
            entry.worker_id,
            _FakeConn(),
            {
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {},
                "object_info_hash": oi_hash,
            },
        )
    )
    assert result is False


def test_heartbeat_hash_drift_triggers_want_object_info(client):
    entry = _register_worker(client)
    sk = SigningKey(bytes.fromhex(entry.signing_key_hex))

    ws = _connect(client, entry.worker_id, sk)
    try:
        # No upload has ever happened, so the server's stored hash is "" --
        # any non-empty hash reported by the agent is drift.
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {},
                "object_info_hash": "deadbeef",
            }
        )
        msg = ws.receive_json()
        assert msg["type"] == "want_object_info"
    finally:
        ws.close()


def test_heartbeat_hash_matches_but_file_missing_still_triggers_resend(client):
    entry = _register_worker(client)
    sk = SigningKey(bytes.fromhex(entry.signing_key_hex))

    payload = _object_info_payload()
    oi_hash = hashlib.sha256(payload).hexdigest()

    # Simulate a stale DB row (hash recorded) whose file was lost.
    with db.get_session() as session:
        worker = session.get(db.Worker, entry.worker_id)
        worker.object_info_hash = oi_hash
        session.commit()

    ws = _connect(client, entry.worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {},
                "object_info_hash": oi_hash,
            }
        )
        msg = ws.receive_json()
        assert msg["type"] == "want_object_info"
    finally:
        ws.close()


# --- upload size bounding (I1) -------------------------------------------------


def test_oversized_content_length_is_413_before_the_body_is_read(client, monkeypatch):
    """A declared Content-Length past the compressed cap is refused up front.

    The point is the ORDER: the decompressed cap alone is unenforceable
    because `verify_agent` must buffer the whole body to check the signature
    over it. `limit_object_info_upload` is declared as the first dependency on
    the route precisely so an oversized upload dies before that read.
    """
    entry = _register_worker(client)
    monkeypatch.setattr(workers, "_MAX_OBJECT_INFO_COMPRESSED_BYTES", 64)

    # Incompressible content, so the GZIPPED body is genuinely over the cap
    # (a run of repeated characters would gzip to a few dozen bytes).
    payload = json.dumps({"Node": {"x": os.urandom(4096).hex()}}).encode()
    r = _upload(client, entry, payload)
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "agent.object_info_too_large"


def test_content_length_within_the_compressed_cap_still_succeeds(client, monkeypatch):
    entry = _register_worker(client)
    monkeypatch.setattr(workers, "_MAX_OBJECT_INFO_COMPRESSED_BYTES", 4096)

    r = _upload(client, entry, _object_info_payload())
    assert r.status_code == 200


def test_gzip_bomb_is_413_without_being_materialized(client, monkeypatch):
    """A small gzip that inflates past the decompressed cap must be refused.

    64MB of zeros gzips to well under 100KB, so it sails past every
    compressed-size check; the old `gzip.decompress()` would have inflated the
    whole thing into memory before `len()` could object. `bounded_gunzip`
    aborts one chunk past the cap. The assertion is just the 413 -- if the
    bomb HAD been materialized, this test would be measured in gigabytes of
    RSS rather than by its return code.
    """
    entry = _register_worker(client)
    monkeypatch.setattr(workers, "_MAX_OBJECT_INFO_BYTES", 1024 * 1024)

    bomb = b"\0" * (64 * 1024 * 1024)
    gz = gzip.compress(bomb)
    assert len(gz) < 1024 * 1024  # small enough to pass every compressed check

    oi_hash = hashlib.sha256(bomb).hexdigest()
    headers = signing.signed_headers(entry, "POST", "/api/agent/object_info", gz)
    headers["X-OI-Hash"] = oi_hash
    headers["Content-Encoding"] = "gzip"

    r = client.post("/api/agent/object_info", headers=headers, content=gz)
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "agent.object_info_too_large"


def test_bounded_gunzip_round_trips_a_normal_payload():
    payload = _object_info_payload()
    assert workers.bounded_gunzip(gzip.compress(payload)) == payload


def test_bounded_gunzip_rejects_a_non_gzip_stream():
    import zlib

    with pytest.raises(zlib.error):
        workers.bounded_gunzip(b"definitely not gzip")


def test_bounded_gunzip_rejects_a_truncated_stream():
    import zlib

    gz = gzip.compress(b"x" * 100_000)
    with pytest.raises(zlib.error):
        workers.bounded_gunzip(gz[: len(gz) // 2])


def test_bounded_gunzip_raises_at_the_cap():
    with pytest.raises(workers.ObjectInfoTooLarge):
        workers.bounded_gunzip(gzip.compress(b"a" * 5000), max_bytes=1000)
