"""`comfyfed pause / resume / status / stop`: the control files they write
and the bilingual output they print."""

import argparse
import json
from datetime import datetime, timedelta, timezone

import pytest

from comfyfed_agent import control, idle
from comfyfed_agent import main as main_module


def _args(tmp_path) -> argparse.Namespace:
    return argparse.Namespace(config=str(tmp_path / "agent.json"))


def test_pause_writes_the_flag_and_prints_both_languages(tmp_path, capsys):
    main_module._cmd_pause(_args(tmp_path))

    assert control.is_pause_requested(str(tmp_path)) is True
    out = capsys.readouterr().out
    assert "已暫停接收新工作" in out
    assert "no new jobs will be accepted" in out


def test_resume_clears_the_flag_and_mentions_idle_detection(tmp_path, capsys):
    control.request_pause(str(tmp_path))

    main_module._cmd_resume(_args(tmp_path))

    assert control.is_pause_requested(str(tmp_path)) is False
    out = capsys.readouterr().out
    assert "閒置偵測仍然有效" in out
    assert "idle detection still applies" in out


def test_resume_on_a_never_paused_agent_is_not_an_error(tmp_path, capsys):
    main_module._cmd_resume(_args(tmp_path))

    assert control.is_pause_requested(str(tmp_path)) is False
    assert capsys.readouterr().out


def test_stop_writes_the_request_and_warns_about_autostart(tmp_path, capsys):
    main_module._cmd_stop(_args(tmp_path))

    assert control.is_stop_requested(str(tmp_path)) is True
    out = capsys.readouterr().out
    assert "已要求 agent 結束" in out
    assert "開機自啟仍在" in out
    # Final review H1: stop is a graceful CANCEL (the same wind-down Ctrl-C
    # runs), not a drain. The text must not promise otherwise.
    assert "the running job finishes first" not in out
    assert "進行中的工作會被取消並清理" in out
    assert "same as Ctrl-C" in out


def test_stop_tells_the_user_how_to_drain_instead(tmp_path, capsys):
    """The honest replacement for the old promise: pause, wait, then stop."""
    main_module._cmd_stop(_args(tmp_path))

    out = capsys.readouterr().out
    assert "先 comfyfed pause" in out
    assert "comfyfed status" in out
    assert "'comfyfed pause'" in out
    assert "no longer reports busy" in out


def test_status_reports_not_running_without_a_state_file(tmp_path, capsys):
    main_module._cmd_status(_args(tmp_path))

    out = capsys.readouterr().out
    assert "agent 未在執行" in out
    assert "agent not running" in out
    assert "未手動暫停" in out


def test_status_reports_a_running_agent_and_its_job(tmp_path, capsys):
    control.write_state(str(tmp_path), "busy", "job-42")

    main_module._cmd_status(_args(tmp_path))

    out = capsys.readouterr().out
    assert "agent 執行中" in out
    assert "agent running, state: busy" in out
    assert "job-42" in out


def test_status_omits_the_job_line_when_idle(tmp_path, capsys):
    control.write_state(str(tmp_path), "idle", None)

    main_module._cmd_status(_args(tmp_path))

    out = capsys.readouterr().out
    assert "agent running, state: idle" in out
    assert "running job" not in out


def test_status_treats_a_stale_state_file_as_not_running(tmp_path, capsys):
    """A state file older than the staleness window is a leftover from an
    agent that died without cleaning up."""
    stale = datetime.now(timezone.utc) - timedelta(seconds=main_module._STATE_STALE_SECONDS + 60)
    (tmp_path / control.STATE_FILE).write_text(
        json.dumps({"pid": 1, "state": "idle", "job_id": None, "updated_at": stale.isoformat()}),
        encoding="utf-8",
    )

    main_module._cmd_status(_args(tmp_path))

    assert "agent not running" in capsys.readouterr().out


def test_status_treats_an_unparseable_timestamp_as_not_running(tmp_path, capsys):
    (tmp_path / control.STATE_FILE).write_text(
        json.dumps({"state": "idle", "updated_at": "not-a-date"}), encoding="utf-8"
    )

    main_module._cmd_status(_args(tmp_path))

    assert "agent not running" in capsys.readouterr().out


def test_status_still_reports_the_manual_pause_flag_when_not_running(tmp_path, capsys):
    control.request_pause(str(tmp_path))

    main_module._cmd_status(_args(tmp_path))

    out = capsys.readouterr().out
    assert "agent not running" in out
    assert "手動暫停中" in out
    assert "Manually paused" in out


def test_status_prints_the_live_availability_verdict(tmp_path, capsys, monkeypatch):
    """Final review L2: the docs promise the words `available` /
    `paused-manual` / `paused-active`, so `status` computes the verdict live
    rather than only echoing the heartbeat state."""
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 9999.0)

    main_module._cmd_status(_args(tmp_path))

    out = capsys.readouterr().out
    assert "availability now: available" in out
    assert "可接新工作" in out


def test_status_availability_says_paused_manual_while_paused(tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 9999.0)
    control.request_pause(str(tmp_path))

    main_module._cmd_status(_args(tmp_path))

    out = capsys.readouterr().out
    assert "availability now: paused-manual" in out
    assert "手動暫停中" in out


def test_status_availability_says_paused_active_while_the_user_is_typing(
    tmp_path, capsys, monkeypatch
):
    monkeypatch.setattr(idle, "seconds_since_input", lambda: 1.0)

    main_module._cmd_status(_args(tmp_path))

    out = capsys.readouterr().out
    assert "availability now: paused-active" in out
    assert "偵測到有人在用這台電腦" in out


@pytest.mark.parametrize("command", ["pause", "resume", "status", "stop"])
def test_cli_wires_each_subcommand_to_its_handler(monkeypatch, tmp_path, command):
    monkeypatch.setattr(
        main_module.sys, "argv", ["comfyfed", command, "--config", str(tmp_path / "agent.json")]
    )
    called = []
    monkeypatch.setattr(main_module, f"_cmd_{command}", lambda args: called.append(args.config))

    main_module.cli()

    assert called == [str(tmp_path / "agent.json")]
