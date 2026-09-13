"""Authenticated agent WebSocket channel.

Handles the challenge/response handshake, the agent->server hello/heartbeat/
inventory/job_done/job_failed messages, server->agent job push, and the
background loop that requeues stale jobs and dispatches queued work to idle
connections.

Agent -> server message contract (all JSON):

  {"type": "hello", "hardware": {...}, "backend": str, "torch_version": str,
   "node_classes": [str]}
  {"type": "heartbeat", "state": "idle"|"busy", "progress": float,
   "job_id": str|null, "dynamic": {...}, "object_info_hash": str|null}
      -- `object_info_hash` is the agent's current sha256 of its local
         ComfyUI's canonical `/object_info` (see comfyfed_agent.comfy). When
         it doesn't match `Worker.object_info_hash`, or the platform's stored
         snapshot file is missing, the server replies over this same socket
         with `{"type": "want_object_info"}` to trigger a resend.
  {"type": "inventory", "models": [{"name": str, "size": float}]}
      -- `size` is the model file size in GIGABYTES (not bytes); the server
         compares it against VRAM and free-disk figures that are also in GB.
  {"type": "job_done", "job_id": str, "result_files": [str],
   "exec_seconds": float|null}
      -- `exec_seconds` is the agent's measurement of actual GPU execution
         time (from `comfyfed_agent.comfy.run_workflow`), excluding time the
         prompt spent merely queued on the worker. The receipt's billed
         `gpu_seconds` is `min(exec_seconds, wall_clock)`, falling back to
         the wall clock (`finished_at - started_at`) when this is missing or
         invalid -- see `_create_and_push_receipt`.
  {"type": "job_failed", "job_id": str, "error": str}
  {"type": "receipt_ack", "receipt_id": str, "worker_sig": hex}

Server -> agent also includes `{"type": "want_object_info"}` (see above); the
full object_info payload itself travels out-of-band over a signed HTTP POST
(`/api/agent/object_info` in workers.py), not this socket. It also includes
`{"type": "job_cancelled", "job_id": str}`, pushed whenever this connection
references a job it no longer owns -- a job someone else now owns, or one
requeued out from under it that a blip re-adoption (see dispatch.try_readopt)
didn't restore -- so the agent can abort a run it has no business finishing.
Sent at most once per job per connection (see `_send_job_cancelled`).

A `job_id` in any of these is only acted on when the authenticated worker
actually owns that job (see dispatch._owned_job).
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import os
import secrets
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey

from . import db, dispatch, metrics, panelws, security, workers

logger = logging.getLogger(__name__)

_AUTH_TIMEOUT_SECONDS = 10
_TICK_INTERVAL_SECONDS = 5
_CLOSE_UNAUTHORIZED = 4401

# Set by create_router(data_dir); used to sign job_done receipts.
_signing_key: Optional[SigningKey] = None

# Set by create_router(data_dir); used to check for a worker's stored
# object_info file when a heartbeat reports drift (see _handle_heartbeat).
_data_dir: Optional[str] = None


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


# Cap for every per-connection dedup/rate-limit set below. A connection lives
# as long as the agent stays attached -- potentially days -- so anything keyed
# by job id or message type must be bounded or it grows for the connection's
# whole lifetime (see _BoundedSet).
_DEDUP_CAP = 512


class _BoundedSet:
    """A set capped at `cap` members, evicting the oldest on overflow.

    Backs `_Connection.cancelled_jobs_sent` (dedup for the `job_cancelled`
    push) and the warned-job-id/warned-message-type sets below (rate-limiting
    repeat WARNINGs) -- both need "have I seen this before", bounded so a
    connection that lives for days can't grow either without limit. Eviction
    only ever matters for `cancelled_jobs_sent`: an evicted-then-repeated job
    id there causes a rare duplicate `job_cancelled` push, which is harmless
    since the agent treats that push idempotently (it just aborts a run it
    was already told to abort). For the warn sets, an eviction merely means a
    very old job id/message type can re-earn a single WARNING -- exactly the
    behavior wanted, just triggered a message early.

    `OrderedDict` gives ordered keys for free; membership is never re-added
    once present (every call site checks `in` before `add`), so plain
    insertion-order (FIFO) eviction is equivalent to true LRU here -- no
    `move_to_end` needed.
    """

    def __init__(self, cap: int = _DEDUP_CAP):
        self._cap = cap
        self._items: "OrderedDict[object, None]" = OrderedDict()

    def __contains__(self, item) -> bool:
        return item in self._items

    def __iter__(self):
        return iter(self._items)

    def __len__(self) -> int:
        return len(self._items)

    def __eq__(self, other) -> bool:
        if isinstance(other, _BoundedSet):
            return set(self._items) == set(other._items)
        if isinstance(other, (set, frozenset)):
            return set(self._items) == other
        return NotImplemented

    def __repr__(self) -> str:
        return f"_BoundedSet({list(self._items)!r})"

    def add(self, item) -> None:
        if item in self._items:
            return
        self._items[item] = None
        if len(self._items) > self._cap:
            self._items.popitem(last=False)


@dataclass
class _Connection:
    ws: WebSocket
    worker_id: str
    loop: asyncio.AbstractEventLoop
    state: str = "idle"  # idle | busy | dispatched
    # job_ids this connection has already been sent `job_cancelled` for --
    # see `_send_job_cancelled`. Scoped to the connection instance itself, so
    # a reconnect naturally starts with a clean set. Bounded (see
    # `_BoundedSet`): an evicted-then-repeated job id merely risks a rare
    # duplicate push, which the agent treats idempotently.
    cancelled_jobs_sent: _BoundedSet = field(default_factory=_BoundedSet)
    # job_ids that have already earned a WARNING via `_resolve_warn_level`
    # for a not-owned/unknown/finished reference on this connection --
    # repeats log DEBUG instead. Separate from `cancelled_jobs_sent`: a job
    # can be referenced (and warned about) many times before or without ever
    # triggering a `job_cancelled` push.
    warned_job_ids: _BoundedSet = field(default_factory=_BoundedSet)
    # Message type names that have already earned a WARNING for being
    # unrecognized on this connection -- see `_handle_message`.
    warned_msg_types: _BoundedSet = field(default_factory=_BoundedSet)


# Module-level connection registry: worker_id -> live connection state.
_connections: dict[str, _Connection] = {}


def create_router(data_dir: str) -> APIRouter:
    global _signing_key, _data_dir
    _signing_key, _ = security.load_platform_keys(data_dir)
    _data_dir = data_dir

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
            # Only evict OUR OWN registration. A socket that dropped silently
            # can reach this line after the agent has already reconnected and
            # registered a new connection; popping by worker_id alone would
            # unregister the live one, leaving a worker that heartbeats fine
            # but is invisible to dispatch_tick and to push_job_cancelled --
            # which this branch makes load-bearing for cancellation delivery.
            if _connections.get(worker_id) is conn:
                del _connections[worker_id]

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


def _resolve_warn_level(conn: _Connection, job_id: Optional[str]) -> int:
    """WARNING the first time `job_id` earns a not-owned/unknown/finished
    reference on this connection (see `dispatch._owned_job`); DEBUG for every
    later one. Passed as `_owned_job`'s `resolve_warn_level` so the decision
    and the bookkeeping happen together, exactly at the three branches that
    would otherwise log an unconditional WARNING -- the already-DEBUG steady
    -state branches never call this at all, so they can't poison the set with
    a job id that was never actually warning-worthy.
    """
    if not job_id:
        return logging.WARNING
    if job_id in conn.warned_job_ids:
        return logging.DEBUG
    conn.warned_job_ids.add(job_id)
    return logging.WARNING


async def _handle_message(worker_id: str, conn: _Connection, message: dict) -> None:
    msg_type = message.get("type") if isinstance(message, dict) else None
    try:
        if msg_type == "hello":
            _handle_hello(worker_id, message)
        elif msg_type == "heartbeat":
            want_object_info = await _handle_heartbeat(worker_id, conn, message)
            if want_object_info:
                try:
                    await conn.ws.send_json({"type": "want_object_info"})
                except Exception:
                    logger.exception(
                        "agentws: failed to send want_object_info to worker %s", worker_id
                    )
        elif msg_type == "inventory":
            _handle_inventory(worker_id, message)
        elif msg_type == "job_done":
            await _handle_job_done(worker_id, conn, message)
        elif msg_type == "job_failed":
            job_id = message.get("job_id")
            error = message.get("error") or ""
            if dispatch.mark_failed(
                job_id, worker_id, error, resolve_warn_level=lambda jid: _resolve_warn_level(conn, jid)
            ):
                await panelws.job_failed(job_id, error)
            elif job_id and _job_not_owned_by(job_id, worker_id):
                await _send_job_cancelled(conn, job_id)
        elif msg_type == "receipt_ack":
            _handle_receipt_ack(worker_id, message)
        else:
            # Rate-limited the same way as job-id warnings above: a stale or
            # misbehaving agent that keeps sending the same bogus type would
            # otherwise put one WARNING per message in the log forever.
            key = msg_type if isinstance(msg_type, str) else repr(msg_type)
            level = logging.DEBUG if key in conn.warned_msg_types else logging.WARNING
            conn.warned_msg_types.add(key)
            logger.log(level, "agentws: unknown message type %r from worker %s", msg_type, worker_id)
    except Exception:
        logger.exception("agentws: error handling %r message from worker %s", msg_type, worker_id)


def _job_not_owned_by(job_id: Optional[str], worker_id: str) -> bool:
    """Read-only ownership check: is `job_id` currently *not* held by
    `worker_id` (someone else's, or unowned/unknown)?

    Used only to decide whether a failed transition deserves a
    `job_cancelled` push -- unlike `dispatch._owned_job`, this doesn't care
    about the job's status, only who (if anyone) currently holds it. A
    worker re-sending a message for its own already-terminal job (e.g. a
    duplicate `job_done`) must NOT get `job_cancelled`: it still owns that
    job, it's just too late -- so this returns False for it.
    """
    if not job_id:
        return False
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        return job is None or job.worker_id != worker_id


async def _send_job_cancelled(conn: "_Connection", job_id: Optional[str]) -> None:
    """Push `{"type": "job_cancelled", "job_id": job_id}` to `conn`, at most
    once per job for the lifetime of this connection.

    Without the dedup, a worker that keeps referencing a job it no longer
    owns -- it heartbeats every ~30s for the length of a run -- would get
    this pushed on every single message for as long as it kept doing so. The
    set lives on the `_Connection` itself, so a fresh connection (reconnect)
    naturally starts clean without any explicit clearing.

    The set is bounded (`_BoundedSet`, cap 512), so on a very long-lived
    connection an old job id can eventually be evicted and, if somehow
    referenced again, cause a second `job_cancelled` push for it. Harmless:
    the agent treats this push idempotently, simply aborting a run it was
    already told to abort.
    """
    if not job_id or job_id in conn.cancelled_jobs_sent:
        return
    conn.cancelled_jobs_sent.add(job_id)
    try:
        await conn.ws.send_json({"type": "job_cancelled", "job_id": job_id})
    except Exception:
        logger.exception(
            "agentws: failed to send job_cancelled to worker %s for job %s", conn.worker_id, job_id
        )


async def push_job_cancelled(worker_id: Optional[str], job_id: str) -> None:
    """Push `job_cancelled` to `worker_id`'s live connection, if any.

    Public entry point for callers outside the agent socket itself -- the
    admin cancel API and the ComfyUI-compat `/interrupt` and `/queue`
    (delete/clear) handlers -- that need to tell an owning agent its job was
    just cancelled out from under it. A no-op when `worker_id` is falsy (the
    job was never picked up) or that worker isn't currently connected.

    Mirrors `panelws.post_event`'s cross-event-loop handling: a caller
    running on a different loop than the one the connection was accepted on
    (as happens under `TestClient`, and would for any future worker-thread
    caller) is scheduled via `run_coroutine_threadsafe` rather than awaited
    directly, which would silently never run if the loops differed, or
    deadlock if `.result()` were called unconditionally on the same loop.
    """
    if not worker_id:
        return
    conn = _connections.get(worker_id)
    if conn is None:
        return
    current = asyncio.get_running_loop()
    if conn.loop is current:
        await _send_job_cancelled(conn, job_id)
    else:
        asyncio.run_coroutine_threadsafe(_send_job_cancelled(conn, job_id), conn.loop).result(
            timeout=5
        )


async def cancel_and_notify(job_id: str, *, reason: str) -> bool:
    """Cancel `job_id` if it is still cancellable, notifying whoever cares.

    Shared by the admin cancel API and the ComfyUI-compat `/interrupt` and
    `/queue` (delete/clear) handlers, so all three entry points can never
    drift on what "cancel this job" actually does to a live agent connection
    or the panel: the owning agent (if any) gets `job_cancelled` pushed over
    its live connection, and every connected panel client gets the
    `executing:null` + refreshed `status` combination `panelws.job_cancelled`
    sends.

    Returns whether anything actually happened. `dispatch.cancel_job`'s own
    return (the owning worker_id, or None) is ambiguous between "cancelled
    but nobody owned it yet" and "no-op: already terminal or unknown" -- a
    caller that only wants to notify on a REAL cancellation needs the two
    told apart, so eligibility is checked up front instead.
    """
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        cancellable = job is not None and not dispatch.is_terminal(job.status)
    if not cancellable:
        return False

    owner = dispatch.cancel_job(job_id, reason=reason)
    if owner:
        await push_job_cancelled(owner, job_id)
    await panelws.job_cancelled(job_id)
    return True


async def _handle_job_done(worker_id: str, conn: "_Connection", message: dict) -> None:
    """Handle a `job_done` message, including blip re-adoption.

    A receipt is only ever written for a transition we actually applied, so
    a worker cannot mint contribution records for jobs it does not own by
    sending someone else's job_id.

    When the straightforward `mark_done` fails because this worker doesn't
    currently own the job, that's not necessarily forgery -- it's exactly
    what a worker that blipped offline mid-run looks like: `requeue_stale`
    put the job back to `queued` and recorded `last_worker_id`, and this
    `job_done` is that same worker coming back with the (possibly genuine)
    result. `try_readopt` tells the two cases apart: on success, ownership is
    restored and completion proceeds exactly as if it had never blipped. On
    failure -- someone else's job now, or plain unknown -- the message is
    rejected and the worker is told via `job_cancelled` so it stops chasing a
    job that isn't its to finish.
    """
    job_id = message.get("job_id")
    result_files = message.get("result_files") or []

    def _resolve(jid: Optional[str]) -> int:
        return _resolve_warn_level(conn, jid)

    done = dispatch.mark_done(job_id, worker_id, result_files, resolve_warn_level=_resolve)
    if not done and job_id and _job_not_owned_by(job_id, worker_id):
        if dispatch.try_readopt(job_id, worker_id):
            done = dispatch.mark_done(job_id, worker_id, result_files, resolve_warn_level=_resolve)
        else:
            await _send_job_cancelled(conn, job_id)

    if done:
        await _notify_panel_job_done(job_id)
        exec_seconds = message.get("exec_seconds")
        if (
            not isinstance(exec_seconds, (int, float))
            or isinstance(exec_seconds, bool)
            or not math.isfinite(exec_seconds)
        ):
            exec_seconds = None
        await _create_and_push_receipt(worker_id, conn, job_id, exec_seconds)


async def _notify_panel_job_done(job_id: Optional[str]) -> None:
    """Fetch the just-finished job and hand it to `panelws.job_done`.

    A separate lookup rather than reusing the row `dispatch.mark_done`
    already touched: that call's session has already closed by the time it
    returns, and `job_outputs` needs `result_files`/`workflow_json` off a
    live row. Built and dispatched while the session is still open so nothing
    on `job` is accessed post-detach.
    """
    if not job_id:
        return
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return
        await panelws.job_done(job)


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


async def _handle_heartbeat(worker_id: str, conn: _Connection, message: dict) -> bool:
    """Apply a heartbeat's state to the worker row.

    Returns True when the platform should ask the agent to resend its full
    object_info: the heartbeat carries a hash that doesn't match what this
    worker has on record, or the stored snapshot file has gone missing.
    """
    state = message.get("state")
    if state in ("idle", "busy"):
        conn.state = state

    dynamic = message.get("dynamic") or {}
    job_id = message.get("job_id")
    job_not_owned = False
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return False
        worker.last_seen = _utcnow()
        if state == "idle":
            worker.status = "online"
        elif state == "busy":
            worker.status = "busy"
        worker.dynamic = json.dumps(dynamic)
        worker_name = worker.name
        stored_hash = worker.object_info_hash or ""
        session.commit()

        if job_id:
            job = session.get(db.Job, job_id)
            if job is not None and job.worker_id == worker_id:
                progress = message.get("progress")
                if isinstance(progress, (int, float)):
                    job.progress = float(progress)
                    session.commit()
                    await panelws.job_progress(job_id, job.progress)
            else:
                job_not_owned = True

    # A heartbeat carrying a job_id this worker doesn't (or no longer) own --
    # most commonly a stale agent still reporting a job that was requeued and
    # picked up by someone else. Told once per connection (dedup lives in
    # _send_job_cancelled) so the agent can abort instead of grinding away on
    # a run that will never be accepted.
    if job_not_owned:
        await _send_job_cancelled(conn, job_id)

    # The agent broadcasts a busy heartbeat carrying the job_id the moment it
    # picks the job up (see agent runner.handle_job), and that is the only
    # signal the server gets that execution actually started -- so this is
    # where "assigned" becomes "running" (and started_at gets set, which the
    # job_done receipt's gpu_seconds is computed from). Ownership and status
    # are gated inside dispatch.mark_running -- called unconditionally here
    # (even when job_not_owned already told us it'll fail) so the WARNING it
    # logs for a foreign job_id keeps firing on every such heartbeat, not
    # just the first.
    if state == "busy" and job_id:
        if dispatch.mark_running(
            job_id, worker_id, resolve_warn_level=lambda jid: _resolve_warn_level(conn, jid)
        ):
            await panelws.job_running(job_id)

    try:
        m = metrics.get_metrics()
        m.worker_up.labels(worker=worker_name).set(1)
        m.set_worker_dynamic(worker_name, dynamic)
    except Exception:
        logger.exception("agentws: failed to update heartbeat metrics for worker %s", worker_id)

    want_object_info = False
    reported_hash = message.get("object_info_hash")
    if isinstance(reported_hash, str) and reported_hash:
        try:
            has_file = _data_dir is not None and os.path.isfile(
                workers.object_info_path(_data_dir, worker_id)
            )
        except Exception:
            has_file = False
        if reported_hash != stored_hash or not has_file:
            want_object_info = True

    return want_object_info


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


async def _create_and_push_receipt(
    worker_id: str, conn: "_Connection", job_id: Optional[str], exec_seconds: Optional[float] = None
) -> None:
    """Create a platform-signed Receipt for a just-completed job and push it
    to the worker over its live connection, for the worker to counter-sign
    via a `receipt_ack` message.

    Billing uses `exec_seconds` -- the agent's own measurement of actual GPU
    execution time (see `comfyfed_agent.comfy.run_workflow`), not the wall
    clock between "assigned" and "done" -- because a worker can sit queued
    behind other work (ours or another platform's, on a worker shared across
    platforms) without burning any of *this* platform's GPU time. Billing
    queue-wait as GPU time would double-charge it to every platform a shared
    worker serves. `exec_seconds` is capped at the wall-clock span (a worker
    cannot bill more than it was observably busy for this job) and falls back
    to the wall clock entirely when missing or invalid (not a real number,
    negative, or non-finite -- `NaN`/`Infinity` survive `json.loads` as float
    literals, so they must be rejected explicitly rather than merely failing
    a `< 0` comparison, which `NaN` also slips past). The final value is
    clamped to zero so a negative wall clock (clock skew between `started_at`
    and `finished_at`) can never reach a signed receipt.
    """
    if not job_id or _signing_key is None:
        return

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return
        wall_seconds = 0.0
        if job.started_at is not None and job.finished_at is not None:
            wall_seconds = (job.finished_at - job.started_at).total_seconds()

        if (
            exec_seconds is None
            or not isinstance(exec_seconds, (int, float))
            or isinstance(exec_seconds, bool)
            or not math.isfinite(exec_seconds)
            or exec_seconds < 0
        ):
            gpu_seconds = wall_seconds
            logger.info(
                "agentws: job %s has no valid exec_seconds from worker %s, "
                "billing the wall-clock span instead",
                job_id,
                worker_id,
            )
        else:
            gpu_seconds = min(exec_seconds, wall_seconds)

        gpu_seconds = max(0.0, gpu_seconds)

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
    """One iteration of the background loop: requeue stale jobs, then collect
    every idle connection's worker id and hand the whole batch to
    `dispatch.assign_jobs` in one call, so it can rank workers against each
    other rather than assigning greedily connection-by-connection. Each
    (worker, job) pair it returns is then pushed on that worker's connection.
    Swallows and logs all exceptions so the caller (the background task, or a
    test) never sees a crash from a single bad connection or DB hiccup."""
    requeued: list[str] = []
    try:
        requeued = dispatch.requeue_stale(_utcnow())
    except Exception:
        logger.exception("agentws: requeue_stale failed")

    # A requeue is invisible from the panel's side otherwise: the frontend
    # still believes the job is executing, and the done/failed event that
    # would have cleared it is never coming for that attempt. Clear the
    # executing marker per job, then refresh the queue badge once.
    if requeued:
        try:
            for job_id in requeued:
                await panelws.job_requeued(job_id)
            await panelws.job_status_refresh()
        except Exception:
            logger.exception("agentws: failed to relay requeued jobs to the panel")

    idle_worker_ids = [worker_id for worker_id, conn in _connections.items() if conn.state == "idle"]
    try:
        assignments = dispatch.assign_jobs(idle_worker_ids)
    except Exception:
        logger.exception("agentws: assign_jobs failed")
        assignments = []

    for worker_id, job in assignments:
        conn = _connections.get(worker_id)
        if conn is None:
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
