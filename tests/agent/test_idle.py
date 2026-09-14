"""`idle.seconds_since_input` dispatch + the pause/idle config fields.

No real OS input APIs are exercised here beyond one smoke test: the
per-platform helpers are monkeypatched, because what matters to the rest of
the system is the contract (a float, or `None`, never an exception).
"""

import json

import pytest

from comfyfed_agent import idle
from comfyfed_agent.config import AgentConfig


@pytest.mark.parametrize(
    "platform, helper",
    [
        ("win32", "_win32_seconds"),
        ("darwin", "_darwin_seconds"),
        ("linux", "_linux_seconds"),
        ("linux2", "_linux_seconds"),
    ],
)
def test_seconds_since_input_dispatches_per_platform(monkeypatch, platform, helper):
    monkeypatch.setattr(idle.sys, "platform", platform)
    monkeypatch.setattr(idle, helper, lambda: 12.5)

    assert idle.seconds_since_input() == 12.5


def test_seconds_since_input_returns_none_on_unsupported_platform(monkeypatch):
    monkeypatch.setattr(idle.sys, "platform", "sunos5")

    assert idle.seconds_since_input() is None


@pytest.mark.parametrize(
    "platform, helper",
    [("win32", "_win32_seconds"), ("darwin", "_darwin_seconds"), ("linux", "_linux_seconds")],
)
def test_seconds_since_input_swallows_helper_exceptions(monkeypatch, platform, helper):
    """A missing libXss, a refused CoreGraphics load, any ctypes error: the
    worker must stay schedulable, so detection failure is `None`, not a raise."""

    def boom():
        raise OSError("no such library")

    monkeypatch.setattr(idle.sys, "platform", platform)
    monkeypatch.setattr(idle, helper, boom)

    assert idle.seconds_since_input() is None


def test_seconds_since_input_smoke_on_this_host():
    """Whatever this CI host is, the real call must return float-or-None and
    must not raise."""
    result = idle.seconds_since_input()

    assert result is None or isinstance(result, float)


def test_config_pause_defaults(tmp_path):
    path = tmp_path / "agent.json"
    AgentConfig().save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.pause_when_active is True
    assert loaded.idle_minutes == 5.0


def test_config_pause_round_trip(tmp_path):
    path = tmp_path / "agent.json"
    AgentConfig(pause_when_active=False, idle_minutes=2.5).save(str(path))

    loaded = AgentConfig.load(str(path))
    assert loaded.pause_when_active is False
    assert loaded.idle_minutes == 2.5


def test_config_pause_coercion(tmp_path):
    """Same defensive posture as max_fetch_gb / peer_serve: a hand-edited
    agent.json falls back to the default instead of raising."""
    path = tmp_path / "agent.json"

    for raw, expected in [("abc", 5.0), (-1, 5.0), (None, 5.0), ("7", 7.0), (1.5, 1.5)]:
        path.write_text(json.dumps({"idle_minutes": raw}), encoding="utf-8")
        assert AgentConfig.load(str(path)).idle_minutes == expected

    for raw, expected in [("off", False), ("no", False), ("on", True), (False, False), (None, True), ("junk", True)]:
        path.write_text(json.dumps({"pause_when_active": raw}), encoding="utf-8")
        assert AgentConfig.load(str(path)).pause_when_active is expected
