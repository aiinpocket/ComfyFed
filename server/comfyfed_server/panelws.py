"""Pub/sub broadcaster relaying federation job events to ComfyUI-frontend panel
clients connected over `/comfy/api/ws`.

Federation job lifecycle events (progress heartbeats, running/done/failed
transitions) originate in `agentws.py`'s agent-socket handlers. Rather than
agentws knowing anything about panel connections, it calls the small,
named functions here (`job_progress`, `job_running`, `job_done`,
`job_failed`) right after it applies each transition; those functions build
the ComfyUI-shaped `{"type", "data"}` envelope and fan it out to every
connected panel client via `post_event`.

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


def queue_status() -> dict:
    """Build the `status.exec_info` payload for the initial/refreshed `status` message."""
    with db.get_session() as session:
        remaining = session.query(db.Job).filter(db.Job.status == "queued").count()
    return {"exec_info": {"queue_remaining": remaining}}


async def _broadcast(evt: dict) -> None:
    for sid, conn in list(_connections.items()):
        try:
            await conn.ws.send_json(evt)
        except Exception:
            logger.exception("panelws: failed to deliver event to panel client %s", sid)
            _connections.pop(sid, None)


def post_event(evt: dict) -> None:
    """Broadcast a `{"type", "data"}` envelope to every connected panel client.

    Callable from sync code (agentws's message handlers are not coroutines)
    regardless of whether it happens to run on the same event loop the panel
    sockets live on: it schedules the broadcast on that loop and blocks for
    its completion, the same cross-thread pattern `agentws.dispatch_once`
    uses. Never raises -- swallows and logs everything, including "no panel
    clients connected" (a no-op) and a dead event loop.
    """
    if not _connections:
        return
    loop = next(iter(_connections.values())).loop
    try:
        asyncio.run_coroutine_threadsafe(_broadcast(evt), loop).result(timeout=5)
    except Exception:
        logger.exception("panelws: failed to broadcast %r event", evt.get("type"))


def job_progress(job_id: str, progress: float) -> None:
    post_event(
        {
            "type": "progress",
            "data": {"value": int(progress * 100), "max": 100, "prompt_id": job_id},
        }
    )


def job_running(job_id: str) -> None:
    post_event(
        {"type": "executing", "data": {"node": _RUNNING_NODE_LABEL, "prompt_id": job_id}}
    )


def job_done(job: "db.Job") -> None:
    """Emit `executed` + the completion `executing` signal + a refreshed `status`.

    `outputs`/`node` are computed by `comfyapi.job_outputs`, the same helper
    `GET /history` uses, so a done job's outputs can never drift between the
    two surfaces. Imported lazily to avoid a module-import cycle (comfyapi
    imports this module to serve `/comfy/api/ws`).
    """
    from . import comfyapi

    outputs = comfyapi.job_outputs(job)
    node = next(iter(outputs), comfyapi.FALLBACK_OUTPUT_KEY)

    post_event(
        {"type": "executed", "data": {"prompt_id": job.id, "output": outputs, "node": node}}
    )
    post_event({"type": "executing", "data": {"node": None, "prompt_id": job.id}})
    post_event({"type": "status", "data": {"status": queue_status()}})


def job_failed(job_id: str, error: str) -> None:
    post_event(
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
            },
        }
    )
