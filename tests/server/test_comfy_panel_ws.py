"""The ComfyUI-frontend panel WebSocket (`/comfy/api/ws`) and the federation
job-event relay that feeds it (`panelws.py`).

Shapes here are dictated by the real ComfyUI frontend, same rationale as
`test_comfyapi.py`: the initial `status` message and the `progress`/
`executing`/`executed`/`execution_error` events are all `{"type", "data"}`
envelopes per `server.py` / `execution.py`.
"""

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, comfyapi, db, dispatch, panelws


@pytest.fixture(autouse=True)
def _clear_panelws():
    panelws.clear()
    yield
    panelws.clear()


@pytest.fixture()
def client(tmp_path):
    comfyapi.clear_object_info_cache()
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
    r = client.post("/api/workers/tokens", json={"name": name}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register", json={"token": token, "name": name, "pubkey": "ab" * 32}
    )
    return reg.json()["worker_id"]


def _post_prompt(client, prompt=None):
    prompt = prompt or {
        "1": {"class_type": "KSampler", "inputs": {"seed": 1}},
        "2": {"class_type": "SaveImage", "inputs": {"images": ["1", 0]}},
    }
    r = client.post("/comfy/api/prompt", json={"prompt": prompt})
    assert r.status_code == 200
    return r.json()["prompt_id"]


# --- auth --------------------------------------------------------------------


def test_unauthenticated_connection_is_closed_4401(client):
    with client.websocket_connect("/comfy/api/ws") as ws:
        with pytest.raises(WebSocketDisconnect) as exc_info:
            ws.receive_json()
        assert exc_info.value.code == 4401


def test_authenticated_connection_gets_initial_status(client):
    _login(client)
    with client.websocket_connect("/comfy/api/ws") as ws:
        msg = ws.receive_json()
        assert msg["type"] == "status"
        assert msg["data"]["status"] == {"exec_info": {"queue_remaining": 0}}
        assert isinstance(msg["data"]["sid"], str) and msg["data"]["sid"]


def test_initial_status_reports_queue_remaining(client):
    _login(client)
    _post_prompt(client)
    _post_prompt(client)

    with client.websocket_connect("/comfy/api/ws") as ws:
        msg = ws.receive_json()
        assert msg["data"]["status"]["exec_info"]["queue_remaining"] == 2


def test_initial_status_queue_remaining_includes_running_jobs(client):
    # Matches upstream get_tasks_remaining() = len(queue) + len(currently_running):
    # a job already picked up (assigned/running) still counts as "remaining".
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)
    dispatch.mark_running(job_id, worker_id)

    with client.websocket_connect("/comfy/api/ws") as ws:
        msg = ws.receive_json()
        assert msg["data"]["status"]["exec_info"]["queue_remaining"] == 1


# --- job lifecycle relay ------------------------------------------------------


def test_progress_event_relayed_to_panel_client(client):
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)
    dispatch.mark_running(job_id, worker_id)

    with client.websocket_connect("/comfy/api/ws") as ws:
        ws.receive_json()  # initial status

        panelws.job_progress(job_id, 0.42)

        msg = ws.receive_json()
        assert msg == {
            "type": "progress",
            "data": {"value": 42, "max": 100, "prompt_id": job_id},
        }


def test_executing_event_on_job_running(client):
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)

    with client.websocket_connect("/comfy/api/ws") as ws:
        ws.receive_json()  # initial status

        panelws.job_running(job_id)

        msg = ws.receive_json()
        assert msg == {"type": "executing", "data": {"node": "comfyfed", "prompt_id": job_id}}


