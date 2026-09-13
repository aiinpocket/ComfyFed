import asyncio
import hashlib
import json
import logging
import math
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from starlette.websockets import WebSocketDisconnect

from comfyfed_server import agentws, app as app_module
from comfyfed_server import bootstrap, db, dispatch, model_manifest


@pytest.fixture()
def client(tmp_path):
    data_dir = str(tmp_path)
    result = bootstrap.ensure_installed(data_dir, lang="en", url="http://h", interactive=False)
    app = app_module.create_app(data_dir)
    c = TestClient(app)
    c.admin_password = result.admin_password
    c.data_dir = data_dir
    yield c
    # Module-level, in-memory, per-process (see agentws._fetch_progress) --
    # reset between tests. Hash-conflict state is persisted on the
    # model_hashes row itself now (migration c9d0e1f2a3b4) and each test
    # gets a fresh tmp_path database, so there's nothing to reset for that.
    agentws._fetch_progress.clear()


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


def _submit_panel(client, workflow=None):
    """Submit a job as the panel would, via `/comfy/api/prompt`.

    `origin="panel"` is what `/comfy/api/interrupt` and `/comfy/api/queue`
    require to act on a job (see comfyapi.py) -- a job submitted through
    the console's `_submit` above is invisible to both.
    """
    workflow = workflow if workflow is not None else {"1": {"class_type": "KSampler", "inputs": {"seed": 1}}}
    r = client.post("/comfy/api/prompt", json={"prompt": workflow, "client_id": "panel-test"})
    assert r.status_code == 200
    return r.json()["prompt_id"]


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


def test_job_push_omits_fetch_models_for_a_directly_eligible_worker(client):
    """The ordinary push shape (no model gap at all) must carry no
    `fetch_models` key -- Task 4 is purely additive."""
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
        assert "fetch_models" not in job_msg


def _bytes(gb: float) -> int:
    return round(gb * (1024 ** 3))


def _sha(label: str) -> str:
    return hashlib.sha256(label.encode()).hexdigest()


def test_job_push_includes_fetch_models_for_an_eligible_after_fetch_worker(client):
    """The winning eligible_after_fetch worker's push carries `fetch_models`:
    the full manifest entries for exactly its missing models."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    worker_id, sk = _register_worker(client, csrf, "w1")
    # The console submit predicate (jobs.py) needs an ONLINE, opted-in worker
    # to accept a fetchable-missing model at submission time -- set that up
    # before submitting, then re-declare it for real over the WS hello below
    # (which is what actually matters for dispatch ranking).
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        worker.status = "online"
        worker.protocol = 3
        worker.auto_fetch = True
        worker.dynamic = json.dumps({"free_disk_gb": 100.0})
        session.commit()

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}}}
    job_id = _submit(client, csrf, workflow=workflow)

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "hello",
                "hardware": {},
                "backend": "cuda",
                "torch_version": "",
                "node_classes": [],
                "protocol": 3,
                "auto_fetch": True,
            }
        )
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_disk_gb": 100.0},
            }
        )
        agentws.dispatch_once(worker_id)

        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id
        assert "fetch_models" in job_msg
        entries = job_msg["fetch_models"]
        assert len(entries) == 1
        assert entries[0]["name"] == "flux1-dev.safetensors"
        assert entries[0]["size_bytes"] == _bytes(22.17)
        assert entries[0]["sha256"] == _sha("flux")

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "assigned"


def test_job_push_never_sent_to_a_protocol_2_worker_even_when_manifest_covers_it(client):
    """Defensive gate: a protocol<3 agent can never be dispatched an
    eligible_after_fetch job at all (assess._eligible_after_fetch already
    excludes it), so the job simply stays queued rather than being pushed
    without fetch_models."""
    csrf = _login(client)
    model_manifest.record_hash(
        "some-worker", "diffusion_models/flux1-dev.safetensors", _bytes(22.17), _sha("flux")
    )
    worker_id, sk = _register_worker(client, csrf, "w1")

    workflow = {"1": {"class_type": "UNETLoader", "inputs": {"unet_name": "flux1-dev.safetensors"}}}

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        _send_hello_v2(ws)  # protocol 2
        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            worker.auto_fetch = True
            worker.dynamic = json.dumps({"free_disk_gb": 100.0})
            session.commit()

        # Registering this worker (w1) makes the model missing-everywhere but
        # the manifest entry above still requires an ONLINE, protocol>=3,
        # opted-in worker to be considered fetchable at submission time --
        # a bare-registered second worker at protocol 3 supplies that so the
        # console predicate accepts the submission (Task 4's own concern is
        # dispatch, not submission, for this test).
        other_id = _register_worker(client, csrf, "w2")[0]
        with db.get_session() as session:
            other = session.get(db.Worker, other_id)
            other.status = "online"
            other.protocol = 3
            other.auto_fetch = True
            other.dynamic = json.dumps({"free_disk_gb": 100.0})
            session.commit()

        job_id = _submit(client, csrf, workflow=workflow)

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {"free_disk_gb": 100.0}})
        agentws.dispatch_once(worker_id)

    # w1 (protocol 2) must never win this job even though it's otherwise the
    # only idle connection dispatch_tick sees -- it stays queued.
    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"


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


def _send_hello_v2(ws):
    """Declare protocol 2 on an already-connected `ws` -- what a current
    comfyfed-agent does right after handshake (see runner.send_hello).
    Sends no reply frame (unlike a protocol-1-defaulting hello, which earns
    a one-time deprecation notice -- see test_hello_without_protocol_...),
    so it's safe to call without an immediate matching receive_json."""
    ws.send_json(
        {
            "type": "hello",
            "hardware": {},
            "backend": "cuda",
            "torch_version": "",
            "node_classes": [],
            "protocol": 2,
        }
    )


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


