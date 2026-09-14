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
from typing import Optional

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
    # Phase 3.0 Task 4: the session uid this socket authenticated as, so
    # `post_event` can scope job-specific frames to this connection's own
    # jobs. `None` for a connection registered without going through the
    # real WS handshake -- only the same-loop test helpers in
    # `test_comfy_panel_ws.py` still do that -- which `_visible_to` treats
    # as "sees everything", exactly matching this module's pre-Task-4
    # behavior for those tests.
    uid: Optional[str] = None


# sid -> live connection. Module-level, mirroring agentws._connections.
_connections: dict[str, _PanelConnection] = {}


def register(ws: WebSocket, uid: Optional[str] = None) -> str:
    """Register a newly-accepted panel WebSocket. Returns its sid.

    `uid` is the resolved session user's id (`comfyapi.create_ws_router`'s
    handshake passes it); omitted by the handful of test helpers that
    register a connection directly without a real session.
    """
    sid = uuid.uuid4().hex
    _connections[sid] = _PanelConnection(ws=ws, loop=asyncio.get_running_loop(), uid=uid)
    return sid


def unregister(sid: str) -> None:
    _connections.pop(sid, None)


# WebSocket close code for a socket force-closed because its session_epoch
# was bumped out from under it -- distinct from `comfyapi._CLOSE_UNAUTHORIZED`
# (4401, an unauthenticated handshake) even though both are in the private
# range, since this one is a live, previously-authenticated connection being
# cut off, not a handshake ever being rejected.
_CLOSE_EPOCH_BUMPED = 4402


def close_for_uid(uid: str) -> None:
    """Synchronously close every registered panel WebSocket for `uid`.

    Final review finding #6: an open panel socket used to survive a
    session_epoch bump indefinitely -- the handshake resolves the session
    once and stores only the uid, with no re-check afterwards, so a user
    disabled (or password-reset, or self-changed) while their panel was open
    kept streaming job frames until the tab was closed on its own. Called
    from every epoch-bump call site (`auth.change_password`,
    `users.reset_password`, `users.patch_user`'s disable branch) right after
    the bump commits.

    Those call sites are synchronous request handlers, not coroutines, so
    this schedules the close on each matching connection's own captured loop
    (mirrors `agentws.dispatch_once`'s same sync-caller-into-async pattern)
    rather than awaiting directly. Never raises: a socket that is already
    gone, or whose close races the client's own disconnect, is exactly the
    outcome this function is trying to produce anyway.
    """
    for sid, conn in list(_connections.items()):
        if conn.uid != uid:
            continue
        try:
            asyncio.run_coroutine_threadsafe(
                conn.ws.close(code=_CLOSE_EPOCH_BUMPED), conn.loop
            ).result(timeout=_CROSS_LOOP_TIMEOUT_SECONDS)
        except Exception:
            logger.exception("panelws: failed to close panel socket %s for uid %s", sid, uid)
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


def _job_owner(job_id: Optional[str]) -> Optional[tuple[str, Optional[str]]]:
    """`(origin, user_id)` for `job_id`, or `None` if it doesn't (or no
    longer) exist. A one-off DB lookup -- the job-event callers below only
    ever have a bare `job_id`, not a live row, so there is nothing cheaper to
    read this off of without threading a row through every agentws call
    site."""
    if not job_id:
        return None
    with db.get_session() as session:
        job = session.get(db.Job, job_id)
        if job is None:
            return None
        return (job.origin, job.user_id)


def _visible_to(conn_uid: Optional[str], owner: tuple[str, Optional[str]]) -> bool:
    """Whether a job-scoped frame for `owner` (`(origin, user_id)`) should
    reach a connection whose session uid is `conn_uid`.

    Phase 3.0 Task 4: the panel is a per-user workspace, so a job-specific
    frame (`progress`/`executing`/`executed`/`execution_error`) must only
    ever reach the socket for the job's OWN panel origin and user -- same
    rule `comfyapi`'s REST routes apply, including for an admin socket.
    """
    if conn_uid is None:
        return True
    origin, user_id = owner
    return origin == "panel" and user_id == conn_uid


