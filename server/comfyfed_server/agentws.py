"""Authenticated agent WebSocket channel.

Handles the challenge/response handshake, the agent->server hello/heartbeat/
inventory/job_done/job_failed messages, server->agent job push, and the
background loop that requeues stale jobs and dispatches queued work to idle
connections.

Agent -> server message contract (all JSON):

  {"type": "hello", "hardware": {...}, "backend": str, "torch_version": str,
   "node_classes": [str]}
  {"type": "heartbeat", "state": "idle"|"busy", "progress": float,
   "job_id": str|null, "dynamic": {...}, "object_info_hash": str|null,
   "stage": "fetching_models"|absent, "fetch_pct": float|absent,
   "fetch_model": str|absent}
      -- `object_info_hash` is the agent's current sha256 of its local
         ComfyUI's canonical `/object_info` (see comfyfed_agent.comfy). When
         it doesn't match `Worker.object_info_hash`, or the platform's stored
         snapshot file is missing, the server replies over this same socket
         with `{"type": "want_object_info"}` to trigger a resend.
      -- `stage`/`fetch_pct`/`fetch_model` (Phase 2.1 Task 5 agents) are
         present while the agent is downloading a missing model before
         running the job it was pushed (see the `job` push's `fetch_models`
         below). Stored transiently in `_fetch_progress`, NOT persisted on
         the Job row, and relayed to the panel as extra fields on the normal
         `progress` event (`panelws.job_progress`) -- see that function.
  {"type": "inventory", "models": [{"name": str, "size": float,
   "size_bytes": int|absent, "sha256": str|absent}]}
      -- `size` is the model file size in GIGABYTES (not bytes); the server
         compares it against VRAM and free-disk figures that are also in GB.
         `sha256` (Phase 2.1 Task 1 agents) is present once the agent has
         hashed the file; `size_bytes` (same agents) is the file's EXACT
         `os.stat().st_size`, additive alongside `size`. Both are fed into
         `model_manifest.record_hash` for every entry that carries a
         `sha256` -- see `_record_model_hashes`, which falls back to
         reconstructing size_bytes from the rounded `size` when an entry
         has a `sha256` but no `size_bytes` (an agent that hashes but
         predates the exact field).
  {"type": "job_done", "job_id": str, "result_files": [str],
   "exec_seconds": float|null}
      -- `exec_seconds` is the agent's measurement of actual GPU execution
         time (from `comfyfed_agent.comfy.run_workflow`), excluding time the
         prompt spent merely queued on the worker. The receipt's billed
         `gpu_seconds` is `min(exec_seconds, wall_clock)`, falling back to
         the wall clock (`finished_at - started_at`) when this is missing or
         invalid -- see `_create_and_push_receipt`.
  {"type": "job_failed", "job_id": str, "error": str, "exec_seconds": float|null}
      -- `exec_seconds` mirrors job_done's: the agent's measured GPU
         execution time, present only when the prompt actually started
         (omitted/null otherwise). Mints a non-billable `kind=failed`
         receipt -- see `_create_and_push_failure_receipt`.
  {"type": "receipt_ack", "receipt_id": str, "worker_sig": hex}

Server -> agent job push (`{"type": "job", "job_id", "workflow_json",
"input_assets", "fetch_models"}`, sent from `dispatch_tick`) gains
`fetch_models` -- the manifest entries (`model_manifest.entries()` shape:
name/directory/url/backup_url/sha256/size_bytes/sig) for this job's missing
models -- ONLY when the pushed worker's verdict for this job was
`eligible_after_fetch`; omitted entirely otherwise (a directly-eligible push
carries no such key, same wire shape as before Task 4). Never sent to a
protocol < 3 connection -- `assess._eligible_after_fetch` already gates that
verdict kind on `protocol >= 3`, so this is enforced twice: once by the
verdict a worker had to earn to be dispatched at all, and defensively again
right before the push (see `_fetch_models_for_push`).

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

from . import assess, db, dispatch, metrics, model_manifest, panelws, security, workers

logger = logging.getLogger(__name__)

_AUTH_TIMEOUT_SECONDS = 10
_TICK_INTERVAL_SECONDS = 5
_CLOSE_UNAUTHORIZED = 4401

# Minimum `hello.protocol` that guarantees exec_seconds on job_done/job_failed
# (when the run started) and understands `job_cancelled` pushes. Below this,
# the agent is still fully served (backward compat) but gets a one-time
# deprecation notice and never a job_cancelled frame it couldn't act on.
_CURRENT_PROTOCOL = 2

_DEPRECATION_MESSAGE = (
    "agent 版本過舊：無法接收取消通知，計費將以整體耗時（wall-clock）為準。"
    "請更新 comfyfed-agent。/ Agent is outdated: cannot receive cancellation "
    "notices; billing falls back to wall-clock. Please update comfyfed-agent."
)

# Set by create_router(data_dir); used to sign job_done receipts.
_signing_key: Optional[SigningKey] = None

# Set by create_router(data_dir); used to check for a worker's stored
# object_info file when a heartbeat reports drift (see _handle_heartbeat).
_data_dir: Optional[str] = None

# job_id -> {"stage": "fetching_models", "fetch_pct": float, "fetch_model": str}
# for a job currently in the pre-run model-download phase (Phase 2.1 Task 5's
# agent side). Deliberately NOT a Job column: this is live, second-by-second
# state for exactly as long as an agent is downloading, same "transient,
# in-memory, per-process" shape as model_manifest's poisoned-name set --
# there is nothing here worth surviving a server restart (a fresh heartbeat
# repopulates it within one tick). `jobs._job_dict` reads it via
# `get_fetch_progress` to add the stage fields to the console's job payload
# "when present" (see task-4-brief.md); cleared on every transition that
# ends or restarts a job's lifecycle so a stale stage never lingers after the
# fetch (or the job) is actually over.
_fetch_progress: dict[str, dict] = {}


def get_fetch_progress(job_id: str) -> Optional[dict]:
    """Current fetch-stage progress for `job_id`, or None outside that phase."""
    return _fetch_progress.get(job_id)


def _clear_fetch_progress(job_id: str) -> None:
    _fetch_progress.pop(job_id, None)


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
    # Agent protocol version from `hello.protocol`, defaulting to 1 (never
    # sent a hello, or an old agent that doesn't send the field at all) --
    # see `_handle_hello` and `_send_job_cancelled`.
    protocol: int = 1
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
            await _handle_hello(worker_id, conn, message)
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
                _clear_fetch_progress(job_id)
                await panelws.job_failed(job_id, error)
                exec_seconds = message.get("exec_seconds")
                if not _is_valid_exec_seconds(exec_seconds):
                    exec_seconds = None
                await _create_and_push_failure_receipt(worker_id, conn, job_id, exec_seconds)
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
    if conn.protocol < _CURRENT_PROTOCOL:
        # A protocol-1 agent doesn't understand this message type -- sending
        # it would only earn a rate-limited "unknown message type" warning on
        # its side. Skip silently; it already got the deprecation notice.
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

    The job's `cancelled` status is already committed by `dispatch.cancel_job`
    before any of the notification steps below run, so a failure in either
    the agent push or the panel notify must not stop the other, and must
    never cost the cancelled receipt: each of the three is isolated in its
    own try/except (logged at WARNING, matching `_handle_receipt_ack`'s
    pattern), and the receipt mint happens independently of the (possibly
    slow, possibly failing) cross-loop agent push rather than after it.
    """
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        cancellable = job is not None and not dispatch.is_terminal(job.status)
        # Snapshot before cancel_job flips status/clears worker_id: a
        # cancelled receipt is only ever minted for a job that was actually
        # RUNNING (started_at set) -- a queued or merely-assigned cancel
        # never burned GPU time, so it stays receipt-free.
        was_running = cancellable and job.status == "running" and job.started_at is not None
    if not cancellable:
        return False

    owner = dispatch.cancel_job(job_id, reason=reason)
    _clear_fetch_progress(job_id)

    if was_running and owner:
        try:
            await _mint_cancelled_receipt(owner, job_id)
        except Exception:
            logger.warning(
                "agentws: failed to mint cancelled receipt for job %s owner %s", job_id, owner, exc_info=True
            )

    if owner:
        try:
            await push_job_cancelled(owner, job_id)
        except Exception:
            logger.warning(
                "agentws: failed to push job_cancelled for job %s owner %s", job_id, owner, exc_info=True
            )

    try:
        await panelws.job_cancelled(job_id)
    except Exception:
        logger.warning("agentws: panelws.job_cancelled failed for job %s", job_id, exc_info=True)

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
        _clear_fetch_progress(job_id)
        await _notify_panel_job_done(job_id)
        exec_seconds = message.get("exec_seconds")
        if not _is_valid_exec_seconds(exec_seconds):
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