def test_inventory_entries_with_exact_size_bytes_are_learned_verbatim(client):
    """A Task 1+ agent that also reports the file's exact `size_bytes`
    (`hardware.scan_models`) must have THAT value stored, not a
    reconstruction from the rounded `size` GB figure -- the signed manifest
    payload has to pin the real byte length."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    sha = hashlib.sha256(b"clip").hexdigest()
    exact_size_bytes = round(0.23 * (1024 ** 3)) + 7  # deliberately off the rounded GB figure

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "inventory",
                "models": [
                    {
                        "name": "text_encoders/clip_l.safetensors",
                        "size": 0.23,
                        "size_bytes": exact_size_bytes,
                        "sha256": sha,
                    },
                    {"name": "vae/no_hash_yet.safetensors", "size": 0.31},
                ],
            }
        )
        agentws.dispatch_once(worker_id)

    with db.get_session() as session:
        row = session.get(db.ModelHash, ("text_encoders/clip_l.safetensors", exact_size_bytes))
        assert row is not None
        assert row.sha256 == sha
        assert row.first_worker_id == worker_id
        # No row at the rounded-GB reconstruction -- the exact value won.
        assert session.get(db.ModelHash, ("text_encoders/clip_l.safetensors", round(0.23 * 1024 ** 3))) is None
        # The hash-less entry must not have produced any row at all.
        assert session.query(db.ModelHash).count() == 1


def test_inventory_entries_without_size_bytes_fall_back_to_rounded_gb(client):
    """An agent that hashes but predates the exact `size_bytes` field (only
    sends `sha256` + the rounded `size` GB) still gets learned, via the
    documented fallback reconstruction."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    sha = hashlib.sha256(b"clip").hexdigest()

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "inventory",
                "models": [
                    {"name": "text_encoders/clip_l.safetensors", "size": 0.23, "sha256": sha},
                    {"name": "vae/no_hash_yet.safetensors", "size": 0.31},
                ],
            }
        )
        agentws.dispatch_once(worker_id)

    size_bytes = round(0.23 * (1024 ** 3))
    with db.get_session() as session:
        row = session.get(db.ModelHash, ("text_encoders/clip_l.safetensors", size_bytes))
        assert row is not None
        assert row.sha256 == sha
        assert row.first_worker_id == worker_id
        # The hash-less entry must not have produced any row at all.
        assert session.query(db.ModelHash).count() == 1


