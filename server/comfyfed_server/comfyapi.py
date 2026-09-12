"""ComfyUI-compatible API surface, so the official ComfyUI frontend can drive
the federation.

Every route here mimics the real ComfyUI server (`server.py` /
`execution.py`) rather than ComfyFed's own conventions, because the client is
ComfyUI's own JavaScript, not our console:

* `POST /prompt` errors are `{"error": {type, message, details, extra_info},
  "node_errors": {...}}` with status 400 -- NOT the `{"error": {"code",
  "message"}}` envelope the rest of this server returns. These handlers build
  their responses directly (returning a `JSONResponse` instead of raising
  `HTTPException`) precisely so the app-wide handler cannot rewrap them.
* Queue entries are the 5-element list `[number, prompt_id, prompt,
  extra_data, outputs_to_execute]` (upstream's queue tuples carry a 6th
  "sensitive" slot that `_remove_sensitive_from_queue` strips before it is
  ever serialised, so 5 is the wire shape).
* History entries are `{"prompt": <queue entry>, "outputs": {...},
  "status": {"status_str", "completed", "messages"}}`.

Deliberate deviations from upstream, all forced by ComfyFed being a
federation rather than a single GPU:

* Everything is behind an admin session (`require_admin`). `POST /prompt` is
  intentionally NOT behind `require_csrf`: the stock ComfyUI frontend has no
  way to send our `X-CSRF` header. The session cookie is `SameSite`-scoped,
  which is what keeps this from being cross-site submittable.
* `/object_info` is the union over online, enabled workers -- no single
  worker defines the node set. When no worker is online the response is an
  empty dict plus `X-ComfyFed-No-Workers: 1`, so the panel can say "no
  workers" instead of "ComfyUI has no nodes".
* `/view?type=input` and `/upload/image` are backed by a flat staging
  directory (`<data_dir>/comfy_staging/`), not ComfyUI's `input/` folder with
  subfolders -- a prompt referencing a staged filename gets it COPIED into
  the job's own inputs at submission time (see `_default_resolve_asset`), so
  the same staged file can be reused across several prompts.
* `prompt_id` is the ComfyFed job id, so a prompt submitted here is the same
  row the console's `/api/jobs` shows.
* `/ws` is served by `create_ws_router` (not this module's admin-gated
  router) and relays federation job lifecycle events -- see its docstring
  for why it is split out and how it authenticates.
"""

from __future__ import annotations

import json
import mimetypes
import os
from typing import Callable, Optional

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response

from . import assess, auth, db, jobs, panelws, storage, workers

# Node classes whose id keys a history entry's `outputs`. The ComfyUI frontend
# looks up the images it should display under the id of the node that saved
# them; when a workflow has none of these we fall back to `FALLBACK_OUTPUT_KEY`
# so the artifacts are still reachable. Public: `panelws.job_done` uses it too.
_OUTPUT_NODE_CLASSES = {"SaveImage", "SaveVideo", "SaveAudio"}
FALLBACK_OUTPUT_KEY = "comfyfed"

# Flat staging area for images/masks/audio uploaded through the ComfyUI
# frontend's upload widgets, ahead of being referenced by a submitted prompt.
# Unlike ComfyUI's own `input/`, there are no subfolders: a name here is
# reusable across any number of prompts (see `_default_resolve_asset`), and
# staged files are never cleaned up automatically -- Phase 1.5 leaves that
# to the admin.
_STAGING_DIRNAME = "comfy_staging"

# WebSocket close code for an unauthenticated `/ws` connection, mirroring
# agentws's convention for its own agent socket.
_CLOSE_UNAUTHORIZED = 4401


def staging_dir(data_dir: str) -> str:
    return os.path.join(data_dir, _STAGING_DIRNAME)


def _default_resolve_asset(data_dir: str, name: str) -> Optional[str]:
    """Look `name` up in the staging directory. `None` if unsafe or absent.

    Used as `create_router`'s default `resolve_asset` so `/prompt` submissions
    actually pick up files uploaded via `/upload/image` without every caller
    having to wire that together -- tests can still override the hook to
    isolate themselves from the filesystem.
    """
    try:
        safe_name = storage.sanitize_path_component(name, what="asset filename")
    except ValueError:
        return None
    path = os.path.join(staging_dir(data_dir), safe_name)
    return path if os.path.isfile(path) else None


