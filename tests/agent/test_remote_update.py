"""Platform-initiated agent update (spec §2.2): `{"type": "update_agent"}` in,
`{"type": "update_ack", "status": ..., "detail": ...}` out.

Reuses `two_platform_loop` / `cancellable_loop` (and their `FakeConnection`)
from test_runner.py -- the fake records `update_acks` the same way it
records `receipt_acks`.
"""

import argparse
import asyncio

import pytest

from comfyfed_agent import __version__, main as main_module, remote_update, update
from comfyfed_agent.config import AgentConfig, PlatformEntry
from comfyfed_agent.runner import AgentLoop

from tests.agent.test_runner import (  # noqa: F401 -- fixtures are used by name
    _await_flag,
    _job_message,
    cancellable_loop,
    two_platform_loop,
)

_UPDATE_AGENT = {"type": "update_agent"}


def _decision(action: str = "update") -> update.UpdateDecision:
    return update.UpdateDecision(
        action=action,
        latest="9.9.9",
        min_supported="0.0.0",
        wheel_url="/agent/comfyfed-9.9.9-py3-none-any.whl",
        sha256="ab" * 32,
        platform_sig="cd" * 64,
    )


@pytest.fixture()
def no_real_shutdown(monkeypatch):
    """`_graceful_shutdown_and_stop` would `loop.stop()` the test's own event
    loop; record the request instead."""
    requested: list[str] = []

    async def _record(self, loop):
        requested.append("shutdown")

    monkeypatch.setattr(AgentLoop, "_graceful_shutdown_and_stop", _record)
    return requested


@pytest.fixture()
def apply_spy(monkeypatch):
    """Replace `update.apply_update`; `.result` controls what it returns."""
    calls: list[tuple[PlatformEntry, update.UpdateDecision]] = []
    state = {"result": True}

    def _apply(entry, decision, client, pip_install=None, restart=None):
        calls.append((entry, decision))
        # The remote path must never let apply_update raise SystemExit from
        # inside a worker thread: it has to pass a no-op restart.
        assert restart is not None
        restart()
        return state["result"]

    monkeypatch.setattr(update, "apply_update", _apply)
    state["calls"] = calls
    return state


async def _send_update_agent(loop: AgentLoop, conn) -> None:
    await loop._handle_message(conn, _UPDATE_AGENT)
    await asyncio.wait_for(loop._update_task, timeout=10)


# --- the five ack statuses ---------------------------------------------------


async def test_up_to_date_when_platform_has_nothing_newer(
    two_platform_loop, monkeypatch, apply_spy, no_real_shutdown
):
    monkeypatch.setattr(update, "check", lambda entry, current, client: _decision("ok"))
    conn = two_platform_loop.connections["worker-a"]

    await _send_update_agent(two_platform_loop, conn)

    assert [s for s, _ in conn.update_acks] == ["up_to_date"]
    assert apply_spy["calls"] == []
    assert two_platform_loop.exit_code is None


async def test_declined_when_owner_turned_auto_update_off(
    two_platform_loop, monkeypatch, apply_spy, no_real_shutdown
):
    monkeypatch.setattr(update, "check", lambda entry, current, client: _decision())
    two_platform_loop.config.auto_update = False
    conn = two_platform_loop.connections["worker-a"]

    await _send_update_agent(two_platform_loop, conn)

    assert [s for s, _ in conn.update_acks] == ["declined"]
    assert apply_spy["calls"] == []
    assert two_platform_loop.exit_code is None
    assert no_real_shutdown == []


async def test_updating_applies_immediately_sets_exit_code_and_stops_the_loop(
    two_platform_loop, monkeypatch, apply_spy, no_real_shutdown
):
    seen: list[tuple[str, str]] = []

    def _check(entry, current, client):
        seen.append((entry.worker_id, current))
        return _decision()

    monkeypatch.setattr(update, "check", _check)
    conn = two_platform_loop.connections["worker-a"]

    await _send_update_agent(two_platform_loop, conn)

    assert seen == [("worker-a", __version__)]
    assert [s for s, _ in conn.update_acks] == ["updating"]
    assert [entry.worker_id for entry, _ in apply_spy["calls"]] == ["worker-a"]
    assert two_platform_loop.exit_code == update.RESTART_EXIT_CODE == 75
    assert two_platform_loop.shutdown_in_progress
    assert no_real_shutdown == ["shutdown"]


async def test_failed_when_apply_does_not_verify(
    two_platform_loop, monkeypatch, apply_spy, no_real_shutdown
):
    monkeypatch.setattr(update, "check", lambda entry, current, client: _decision())
    apply_spy["result"] = False
    conn = two_platform_loop.connections["worker-a"]

    await _send_update_agent(two_platform_loop, conn)

    assert [s for s, _ in conn.update_acks] == ["failed"]
    assert len(apply_spy["calls"]) == 1
    assert two_platform_loop.exit_code is None
    assert not two_platform_loop.shutdown_in_progress
    assert no_real_shutdown == []


async def test_failed_when_the_version_check_itself_raises(
    two_platform_loop, monkeypatch, apply_spy, no_real_shutdown
):
    def _boom(entry, current, client):
        raise RuntimeError("platform exploded")

    monkeypatch.setattr(update, "check", _boom)
    conn = two_platform_loop.connections["worker-a"]

    await _send_update_agent(two_platform_loop, conn)

    assert [s for s, _ in conn.update_acks] == ["failed"]
    assert apply_spy["calls"] == []