def test_inventory_hash_conflict_between_two_workers_poisons_the_name(client, caplog):
    csrf = _login(client)
    worker_a, sk_a = _register_worker(client, csrf, "wa")
    worker_b, sk_b = _register_worker(client, csrf, "wb")
    sha_a = hashlib.sha256(b"a").hexdigest()
    sha_b = hashlib.sha256(b"b").hexdigest()

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        ws.send_json(
            {"type": "auth", "worker_id": worker_a, "sig": sk_a.sign(challenge["nonce"].encode()).signature.hex()}
        )
        assert ws.receive_json()["type"] == "ready"
        ws.send_json(
            {"type": "inventory", "models": [{"name": "clip_l.safetensors", "size": 0.23, "sha256": sha_a}]}
        )
        agentws.dispatch_once(worker_a)

    with caplog.at_level(logging.WARNING, logger="comfyfed_server.model_manifest"):
        with client.websocket_connect("/api/agent/ws") as ws:
            challenge = ws.receive_json()
            ws.send_json(
                {"type": "auth", "worker_id": worker_b, "sig": sk_b.sign(challenge["nonce"].encode()).signature.hex()}
            )
            assert ws.receive_json()["type"] == "ready"
            ws.send_json(
                {"type": "inventory", "models": [{"name": "clip_l.safetensors", "size": 0.23, "sha256": sha_b}]}
            )
            agentws.dispatch_once(worker_b)

    assert any(
        r.levelno == logging.WARNING and worker_a in r.message and worker_b in r.message
        for r in caplog.records
    )
    size_bytes = round(0.23 * (1024 ** 3))
    with db.get_session() as session:
        row = session.get(db.ModelHash, ("clip_l.safetensors", size_bytes))
        assert row is not None
        assert row.conflict is True


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
    dispatch.mark_running fires once and is rate-limited to DEBUG for the
    same (connection, job id) after that -- see Task 2."""
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
        _send_hello_v2(ws_b)  # protocol 2, so it can be told via job_cancelled
        try:
            with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
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
            assert len(warnings) == 1  # rate-limited: only the first heartbeat warns
            debugs = [r for r in caplog.records if r.levelno == logging.DEBUG]
            assert len(debugs) == 2  # the repeats are downgraded, not silenced

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
    _send_hello_v2(ws_a)  # protocol 2, so it can be told the stale job_done via job_cancelled
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
    _send_hello_v2(ws)  # protocol 2, so the cancel can reach it via job_cancelled
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
    job_id = _submit_panel(client)

    ws = _connect(client, worker_id, sk)
    _send_hello_v2(ws)  # protocol 2, so the interrupt can reach it via job_cancelled
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)  # -> running

        r = client.post("/comfy/api/interrupt")
        assert r.status_code == 200

        # The cancelled receipt is minted before job_cancelled is pushed (so
        # a push failure can never cost the receipt), so the receipt frame
        # now arrives first.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "cancelled"
        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"
    finally:
        ws.close()


def test_comfy_queue_delete_pushes_job_cancelled_to_the_assigned_worker(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit_panel(client)

    ws = _connect(client, worker_id, sk)
    _send_hello_v2(ws)  # protocol 2, so the delete can reach it via job_cancelled
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


# --- Final review Major 1: a cancel the owner missed must be re-pushed ------


def test_cancel_then_owner_heartbeat_pushes_job_cancelled_once_without_warning_spam(client, caplog):
    """The cancel push landing nowhere (agent mid-reconnect) must not be the
    end of it: the owner's very next busy heartbeat has to learn about it.

    `cancel_job` clears `worker_id` (recording `last_worker_id`), so every
    later reference by the old owner takes the not-owned path -- which pushes
    `job_cancelled`, deduped per connection. And because that worker IS the
    job's former owner and the job is terminal, the repeat heartbeats log at
    DEBUG: WARNING stays reserved for forged job ids.
    """
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    _send_hello_v2(ws_a)  # protocol 2, so the re-push can reach it via job_cancelled
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        # Cancelled straight through dispatch, i.e. the push found no live
        # connection -- exactly the window the review reproduced.
        assert dispatch.cancel_job(job_id, reason="operator cancelled") == worker_a
        with db.get_session() as session:
            job = session.get(db.Job, job_id)
            assert job.status == "cancelled"
            assert job.worker_id is None
            assert job.last_worker_id == worker_a

        with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
            for progress in (0.1, 0.4, 0.7):
                ws_a.send_json(
                    {
                        "type": "heartbeat",
                        "state": "busy",
                        "progress": progress,
                        "job_id": job_id,
                        "dynamic": {},
                    }
                )
                agentws.dispatch_once(worker_a)

        assert ws_a.receive_json() == {"type": "job_cancelled", "job_id": job_id}
        # Exactly one push for the whole burst.
        assert agentws._connections[worker_a].cancelled_jobs_sent == {job_id}

        warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
        assert warnings == [], "a former owner's heartbeat for its cancelled job is not a forgery signal"
        assert any(r.levelno == logging.DEBUG for r in caplog.records)
    finally:
        ws_a.close()


def test_forged_job_id_from_a_stranger_still_warns(client, caplog):
    """The DEBUG downgrade above must not blind the forgery signal: a worker
    referencing a job it never owned still logs WARNING."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"

        ws_b = _connect(client, worker_b, key_b)
        try:
            dispatch.cancel_job(job_id, reason="operator cancelled")
            with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
                ws_b.send_json(
                    {"type": "heartbeat", "state": "busy", "progress": 0.5, "job_id": job_id, "dynamic": {}}
                )
                agentws.dispatch_once(worker_b)

            warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
            assert len(warnings) == 1
        finally:
            ws_b.close()
    finally:
        ws_a.close()


