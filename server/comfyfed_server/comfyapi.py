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
from collections import OrderedDict
from typing import Callable, Optional

from fastapi import APIRouter, Depends, File, Form, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, Response

from . import agentws, assess, auth, db, jobs, model_guide, panelws, storage, workers

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

# Flat staging area for images/masks/audio uploaded through the ComfyUI
# frontend's upload widgets, ahead of being referenced by a submitted prompt.
# Unlike ComfyUI's own `input/`, there are no subfolders: a name here is
# reusable across any number of prompts (see `_default_resolve_asset`), and
# staged files are never cleaned up automatically -- Phase 1.5 leaves that
# to the admin.
_STAGING_DIRNAME = "comfy_staging"

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


def staging_dir(data_dir: str) -> str:
    return os.path.join(data_dir, _STAGING_DIRNAME)


def _settings_path(data_dir: str) -> str:
    return os.path.join(data_dir, _SETTINGS_FILENAME)


def _load_settings(data_dir: str) -> dict:
    try:
        with open(_settings_path(data_dir), "r", encoding="utf-8") as f:
            loaded = json.load(f)
    except (OSError, ValueError):
        return {}
    return loaded if isinstance(loaded, dict) else {}


def _save_settings(data_dir: str, values: dict) -> None:
    os.makedirs(data_dir, exist_ok=True)
    with open(_settings_path(data_dir), "w", encoding="utf-8") as f:
        json.dump(values, f, ensure_ascii=False, indent=1, sort_keys=True)


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

    Deliberately fleet-wide rather than "every worker that happens to be
    online right now": the classic home federation is one big GPU box holding
    every model plus a small always-on box holding none, and refusing a prompt
    during the GPU box's ten-minute reboot -- for models the user already owns
    -- is strictly worse than queueing it. Every registered worker row counts,
    whatever its `status` and whether or not it is disabled, so a sleeping or
    temporarily-disabled machine still vouches for its inventory. Only a model
    that exists nowhere in the federation is a real dead end, and that is what
    the admin can actually act on.

    Matching is `assess.find_model`, i.e. `assess.matches_model_name`
    semantics, so a worker's `diffusion_models/flux1-dev.safetensors`
    satisfies a workflow's `flux1-dev.safetensors`.

    Node classes are computed the same way and returned alongside, because a
    fleet missing both would otherwise send the admin off to download 22 GB
    for a job that still cannot run (see `post_prompt`, which appends a
    節點 line to the guidance). A worker reporting an EMPTY `node_classes`
    list means "unknown", not "supports nothing" -- same rule as
    `assess.verdict` -- so such workers are skipped for the node check, and
    if that leaves no informative worker the node set comes back empty.

    With zero workers registered both sets are empty: an install that has
    never had an agent connect keeps today's queue-and-wait behavior.
    """
    with db.get_session() as session:
        all_workers = session.query(db.Worker).all()
        if not all_workers:
            return set(), set()
        inventories = [assess.model_inventory(w) for w in all_workers]
        node_class_sets = [
            classes for classes in (set(assess.worker_node_classes(w)) for w in all_workers)
            if classes
        ]

    missing_models = {
        name
        for name in needs.models
        if not any(assess.find_model(inventory, name)[0] for inventory in inventories)
    }

    missing_nodes: set[str] = set()
    if node_class_sets:
        missing_nodes = {
            node for node in needs.nodes
            if not any(node in classes for classes in node_class_sets)
        }

    return missing_models, missing_nodes


def staged_image_names(data_dir: str) -> list[str]:
    """Sorted filenames currently sitting in the panel's staging directory."""
    try:
        staging = staging_dir(data_dir)
        return sorted(
            name for name in os.listdir(staging)
            if os.path.isfile(os.path.join(staging, name))
        )
    except OSError:
        return []


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
    resolve_asset: Optional[Callable[[str], Optional[str]]] = None,
) -> APIRouter:
    """Build the `/comfy/api` router.

    `resolve_asset(filename) -> path | None` given a filename a submitted
    prompt references, returns a local path to copy into the job's inputs, or
    None if the file is unavailable. Defaults to `_default_resolve_asset`,
    which looks the name up in `<data_dir>/comfy_staging/`; tests pass their
    own to isolate themselves from the filesystem.
    """
    global _data_dir
    _data_dir = data_dir

    resolver = resolve_asset if resolve_asset is not None else (
        lambda name: _default_resolve_asset(data_dir, name)
    )

    r = APIRouter(prefix="/comfy/api", dependencies=[Depends(auth.require_admin)])

    @r.get("/object_info")
    def object_info() -> Response:
        with db.get_session() as session:
            fleet = _online_worker_hashes(session)

        if not fleet:
            return JSONResponse(
                content={},
                headers={"X-ComfyFed-No-Workers": "1", _WORKER_COUNT_HEADER: "0"},
            )

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

        return JSONResponse(
            content=_with_staged_images(cached, staged_image_names(data_dir)),
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

        blocking, missing_nodes = _fleet_wide_gaps(needs)
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
            return _comfy_error(
                "prompt.missing_models",
                model_guide.guidance_summary(names),
                guidance,
            )

        resolved: dict[str, str] = {}
        for name in sorted(needs.assets):
            path = resolver(name)
            if path:
                resolved[name] = path

        try:
            job_id = jobs.create_job(
                json.dumps(prompt), prompt, available_assets=set(resolved), origin="panel"
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

    @r.post("/interrupt")
    async def post_interrupt() -> Response:
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
                .filter(db.Job.status.in_(_RUNNING_STATUSES), db.Job.origin == "panel")
                .order_by(db.Job.created_at.asc())
                .first()
            )
            job_id = job.id if job is not None else None

        if job_id:
            await agentws.cancel_and_notify(job_id, reason="interrupted from panel")

        return JSONResponse(content={})

    @r.post("/queue")
    async def post_queue(request: Request) -> Response:
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
                        .filter(db.Job.id.in_(requested_ids), db.Job.origin == "panel")
                        .all()
                    ]
            else:
                job_ids = []

        for job_id in job_ids:
            await agentws.cancel_and_notify(job_id, reason="removed from panel queue")

        return JSONResponse(content={})

    @r.get("/history")
    def get_history(max_items: Optional[int] = None) -> Response:
        with db.get_session() as session:
            numbers = _numbers_by_job_id(session)
            query = (
                session.query(db.Job)
                .filter(db.Job.status.in_(_HISTORY_STATUSES), db.Job.panel_hidden == False)  # noqa: E712
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
            if job is None or job.status not in _HISTORY_STATUSES or job.panel_hidden:
                # Upstream returns {} for an unknown prompt id, never a 404.
                return JSONResponse(content={})
            numbers = _numbers_by_job_id(session)
            out = {job.id: _history_entry(numbers.get(job.id, 0), job)}
        return JSONResponse(content=out)

    @r.post("/history")
    async def post_history(request: Request) -> Response:
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
                db.Job.status.in_(_HISTORY_STATUSES), db.Job.origin == "panel"
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
    def view(filename: str = "", type: str = "output", subfolder: str = "") -> Response:
        try:
            safe_name = storage.sanitize_path_component(filename, what="filename")
        except ValueError:
            return Response(status_code=400)

        if type == "input":
            # The staging area is genuinely flat, so a subfolder there can
            # only be a traversal attempt or a request we cannot satisfy.
            if subfolder:
                return Response(status_code=404)
            path = os.path.join(staging_dir(data_dir), safe_name)
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
                if job is None or safe_name not in _result_files(job):
                    return Response(status_code=404)
        else:
            # Legacy fallback for links minted before outputs carried a
            # subfolder: scan done jobs newest-first for the filename.
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
        return JSONResponse(content=[])

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
    def get_settings() -> Response:
        return JSONResponse(content=_load_settings(data_dir))

    @r.get("/settings/{setting_id}")
    def get_setting(setting_id: str) -> Response:
        # Upstream answers `null` (not 404) for a setting never written.
        return JSONResponse(content=_load_settings(data_dir).get(setting_id))

    @r.post("/settings")
    async def post_settings(request: Request) -> Response:
        try:
            incoming = await request.json()
        except (ValueError, TypeError):
            return Response(status_code=400)
        if not isinstance(incoming, dict):
            return Response(status_code=400)
        _save_settings(data_dir, {**_load_settings(data_dir), **incoming})
        return Response(status_code=200)

    @r.post("/settings/{setting_id}")
    async def post_setting(setting_id: str, request: Request) -> Response:
        try:
            value = await request.json()
        except (ValueError, TypeError):
            return Response(status_code=400)
        settings = _load_settings(data_dir)
        settings[setting_id] = value
        _save_settings(data_dir, settings)
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

        payload = auth.read_session_payload(websocket.cookies.get(auth.SESSION_COOKIE_NAME))
        if not payload or not payload.get("authenticated"):
            await websocket.close(code=_CLOSE_UNAUTHORIZED)
            return

        sid = panelws.register(websocket)
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
