import hashlib
import io
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
import pytest
import secrets
import time
from alembic import command
from alembic.config import Config
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
    r = client.post("/api/auth/login", json={"username": "admin", "password": client.admin_password})
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


# --- Phase 1.7: artifact upload during the blip re-adoption window ----------


def test_artifact_upload_accepted_in_blip_readopt_window(client):
    """(d) A job requeued while its worker blipped (status=queued,
    last_worker_id=worker) still accepts that worker's artifact upload. The
    upload path is deliberately read-only -- it must not itself flip
    ownership; only a subsequent job_done's dispatch.try_readopt does that."""
    csrf = _login(client)
    w1_id, w1_key = _register_worker_with_key(client, csrf, "agent1")
    job_id = _submit(client, csrf)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "queued"
        job.worker_id = None
        job.last_worker_id = w1_id
        session.commit()

    path = f"/api/agent/jobs/{job_id}/artifacts"
    ok = _signed_post_multipart(client, path, w1_id, w1_key, "out.png", b"pixel-bytes")
    assert ok.status_code == 200

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        assert job.status == "queued"
        assert job.worker_id is None


def test_artifact_upload_rejected_when_blip_last_worker_mismatches(client):
    csrf = _login(client)
    w1_id, w1_key = _register_worker_with_key(client, csrf, "agent1")
    w2_id, _w2_key = _register_worker_with_key(client, csrf, "agent2")
    job_id = _submit(client, csrf)
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "queued"
        job.worker_id = None
        job.last_worker_id = w2_id
        session.commit()

    path = f"/api/agent/jobs/{job_id}/artifacts"
    forbidden = _signed_post_multipart(client, path, w1_id, w1_key, "out.png", b"pixel-bytes")
    assert forbidden.status_code == 403
    assert forbidden.json()["error"]["code"] == "jobs.not_assigned"


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


# --- Task 5: non-billable receipts in the contributions report -------------


def test_contributions_report_splits_billable_from_unbilled(client):
    """Headline `jobs`/`gpu_seconds` stay billable-only (unchanged semantics);
    non-billable (failed/cancelled) receipts show up only in
    `unbilled_gpu_seconds` and the per-receipt listing."""
    csrf = _login(client)
    worker_id, sk = _register_worker_with_key(client, csrf, "w1")

    with db.get_session() as session:
        session.add_all(
            [
                db.Receipt(
                    job_id="job-done",
                    worker_id=worker_id,
                    gpu_seconds=10.0,
                    platform_sig="ab" * 32,
                    kind="completed",
                    billable=True,
                    basis="exec",
                ),
                db.Receipt(
                    job_id="job-failed",
                    worker_id=worker_id,
                    gpu_seconds=4.0,
                    platform_sig="cd" * 32,
                    kind="failed",
                    billable=False,
                    basis="exec",
                ),
                db.Receipt(
                    job_id="job-cancelled",
                    worker_id=worker_id,
                    gpu_seconds=6.0,
                    platform_sig="ef" * 32,
                    kind="cancelled",
                    billable=False,
                    basis="wall",
                ),
            ]
        )
        session.commit()

    res = client.get("/api/reports/contributions", headers={"X-CSRF": csrf})
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 1
    row = rows[0]

    # Headline numbers: billable (completed) receipts only.
    assert row["jobs"] == 1
    assert row["gpu_seconds"] == 10.0
    # New: total non-billable GPU time for this worker.
    assert row["unbilled_gpu_seconds"] == 10.0

    receipts_by_job = {r["job_id"]: r for r in row["receipts"]}
    assert receipts_by_job["job-done"] == {
        "job_id": "job-done", "kind": "completed", "billable": True, "basis": "exec",
        "gpu_seconds": 10.0, "acked": False,
    }
    assert receipts_by_job["job-failed"]["kind"] == "failed"
    assert receipts_by_job["job-failed"]["billable"] is False
    assert receipts_by_job["job-cancelled"]["kind"] == "cancelled"
    assert receipts_by_job["job-cancelled"]["basis"] == "wall"


def test_contributions_report_marks_acked_receipts(client):
    csrf = _login(client)
    worker_id, sk = _register_worker_with_key(client, csrf, "w1")

    with db.get_session() as session:
        session.add(
            db.Receipt(
                job_id="job-acked",
                worker_id=worker_id,
                gpu_seconds=5.0,
                platform_sig="ab" * 32,
                worker_sig="cd" * 32,
            )
        )
        session.commit()

    res = client.get("/api/reports/contributions", headers={"X-CSRF": csrf})
    row = res.json()[0]
    assert row["receipts"][0]["acked"] is True


