"""comfyfed-agent CLI: register with a platform, then run the job loop."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys

import httpx

from datetime import datetime, timezone

from . import __version__, control, detect, identity, update
from .config import AgentConfig
from .runner import AgentLoop

DEFAULT_CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".comfyfed", "agent.json")

# How stale the agent's published state may be before `status` calls the
# agent "not running": four heartbeats' worth of slack over the 30s beat, so
# one missed or slow tick never reads as a dead service.
_STATE_STALE_SECONDS = 120.0


def _cmd_register(args: argparse.Namespace) -> None:
    with open(args.bundle, "r", encoding="utf-8") as f:
        bundle = json.load(f)

    name = args.name or socket.gethostname()

    with httpx.Client() as client:
        entry = identity.register(bundle, name, args.config, client)

    print(f"Registered worker '{name}' ({entry.worker_id}) with platform {entry.platform_url}")
    print(f"Config saved to {args.config}")

    # Auto-detect the local ComfyUI so a fresh install needs no hand-edited
    # agent.json (user directive, 2026-09-14): port via /system_stats
    # fingerprint, models/output/input dirs via /internal/folder_paths.
    cfg = AgentConfig.load(args.config)
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
    if notes:
        cfg.save(args.config)
        for note in notes:
            print(f"  {note}")
    with httpx.Client() as client:
        comfy_ok = detect.probe_comfy(cfg.comfy_url, client)
    if not comfy_ok:
        print(
            "找不到本機 ComfyUI（請確認它正在執行，或在 agent.json 填 comfy_url）。/ "
            "No local ComfyUI found -- make sure it is running, or set comfy_url in agent.json."
        )


def _cmd_run(args: argparse.Namespace) -> None:
    cfg = AgentConfig.load(args.config)
    if not cfg.platforms:
        print(f"No platforms registered in {args.config}. Run 'comfyfed-agent register <bundle.json>' first.")
        return

    # Auto-detect / re-detect the local ComfyUI before starting: fills any
    # still-missing dirs and recovers a moved port (only when comfy_url is
    # the untouched default) -- see detect.apply_detection's contract.
    with httpx.Client() as client:
        notes = detect.apply_detection(cfg, client, AgentConfig.comfy_url)
        if notes:
            cfg.save(args.config)
            for note in notes:
                print(f"  {note}")
        if not detect.probe_comfy(cfg.comfy_url, client):
            print(
                f"連不上 ComfyUI（{cfg.comfy_url}）——請確認它正在執行，或在 {args.config} 修改 comfy_url。/ "
                f"Cannot reach ComfyUI at {cfg.comfy_url} -- make sure it is running, or fix comfy_url in {args.config}."
            )

    # One agent install may be pinned to multiple platforms; checking the
    # first is enough since any pinned platform can vouch for whether this
    # agent build is still supported.
    with httpx.Client() as client:
        decision = update.check(cfg.platforms[0], __version__, client)

        if decision.action == "blocked":
            print(
                f"This agent version ({__version__}) is no longer supported by "
                f"{cfg.platforms[0].platform_url} (minimum: {decision.min_supported}). "
                "請更新 comfyfed-agent 後再啟動 / Please update comfyfed-agent before starting."
            )
            sys.exit(3)

        if decision.action == "update":
            if cfg.auto_update:
                print(f"Updating comfyfed-agent {__version__} -> {decision.latest}...")
                if not update.apply_update(cfg.platforms[0], decision, client):
                    print("Update failed verification; continuing with the current version.")
            else:
                print(f"新版本可用 / A new version is available: {decision.latest} (auto_update is off).")

    print(f"Starting agent loop for {len(cfg.platforms)} platform(s)...")
    agent_loop = AgentLoop(cfg, args.config)
    try:
        asyncio.run(agent_loop.run())
    except RuntimeError as exc:
        # `_graceful_shutdown_and_stop` calls `loop.stop()` from a task once
        # a console signal (Ctrl-C / CTRL_BREAK) has been handled and the job
        # wound down cleanly -- but `asyncio.run`'s own `run_until_complete`
        # was still waiting on the `run()` coroutine (parked in `gather`),
        # not on that task, so it raises this exact RuntimeError rather than
        # returning normally. That is expected and not an error: swallow it
        # and exit 0. Any OTHER RuntimeError (no signal ever seen) is a real
        # bug and must keep propagating.
        if agent_loop.shutdown_in_progress and "Event loop stopped before Future completed" in str(exc):
            sys.exit(0)
        raise


def _config_dir(args: argparse.Namespace) -> str:
    """The control files live beside the config file the agent was started
    with, so `--config` is the only thing a second terminal has to match."""
    return os.path.dirname(os.path.abspath(args.config))


def _cmd_pause(args: argparse.Namespace) -> None:
    control.request_pause(_config_dir(args))
    print(
        "已暫停接收新工作（最慢一個心跳週期內生效；進行中的工作會跑完）。/ "
        "Paused: no new jobs will be accepted (takes effect within one heartbeat; "
        "the running job finishes)."
    )


def _cmd_resume(args: argparse.Namespace) -> None:
    control.clear_pause(_config_dir(args))
    print(
        "已恢復接收新工作（閒置偵測仍然有效：偵測到你在使用電腦時仍會自動暫停）。/ "
        "Resumed: new jobs will be accepted again (idle detection still applies -- "
        "the agent auto-pauses while you are using the machine, if enabled)."
    )


def _cmd_stop(args: argparse.Namespace) -> None:
    control.request_stop(_config_dir(args))
    print(
        "已要求 agent 結束（進行中的工作會先跑完）。開機自啟仍在：下次登入／開機會再啟動；"
        "要恢復請執行 comfyfed resume 前先手動啟動，或重新登入。/ "
        "Stop requested; the running job finishes first. Autostart remains: "
        "the agent returns at next logon/boot."
    )


def _state_age_seconds(state: dict) -> float | None:
    """Seconds since the agent published `state`, or `None` if the timestamp
    is missing or unparseable (a hand-mangled file reads as stale)."""
    raw = state.get("updated_at")
    if not isinstance(raw, str):
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - parsed).total_seconds()


def _cmd_status(args: argparse.Namespace) -> None:
    config_dir = _config_dir(args)
    paused = control.is_pause_requested(config_dir)
    state = control.read_state(config_dir)
    age = _state_age_seconds(state) if state else None

    if state is None or age is None or age > _STATE_STALE_SECONDS:
        print("agent 未在執行 / agent not running")
    else:
        reported = state.get("state") or "unknown"
        job_id = state.get("job_id")
        print(f"agent 執行中，狀態：{reported} / agent running, state: {reported}")
        if job_id:
            print(f"進行中的工作 / running job: {job_id}")

    if paused:
        print(
            "手動暫停中（執行 comfyfed resume 以恢復）。/ "
            "Manually paused (run 'comfyfed resume' to resume)."
        )
    else:
        print(
            "未手動暫停（閒置偵測可能仍會自動暫停）。/ "
            "Not manually paused (idle detection may still auto-pause)."
        )


def cli() -> None:
    parser = argparse.ArgumentParser(prog="comfyfed-agent", description="ComfyFed agent: run ComfyUI jobs for a platform.")
    sub = parser.add_subparsers(dest="command", required=True)

    reg = sub.add_parser("register", help="Register this agent with a platform using a registration bundle.")
    reg.add_argument("bundle", help="Path to the bundle JSON issued by the platform.")
    reg.add_argument("--name", default=None, help="Worker name (defaults to this machine's hostname).")
    reg.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to the agent config file.")
    reg.set_defaults(func=_cmd_register)

    runp = sub.add_parser("run", help="Connect to all registered platforms and process jobs.")
    runp.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to the agent config file.")
    runp.set_defaults(func=_cmd_run)

    for name, help_text, handler in (
        ("pause", "暫停接收新工作 / Stop accepting new jobs (the running job finishes).", _cmd_pause),
        ("resume", "恢復接收新工作 / Accept new jobs again.", _cmd_resume),
        ("status", "顯示 agent 狀態 / Show the agent's current state.", _cmd_status),
        ("stop", "要求 agent 結束 / Ask a running agent to shut down gracefully.", _cmd_stop),
    ):
        p = sub.add_parser(name, help=help_text)
        p.add_argument("--config", default=DEFAULT_CONFIG_PATH, help="Path to the agent config file.")
        p.set_defaults(func=handler)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    cli()
