"""Tests for `comfyupdate` (platform-commanded ComfyUI update) and the
runner's handling of the protocol-6 `update_comfyui` push."""

from __future__ import annotations

import asyncio
import json
import os

import pytest

from comfyfed_agent import comfyupdate, hardware, whitelist
from comfyfed_agent.config import AgentConfig, PlatformEntry
from comfyfed_agent.runner import AgentLoop


# --- comfyupdate unit pieces --------------------------------------------


def test_parse_tag_accepts_stable_and_rejects_prereleases():
    assert comfyupdate._parse_tag("v0.42.5") == (0, 42, 5)
    assert comfyupdate._parse_tag("v1.0") == (1, 0, 0)
    assert comfyupdate._parse_tag("v0.42.5rc1") is None
    assert comfyupdate._parse_tag("latest") is None
    assert comfyupdate._parse_tag("") is None


def test_latest_stable_tag_picks_the_numeric_maximum(monkeypatch):
    tags = "v0.9.9\nv0.42.5\nv0.42.4\nv0.43.0rc1\nnightly\n"
    monkeypatch.setattr(comfyupdate, "_git", lambda repo, *a: tags)
    assert comfyupdate.latest_stable_tag("/repo") == "v0.42.5"


def test_latest_stable_tag_none_when_no_stable_tags(monkeypatch):
    monkeypatch.setattr(comfyupdate, "_git", lambda repo, *a: "nightly\nv1.0rc1\n")
    assert comfyupdate.latest_stable_tag("/repo") is None


def test_perform_update_fails_without_marker(tmp_path):
    result = comfyupdate.perform_update(str(tmp_path), "http://127.0.0.1:8188", lambda s: None)
    assert not result.ok
    assert comfyupdate.MARKER_NAME in result.detail


def _write_marker(tmp_path, comfy_dir):
    marker = {
        "start_exe": os.path.join(str(comfy_dir), "python.exe"),
        "args": ["main.py", "--port", "8199"],
        "cwd": str(comfy_dir),
    }
    with open(os.path.join(str(tmp_path), comfyupdate.MARKER_NAME), "w", encoding="utf-8") as f:
        json.dump(marker, f)


def test_perform_update_fails_when_not_a_git_checkout(tmp_path, monkeypatch):
    comfy_dir = tmp_path / "comfy"
    comfy_dir.mkdir()
    _write_marker(tmp_path, comfy_dir)

    def fake_git(repo, *args):
        raise RuntimeError("not a git repo")

    monkeypatch.setattr(comfyupdate, "_git", fake_git)
    result = comfyupdate.perform_update(str(tmp_path), "http://127.0.0.1:8188", lambda s: None)
    assert not result.ok
    assert "git" in result.detail


def test_perform_update_short_circuits_when_already_latest(tmp_path, monkeypatch):
    comfy_dir = tmp_path / "comfy"
    comfy_dir.mkdir()
    _write_marker(tmp_path, comfy_dir)

    def fake_git(repo, *args):
        if args[0] == "rev-parse" and args[1] == "--is-inside-work-tree":
            return "true"
        if args[0] == "rev-parse":
            return "abc123"
        if args[0] == "fetch":
            return ""
        if args[0] == "tag":
            return "v0.42.4\nv0.42.5\n"
        if args[0] == "describe":
            return "v0.42.5"
        raise AssertionError(f"unexpected git call: {args}")

    monkeypatch.setattr(comfyupdate, "_git", fake_git)
    result = comfyupdate.perform_update(str(tmp_path), "http://127.0.0.1:8188", lambda s: None)
    assert result.ok
    assert result.version == "0.42.5"
    assert "already" in result.detail or "最新" in result.detail


# --- runner handling of the two pushes ----------------------------------


def _entry(worker_id: str) -> PlatformEntry:
    return PlatformEntry(
        platform_url="http://platform.example",
        platform_pubkey="pp",
        worker_id=worker_id,
        certificate="cert",
        signing_key_hex="11" * 32,
    )


def _loop(tmp_path, monkeypatch, **cfg_overrides) -> AgentLoop:
    monkeypatch.setattr(whitelist, "allowed_classes", lambda *a, **k: {"KSampler"})
    monkeypatch.setattr(hardware, "collect_dynamic", lambda *a, **k: {"free_ram_gb": 1})
    config = AgentConfig(platforms=[_entry("worker-a")], pause_when_active=False, **cfg_overrides)
    return AgentLoop(config, str(tmp_path / "agent.json"))


def test_collect_dynamic_merges_the_update_status(tmp_path, monkeypatch):
    loop = _loop(tmp_path, monkeypatch)
    assert loop._collect_dynamic() == {"free_ram_gb": 1}

    loop._set_comfy_update_status("updating", "fetching tags")
    dynamic = loop._collect_dynamic()
    assert dynamic["free_ram_gb"] == 1
    assert dynamic["comfyui_update"]["status"] == "updating"
    assert dynamic["comfyui_update"]["detail"] == "fetching tags"
    assert dynamic["comfyui_update"]["at"]


@pytest.mark.asyncio
async def test_update_comfyui_defers_while_a_job_runs(tmp_path, monkeypatch):
    """2026-10-25「強迫更新」: a busy worker parks the command and starts the
    update the moment the job is gone, instead of making the admin retry."""
    loop = _loop(tmp_path, monkeypatch)

    class _Handle:
        running = True
        job_id = "job-1"

    loop._jobs["job-1"] = _Handle()
    loop._spawn_comfy_update()
    assert loop._comfy_update_task is None
    assert loop._comfy_update_pending is True
    assert loop._comfy_update_status["status"] == "deferred"


@pytest.mark.asyncio
async def test_update_comfyui_runs_and_reports_then_reconnects(tmp_path, monkeypatch):
    loop = _loop(tmp_path, monkeypatch)

    closed = []

    class _FakeConn:
        state = "idle"

        async def close(self):
            closed.append(True)

    loop.connections = {"worker-a": _FakeConn()}

    async def no_beat(*a, **k):
        return None

    monkeypatch.setattr(loop, "broadcast_heartbeat", no_beat)
    monkeypatch.setattr(
        comfyupdate,
        "perform_update",
        lambda config_dir, comfy_url, status: comfyupdate.UpdateResult(
            True, "updated", "0.99.0"
        ),
    )

    loop._spawn_comfy_update()
    assert loop._comfy_update_status["status"] == "updating"
    await loop._comfy_update_task
    assert loop._comfy_update_status["status"] == "ok"
    assert loop._comfy_update_status["version"] == "0.99.0"
    assert closed  # reconnect so the fresh hello reports the new version