_RUNNING_STATUSES = ("assigned", "running")
_PENDING_STATUSES = ("queued",)
_HISTORY_STATUSES = ("done", "failed")

# object_info union cache: (frozenset of (worker_id, object_info_hash)) -> dict.
# Keyed by the exact set of contributing workers and their content hashes, so a
# worker going offline, being disabled, or re-uploading its snapshot all miss
# the cache naturally. Only the newest key is kept -- the frontend polls this
# route constantly with the same fleet, so one entry is the whole win, and
# unbounded growth across fleet churn is not.
_object_info_cache: dict[frozenset, dict] = {}


def clear_object_info_cache() -> None:
    """Drop the cached `/object_info` union (used by tests between apps)."""
    _object_info_cache.clear()


def _comfy_error(
    error_type: str, message: str, details: str = "", node_errors: Optional[dict] = None
) -> JSONResponse:
    return JSONResponse(
        status_code=400,
        content={
            "error": {
                "type": error_type,
                "message": message,
                "details": details or message,
                "extra_info": {},
            },
            "node_errors": node_errors or {},
        },
    )


def _workflow_of(job: db.Job) -> dict:
    try:
        workflow = json.loads(job.workflow_json or "{}")
    except (TypeError, ValueError):
        return {}
    return workflow if isinstance(workflow, dict) else {}


def _result_files(job: db.Job) -> list[str]:
    try:
        files = json.loads(job.result_files or "[]")
    except (TypeError, ValueError):
        return []
    return [f for f in files if isinstance(f, str)]


def _output_node_ids(workflow: dict) -> list[str]:
    return sorted(
        node_id
        for node_id, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") in _OUTPUT_NODE_CLASSES
    )


def _queue_entry(number: int, job: db.Job) -> list:
    """Build ComfyUI's `[number, prompt_id, prompt, extra_data, outputs_to_execute]`."""
    workflow = _workflow_of(job)
    extra_data = {}
    if job.created_at is not None:
        extra_data["create_time"] = int(job.created_at.timestamp() * 1000)
    return [number, job.id, workflow, extra_data, _output_node_ids(workflow)]


def job_outputs(job: db.Job) -> dict:
    """Build the `{node_id: {"images": [...]}}` mapping ComfyUI's frontend
    expects for a job's outputs.

    Shared by `_history_entry` (`GET /history`) and `panelws.job_done` (the
    WS `executed` event), so a done job's outputs can never drift between the
    two surfaces. Empty until the job has result files.
    """
    files = _result_files(job)
    if not files:
        return {}
    node_ids = _output_node_ids(_workflow_of(job))
    key = node_ids[0] if node_ids else FALLBACK_OUTPUT_KEY
    return {
        key: {
            "images": [
                {"filename": name, "subfolder": "", "type": "output"} for name in files
            ]
        }
    }


def _history_entry(number: int, job: db.Job) -> dict:
    outputs = job_outputs(job)
    succeeded = job.status == "done"
    messages: list = []
    if not succeeded and job.error:
        messages.append(["execution_error", {"prompt_id": job.id, "exception_message": job.error}])

    return {
        "prompt": _queue_entry(number, job),
        "outputs": outputs,
        "status": {
            "status_str": "success" if succeeded else "error",
            "completed": succeeded,
            "messages": messages,
        },
    }


def _numbers_by_job_id(session) -> dict[str, int]:
    """Assign each job ComfyUI's monotonic queue `number`, oldest = 1.

    Upstream's number is a per-process submit counter; ComfyFed has no such
    counter surviving a restart, so it is derived from submission order, which
    is what the frontend actually uses it for (ordering and display).
    """
    rows = session.query(db.Job.id).order_by(db.Job.created_at.asc(), db.Job.id.asc()).all()
    return {row[0]: index for index, row in enumerate(rows, start=1)}


def _online_worker_hashes(session) -> list[tuple[str, str]]:
    rows = (
        session.query(db.Worker)
        .filter(db.Worker.disabled == False)  # noqa: E712
        .filter(db.Worker.status != "offline")
        .order_by(db.Worker.created_at.asc(), db.Worker.id.asc())
        .all()
    )
    return [(w.id, w.object_info_hash or "") for w in rows]


