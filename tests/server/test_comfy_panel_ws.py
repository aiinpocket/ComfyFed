"""The ComfyUI-frontend panel WebSocket (`/comfy/api/ws`) and the federation
job-event relay that feeds it (`panelws.py`).

Shapes here are dictated by the real ComfyUI frontend, same rationale as
`test_comfyapi.py`: the initial `status` message and the `progress`/
`executing`/`executed`/`execution_error` events are all `{"type", "data"}`
envelopes per `server.py` / `execution.py`.
"""

import asyncio
import time

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from comfyfed_server import app as app_module
from comfyfed_server import bootstrap, comfyapi, db, dispatch, panelws


def relay(coro):
    """Drive one panelws coroutine from a synchronous test.

    The relay functions are coroutines (see `panelws.post_event`), and these
    tests hold their panel socket through `TestClient`, whose event loop runs
    on its own thread. `asyncio.run` here therefore exercises panelws's
    genuinely-cross-loop branch, which is the correct one for this situation.
    The same-loop branch -- the one production actually takes -- is covered by
    the async tests at the bottom of this file.
    """
    return asyncio.run(coro)


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


def test_frontend_ws_path_alias_is_served(client):
    """`/comfy/ws` is the address the stock frontend actually dials.

    It builds its socket URL as `api_base + "/ws"` -- bypassing the `apiURL()`
    helper that prefixes `/api` onto everything else -- so a panel served at
    `/comfy/` connects to `/comfy/ws`, not `/comfy/api/ws`. Both answer.
    """
    _login(client)
    with client.websocket_connect("/comfy/ws?clientId=panel-1") as ws:
        assert ws.receive_json()["type"] == "status"


def test_unauthenticated_frontend_ws_alias_is_also_closed_4401(client):
    with client.websocket_connect("/comfy/ws") as ws:
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


def test_connection_gets_explicit_feature_flags_right_after_status(client):
    """The pinned frontend gates several UI affordances (asset browser, node
    replacement suggestions, the sign-in button, manager v4 UI, manager CSRF
    POST support) on these flags; answering false for all of them is the
    truthful answer for a platform that supports none of them yet, and it is
    sent unprompted -- ComfyUI's own server does the same on connect rather
    than waiting to be asked."""
    _login(client)
    with client.websocket_connect("/comfy/api/ws") as ws:
        ws.receive_json()  # initial status

        msg = ws.receive_json()
        assert msg == {
            "type": "feature_flags",
            "data": {
                "assets": False,
                "node_replacements": False,
                "show_signin_button": False,
                "extension.manager.supports_v4": False,
                "extension.manager.supports_csrf_post": False,
            },
        }


def test_client_feature_flags_message_is_consumed_without_disrupting_the_socket(client):
    """The frontend announces its own capabilities (`supports_manager_v4_ui`
    etc.) as a `feature_flags` message right after opening the socket. This
    is expected chatter, not an error -- the panel socket only ever listens,
    so it must swallow this silently and stay usable for subsequent relayed
    events."""
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)

    with client.websocket_connect("/comfy/api/ws") as ws:
        ws.receive_json()  # initial status
        ws.receive_json()  # feature_flags

        ws.send_json({"type": "feature_flags", "data": {"supports_manager_v4_ui": True}})

        relay(panelws.job_running(job_id))

        msg = ws.receive_json()
        assert msg == {
            "type": "executing",
            "data": {
                "node": "comfyfed",
                "prompt_id": job_id,
                "display_node": "comfyfed",
            },
        }


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
        ws.receive_json()  # feature_flags

        relay(panelws.job_progress(job_id, 0.42))

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
        ws.receive_json()  # feature_flags

        relay(panelws.job_running(job_id))

        msg = ws.receive_json()
        assert msg == {
            "type": "executing",
            "data": {
                "node": "comfyfed",
                "prompt_id": job_id,
                "display_node": "comfyfed",
            },
        }


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
            ws.receive_json()  # feature_flags

            relay(panelws.job_done(job))

            executed = ws.receive_json()
            assert executed["type"] == "executed"
            assert executed["data"]["prompt_id"] == job_id
            assert executed["data"]["node"] == "2"
            assert executed["data"]["display_node"] == "2"
            assert executed["data"]["output"] == {
                "2": {
                    "images": [
                        {
                            "filename": "out_00001_.png",
                            "subfolder": job_id,
                            "type": "output",
                        }
                    ]
                }
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
        ws.receive_json()  # feature_flags

        relay(panelws.job_failed(job_id, "boom"))

        msg = ws.receive_json()
        assert msg["type"] == "execution_error"
        assert msg["data"]["prompt_id"] == job_id
        assert msg["data"]["exception_message"] == "boom"
        assert msg["data"]["executed"] == []

        # A refreshed status follows, so the panel's queue badge cannot stay
        # stuck counting a job that has left the queue. (This test calls the
        # relay directly without applying the DB transition, so the count is
        # still 1 -- what matters is that the message is sent, and sent last.)
        status = ws.receive_json()
        assert status["type"] == "status"
        assert status["data"]["status"] == {"exec_info": {"queue_remaining": 1}}


def test_broadcast_reaches_multiple_connected_clients(client):
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)

    with client.websocket_connect("/comfy/api/ws") as ws1, client.websocket_connect(
        "/comfy/api/ws"
    ) as ws2:
        ws1.receive_json()  # initial status
        ws1.receive_json()  # feature_flags
        ws2.receive_json()  # initial status
        ws2.receive_json()  # feature_flags

        relay(panelws.job_running(job_id))

        for ws in (ws1, ws2):
            msg = ws.receive_json()
            assert msg == {
                "type": "executing",
                "data": {
                    "node": "comfyfed",
                    "prompt_id": job_id,
                    "display_node": "comfyfed",
                },
            }


