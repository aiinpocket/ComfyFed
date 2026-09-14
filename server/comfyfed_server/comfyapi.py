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

* Everything is behind a logged-in session (`require_user`) -- Phase 3.0
  Task 4 made the panel a per-user workspace, so any non-disabled account
  reaches it now, not just admin. What stays admin-only is nothing here:
  every panel-native read/control is instead SCOPED to `origin == "panel"
  AND user_id == <the session's own uid>`, including for an admin session
  (full fleet visibility lives in the console's `/api/jobs`, not the panel).
  `POST /prompt` is intentionally NOT behind `require_csrf`: the stock
  ComfyUI frontend has no way to send our `X-CSRF` header. The session
  cookie is `SameSite`-scoped, which is what keeps this from being
  cross-site submittable.
* `/object_info` is the union over online, enabled workers -- no single
  worker defines the node set. When no worker is online the response is an
  empty dict plus `X-ComfyFed-No-Workers: 1`, so the panel can say "no
  workers" instead of "ComfyUI has no nodes".
* `/view?type=input` and `/upload/image` are backed by a per-user staging
  directory (`<data_dir>/comfy_staging/<uid>/`), not ComfyUI's `input/`
  folder with worker-side subfolders -- a prompt referencing a staged
  filename gets it COPIED into the job's own inputs at submission time (see
  `_default_resolve_asset`), so the same staged file can be reused across
  several of that user's own prompts. Namespaced by uid since Phase 3.0
  Task 4 widened the panel to every logged-in user.
* `prompt_id` is the ComfyFed job id, so a prompt submitted here is the same
  row the console's `/api/jobs` shows.
* `/ws` is served by `create_ws_router` (not this module's admin-gated
  router) and relays federation job lifecycle events -- see its docstring
  for why it is split out and how it authenticates.