def _parse_protocol(message: dict) -> int:
    """Validate `hello.protocol`, defaulting to 1 (the version before this
    field existed) for anything missing or malformed -- a stray string or
    negative number must degrade to "treat as old agent", not crash hello
    handling."""
    protocol = message.get("protocol")
    if not isinstance(protocol, int) or isinstance(protocol, bool) or protocol < 1:
        return 1
    return protocol


async def _handle_hello(worker_id: str, conn: "_Connection", message: dict) -> None:
    protocol = _parse_protocol(message)
    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return
        worker.hardware = json.dumps(message.get("hardware") or {})
        worker.backend = message.get("backend") or ""
        worker.torch_version = message.get("torch_version") or ""
        worker.node_classes = json.dumps(message.get("node_classes") or [])
        worker.protocol = protocol
        # Agent-side opt-in for manifest-based model auto-fetch (Phase 2.1
        # Task 1's hello `auto_fetch` field; gate consumed by
        # `assess.verdict`'s eligible_after_fetch check). Missing/non-bool
        # degrades to False -- an old or malformed hello must never be read
        # as consent to download.
        worker.auto_fetch = message.get("auto_fetch") is True
        worker.status = "online"
        worker.last_seen = _utcnow()
        session.commit()

    conn.protocol = protocol
    if protocol < _CURRENT_PROTOCOL:
        try:
            await conn.ws.send_json({"type": "deprecation", "message": _DEPRECATION_MESSAGE})
        except Exception:
            logger.exception(
                "agentws: failed to send deprecation notice to worker %s", worker_id
            )


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
                progress_reported = isinstance(progress, (int, float))
                if progress_reported:
                    job.progress = float(progress)
                    session.commit()

                # Phase 2.1 Task 4/5: an agent downloading a missing model
                # before it can run the job reports stage="fetching_models"
                # alongside its usual progress. Stored transiently (see
                # `_fetch_progress`'s docstring) rather than as a Job column,
                # and cleared the moment a heartbeat stops reporting it (the
                # download finished, or this is an older agent that never
                # sends it at all).
                if message.get("stage") == "fetching_models":
                    fetch_pct = message.get("fetch_pct")
                    fetch_model = message.get("fetch_model")
                    _fetch_progress[job_id] = {
                        "stage": "fetching_models",
                        "fetch_pct": float(fetch_pct)
                        if isinstance(fetch_pct, (int, float)) and not isinstance(fetch_pct, bool)
                        else None,
                        "fetch_model": fetch_model if isinstance(fetch_model, str) else None,
                    }
                else:
                    _clear_fetch_progress(job_id)

                fetch_fields = _fetch_progress.get(job_id, {})
                if progress_reported or fetch_fields:
                    await panelws.job_progress(job_id, job.progress, **fetch_fields)
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
    # logs for a foreign job_id still fires on the first such heartbeat.
    # Repeats for the same (connection, job id) are rate-limited to DEBUG via
    # resolve_warn_level/_resolve_warn_level, so a stale agent heartbeating
    # every ~30s for the rest of the run doesn't spam WARNING lines for it.
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
    models = _normalize_models(message.get("models") or [])

    with db.get_session() as session:
        worker = session.get(db.Worker, worker_id)
        if worker is None:
            return
        worker.model_inventory = json.dumps(models)
        session.commit()

    _record_model_hashes(worker_id, models)