def test_broadcast_with_no_connected_clients_is_a_noop(client):
    # No panel client connected at all -- must not raise.
    relay(panelws.job_progress("nonexistent-job", 0.5))
    relay(panelws.job_running("nonexistent-job"))
    relay(panelws.job_failed("nonexistent-job", "boom"))


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
        panel_ws.receive_json()  # feature_flags

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
                "data": {
                    "node": "comfyfed",
                    "prompt_id": job_id,
                    "display_node": "comfyfed",
                },
            }


# --- same-loop delivery (the production topology) ------------------------------
#
# Everything above holds its panel socket through `TestClient`, which runs the
# app on its OWN event loop in a separate thread. That is NOT how production
# looks: uvicorn runs the panel sockets and the agent socket handlers on one
# loop, and the relay is invoked from a coroutine already executing on it.
#
# An earlier panelws scheduled every broadcast with
# `run_coroutine_threadsafe(...).result(timeout=5)` against that same loop --
# an unconditional self-deadlock in production (the loop blocks waiting for
# work only it could run), which the TestClient tests could not see precisely
# because their two loops made the cross-thread call legitimate. The tests
# below register a fake connection on the CURRENT running loop and assert
# delivery: completes promptly, in order, with no timeout burned.


class _FakePanelSocket:
    """Records what the relay sends, standing in for a live panel WebSocket."""

    def __init__(self):
        self.sent = []

    async def send_json(self, evt):
        self.sent.append(evt)


def _register_on_current_loop() -> tuple[str, _FakePanelSocket]:
    ws = _FakePanelSocket()
    sid = panelws.register(ws)  # captures asyncio.get_running_loop()
    return sid, ws


async def test_same_loop_relay_delivers_without_blocking(client):
    """A relay call from the loop the panel connection lives on must deliver.

    The old implementation deadlocked here until its 5s timeout and delivered
    nothing at all, so both halves of the assertion matter: something arrived,
    and it arrived fast.
    """
    _login(client)
    job_id = _post_prompt(client)

    _sid, ws = _register_on_current_loop()

    started = time.monotonic()
    await panelws.job_progress(job_id, 0.5)
    elapsed = time.monotonic() - started

    assert ws.sent == [
        {"type": "progress", "data": {"value": 50, "max": 100, "prompt_id": job_id}}
    ]
    assert elapsed < 1.0


async def test_same_loop_job_done_delivers_three_events_in_order(client):
    """`job_done` is the worst case: three events, 15s of deadlock before.

    Order is part of the contract -- the frontend needs `executed` (the
    outputs) before the `executing: null` that closes the prompt out, and the
    refreshed `status` last -- so this must stay sequential awaits, never a
    fire-and-forget task per event.
    """
    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)
    dispatch.mark_running(job_id, worker_id)
    dispatch.mark_done(job_id, worker_id, ["out_00001_.png"])

    _sid, ws = _register_on_current_loop()

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        started = time.monotonic()
        await panelws.job_done(job)
        elapsed = time.monotonic() - started

    assert [e["type"] for e in ws.sent] == ["executed", "executing", "status"]
    assert ws.sent[1]["data"] == {"node": None, "prompt_id": job_id}
    assert elapsed < 1.0


async def test_same_loop_agentws_handler_relays_job_done(client):
    """The real agentws handler path, driven on the loop the panel is on.

    `_notify_panel_job_done` is what production actually calls; running it
    here (rather than `panelws.job_done`) proves the await was threaded all
    the way through the agent-socket handler, not just into panelws.
    """
    from comfyfed_server import agentws

    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)
    dispatch.mark_running(job_id, worker_id)
    dispatch.mark_done(job_id, worker_id, ["out_00001_.png"])

    _sid, ws = _register_on_current_loop()

    started = time.monotonic()
    await agentws._notify_panel_job_done(job_id)
    elapsed = time.monotonic() - started

    assert [e["type"] for e in ws.sent] == ["executed", "executing", "status"]
    assert elapsed < 1.0


async def test_dispatch_tick_relays_requeued_jobs_to_the_panel(client):
    """I2: a stale worker's running job goes back to `queued` silently.

    Nothing else will ever send a done/failed event for that attempt, so
    without an explicit `executing: null` the panel shows it executing
    forever.
    """
    from datetime import datetime, timedelta, timezone

    from comfyfed_server import agentws

    csrf = _login(client)
    job_id = _post_prompt(client)
    worker_id = _register_worker(client, csrf, "runner")
    dispatch.pick_job_for(worker_id)
    dispatch.mark_running(job_id, worker_id)

    stale = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(seconds=200)
    with db.get_session() as session:
        session.get(db.Worker, worker_id).last_seen = stale
        session.commit()

    _sid, ws = _register_on_current_loop()

    await agentws.dispatch_tick()

    assert ws.sent[0] == {
        "type": "executing",
        "data": {"node": None, "prompt_id": job_id},
    }
    assert ws.sent[-1]["type"] == "status"

    with db.get_session() as session:
        assert session.get(db.Job, job_id).status == "queued"
