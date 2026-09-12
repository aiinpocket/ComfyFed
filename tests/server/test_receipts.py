import hashlib
import io
import json
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
import pytest
import secrets
import time
from nacl.signing import SigningKey, VerifyKey

from comfyfed_server import agentws, app as app_module
from comfyfed_server import bootstrap, db, dispatch, security, storage


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    from fastapi.testclient import TestClient

    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    return c


def _login(client):
    r = client.post("/api/auth/login", json={"password": client.admin_password})
    assert r.status_code == 200
    return r.json()["csrf"]


def _register_worker_with_key(client, csrf, name):
    sk = SigningKey.generate()
    pubkey_hex = bytes(sk.verify_key).hex()
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post("/api/agent/register", json={"token": token, "name": name, "pubkey": pubkey_hex})
    return reg.json()["worker_id"], sk


SIMPLE_WORKFLOW = {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}


def _submit(client, csrf, workflow=None):
    workflow = workflow if workflow is not None else SIMPLE_WORKFLOW
    r = client.post(
        "/api/jobs",
        data={"workflow_json": json.dumps(workflow)},
        files=[],
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200
    return r.json()["job_id"]


def _signed_post_multipart(client, path, worker_id, signing_key, filename, content, extra_headers=None):
    req = httpx.Request(
        "POST",
        "http://testserver" + path,
        files={"file": (filename, content, "application/octet-stream")},
    )
    body = req.read()
    content_type = req.headers["content-type"]

    ts = str(int(time.time()))
    nonce = secrets.token_hex(8)
    message = f"POST\n{path}\n{ts}\n{nonce}\n".encode() + body
    sig = signing_key.sign(message).signature.hex()

    headers = {
        "Content-Type": content_type,
        "X-Worker-Id": worker_id,
        "X-Ts": ts,
        "X-Nonce": nonce,
        "X-Sig": sig,
    }
    headers.update(extra_headers or {})

    return client.post(path, content=body, headers=headers)


def test_artifact_upload_lands_on_disk(client):
    csrf = _login(client)
    w1_id, w1_key = _register_worker_with_key(client, csrf, "agent1")
    w2_id, w2_key = _register_worker_with_key(client, csrf, "agent2")

    job_id = _submit(client, csrf)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "assigned"
        job.worker_id = w1_id
        session.commit()

    path = f"/api/agent/jobs/{job_id}/artifacts"

    ok = _signed_post_multipart(client, path, w1_id, w1_key, "out.png", b"pixel-bytes")
    assert ok.status_code == 200
    expected_sha256 = hashlib.sha256(b"pixel-bytes").hexdigest()
    assert ok.json() == {"stored": "out.png", "sha256": expected_sha256}

    with db.get_session() as session:
        assert json.loads(session.get(db.Job, job_id).result_hashes) == {"out.png": expected_sha256}

    store = storage.get_store(client.data_dir)
    with store.open(job_id, "out.png") as f:
        assert f.read() == b"pixel-bytes"

    forbidden = _signed_post_multipart(client, path, w2_id, w2_key, "out.png", b"pixel-bytes")
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "jobs.not_assigned"


def test_artifact_upload_with_matching_hash_header_succeeds(client):
    csrf = _login(client)
    w1_id, w1_key = _register_worker_with_key(client, csrf, "agent1")
    job_id = _submit(client, csrf)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "assigned"
        job.worker_id = w1_id
        session.commit()

    path = f"/api/agent/jobs/{job_id}/artifacts"
    expected_sha256 = hashlib.sha256(b"pixel-bytes").hexdigest()

    ok = _signed_post_multipart(
        client, path, w1_id, w1_key, "out.png", b"pixel-bytes",
        extra_headers={"X-Artifact-SHA256": expected_sha256},
    )
    assert ok.status_code == 200
    assert ok.json() == {"stored": "out.png", "sha256": expected_sha256}


def test_artifact_upload_with_mismatched_hash_header_is_rejected(client):
    csrf = _login(client)
    w1_id, w1_key = _register_worker_with_key(client, csrf, "agent1")
    job_id = _submit(client, csrf)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "assigned"
        job.worker_id = w1_id
        session.commit()

    path = f"/api/agent/jobs/{job_id}/artifacts"

    bad = _signed_post_multipart(
        client, path, w1_id, w1_key, "out.png", b"pixel-bytes",
        extra_headers={"X-Artifact-SHA256": "0" * 64},
    )
    assert bad.status_code == 400
    assert bad.json()["error"]["code"] == "artifact.hash_mismatch"

    # Rejected upload must not be stored, and must not pollute result_hashes.
    store = storage.get_store(client.data_dir)
    with pytest.raises(FileNotFoundError):
        store.open(job_id, "out.png")
    with db.get_session() as session:
        assert json.loads(session.get(db.Job, job_id).result_hashes) == {}


def test_get_job_exposes_result_hashes(client):
    csrf = _login(client)
    w1_id, w1_key = _register_worker_with_key(client, csrf, "agent1")
    job_id = _submit(client, csrf)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "assigned"
        job.worker_id = w1_id
        session.commit()

    path = f"/api/agent/jobs/{job_id}/artifacts"
    expected_sha256 = hashlib.sha256(b"pixel-bytes").hexdigest()
    ok = _signed_post_multipart(client, path, w1_id, w1_key, "out.png", b"pixel-bytes")
    assert ok.status_code == 200

    res = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf})
    assert res.status_code == 200
    assert res.json()["result_hashes"] == {"out.png": expected_sha256}