def _record_model_hashes(worker_id: str, models: list) -> None:
    """Learn a sha256 for every inventory entry that carries one (Phase 2.1
    Task 1 agents; older agents send none). Cheap skip for entries without
    it -- see `model_manifest.record_hash` for the consensus/conflict rule.

    `size_bytes` is preferred when the entry carries it (an exact
    `os.stat().st_size` from `hardware.scan_models` -- see its docstring):
    the signed fetch-manifest trust payload must pin the real byte length,
    not an approximation. Entries from an agent that hashes but predates
    the exact `size_bytes` field fall back to reconstructing it from the
    rounded-to-3-decimal-places GB `size` -- lossy (~1 MB resolution), kept
    only so those agents' reports aren't dropped outright.
    """
    for entry in models:
        sha256 = entry.get("sha256")
        if not isinstance(sha256, str) or not sha256:
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue

        size_bytes = entry.get("size_bytes")
        if isinstance(size_bytes, int) and not isinstance(size_bytes, bool) and size_bytes > 0:
            exact_size_bytes = size_bytes
        else:
            size = entry.get("size")
            if not isinstance(size, (int, float)) or isinstance(size, bool):
                continue
            # Fallback for agents that hash but don't yet report exact
            # size_bytes: reconstruct from the rounded GB figure.
            exact_size_bytes = round(size * (1024 ** 3))

        model_manifest.record_hash(worker_id, name, exact_size_bytes, sha256)