def create_router(
    data_dir: str,
    resolve_asset: Optional[Callable[[str], Optional[str]]] = None,
) -> APIRouter:
    """Build the `/comfy/api` router.

    `resolve_asset(filename) -> path | None` given a filename a submitted
    prompt references, returns a local path to copy into the job's inputs, or
    None if the file is unavailable. Defaults to `_default_resolve_asset`,
    which looks the name up in `<data_dir>/comfy_staging/`; tests pass their
    own to isolate themselves from the filesystem.
    """
    resolver = resolve_asset if resolve_asset is not None else (
        lambda name: _default_resolve_asset(data_dir, name)
    )

    r = APIRouter(prefix="/comfy/api", dependencies=[Depends(auth.require_admin)])

    @r.get("/object_info")
    def object_info() -> Response:
        with db.get_session() as session:
            fleet = _online_worker_hashes(session)

        if not fleet:
            return JSONResponse(content={}, headers={"X-ComfyFed-No-Workers": "1"})

        key = frozenset(fleet)
        cached = _object_info_cache.get(key)
        if cached is None:
            merged: dict = {}
            for worker_id, _hash in fleet:
                info = workers.load_object_info(data_dir, worker_id)
                if not isinstance(info, dict):
                    continue
                for node_name, node_def in info.items():
                    # First worker wins: a node present on several workers is
                    # the same node, and picking one keeps the union stable.
                    merged.setdefault(node_name, node_def)
            _object_info_cache.clear()
            _object_info_cache[key] = merged
            cached = merged

        return JSONResponse(content=cached)

    @r.post("/prompt")
    async def post_prompt(request: Request) -> Response:
        try:
            body = await request.json()
        except (ValueError, TypeError):
            body = None
        if not isinstance(body, dict):
            return _comfy_error("no_prompt", "No prompt provided")

        if "prompt" not in body:
            return _comfy_error("no_prompt", "No prompt provided")

        prompt = body["prompt"]
        if not isinstance(prompt, dict) or not prompt:
            return _comfy_error("invalid_prompt", "Prompt must be a non-empty API-format object")

        needs = assess.extract(prompt)
        resolved: dict[str, str] = {}
        for name in sorted(needs.assets):
            path = resolver(name)
            if path:
                resolved[name] = path

        try:
            job_id = jobs.create_job(
                json.dumps(prompt), prompt, available_assets=set(resolved)
            )
        except jobs.MissingAssetsError as exc:
            return _comfy_error(
                "invalid_prompt",
                "Prompt references input files that are not available: "
                + ", ".join(exc.missing),
                "Upload the referenced input files before queueing this prompt.",
            )

        if resolved:
            job_dir = jobs.job_inputs_dir(data_dir, job_id)
            os.makedirs(job_dir, exist_ok=True)
            for name, source in resolved.items():
                with open(source, "rb") as src, open(os.path.join(job_dir, name), "wb") as dest:
                    for chunk in iter(lambda: src.read(1024 * 1024), b""):
                        dest.write(chunk)

        with db.get_session() as session:
            number = session.query(db.Job).filter(db.Job.status.in_(_PENDING_STATUSES)).count()

        return JSONResponse(content={"prompt_id": job_id, "number": number, "node_errors": {}})

    @r.post("/upload/image")
    async def upload_image(
        image: UploadFile = File(...),
        overwrite: Optional[str] = Form(default=None),
    ) -> Response:
        # `overwrite` is accepted (the stock frontend's upload widget sends
        # it) but not branched on: ComfyUI's own dance -- auto-rename with a
        # " (1)" suffix unless overwrite=true -- exists to avoid clobbering a
        # previous upload by accident. ComfyFed's staging area is flat and
        # short-lived by design (a staged file is meant to be reused by name
        # across prompts), so a same-name upload always just replaces it.
        del overwrite

        if not image.filename:
            return Response(status_code=400)
        try:
            filename = storage.sanitize_path_component(image.filename, what="asset filename")
        except ValueError:
            return Response(status_code=400)

        staging = staging_dir(data_dir)
        os.makedirs(staging, exist_ok=True)
        content = await image.read()
        with open(os.path.join(staging, filename), "wb") as f:
            f.write(content)

        return JSONResponse(content={"name": filename, "subfolder": "", "type": "input"})

    @r.get("/queue")
    def get_queue() -> Response:
        with db.get_session() as session:
            numbers = _numbers_by_job_id(session)
            rows = (
                session.query(db.Job)
                .filter(db.Job.status.in_(_RUNNING_STATUSES + _PENDING_STATUSES))
                .order_by(db.Job.created_at.asc())
                .all()
            )
            running = [
                _queue_entry(numbers.get(j.id, 0), j) for j in rows if j.status in _RUNNING_STATUSES
            ]
            pending = [
                _queue_entry(numbers.get(j.id, 0), j) for j in rows if j.status in _PENDING_STATUSES
            ]
        return JSONResponse(content={"queue_running": running, "queue_pending": pending})

    @r.get("/history")
    def get_history(max_items: Optional[int] = None) -> Response:
        with db.get_session() as session:
            numbers = _numbers_by_job_id(session)
            query = (
                session.query(db.Job)
                .filter(db.Job.status.in_(_HISTORY_STATUSES))
                .order_by(db.Job.finished_at.asc(), db.Job.created_at.asc())
            )
            rows = query.all()
            if max_items is not None and max_items >= 0:
                rows = rows[-max_items:] if max_items else []
            out = {job.id: _history_entry(numbers.get(job.id, 0), job) for job in rows}
        return JSONResponse(content=out)

    @r.get("/history/{prompt_id}")
    def get_history_prompt_id(prompt_id: str) -> Response:
        with db.get_session() as session:
            job = session.get(db.Job, prompt_id)
            if job is None or job.status not in _HISTORY_STATUSES:
                # Upstream returns {} for an unknown prompt id, never a 404.
                return JSONResponse(content={})
            numbers = _numbers_by_job_id(session)
            out = {job.id: _history_entry(numbers.get(job.id, 0), job)}
        return JSONResponse(content=out)

    @r.get("/view")
    def view(filename: str = "", type: str = "output", subfolder: str = "") -> Response:
        try:
            safe_name = storage.sanitize_path_component(filename, what="filename")
        except ValueError:
            return Response(status_code=400)

        if subfolder:
            # ComfyFed artifacts are flat under their job; a subfolder can only
            # ever be a traversal attempt or a request we cannot satisfy.
            return Response(status_code=404)

        if type == "input":
            path = os.path.join(staging_dir(data_dir), safe_name)
            if not os.path.isfile(path):
                return Response(status_code=404)
            media_type = mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
            return FileResponse(path, media_type=media_type, filename=safe_name)

        if type != "output":
            return Response(status_code=404)

        with db.get_session() as session:
            candidates = (
                session.query(db.Job)
                .filter(db.Job.status == "done")
                .order_by(db.Job.finished_at.desc(), db.Job.created_at.desc())
                .all()
            )
            job_id = next(
                (job.id for job in candidates if safe_name in _result_files(job)), None
            )

        if job_id is None:
            return Response(status_code=404)

        store = storage.get_store(data_dir)
        try:
            path = store.path(job_id, safe_name)
        except (FileNotFoundError, ValueError, NotImplementedError):
            return Response(status_code=404)

        media_type = mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
        return FileResponse(path, media_type=media_type, filename=safe_name)

    return r


