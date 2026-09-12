import json
import logging
import math
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from starlette.websockets import WebSocketDisconnect

from comfyfed_server import agentws, app as app_module
from comfyfed_server import bootstrap, db, dispatch


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


def _register_worker(client, csrf, name):
    sk = SigningKey.generate()
    pubkey_hex = bytes(sk.verify_key).hex()
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post("/api/agent/register", json={"token": token, "name": name, "pubkey": pubkey_hex})
    return reg.json()["worker_id"], sk


def _submit(client, csrf, workflow=None):
    workflow = workflow if workflow is not None else {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}
    r = client.post(
        "/api/jobs",
        data={"workflow_json": json.dumps(workflow)},
        files=[],
        headers={"X-CSRF": csrf},
    )
    assert r.status_code == 200
    return r.json()["job_id"]


def test_handshake_with_bad_signature_closes_4401(client):
    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        assert challenge["type"] == "challenge"

        ws.send_json({"type": "auth", "worker_id": "unknown-worker", "sig": "00" * 64})

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4401


def test_handshake_with_unregistered_signature_closes_4401(client):
    csrf = _login(client)
    worker_id, _real_key = _register_worker(client, csrf, "w1")
    forged_key = SigningKey.generate()  # correct worker_id, wrong key -> bad sig

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        nonce = challenge["nonce"]
        sig = forged_key.sign(nonce.encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})

        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4401


def test_good_handshake_gets_ready(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        nonce = challenge["nonce"]
        sig = sk.sign(nonce.encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})

        ready = ws.receive_json()
        assert ready["type"] == "ready"


def test_heartbeat_updates_last_seen_and_status(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.last_seen is None

        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_vram_gb": 10.0},
            }
        )

        agentws.dispatch_once(worker_id)  # round-trips through the same loop; ensures heartbeat processed

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.last_seen is not None
            assert worker.status == "online"
            assert json.loads(worker.dynamic)["free_vram_gb"] == 10.0