def _sign_and_store_receipt(
    session, job_id: str, worker_id: str, gpu_seconds: float, *, kind: str, billable: bool, basis: str
):
    """Sign `f"{job_id}|{worker_id}|{gpu_seconds:.1f}"` (the wire payload
    format worker verifiers pin -- UNCHANGED by this task) and store a
    Receipt row for it. `kind`/`billable`/`basis` ride only in the row and
    the outbound WS frame's extra fields (see `_push_receipt_frame`); old
    agents that only ever look at `payload`/`platform_sig` are unaffected.

    Returns `(receipt_id, payload, platform_sig)` for the caller to push.
    """
    payload = f"{job_id}|{worker_id}|{gpu_seconds:.1f}"
    platform_sig = _signing_key.sign(payload.encode()).signature.hex()

    receipt = db.Receipt(
        job_id=job_id,
        worker_id=worker_id,
        gpu_seconds=gpu_seconds,
        platform_sig=platform_sig,
        kind=kind,
        billable=billable,
        basis=basis,
    )
    session.add(receipt)
    session.commit()
    return receipt.id, payload, platform_sig


async def _send_receipt_frame(conn: "_Connection", receipt_id: str, frame: dict) -> None:
    """Actually send `frame` over `conn`'s socket, swallowing (and logging)
    any failure -- the receipt row is already committed by the time this
    runs, so a send failure here just means the push is missed, not that
    anything about the receipt itself needs to be undone. Split out from
    `_push_receipt_frame` so it can be handed to `run_coroutine_threadsafe`
    as a plain coroutine when the caller is on a different event loop than
    the one `conn` was accepted on (see `_push_receipt_frame`).
    """
    try:
        await conn.ws.send_json(frame)
    except Exception:
        logger.exception("agentws: failed to push receipt %s to worker %s", receipt_id, conn.worker_id)