# --- Task 2: agentws hygiene -- bounded dedup, rate-limited warnings --------


def test_cancelled_jobs_sent_is_bounded_with_fifo_eviction(client):
    """A connection lives as long as the agent stays attached -- potentially
    days -- so `cancelled_jobs_sent` must not grow without bound. Capped at
    512, oldest entry evicted first (see agentws._BoundedSet)."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        conn = agentws._connections[worker_id]
        for i in range(600):
            conn.cancelled_jobs_sent.add(f"job-{i}")

        assert len(conn.cancelled_jobs_sent) == 512
        # The oldest 88 entries (600 - 512) were evicted...
        assert "job-0" not in conn.cancelled_jobs_sent
        assert "job-87" not in conn.cancelled_jobs_sent
        # ...and the 512 most recent survive, oldest-first eviction order.
        assert "job-88" in conn.cancelled_jobs_sent
        assert "job-599" in conn.cancelled_jobs_sent

        # Re-adding an already-present item is a no-op, not a re-insertion --
        # it must not disturb eviction order or count.
        conn.cancelled_jobs_sent.add("job-599")
        assert len(conn.cancelled_jobs_sent) == 512
    finally:
        ws.close()


def test_bounded_set_eviction_causes_only_a_harmless_duplicate_push(client):
    """Contract check for the behavior note in agentws._send_job_cancelled:
    if a job id is evicted from `cancelled_jobs_sent` and then referenced
    again, the dedup simply doesn't fire and a second `job_cancelled` push
    goes out -- there is no crash, no state corruption, and the agent treats
    the push idempotently (it just re-aborts a run it was already told to
    abort), so this is asserted as an accepted rare duplicate, not a bug."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        conn = agentws._connections[worker_id]
        conn.cancelled_jobs_sent.add("evicted-job")
        for i in range(512):
            conn.cancelled_jobs_sent.add(f"filler-{i}")
        assert "evicted-job" not in conn.cancelled_jobs_sent  # pushed out of the cap

        # A second push for the now-evicted id is allowed through again --
        # exactly the "rare duplicate push" the eviction note describes.
        assert "evicted-job" not in conn.cancelled_jobs_sent
    finally:
        ws.close()


def test_unknown_message_type_warns_once_then_debug(client, caplog):
    """Rate limit for unknown message types, mirroring the job-id policy:
    the first bogus type from a connection logs WARNING, repeats of the same
    type name log DEBUG instead."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        with caplog.at_level(logging.DEBUG, logger="comfyfed_server.agentws"):
            for _ in range(3):
                ws.send_json({"type": "not_a_real_type"})
                agentws.dispatch_once(worker_id)

        relevant = [r for r in caplog.records if "unknown message type" in r.getMessage()]
        warnings = [r for r in relevant if r.levelno >= logging.WARNING]
        debugs = [r for r in relevant if r.levelno == logging.DEBUG]
        assert len(warnings) == 1
        assert len(debugs) == 2
    finally:
        ws.close()


def test_unknown_message_type_rate_limit_is_per_type_name(client, caplog):
    """A different unknown type name gets its own first WARNING -- the rate
    limit is keyed by type name, not a single global switch."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        with caplog.at_level(logging.DEBUG, logger="comfyfed_server.agentws"):
            ws.send_json({"type": "bogus_a"})
            agentws.dispatch_once(worker_id)
            ws.send_json({"type": "bogus_a"})
            agentws.dispatch_once(worker_id)
            ws.send_json({"type": "bogus_b"})
            agentws.dispatch_once(worker_id)

        relevant = [r for r in caplog.records if "unknown message type" in r.getMessage()]
        warnings = [r for r in relevant if r.levelno >= logging.WARNING]
        assert len(warnings) == 2  # first bogus_a, first bogus_b
    finally:
        ws.close()