def test_enqueued_job_pushed_to_idle_worker_and_job_done_marks_complete(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
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
        assert job_msg["job_id"] == job_id
        assert job_msg["input_assets"] == []
        assert "workflow_json" in job_msg

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "done"
            assert json.loads(job.result_files) == ["out.png"]


def test_job_failed_marks_job_failed(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        ws.receive_json()  # the pushed job message

        ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom"})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "failed"
            assert job.error == "boom"


def _connect(client, worker_id, sk):
    """Open an authenticated agent WS and return it (as a context manager)."""
    ws = client.websocket_connect("/api/agent/ws").__enter__()
    challenge = ws.receive_json()
    sig = sk.sign(challenge["nonce"].encode()).signature.hex()
    ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
    assert ws.receive_json()["type"] == "ready"
    return ws


def test_busy_heartbeat_marks_the_assigned_job_running(client):
    """C2: the agent's busy broadcast is what starts the job clock.

    Without it a job stayed "assigned" forever, started_at was never set, and
    every receipt recorded gpu_seconds == 0.
    """
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        # This is exactly what the agent runner broadcasts on job pickup.
        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "running"
            assert job.started_at is not None

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds > 0


def _backdate_started_at(job_id, hours):
    """Push a job's `started_at` into the past, so `finished_at - started_at`
    (the wall clock) is large by the time `job_done` is sent -- used to prove
    billing prefers `exec_seconds` over the wall clock rather than merely
    happening to agree with it on a normal, fast test run."""
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.started_at = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(hours=hours)
        session.commit()


def test_job_done_bills_exec_seconds_when_present_even_if_wall_clock_is_large(client):
    """Deliverable 3: `gpu_seconds = min(exec_seconds, wall)`. A worker that
    sat queued for an hour (large wall clock) before actually running for 2
    real seconds must only be billed those 2 seconds."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        _backdate_started_at(job_id, hours=1)

        ws.send_json(
            {"type": "job_done", "job_id": job_id, "result_files": ["out.png"], "exec_seconds": 2.0}
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds == 2.0
        assert receipt_msg["payload"] == f"{job_id}|{worker_id}|2.0"


def test_job_done_without_exec_seconds_falls_back_to_wall_clock(client, caplog):
    """Deliverable 3: a missing/invalid `exec_seconds` (older agent, or a
    ComfyUI whose /queue was unreachable) must fall back to the wall clock,
    with an info-level log noting the fallback."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        _backdate_started_at(job_id, hours=1)

        with caplog.at_level(logging.INFO, logger="comfyfed_server.agentws"):
            ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
            agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            # ~1 hour (3600s), allowing a little slack for real elapsed time.
            assert 3595 <= receipt.gpu_seconds <= 3605
        assert any("wall-clock" in rec.getMessage() for rec in caplog.records)


def test_job_done_with_nan_exec_seconds_falls_back_to_wall_clock(client):
    """A NaN literal survives `json.loads` as a real Python float, so it
    passes a naive `isinstance(..., (int, float))` check and a naive
    `< 0` comparison alike (NaN compares False to everything) -- it must be
    rejected explicitly via `math.isfinite`, or "nan" would end up baked into
    the signed receipt payload."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        _backdate_started_at(job_id, hours=1)

        ws.send_json(
            {
                "type": "job_done",
                "job_id": job_id,
                "result_files": ["out.png"],
                "exec_seconds": float("nan"),
            }
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert math.isfinite(receipt.gpu_seconds)
            assert receipt.gpu_seconds >= 0
            # ~1 hour wall-clock fallback, not NaN.
            assert 3595 <= receipt.gpu_seconds <= 3605
        assert "nan" not in receipt_msg["payload"].lower()


def test_job_done_with_negative_wall_clock_clamps_gpu_seconds_to_zero(client):
    """Clock skew between `started_at` and `finished_at` (or any other bug
    producing a negative wall clock) must never reach a signed receipt as a
    negative number -- it's clamped to 0.0."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # started_at pushed an hour into the *future* relative to `now` -- by
        # the time job_done sets finished_at, wall_seconds is negative.
        _backdate_started_at(job_id, hours=-1)

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds == 0.0
        assert receipt_msg["payload"] == f"{job_id}|{worker_id}|0.0"


def test_job_done_caps_absurd_exec_seconds_at_the_wall_clock(client):
    """Deliverable 3: `exec_seconds` far exceeding the wall clock (a buggy or
    hostile agent) must be capped at the wall clock, never inflate billing
    past what actually elapsed."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # Wall clock stays small (no backdating) -- just the real time
        # elapsed by the test itself, well under a second.
        ws.send_json(
            {"type": "job_done", "job_id": job_id, "result_files": ["out.png"], "exec_seconds": 999999.0}
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            wall = (job.finished_at - job.started_at).total_seconds()
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.gpu_seconds == wall
            assert receipt.gpu_seconds < 999999.0


def test_job_done_from_a_foreign_worker_changes_nothing(client):
    """C3: worker B must not be able to complete worker A's job."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        with client.websocket_connect("/api/agent/ws") as ws_b:
            challenge = ws_b.receive_json()
            sig = key_b.sign(challenge["nonce"].encode()).signature.hex()
            ws_b.send_json({"type": "auth", "worker_id": worker_b, "sig": sig})
            assert ws_b.receive_json()["type"] == "ready"

            ws_b.send_json({"type": "job_done", "job_id": job_id, "result_files": ["forged.png"]})
            agentws.dispatch_once(worker_b)

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.worker_id == worker_a
                assert json.loads(job.result_files) == []
                # No receipt was minted for the thief.
                assert session.query(db.Receipt).count() == 0
    finally:
        ws_a.close()


def test_job_failed_from_a_foreign_worker_changes_nothing(client):
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        with client.websocket_connect("/api/agent/ws") as ws_b:
            challenge = ws_b.receive_json()
            sig = key_b.sign(challenge["nonce"].encode()).signature.hex()
            ws_b.send_json({"type": "auth", "worker_id": worker_b, "sig": sig})
            assert ws_b.receive_json()["type"] == "ready"

            ws_b.send_json({"type": "job_failed", "job_id": job_id, "error": "sabotage"})
            agentws.dispatch_once(worker_b)

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.error is None
    finally:
        ws_a.close()


def test_busy_heartbeat_for_a_foreign_job_does_not_start_it(client):
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        with client.websocket_connect("/api/agent/ws") as ws_b:
            challenge = ws_b.receive_json()
            sig = key_b.sign(challenge["nonce"].encode()).signature.hex()
            ws_b.send_json({"type": "auth", "worker_id": worker_b, "sig": sig})
            assert ws_b.receive_json()["type"] == "ready"

            ws_b.send_json(
                {"type": "heartbeat", "state": "busy", "progress": 0.7, "job_id": job_id, "dynamic": {}}
            )
            agentws.dispatch_once(worker_b)

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.started_at is None
                assert job.progress == 0
    finally:
        ws_a.close()


def test_byte_scale_inventory_is_converted_to_gigabytes(client):
    """C1: an old agent reporting raw bytes must not blow up the VRAM estimate."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    six_gb_in_bytes = 6 * 1024 ** 3

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "inventory",
                "models": [
                    {"name": "sd_xl_base.safetensors", "size": six_gb_in_bytes},
                    {"name": "vae.safetensors", "size": 0.3},  # already GB: untouched
                ],
            }
        )
        agentws.dispatch_once(worker_id)

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        inventory = {e["name"]: e["size"] for e in json.loads(worker.model_inventory)}

    assert inventory["sd_xl_base.safetensors"] == 6.0
    assert inventory["vae.safetensors"] == 0.3

    # And the estimate that reads it stays in a sane GB range.
    workflow = {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "sd_xl_base.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow)
    detail = client.get(f"/api/jobs/{job_id}", headers={"X-CSRF": csrf}).json()
    assert 6.0 <= detail["est_vram_gb"] <= 8.0


def test_repeated_busy_heartbeat_is_a_silent_no_op(client, caplog):
    """A job's later busy heartbeats must not warn.

    The agent heartbeats every 30s for the whole length of a job, but only the
    first one has a transition to make. If the rest logged at WARNING they
    would bury the cross-worker forgery signal that shares this code path.
    """
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            first = session.get(db.Job, job_id)
            assert first.status == "running"
            started_at = first.started_at

        # Everything from here on must be silent at WARNING and change nothing.
        with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
            for progress in (0.3, 0.6, 0.9):
                ws.send_json(
                    {
                        "type": "heartbeat",
                        "state": "busy",
                        "progress": progress,
                        "job_id": job_id,
                        "dynamic": {},
                    }
                )
                agentws.dispatch_once(worker_id)

        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert warnings == [], [r.getMessage() for r in warnings]
        # It is still logged, just at DEBUG.
        assert any(r.levelno == logging.DEBUG for r in caplog.records)

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "running"
            assert job.started_at == started_at  # not restarted
            assert job.progress == 0.9  # progress still tracked


def test_foreign_and_terminal_transitions_still_warn(client, caplog):
    """The forgery signal stays loud: wrong owner, and re-finishing a done job."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, _key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        job.status = "assigned"
        job.worker_id = worker_a
        session.commit()

    with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
        # Wrong owner.
        assert dispatch.mark_done(job_id, worker_b, []) is False
        # Unknown job id.
        assert dispatch.mark_done("no-such-job", worker_a, []) is False

    warnings = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(warnings) == 2
    assert any(worker_b in m for m in warnings)
    assert any("no-such-job" in m for m in warnings)

    # Finish it legitimately, then try to finish it again.
    assert dispatch.mark_done(job_id, worker_a, ["out.png"]) is True

    caplog.clear()
    with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
        assert dispatch.mark_done(job_id, worker_a, ["again.png"]) is False

    terminal_warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
    assert len(terminal_warnings) == 1
    assert "done" in terminal_warnings[0].getMessage()


# --- Phase 1.7: job_cancelled push + blip re-adoption -----------------------


def test_busy_heartbeat_for_foreign_job_sends_job_cancelled_once_with_dedup(client, caplog):
    """(a) A worker repeatedly heartbeating a job it doesn't own gets
    `job_cancelled` exactly once (dedup), while the ownership WARNING from
    dispatch.mark_running keeps firing on every single heartbeat."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"  # worker_a now owns job_id

        ws_b = _connect(client, worker_b, key_b)
        try:
            with caplog.at_level(logging.WARNING, logger="comfyfed_server.dispatch"):
                for progress in (0.1, 0.4, 0.7):
                    ws_b.send_json(
                        {
                            "type": "heartbeat",
                            "state": "busy",
                            "progress": progress,
                            "job_id": job_id,
                            "dynamic": {},
                        }
                    )
                    agentws.dispatch_once(worker_b)

            cancelled_msg = ws_b.receive_json()
            assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

            warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
            assert len(warnings) == 3  # one per heartbeat, still not deduped

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.worker_id == worker_a
                assert job.started_at is None
        finally:
            ws_b.close()
    finally:
        ws_a.close()


def test_job_done_after_blip_readopts_and_completes(client):
    """(b) A job_done from the same worker last_worker_id names, for a job
    that's back to `queued` (a blip requeue), is re-adopted and finishes
    exactly like a normal completion -- no job_cancelled."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # Simulate the requeue dispatch.requeue_stale performs when this
        # worker blips offline mid-run: back to queued, ownership cleared,
        # last_worker_id recorded.
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            job.status = "queued"
            job.worker_id = None
            job.last_worker_id = worker_id
            session.commit()

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

        # The very next message is the receipt -- not a job_cancelled.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "done"
            assert json.loads(job.result_files) == ["out.png"]
            assert session.query(db.Receipt).count() == 1
    finally:
        ws.close()


def test_job_done_for_job_now_owned_by_another_worker_is_rejected_and_cancelled(client):
    """(c) A stale job_done from worker A for a job worker B now actually
    owns is rejected outright, A is told via job_cancelled, and B's job is
    untouched."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, _key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        # Simulate: A blipped, the job was requeued (last_worker_id=A), and
        # worker B has since actually picked it up and is running it.
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            job.status = "running"
            job.worker_id = worker_b
            job.last_worker_id = worker_a
            job.started_at = datetime.now(timezone.utc).replace(tzinfo=None)
            session.commit()

        ws_a.send_json({"type": "job_done", "job_id": job_id, "result_files": ["stale.png"]})
        agentws.dispatch_once(worker_a)

        cancelled_msg = ws_a.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "running"
            assert job.worker_id == worker_b
            assert json.loads(job.result_files) == []
            assert session.query(db.Receipt).count() == 0
    finally:
        ws_a.close()


# --- Task 2: cancel entry points push job_cancelled to the owning agent -----


def test_admin_cancel_pushes_job_cancelled_to_the_owning_agent(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"  # worker now owns job_id, status=assigned

        r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert r.status_code == 200

        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"
    finally:
        ws.close()


def test_admin_cancel_of_an_unowned_queued_job_sends_nothing_to_any_agent(client):
    """A queued job has no owner yet -- there is no connection to push to."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        r = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert r.status_code == 200

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"

        # Nothing was ever queued to push to this connection -- no job to
        # dispatch, and no job_cancelled for a job it never owned.
        assert agentws._connections[worker_id].cancelled_jobs_sent == set()
    finally:
        ws.close()


def test_comfy_interrupt_pushes_job_cancelled_to_the_running_worker(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)  # -> running

        r = client.post("/comfy/api/interrupt")
        assert r.status_code == 200

        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"
    finally:
        ws.close()


def test_comfy_queue_delete_pushes_job_cancelled_to_the_assigned_worker(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"  # assigned to worker_id

        r = client.post("/comfy/api/queue", json={"delete": [job_id]})
        assert r.status_code == 200

        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}
    finally:
        ws.close()


def test_job_done_resent_for_own_terminal_job_does_not_send_job_cancelled(client):
    """A duplicate job_done for a job this worker already legitimately
    finished must not be mistaken for "not owned" -- it still owns the job,
    it's just too late. No job_cancelled belongs on that socket."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "receipt"

        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["again.png"]})
        agentws.dispatch_once(worker_id)

        # No job_cancelled was queued for the resend -- it still owns the
        # job, it's just too late to matter.
        assert job_id not in agentws._connections[worker_id].cancelled_jobs_sent

        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "done"
            assert json.loads(job.result_files) == ["out.png"]
    finally:
        ws.close()