def test_alembic_migration_7_adds_and_backfills_kind_billable_basis(tmp_path):
    """A DB already at the previous head (migration #6, job origin/panel_hidden)
    must upgrade to head cleanly, backfilling every pre-existing receipt as
    kind=completed/billable=1/basis=exec -- exactly what every receipt was
    before this task existed."""
    db_path = str(tmp_path / "t.db")
    cfg = Config()
    cfg.set_main_option("script_location", db._alembic_dir())
    cfg.set_main_option("sqlalchemy.url", f"sqlite+pysqlite:///{db_path}")

    command.upgrade(cfg, "e5f6a7b8c9d0")  # pre-existing DB, one migration behind

    conn = sqlite3.connect(db_path)
    try:
        conn.execute(
            "INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at) "
            "VALUES ('r1', 'j1', 'w1', 5.0, 'sig', '2026-01-01 00:00:00')"
        )
        conn.commit()
    finally:
        conn.close()

    command.upgrade(cfg, "head")

    conn = sqlite3.connect(db_path)
    try:
        cols = {row[1]: row for row in conn.execute("PRAGMA table_info(receipts)").fetchall()}
        row = conn.execute(
            "SELECT kind, billable, basis FROM receipts WHERE id = 'r1'"
        ).fetchone()
    finally:
        conn.close()

    assert {"kind", "billable", "basis"} <= set(cols)
    assert row == ("completed", 1, "exec")

    # Downgrade must cleanly drop all three columns again.
    command.downgrade(cfg, "e5f6a7b8c9d0")
    conn = sqlite3.connect(db_path)
    try:
        cols_after = {row[1] for row in conn.execute("PRAGMA table_info(receipts)").fetchall()}
    finally:
        conn.close()
    assert not ({"kind", "billable", "basis"} & cols_after)


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


# --- Task 5: per-user usage, my-usage, payout reports -----------------------


def _create_user(client, admin_csrf, username, role="user", password="password123"):
    r = client.post(
        "/api/users",
        json={"username": username, "role": role, "password": password},
        headers={"X-CSRF": admin_csrf},
    )
    assert r.status_code == 200, r.text
    return r.json()


def test_usage_report_aggregates_per_user_and_null_legacy_row(client):
    admin_csrf = _login(client)
    worker_id, _sk = _register_worker_with_key(client, admin_csrf, "w1")
    alice = _create_user(client, admin_csrf, "alice", password="alice-pw-123")
    bob = _create_user(client, admin_csrf, "bob", password="bob-pw-123")

    with db.get_session() as session:
        session.add_all(
            [
                db.Job(id="job-alice-1", workflow_json="{}", user_id=alice["id"]),
                db.Job(id="job-alice-2", workflow_json="{}", user_id=alice["id"]),
                db.Job(id="job-bob-1", workflow_json="{}", user_id=bob["id"]),
                db.Job(id="job-legacy", workflow_json="{}", user_id=None),
            ]
        )
        session.add_all(
            [
                db.Receipt(job_id="job-alice-1", worker_id=worker_id, gpu_seconds=10.0, platform_sig="ab" * 32),
                db.Receipt(
                    job_id="job-alice-2", worker_id=worker_id, gpu_seconds=3.0, platform_sig="cd" * 32,
                    kind="failed", billable=False,
                ),
                db.Receipt(job_id="job-bob-1", worker_id=worker_id, gpu_seconds=5.0, platform_sig="ef" * 32),
                db.Receipt(job_id="job-legacy", worker_id=worker_id, gpu_seconds=7.0, platform_sig="99" * 32),
            ]
        )
        session.commit()

    res = client.get("/api/reports/usage", headers={"X-CSRF": admin_csrf})
    assert res.status_code == 200
    rows = res.json()
    by_user = {row["user_id"]: row for row in rows}

    assert by_user[alice["id"]] == {
        "user_id": alice["id"], "username": "alice", "jobs": 1, "gpu_seconds": 10.0, "unbilled_gpu_seconds": 3.0,
    }
    assert by_user[bob["id"]] == {
        "user_id": bob["id"], "username": "bob", "jobs": 1, "gpu_seconds": 5.0, "unbilled_gpu_seconds": 0.0,
    }
    assert by_user[None] == {
        "user_id": None, "username": None, "jobs": 1, "gpu_seconds": 7.0, "unbilled_gpu_seconds": 0.0,
    }
    # sorted gpu_seconds DESC
    assert [row["gpu_seconds"] for row in rows] == sorted((row["gpu_seconds"] for row in rows), reverse=True)


