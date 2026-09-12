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


def _is_prompt_running(comfy_url: str, prompt_id: str, client: httpx.Client) -> bool:
    """Whether ComfyUI's /queue specifically lists `prompt_id` under
    `queue_running` right now -- i.e. GPU execution has actually started.

    Used only to timestamp billing's `exec_seconds`, so this is the opposite
    best-effort direction from `_is_prompt_active`: a /queue that errors or
    returns an unexpected shape reports NOT running, because billing must
    never guess a start time it did not actually observe.
    """
    try:
        resp = client.get(f"{comfy_url.rstrip('/')}/queue")
        resp.raise_for_status()
        body = resp.json()
    except Exception:
        return False

    for item in body.get("queue_running") or []:
        if isinstance(item, (list, tuple)) and prompt_id in item:
            return True
    return False


def run_workflow(
    comfy_url: str,
    workflow: dict,
    on_progress: Optional[Callable[[float], None]] = None,
    client: Optional[httpx.Client] = None,
    expected_seconds: float = _DEFAULT_EXPECTED_SECONDS,
) -> tuple[list[tuple[str, bytes, str]], Optional[float]]:
    """Submit `workflow` to ComfyUI, poll until done, and return its outputs.

    Returns `(files, exec_seconds)`: `files` is a list of
    (filename, content, subfolder) tuples for every image/gif/video output
    produced by the run. `subfolder` is ComfyUI's own subfolder for that
    output (often "") and is carried through so a caller can reconstruct the
    exact on-disk path ComfyUI itself used -- e.g. to clean up its output
    directory after the artifact is safely uploaded elsewhere.
    `exec_seconds` is the measured wall-clock span between the first moment
    this prompt was observed under ComfyUI's `/queue` `queue_running` (i.e.
    GPU execution actually started, as opposed to merely being queued behind
    other work -- ours or another platform's, on a worker shared across
    platforms) and completion. When that moment was never observed -- the run
    finished between polls, or `/queue` was unreachable -- it falls back to
    the span since the local `/prompt` POST: a strict upper bound on GPU time
    that is still measured wholly on this worker, so it excludes federation
    dispatch and input download. It is deliberately NOT `None` there: `None`
    makes the server bill its own `assigned -> done` wall clock, which puts
    the federation's queue wait back into the bill -- the exact thing this
    measurement exists to keep out. `None` is reserved for a run that is
    genuinely unmeasurable (an exception before submission).

    Raises `ComfyError` on a /prompt submission error (node_errors, a
    top-level error, or a non-2xx response) or when the finished history
    entry reports `status.status_str == "error"`.

    `on_progress` receives an ESTIMATE while the prompt is in ComfyUI's queue
    (see `_estimate_progress`) -- an elapsed-time ramp toward 0.9, sized by
    `expected_seconds` (default 120s). Only the final `on_progress(1.0)`
    reflects real completion.
    """
    c, owns = _client_or_new(client)
    try:
        client_id = str(uuid.uuid4())
        # Clock for the exec_seconds fallback: everything after this point is
        # local to this worker, so a span measured from here never includes
        # federation dispatch or input download.
        submitted_at = time.monotonic()
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
        exec_start: Optional[float] = None
        history_entry = None
        while history_entry is None:
            hist_resp = c.get(f"{comfy_url.rstrip('/')}/history/{prompt_id}")
            hist_resp.raise_for_status()
            history = hist_resp.json()
            if prompt_id in history:
                history_entry = history[prompt_id]
                break
            if exec_start is None and _is_prompt_running(comfy_url, prompt_id, c):
                exec_start = time.monotonic()
            if on_progress is not None:
                elapsed = time.monotonic() - started_at
                if _is_prompt_active(comfy_url, prompt_id, c):
                    on_progress(_estimate_progress(elapsed, expected_seconds))
                else:
                    # Off the queue but not yet in history: it is finishing up
                    # (writing outputs), so sit at the ceiling.
                    on_progress(_PROGRESS_CEILING)
            time.sleep(_POLL_INTERVAL_SECONDS)

        # Fall back to the span since the local /prompt POST when the running
        # window was never observed (a run that finished between polls, or a
        # /queue we could not reach). That is a strict upper bound on GPU
        # time, but it is measured entirely on this worker AFTER submission,
        # so it still excludes federation dispatch and input download -- which
        # is exactly what the server's own wall-clock fallback (assigned ->
        # done) would wrongly re-admit into the bill. `None` is reserved for
        # genuinely unmeasurable runs.
        exec_seconds = time.monotonic() - (exec_start if exec_start is not None else submitted_at)

        status = history_entry.get("status") or {}
        if status.get("status_str") == "error":
            raise ComfyError(f"ComfyUI job execution failed: {status}")

        if on_progress is not None:
            on_progress(1.0)

        results: list[tuple[str, bytes, str]] = []
        outputs = history_entry.get("outputs") or {}
        for node_output in outputs.values():
            for key in ("images", "gifs", "videos"):
                for item in node_output.get(key, []) or []:
                    subfolder = item.get("subfolder", "")
                    params = {
                        "filename": item["filename"],
                        "subfolder": subfolder,
                        "type": item.get("type", "output"),
                    }
                    view_resp = c.get(f"{comfy_url.rstrip('/')}/view", params=params)
                    view_resp.raise_for_status()
                    results.append((item["filename"], view_resp.content, subfolder))
        return results, exec_seconds
    finally:
        if owns:
            c.close()