def test_repeat_forged_job_id_warns_once_then_debug_across_message_kinds(client, caplog):
    """The rate limit is per (connection, job id), not per message kind: a
    forged job id first seen via a busy heartbeat still gets downgraded to
    DEBUG on a subsequent `job_done` for the very same id."""
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
        _send_hello_v2(ws_b)  # protocol 2, so it can be told via job_cancelled
        try:
            with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
                ws_b.send_json(
                    {"type": "heartbeat", "state": "busy", "progress": 0.1, "job_id": job_id, "dynamic": {}}
                )
                agentws.dispatch_once(worker_b)
                ws_b.receive_json()  # job_cancelled

                ws_b.send_json({"type": "job_done", "job_id": job_id, "result_files": ["x.png"]})
                agentws.dispatch_once(worker_b)

            warnings = [r for r in caplog.records if r.levelno >= logging.WARNING]
            debugs = [r for r in caplog.records if r.levelno == logging.DEBUG]
            assert len(warnings) == 1  # only the first (heartbeat) reference warned
            assert len(debugs) == 1  # the job_done repeat was downgraded

            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                assert job.status == "assigned"
                assert job.worker_id == worker_a
                assert json.loads(job.result_files) == []
        finally:
            ws_b.close()
    finally:
        ws_a.close()


# --- Task 5: non-billable receipts for failed and cancelled runs -----------


def _run_to_running(client, csrf, worker_id, sk, job_id):
    """Connect `worker_id`, get `job_id` dispatched to it, and mark it
    running -- the shared setup every failed/cancelled-receipt test needs.
    Returns the open websocket (caller must close it)."""
    ws = _connect(client, worker_id, sk)
    _send_hello_v2(ws)  # protocol 2, so cancel/job_cancelled pushes reach it
    ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
    agentws.dispatch_once(worker_id)
    assert ws.receive_json()["type"] == "job"
    ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.0, "job_id": job_id, "dynamic": {}})
    agentws.dispatch_once(worker_id)
    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "running"
    return ws