def test_usage_report_requires_admin(client):
    admin_csrf = _login(client)
    _create_user(client, admin_csrf, "alice", password="alice-pw-123")

    r = client.post("/api/auth/login", json={"username": "alice", "password": "alice-pw-123"})
    assert r.status_code == 200
    alice_csrf = r.json()["csrf"]

    res = client.get("/api/reports/usage", headers={"X-CSRF": alice_csrf})
    assert res.status_code == 403


def test_my_usage_is_isolated_to_the_session_user(client):
    admin_csrf = _login(client)
    worker_id, _sk = _register_worker_with_key(client, admin_csrf, "w1")
    alice = _create_user(client, admin_csrf, "alice", password="alice-pw-123")
    bob = _create_user(client, admin_csrf, "bob", password="bob-pw-123")

    with db.get_session() as session:
        session.add_all(
            [
                db.Job(id="job-alice-1", workflow_json="{}", user_id=alice["id"]),
                db.Job(id="job-bob-1", workflow_json="{}", user_id=bob["id"]),
            ]
        )
        session.add_all(
            [
                db.Receipt(job_id="job-alice-1", worker_id=worker_id, gpu_seconds=12.0, platform_sig="ab" * 32),
                db.Receipt(job_id="job-bob-1", worker_id=worker_id, gpu_seconds=99.0, platform_sig="cd" * 32),
            ]
        )
        session.commit()

    r = client.post("/api/auth/login", json={"username": "alice", "password": "alice-pw-123"})
    assert r.status_code == 200
    alice_csrf = r.json()["csrf"]

    res = client.get("/api/reports/my-usage", headers={"X-CSRF": alice_csrf})
    assert res.status_code == 200
    assert res.json() == {
        "user_id": alice["id"], "username": "alice", "jobs": 1, "gpu_seconds": 12.0, "unbilled_gpu_seconds": 0.0,
    }


def test_my_usage_returns_zeroed_row_when_no_receipts(client):
    admin_csrf = _login(client)
    carol = _create_user(client, admin_csrf, "carol", password="carol-pw-123")

    r = client.post("/api/auth/login", json={"username": "carol", "password": "carol-pw-123"})
    assert r.status_code == 200
    carol_csrf = r.json()["csrf"]

    res = client.get("/api/reports/my-usage", headers={"X-CSRF": carol_csrf})
    assert res.status_code == 200
    assert res.json() == {
        "user_id": carol["id"], "username": "carol", "jobs": 0, "gpu_seconds": 0.0, "unbilled_gpu_seconds": 0.0,
    }


def test_my_usage_allows_any_authenticated_user(client):
    # Admin's own bootstrap session can also call my-usage (any user, not
    # admin-only).
    admin_csrf = _login(client)
    res = client.get("/api/reports/my-usage", headers={"X-CSRF": admin_csrf})
    assert res.status_code == 200
    assert res.json()["jobs"] == 0


def test_payout_report_computes_ratio_and_amount_from_billable_gpu_seconds(client):
    admin_csrf = _login(client)
    w1_id, _sk1 = _register_worker_with_key(client, admin_csrf, "w1")
    w2_id, _sk2 = _register_worker_with_key(client, admin_csrf, "w2")

    with db.get_session() as session:
        session.add_all(
            [
                db.Receipt(job_id="j1", worker_id=w1_id, gpu_seconds=30.0, platform_sig="ab" * 32),
                db.Receipt(
                    job_id="j2", worker_id=w1_id, gpu_seconds=999.0, platform_sig="cd" * 32,
                    kind="failed", billable=False,
                ),
                db.Receipt(job_id="j3", worker_id=w2_id, gpu_seconds=10.0, platform_sig="ef" * 32),
            ]
        )
        session.commit()

    res = client.get("/api/reports/payout", params={"pool": "100"}, headers={"X-CSRF": admin_csrf})
    assert res.status_code == 200
    body = res.json()
    assert body["total_gpu_seconds"] == 40.0
    assert body["pool"] == 100.0
    workers = {w["worker_id"]: w for w in body["workers"]}
    assert workers[w1_id]["gpu_seconds"] == 30.0
    assert workers[w1_id]["ratio"] == pytest.approx(0.75)
    assert workers[w1_id]["amount"] == pytest.approx(75.0)
    assert workers[w2_id]["gpu_seconds"] == 10.0
    assert workers[w2_id]["ratio"] == pytest.approx(0.25)
    assert workers[w2_id]["amount"] == pytest.approx(25.0)
    # sorted gpu_seconds DESC
    assert [w["gpu_seconds"] for w in body["workers"]] == [30.0, 10.0]


