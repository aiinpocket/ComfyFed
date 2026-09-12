import json

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey
from starlette.websockets import WebSocketDisconnect

from comfyfed_server import agentws, app as app_module
from comfyfed_server import bootstrap, db


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
