"""Auto-detection of the local ComfyUI install.

User directive (2026-09-14): a fresh agent should find the local ComfyUI by
itself -- which port it listens on, where its models/output/input folders
live -- and only ask for manual `agent.json` edits when nothing can be
found. ComfyUI (0.3x, desktop and OSS alike) self-describes well enough to
make that reliable:

- `GET /system_stats` is the fingerprint: a JSON body whose `system` object
  carries `comfyui_version`. Anything else listening on a candidate port
  (another web app, a dev server) fails this check and is skipped.
- `GET /internal/folder_paths` maps every model category to its configured
  directory list, e.g. `checkpoints -> [<shared>/models/checkpoints,
  <install>/models/checkpoints, <install>/output/checkpoints]`. From it:
  * `models_dir` = the parent of the first existing `checkpoints` entry
    (first entry = ComfyUI's highest-priority location -- on desktop
    installs that is the shared models library, exactly what the agent
    should scan and download into);
  * `comfy_output_dir`/`comfy_input_dir` = `<base>/output` and
    `<base>/input` for the first `<base>/models/<category>` entry whose
    sibling output+input folders actually exist on disk.

Detection never overwrites a value the user set by hand: only missing
fields (and a `comfy_url` still at its untouched default that does not
answer the fingerprint) are filled in.
"""

from __future__ import annotations

import concurrent.futures
import logging
import os
import socket

import httpx

logger = logging.getLogger(__name__)

# Well-known ComfyUI ports, probed first (in order): the OSS default, the
# desktop app's default, then two common "I moved it" choices.
DEFAULT_PORT_CANDIDATES: tuple[int, ...] = (8188, 8000, 8080, 8888)

# Fallback sweep for custom ports (raw TCP connect, ~50ms each, run on a
# thread pool so the whole range takes well under a second locally).
SWEEP_PORTS: tuple[int, ...] = tuple(range(8000, 8400))

_PROBE_TIMEOUT_SECONDS = 1.5
_CONNECT_TIMEOUT_SECONDS = 0.05


def probe_comfy(url: str, client: httpx.Client) -> bool:
    """True iff `url` answers `GET /system_stats` like a real ComfyUI."""
    try:
        r = client.get(url.rstrip("/") + "/system_stats", timeout=_PROBE_TIMEOUT_SECONDS)
        if r.status_code != 200:
            return False
        body = r.json()
    except Exception:
        return False
    system = body.get("system") if isinstance(body, dict) else None
    return isinstance(system, dict) and "comfyui_version" in system


def _open_ports(host: str, ports: tuple[int, ...]) -> list[int]:
    """TCP-connect scan: which of `ports` accept a connection on `host`."""

    def check(port: int) -> int | None:
        try:
            with socket.create_connection((host, port), timeout=_CONNECT_TIMEOUT_SECONDS):
                return port
        except OSError:
            return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=64) as pool:
        return sorted(p for p in pool.map(check, ports) if p is not None)


def find_comfy_url(
    client: httpx.Client,
    host: str = "127.0.0.1",
    candidates: tuple[int, ...] | None = None,
    sweep: tuple[int, ...] | None = None,
) -> str | None:
    """Locate a local ComfyUI: well-known ports first, then a sweep.

    `candidates`/`sweep` default to the module constants at CALL time (not
    def time), so tests can monkeypatch `DEFAULT_PORT_CANDIDATES`/
    `SWEEP_PORTS` and callers pick the patched values up.
    """
    if candidates is None:
        candidates = DEFAULT_PORT_CANDIDATES
    if sweep is None:
        sweep = SWEEP_PORTS
    for port in candidates:
        url = f"http://{host}:{port}"
        if probe_comfy(url, client):
            return url

    remaining = tuple(p for p in sweep if p not in candidates)
    for port in _open_ports(host, remaining):
        url = f"http://{host}:{port}"
        if probe_comfy(url, client):
            return url
    return None