def test_payout_report_zero_total_returns_empty_workers(client):
    admin_csrf = _login(client)
    res = client.get("/api/reports/payout", params={"pool": "50"}, headers={"X-CSRF": admin_csrf})
    assert res.status_code == 200
    assert res.json() == {"total_gpu_seconds": 0, "pool": 50.0, "workers": []}


def test_payout_report_rejects_missing_or_bad_or_negative_pool(client):
    admin_csrf = _login(client)

    r = client.get("/api/reports/payout", headers={"X-CSRF": admin_csrf})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "reports.bad_pool"

    r = client.get("/api/reports/payout", params={"pool": "not-a-number"}, headers={"X-CSRF": admin_csrf})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "reports.bad_pool"

    r = client.get("/api/reports/payout", params={"pool": "-5"}, headers={"X-CSRF": admin_csrf})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "reports.bad_pool"


def test_payout_report_requires_admin(client):
    admin_csrf = _login(client)
    _create_user(client, admin_csrf, "alice", password="alice-pw-123")

    r = client.post("/api/auth/login", json={"username": "alice", "password": "alice-pw-123"})
    assert r.status_code == 200
    alice_csrf = r.json()["csrf"]

    res = client.get("/api/reports/payout", params={"pool": "10"}, headers={"X-CSRF": alice_csrf})
    assert res.status_code == 403


def test_usage_and_payout_reports_respect_from_to_date_range(client):
    """Receipts seeded on two different dates: `from`/`to` on /usage,
    /my-usage, and /payout must all filter the same way /contributions
    already does (see test_contributions_report_filters_by_date_range)."""
    admin_csrf = _login(client)
    worker_id, _sk = _register_worker_with_key(client, admin_csrf, "w1")
    alice = _create_user(client, admin_csrf, "alice", password="alice-pw-123")

    with db.get_session() as session:
        session.add_all(
            [
                db.Job(id="job-old", workflow_json="{}", user_id=alice["id"]),
                db.Job(id="job-recent", workflow_json="{}", user_id=alice["id"]),
            ]
        )
        session.add_all(
            [
                db.Receipt(
                    job_id="job-old", worker_id=worker_id, gpu_seconds=10.0,
                    platform_sig="ab" * 32, created_at=datetime(2020, 1, 1),
                ),
                db.Receipt(
                    job_id="job-recent", worker_id=worker_id, gpu_seconds=20.0,
                    platform_sig="cd" * 32, created_at=datetime(2026, 6, 1),
                ),
            ]
        )
        session.commit()

    range_params = {"from": "2026-01-01", "to": "2026-12-31"}

    # /usage: only the in-range receipt counts.
    res = client.get("/api/reports/usage", params=range_params, headers={"X-CSRF": admin_csrf})
    assert res.status_code == 200
    rows = res.json()
    assert len(rows) == 1
    assert rows[0]["user_id"] == alice["id"]
    assert rows[0]["jobs"] == 1
    assert rows[0]["gpu_seconds"] == 20.0

    res_all = client.get("/api/reports/usage", headers={"X-CSRF": admin_csrf})
    assert res_all.status_code == 200
    rows_all = res_all.json()
    assert len(rows_all) == 1
    assert rows_all[0]["jobs"] == 2
    assert rows_all[0]["gpu_seconds"] == 30.0

    # /my-usage: same filtering, scoped to alice.
    r = client.post("/api/auth/login", json={"username": "alice", "password": "alice-pw-123"})
    assert r.status_code == 200
    alice_csrf = r.json()["csrf"]

    res_my = client.get("/api/reports/my-usage", params=range_params, headers={"X-CSRF": alice_csrf})
    assert res_my.status_code == 200
    assert res_my.json()["jobs"] == 1
    assert res_my.json()["gpu_seconds"] == 20.0

    # /payout: only the in-range receipt's gpu_seconds feed the pool split.
    # Re-login as admin -- the client's single cookie jar is currently
    # alice's session from the /my-usage check above.
    admin_csrf = _login(client)
    res_payout = client.get(
        "/api/reports/payout",
        params={**range_params, "pool": "100"},
        headers={"X-CSRF": admin_csrf},
    )
    assert res_payout.status_code == 200
    body = res_payout.json()
    assert body["total_gpu_seconds"] == 20.0
    assert body["workers"] == [
        {"worker_id": worker_id, "name": "w1", "gpu_seconds": 20.0, "ratio": 1.0, "amount": 100.0}
    ]
