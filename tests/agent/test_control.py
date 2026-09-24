"""Cross-process control files: pause / stop flags, published state, and the
availability rule the heartbeat tick is built on."""

import json

import pytest

from comfyfed_agent import control, idle
from comfyfed_agent.config import AgentConfig


def test_pause_flag_round_trip(tmp_path):
    config_dir = str(tmp_path)
    assert control.is_pause_requested(config_dir) is False

    control.request_pause(config_dir)
    assert control.is_pause_requested(config_dir) is True
    # The file's content is a timestamp, for a human poking at the config dir.
    assert (tmp_path / control.PAUSE_FILE).read_text(encoding="utf-8").startswith("20")

    control.clear_pause(config_dir)
    assert control.is_pause_requested(config_dir) is False
    # Clearing an already-cleared pause is not an error.
    control.clear_pause(config_dir)


def test_stop_flag_round_trip(tmp_path):
    config_dir = str(tmp_path)
    assert control.is_stop_requested(config_dir) is False

    control.request_stop(config_dir)
    assert control.is_stop_requested(config_dir) is True

    control.clear_stop(config_dir)
    assert control.is_stop_requested(config_dir) is False


def test_request_pause_creates_a_missing_config_dir(tmp_path):
    config_dir = str(tmp_path / "nested" / "comfyfed")

    control.request_pause(config_dir)

    assert control.is_pause_requested(config_dir) is True


def test_write_and_read_state(tmp_path):
    config_dir = str(tmp_path)
    assert control.read_state(config_dir) is None

    control.write_state(config_dir, "busy", "job-7")

    state = control.read_state(config_dir)
    assert state["state"] == "busy"
    assert state["job_id"] == "job-7"
    assert isinstance(state["pid"], int)
    assert state["updated_at"]


def test_write_state_leaves_no_temp_file(tmp_path):
    control.write_state(str(tmp_path), "idle", None)

    assert [p.name for p in tmp_path.iterdir()] == [control.STATE_FILE]


def test_read_state_returns_none_on_corrupt_json(tmp_path):
    (tmp_path / control.STATE_FILE).write_text("{not json", encoding="utf-8")

    assert control.read_state(str(tmp_path)) is None


def test_read_state_returns_none_when_json_is_not_an_object(tmp_path):
    (tmp_path / control.STATE_FILE).write_text(json.dumps([1, 2]), encoding="utf-8")

    assert control.read_state(str(tmp_path)) is None


def test_clear_state_removes_the_file(tmp_path):
    control.write_state(str(tmp_path), "idle", None)

    control.clear_state(str(tmp_path))

    assert control.read_state(str(tmp_path)) is None


@pytest.mark.parametrize(
    "pause_when_active, idle_seconds, expected",
    [
        # Detection unavailable (headless / Wayland without XWayland): the
        # worker must stay schedulable.
        (True, None, "available"),
        # Threshold boundary: exactly idle_minutes*60 counts as idle.
        (True, 300.0, "available"),
        (True, 299.9, "paused-active"),
        (True, 0.0, "paused-active"),
        (True, 3600.0, "available"),
        # Detection switched off: activity is irrelevant.
        (False, 0.0, "available"),
    ],
)
def test_availability_idle_detection(monkeypatch, tmp_path, pause_when_active, idle_seconds, expected):
    monkeypatch.setattr(idle, "seconds_since_input", lambda: idle_seconds)
    cfg = AgentConfig(pause_when_active=pause_when_active, idle_minutes=5.0)

    assert control.availability(cfg, str(tmp_path)) == expected


def test_availability_manual_pause_beats_idle_detection(monkeypatch, tmp_path):
    """An explicit human decision is not second-guessed: even a machine that
    has been untouched for an hour stays paused until `resume`."""
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 3600.0)
    control.request_pause(str(tmp_path))
    cfg = AgentConfig(pause_when_active=True, idle_minutes=5.0)

    assert control.availability(cfg, str(tmp_path)) == "paused-manual"

    control.clear_pause(str(tmp_path))
    assert control.availability(cfg, str(tmp_path)) == "available"


def test_availability_honours_a_custom_idle_minutes(monkeypatch, tmp_path):
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 90.0)
    cfg = AgentConfig(pause_when_active=True, idle_minutes=1.0)

    assert control.availability(cfg, str(tmp_path)) == "available"

    cfg.idle_minutes = 2.0
    assert control.availability(cfg, str(tmp_path)) == "paused-active"