def test_artifact_download_requires_admin(client):
    csrf = _login(client)
    w1_id, w1_key = _register_worker_with_key(client, csrf, "agent1")
    job_id = _submit(client, csrf)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "assigned"
        job.worker_id = w1_id
        session.commit()

    path = f"/api/agent/jobs/{job_id}/artifacts"
    ok = _signed_post_multipart(client, path, w1_id, w1_key, "out.png", b"pixel-bytes")
    assert ok.status_code == 200

    res = client.get(f"/api/jobs/{job_id}/artifacts/out.png", headers={"X-CSRF": csrf})
    assert res.status_code == 200
    assert res.content == b"pixel-bytes"

    missing = client.get(f"/api/jobs/{job_id}/artifacts/nope.png", headers={"X-CSRF": csrf})
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "jobs.artifact_not_found"


def test_store_rejects_path_traversal_job_id(client):
    store = storage.get_store(client.data_dir)

    # Directly exercising the store: job_id=".." must never be accepted, even
    # though a bare os.path.basename(".") pass-through would collapse it to
    # "<data_dir>/<filename>" and expose files like keys/platform.key.
    with pytest.raises(ValueError):
        store.open("..", "platform.key")
    with pytest.raises(ValueError):
        store.put("..", "platform.key", io.BytesIO(b"pwned"))
    with pytest.raises(ValueError):
        store.url("..", "platform.key")

    # keys/platform.key must genuinely exist (proves this isn't a vacuous check).
    _, _ = security.load_platform_keys(client.data_dir)


def test_artifact_download_rejects_path_traversal_job_id_over_http(client):
    csrf = _login(client)
    # Force the real platform key to exist so a traversal attempt has a real
    # target to read if the sanitization regresses.
    security.load_platform_keys(client.data_dir)

    # Percent-encode the ".." segment so httpx doesn't normalize it away
    # client-side before the request is even sent.
    res = client.get("/api/jobs/%2e%2e/artifacts/platform.key", headers={"X-CSRF": csrf})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "jobs.not_found"
    assert res.headers["content-type"].startswith("application/json")  # never leaked raw key bytes


def test_artifact_download_404s_for_nonexistent_job(client):
    csrf = _login(client)
    res = client.get("/api/jobs/no-such-job/artifacts/out.png", headers={"X-CSRF": csrf})
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "jobs.not_found"


