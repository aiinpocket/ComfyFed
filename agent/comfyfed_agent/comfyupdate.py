"""Platform-commanded ComfyUI update: git checkout of the latest stable tag.

Triggered by the server pushing `{"type": "update_comfyui"}` over the agent
WS (admin button on the console's Workers page; agent protocol 6). The whole
routine is BLOCKING by design -- the runner calls it through
`asyncio.to_thread` and reports progress through the heartbeat `dynamic`
blob, so nothing here needs an event loop.

What counts as "updatable": the ComfyUI recorded in `comfyui_managed.json`
(written by the installer, next to agent.json -- see installers/install.*),
whose working directory is a git checkout. That covers both installs the
installer creates and the "detected" case where it captured how an existing
ComfyUI (e.g. Comfy Desktop) is started, as long as that install is a git
repo. Anything else -- no marker, no git, no start command -- fails fast
with a reason the console can show, and touches nothing.

Update = `git fetch --tags` + checkout of the highest `vX.Y[.Z]` tag +
`<marker python> -m pip install -r requirements.txt` + restart of the
ComfyUI process (kill the port's listener, relaunch with the marker's
recorded command, wait for `/system_stats`). If the freshly checked-out
version fails to come back up, the previous ref is checked out again and
restarted (best effort), so a broken release doesn't strand the worker.
"""

from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import time
from dataclasses import dataclass
from typing import Callable, Optional
from urllib.parse import urlparse

import httpx
import psutil

logger = logging.getLogger(__name__)

MARKER_NAME = "comfyui_managed.json"

_STABLE_TAG_RE = re.compile(r"^v(\d+)\.(\d+)(?:\.(\d+))?$")

# Model-heavy ComfyUI starts can take a while on a cold disk; match the
# installer's patience (60 polls x 3 s) and then some.
_READY_TIMEOUT_SECONDS = 240
_READY_POLL_SECONDS = 3

# `git fetch` against a slow network; `pip install` of a torch-adjacent
# requirements set. Generous but bounded -- a wedged subprocess must not
# hold the agent's update slot forever.
_GIT_TIMEOUT_SECONDS = 300
_PIP_TIMEOUT_SECONDS = 1800


@dataclass
class UpdateResult:
    ok: bool
    detail: str
    version: Optional[str] = None  # ComfyUI version string after the attempt


StatusCb = Callable[[str], None]


def _read_marker(config_dir: str) -> dict:
    path = os.path.join(config_dir, MARKER_NAME)
    with open(path, "r", encoding="utf-8-sig") as f:
        marker = json.load(f)
    if not isinstance(marker, dict):
        raise ValueError("marker is not an object")
    return marker


def _marker_paths(marker: dict) -> tuple[str, list[str], str]:
    """(python/start exe, args, comfy working dir) out of the marker.

    The comfy dir is the marker's `cwd` when present; otherwise the
    directory of a `main.py` found in args is NOT derivable (args are
    relative to cwd), so a marker without `cwd` only updates when its
    `start_exe` lives inside the checkout -- not worth guessing: fail.
    """
    start_exe = marker.get("start_exe")
    args = marker.get("args")
    cwd = marker.get("cwd")
    if not isinstance(start_exe, str) or not start_exe:
        raise ValueError("marker has no start_exe")
    if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
        raise ValueError("marker has no usable args")
    if not isinstance(cwd, str) or not os.path.isdir(cwd):
        raise ValueError("marker has no usable cwd")
    return start_exe, list(args), cwd


def _git(repo: str, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True,
        text=True,
        timeout=_GIT_TIMEOUT_SECONDS,
        check=True,
    )
    return result.stdout.strip()


def _parse_tag(tag: str) -> Optional[tuple[int, ...]]:
    m = _STABLE_TAG_RE.match(tag.strip())
    if not m:
        return None
    return tuple(int(part) for part in m.groups(default="0"))


def latest_stable_tag(repo: str) -> Optional[str]:
    """The highest `vX.Y[.Z]` tag the checkout knows (after a fetch)."""
    best: Optional[tuple[tuple[int, ...], str]] = None
    for tag in _git(repo, "tag", "--list").splitlines():
        parsed = _parse_tag(tag)
        if parsed is None:
            continue
        if best is None or parsed > best[0]:
            best = (parsed, tag.strip())
    return best[1] if best else None


def _comfy_port(comfy_url: str) -> Optional[int]:
    try:
        parsed = urlparse(comfy_url)
        return parsed.port
    except ValueError:
        return None


def _stop_comfy(comfy_url: str, status: StatusCb) -> None:
    """Terminate whatever is listening on the ComfyUI port, and wait it out.

    No listener is fine (ComfyUI already down); a listener that survives
    terminate() gets kill(). Raises on a port we cannot free -- replacing
    the code under a still-running ComfyUI works, but the whole point of
    the restart is to LOAD the new code.
    """
    port = _comfy_port(comfy_url)
    if port is None:
        raise RuntimeError(f"comfy_url has no port: {comfy_url}")
    pids = set()
    for conn in psutil.net_connections(kind="tcp"):
        if conn.laddr and conn.laddr.port == port and conn.status == psutil.CONN_LISTEN:
            if conn.pid:
                pids.add(conn.pid)
    if not pids:
        return
    status("stopping ComfyUI")
    procs = []
    for pid in pids:
        try:
            p = psutil.Process(pid)
            p.terminate()
            procs.append(p)
        except psutil.Error:
            continue
    _, alive = psutil.wait_procs(procs, timeout=30)
    for p in alive:
        try:
            p.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(alive, timeout=15)


