"""Authenticated agent WebSocket channel.

Handles the challenge/response handshake, the agent->server hello/heartbeat/
inventory/job_done/job_failed messages, server->agent job push, and the
background loop that requeues stale jobs and dispatches queued work to idle
connections.

Agent -> server message contract (all JSON):

  {"type": "hello", "hardware": {...}, "backend": str, "torch_version": str,
   "node_classes": [str]}
  {"type": "heartbeat", "state": "idle"|"busy", "progress": float,
   "job_id": str|null, "dynamic": {...}}
  {"type": "inventory", "models": [{"name": str, "size": float}]}
      -- `size` is the model file size in GIGABYTES (not bytes); the server
         compares it against VRAM and free-disk figures that are also in GB.
  {"type": "job_done", "job_id": str, "result_files": [str]}
  {"type": "job_failed", "job_id": str, "error": str}
  {"type": "receipt_ack", "receipt_id": str, "worker_sig": hex}

A `job_id` in any of these is only acted on when the authenticated worker
actually owns that job (see dispatch._owned_job).
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
from nacl.signing import SigningKey, VerifyKey

from . import db, dispatch, metrics, security

logger = logging.getLogger(__name__)

_AUTH_TIMEOUT_SECONDS = 10
_TICK_INTERVAL_SECONDS = 5
_CLOSE_UNAUTHORIZED = 4401

# Set by create_router(data_dir); used to sign job_done receipts.
_signing_key: Optional[SigningKey] = None


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


def create_router(data_dir: str) -> APIRouter:
    global _signing_key
    _signing_key, _ = security.load_platform_keys(data_dir)

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
            _record_reconnect(worker_id)
            await websocket.send_json({"type": "ready"})
            while True:
                message = await websocket.receive_json()
                await _handle_message(worker_id, conn, message)
        except WebSocketDisconnect:
            pass
        finally:
            _connections.pop(worker_id, None)

    return r


def _record_reconnect(worker_id: str) -> None:
    """Increment ws_reconnects_total for this worker. Best-effort: metrics
    must never break the WS dispatch path, so any failure (DB hiccup, metrics
    not initialized, etc.) is logged and swallowed rather than propagated."""
    try:
        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            worker_name = worker.name if worker is not None else worker_id
        metrics.get_metrics().ws_reconnects_total.labels(worker=worker_name).inc()
    except Exception:
        logger.exception("agentws: failed to record ws_reconnects_total for worker %s", worker_id)


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
            job_id = message.get("job_id")
            # A receipt is only ever written for a transition we actually
            # applied, so a worker cannot mint contribution records for jobs
            # it does not own by sending someone else's job_id.
            if dispatch.mark_done(job_id, worker_id, message.get("result_files") or []):
                await _create_and_push_receipt(worker_id, conn, job_id)
        elif msg_type == "job_failed":
            dispatch.mark_failed(message.get("job_id"), worker_id, message.get("error") or "")
        elif msg_type == "receipt_ack":
            _handle_receipt_ack(worker_id, message)
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

    dynamic = message.get("dynamic") or {}
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return
        worker.last_seen = _utcnow()
        if state == "idle":
            worker.status = "online"
        elif state == "busy":
            worker.status = "busy"
        worker.dynamic = json.dumps(dynamic)
        worker_name = worker.name
        session.commit()

        job_id = message.get("job_id")
        if job_id:
            job = session.get(db.Job, job_id)
            if job is not None and job.worker_id == worker_id:
                progress = message.get("progress")
                if isinstance(progress, (int, float)):
                    job.progress = float(progress)
                    session.commit()

    # The agent broadcasts a busy heartbeat carrying the job_id the moment it
    # picks the job up (see agent runner.handle_job), and that is the only
    # signal the server gets that execution actually started -- so this is
    # where "assigned" becomes "running" (and started_at gets set, which the
    # job_done receipt's gpu_seconds is computed from). Ownership and status
    # are gated inside dispatch.mark_running.
    if state == "busy" and message.get("job_id"):
        dispatch.mark_running(message["job_id"], worker_id)

    try:
        m = metrics.get_metrics()
        m.worker_up.labels(worker=worker_name).set(1)
        m.set_worker_dynamic(worker_name, dynamic)
    except Exception:
        logger.exception("agentws: failed to update heartbeat metrics for worker %s", worker_id)


# A single model file larger than this many GB is not plausible; a "size"
# that big is an old agent still reporting raw bytes (see _normalize_models).
_MAX_PLAUSIBLE_MODEL_GB = 10000


def _normalize_models(models) -> list:
    """Normalize an `inventory` message's model list to the wire contract.

    Contract: `{"type": "inventory", "models": [{"name": str, "size": GB}]}` --
    `size` is the file size in **gigabytes** (float, 3 dp), not bytes. The
    server's VRAM estimate and free-disk checks all work in GB, so a byte-scale
    number would inflate an estimate by ~10^9 and make every worker ineligible.

    Agents older than this contract sent bytes. Rather than trusting the
    version handshake, any size above `_MAX_PLAUSIBLE_MODEL_GB` is treated as
    bytes and converted -- no real single model file is 10000 GB, while a
    byte-scale value for even a 1 MB file exceeds it.
    """
    if not isinstance(models, list):
        return []

    normalized = []
    for entry in models:
        if not isinstance(entry, dict):
            continue
        size = entry.get("size")
        if isinstance(size, (int, float)) and not isinstance(size, bool):
            if size > _MAX_PLAUSIBLE_MODEL_GB:
                entry = {**entry, "size": round(size / (1024 ** 3), 3)}
        normalized.append(entry)
    return normalized


def _handle_inventory(worker_id: str, message: dict) -> None:
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return
        worker.model_inventory = json.dumps(_normalize_models(message.get("models") or []))
        session.commit()


async def _create_and_push_receipt(worker_id: str, conn: "_Connection", job_id: Optional[str]) -> None:
    """Create a platform-signed Receipt for a just-completed job and push it
    to the worker over its live connection, for the worker to counter-sign
    via a `receipt_ack` message."""
    if not job_id or _signing_key is None:
        return

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return
        gpu_seconds = 0.0
        if job.started_at is not None and job.finished_at is not None:
            gpu_seconds = (job.finished_at - job.started_at).total_seconds()

        payload = f"{job_id}|{worker_id}|{gpu_seconds:.1f}"
        platform_sig = _signing_key.sign(payload.encode()).signature.hex()

        receipt = db.Receipt(
            job_id=job_id,
            worker_id=worker_id,
            gpu_seconds=gpu_seconds,
            platform_sig=platform_sig,
        )
        session.add(receipt)
        session.commit()
        receipt_id = receipt.id

    try:
        await conn.ws.send_json(
            {
                "type": "receipt",
                "receipt_id": receipt_id,
                "payload": payload,
                "platform_sig": platform_sig,
            }
        )
    except Exception:
        logger.exception("agentws: failed to push receipt %s to worker %s", receipt_id, worker_id)


def _handle_receipt_ack(worker_id: str, message: dict) -> None:
    receipt_id = message.get("receipt_id")
    worker_sig = message.get("worker_sig")
    if not isinstance(receipt_id, str) or not isinstance(worker_sig, str):
        return

    with db.get_session() as session:
        receipt = session.get(db.Receipt, receipt_id)
        if receipt is None or receipt.worker_id != worker_id:
            logger.warning("agentws: receipt_ack for unknown/foreign receipt %s from worker %s", receipt_id, worker_id)
            return

        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return

        payload = f"{receipt.job_id}|{receipt.worker_id}|{receipt.gpu_seconds:.1f}"
        try:
            VerifyKey(bytes.fromhex(worker.pubkey)).verify(payload.encode(), bytes.fromhex(worker_sig))
        except (BadSignatureError, ValueError):
            logger.warning("agentws: invalid receipt_ack signature for receipt %s from worker %s", receipt_id, worker_id)
            return

        receipt.worker_sig = worker_sig
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
