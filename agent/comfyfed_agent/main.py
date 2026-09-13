"""comfyfed-agent CLI: register with a platform, then run the job loop."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import sys

import httpx

from . import __version__, identity, update
from .config import AgentConfig
from .runner import AgentLoop

DEFAULT_CONFIG_PATH = os.path.join(os.path.expanduser("~"), ".comfyfed", "agent.json")


def _cmd_register(args: argparse.Namespace) -> None:
    with open(args.bundle, "r", encoding="utf-8") as f:
        bundle = json.load(f)

    name = args.name or socket.gethostname()

    with httpx.Client() as client:
        entry = identity.register(bundle, name, args.config, client)

    print(f"Registered worker '{name}' ({entry.worker_id}) with platform {entry.platform_url}")
    print(f"Config saved to {args.config}")


def _cmd_run(args: argparse.Namespace) -> None:
    cfg = AgentConfig.load(args.config)
    if not cfg.platforms:
        print(f"No platforms registered in {args.config}. Run 'comfyfed-agent register <bundle.json>' first.")
        return

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

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    cli()