async def post_event(
    evt: dict, *, job_id: Optional[str] = None, job: Optional["db.Job"] = None
) -> None:
    """Broadcast a `{"type", "data"}` envelope to connected panel clients.

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

    `job_id` / `job` (Phase 3.0 Task 4): pass whichever is at hand to scope
    `evt` to the owning job's panel user -- `job` when the caller already has
    a live row (avoids a redundant lookup), `job_id` when it only has the
    id (this module then looks the row up itself). Neither given means an
    unscoped broadcast (used for the queue-badge `status` refreshes, which
    carry no single job's identity to scope against) -- delivered to every
    connection, exactly as before this parameter existed.

    Final review finding #5: a `job_id` that no longer resolves to a row
    (already deleted, or a synthetic id used only by a relay-function unit
    test) now fails CLOSED -- the frame is DROPPED, reaching no connection at
    all -- rather than falling back to an unscoped broadcast. The earlier
    fail-OPEN reasoning ("swallowing a real event is worse than a one-off
    leak") predates the panel being multi-tenant: an `executed` frame carries
    the job's full output payload, including `.txt` artifact TEXT CONTENT
    (`job_outputs`), so an unscoped fan-out on a resolution miss would risk
    handing one user's job output to every other connected panel socket.
    A connection registered without a resolved uid (`conn.uid is None` --
    only the same-loop test helpers still do this) still always sees
    everything once a frame IS scoped to a resolved owner.

    Never raises -- swallows and logs everything, including "no panel clients
    connected" (a no-op) and a dead event loop.
    """
    if not _connections:
        return

    owner: Optional[tuple[str, Optional[str]]] = None
    if job is not None:
        owner = (job.origin, job.user_id)
    elif job_id is not None:
        owner = _job_owner(job_id)
        if owner is None:
            # Fail CLOSED (final review finding #5): this frame identifies a
            # specific job, but the row can no longer be resolved -- there is
            # nothing left to scope against, and an unscoped fan-out here
            # could leak another user's job data. Drop it instead.
            logger.warning("panelws: dropping unresolved job-scoped frame for job %s", job_id)
            return

    current = asyncio.get_running_loop()
    for sid, conn in list(_connections.items()):
        if owner is not None and not _visible_to(conn.uid, owner):
            continue
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


async def job_progress(
    job_id: str,
    progress: float,
    *,
    stage: Optional[str] = None,
    fetch_pct: Optional[float] = None,
    fetch_model: Optional[str] = None,
) -> None:
    """Relay a progress update to every connected panel client.

    `stage`/`fetch_pct`/`fetch_model` (Phase 2.1 Task 4) are the model
    auto-fetch phase's extra fields (`agentws._handle_heartbeat` sourced from
    the agent's own heartbeat) -- included in `data` only when given, so the
    wire shape for a plain execution-progress update is byte-identical to
    before this parameter existed. The stock ComfyUI frontend ignores unknown
    fields on a `progress` event, so this is purely additive.
    """
    data = {"value": int(progress * 100), "max": 100, "prompt_id": job_id}
    if stage is not None:
        data["stage"] = stage
    if fetch_pct is not None:
        data["fetch_pct"] = fetch_pct
    if fetch_model is not None:
        data["fetch_model"] = fetch_model
    await post_event({"type": "progress", "data": data}, job_id=job_id)


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
        },
        job_id=job_id,
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
    await post_event({"type": "executing", "data": {"node": None, "prompt_id": job_id}}, job_id=job_id)


async def job_cancelled(job_id: str) -> None:
    """Tell the panel a job was cancelled -- admin API, native /interrupt, or
    a /queue delete/clear.

    ComfyUI's own protocol has no "cancelled" concept for the frontend to
    render, so this relays the same combination `job_requeued` uses: clear
    the executing marker for this job (a no-op if it wasn't the one showing
    as executing) and refresh the queue badge, which together are what stop
    the panel from believing a cancelled job is still queued or running.
    """
    await post_event({"type": "executing", "data": {"node": None, "prompt_id": job_id}}, job_id=job_id)
    await job_status_refresh()


async def job_done(job: "db.Job") -> None:
    """Emit one `executed` per output node, then the completion `executing`
    signal, then a refreshed `status`.

    Upstream's `executed` message carries exactly ONE node's UI dict in
    `data.output`, keyed by `data.node`/`data.display_node` -- never the whole
    `{node_id: {...}}` map (see `ComfyApp.addApiUpdateHandlers` in the pinned
    frontend bundle: it does `setNodeOutputsByExecutionId(node, output)` and
    `getNodeByExecutionId(node).onExecuted(output)`). Sending the full map
    under a single node id silently clears that node's preview widget
    (`output.text`/`output.images` come back `undefined`) and never reaches
    any other node -- notably `PreviewAny`, which is why this iterates every
    entry from `comfyapi.job_outputs` instead of sending it once.

    `job_outputs` is the same helper `GET /history` uses, so a done job's
    outputs can never drift between the two surfaces. Imported lazily to
    avoid a module-import cycle (comfyapi imports this module to serve
    `/comfy/api/ws`).
    """
    from . import comfyapi

    outputs = comfyapi.job_outputs(job) or {comfyapi.FALLBACK_OUTPUT_KEY: {}}

    for node_id, payload in outputs.items():
        await post_event(
            {
                "type": "executed",
                "data": {
                    "prompt_id": job.id,
                    "output": payload,
                    "node": node_id,
                    # Same value as "node" -- ComfyFed jobs have no distinct
                    # real/display node id, but upstream's shape always carries
                    # both (execution.py), and the pinned frontend may read
                    # display_node for gallery routing.
                    "display_node": node_id,
                },
            },
            job=job,
        )
    await post_event({"type": "executing", "data": {"node": None, "prompt_id": job.id}}, job=job)
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
        },
        job_id=job_id,
    )
    await job_status_refresh()
