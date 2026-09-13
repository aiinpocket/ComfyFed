"""`comfyfed-agent run` CLI entry: the RuntimeError `_graceful_shutdown_and_stop`'s
`loop.stop()` provokes out of `asyncio.run` must be swallowed for a clean,
signal-initiated shutdown -- and nothing else."""

import argparse

import pytest

from comfyfed_agent import main as main_module
from comfyfed_agent.config import AgentConfig, PlatformEntry
from comfyfed_agent.runner import AgentLoop
from comfyfed_agent import update


def _args(config_path: str) -> argparse.Namespace:
    return argparse.Namespace(config=config_path)


def _entry() -> PlatformEntry:
    return PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="pp",
        worker_id="worker-a",
        certificate="cert",
        signing_key_hex="11" * 32,
    )


@pytest.fixture(autouse=True)
def _no_update_check(monkeypatch):
    monkeypatch.setattr(
        update, "check", lambda *a, **k: update.UpdateDecision(action="ok", latest="0.0.0", min_supported="0.0.0")
    )
    monkeypatch.setattr(AgentConfig, "load", lambda path: AgentConfig(platforms=[_entry()]))


def test_run_exits_cleanly_when_shutdown_already_in_progress(monkeypatch, tmp_path):
    """The exact case the live driver hit: a signal was handled, `shutdown()`
    finished, `loop.stop()` ran -- and `asyncio.run` surfaces that as a
    RuntimeError instead of `run()` returning normally. That must become a
    quiet `sys.exit(0)`, not a traceback."""

    async def _raise_after_shutdown(self):
        self._shutdown_in_progress = True
        raise RuntimeError("Event loop stopped before Future completed.")

    monkeypatch.setattr(AgentLoop, "run", _raise_after_shutdown)

    with pytest.raises(SystemExit) as exc_info:
        main_module._cmd_run(_args(str(tmp_path / "agent.json")))

    assert exc_info.value.code == 0


def test_run_reraises_the_same_runtimeerror_without_a_signal(monkeypatch, tmp_path):
    """The same message, but no signal was ever handled: this is a genuine
    bug (or some other asyncio failure), not a clean shutdown, and must not
    be swallowed."""

    async def _raise_without_shutdown(self):
        raise RuntimeError("Event loop stopped before Future completed.")

    monkeypatch.setattr(AgentLoop, "run", _raise_without_shutdown)

    with pytest.raises(RuntimeError, match="Event loop stopped before Future completed"):
        main_module._cmd_run(_args(str(tmp_path / "agent.json")))


def test_run_reraises_unrelated_runtimeerror_even_during_shutdown(monkeypatch, tmp_path):
    """Only the specific `loop.stop()` message is treated as a clean
    shutdown; any other RuntimeError -- even with the flag set -- is a real
    failure and must keep propagating."""

    async def _raise_other(self):
        self._shutdown_in_progress = True
        raise RuntimeError("something else entirely broke")

    monkeypatch.setattr(AgentLoop, "run", _raise_other)

    with pytest.raises(RuntimeError, match="something else entirely broke"):
        main_module._cmd_run(_args(str(tmp_path / "agent.json")))