def detect_dirs(url: str, client: httpx.Client) -> dict[str, str]:
    """Derive models/output/input dirs from `/internal/folder_paths`.

    Returns any subset of {"models_dir", "comfy_output_dir",
    "comfy_input_dir"} it could establish (paths verified to exist); an
    older ComfyUI without the endpoint, or one whose paths do not resolve
    locally, simply yields fewer keys -- never an exception.
    """
    try:
        r = client.get(
            url.rstrip("/") + "/internal/folder_paths", timeout=_PROBE_TIMEOUT_SECONDS
        )
        if r.status_code != 200:
            return {}
        folder_paths = r.json()
    except Exception:
        return {}
    if not isinstance(folder_paths, dict):
        return {}

    detected: dict[str, str] = {}

    checkpoints = folder_paths.get("checkpoints")
    if isinstance(checkpoints, list):
        for entry in checkpoints:
            if isinstance(entry, str) and os.path.isdir(entry):
                detected["models_dir"] = os.path.dirname(os.path.normpath(entry))
                break

    # The ACTUAL output directory has an authoritative marker: ComfyUI adds
    # `<output>/<category>` (e.g. `<output>/checkpoints`) to some category
    # search paths, so an entry whose parent folder is literally named
    # "output" reveals the real configured output dir -- more reliable than
    # guessing from install-root siblings (live-caught: a desktop install
    # had a stale `<shared>/output` next to the shared models library that
    # a sibling-existence guess picked over the real one).
    for entries in folder_paths.values():
        if not isinstance(entries, list):
            continue
        for entry in entries:
            if not isinstance(entry, str):
                continue
            parent = os.path.dirname(os.path.normpath(entry))
            if os.path.basename(parent).lower() == "output" and os.path.isdir(parent):
                detected["comfy_output_dir"] = parent
                in_dir = os.path.join(os.path.dirname(parent), "input")
                if os.path.isdir(in_dir):
                    detected["comfy_input_dir"] = in_dir
                break
        if "comfy_output_dir" in detected:
            break

    if "comfy_output_dir" not in detected:
        # Fallback (older ComfyUI without the output marker): the first
        # `<base>/models/<category>` base whose output/ and input/ siblings
        # both exist.
        seen_bases: list[str] = []
        for entries in folder_paths.values():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, str):
                    continue
                parent = os.path.dirname(os.path.normpath(entry))
                if os.path.basename(parent).lower() != "models":
                    continue
                base = os.path.dirname(parent)
                if base not in seen_bases:
                    seen_bases.append(base)
        for base in seen_bases:
            out_dir = os.path.join(base, "output")
            in_dir = os.path.join(base, "input")
            if os.path.isdir(out_dir) and os.path.isdir(in_dir):
                detected["comfy_output_dir"] = out_dir
                detected["comfy_input_dir"] = in_dir
                break

    return detected


def apply_detection(cfg, client: httpx.Client, default_comfy_url: str) -> list[str]:
    """Fill missing/defaulted fields on `cfg` from a detected ComfyUI.

    Mutates `cfg` in place and returns human-readable notes (one per filled
    field, empty when nothing was needed or nothing was found). Values the
    user set explicitly are never touched: `comfy_url` is only replaced
    when it is still the library default AND that default does not answer
    the fingerprint; the three directory fields only when currently unset.
    """
    notes: list[str] = []

    comfy_url = cfg.comfy_url
    if not probe_comfy(comfy_url, client):
        if comfy_url != default_comfy_url:
            # A hand-set URL that does not answer right now is the user's
            # call (ComfyUI may simply not be running yet) -- leave it.
            return notes
        found = find_comfy_url(client)
        if found is None:
            return notes
        cfg.comfy_url = comfy_url = found
        notes.append(f"comfy_url -> {found} (auto-detected)")

    missing = [
        field
        for field in ("models_dir", "comfy_output_dir", "comfy_input_dir")
        if getattr(cfg, field) is None
    ]
    if missing:
        detected = detect_dirs(comfy_url, client)
        for field in missing:
            value = detected.get(field)
            if value:
                setattr(cfg, field, value)
                notes.append(f"{field} -> {value} (auto-detected)")

    return notes
