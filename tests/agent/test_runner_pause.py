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


async def _run_connection_loop_briefly(loop, conn, seconds: float = 0.1) -> None:
    loop_task = asyncio.create_task(loop._connection_loop(conn))
    await asyncio.sleep(seconds)
    loop_task.cancel()
    try:
        await loop_task
    except asyncio.CancelledError:
        pass


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


async def test_each_tick_publishes_the_effective_state(pause_loop):
    conn = pause_loop.connections["worker-a"]
    control.request_pause(pause_loop._config_dir)

    await _run_connection_loop_briefly(pause_loop, conn)

    state = control.read_state(pause_loop._config_dir)
    assert state["state"] == "paused"
    assert state["job_id"] is None


async def test_a_stop_request_starts_the_graceful_shutdown(pause_loop, monkeypatch):
    conn = pause_loop.connections["worker-a"]
    shutdowns = []

    async def fake_graceful(loop):
        shutdowns.append(loop)

    monkeypatch.setattr(pause_loop, "_graceful_shutdown_and_stop", fake_graceful)
    control.request_stop(pause_loop._config_dir)

    await _run_connection_loop_briefly(pause_loop, conn)

    assert pause_loop.shutdown_in_progress is True
    # The request is consumed, so a crash mid-shutdown cannot kill the next run.
    assert control.is_stop_requested(pause_loop._config_dir) is False
    # Exactly one wind-down, however many ticks the loop managed.
    assert len(shutdowns) == 1


async def test_a_repeated_stop_request_does_not_schedule_a_second_shutdown(
    pause_loop, monkeypatch
):
    conn = pause_loop.connections["worker-a"]
    shutdowns = []

    async def fake_graceful(loop):
        shutdowns.append(loop)

    monkeypatch.setattr(pause_loop, "_graceful_shutdown_and_stop", fake_graceful)
    control.request_stop(pause_loop._config_dir)
    await _run_connection_loop_briefly(pause_loop, conn)

    control.request_stop(pause_loop._config_dir)
    await _run_connection_loop_briefly(pause_loop, conn)

    assert len(shutdowns) == 1


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