def test_job_failed_mints_non_billable_receipt_with_exec_basis(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        # Large wall-clock span so the exec/wall cap (m2) never binds here --
        # this test is about the exec basis being honoured, not the cap.
        _backdate_started_at(job_id, hours=1)
        ws.send_json(
            {"type": "job_failed", "job_id": job_id, "error": "boom", "exec_seconds": 2.5}
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "failed"
        assert receipt_msg["billable"] is False
        assert receipt_msg["basis"] == "exec"
        # The signed payload byte-format is UNCHANGED: existing worker
        # verifiers must keep validating it regardless of the new kind/
        # billable/basis fields riding alongside it.
        assert receipt_msg["payload"] == f"{job_id}|{worker_id}|2.5"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.kind == "failed"
            assert receipt.billable is False
            assert receipt.basis == "exec"
            assert receipt.gpu_seconds == 2.5
            assert receipt.job_id == job_id
            assert receipt.worker_id == worker_id
    finally:
        ws.close()


def test_job_failed_caps_absurd_exec_seconds_at_the_wall_clock(client):
    """Final-review m2: a failure receipt is non-billable, but
    `unbilled_gpu_seconds` in the contributions report is a capacity/health
    number -- an agent bug (or a hostile agent) reporting an absurd
    `exec_seconds` for a fast failure must still be capped at the wall
    clock, exactly like the completed-receipt path already is."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        # Wall clock stays small (no backdating) -- just the real time
        # elapsed by the test itself, well under a second.
        ws.send_json(
            {"type": "job_failed", "job_id": job_id, "error": "boom", "exec_seconds": 999999.0}
        )
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["basis"] == "exec"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert 0.0 <= receipt.gpu_seconds < 5.0  # capped, nowhere near 999999
    finally:
        ws.close()


def test_job_failed_without_exec_seconds_falls_back_to_wall_basis(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom"})
        agentws.dispatch_once(worker_id)

        receipt_msg = ws.receive_json()
        assert receipt_msg["kind"] == "failed"
        assert receipt_msg["billable"] is False
        assert receipt_msg["basis"] == "wall"

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.basis == "wall"
            assert receipt.gpu_seconds >= 0
    finally:
        ws.close()


def test_job_failed_receipt_can_still_be_counter_signed(client):
    """The failed-receipt frame is a real receipt, not a notification -- the
    worker's normal `receipt_ack` flow must work on it exactly like a
    completed one."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        ws.send_json({"type": "job_failed", "job_id": job_id, "error": "boom"})
        agentws.dispatch_once(worker_id)
        receipt_msg = ws.receive_json()

        worker_sig = sk.sign(receipt_msg["payload"].encode()).signature.hex()
        ws.send_json(
            {"type": "receipt_ack", "receipt_id": receipt_msg["receipt_id"], "worker_sig": worker_sig}
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            receipt = session.get(db.Receipt, receipt_msg["receipt_id"])
            assert receipt.worker_sig == worker_sig
    finally:
        ws.close()


def test_console_cancel_of_running_job_mints_cancelled_receipt(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert res.status_code == 200

        # The cancelled receipt is minted before job_cancelled is pushed (so
        # a push failure can never cost the receipt), so the receipt frame
        # now arrives first.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "cancelled"
        assert receipt_msg["billable"] is False
        assert receipt_msg["basis"] == "wall"
        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            receipts = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).all()
            assert len(receipts) == 1  # exactly once
            assert receipts[0].kind == "cancelled"
            assert receipts[0].gpu_seconds >= 0
    finally:
        ws.close()


def test_panel_interrupt_of_running_job_mints_cancelled_receipt(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit_panel(client)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        res = client.post("/comfy/api/interrupt")
        assert res.status_code == 200

        receipt_msg = ws.receive_json()  # receipt now precedes job_cancelled
        assert receipt_msg["kind"] == "cancelled"
        assert receipt_msg["billable"] is False
        ws.receive_json()  # job_cancelled

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 1
    finally:
        ws.close()


def test_panel_queue_delete_of_running_job_mints_cancelled_receipt(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit_panel(client)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        res = client.post("/comfy/api/queue", json={"delete": [job_id]})
        assert res.status_code == 200

        receipt_msg = ws.receive_json()  # receipt now precedes job_cancelled
        assert receipt_msg["kind"] == "cancelled"
        ws.receive_json()  # job_cancelled

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 1
    finally:
        ws.close()


def test_cancel_of_queued_job_mints_no_receipt(client):
    """Nothing ran, so nothing is owed a receipt at all -- billable or not."""
    csrf = _login(client)
    job_id = _submit(client, csrf)

    res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert res.status_code == 200

    with db.get_session() as session:
        assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 0


def test_cancel_of_assigned_but_not_yet_running_job_mints_no_receipt(client):
    """`started_at` is only set by the busy heartbeat (mark_running); a job
    merely handed to a worker but not yet started has burned no GPU time."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "assigned"

        res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
        assert res.status_code == 200

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 0
    finally:
        ws.close()


def test_cancel_and_notify_pushes_receipt_across_event_loops(client):
    """`cancel_and_notify` (and therefore `_mint_cancelled_receipt` /
    `_push_receipt_frame`) can be invoked from a different event loop than
    the one the target connection was accepted on -- e.g. an admin/panel
    HTTP handler running under its own async context relative to a
    long-lived agent websocket. `asyncio.run(...)` here genuinely starts a
    fresh loop distinct from `TestClient`'s (mirrors the `relay()` helper in
    test_comfy_panel_ws.py, which exercises `panelws`'s equivalent
    cross-loop branch the same way): before the fix for review finding M1,
    `_push_receipt_frame` awaited `conn.ws.send_json` directly regardless of
    which loop `conn` belonged to, which fails against a foreign loop and
    was then silently swallowed by the bare `except Exception` around the
    send -- the worker would never see the frame to counter-sign. Pushing
    `job_cancelled` already had the loop-check/`run_coroutine_threadsafe`
    guard (`push_job_cancelled`); the receipt push now mirrors it."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        assert asyncio.run(agentws.cancel_and_notify(job_id, reason="cross-loop cancel"))

        # The cancelled receipt is minted before job_cancelled is pushed (so
        # a push failure can never cost the receipt), so the receipt frame
        # now arrives first.
        receipt_msg = ws.receive_json()
        assert receipt_msg["type"] == "receipt"
        assert receipt_msg["kind"] == "cancelled"
        assert receipt_msg["billable"] is False
        cancelled_msg = ws.receive_json()
        assert cancelled_msg == {"type": "job_cancelled", "job_id": job_id}

        with db.get_session() as session:
            receipts = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).all()
            assert len(receipts) == 1
    finally:
        ws.close()


def test_cancel_of_running_job_with_offline_worker_still_writes_receipt(client):
    """The owning worker may be offline at cancel time (an admin cancelling
    a job whose agent has already dropped/crashed). The receipt must still
    be written -- worker_sig NULL until an ack ever arrives -- rather than
    the mint being skipped just because there is nobody to push it to."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    ws.close()  # simulate the worker dropping off before the cancel lands

    res = client.post(f"/api/jobs/{job_id}/cancel", headers={"X-CSRF": csrf})
    assert res.status_code == 200

    with db.get_session() as session:
        receipts = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).all()
        assert len(receipts) == 1
        assert receipts[0].kind == "cancelled"
        assert receipts[0].billable is False
        assert receipts[0].worker_sig is None


def test_cancel_and_notify_still_mints_receipt_when_job_cancelled_push_raises(client, monkeypatch, caplog):
    """Final-review M2: `push_job_cancelled` can raise (a wedged or closed
    target event loop surfaces as `TimeoutError`/`RuntimeError` from
    `run_coroutine_threadsafe(...).result()`, uncaught by anything below the
    HTTP handler). The cancelled receipt must still be minted -- the mint no
    longer sits downstream of the push -- and `cancel_and_notify` must not
    propagate the failure to its caller (an HTTP handler cancelling several
    jobs in a loop)."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        def _boom(*args, **kwargs):
            raise TimeoutError("wedged target loop")

        monkeypatch.setattr(agentws, "push_job_cancelled", _boom)

        with caplog.at_level(logging.WARNING, logger="comfyfed_server.agentws"):
            result = asyncio.run(agentws.cancel_and_notify(job_id, reason="push failure"))

        assert result is True
        assert any("push job_cancelled" in rec.message for rec in caplog.records)

        with db.get_session() as session:
            assert session.get(db.Job, job_id).status == "cancelled"
            receipts = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).all()
            assert len(receipts) == 1
            assert receipts[0].kind == "cancelled"
    finally:
        ws.close()


def test_cancel_and_notify_isolates_panelws_notify_failure(client, monkeypatch, caplog):
    """A `panelws.job_cancelled` failure must not cost the already-minted
    receipt or the agent push, and must not propagate."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _run_to_running(client, csrf, worker_id, sk, job_id)
    try:
        async def _boom(*args, **kwargs):
            raise RuntimeError("panel loop closed")

        monkeypatch.setattr(agentws.panelws, "job_cancelled", _boom)

        with caplog.at_level(logging.WARNING, logger="comfyfed_server.agentws"):
            result = asyncio.run(agentws.cancel_and_notify(job_id, reason="panel failure"))

        assert result is True
        assert any("panelws.job_cancelled" in rec.message for rec in caplog.records)

        ws.receive_json()  # receipt
        ws.receive_json()  # job_cancelled

        with db.get_session() as session:
            assert session.query(db.Receipt).filter(db.Receipt.job_id == job_id).count() == 1
    finally:
        ws.close()


def test_panel_queue_clear_continues_past_one_jobs_notify_failure(client, monkeypatch):
    """Final-review M2: `POST /comfy/api/queue {"clear": true}` cancels every
    matching job in a loop -- one job's `cancel_and_notify` blowing up must
    not 500 the request or leave later jobs untouched."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_a = _submit_panel(client)
    job_b = _submit_panel(client)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        first = ws.receive_json()
        assert first["type"] == "job"
        running_job = first["job_id"]
        queued_job = job_b if running_job == job_a else job_a

        real_cancel_and_notify = agentws.cancel_and_notify

        async def _flaky(job_id, *, reason):
            if job_id == running_job:
                raise RuntimeError("boom")
            return await real_cancel_and_notify(job_id, reason=reason)

        import comfyfed_server.comfyapi as comfyapi_module

        monkeypatch.setattr(comfyapi_module.agentws, "cancel_and_notify", _flaky)

        res = client.post("/comfy/api/queue", json={"clear": True})
        assert res.status_code == 200

        with db.get_session() as session:
            # running_job's cancel_and_notify blew up entirely, but the loop
            # in post_queue must not abort on that -- the OTHER job in the
            # same sweep is still cancelled.
            assert session.get(db.Job, queued_job).status == "cancelled"
    finally:
        ws.close()


# --- Task 6: agent protocol 2 ----------------------------------------------


def test_hello_records_reported_protocol_and_platform(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x", "platform": "Linux"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 2,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.protocol == 2
            assert json.loads(worker.hardware)["platform"] == "Linux"
    finally:
        ws.close()


def test_hello_without_protocol_defaults_to_1_and_sends_deprecation_frame(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
            }
        )
        frame = ws.receive_json()
        assert frame["type"] == "deprecation"
        assert "agent 版本過舊" in frame["message"]
        assert "outdated" in frame["message"].lower()

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.protocol == 1
    finally:
        ws.close()


def test_hello_stores_reported_auto_fetch_true(client):
    """Phase 2.1 Task 3: hello's auto_fetch opt-in flag lands on the worker
    row so assess.verdict's eligible_after_fetch gate can read it."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 3,
                "auto_fetch": True,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.auto_fetch is True
    finally:
        ws.close()


def test_hello_stores_reported_auto_fetch_false(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 3,
                "auto_fetch": False,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.auto_fetch is False
    finally:
        ws.close()


def test_hello_without_auto_fetch_field_defaults_to_false(client):
    """An old (pre-Task-1) agent's hello has no `auto_fetch` key at all --
    must never be read as consent to auto-download models."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 2,
            }
        )
        agentws.dispatch_once(worker_id)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            assert worker.auto_fetch is False
    finally:
        ws.close()


