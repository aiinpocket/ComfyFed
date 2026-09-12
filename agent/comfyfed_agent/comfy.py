"""Minimal ComfyUI HTTP client: object_info, input upload, workflow execution."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Callable, Optional

import httpx

_POLL_INTERVAL_SECONDS = 1.0

# Progress ramp bounds (see `_estimate_progress`).
_PROGRESS_FLOOR = 0.1
_PROGRESS_CEILING = 0.9
_DEFAULT_EXPECTED_SECONDS = 120.0
_MIN_EXPECTED_SECONDS = 30.0


class ComfyError(Exception):
    """Raised when ComfyUI reports a /prompt submission or execution error."""


def _client_or_new(client: Optional[httpx.Client]) -> tuple[httpx.Client, bool]:
    if client is not None:
        return client, False
    return httpx.Client(timeout=30.0), True


def get_object_info(comfy_url: str, client: Optional[httpx.Client] = None) -> dict:
    """GET ComfyUI's /object_info: a dict keyed by every installed node class."""
    c, owns = _client_or_new(client)
    try:
        resp = c.get(f"{comfy_url.rstrip('/')}/object_info")
        resp.raise_for_status()
        return resp.json()
    finally:
        if owns:
            c.close()


def canonical_object_info_bytes(object_info: dict) -> bytes:
    """Canonical UTF-8 JSON encoding of an `/object_info` payload.

    Sorted keys and compact separators so the same object_info always
    serializes to the exact same bytes -- this is what gets sha256'd and
    gzipped for `POST /api/agent/object_info`, and what the server's
    `X-OI-Hash` check must be able to reproduce independently.
    """
    return json.dumps(object_info, sort_keys=True, separators=(",", ":")).encode("utf-8")


def object_info_hash(payload: bytes) -> str:
    """sha256 hex digest of a canonical object_info payload."""
    return hashlib.sha256(payload).hexdigest()


def upload_input(
    comfy_url: str, filename: str, content: bytes, client: Optional[httpx.Client] = None
) -> None:
    """POST a job's input asset into ComfyUI's local input directory (overwrite=true)."""
    c, owns = _client_or_new(client)
    try:
        resp = c.post(
            f"{comfy_url.rstrip('/')}/upload/image",
            files={"image": (filename, content)},
            data={"overwrite": "true"},
        )
        resp.raise_for_status()
    finally:
        if owns:
            c.close()


def _estimate_progress(elapsed_seconds: float, expected_seconds: float) -> float:
    """Elapsed-time progress estimate, clamped to [0.1, 0.9].

    ComfyUI's HTTP API exposes no per-step progress for a queued prompt (that
    only comes over its own WebSocket), so this is a deliberate ESTIMATE, not
    a measurement: a monotonic ramp from 0.1 toward 0.9 that reaches the
    ceiling at `expected_seconds` and stays there until the run really ends.
    It exists so the console shows a bar that moves; only `on_progress(1.0)`
    at completion is authoritative.
    """
    span = max(expected_seconds, _MIN_EXPECTED_SECONDS)
    ramp = (elapsed_seconds / span) * (_PROGRESS_CEILING - _PROGRESS_FLOOR)
    return min(_PROGRESS_FLOOR + ramp, _PROGRESS_CEILING)


def _is_prompt_active(comfy_url: str, prompt_id: str, client: httpx.Client) -> bool:
    """Whether ComfyUI's /queue still lists `prompt_id` as running or pending.

    Best-effort: a /queue that errors or returns an unexpected shape is
    reported as active, since the history poll (not this) decides completion.
    """
    try:
        resp = client.get(f"{comfy_url.rstrip('/')}/queue")
        resp.raise_for_status()
        body = resp.json()
    except Exception:
        return True

    for key in ("queue_running", "queue_pending"):
        for item in body.get(key) or []:
            # Queue entries are positional arrays: [number, prompt_id, ...].
            if isinstance(item, (list, tuple)) and prompt_id in item:
                return True
    return False


def run_workflow(
    comfy_url: str,
    workflow: dict,
    on_progress: Optional[Callable[[float], None]] = None,
    client: Optional[httpx.Client] = None,
    expected_seconds: float = _DEFAULT_EXPECTED_SECONDS,
) -> list[tuple[str, bytes]]:
    """Submit `workflow` to ComfyUI, poll until done, and return its output files.

    Returns a list of (filename, content) tuples for every image/gif/video
    output produced by the run. Raises `ComfyError` on a /prompt submission
    error (node_errors, a top-level error, or a non-2xx response) or when the
    finished history entry reports `status.status_str == "error"`.

    `on_progress` receives an ESTIMATE while the prompt is in ComfyUI's queue
    (see `_estimate_progress`) -- an elapsed-time ramp toward 0.9, sized by
    `expected_seconds` (default 120s). Only the final `on_progress(1.0)`
    reflects real completion.
    """
    c, owns = _client_or_new(client)
    try:
        client_id = str(uuid.uuid4())
        resp = c.post(
            f"{comfy_url.rstrip('/')}/prompt",
            json={"prompt": workflow, "client_id": client_id},
        )
        try:
            body = resp.json()
        except ValueError:
            body = {}

        if resp.status_code >= 400 or body.get("node_errors") or body.get("error"):
            raise ComfyError(f"ComfyUI /prompt submission failed: {body}")

        prompt_id = body["prompt_id"]

        if on_progress is not None:
            on_progress(0.0)

        started_at = time.monotonic()
        history_entry = None
        while history_entry is None:
            hist_resp = c.get(f"{comfy_url.rstrip('/')}/history/{prompt_id}")
            hist_resp.raise_for_status()
            history = hist_resp.json()
            if prompt_id in history:
                history_entry = history[prompt_id]
                break
            if on_progress is not None:
                elapsed = time.monotonic() - started_at
                if _is_prompt_active(comfy_url, prompt_id, c):
                    on_progress(_estimate_progress(elapsed, expected_seconds))
                else:
                    # Off the queue but not yet in history: it is finishing up
                    # (writing outputs), so sit at the ceiling.
                    on_progress(_PROGRESS_CEILING)
            time.sleep(_POLL_INTERVAL_SECONDS)

        status = history_entry.get("status") or {}
        if status.get("status_str") == "error":
            raise ComfyError(f"ComfyUI job execution failed: {status}")

        if on_progress is not None:
            on_progress(1.0)

        results: list[tuple[str, bytes]] = []
        outputs = history_entry.get("outputs") or {}
        for node_output in outputs.values():
            for key in ("images", "gifs", "videos"):
                for item in node_output.get(key, []) or []:
                    params = {
                        "filename": item["filename"],
                        "subfolder": item.get("subfolder", ""),
                        "type": item.get("type", "output"),
                    }
                    view_resp = c.get(f"{comfy_url.rstrip('/')}/view", params=params)
                    view_resp.raise_for_status()
                    results.append((item["filename"], view_resp.content))
        return results
    finally:
        if owns:
            c.close()