def test_job_done_creates_dual_signed_receipt_over_ws(client):
    csrf = _login(client)
    worker_id, sk = _register_worker_with_key(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"

        dispatch.mark_running(job_id, worker_id)

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        receipt_id = receipt_msg["receipt_id"]
        payload = receipt_msg["payload"]
        platform_sig = receipt_msg["platform_sig"]

        _, platform_verify_key = security.load_platform_keys(client.data_dir)
        platform_verify_key.verify(payload.encode(), bytes.fromhex(platform_sig))  # raises if invalid

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_id)
            assert receipt is not None
            assert receipt.platform_sig == platform_sig
            assert receipt.worker_sig is None

        worker_sig = sk.sign(payload.encode()).signature.hex()
        ws.send_json({"type": "receipt_ack", "receipt_id": receipt_id, "worker_sig": worker_sig})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_id)
            assert receipt.worker_sig == worker_sig


def test_receipt_ack_with_bad_signature_is_ignored(client):
    csrf = _login(client)
    worker_id, sk = _register_worker_with_key(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        ws.receive_json()  # job push

        dispatch.mark_running(job_id, worker_id)
        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": []})
        agentws.dispatch_once(worker_id)
        receipt_msg = ws.receive_json()
        receipt_id = receipt_msg["receipt_id"]

        forged = SigningKey.generate()
        bad_sig = forged.sign(receipt_msg["payload"].encode()).signature.hex()
        ws.send_json({"type": "receipt_ack", "receipt_id": receipt_id, "worker_sig": bad_sig})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_id)
            assert receipt.worker_sig is None


def test_contributions_report_filters_by_date_range(client):
    csrf = _login(client)
    worker_id, sk = _register_worker_with_key(client, csrf, "w1")

    with db.get_session() as session:
        old = db.Receipt(
            job_id="job-old",
            worker_id=worker_id,
            gpu_seconds=10.0,
            platform_sig="ab" * 32,
            created_at=datetime(2020, 1, 1),
        )
        recent = db.Receipt(
            job_id="job-recent",
            worker_id=worker_id,
            gpu_seconds=20.0,
            platform_sig="cd" * 32,
            created_at=datetime(2026, 6, 1),
        )
        session.add_all([old, recent])
        session.commit()

    res = client.get(
        "/api/reports/contributions",
        params={"from": "2026-01-01", "to": "2026-12-31"},
        headers={"X-CSRF": csrf},
    )
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 1
    assert rows[0]["worker_id"] == worker_id
    assert rows[0]["name"] == "w1"
    assert rows[0]["jobs"] == 1
    assert rows[0]["gpu_seconds"] == 20.0

    res_all = client.get("/api/reports/contributions", headers={"X-CSRF": csrf})
    assert res_all.status_code == 200
    rows_all = res_all.json()
    assert len(rows_all) == 1
    assert rows_all[0]["jobs"] == 2
    assert rows_all[0]["gpu_seconds"] == 30.0


def test_contributions_rejects_an_unparseable_date(client):
    """M5: a bad `from`/`to` is the caller's mistake -> 400, not a 500."""
    _login(client)
    r = client.get("/api/reports/contributions?from=not-a-date")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "reports.bad_date"

    r = client.get("/api/reports/contributions?to=13/07/2026")
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "reports.bad_date"


def test_contributions_accepts_a_timezone_aware_date(client):
    """An aware bound is converted to naive UTC; receipts are stored naive."""
    _login(client)
    with db.get_session() as session:
        session.add(
            db.Receipt(job_id="j1", worker_id="w1", gpu_seconds=10.0, platform_sig="sig")
        )
        session.commit()

    # 08:00+08:00 == 00:00Z, so a receipt written "now" (UTC) is after it.
    yesterday = (datetime.now(timezone.utc) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S+08:00")
    r = client.get(f"/api/reports/contributions?from={quote(yesterday)}")
    assert r.status_code == 200
    assert r.json()[0]["gpu_seconds"] == 10.0

    tomorrow = (datetime.now(timezone.utc) + timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    r = client.get(f"/api/reports/contributions?from={quote(tomorrow)}")
    assert r.status_code == 200
    assert r.json() == []