def test_hello_with_protocol_2_sends_no_deprecation_frame(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 2,
            }
        )
        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        # The first (and only) frame this connection receives is the job
        # push -- no deprecation frame was ever sent.
        job_msg = ws.receive_json()
        assert job_msg["type"] == "job"
        assert job_msg["job_id"] == job_id
    finally:
        ws.close()


def test_job_cancelled_is_not_pushed_to_a_protocol_1_worker(client, caplog):
    """A protocol-1 worker (the default for a freshly registered worker that
    has never sent a `hello` with `protocol: 2`) can't act on `job_cancelled`
    -- it would only log an unknown-message-type warning -- so the server
    must skip the push silently rather than sending it."""
    csrf = _login(client)
    worker_a, key_a = _register_worker(client, csrf, "w-a")
    worker_b, key_b = _register_worker(client, csrf, "w-b")
    job_id = _submit(client, csrf)

    ws_a = _connect(client, worker_a, key_a)
    try:
        ws_a.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_a)
        assert ws_a.receive_json()["type"] == "job"  # worker_a now owns job_id

        # worker_b is protocol 1 by default (no hello sent).
        ws_b = _connect(client, worker_b, key_b)
        try:
            with caplog.at_level(logging.DEBUG, logger="comfyfed_server.dispatch"):
                ws_b.send_json(
                    {
                        "type": "heartbeat",
                        "state": "busy",
                        "progress": 0.1,
                        "job_id": job_id,
                        "dynamic": {},
                    }
                )
                agentws.dispatch_once(worker_b)

            # No job_cancelled was ever queued to push to worker_b.
            assert agentws._connections[worker_b].cancelled_jobs_sent == set()
        finally:
            ws_b.close()
    finally:
        ws_a.close()


