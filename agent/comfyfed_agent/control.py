"""Cross-process control for a running agent: pause / resume / stop / status.

The agent normally runs as a background service, so `comfyfed pause` in a
second terminal has no channel to it -- no signal works identically on
Windows, macOS and Linux, and there is no local socket. Instead the CLI
drops tiny marker files next to `agent.json` and the runner's heartbeat loop
polls them once per beat; the runner writes `agent_state.json` back so
`comfyfed status` can report what the service is doing.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone

from . import idle

PAUSE_FILE = "paused"
STOP_FILE = "stop.request"
STATE_FILE = "agent_state.json"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _path(config_dir: str, name: str) -> str:
    return os.path.join(config_dir, name)


def _touch(config_dir: str, name: str) -> None:
    os.makedirs(config_dir, exist_ok=True)
    with open(_path(config_dir, name), "w", encoding="utf-8") as f:
        f.write(_now_iso())


def _remove(config_dir: str, name: str) -> None:
    try:
        os.remove(_path(config_dir, name))
    except FileNotFoundError:
        pass
    except OSError:
        # A locked/unwritable config dir is not worth crashing the CLI or the
        # heartbeat tick over; the next attempt retries.
        pass


def is_pause_requested(config_dir: str) -> bool:
    return os.path.exists(_path(config_dir, PAUSE_FILE))


def request_pause(config_dir: str) -> None:
    _touch(config_dir, PAUSE_FILE)


def clear_pause(config_dir: str) -> None:
    _remove(config_dir, PAUSE_FILE)


def is_stop_requested(config_dir: str) -> bool:
    return os.path.exists(_path(config_dir, STOP_FILE))


def request_stop(config_dir: str) -> None:
    _touch(config_dir, STOP_FILE)


def clear_stop(config_dir: str) -> None:
    _remove(config_dir, STOP_FILE)


def write_state(config_dir: str, state: str, job_id: str | None) -> None:
    """Publish what the running agent is doing, atomically (`status` may read
    it at any instant, and must never see a half-written file)."""
    try:
        os.makedirs(config_dir, exist_ok=True)
        payload = {
            "pid": os.getpid(),
            "state": state,
            "job_id": job_id,
            "updated_at": _now_iso(),
        }
        path = _path(config_dir, STATE_FILE)
        tmp_path = f"{path}.tmp-{os.getpid()}"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False)
        os.replace(tmp_path, path)
        try:
            # Same posture as config.py's 0600 on agent.json: the contents
            # (pid, state, job id) are low-sensitivity, but on a shared Unix
            # host there is no reason to let every local user enumerate which
            # jobs this worker runs and when it sits idle. Best-effort --
            # chmod is a no-op-ish on Windows and must never break a tick.
            os.chmod(path, 0o600)
        except OSError:
            pass
    except OSError:
        # Status reporting is a convenience; never let it break a heartbeat.
        pass


def clear_state(config_dir: str) -> None:
    """Drop the published state on a clean exit, so `status` says "not
    running" immediately instead of waiting out its staleness window."""
    _remove(config_dir, STATE_FILE)


def read_state(config_dir: str) -> dict | None:
    """The last state the running agent published, or `None` if there is none
    (never started, already exited and cleaned up) or it is unreadable."""
    try:
        with open(_path(config_dir, STATE_FILE), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    return data


def availability(cfg, config_dir: str) -> str:
    """`"available"`, `"paused-manual"` or `"paused-active"`.

    A manual pause wins outright -- it is an explicit human decision and must
    not be second-guessed by idle detection. Otherwise the machine counts as
    busy-with-a-human only when detection actually produced a number below
    the threshold: `None` (cannot detect) is always-available, so a headless
    box never becomes unschedulable.
    """
    if is_pause_requested(config_dir):
        return "paused-manual"
    if getattr(cfg, "pause_when_active", False):
        seconds = idle.seconds_since_input()
        if isinstance(seconds, (int, float)) and seconds < cfg.idle_minutes * 60:
            return "paused-active"
    return "available"