async def _push_receipt_frame(
    worker_id: str,
    receipt_id: str,
    payload: str,
    platform_sig: str,
    *,
    kind: str,
    billable: bool,
    basis: str,
    conn: Optional["_Connection"] = None,
) -> None:
    """Push a `receipt` frame to `worker_id`'s live connection, if any.

    `conn` is passed when the caller already has the connection that just
    sent the message being answered (job_done/job_failed); otherwise (a
    cancel triggered from an HTTP request, where the owning worker may well
    be offline right now) the live connection registry is consulted instead.
    A worker with no live connection at mint time is not an error: the
    receipt row is already committed by the caller, `worker_sig` stays NULL,
    and the worker's next `receipt_ack` -- whenever it reconnects -- can
    never arrive for a frame it was never sent, so nothing here needs to
    replay it; the report simply shows it as unacked in the meantime.

    Mirrors `push_job_cancelled`'s cross-event-loop handling: the cancel
    entry points (the admin cancel API, `/comfy/api/interrupt`,
    `/comfy/api/queue`) can run on a different event loop than the one the
    target connection was accepted on (routine under `TestClient`, and for
    any future worker-thread caller) -- awaiting `conn.ws.send_json`
    directly in that case doesn't raise cleanly, it hangs or fails against
    the wrong loop's internals, and the bare `except Exception` around the
    send would then quietly eat that failure, leaving the worker never
    counter-signing a receipt it was never actually sent. Scheduling the
    send on the connection's own loop via `run_coroutine_threadsafe` avoids
    that entirely; the job_done/job_failed callers that pass `conn` directly
    are always already running on that connection's own loop (the message
    that triggered them was received there), so this is a no-op check for
    them, not a behavior change.
    """
    target = conn or _connections.get(worker_id)
    if target is None:
        logger.info(
            "agentws: worker %s not connected, deferring receipt %s push (kind=%s)",
            worker_id, receipt_id, kind,
        )
        return

    frame = {
        "type": "receipt",
        "receipt_id": receipt_id,
        "payload": payload,
        "platform_sig": platform_sig,
        "kind": kind,
        "billable": billable,
        "basis": basis,
    }

    current = asyncio.get_running_loop()
    if target.loop is current:
        await _send_receipt_frame(target, receipt_id, frame)
    else:
        asyncio.run_coroutine_threadsafe(
            _send_receipt_frame(target, receipt_id, frame), target.loop
        ).result(timeout=5)


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

        if _is_valid_exec_seconds(exec_seconds):
            gpu_seconds = min(exec_seconds, wall_seconds)
            basis = "exec"
        else:
            gpu_seconds = wall_seconds
            basis = "wall"
            if conn.protocol >= _CURRENT_PROTOCOL and job.started_at is not None:
                # A protocol-2 agent guarantees exec_seconds once the run
                # started (Task 5) -- missing it here is the agent breaking
                # its own contract, not a routine fallback.
                logger.error(
                    "agentws: protocol violation: job %s from worker %s (protocol %s) "
                    "has no valid exec_seconds despite having started; "
                    "billing the wall-clock span instead",
                    job_id,
                    worker_id,
                    conn.protocol,
                )
            else:
                logger.info(
                    "agentws: job %s has no valid exec_seconds from worker %s, "
                    "billing the wall-clock span instead",
                    job_id,
                    worker_id,
                )

        gpu_seconds = max(0.0, gpu_seconds)

        receipt_id, payload, platform_sig = _sign_and_store_receipt(
            session, job_id, worker_id, gpu_seconds, kind="completed", billable=True, basis=basis
        )

    await _push_receipt_frame(
        worker_id, receipt_id, payload, platform_sig,
        kind="completed", billable=True, basis=basis, conn=conn,
    )


def _is_valid_exec_seconds(exec_seconds) -> bool:
    """Whether `exec_seconds` is a real, non-negative, finite number.

    Shared by the completed and failed receipt paths -- both fall back to a
    wall-clock basis under the exact same invalidity conditions (missing,
    wrong type, `NaN`/`Infinity`, or negative).
    """
    return (
        exec_seconds is not None
        and isinstance(exec_seconds, (int, float))
        and not isinstance(exec_seconds, bool)
        and math.isfinite(exec_seconds)
        and exec_seconds >= 0
    )


