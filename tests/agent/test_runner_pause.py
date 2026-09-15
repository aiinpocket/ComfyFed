"""Runner-side pause/stop: a tick that would report `idle` reports `paused`
while the machine is unavailable, a busy tick is never rewritten, and a
`stop.request` dropped by another process starts the same graceful wind-down
a console signal does.

Reuses `test_runner.py`'s FakeConnection harness (same idiom as
`test_fetcher.py` borrowing from `test_peerserve.py`).
"""

import asyncio

import pytest

from comfyfed_agent import comfy, control, hardware, idle, whitelist
from comfyfed_agent import runner as runner_module
from comfyfed_agent.config import AgentConfig
from comfyfed_agent.runner import AgentLoop
from tests.agent.test_runner import FakeConnection, _entry, _job_message


@pytest.fixture()
def pause_loop(monkeypatch, tmp_path):
    """A one-platform loop whose config dir is a tmp dir, with idle detection
    reporting a long-idle machine unless a test says otherwise."""
    monkeypatch.setattr(whitelist, "allowed_classes", lambda *a, **k: {"KSampler"})
    monkeypatch.setattr(whitelist, "check", lambda *a, **k: None)
    monkeypatch.setattr(hardware, "collect_dynamic", lambda *a, **k: {})
    monkeypatch.setattr(comfy, "run_workflow", lambda *a, **k: ([], None))
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 9999.0)
    monkeypatch.setattr(runner_module, "_HEARTBEAT_INTERVAL_SECONDS", 0)
    monkeypatch.setattr(runner_module, "_RECV_POLL_TIMEOUT_SECONDS", 0.01)

    config = AgentConfig(platforms=[_entry("worker-a")])
    cfg_path = str(tmp_path / "agent.json")
    return AgentLoop(config, cfg_path, connection_factory=FakeConnection)


async def _cancel(task) -> None:
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def _run_until(task, condition, timeout: float = 5.0) -> None:
    """Drive `task` until `condition()` holds, then cancel it.

    Condition-driven rather than "sleep a fixed 0.1 s and hope": with a
    zeroed heartbeat interval the loop produces its first beat almost at
    once, but a loaded CI box can miss any fixed window (final review I3).
    The timeout only exists so a genuine regression fails loudly instead of
    hanging the suite.
    """
    event_loop = asyncio.get_running_loop()
    deadline = event_loop.time() + timeout
    try:
        while not condition():
            if task.done():
                await task
                break
            if event_loop.time() > deadline:
                raise AssertionError("the loop never reached the expected state")
            await asyncio.sleep(0.01)
    finally:
        await _cancel(task)


async def _run_connection_loop_briefly(loop, conn, condition=None) -> None:
    task = asyncio.create_task(loop._connection_loop(conn))
    await _run_until(task, condition or (lambda: bool(conn.heartbeats)))


async def _run_control_loop_briefly(loop, condition=None) -> None:
    """At least one tick of the platform-independent control loop (its first
    tick runs before the first `await`, so one scheduler turn is enough)."""
    task = asyncio.create_task(loop._control_loop())
    await asyncio.sleep(0)
    if condition is None:
        await _cancel(task)
    else:
        await _run_until(task, condition)


async def test_idle_tick_stays_idle_when_available(pause_loop):
    conn = pause_loop.connections["worker-a"]

    await _run_connection_loop_briefly(pause_loop, conn)

    assert conn.heartbeats
    assert all(hb["state"] == "idle" for hb in conn.heartbeats)


async def test_idle_tick_reports_paused_while_a_pause_file_exists(pause_loop):
    conn = pause_loop.connections["worker-a"]
    control.request_pause(pause_loop._config_dir)

    await _run_connection_loop_briefly(pause_loop, conn)

    assert conn.heartbeats
    assert all(hb["state"] == "paused" for hb in conn.heartbeats)


async def test_idle_tick_reports_paused_while_the_user_is_active(pause_loop, monkeypatch):
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 3.0)
    conn = pause_loop.connections["worker-a"]

    await _run_connection_loop_briefly(pause_loop, conn)

    assert conn.heartbeats
    assert all(hb["state"] == "paused" for hb in conn.heartbeats)