async def test_deferred_while_a_job_runs_then_applied_when_it_finishes(
    cancellable_loop, monkeypatch, apply_spy, no_real_shutdown
):
    loop = cancellable_loop
    monkeypatch.setattr(update, "check", lambda entry, current, client: _decision())
    conn_a = loop.connections["worker-a"]

    await loop._handle_message(conn_a, _job_message("job-busy"))
    job_task = loop._current_job_task
    await _await_flag(loop.test_started)

    await _send_update_agent(loop, conn_a)

    assert [s for s, _ in conn_a.update_acks] == ["deferred"]
    assert "job-busy" in conn_a.update_acks[0][1]
    assert apply_spy["calls"] == []
    assert loop.exit_code is None

    # The job ends (here: cancelled -- success and failure go through the
    # same task-done hook) and the stored decision is applied.
    await loop._handle_message(conn_a, {"type": "job_cancelled", "job_id": "job-busy"})
    await asyncio.wait_for(job_task, timeout=10)
    await asyncio.wait_for(loop._update_task, timeout=10)

    assert [entry.worker_id for entry, _ in apply_spy["calls"]] == ["worker-a"]
    assert loop.exit_code == 75
    assert no_real_shutdown == ["shutdown"]
    # Exactly one ack: "deferred" up front, nothing more after the apply.
    assert [s for s, _ in conn_a.update_acks] == ["deferred"]


async def test_deferred_update_is_skipped_when_the_job_ends_because_of_a_stop(
    cancellable_loop, monkeypatch, apply_spy, no_real_shutdown
):
    """`comfyfed stop` / Ctrl-C ends the job too; that must stay a stop
    (exit 0), not become an install + restart."""
    loop = cancellable_loop
    monkeypatch.setattr(update, "check", lambda entry, current, client: _decision())
    conn_a = loop.connections["worker-a"]

    await loop._handle_message(conn_a, _job_message("job-stopped"))
    await _await_flag(loop.test_started)
    await _send_update_agent(loop, conn_a)
    assert [s for s, _ in conn_a.update_acks] == ["deferred"]

    loop._shutdown_in_progress = True
    await asyncio.wait_for(loop.shutdown(), timeout=10)
    await asyncio.sleep(0)  # let any (wrongly) spawned apply task start

    assert apply_spy["calls"] == []
    assert loop.exit_code is None


async def test_every_ack_carries_the_update_ack_shape(two_platform_loop, monkeypatch, apply_spy, no_real_shutdown):
    """`PlatformConnection.send_update_ack` builds the wire message; check it
    once against the spec's shape."""
    from comfyfed_agent.runner import PlatformConnection

    sent: list[dict] = []
    conn = PlatformConnection(two_platform_loop.config.platforms[0], two_platform_loop.config)

    async def _capture(message):
        sent.append(message)

    monkeypatch.setattr(conn, "_send", _capture)
    await conn.send_update_ack("up_to_date", "already on 9.9.9")

    assert sent == [{"type": "update_ack", "status": "up_to_date", "detail": "already on 9.9.9"}]


def test_ack_statuses_are_the_spec_set():
    assert remote_update.ACK_STATUSES == frozenset(
        {"updating", "deferred", "up_to_date", "declined", "failed"}
    )


# --- main._cmd_run honours AgentLoop.exit_code -------------------------------


def _entry() -> PlatformEntry:
    return PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="pp",
        worker_id="worker-a",
        certificate="cert",
        signing_key_hex="11" * 32,
    )


@pytest.fixture()
def cli_env(monkeypatch):
    monkeypatch.setattr(
        update, "check", lambda *a, **k: update.UpdateDecision(action="ok", latest="0.0.0", min_supported="0.0.0")
    )
    monkeypatch.setattr(AgentConfig, "load", lambda path: AgentConfig(platforms=[_entry()]))
    return argparse.Namespace(config="/nonexistent/agent.json")


def test_cmd_run_exits_with_restart_code_when_the_loop_returns_normally(monkeypatch, cli_env):
    async def _run(self):
        self.exit_code = update.RESTART_EXIT_CODE

    monkeypatch.setattr(AgentLoop, "run", _run)

    with pytest.raises(SystemExit) as exc_info:
        main_module._cmd_run(cli_env)

    assert exc_info.value.code == 75


def test_cmd_run_exits_with_restart_code_on_the_graceful_stop_path(monkeypatch, cli_env):
    """The real remote-update path: the apply succeeded, `_graceful_shutdown_
    and_stop` ran `loop.stop()`, and `asyncio.run` raised its RuntimeError."""

    async def _run(self):
        self.exit_code = update.RESTART_EXIT_CODE
        self._shutdown_in_progress = True
        raise RuntimeError("Event loop stopped before Future completed.")

    monkeypatch.setattr(AgentLoop, "run", _run)

    with pytest.raises(SystemExit) as exc_info:
        main_module._cmd_run(cli_env)

    assert exc_info.value.code == 75


def test_cmd_run_still_returns_normally_without_an_exit_code(monkeypatch, cli_env):
    async def _run(self):
        return None

    monkeypatch.setattr(AgentLoop, "run", _run)

    assert main_module._cmd_run(cli_env) is None
