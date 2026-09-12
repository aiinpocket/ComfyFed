"""comfyfed-server CLI: bilingual install wizard, and running the server."""

from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import sys

import uvicorn

from . import bootstrap, comfy_frontend, db, i18n, security
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
    lang = bootstrap.get_lang() or args.lang or "en"
    url = bootstrap.get_platform_url() or args.url or ""

    _print_password_box(result.admin_password, lang, url)


_RELEASES_DIRNAME = "releases"

# agent-0.2.0-py3-none-any.whl / comfyfed-0.2.0.whl -> "0.2.0"
_WHEEL_VERSION_RE = re.compile(r"^[^-]+-([^-]+)")


def _wheel_version(wheel_path: str) -> str:
    """Pull the version out of a PEP 427 wheel filename ({name}-{version}-...)."""
    name = os.path.basename(wheel_path)
    if not name.endswith(".whl"):
        raise SystemExit(f"Not a wheel file: {wheel_path}")
    match = _WHEEL_VERSION_RE.match(name[: -len(".whl")])
    if match is None:
        raise SystemExit(f"Cannot read a version out of the wheel filename: {name}")
    return match.group(1)


def _set_settings(values: dict) -> None:
    with db.get_session() as session:
        for key, value in values.items():
            row = session.get(db.Setting, key)
            if row is None:
                session.add(db.Setting(key=key, value=value))
            else:
                row.value = value
        session.commit()


def publish_agent(
    data_dir: str,
    wheel_path: str,
    latest: str | None = None,
    min_supported: str | None = None,
) -> dict:
    """Publish an agent wheel as this platform's advertised release.

    Copies the wheel into `<data_dir>/releases/`, hashes it, signs
    `"{version}|{sha256hex}"` with the platform's Ed25519 key, and writes the
    five `agent_*` settings that `GET /api/agent/version` serves. The signed
    payload includes the version so a signature cannot be reused to advertise
    a different release (see `comfyfed_agent.update.apply_update`).

    Returns the published values. Importable directly so tests (and any
    automation) can publish without going through argparse.
    """
    if not os.path.isfile(wheel_path):
        raise SystemExit(f"Wheel not found: {wheel_path}")

    bootstrap.ensure_installed(data_dir, lang=None, url=None, interactive=False)

    version = latest or _wheel_version(wheel_path)
    filename = os.path.basename(wheel_path)

    releases_dir = os.path.join(data_dir, _RELEASES_DIRNAME)
    os.makedirs(releases_dir, exist_ok=True)
    dest = os.path.join(releases_dir, filename)
    if os.path.abspath(dest) != os.path.abspath(wheel_path):
        shutil.copyfile(wheel_path, dest)

    with open(dest, "rb") as f:
        sha256_hex = hashlib.sha256(f.read()).hexdigest()

    signing_key, _ = security.load_platform_keys(data_dir)
    signature = signing_key.sign(f"{version}|{sha256_hex}".encode()).signature.hex()

    published = {
        "agent_latest": version,
        "agent_min_supported": min_supported or version,
        "agent_wheel_url": f"/api/agent/releases/{filename}",
        "agent_wheel_sha256": sha256_hex,
        "agent_wheel_sig": signature,
    }
    _set_settings(published)
    return published


def _cmd_publish_agent(args: argparse.Namespace) -> None:
    published = publish_agent(
        args.data_dir, args.wheel_path, latest=args.latest, min_supported=args.min_supported
    )

    print(i18n.t("publish.done", "zh-TW"))
    print(i18n.t("publish.done", "en"))
    print(f"  agent_latest        : {published['agent_latest']}")
    print(f"  agent_min_supported : {published['agent_min_supported']}")
    print(f"  agent_wheel_url     : {published['agent_wheel_url']}")
    print(f"  agent_wheel_sha256  : {published['agent_wheel_sha256']}")
    print(f"  agent_wheel_sig     : {published['agent_wheel_sig']}")
    print()
    print(i18n.t("publish.offline_key_note", "zh-TW"))
    print(i18n.t("publish.offline_key_note", "en"))


def _bilingual(key: str, **fields) -> None:
    for lang in ("zh-TW", "en"):
        print(i18n.t(key, lang).format(**fields))


def _cmd_fetch_comfy_ui(args: argparse.Namespace) -> None:
    """Download the official ComfyUI frontend bundle into the data directory.

    Deliberately does NOT require the server to be installed: an operator can
    stage the static files before (or independently of) `install`.
    """
    data_dir = args.data_dir
    os.makedirs(data_dir, exist_ok=True)

    if comfy_frontend.is_populated(data_dir):
        _bilingual("fetch_ui.already_present")
        print(f"  {comfy_frontend.frontend_dir(data_dir)}")
        return

    version = args.version or comfy_frontend.FRONTEND_VERSION
    if args.version:
        _bilingual("fetch_ui.unpinned_warning")

    _bilingual("fetch_ui.start", version=version)

    try:
        result = comfy_frontend.fetch(data_dir, version=args.version)
    except comfy_frontend.FetchError as exc:
        _bilingual("fetch_ui.failed")
        raise SystemExit(f"  {exc}")

    _bilingual("fetch_ui.done", files=result["files"])
    print(f"  {result['dir']}")


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

    publish = sub.add_parser(
        "publish-agent", help="Publish an agent wheel as the platform's advertised release."
    )
    publish.add_argument("wheel_path", help="Path to the agent .whl to publish.")
    publish.add_argument(
        "--latest", default=None, help="Version to advertise (default: parsed from the wheel filename)."
    )
    publish.add_argument(
        "--min-supported",
        default=None,
        dest="min_supported",
        help="Oldest agent version still allowed to connect (default: same as --latest).",
    )
    publish.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="Data directory (default: ./data).")
    publish.set_defaults(func=_cmd_publish_agent)

    fetch_ui = sub.add_parser(
        "fetch-comfy-ui",
        help="Download the official ComfyUI frontend for the embedded /comfy editor.",
    )
    fetch_ui.add_argument(
        "--version",
        default=None,
        help=(
            "Override the pinned comfyui-frontend-package version "
            f"(default: {comfy_frontend.FRONTEND_VERSION}). Skips sha256 verification."
        ),
    )
    fetch_ui.add_argument("--data-dir", default=DEFAULT_DATA_DIR, help="Data directory (default: ./data).")
    fetch_ui.set_defaults(func=_cmd_fetch_comfy_ui)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    cli()