async def test_a_paused_worker_returns_to_idle_after_resume(pause_loop):
    """`send_heartbeat` leaves `paused` on `conn.state`; the next tick has to
    treat that as "would be idle" or a resume would never take effect."""
    conn = pause_loop.connections["worker-a"]
    control.request_pause(pause_loop._config_dir)
    await _run_connection_loop_briefly(pause_loop, conn)
    assert conn.state == "paused"

    control.clear_pause(pause_loop._config_dir)
    conn.heartbeats.clear()
    await _run_connection_loop_briefly(pause_loop, conn)

    assert conn.heartbeats
    assert all(hb["state"] == "idle" for hb in conn.heartbeats)


async def test_a_busy_tick_is_never_rewritten_to_paused(pause_loop):
    """Pausing stops NEW intake only -- a running job keeps its busy beats."""
    conn = pause_loop.connections["worker-a"]
    conn.state = "busy"
    control.request_pause(pause_loop._config_dir)

    await _run_connection_loop_briefly(pause_loop, conn)

    assert conn.heartbeats
    assert all(hb["state"] == "busy" for hb in conn.heartbeats)


async def test_completing_a_job_while_paused_reports_paused_not_idle(pause_loop):
    """Review round 1 (HIGH): the job-completion beat fires the instant the
    job ends. If it reported a bare "idle" it would hand a paused worker
    straight back to the dispatcher for a whole heartbeat interval."""
    conn = pause_loop.connections["worker-a"]
    control.request_pause(pause_loop._config_dir)

    await pause_loop.handle_job(conn, _job_message("job-paused"))

    assert conn.job_done == ("job-paused", [], None)
    # Busy beats are never rewritten; the wind-down beat is.
    assert [hb["state"] for hb in conn.heartbeats if hb["state"] == "busy"]
    assert conn.heartbeats[-1]["state"] == "paused"


async def test_completing_a_job_while_the_user_is_active_reports_paused(pause_loop, monkeypatch):
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 1.0)
    conn = pause_loop.connections["worker-a"]

    await pause_loop.handle_job(conn, _job_message("job-active"))

    assert conn.heartbeats[-1]["state"] == "paused"


async def test_a_failed_job_while_paused_also_reports_paused(pause_loop, monkeypatch):
    """Completion, failure and cancel all wind down through the same
    `finally`, so the gate has to cover the failure path too."""

    def boom(*args, **kwargs):
        raise comfy.ComfyError("kaboom")

    monkeypatch.setattr(comfy, "run_workflow", boom)
    conn = pause_loop.connections["worker-a"]
    control.request_pause(pause_loop._config_dir)

    await pause_loop.handle_job(conn, _job_message("job-failed"))

    assert conn.job_failed == ("job-failed", "kaboom", None)
    assert conn.heartbeats[-1]["state"] == "paused"


async def test_completing_a_job_when_available_still_reports_idle(pause_loop):
    conn = pause_loop.connections["worker-a"]

    await pause_loop.handle_job(conn, _job_message("job-free"))

    assert conn.heartbeats[-1]["state"] == "idle"


async def test_each_control_tick_publishes_the_effective_state(pause_loop):
    control.request_pause(pause_loop._config_dir)

    await _run_control_loop_briefly(pause_loop)

    state = control.read_state(pause_loop._config_dir)
    assert state["state"] == "paused"
    assert state["job_id"] is None


async def test_the_control_loop_publishes_without_any_connection(pause_loop):
    """Final review H3: `status` must work while every platform is
    unreachable -- the control loop never touches a socket."""
    await _run_control_loop_briefly(pause_loop)

    state = control.read_state(pause_loop._config_dir)
    assert state["state"] == "idle"


async def test_the_published_state_is_process_wide_not_per_connection(pause_loop):
    """Final review M4: two connection loops used to take turns writing one
    file. The verdict now comes from the job table, so a worker running a
    job for ANY platform publishes `busy` with that job's id."""
    conn = pause_loop.connections["worker-a"]
    handle = runner_module._JobHandle(job_id="job-1", conn=conn)
    handle.running = True
    pause_loop._jobs["job-1"] = handle

    await _run_control_loop_briefly(pause_loop)

    state = control.read_state(pause_loop._config_dir)
    assert state["state"] == "busy"
    assert state["job_id"] == "job-1"