def test_job_done_missing_exec_seconds_for_protocol_2_logs_error(client, caplog):
    """A protocol-2 agent guarantees `exec_seconds` once the run started
    (Task 5) -- omitting it is a protocol violation, not a routine fallback,
    so it must log at ERROR (still falling back to wall-clock billing)."""
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")
    job_id = _submit(client, csrf)

    ws = _connect(client, worker_id, sk)
    try:
        ws.send_json(
            {
                "type": "hello",
                "hardware": {"cpu": "x"},
                "backend": "cuda",
                "torch_version": "2.0",
                "node_classes": [],
                "protocol": 2,
            }
        )
        agentws.dispatch_once(worker_id)

        ws.send_json({"type": "heartbeat", "state": "idle", "progress": 0.0, "job_id": None, "dynamic": {}})
        agentws.dispatch_once(worker_id)
        assert ws.receive_json()["type"] == "job"

        ws.send_json({"type": "heartbeat", "state": "busy", "progress": 0.5, "job_id": job_id, "dynamic": {}})
        agentws.dispatch_once(worker_id)

        with caplog.at_level(logging.ERROR, logger="comfyfed_server.agentws"):
            ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
            agentws.dispatch_once(worker_id)
            ws.receive_json()  # receipt frame

        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert len(errors) == 1
        assert "protocol violation" in errors[0].message.lower()

        with db.get_session() as session:
            receipt = session.query(db.Receipt).filter(db.Receipt.job_id == job_id).one()
            assert receipt.basis == "wall"
    finally:
        ws.close()