def _start_comfy(start_exe: str, args: list[str], cwd: str, config_dir: str) -> None:
    """Relaunch ComfyUI detached, logging into the agent's config dir.

    Same command the launcher replays at logon (`start_exe` + `args`, run in
    `cwd`), so an install the installer could bring up, this can too.
    """
    log_path = os.path.join(config_dir, "comfyui.update.log")
    log = open(log_path, "ab")
    kwargs: dict = {
        "cwd": cwd,
        "stdout": log,
        "stderr": subprocess.STDOUT,
        "stdin": subprocess.DEVNULL,
    }
    if os.name == "nt":
        kwargs["creationflags"] = (
            subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
        )
    else:
        kwargs["start_new_session"] = True
    try:
        subprocess.Popen([start_exe, *args], **kwargs)
    finally:
        log.close()


def _wait_ready(comfy_url: str) -> Optional[str]:
    """Poll `/system_stats` until ComfyUI answers; its version, or None."""
    deadline = time.monotonic() + _READY_TIMEOUT_SECONDS
    url = comfy_url.rstrip("/") + "/system_stats"
    while time.monotonic() < deadline:
        try:
            r = httpx.get(url, timeout=5)
            r.raise_for_status()
            version = (r.json().get("system") or {}).get("comfyui_version")
            return version if isinstance(version, str) and version else "unknown"
        except Exception:
            time.sleep(_READY_POLL_SECONDS)
    return None


def perform_update(config_dir: str, comfy_url: str, status: StatusCb) -> UpdateResult:
    """The whole update, synchronously. Never raises -- every failure is an
    `UpdateResult(ok=False)` whose detail is fit for the console."""
    try:
        marker = _read_marker(config_dir)
    except Exception as exc:
        return UpdateResult(False, f"無法讀取 {MARKER_NAME} / cannot read marker: {exc}")
    try:
        start_exe, args, repo = _marker_paths(marker)
    except ValueError as exc:
        return UpdateResult(False, f"{MARKER_NAME}: {exc}")

    try:
        _git(repo, "rev-parse", "--is-inside-work-tree")
    except Exception:
        return UpdateResult(
            False,
            f"ComfyUI 不是 git 安裝，無法自動更新 / not a git checkout, cannot auto-update: {repo}",
        )

    try:
        previous_ref = _git(repo, "rev-parse", "HEAD")
    except Exception as exc:
        return UpdateResult(False, f"git rev-parse failed: {exc}")

    status("fetching tags")
    try:
        _git(repo, "fetch", "--tags", "--quiet")
    except Exception as exc:
        return UpdateResult(False, f"git fetch failed: {exc}")

    target = latest_stable_tag(repo)
    if not target:
        return UpdateResult(False, "找不到任何穩定版 tag / no stable vX.Y.Z tag found")

    try:
        current_tag = _git(repo, "describe", "--tags", "--exact-match")
    except Exception:
        current_tag = ""
    if current_tag == target:
        version = current_tag.lstrip("v")
        return UpdateResult(True, f"已是最新版 / already at the latest release ({target})", version)

    status(f"checking out {target}")
    try:
        _git(repo, "checkout", "--quiet", target)
    except Exception as exc:
        return UpdateResult(False, f"git checkout {target} failed: {exc}")

    def _pip_requirements() -> None:
        subprocess.run(
            [start_exe, "-m", "pip", "install", "-q", "-r",
             os.path.join(repo, "requirements.txt")],
            capture_output=True,
            text=True,
            timeout=_PIP_TIMEOUT_SECONDS,
            check=True,
        )

    status("installing requirements")
    try:
        _pip_requirements()
    except Exception as exc:
        # Roll the checkout back so the still-running (old) ComfyUI and its
        # on-disk code agree again.
        try:
            _git(repo, "checkout", "--quiet", previous_ref)
        except Exception:
            logger.exception("comfyupdate: rollback checkout failed")
        return UpdateResult(False, f"pip install -r requirements.txt failed: {exc}")

    status("restarting ComfyUI")
    try:
        _stop_comfy(comfy_url, status)
        _start_comfy(start_exe, args, repo, config_dir)
    except Exception as exc:
        return UpdateResult(False, f"restart failed: {exc}")

    version = _wait_ready(comfy_url)
    if version is not None:
        return UpdateResult(True, f"更新完成 / updated to {target}", version)

    # The new release did not come up: best-effort rollback to the ref that
    # was running before, so the worker doesn't stay dead.
    logger.warning("comfyupdate: %s did not become ready; rolling back", target)
    status("rolling back")
    try:
        _git(repo, "checkout", "--quiet", previous_ref)
        _pip_requirements()
        _stop_comfy(comfy_url, status)
        _start_comfy(start_exe, args, repo, config_dir)
        rolled_version = _wait_ready(comfy_url)
    except Exception:
        logger.exception("comfyupdate: rollback failed")
        rolled_version = None
    if rolled_version is not None:
        return UpdateResult(
            False,
            f"{target} 啟動失敗，已回復原版本 / {target} failed to start; rolled back",
            rolled_version,
        )
    return UpdateResult(
        False,
        f"{target} 啟動失敗且回復失敗，請手動處理 / {target} failed to start AND the rollback "
        "did not come up -- manual intervention needed",
    )