async def test_a_busy_process_is_published_busy_even_while_paused(pause_loop):
    conn = pause_loop.connections["worker-a"]
    handle = runner_module._JobHandle(job_id="job-2", conn=conn)
    handle.running = True
    pause_loop._jobs["job-2"] = handle
    control.request_pause(pause_loop._config_dir)

    await _run_control_loop_briefly(pause_loop)

    assert control.read_state(pause_loop._config_dir)["state"] == "busy"


async def test_a_connection_tick_no_longer_polls_stop(pause_loop):
    """The stop poll moved off the heartbeat, so a socket tick must leave the
    request alone for the control loop to consume."""
    conn = pause_loop.connections["worker-a"]
    control.request_stop(pause_loop._config_dir)

    await _run_connection_loop_briefly(pause_loop, conn)

    assert control.is_stop_requested(pause_loop._config_dir) is True
    assert pause_loop.shutdown_in_progress is False


async def test_a_stop_request_starts_the_graceful_shutdown(pause_loop, monkeypatch):
    shutdowns = []

    async def fake_graceful(loop):
        shutdowns.append(loop)

    monkeypatch.setattr(pause_loop, "_graceful_shutdown_and_stop", fake_graceful)
    control.request_stop(pause_loop._config_dir)

    await _run_control_loop_briefly(pause_loop, lambda: bool(shutdowns))

    assert pause_loop.shutdown_in_progress is True
    # The request is consumed, so a crash mid-shutdown cannot kill the next run.
    assert control.is_stop_requested(pause_loop._config_dir) is False
    # Exactly one wind-down, however many ticks the loop managed.
    assert len(shutdowns) == 1


async def test_a_repeated_stop_request_does_not_schedule_a_second_shutdown(
    pause_loop, monkeypatch
):
    shutdowns = []

    async def fake_graceful(loop):
        shutdowns.append(loop)

    monkeypatch.setattr(pause_loop, "_graceful_shutdown_and_stop", fake_graceful)
    control.request_stop(pause_loop._config_dir)
    await _run_control_loop_briefly(pause_loop, lambda: bool(shutdowns))

    control.request_stop(pause_loop._config_dir)
    await _run_control_loop_briefly(pause_loop)

    assert len(shutdowns) == 1


async def test_stopping_the_control_loop_clears_the_published_state(pause_loop):
    """Final review M5: `loop.stop()` never resumes `run()`, so the cleanup
    has to live where both shutdown paths reach it."""
    await _run_control_loop_briefly(pause_loop)
    assert control.read_state(pause_loop._config_dir) is not None

    pause_loop._control_task = asyncio.create_task(pause_loop._control_loop())
    await asyncio.sleep(0)
    await pause_loop._stop_control_loop()

    assert control.read_state(pause_loop._config_dir) is None
    assert pause_loop._control_task is None


async def test_a_connection_sends_an_immediate_beat_after_hello(pause_loop, monkeypatch):
    """Final review H2: both platforms assume a freshly handshaked agent is
    idle, so the true availability must not wait a whole heartbeat."""
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 1.0)
    monkeypatch.setattr(hardware, "collect_hardware", lambda *a, **k: {})
    monkeypatch.setattr(hardware, "detect_backend", lambda: ("cpu", "0"))
    conn = pause_loop.connections["worker-a"]

    async def _noop(*args, **kwargs):
        return None

    async def _stop_here(*args, **kwargs):
        # The first thing `_run_platform` does after the immediate beat.
        raise asyncio.CancelledError

    conn.connect = _noop
    conn.handshake = _noop
    conn.send_hello = _noop
    conn.close = _noop
    conn.send_inventory = _stop_here

    with pytest.raises(asyncio.CancelledError):
        await pause_loop._run_platform(conn)

    assert conn.heartbeats
    assert conn.heartbeats[0]["state"] == "paused"


