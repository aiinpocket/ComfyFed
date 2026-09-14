"""`comfyfed pause / resume / status / stop`: the control files they write
and the bilingual output they print."""

import argparse
import json
from datetime import datetime, timedelta, timezone

import pytest

from comfyfed_agent import control
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
    assert "the running job finishes first" in out


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


@pytest.mark.parametrize("command", ["pause", "resume", "status", "stop"])
def test_cli_wires_each_subcommand_to_its_handler(monkeypatch, tmp_path, command):
    monkeypatch.setattr(
        main_module.sys, "argv", ["comfyfed", command, "--config", str(tmp_path / "agent.json")]
    )
    called = []
    monkeypatch.setattr(main_module, f"_cmd_{command}", lambda args: called.append(args.config))

    main_module.cli()

    assert called == [str(tmp_path / "agent.json")]