def test_job_done_sends_executed_then_executing_none_then_status(client):
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)
    dispatch.mark_running(job_id, worker_id)
    dispatch.mark_done(job_id, worker_id, ["out_00001_.png"])

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        with client.websocket_connect("/comfy/api/ws") as ws:
            ws.receive_json()  # initial status

            panelws.job_done(job)

            executed = ws.receive_json()
            assert executed["type"] == "executed"
            assert executed["data"]["prompt_id"] == job_id
            assert executed["data"]["node"] == "2"
            assert executed["data"]["display_node"] == "2"
            assert executed["data"]["output"] == {
                "2": {"images": [{"filename": "out_00001_.png", "subfolder": "", "type": "output"}]}
            }

            completion = ws.receive_json()
            assert completion == {
                "type": "executing",
                "data": {"node": None, "prompt_id": job_id},
            }

            status = ws.receive_json()
            assert status["type"] == "status"
            assert status["data"]["status"] == {"exec_info": {"queue_remaining": 0}}


def test_job_failed_sends_execution_error(client):
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)

    with client.websocket_connect("/comfy/api/ws") as ws:
        ws.receive_json()  # initial status

        panelws.job_failed(job_id, "boom")

        msg = ws.receive_json()
        assert msg["type"] == "execution_error"
        assert msg["data"]["prompt_id"] == job_id
        assert msg["data"]["exception_message"] == "boom"
        assert msg["data"]["executed"] == []


def test_broadcast_reaches_multiple_connected_clients(client):
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)

    with client.websocket_connect("/comfy/api/ws") as ws1, client.websocket_connect(
        "/comfy/api/ws"
    ) as ws2:
        ws1.receive_json()
        ws2.receive_json()

        panelws.job_running(job_id)

        for ws in (ws1, ws2):
            msg = ws.receive_json()
            assert msg == {"type": "executing", "data": {"node": "comfyfed", "prompt_id": job_id}}


def test_broadcast_with_no_connected_clients_is_a_noop(client):
    # No panel client connected at all -- must not raise.
    panelws.job_progress("nonexistent-job", 0.5)
    panelws.job_running("nonexistent-job")
    panelws.job_failed("nonexistent-job", "boom")


# --- end-to-end through the real agent socket ---------------------------------


def test_agent_heartbeat_progress_relayed_through_real_agentws_handler(client):
    """Drives progress through the actual agent WebSocket message handler
    (not `panelws.job_progress` directly), proving the wiring in
    `agentws._handle_heartbeat` -- not just `panelws` in isolation -- reaches
    a connected panel client."""
    from nacl.signing import SigningKey

    from comfyfed_server import agentws

    csrf = _login(client)
    job_id = _post_prompt(client)

    sk = SigningKey.generate()
    pubkey_hex = bytes(sk.verify_key).hex()
    r = client.post("/api/workers/tokens", json={"name": "w1"}, headers={"X-CSRF": csrf})
    token = r.json()["bundle"]["register_token"]
    reg = client.post(
        "/api/agent/register", json={"token": token, "name": "w1", "pubkey": pubkey_hex}
    )
    worker_id = reg.json()["worker_id"]
    dispatch.pick_job_for(worker_id)

    with client.websocket_connect("/comfy/api/ws") as panel_ws:
        panel_ws.receive_json()  # initial status

        with client.websocket_connect("/api/agent/ws") as agent_ws:
            challenge = agent_ws.receive_json()
            sig = sk.sign(challenge["nonce"].encode()).signature.hex()
            agent_ws.send_json({"type": "auth", "worker_id": worker_id, "sig": sig})
            assert agent_ws.receive_json()["type"] == "ready"

            agent_ws.send_json(
                {
                    "type": "heartbeat",
                    "state": "busy",
                    "progress": 0.5,
                    "job_id": job_id,
                    "dynamic": {},
                }
            )
            agentws.dispatch_once(worker_id)

            # _handle_heartbeat applies the progress update (and posts
            # "progress") before it checks state=="busy" to transition
            # assigned->running (and posts "executing") -- see agentws.py.
            progress = panel_ws.receive_json()
            assert progress == {
                "type": "progress",
                "data": {"value": 50, "max": 100, "prompt_id": job_id},
            }
            executing = panel_ws.receive_json()
            assert executing == {
                "type": "executing",
                "data": {"node": "comfyfed", "prompt_id": job_id},
            }