async def test_run_clears_a_stale_stop_file_before_starting(pause_loop, monkeypatch):
    """A stop.request left by a crashed run must not kill a fresh start."""
    control.request_stop(pause_loop._config_dir)

    async def fake_run_platform(conn):
        raise asyncio.CancelledError

    monkeypatch.setattr(pause_loop, "_run_platform", fake_run_platform)
    monkeypatch.setattr(pause_loop, "_start_peer_server", lambda: None)
    monkeypatch.setattr(pause_loop, "_install_signal_handlers", lambda loop: None)

    with pytest.raises(asyncio.CancelledError):
        await pause_loop.run()

    assert control.is_stop_requested(pause_loop._config_dir) is False


# --- 分級 P2P 上傳限速 / tiered P2P upload cap ---------------------------


class _FakePeerServer:
    """Records every `set_upload_limit_mbps` call the runner makes."""

    def __init__(self, *a, **kw):
        self.limits = []

    def set_upload_limit_mbps(self, mbps):
        self.limits.append(mbps)

    def start(self):
        pass

    def stop(self, timeout=5.0):
        pass


async def test_control_tick_applies_the_idle_upload_limit(pause_loop):
    """Idle machine -> the idle tier (default 0 = unlimited)."""
    peer = _FakePeerServer()
    pause_loop._peer_server = peer

    await _run_control_loop_briefly(pause_loop)

    assert peer.limits == [pause_loop.config.peer_upload_limit_idle_mbps]


async def test_control_tick_applies_the_active_upload_limit(pause_loop, monkeypatch):
    """User at the keyboard -> the polite tier (default 20 Mbps). Seeding is
    throttled, NOT stopped."""
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 1.0)
    peer = _FakePeerServer()
    pause_loop._peer_server = peer

    await _run_control_loop_briefly(pause_loop)

    assert peer.limits == [pause_loop.config.peer_upload_limit_mbps]
    assert pause_loop.config.peer_upload_limit_mbps == 20.0


async def test_control_tick_applies_the_active_limit_when_manually_paused(pause_loop):
    control.request_pause(pause_loop._config_dir)
    peer = _FakePeerServer()
    pause_loop._peer_server = peer

    await _run_control_loop_briefly(pause_loop)

    assert peer.limits == [pause_loop.config.peer_upload_limit_mbps]


async def test_upload_limit_is_applied_once_the_peer_server_starts(pause_loop, monkeypatch, tmp_path):
    """The first seconds must not be unlimited-by-omission, waiting for the
    first control tick."""
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 1.0)
    monkeypatch.setattr(runner_module.peerserve, "PeerHTTPServer", _FakePeerServer)
    monkeypatch.setattr(runner_module.peerserve, "advertised_url", lambda cfg: "http://127.0.0.1:8850")
    pause_loop.config.peer_serve = True
    pause_loop.config.peer_listen_port = 8850
    pause_loop.config.models_dir = str(tmp_path / "models")

    pause_loop._start_peer_server()

    assert pause_loop._peer_server.limits == [20.0]


async def test_upload_limit_tier_switch_logs_once_per_change(pause_loop, monkeypatch, caplog):
    active = {"seconds": 9999.0}
    monkeypatch.setattr(idle, "seconds_since_input", lambda: active["seconds"])
    pause_loop._peer_server = _FakePeerServer()

    with caplog.at_level("INFO", logger=runner_module.logger.name):
        pause_loop._apply_peer_upload_limit()
        pause_loop._apply_peer_upload_limit()  # same tier: no second line
        active["seconds"] = 1.0
        pause_loop._apply_peer_upload_limit()
        pause_loop._apply_peer_upload_limit()  # same tier again

    lines = [r.getMessage() for r in caplog.records if "upload cap" in r.getMessage()]
    assert len(lines) == 2
    assert "unlimited" in lines[0]
    assert "20 Mbps" in lines[1]
    assert "上傳限速" in lines[1]
    # Four calls, four applications -- only the LOG is deduped, the cap is
    # re-asserted every tick (cheap, and self-healing if it ever drifts).
    assert pause_loop._peer_server.limits == [0.0, 0.0, 20.0, 20.0]
