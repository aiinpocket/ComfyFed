"""comfyfed-agent CLI: register with a platform, then run the job loop."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket

import httpx

from . import identity
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

    print(f"Starting agent loop for {len(cfg.platforms)} platform(s)...")
    asyncio.run(AgentLoop(cfg, args.config).run())


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