"""

from __future__ import annotations

import json
import logging
import mimetypes
import os
from collections import OrderedDict
from importlib import resources
from typing import Callable, Optional

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response

from . import agentws, assess, auth, db, jobs, model_guide, model_manifest, panelws, storage, workers

logger = logging.getLogger(__name__)

# Node classes whose id keys a history entry's `outputs`. The ComfyUI frontend
# looks up the images it should display under the id of the node that saved
# them; when a workflow has none of these we fall back to `FALLBACK_OUTPUT_KEY`
# so the artifacts are still reachable. Public: `panelws.job_done` uses it too.
# `SaveText` is included here (it's a real output node, so it belongs in
# `outputs_to_execute` too -- see `_queue_entry`) but NOT in
# `_MEDIA_OUTPUT_NODE_CLASSES` below: a workflow with a SaveText node must
# never have its media files keyed under the SaveText id.
_OUTPUT_NODE_CLASSES = {"SaveImage", "SaveVideo", "SaveAudio", "SaveText"}
_MEDIA_OUTPUT_NODE_CLASSES = {"SaveImage", "SaveVideo", "SaveAudio"}
_TEXT_OUTPUT_NODE_CLASS = "SaveText"
# The node novices actually look at to read a generated prompt. It produces
# no file of its own, so it is never a candidate output key for media and
# never appears in `_OUTPUT_NODE_CLASSES` -- `job_outputs` locates its ids
# separately and duplicates the SaveText node's text payload onto each one.
_PREVIEW_ANY_CLASS = "PreviewAny"
FALLBACK_OUTPUT_KEY = "comfyfed"

_TEXT_ARTIFACT_EXT = ".txt"
_TEXT_ARTIFACT_MAX_BYTES = 100_000

# `_read_text_artifact` memo cache, keyed by `(job_id, filename)`. Artifacts
# are immutable once a worker writes them, so a successful read never goes
# stale -- caching it turns `GET /history`'s per-job fan-out (M2 in the final
# review: every done job with a `.txt` output re-opens a store, hits the DB
# for the `artifact_store` setting, and re-reads up to 100 KB from disk, on
# EVERY poll) into a single disk read per artifact for the process lifetime.
# Capped at `_TEXT_ARTIFACT_CACHE_MAX` entries, evicting the oldest
# (`OrderedDict` insertion order) -- an unbounded cache would let a
# long-running admin session accumulate ~20 MB+ of text forever. A FAILED
# read (missing file, misconfigured store, ...) is deliberately NEVER
# cached: `job_outputs`'s documented contract is that a late-arriving upload
# should be picked up by a retry, and caching `None` would make that
# permanent for the process's lifetime instead of just until the file shows
# up.
_TEXT_ARTIFACT_CACHE_MAX = 128
_text_artifact_cache: "OrderedDict[tuple[str, str], str]" = OrderedDict()

# Set by `create_router` (mirrors `agentws._data_dir`): `job_outputs` needs it
# to read a `.txt` artifact's content from the store, but it is shared by
# `panelws.job_done` (no `data_dir` in scope there) and `_history_entry`
# (which does have one) alike, so a module-level value set once at app
# startup is simpler than threading `data_dir` through both call paths.
_data_dir: Optional[str] = None

# Per-user staging area for images/masks/audio uploaded through the ComfyUI
# frontend's upload widgets, ahead of being referenced by a submitted prompt.
# Unlike ComfyUI's own `input/`, there are no subfolders within a user's own
# namespace: a name here is reusable across any number of that user's own
# prompts (see `_default_resolve_asset`), and staged files are never cleaned
# up automatically -- Phase 1.5 leaves that to the admin.
_STAGING_DIRNAME = "comfy_staging"

# Reserved pseudo-uid for the packaged template sample assets
# (`templates.seed_staging`), namespaced alongside real per-user staging
# directories but readable by EVERY user -- these are platform-shipped
# public samples (e.g. `amyntas_ref.png`), not private uploads, so every
# user's templates must still resolve on first run even though uploads are
# now isolated per uid (final review finding #1). Never collides with a real
# `db.User.id` (`uuid4().hex` is 32 lowercase hex chars, never starting with
# `_`).
SHARED_STAGING_UID = "_shared"

# Panel UI preferences (theme, canvas options, ...), the ComfyFed stand-in for
# upstream's per-user `comfy.settings.json`. One file, because ComfyFed has
# exactly one admin.
_SETTINGS_FILENAME = "comfy_settings.json"

# WebSocket close code for an unauthenticated `/ws` connection, mirroring
# agentws's convention for its own agent socket.
_CLOSE_UNAUTHORIZED = 4401

# How many workers contributed to the `/object_info` union, reported as a
# response header rather than mixed into the body. The body has to stay a
# byte-for-byte plausible ComfyUI `/object_info` -- the stock frontend
# iterates it and builds a node for every key, so any ComfyFed-specific entry
# would materialise as a bogus node in the palette, and any extra field on a
# node def risks tripping its schema handling. A header is invisible to the
# frontend and readable by anything of ours that wants to explain "these
# nodes come from N workers, and a graph mixing them may be undispatchable".
_WORKER_COUNT_HEADER = "X-ComfyFed-Worker-Count"


def staging_dir(data_dir: str, uid: str) -> str:
    """Per-user staging directory: `<data_dir>/comfy_staging/<uid>/`.

    Phase 3.0 Task 4 widened `/comfy/*` to any logged-in user, but the
    staging area used to be one flat, process-wide directory -- any user
    could list, read, or overwrite any other user's staged upload (final
    review finding #1). Namespacing by uid keeps the "flat and short-lived,
    reused by name across prompts" property intact WITHIN a user while
    isolating users from each other. `uid` is path-sanitized the same way a
    client-supplied filename is (`storage.sanitize_path_component`) -- it
    always comes from an authenticated session, but defense in depth costs
    nothing here.

    A pre-Task-4 flat file directly under `comfy_staging/` (if any survive
    on an upgraded deployment) is simply unreachable through this path now --
    staging data is transient, so no migration is needed.
    """
    safe_uid = storage.sanitize_path_component(uid, what="user id")
    return os.path.join(data_dir, _STAGING_DIRNAME, safe_uid)


def _legacy_settings_path(data_dir: str) -> str:
    """The pre-Task-4 single global blob -- ComfyFed had exactly one admin
    then, so one file was the direct equivalent of upstream's per-user
    `comfy.settings.json`. Kept as a read-only fallback default (final
    review finding #7): a user who has never written their own settings
    reads this so their editor doesn't appear to reset on upgrade."""
    return os.path.join(data_dir, _SETTINGS_FILENAME)


def _user_settings_path(data_dir: str, uid: str) -> str:
    """Per-user settings file: `<data_dir>/comfy_settings.<uid>.json`.

    Final review finding #7: now that any role reaches `/comfy/api/*`, one
    global settings blob meant a regular user's panel preference write
    silently overwrote every other user's (including admins'), contradicting
    the "面板改為個人工作區" ruling the rest of Task 4 implements carefully.
    `uid` is path-sanitized the same way a client-supplied filename is.
    """
    safe_uid = storage.sanitize_path_component(uid, what="user id")
    return os.path.join(data_dir, f"comfy_settings.{safe_uid}.json")


def _load_json_dict(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            loaded = json.load(f)
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _load_settings(data_dir: str, uid: str) -> dict:
    """`uid`'s own settings, falling back to the legacy global blob when
    this user has never written their own (see `_legacy_settings_path`).
    Once a user writes anything, `_save_settings` forks their own file
    (seeded from this same effective view), so this fallback only ever
    applies before their very first write.
    """
    own_path = _user_settings_path(data_dir, uid)
    if os.path.exists(own_path):
        return _load_json_dict(own_path)
    return _load_json_dict(_legacy_settings_path(data_dir))


def _save_settings(data_dir: str, uid: str, values: dict) -> None:
    os.makedirs(data_dir, exist_ok=True)
    with open(_user_settings_path(data_dir, uid), "w", encoding="utf-8") as f:
        json.dump(values, f, ensure_ascii=False, indent=1, sort_keys=True)


def _default_resolve_asset(data_dir: str, uid: str, name: str) -> Optional[str]:
    """Look `name` up in `uid`'s own staging directory. `None` if unsafe or absent.

    Used as `create_router`'s default `resolve_asset` so `/prompt` submissions
    actually pick up files uploaded via `/upload/image` without every caller
    having to wire that together -- tests can still override the hook to
    isolate themselves from the filesystem. Scoped to the submitting session's
    own uid so `/prompt` can never resolve another user's staged file by name
    (final review finding #1).
    """
    try:
        safe_name = storage.sanitize_path_component(name, what="asset filename")
    except ValueError:
        return None
    path = os.path.join(staging_dir(data_dir, uid), safe_name)
    if os.path.isfile(path):
        return path
    # Fall back to the shared, packaged template samples -- public by
    # design, so every user's templates resolve on first run.
    shared_path = os.path.join(staging_dir(data_dir, SHARED_STAGING_UID), safe_name)
    return shared_path if os.path.isfile(shared_path) else None


_RUNNING_STATUSES = ("assigned", "running")
_PENDING_STATUSES = ("queued",)
_HISTORY_STATUSES = ("done", "failed")

# object_info merge cache: (frozenset of (worker_id, object_info_hash), mode)
# -> dict. Keyed by the exact set of contributing workers, their content
# hashes, AND the merge mode (Task 7's `object_info_mode` setting), so a
# worker going offline, being disabled, re-uploading its snapshot, or an admin
# flipping union/intersection all miss the cache naturally. Only the newest
# key is kept -- the frontend polls this route constantly with the same fleet
# and mode, so one entry is the whole win, and unbounded growth across fleet
# churn is not.
_object_info_cache: dict[tuple[frozenset, str], dict] = {}

_OBJECT_INFO_MODE_KEY = "object_info_mode"
_OBJECT_INFO_MODES = ("union", "intersection")
_DEFAULT_OBJECT_INFO_MODE = "union"


def _object_info_mode(session) -> str:
    """Read the `object_info_mode` setting (own copy of the key -- see
    `auth._OBJECT_INFO_MODE_KEY`, `metrics._METRICS_PUBLIC_KEY` and
    `storage._ARTIFACT_STORE_SETTING_KEY` for the same each-consumer-reads-
    its-own-setting pattern). Falls back to the default on an unset or
    corrupted (pre-Task-7 admin tooling, hand-edited DB) value rather than
    raising, since a bad setting must not take `/object_info` down."""
    row = session.get(db.Setting, _OBJECT_INFO_MODE_KEY)
    if row is not None and row.value in _OBJECT_INFO_MODES:
        return row.value
    return _DEFAULT_OBJECT_INFO_MODE


def _merge_object_info(data_dir: str, fleet: list[tuple[str, str]], mode: str) -> dict:
    """Build the `/object_info` merge over `fleet` (online, enabled workers).

    `union` (default): every node class any contributing worker defines,
    first-worker-wins on a same-named class -- unchanged from pre-Task-7
    behaviour.

    `intersection`: only node classes EVERY contributing worker defines --
    "every class in the result is dispatchable to any worker in the fleet"
    is the whole point, so a class only one worker knows about would be a
    trap (submit succeeds, dispatch to the wrong worker fails). The per-class
    *value* kept for a surviving class is still the plain first-worker-wins
    union pick, not a deep per-field merge: 交集模式保證派得出去，下拉內容仍聯集
    因為模型檔各 worker 本就不同 -- e.g. two workers' CheckpointLoaderSimple both
    survive intersection (both have the class), but each worker's own
    checkpoint filenames differ, and there is no single "the" combo list to
    reconcile beyond picking one worker's -- narrowing node-class *presence*
    is Task 7's job, not reconciling per-worker model inventories.

    Workers whose snapshot failed to parse (`load_object_info` returned
    something other than a dict) contribute nothing either way, same as
    today: they neither add classes to the union nor constrain the
    intersection, since we have no information from them to intersect with.
    """
    worker_infos: list[dict] = []
    for worker_id, _hash in fleet:
        info = workers.load_object_info(data_dir, worker_id)
        if isinstance(info, dict):
            worker_infos.append(info)

    merged: dict = {}
    for info in worker_infos:
        for node_name, node_def in info.items():
            # First worker wins: a node present on several workers is the
            # same node, and picking one keeps the union stable.
            merged.setdefault(node_name, node_def)

    if mode == "intersection" and worker_infos:
        common = set(worker_infos[0])
        for info in worker_infos[1:]:
            common &= set(info)
        merged = {name: node_def for name, node_def in merged.items() if name in common}

    return merged


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


def _node_ids_of_class(workflow: dict, classes) -> list[str]:
    return sorted(
        node_id
        for node_id, node in workflow.items()
        if isinstance(node, dict) and node.get("class_type") in classes
    )


def _output_node_ids(workflow: dict) -> list[str]:
    """Node ids for the queue entry's `outputs_to_execute` slot -- deliberately
    `_OUTPUT_NODE_CLASSES` (media + `SaveText`), NOT the separate concept of
    "every node id `job_outputs` can key a payload onto" (which also includes
    `PreviewAny`, kept out here on purpose since it produces no file of its
    own). These are two different sets that happen to share most of their
    membership; don't fold `_PREVIEW_ANY_CLASS` into `_OUTPUT_NODE_CLASSES` to
    "fix" this -- the agent re-derives real output nodes by submitting the
    prompt to its own ComfyUI, and only the panel's queue view reads this
    field, so there is no functional bug here today.
    """
    return _node_ids_of_class(workflow, _OUTPUT_NODE_CLASSES)


def _queue_entry(number: int, job: db.Job) -> list:
    """Build ComfyUI's `[number, prompt_id, prompt, extra_data, outputs_to_execute]`."""
    workflow = _workflow_of(job)
    extra_data = {}
    if job.created_at is not None:
        extra_data["create_time"] = int(job.created_at.timestamp() * 1000)
    return [number, job.id, workflow, extra_data, _output_node_ids(workflow)]


def _read_text_artifact(job: db.Job, filename: str) -> Optional[str]:
    """Best-effort read of a `.txt` artifact's content for the panel preview.

    Memoized in `_text_artifact_cache` per `(job.id, filename)` -- see that
    cache's comment for why this is sound (artifacts are immutable) and why
    a failed read is never cached (a retry after a late upload must still
    succeed). `job_outputs` stays synchronous either way; this only removes
    repeat disk/DB work across calls, it does not change when the work runs.

    Capped at `_TEXT_ARTIFACT_MAX_BYTES` (a generated prompt can run long,
    and this is a preview, not a download -- the full file is still
    reachable via `files`). Any failure (store misconfigured, artifact
    missing, ...) returns `None` so the caller falls back to a files-only
    entry instead of ever raising out of `job_outputs`.
    """
    cache_key = (job.id, filename)
    cached = _text_artifact_cache.get(cache_key)
    if cached is not None:
        _text_artifact_cache.move_to_end(cache_key)
        return cached

    if _data_dir is None:
        return None
    try:
        store = storage.get_store(_data_dir)
        with store.open(job.id, filename) as f:
            raw = f.read(_TEXT_ARTIFACT_MAX_BYTES)
    except Exception:  # noqa: BLE001 -- "never raise" is the explicit contract here
        return None

    text = raw.decode("utf-8", errors="replace")
    _text_artifact_cache[cache_key] = text
    _text_artifact_cache.move_to_end(cache_key)
    if len(_text_artifact_cache) > _TEXT_ARTIFACT_CACHE_MAX:
        _text_artifact_cache.popitem(last=False)
    return text


def _merge_output(result: dict, key: str, payload: dict) -> None:
    """Add `payload`'s lists into `result[key]`, creating or extending it.

    A plain `result[key] = payload` would let two different pieces of
    `job_outputs` clobber each other when they happen to land on the same
    node id (notably the `FALLBACK_OUTPUT_KEY` collision between media and
    text when a workflow has neither a recognised media output node nor a
    `SaveText` node).
    """
    existing = result.setdefault(key, {})
    for field, values in payload.items():
        existing.setdefault(field, []).extend(values)


def job_outputs(job: db.Job) -> dict:
    """Build the `{node_id: {...}}` mapping ComfyUI's frontend expects for a
    job's outputs.

    Shared by `_history_entry` (`GET /history`) and `panelws.job_done` (the
    WS `executed` event), so a done job's outputs can never drift between the
    two surfaces. Empty until the job has result files.

    Result files split by extension:

    * Everything but `.txt` is today's `images` mapping, keyed to the first
      *media* output node id (`_MEDIA_OUTPUT_NODE_CLASSES`) or
      `FALLBACK_OUTPUT_KEY`.
    * `.txt` files become a `{"text": [...], "files": [...]}` mapping keyed
      to the workflow's `SaveText` node id (or `FALLBACK_OUTPUT_KEY` if the
      workflow has none, so the files stay reachable even then). The same
      `{"text": [...]}` is ALSO duplicated onto every `PreviewAny` node id --
      that is the node novices actually look at, and duplicating is how both
      render the result. `text` is omitted entirely (not an empty list) when
      no artifact content could be read, so a missing/unreadable `.txt`
      degrades to a files-only entry rather than a misleading blank preview.

    A job with both media and text files gets both mappings side by side.

    `subfolder` carries the JOB ID, which is what makes an old history entry
    still resolvable. ComfyUI names outputs from a node-side prefix
    (`ComfyUI_00001_.png`), and every worker in a federation numbers from its
    own counter -- so the same filename recurs across jobs constantly. The
    frontend round-trips `subfolder` verbatim from history into its `/view`
    call, and `/view` reads it back as the owning job (see the route), so a
    filename collision resolves to the right bytes instead of whichever job
    finished most recently. Upstream uses the same field for the same
    purpose (its outputs live under `output/<subfolder>/`), so this is a
    shape the stock frontend already handles -- no client change needed.
    """
    files = _result_files(job)
    if not files:
        return {}

    text_files = [f for f in files if os.path.splitext(f)[1].lower() == _TEXT_ARTIFACT_EXT]
    media_files = [f for f in files if f not in text_files]

    workflow = _workflow_of(job)
    result: dict = {}

    if media_files:
        media_ids = _node_ids_of_class(workflow, _MEDIA_OUTPUT_NODE_CLASSES)
        key = media_ids[0] if media_ids else FALLBACK_OUTPUT_KEY
        _merge_output(
            result,
            key,
            {
                "images": [
                    {"filename": name, "subfolder": job.id, "type": "output"}
                    for name in media_files
                ]
            },
        )

    if text_files:
        texts = [
            content
            for content in (_read_text_artifact(job, name) for name in text_files)
            if content is not None
        ]
        file_entries = [
            {"filename": name, "subfolder": job.id, "type": "output"} for name in text_files
        ]

        # Only the FIRST `SaveText` node (sorted by id) gets a payload; a
        # second one in the same workflow gets no key at all, and its
        # preview stays blank (`WidgetTextPreview` also only ever reads
        # `files[0]`). Not hit by any shipped template (one SaveText each) --
        # documented here rather than fixed so the contract is explicit if a
        # future template adds a second one.
        save_text_ids = _node_ids_of_class(workflow, {_TEXT_OUTPUT_NODE_CLASS})
        save_target = save_text_ids[0] if save_text_ids else FALLBACK_OUTPUT_KEY
        save_payload: dict = {"files": file_entries}
        if texts:
            save_payload["text"] = texts
        _merge_output(result, save_target, save_payload)

        if texts:
            for preview_id in _node_ids_of_class(workflow, {_PREVIEW_ANY_CLASS}):
                _merge_output(result, preview_id, {"text": texts})

    return result


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


def _fleet_wide_gaps(needs: assess.JobNeeds) -> tuple[set[str], set[str]]:
    """`(models, node classes)` that NOT ONE registered worker can supply.

    Thin session-fetching wrapper around `assess.fleet_wide_gaps` (the shared,
    pure implementation `jobs.py`'s console submit predicate also calls) --
    see that function's docstring for the fleet-wide-vs-online-only rationale.
    """
    with db.get_session() as session:
        # Soft-deleted rows excluded (`jobs._live_workers`), matching the
        # cloud's `getAllWorkers`-backed twin: a deleted worker can never be
        # assigned, so its inventory must not make a prompt look servable.
        all_workers = jobs._live_workers(session)
    return assess.fleet_wide_gaps(needs, all_workers)


def _online_enabled_workers(session) -> list:
    """Workers eligible to be asked to auto-fetch: online and not disabled.

    Same "online" definition as `_online_worker_hashes` (`status != "offline"`,
    `disabled == False`) -- a worker that isn't actually reachable right now,
    or that the admin paused, must not make a missing model look fetchable to
    a submitter, since nothing will ever come along and fetch it.
    """
    return (
        session.query(db.Worker)
        .filter(db.Worker.disabled == False)  # noqa: E712
        .filter(db.Worker.status != "offline")
        .all()
    )


def _partition_missing_models(missing_models: set[str], data_dir: str) -> tuple[set[str], set[str]]:
    """`(fetchable, unfetchable)` split of a fleet-wide missing-model set --
    see `assess.partition_fleet_fetchable` for the combined-gate rule. Shared
    by `post_prompt`'s 400 predicate and `jobs.py`'s console submit predicate
    (which imports this rather than duplicating the manifest/online-worker
    lookup).
    """
    if not missing_models:
        return set(), set()
    with db.get_session() as session:
        online_workers = _online_enabled_workers(session)
    manifest_entries = model_manifest.entries(data_dir)
    fetchable_map = {e["name"]: e["size_bytes"] for e in manifest_entries}
    peer_only_models = model_manifest.peer_only_names(manifest_entries)
    return assess.partition_fleet_fetchable(missing_models, fetchable_map, online_workers, peer_only_models)


def _dir_file_names(directory: str) -> set[str]:
    try:
        return {
            name for name in os.listdir(directory)
            if os.path.isfile(os.path.join(directory, name))
        }
    except OSError:
        return set()


def staged_image_names(data_dir: str, uid: str) -> list[str]:
    """Sorted filenames currently sitting in `uid`'s own staging directory,
    plus the shared, packaged template samples every user can see."""
    names = _dir_file_names(staging_dir(data_dir, uid))
    names |= _dir_file_names(staging_dir(data_dir, SHARED_STAGING_UID))
    return sorted(names)


def _merge_options(spec: list, names: list[str]) -> Optional[list]:
    """Return a copy of a combo input spec with `names` merged into its options.

    `/object_info` writes a combo two different ways and both turn up in the
    same fleet: the historical `[[option, ...], config]` and the newer
    `["COMBO", {"options": [...], ...}]`. Returns None when `spec` is neither,
    so the caller can leave an input it does not understand untouched.
    """
    if not isinstance(spec, list) or not spec:
        return None

    if isinstance(spec[0], list):
        existing = spec[0]
        merged = existing + [n for n in names if n not in existing]
        return [merged, *spec[1:]]

    if spec[0] == "COMBO" and len(spec) > 1 and isinstance(spec[1], dict):
        config = spec[1]
        existing = config.get("options")
        if not isinstance(existing, list):
            return None
        merged = existing + [n for n in names if n not in existing]
        return [spec[0], {**config, "options": merged}, *spec[2:]]

    return None


# Which staged-file extensions belong in which upload dropdown. Keys match
# the three core upload-field conventions handled in `_with_staged_images`.
_UPLOAD_FIELD_EXTENSIONS = {
    "image": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"},
    "audio": {".wav", ".mp3", ".flac", ".ogg", ".m4a"},
    "file": {".mp4", ".webm", ".mov", ".mkv", ".avi"},
}


def _with_staged_images(object_info: dict, names: list[str]) -> dict:
    """Offer every staged filename in the `image` dropdown of upload nodes.

    A worker's `/object_info` lists the images sitting in ITS OWN ComfyUI
    `input/` folder, which is not where a panel upload lands -- ComfyFed
    stages uploads centrally and copies them into a job at submit time. So
    without this the dropdown of a `LoadImage` in one of our templates would
    be empty (or, worse, list some worker's unrelated leftovers) and the
    packaged `amyntas_ref.png` would be unselectable even though `/prompt`
    resolves it perfectly well.

    "Upload node" is detected the way ComfyUI itself marks one: a required
    input whose config carries the matching `*_upload` flag. Three core
    conventions exist -- `image`/`image_upload` (`LoadImage`,
    `LoadImageMask`), `audio`/`audio_upload` (`LoadAudio`) and
    `file`/`video_upload` (`LoadVideo`) -- and any custom node following one
    of them is caught too, without hard-coding a class list.

    Node defs are copied on write, because the caller's dict is the shared
    `/object_info` union cache.
    """
    if not names or not isinstance(object_info, dict):
        return object_info

    # Staged files are offered only to dropdowns of their own media kind: an
    # mp4 in a LoadImage list would just be a confusing selection that fails
    # at execution. A name with an extension none of the kinds claim is
    # offered everywhere -- graceful for exotic formats a custom node might
    # accept.
    known = {ext for exts in _UPLOAD_FIELD_EXTENSIONS.values() for ext in exts}

    def names_for(field_name: str) -> list[str]:
        exts = _UPLOAD_FIELD_EXTENSIONS[field_name]
        return [
            n for n in names
            if os.path.splitext(n)[1].lower() in exts or os.path.splitext(n)[1].lower() not in known
        ]

    upload_fields = (("image", "image_upload"), ("audio", "audio_upload"), ("file", "video_upload"))

    result = object_info
    for node_name, node_def in object_info.items():
        if not isinstance(node_def, dict):
            continue
        required = node_def.get("input", {}).get("required") if isinstance(node_def.get("input"), dict) else None
        if not isinstance(required, dict):
            continue
        for field_name, upload_flag in upload_fields:
            spec = required.get(field_name)
            if not isinstance(spec, list) or len(spec) < 2 or not isinstance(spec[1], dict):
                continue
            if not spec[1].get(upload_flag):
                continue
            merged = _merge_options(spec, names_for(field_name))
            if merged is None or merged == spec:
                continue
            if result is object_info:
                result = dict(object_info)
            patched_def = dict(result[node_name]) if result[node_name] is node_def else result[node_name]
            patched_input = dict(patched_def["input"])
            patched_required = dict(patched_input.get("required") or {})
            patched_required[field_name] = merged
            patched_input["required"] = patched_required
            patched_def["input"] = patched_input
            result[node_name] = patched_def
    return result


def create_router(
    data_dir: str,
    resolve_asset: Optional[Callable[[str, str], Optional[str]]] = None,
) -> APIRouter:
    """Build the `/comfy/api` router.

    `resolve_asset(uid, filename) -> path | None` given the submitting
    session's uid and a filename a submitted prompt references, returns a
    local path to copy into the job's inputs, or None if the file is
    unavailable. Defaults to `_default_resolve_asset`, which looks the name
    up in `<data_dir>/comfy_staging/<uid>/`; tests pass their own to isolate
    themselves from the filesystem.
    """
    global _data_dir
    _data_dir = data_dir

    resolver = resolve_asset if resolve_asset is not None else (
        lambda uid, name: _default_resolve_asset(data_dir, uid, name)
    )

    # Phase 3.0 Task 4: the panel is a per-user workspace, not an admin-only
    # surface -- any authenticated, non-disabled user may reach it
    # (`require_user`), same rule as the static `/comfy` gate and the panel
    # WS handshake below. What changes per role is NOT gate access but
    # per-route SCOPE: every panel-native read/control (`/queue`, `/history`,
    # `/interrupt`, `/queue` delete/clear, `/history` hide, `/view`) is
    # additionally filtered to `origin == "panel" AND user_id == <the
    # session's own uid>` -- including for an admin session, whose panel is
    # just as personal as anyone else's (the spec's ruling: full fleet
    # visibility lives in the console, not here).
    r = APIRouter(prefix="/comfy/api", dependencies=[Depends(auth.require_user)])

    @r.get("/object_info")
    def object_info(user: auth.SessionUser = Depends(auth.require_user)) -> Response:
        with db.get_session() as session:
            fleet = _online_worker_hashes(session)
            mode = _object_info_mode(session)

        if not fleet:
            return JSONResponse(
                content={},
                headers={"X-ComfyFed-No-Workers": "1", _WORKER_COUNT_HEADER: "0"},
            )

        key = (frozenset(fleet), mode)
        cached = _object_info_cache.get(key)
        if cached is None:
            cached = _merge_object_info(data_dir, fleet, mode)
            _object_info_cache.clear()
            _object_info_cache[key] = cached

        # Staged filenames are merged in per-request (never cached), scoped to
        # the CALLING session's own uid -- otherwise B's dropdown would list
        # A's staged uploads (final review finding #1).
        return JSONResponse(
            content=_with_staged_images(cached, staged_image_names(data_dir, user.uid)),
            headers={_WORKER_COUNT_HEADER: str(len(fleet))},
        )

    @r.get("/workflow_templates")
    def workflow_templates() -> Response:
        """Custom-node template map -- always empty for ComfyFed.

        The frontend's template browser calls this FIRST and only fetches the
        core `templates/index.json` (which is where our library lives, see
        `templates.py`) once it resolves. A 404 here would leave the browser
        empty, so the route exists purely to say "no custom-node packs".
        """
        return JSONResponse(content={})

    @r.post("/prompt")
    async def post_prompt(request: Request, user: auth.SessionUser = Depends(auth.require_user)) -> Response:
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

        missing_models, missing_nodes = _fleet_wide_gaps(needs)
        # Phase 2.1: a model missing from every worker's inventory is no
        # longer automatically a dead end -- if the manifest has a signed
        # entry for it AND at least one online, opted-in worker can fetch the
        # whole missing set (see assess.partition_fleet_fetchable), it queues
        # normally instead of being refused. Only the genuinely-unfetchable
        # remainder still blocks submission.
        _fetchable, blocking = _partition_missing_models(missing_models, data_dir)
        if blocking:
            names = sorted(blocking)
            guidance = model_guide.guidance_message(names, data_dir)
            if missing_nodes:
                guidance += "\n\n" + model_guide.missing_nodes_note(sorted(missing_nodes))
            # message = one-line summary, details = the full guidance. The
            # official frontend uses `message` as the Errors-panel card title
            # and as the leading half of the dialog's `message + ": " +
            # details`, so a multi-line blob in `message` renders either as a
            # collapsed one-line headline or twice over.
            #
            # node_errors mirrors the same missing models onto the actual
            # offending node(s): the panel's Errors tab reads its scrollable
            # details box ONLY from node_errors[<id>].errors[].details, never
            # from this top-level error, so without this an admin sees just
            # the one-line summary there and has to fall back to the legacy
            # dialog to read the download guidance at all.
            node_errors: dict = {}
            model_node_map = assess.model_nodes(prompt)
            for name in names:
                for node_id, class_type in model_node_map.get(name, []):
                    entry = node_errors.setdefault(
                        node_id,
                        {"class_type": class_type, "dependent_outputs": [], "errors": []},
                    )
                    entry["errors"].append(
                        {
                            "type": "comfyfed.missing_model",
                            "message": model_guide.guidance_summary([name]),
                            "details": model_guide.model_guidance_block(name, data_dir),
                            "extra_info": {},
                        }
                    )
            return _comfy_error(
                "prompt.missing_models",
                model_guide.guidance_summary(names),
                guidance,
                node_errors,
            )

        resolved: dict[str, str] = {}
        for name in sorted(needs.assets):
            path = resolver(user.uid, name)
            if path:
                resolved[name] = path

        # Phase 3.0 Task 4: stamp the submitting session's user onto the job,
        # same as the console's `POST /api/jobs`. `user` now comes from the
        # router-level `require_user` dependency (the panel is open to any
        # logged-in user, not just admin), cached per-request by FastAPI so
        # this doesn't re-run the cookie decode a second time.
        try:
            job_id = jobs.create_job(
                json.dumps(prompt),
                prompt,
                available_assets=set(resolved),
                origin="panel",
                user_id=user.uid,
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
        user: auth.SessionUser = Depends(auth.require_user),
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

        staging = staging_dir(data_dir, user.uid)
        os.makedirs(staging, exist_ok=True)
        content = await image.read()
        with open(os.path.join(staging, filename), "wb") as f:
            f.write(content)

        return JSONResponse(content={"name": filename, "subfolder": "", "type": "input"})

    @r.get("/queue")
    def get_queue(user: auth.SessionUser = Depends(auth.require_user)) -> Response:
        with db.get_session() as session:
            numbers = _numbers_by_job_id(session)
            rows = (
                session.query(db.Job)
                .filter(
                    db.Job.status.in_(_RUNNING_STATUSES + _PENDING_STATUSES),
                    db.Job.origin == "panel",
                    db.Job.user_id == user.uid,
                )
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

    @r.post("/interrupt")
    async def post_interrupt(user: auth.SessionUser = Depends(auth.require_user)) -> Response:
        """Cancel whatever the panel currently sees as executing.

        Upstream's `/interrupt` targets the single job ComfyUI itself is
        running; ComfyFed's federation equivalent is the oldest `origin ==
        "panel"` job in `_RUNNING_STATUSES` (the same ordering `GET /queue`
        reports as `queue_running`) -- the one the panel's own UI would be
        showing as the active prompt. Scoped to panel-origin jobs only: a
        console-submitted job running at the same time is none of the
        panel's business, even if it happens to be older. A no-op (still
        200) when nothing is running, matching upstream's fire-and-forget
        contract: the real ComfyUI answers `/interrupt` with an empty 200
        unconditionally too.
        """
        with db.get_session() as session:
            job = (
                session.query(db.Job)
                .filter(
                    db.Job.status.in_(_RUNNING_STATUSES),
                    db.Job.origin == "panel",
                    db.Job.user_id == user.uid,
                )
                .order_by(db.Job.created_at.asc())
                .first()
            )
            job_id = job.id if job is not None else None

        if job_id:
            await agentws.cancel_and_notify(job_id, reason="interrupted from panel")

        return JSONResponse(content={})

    @r.post("/queue")
    async def post_queue(
        request: Request, user: auth.SessionUser = Depends(auth.require_user)
    ) -> Response:
        """ComfyUI-compat queue mutation: `{"delete": [prompt_ids]}` cancels
        those specific jobs; `{"clear": true}` cancels every non-terminal
        job currently in the federation's queue (upstream empties the whole
        pending queue -- ComfyFed has no separate "local queue" to distinguish
        it from jobs already dispatched to a worker, so `assigned`/`running`
        jobs are cancelled too).

        Both branches are scoped to `origin == "panel"` jobs: this is the
        panel's own queue view, so it must never reach into (or even name,
        via an explicit id in `delete`) a job the console submitted.
        """
        try:
            body = await request.json()
        except (ValueError, TypeError):
            body = None
        if not isinstance(body, dict):
            body = {}

        if body.get("clear"):
            with db.get_session() as session:
                job_ids = [
                    j.id
                    for j in session.query(db.Job)
                    .filter(
                        db.Job.status.in_(_PENDING_STATUSES + _RUNNING_STATUSES),
                        db.Job.origin == "panel",
                        db.Job.user_id == user.uid,
                    )
                    .all()
                ]
        else:
            requested = body.get("delete")
            requested_ids = (
                [pid for pid in requested if isinstance(pid, str)] if isinstance(requested, list) else []
            )
            if requested_ids:
                with db.get_session() as session:
                    job_ids = [
                        j.id
                        for j in session.query(db.Job)
                        .filter(
                            db.Job.id.in_(requested_ids),
                            db.Job.origin == "panel",
                            db.Job.user_id == user.uid,
                        )
                        .all()
                    ]
            else:
                job_ids = []

        for job_id in job_ids:
            try:
                await agentws.cancel_and_notify(job_id, reason="removed from panel queue")
            except Exception:
                # One job's cancel/notify blowing up must not 500 the whole
                # sweep or skip the rest of `job_ids` -- a partially-applied
                # `{"clear": true}` (or a `delete` list with several ids)
                # would otherwise leave later jobs queued/running with no
                # indication to the panel of what actually happened.
                logger.warning("comfyapi: cancel_and_notify failed for job %s", job_id, exc_info=True)

        return JSONResponse(content={})

    @r.get("/history")
    def get_history(
        max_items: Optional[int] = None, user: auth.SessionUser = Depends(auth.require_user)
    ) -> Response:
        """Scoped to `origin == "panel" AND user_id == <session uid>`,
        matching `POST /history`'s write scope: the panel's history is each
        user's own -- including an admin's -- and a job that this endpoint
        could never let its viewer hide (`panel_hidden` is set only by
        panel-origin history mutations, themselves scoped the same way) must
        never appear here in the first place. The console's all-seeing audit
        surface is `/api/jobs`, which ignores `panel_hidden`, `origin` and
        `user_id` alike.
        """
        with db.get_session() as session:
            numbers = _numbers_by_job_id(session)
            query = (
                session.query(db.Job)
                .filter(
                    db.Job.status.in_(_HISTORY_STATUSES),
                    db.Job.panel_hidden == False,  # noqa: E712
                    db.Job.origin == "panel",
                    db.Job.user_id == user.uid,
                )
                .order_by(db.Job.finished_at.asc(), db.Job.created_at.asc())
            )
            rows = query.all()
            if max_items is not None and max_items >= 0:
                rows = rows[-max_items:] if max_items else []
            out = {job.id: _history_entry(numbers.get(job.id, 0), job) for job in rows}
        return JSONResponse(content=out)

    @r.get("/history/{prompt_id}")
    def get_history_prompt_id(
        prompt_id: str, user: auth.SessionUser = Depends(auth.require_user)
    ) -> Response:
        with db.get_session() as session:
            job = session.get(db.Job, prompt_id)
            if (
                job is None
                or job.status not in _HISTORY_STATUSES
                or job.panel_hidden
                or job.origin != "panel"
                or job.user_id != user.uid
            ):
                # Upstream returns {} for an unknown prompt id, never a 404.
                return JSONResponse(content={})
            numbers = _numbers_by_job_id(session)
            out = {job.id: _history_entry(numbers.get(job.id, 0), job)}
        return JSONResponse(content=out)

    @r.post("/history")
    async def post_history(
        request: Request, user: auth.SessionUser = Depends(auth.require_user)
    ) -> Response:
        """ComfyUI-compat history mutation, mirroring `/queue`'s shapes:
        `{"delete": [prompt_ids]}` and `{"clear": true}` (verified against
        the shipped frontend dist -- `ComfyApi.deleteItem('history', id)`
        posts `{"delete": [id]}` and `clearItems('history')` posts
        `{"clear": true}`, both to `/history`).

        Unlike `/queue`, this never cancels or deletes anything -- it only
        sets `panel_hidden` on terminal, panel-origin jobs, so `GET
        /history` stops showing them while the row (and any receipt that
        references it) survives. Console's `/api/jobs` ignores
        `panel_hidden` entirely and keeps listing everything.
        """
        try:
            body = await request.json()
        except (ValueError, TypeError):
            body = None
        if not isinstance(body, dict):
            body = {}

        with db.get_session() as session:
            query = session.query(db.Job).filter(
                db.Job.status.in_(_HISTORY_STATUSES),
                db.Job.origin == "panel",
                db.Job.user_id == user.uid,
            )
            if not body.get("clear"):
                requested = body.get("delete")
                requested_ids = (
                    [pid for pid in requested if isinstance(pid, str)]
                    if isinstance(requested, list)
                    else []
                )
                if not requested_ids:
                    return JSONResponse(content={})
                query = query.filter(db.Job.id.in_(requested_ids))

            for job in query.all():
                job.panel_hidden = True
            session.commit()

        return JSONResponse(content={})

    @r.get("/view")
    def view(
        filename: str = "",
        type: str = "output",
        subfolder: str = "",
        user: auth.SessionUser = Depends(auth.require_user),
    ) -> Response:
        try:
            safe_name = storage.sanitize_path_component(filename, what="filename")
        except ValueError:
            return Response(status_code=400)

        if type == "input":
            # The staging area is namespaced per uid (final review finding
            # #1) -- there is no job, and therefore no `user_id`, to scope
            # this branch against yet at upload time, so the caller's OWN
            # staging directory is the scope instead. A subfolder here can
            # only be a traversal attempt or a request we cannot satisfy.
            if subfolder:
                return Response(status_code=404)
            path = os.path.join(staging_dir(data_dir, user.uid), safe_name)
            if not os.path.isfile(path):
                # Shared, packaged template samples are visible to every
                # user; anything else in another user's own namespace stays
                # unreachable here.
                path = os.path.join(staging_dir(data_dir, SHARED_STAGING_UID), safe_name)
            if not os.path.isfile(path):
                return Response(status_code=404)
            media_type = mimetypes.guess_type(safe_name)[0] or "application/octet-stream"
            return FileResponse(path, media_type=media_type, filename=safe_name)

        if type != "output":
            return Response(status_code=404)

        if subfolder:
            # The modern path: `subfolder` is the owning job id, as emitted by
            # `job_outputs` and round-tripped by the frontend out of history.
            # It is what disambiguates ComfyUI's recycled default output names
            # (`ComfyUI_00001_.png`) across jobs -- without it an old history
            # entry would be served whichever job most recently produced a
            # file of that name.
            try:
                job_id = storage.sanitize_path_component(subfolder, what="subfolder")
            except ValueError:
                return Response(status_code=400)
            with db.get_session() as session:
                job = session.get(db.Job, job_id)
                if (
                    job is None
                    or safe_name not in _result_files(job)
                    or job.origin != "panel"
                    or job.user_id != user.uid
                ):
                    return Response(status_code=404)
        else:
            # Legacy fallback for links minted before outputs carried a
            # subfolder: scan this user's OWN done panel jobs newest-first
            # for the filename -- same scope as every other panel-native
            # route, so this fallback can't be used to read another user's
            # (or the console's) artifact just by omitting `subfolder`.
            with db.get_session() as session:
                candidates = (
                    session.query(db.Job)
                    .filter(
                        db.Job.status == "done",
                        db.Job.origin == "panel",
                        db.Job.user_id == user.uid,
                    )
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

    # --- panel bootstrap ------------------------------------------------
    #
    # The stock frontend calls all of the following before it will render a
    # canvas at all, and it does not degrade gracefully when they 404: an
    # error body where it expects a list makes `GraphView` throw and the page
    # stays blank. They are answered here with the *empty* form of each
    # upstream shape, because none of them describes anything a federation
    # has: there is no single machine to report stats for, no `web/extensions`
    # directory, no model folders on the platform (models live on the
    # workers), and no bundled locale packs.
    #
    # Only panel settings are real, and only because a preference the editor
    # forgets on every reload is worse than useless. They persist to one JSON
    # file next to the database -- ComfyFed has a single admin, so upstream's
    # per-user split buys nothing.

    @r.get("/features")
    def features() -> Response:
        # Server feature flags; empty means "supports nothing optional",
        # which is the truthful answer and the one the frontend defaults to.
        return JSONResponse(content={})

    @r.get("/users")
    def users() -> Response:
        # Single-user mode: the frontend then never shows a user picker.
        return JSONResponse(content={"storage": "server", "migrated": False})

    @r.get("/extensions")
    def extensions() -> Response:
        # One real entry: a tiny JS module that hides the dead Comfy-cloud
        # login button (see `panel_ext/comfyfed.js`). The frontend fetches
        # this list and dynamically `import()`s every URL in it, which is
        # the sanctioned hook for panel-side tweaks -- `show_signin_button`
        # in `feature_flags` is dead code the frontend never reads.
        #
        # The path is deliberately WITHOUT the `/comfy` mount prefix: the
        # frontend joins every listed URL onto its own api base (`/comfy`),
        # so listing "/comfy/api/..." here would double the prefix into
        # `/comfy/comfy/api/...` and 404 (caught live, Phase 1.10).
        return JSONResponse(content=["/api/comfyfed-ext/comfyfed.js"])

    @r.get("/comfyfed-ext/comfyfed.js", include_in_schema=False)
    def comfyfed_extension_js() -> Response:
        # Packaged the same way as `templates_data/` (see `templates.py`):
        # `importlib.resources` off the package, so a source checkout and an
        # installed wheel both resolve to the same bytes.
        path = str(resources.files(__package__).joinpath("panel_ext", "comfyfed.js"))
        return FileResponse(path, media_type="application/javascript")

    @r.get("/embeddings")
    def embeddings() -> Response:
        return JSONResponse(content=[])

    @r.get("/models")
    def models() -> Response:
        return JSONResponse(content=[])

    @r.get("/i18n")
    def custom_node_i18n() -> Response:
        return JSONResponse(content={})

    @r.get("/global_subgraphs")
    def global_subgraphs() -> Response:
        return JSONResponse(content={})

    @r.get("/folder_paths")
    def folder_paths() -> Response:
        # The missing-model locate-flow calls this to suggest which folder a
        # model might belong in; there are no model folders on the platform
        # (models live on the workers), so an empty dict -- no suggestions --
        # is the truthful answer, same rationale as `/models` above.
        return JSONResponse(content={})

    @r.get("/system_stats")
    def system_stats() -> Response:
        """Upstream's shape, filled in for a platform that owns no GPU.

        `devices: []` is honest -- the compute is on the workers, and the
        console's own Workers page is where a human should look for it.
        """
        with db.get_session() as session:
            online = (
                session.query(db.Worker)
                .filter(db.Worker.disabled == False)  # noqa: E712
                .filter(db.Worker.status != "offline")
                .count()
            )
        return JSONResponse(
            content={
                "system": {
                    "os": "comfyfed",
                    "comfyui_version": "comfyfed",
                    "python_version": "",
                    "pytorch_version": "",
                    "embedded_python": False,
                    "argv": [],
                    "comfyfed_online_workers": online,
                },
                "devices": [],
            }
        )

    @r.get("/prompt")
    def prompt_status() -> Response:
        # Polled roughly once a second by the frontend for its queue badge.
        return JSONResponse(content=panelws.queue_status())

    @r.get("/settings")
    def get_settings(user: auth.SessionUser = Depends(auth.require_user)) -> Response:
        return JSONResponse(content=_load_settings(data_dir, user.uid))

    @r.get("/settings/{setting_id}")
    def get_setting(
        setting_id: str, user: auth.SessionUser = Depends(auth.require_user)
    ) -> Response:
        # Upstream answers `null` (not 404) for a setting never written.
        return JSONResponse(content=_load_settings(data_dir, user.uid).get(setting_id))

    @r.post("/settings")
    async def post_settings(
        request: Request, user: auth.SessionUser = Depends(auth.require_user)
    ) -> Response:
        try:
            incoming = await request.json()
        except (ValueError, TypeError):
            return Response(status_code=400)
        if not isinstance(incoming, dict):
            return Response(status_code=400)
        _save_settings(data_dir, user.uid, {**_load_settings(data_dir, user.uid), **incoming})
        return Response(status_code=200)

    @r.post("/settings/{setting_id}")
    async def post_setting(
        setting_id: str,
        request: Request,
        user: auth.SessionUser = Depends(auth.require_user),
    ) -> Response:
        try:
            value = await request.json()
        except (ValueError, TypeError):
            return Response(status_code=400)
        settings = _load_settings(data_dir, user.uid)
        settings[setting_id] = value
        _save_settings(data_dir, user.uid, settings)
        return Response(status_code=200)

    return r


def create_ws_router() -> APIRouter:
    """Build the panel WebSocket router (`/comfy/ws`, `/comfy/api/ws`).

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

    Served at BOTH `/comfy/api/ws` and `/comfy/ws`. The stock frontend builds
    its socket URL as `api_base + "/ws"` -- not via `apiURL()`, which is what
    prefixes `/api` onto every other call -- so a panel served at `/comfy/`
    connects to `/comfy/ws`. Upstream ComfyUI has the same split (its `/ws`
    lives at the root while `/api/ws` is the mirrored alias); here `/comfy/ws`
    is the one the frontend actually uses and `/comfy/api/ws` is kept as the
    explicit, documented address.
    """
    r = APIRouter()

    @r.websocket("/comfy/api/ws")
    @r.websocket("/comfy/ws")
    async def panel_ws(websocket: WebSocket) -> None:
        await websocket.accept()

        # Phase 3.0 Task 4: any authenticated, non-disabled user may open the
        # panel socket now, not just admin -- `resolve_session_user` already
        # applies the disabled/stale-epoch checks `require_user` would, it
        # just returns `None` instead of raising, which is what lets this
        # handshake answer with a close code rather than an HTTPException
        # (see this router's docstring). The resolved uid is remembered on
        # the connection (`panelws.register`) so `panelws.post_event` can
        # scope every job-specific frame to this socket's own jobs.
        with db.get_session() as db_session:
            user = auth.resolve_session_user(db_session, websocket)
        if user is None:
            await websocket.close(code=_CLOSE_UNAUTHORIZED)
            return

        sid = panelws.register(websocket, uid=user.uid)
        try:
            await websocket.send_json(
                {"type": "status", "data": {"status": panelws.queue_status(), "sid": sid}}
            )
            # Right after the initial status: the pinned frontend gates a
            # handful of UI affordances on these, and answering unprompted
            # (rather than waiting for a request) matches upstream's own
            # connect behavior. See `panelws.FEATURE_FLAGS` for what each
            # one means and why every one of them is false here.
            await websocket.send_json({"type": "feature_flags", "data": panelws.FEATURE_FLAGS})
            while True:
                # The panel client only ever listens; any inbound message --
                # including the `feature_flags` frame the frontend announces
                # its own capabilities with on open -- is simply discarded
                # here, same as everything else. The disconnect this
                # eventually raises just ends the loop.
                await websocket.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            panelws.unregister(sid)

    return r