async def _create_and_push_failure_receipt(
    worker_id: str, conn: "_Connection", job_id: Optional[str], exec_seconds: Optional[float] = None
) -> None:
    """Mint a non-billable `kind=failed` receipt for a job the worker just
    reported `job_failed` for, and push it for counter-signature exactly
    like a completed receipt.

    `gpu_seconds` is `exec_seconds` when the agent measured the prompt
    actually starting (basis="exec"), else the wall-clock span from
    `started_at` (set by `mark_running`) to now -- `mark_failed` has already
    stamped `finished_at` by the time this runs, so that's the span used
    (basis="wall"). A job that never started (failed while still merely
    `assigned`) has no `started_at` to measure from at all; that is
    genuinely zero measured GPU time, not a missing measurement.

    When both `started_at` and `finished_at` are set, an `exec_seconds`
    basis is still capped at that wall-clock span -- same rationale as the
    completed-receipt path: a worker cannot bill more than it was observably
    busy for this job, and this is `unbilled_gpu_seconds` in the
    contributions report, a capacity/health number an agent bug (or a
    hostile agent) should not be able to inflate without bound just because
    this receipt happens to be non-billable.
    """
    if not job_id or _signing_key is None:
        return

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return

        if _is_valid_exec_seconds(exec_seconds) and job.started_at is not None:
            # A job that never started has no run to have measured -- an
            # exec_seconds claim for it is meaningless, so it falls through to
            # the wall branch below (which measures 0.0 for started_at=None).
            gpu_seconds = exec_seconds
            if job.finished_at is not None:
                gpu_seconds = min(gpu_seconds, (job.finished_at - job.started_at).total_seconds())
            basis = "exec"
        else:
            wall_seconds = 0.0
            if job.started_at is not None:
                end = job.finished_at or _utcnow()
                wall_seconds = (end - job.started_at).total_seconds()
                if conn.protocol >= _CURRENT_PROTOCOL:
                    logger.error(
                        "agentws: protocol violation: job %s from worker %s (protocol %s) "
                        "has no valid exec_seconds despite having started; "
                        "billing the wall-clock span instead",
                        job_id,
                        worker_id,
                        conn.protocol,
                    )
            gpu_seconds = wall_seconds
            basis = "wall"

        gpu_seconds = max(0.0, gpu_seconds)

        receipt_id, payload, platform_sig = _sign_and_store_receipt(
            session, job_id, worker_id, gpu_seconds, kind="failed", billable=False, basis=basis
        )

    await _push_receipt_frame(
        worker_id, receipt_id, payload, platform_sig,
        kind="failed", billable=False, basis=basis, conn=conn,
    )


async def _mint_cancelled_receipt(worker_id: str, job_id: str) -> None:
    """Mint a non-billable `kind=cancelled` receipt for a job that was
    cancelled while genuinely running (`started_at` set).

    The single hook every cancel entry point (the admin cancel API, and the
    ComfyUI-compat `/interrupt` and `/queue` delete/clear handlers) shares,
    by virtue of all three funnelling through `cancel_and_notify` -- so the
    mint happens exactly once regardless of which one fired. Unlike the
    job_done/job_failed mints, there is no live-message `conn` to reuse
    here: an admin can cancel a job whose worker is offline right now, so
    `_push_receipt_frame` looks the connection up itself and defers
    gracefully when there isn't one (see its docstring) -- the row is still
    written, just unacked until the worker reconnects and this receipt_id
    happens to be re-delivered some other way, or is simply reported as
    unacked (Phase 1.9 Task 5 scope: no replay-on-reconnect for it).
    """
    if _signing_key is None:
        return

    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None or job.started_at is None:
            return

        end = job.finished_at or _utcnow()
        gpu_seconds = max(0.0, (end - job.started_at).total_seconds())

        receipt_id, payload, platform_sig = _sign_and_store_receipt(
            session, job_id, worker_id, gpu_seconds, kind="cancelled", billable=False, basis="wall"
        )

    await _push_receipt_frame(
        worker_id, receipt_id, payload, platform_sig,
        kind="cancelled", billable=False, basis="wall",
    )


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


