"""Pub/sub broadcaster relaying federation job events to ComfyUI-frontend panel
clients connected over `/comfy/api/ws`.

Federation job lifecycle events (progress heartbeats, running/done/failed
transitions) originate in `agentws.py`'s agent-socket handlers. Rather than
agentws knowing anything about panel connections, it calls the small,
named functions here (`job_progress`, `job_running`, `job_done`,
`job_failed`, `job_requeued`) right after it applies each transition; those
functions build the ComfyUI-shaped `{"type", "data"}` envelope and fan it out
to every connected panel client via `post_event`.

Everything public that broadcasts is a coroutine and must be awaited: the
callers are already coroutines on the very loop the panel sockets live on, so
blocking that loop to schedule work onto itself would deadlock (see
`post_event`).

Every public function here is defensive: a broadcast failure (a dead socket,
a serialization error, no event loop) must never propagate out and break the
agent-socket handler that triggered it, so everything is caught and logged.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass

from fastapi import WebSocket

from . import db

logger = logging.getLogger(__name__)

# The node id federation job events report -- ComfyFed jobs are opaque units
# dispatched to a single worker, not executed node-by-node like upstream
# ComfyUI, so there is no real per-node id to report while a job is running.
_RUNNING_NODE_LABEL = "comfyfed"


@dataclass
class _PanelConnection:
    ws: WebSocket
    loop: asyncio.AbstractEventLoop


# sid -> live connection. Module-level, mirroring agentws._connections.
_connections: dict[str, _PanelConnection] = {}


def register(ws: WebSocket) -> str:
    """Register a newly-accepted panel WebSocket. Returns its sid."""
    sid = uuid.uuid4().hex
    _connections[sid] = _PanelConnection(ws=ws, loop=asyncio.get_running_loop())
    return sid


def unregister(sid: str) -> None:
    _connections.pop(sid, None)


def clear() -> None:
    """Drop all registered connections (test helper, mirrors comfyapi's cache clear)."""
    _connections.clear()


_QUEUE_REMAINING_STATUSES = ("queued", "assigned", "running")


# Sent once, right after the initial `status` message, on every panel
# connection. All false is the truthful answer for every one of these --
# ComfyFed has no asset browser, no node-replacement suggestions, no sign-in
# button (single admin, cookie session only), and the pinned frontend's
# manager-v4/CSRF-POST UI has nothing on this server to talk to. Sending them
# unprompted (rather than only in response to `GET /features`, which upstream
# also exposes) matches what the stock frontend's own server does on connect,
# and avoids the frontend falling back to feature-detection guesses.
FEATURE_FLAGS: dict = {
    "assets": False,
    "node_replacements": False,
    "show_signin_button": False,
    "extension.manager.supports_v4": False,
    "extension.manager.supports_csrf_post": False,
}


def queue_status() -> dict:
    """Build the `status.exec_info` payload for the initial/refreshed `status` message.

    `queue_remaining` matches upstream's `get_tasks_remaining()`
    (`len(queue) + len(currently_running)`, execution.py): queued jobs PLUS
    ones already picked up but not finished, i.e. exactly the statuses
    `GET /comfy/api/queue` splits into `queue_pending` (comfyapi's
    `_PENDING_STATUSES`) and `queue_running` (`_RUNNING_STATUSES`). Not
    queued-only -- a job mid-execution is still "remaining" work upstream.
    """
    with db.get_session() as session:
        remaining = (
            session.query(db.Job)
            .filter(db.Job.status.in_(_QUEUE_REMAINING_STATUSES))
            .count()
        )
    return {"exec_info": {"queue_remaining": remaining}}


_CROSS_LOOP_TIMEOUT_SECONDS = 5


async def post_event(evt: dict) -> None:
    """Broadcast a `{"type", "data"}` envelope to every connected panel client.

    A coroutine, and deliberately so. The events this relays all originate in
    `agentws`'s agent-socket handlers, which are coroutines running on the
    *same* uvicorn event loop the panel sockets live on. An earlier version
    scheduled the broadcast with `run_coroutine_threadsafe(...).result(5)`
    unconditionally; when the target loop IS the calling loop that is a
    guaranteed self-deadlock -- the loop is blocked inside `.result()` and can
    never run the coroutine it is waiting for, so every event burned the full
    5s timeout, delivered nothing, and froze the server (a `job_done` is three
    events = 15s). Awaiting `send_json` directly is both correct and ordered.

    `run_coroutine_threadsafe` is kept for the one case that genuinely needs
    it: a connection registered on a *different* loop in another thread (what
    `TestClient` produces, and what any future worker-thread caller would
    hit). That branch is chosen per connection by comparing the running loop
    with the loop captured at `register()` time.

    Never raises -- swallows and logs everything, including "no panel clients
    connected" (a no-op) and a dead event loop.
    """
    if not _connections:
        return

    current = asyncio.get_running_loop()
    for sid, conn in list(_connections.items()):
        try:
            if conn.loop is current:
                await conn.ws.send_json(evt)
            else:
                asyncio.run_coroutine_threadsafe(conn.ws.send_json(evt), conn.loop).result(
                    timeout=_CROSS_LOOP_TIMEOUT_SECONDS
                )
        except Exception:
            logger.exception("panelws: failed to deliver event to panel client %s", sid)
            _connections.pop(sid, None)


async def job_progress(job_id: str, progress: float) -> None:
    await post_event(
        {
            "type": "progress",
            "data": {"value": int(progress * 100), "max": 100, "prompt_id": job_id},
        }
    )


async def job_running(job_id: str) -> None:
    await post_event(
        {
            "type": "executing",
            "data": {
                "node": _RUNNING_NODE_LABEL,
                "prompt_id": job_id,
                # Upstream's `executing` payload always carries display_node
                # alongside node (execution.py); the pinned frontend reads it
                # for gallery/preview routing, so send both here too.
                "display_node": _RUNNING_NODE_LABEL,
            },
        }
    )


async def job_status_refresh() -> None:
    """Push a fresh `status` message (the queue badge's source of truth).

    Emitted after any transition that changes how many jobs are outstanding
    but is not itself a `job_done` -- a failure, or a requeue after a worker
    went stale -- so the panel's badge does not stay stuck on a count that no
    longer exists.
    """
    await post_event({"type": "status", "data": {"status": queue_status()}})


async def job_requeued(job_id: str) -> None:
    """Tell the panel a job it thought was executing is back in the queue.

    `dispatch.requeue_stale` moves a dead worker's running job back to
    `queued`; without this the panel keeps showing it as the executing prompt
    forever, because the only other thing that clears `executing` is a
    done/failed transition that will now never arrive for that attempt.
    """
    await post_event({"type": "executing", "data": {"node": None, "prompt_id": job_id}})


async def job_cancelled(job_id: str) -> None:
    """Tell the panel a job was cancelled -- admin API, native /interrupt, or
    a /queue delete/clear.

    ComfyUI's own protocol has no "cancelled" concept for the frontend to
    render, so this relays the same combination `job_requeued` uses: clear
    the executing marker for this job (a no-op if it wasn't the one showing
    as executing) and refresh the queue badge, which together are what stop
    the panel from believing a cancelled job is still queued or running.
    """
    await post_event({"type": "executing", "data": {"node": None, "prompt_id": job_id}})
    await job_status_refresh()


async def job_done(job: "db.Job") -> None:
    """Emit `executed` + the completion `executing` signal + a refreshed `status`.

    `outputs`/`node` are computed by `comfyapi.job_outputs`, the same helper
    `GET /history` uses, so a done job's outputs can never drift between the
    two surfaces. Imported lazily to avoid a module-import cycle (comfyapi
    imports this module to serve `/comfy/api/ws`).
    """
    from . import comfyapi

    outputs = comfyapi.job_outputs(job)
    node = next(iter(outputs), comfyapi.FALLBACK_OUTPUT_KEY)

    await post_event(
        {
            "type": "executed",
            "data": {
                "prompt_id": job.id,
                "output": outputs,
                "node": node,
                # Same value as "node" -- ComfyFed jobs have no distinct
                # real/display node id, but upstream's shape always carries
                # both (execution.py), and the pinned frontend may read
                # display_node for gallery routing.
                "display_node": node,
            },
        }
    )
    await post_event({"type": "executing", "data": {"node": None, "prompt_id": job.id}})
    await post_event({"type": "status", "data": {"status": queue_status()}})


async def job_failed(job_id: str, error: str) -> None:
    """Emit `execution_error` and then a refreshed `status`.

    The status refresh matters for the same reason it does in `job_done`: a
    failed job leaves the queue, and without a fresh `exec_info` the panel's
    queue badge keeps counting it.
    """
    await post_event(
        {
            "type": "execution_error",
            "data": {
                "prompt_id": job_id,
                "node_id": None,
                "node_type": None,
                "exception_message": error,
                "exception_type": "",
                "traceback": [],
                "current_inputs": {},
                "current_outputs": {},
                "executed": [],
            },
        }
    )
    await job_status_refresh()
