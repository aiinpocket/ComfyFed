"""Minimal ComfyUI HTTP client: object_info, input upload, workflow execution."""

from __future__ import annotations

import time
import uuid
from typing import Callable, Optional

import httpx

_POLL_INTERVAL_SECONDS = 1.0


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


def run_workflow(
    comfy_url: str,
    workflow: dict,
    on_progress: Optional[Callable[[float], None]] = None,
    client: Optional[httpx.Client] = None,
) -> list[tuple[str, bytes]]:
    """Submit `workflow` to ComfyUI, poll until done, and return its output files.

    Returns a list of (filename, content) tuples for every image/gif/video
    output produced by the run. Raises `ComfyError` on a /prompt submission
    error (node_errors, a top-level error, or a non-2xx response) or when the
    finished history entry reports `status.status_str == "error"`.
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

        history_entry = None
        while history_entry is None:
            hist_resp = c.get(f"{comfy_url.rstrip('/')}/history/{prompt_id}")
            hist_resp.raise_for_status()
            history = hist_resp.json()
            if prompt_id in history:
                history_entry = history[prompt_id]
                break
            if on_progress is not None:
                on_progress(0.5)
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
