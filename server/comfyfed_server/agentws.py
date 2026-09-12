"""Authenticated agent WebSocket channel.

Handles the challenge/response handshake, the agent->server hello/heartbeat/
inventory/job_done/job_failed messages, server->agent job push, and the
background loop that requeues stale jobs and dispatches queued work to idle
connections.
"""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey

from . import db, dispatch

logger = logging.getLogger(__name__)

_AUTH_TIMEOUT_SECONDS = 10
_TICK_INTERVAL_SECONDS = 5
_CLOSE_UNAUTHORIZED = 4401


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


@dataclass
class _Connection:
    ws: WebSocket
    worker_id: str
    loop: asyncio.AbstractEventLoop
    state: str = "idle"  # idle | busy | dispatched


# Module-level connection registry: worker_id -> live connection state.
_connections: dict[str, _Connection] = {}


def create_router() -> APIRouter:
    r = APIRouter()

    @r.websocket("/api/agent/ws")
    async def agent_ws(websocket: WebSocket) -> None:
        await websocket.accept()

        worker_id = await _handshake(websocket)
        if worker_id is None:
            return

        conn = _Connection(ws=websocket, worker_id=worker_id, loop=asyncio.get_running_loop())
        _connections[worker_id] = conn

        try:
            await websocket.send_json({"type": "ready"})
            while True:
                message = await websocket.receive_json()
                await _handle_message(worker_id, conn, message)
        except WebSocketDisconnect:
            pass
        finally:
            _connections.pop(worker_id, None)

    return r


async def _handshake(websocket: WebSocket) -> Optional[str]:
    """Challenge/response handshake. Returns the verified worker id, or None
    (having already closed the socket with code 4401) on any failure."""
    nonce = secrets.token_hex(16)
    await websocket.send_json({"type": "challenge", "nonce": nonce})

    try:
        auth_message = await asyncio.wait_for(websocket.receive_json(), timeout=_AUTH_TIMEOUT_SECONDS)
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        await _close_unauthorized(websocket)
        return None

    if not isinstance(auth_message, dict) or auth_message.get("type") != "auth":
        await _close_unauthorized(websocket)
        return None

    worker_id = auth_message.get("worker_id")
    sig = auth_message.get("sig")
    if not isinstance(worker_id, str) or not isinstance(sig, str):
        await _close_unauthorized(websocket)
        return None

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None or worker.disabled:
            await _close_unauthorized(websocket)
            return None

        try:
            VerifyKey(bytes.fromhex(worker.pubkey)).verify(nonce.encode(), bytes.fromhex(sig))
        except (BadSignatureError, ValueError):
            await _close_unauthorized(websocket)
            return None

    return worker_id


async def _close_unauthorized(websocket: WebSocket) -> None:
    try:
        await websocket.close(code=_CLOSE_UNAUTHORIZED)
    except Exception:
        pass


async def _handle_message(worker_id: str, conn: _Connection, message: dict) -> None:
    msg_type = message.get("type") if isinstance(message, dict) else None
    try:
        if msg_type == "hello":
            _handle_hello(worker_id, message)
        elif msg_type == "heartbeat":
            _handle_heartbeat(worker_id, conn, message)
        elif msg_type == "inventory":
            _handle_inventory(worker_id, message)
        elif msg_type == "job_done":
            dispatch.mark_done(message.get("job_id"), message.get("result_files") or [])
        elif msg_type == "job_failed":
            dispatch.mark_failed(message.get("job_id"), message.get("error") or "")
        else:
            logger.warning("agentws: unknown message type %r from worker %s", msg_type, worker_id)
    except Exception:
        logger.exception("agentws: error handling %r message from worker %s", msg_type, worker_id)


def _handle_hello(worker_id: str, message: dict) -> None:
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return
        worker.hardware = json.dumps(message.get("hardware") or {})
        worker.backend = message.get("backend") or ""
        worker.torch_version = message.get("torch_version") or ""
        worker.node_classes = json.dumps(message.get("node_classes") or [])
        worker.status = "online"
        worker.last_seen = _utcnow()
        session.commit()


def _handle_heartbeat(worker_id: str, conn: _Connection, message: dict) -> None:
    state = message.get("state")
    if state in ("idle", "busy"):
        conn.state = state

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return
        worker.last_seen = _utcnow()
        if state == "idle":
            worker.status = "online"
        elif state == "busy":
            worker.status = "busy"
        worker.dynamic = json.dumps(message.get("dynamic") or {})
        session.commit()

        job_id = message.get("job_id")
        if job_id:
            job = session.get(db.Job, job_id)
            if job is not None:
                progress = message.get("progress")
                if isinstance(progress, (int, float)):
                    job.progress = float(progress)
                    session.commit()


def _handle_inventory(worker_id: str, message: dict) -> None:
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return
        worker.model_inventory = json.dumps(message.get("models") or [])
        session.commit()


async def dispatch_tick() -> None:
    """One iteration of the background loop: requeue stale jobs, then push a
    queued job to every idle connection that has one available. Swallows and
    logs all exceptions so the caller (the background task, or a test) never
    sees a crash from a single bad connection or DB hiccup."""
    try:
        dispatch.requeue_stale(_utcnow())
    except Exception:
        logger.exception("agentws: requeue_stale failed")

    for worker_id, conn in list(_connections.items()):
        if conn.state != "idle":
            continue
        try:
            job = dispatch.pick_job_for(worker_id)
        except Exception:
            logger.exception("agentws: pick_job_for failed for worker %s", worker_id)
            continue
        if job is None:
            continue
        try:
            await conn.ws.send_json(
                {
                    "type": "job",
                    "job_id": job.id,
                    "workflow_json": job.workflow_json,
                    "input_assets": json.loads(job.input_assets or "[]"),
                }
            )
            # Presume busy until the next heartbeat says otherwise, so we
            # don't double-push before the agent has a chance to report in.
            conn.state = "dispatched"
        except Exception:
            logger.exception("agentws: failed to push job to worker %s", worker_id)


async def _background_loop() -> None:
    while True:
        try:
            await dispatch_tick()
        except Exception:
            logger.exception("agentws: background loop iteration failed")
        await asyncio.sleep(_TICK_INTERVAL_SECONDS)


def start_background_task() -> asyncio.Task:
    return asyncio.create_task(_background_loop())


def dispatch_once(worker_id: Optional[str] = None) -> None:
    """Synchronously run one `dispatch_tick` from outside the event loop.

    For tests (and any other sync caller) that can't await a coroutine
    directly: finds the asyncio loop a connected agent's websocket is running
    on (captured at handshake time) and schedules `dispatch_tick` there via
    `run_coroutine_threadsafe`, blocking until it completes. If `worker_id` is
    given, use that connection's loop; otherwise use any connected one. Falls
    back to a fresh event loop if nothing is connected.
    """
    loop: Optional[asyncio.AbstractEventLoop] = None
    if worker_id is not None:
        conn = _connections.get(worker_id)
        loop = conn.loop if conn else None
    else:
        loop = next((c.loop for c in _connections.values()), None)

    if loop is None:
        asyncio.run(dispatch_tick())
        return

    asyncio.run_coroutine_threadsafe(dispatch_tick(), loop).result(timeout=5)
