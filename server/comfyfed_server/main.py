"""comfyfed-server CLI: bilingual install wizard, and running the server."""

from __future__ import annotations

import argparse
import os
import sys

import uvicorn

from . import bootstrap, db, i18n
from .app import create_app

# Best-effort: force UTF-8 stdout/stderr so bilingual (zh-TW + en) install
# output renders correctly regardless of the host console's codepage (e.g.
# a default Windows terminal on cp950/cp1252). Not all stream objects
# support reconfigure (e.g. when stdout is replaced by a test runner).
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass

DEFAULT_DATA_DIR = "./data"
DEFAULT_HOST = "0.0.0.0"
DEFAULT_PORT = 8388


def _print_password_box(password: str, lang: str, url: str) -> None:
    title_zh = i18n.t("install.password_box_title", "zh-TW")
    title_en = i18n.t("install.password_box_title", "en")
    border = "*" * 64

    # Not width-aligned to the border: CJK characters are double-width in a
    # terminal, so padding based on Python's (single-width) len() would
    # misalign anyway. A plain bordered block reads fine either way and
    # avoids that miscalculation entirely.
    print()
    print(border)
    print(f"* {title_zh} / {title_en}")
    print("*")
    print(f"*   {password}")
    print(border)
    print()
    print(i18n.t("install.next_steps", "zh-TW"))
    print(i18n.t("install.next_steps", "en"))
    print("  comfyfed-server run")
    if url:
        print(f"  {url}")
    print()


def _cmd_install(args: argparse.Namespace) -> None:
    if args.non_interactive and (not args.lang or not args.url):
        raise SystemExit("--non-interactive requires both --lang and --url.")

    data_dir = args.data_dir
    os.makedirs(data_dir, exist_ok=True)

    interactive = not args.non_interactive
    result = bootstrap.ensure_installed(
        data_dir, lang=args.lang, url=args.url, interactive=interactive
    )

    if not result.first_run:
        print(i18n.t("install.already_installed", "zh-TW"))
        print(i18n.t("install.already_installed", "en"))
        return

    # In interactive mode the wizard prompts for lang/url itself, so they may
    # not be present on `args`; read back what was actually persisted.
    with db.get_session() as session:
        lang_row = session.get(db.Setting, bootstrap._LANG_KEY)
        url_row = session.get(db.Setting, bootstrap._PLATFORM_URL_KEY)
        lang = (lang_row.value if lang_row else None) or args.lang or "en"
        url = (url_row.value if url_row else None) or args.url or ""

    _print_password_box(result.admin_password, lang, url)


def _cmd_run(args: argparse.Namespace) -> None:
    app = create_app(args.data_dir)
    uvicorn.run(app, host=args.host, port=args.port)


def cli() -> None:
    parser = argparse.ArgumentParser(
        prog="comfyfed-server", description="ComfyFed platform server."
    )
    sub = parser.add_subparsers(dest="command", required=True)

    install = sub.add_parser("install", help="Install (first-run bootstrap) the server.")
    install.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="Data directory (default: ./data).")
    install.add_argument("--lang", choices=["zh-TW", "en"], default=None, help="Interface language.")
    install.add_argument("--url", default=None, help="Public platform URL.")
    install.add_argument(
        "--non-interactive", action="store_true", help="Skip the interactive wizard (requires --lang and --url)."
    )
    install.set_defaults(func=_cmd_install)

    run = sub.add_parser("run", help="Run the server.")
    run.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="Data directory (default: ./data).")
    run.add_argument("--host", default=DEFAULT_HOST, help="Bind host (default: 0.0.0.0).")
    run.add_argument("--port", type=int, default=DEFAULT_PORT, help="Bind port (default: 8388).")
    run.set_defaults(func=_cmd_run)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    cli()
