import json

import pytest
from fastapi.testclient import TestClient
from nacl.signing import SigningKey

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


def test_metrics_endpoint_contains_jobs_queued(client):
    r = client.get("/metrics")
    assert r.status_code == 200
    assert "comfyfed_jobs_queued" in r.text


def test_heartbeat_sets_worker_gauges(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_vram_gb": 12.5, "free_ram_gb": 30.0, "free_disk_gb": 100.0},
            }
        )
        agentws.dispatch_once(worker_id)

    text = client.get("/metrics").text
    assert 'comfyfed_worker_up{worker="w1"} 1.0' in text
    assert 'comfyfed_worker_free_vram_gb{worker="w1"} 12.5' in text
    assert 'comfyfed_worker_free_ram_gb{worker="w1"} 30.0' in text
    assert 'comfyfed_worker_free_disk_gb{worker="w1"} 100.0' in text


def test_heartbeat_with_garbage_dynamic_value_does_not_disconnect_worker(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    with client.websocket_connect("/api/agent/ws") as ws:
        challenge = ws.receive_json()
        sig = sk.sign(challenge["nonce"].encode()).signature.hex()
        ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
        assert ws.receive_json()["type"] == "ready"

        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_vram_gb": "garbage"},
            }
        )

        # The connection must still be alive and processing messages after a
        # malformed heartbeat value: a second heartbeat should go through
        # normally rather than the socket having been torn down.
        ws.send_json(
            {
                "type": "heartbeat",
                "state": "idle",
                "progress": 0.0,
                "job_id": None,
                "dynamic": {"free_vram_gb": 8.0},
            }
        )
        agentws.dispatch_once(worker_id)

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        assert worker.status == "online"

    text = client.get("/metrics").text
    assert 'comfyfed_worker_free_vram_gb{worker="w1"} 8.0' in text


def test_ws_reconnects_counter_increments(client):
    csrf = _login(client)
    worker_id, sk = _register_worker(client, csrf, "w1")

    for _ in range(2):
        with client.websocket_connect("/api/agent/ws") as ws:
            challenge = ws.receive_json()
            sig = sk.sign(challenge["nonce"].encode()).signature.hex()
            ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
            assert ws.receive_json()["type"] == "ready"

    text = client.get("/metrics").text
    assert 'comfyfed_ws_reconnects_total{worker="w1"} 2.0' in text


def test_job_lifecycle_updates_histograms(client):
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

        dispatch.mark_running(job_id, worker_id)
        ws.send_json({"type": "job_done", "job_id": job_id, "result_files": ["out.png"]})
        agentws.dispatch_once(worker_id)

    text = client.get("/metrics").text
    assert "comfyfed_job_wait_seconds_count 1.0" in text
    assert "comfyfed_job_run_seconds_count 1.0" in text


def test_metrics_private_requires_admin(client):
    with db.get_session() as session:
        session.add(db.Setting(key="metrics_public", value="false"))
        session.commit()

    r = client.get("/metrics")
    assert r.status_code == 401

    csrf = _login(client)
    r = client.get("/metrics")
    assert r.status_code == 200