def _fetch_models_for_push(
    job: db.Job,
    worker: db.Worker,
    fetchable_models: dict[str, int],
    manifest_by_name: dict[str, dict],
) -> list[dict]:
    """The `fetch_models` manifest entries to embed in this job's push to
    `worker`, or `[]` when nothing needs fetching.

    `fetchable_models` (name -> size_bytes) is what `assess.verdict` takes;
    `manifest_by_name` (name -> full manifest entry, same names) is what
    actually gets embedded in the push once a name is confirmed missing.
    Both are compiled once per `dispatch_tick`, not per push.

    Recomputes `assess.verdict` for this exact (job, worker) pair rather than
    threading the winning candidate's missing-model list through
    `dispatch.assign_jobs`'s return value -- a deliberate choice (see
    `assign_jobs`'s docstring): that function keeps its original
    `(worker_id, job)` tuple shape, which a lot of existing tests already
    unpack, and re-running `verdict` once per push is cheap (the same gates
    `assign_jobs` just ran a moment ago for this exact candidate). `[]` is
    passed for `all_workers` -- `verdict` doesn't actually use that parameter
    (kept only for other assessment call sites, see its docstring).
    """
    if not fetchable_models:
        return []

    try:
        requirements_override = json.loads(job.requirements or "{}")
    except (TypeError, ValueError):
        requirements_override = {}

    needs = assess.needs_from_job(job)
    v = assess.verdict(worker, needs, requirements_override, [], fetchable_models)
    if v.kind != "eligible_after_fetch":
        return []

    # Defensive: `eligible_after_fetch` already requires protocol >= 3 (see
    # assess._eligible_after_fetch) -- an agent that predates fetch_models
    # entirely must never receive this key. This should be unreachable; if
    # it ever fires, that gate has regressed, so it's logged loudly rather
    # than silently sent.
    protocol = getattr(worker, "protocol", None)
    if not isinstance(protocol, int) or isinstance(protocol, bool) or protocol < 3:
        logger.error(
            "agentws: refusing to push fetch_models to worker %s (protocol=%r) for job %s "
            "-- eligible_after_fetch verdict should be unreachable below protocol 3",
            worker.id, protocol, job.id,
        )
        return []

    return [manifest_by_name[name] for name in v.missing_models if name in manifest_by_name]


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
                _clear_fetch_progress(job_id)
                await panelws.job_requeued(job_id)
            await panelws.job_status_refresh()
        except Exception:
            logger.exception("agentws: failed to relay requeued jobs to the panel")

    # Compiled ONCE per sweep, not per candidate/job: `fetchable_models`
    # (name -> size_bytes) feeds `assess.verdict` inside `assign_jobs`'s
    # ranking AND the per-push recompute below; `manifest_by_name` (name ->
    # full signed entry) is what actually gets embedded in a `fetch_models`
    # push once a name is confirmed missing. `_data_dir` unset (no router
    # registered -- practically only in ad-hoc tests) degrades to "nothing
    # fetchable", identical to Task 3's default.
    fetchable_models: dict[str, int] = {}
    manifest_by_name: dict[str, dict] = {}
    if _data_dir is not None:
        try:
            manifest_entries = model_manifest.entries(_data_dir)
            fetchable_models = {e["name"]: e["size_bytes"] for e in manifest_entries}
            manifest_by_name = {e["name"]: e for e in manifest_entries}
        except Exception:
            logger.exception("agentws: failed to build fetch manifest for dispatch tick")

    idle_worker_ids = [worker_id for worker_id, conn in _connections.items() if conn.state == "idle"]
    try:
        assignments = dispatch.assign_jobs(idle_worker_ids, fetchable_models)
    except Exception:
        logger.exception("agentws: assign_jobs failed")
        assignments = []

    for worker_id, job in assignments:
        conn = _connections.get(worker_id)
        if conn is None:
            continue
        try:
            frame = {
                "type": "job",
                "job_id": job.id,
                "workflow_json": job.workflow_json,
                "input_assets": json.loads(job.input_assets or "[]"),
            }
            if fetchable_models:
                with db.get_session() as session:
                    worker = session.get(db.Worker, worker_id)
                if worker is not None:
                    fetch_models = _fetch_models_for_push(
                        job, worker, fetchable_models, manifest_by_name
                    )
                    if fetch_models:
                        frame["fetch_models"] = fetch_models
            await conn.ws.send_json(frame)
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