def create_ws_router() -> APIRouter:
    """Build the `/comfy/api/ws` panel WebSocket router.

    Deliberately a SEPARATE router from `create_router`, not another route on
    it: FastAPI applies a router's `dependencies` to its websocket routes too
    (`APIRouter.add_api_websocket_route` copies `self.dependencies`), and
    `auth.require_admin` raising `HTTPException` mid-handshake does not
    reliably translate into a client-visible close code across FastAPI/
    Starlette versions. Real ComfyUI's own `/ws` also accepts unconditionally
    and only then reacts, so this does the same: accept, check the session
    cookie, and close with 4401 (mirroring `agentws`'s convention for its
    agent socket) if it doesn't authenticate.

    Once connected, a client receives the initial `status` message (per
    `server.py`'s `websocket_handler`) and then every federation job event
    `panelws.post_event` broadcasts -- this router never reads anything back
    from the socket beyond noticing it closed.
    """
    r = APIRouter(prefix="/comfy/api")

    @r.websocket("/ws")
    async def panel_ws(websocket: WebSocket) -> None:
        await websocket.accept()

        payload = auth._read_session_payload(websocket.cookies.get("cf_session"))
        if not payload or not payload.get("authenticated"):
            await websocket.close(code=_CLOSE_UNAUTHORIZED)
            return

        sid = panelws.register(websocket)
        try:
            await websocket.send_json(
                {"type": "status", "data": {"status": panelws.queue_status(), "sid": sid}}
            )
            while True:
                # The panel client only ever listens; any inbound message (or
                # the disconnect it eventually raises) just keeps this
                # coroutine alive until the connection ends.
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            panelws.unregister(sid)

    return r
