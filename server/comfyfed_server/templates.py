"""ComfyFed's own workflow-template library, served to the embedded frontend.

The stock ComfyUI frontend has a built-in template browser. In real ComfyUI it
is fed by the separate `comfyui-workflow-templates` package; the frontend does
not know or care where the bytes come from, it just issues two calls whose
shapes were read out of the bundled `api-*.js` / `settingStore-*.js` chunks of
`comfyui-frontend-package` 1.52.7:

* `GET <api_base>/templates/index.json` -- the *core* template catalogue, via
  `fileURL()`, i.e. relative to the page, NOT the `/api` prefix. Served at
  `/comfy/` the panel therefore asks for `/comfy/templates/index.json`. With a
  non-English UI locale it asks for `index.<locale>.json` first and falls back
  to `index.json` on any error, so shipping only the English index is fine.
  A response whose `content-type` is not JSON is treated as "no templates".
* `GET <api_base>/api/workflow_templates` -- the custom-node template map,
  `{module_name: [names]}`. Answered as `{}` by `comfyapi`: ComfyFed has no
  custom-node packs of its own, and the frontend needs the call to succeed
  before it will fetch the core index at all.

`index.json` is a LIST OF CATEGORIES, each `{moduleName, title, type,
templates: [...]}`. `moduleName` must be `"default"`: that is the value the
frontend checks before it resolves a template's workflow and thumbnail through
`fileURL('/templates/<name>...')` rather than through the custom-node API. A
category is only reachable in the browser's sidebar when it is either
`isEssential` (rendered as its own entry) or carries a `category` group name --
ours sets both, so the templates always have a home.

Per template the frontend reads `name` (the file stem), `title`,
`description`, `mediaType`/`mediaSubtype` (which build the thumbnail URL
`/templates/<name>-1.<mediaSubtype>`), and the optional `tags`/`models` that
feed its search box. The workflow itself is `/templates/<name>.json` in
ComfyUI's *UI* (graph) format -- nodes with `pos`/`size`/`widgets_values`,
a flat `links` array and `groups` -- not the API format a prompt submission
uses.

Everything lives in `templates_data/` as package data so a wheel carries it,
and is served under `/comfy/`, which the app's session gate already covers.
`templates_data/assets/` holds the input images the templates reference; they
are copied into the panel's staging directory at startup (`seed_staging`) so a
template's `LoadImage` resolves on the very first run.

Since Phase 1.6 Task 2, `/comfy/templates/...` also merges in the official
ComfyUI template library fetched by `official_templates.fetch` (when an admin
has run it) into `<data_dir>/comfy_templates_official`:

* `index.json` -- ComfyFed's own categories (always our packaged copy, kept
  first so the 平台專用分類 stays visually distinct in the sidebar) followed by
  the official library's categories, if `official_dir/index.json` exists and
  parses. Otherwise ComfyFed's categories are served alone, same as before
  this feature existed.
* `index.<locale>.json` -- merged the same way, but only if the official
  dir has that exact localized index; if not, this route 404s and the
  frontend's own fallback logic re-requests `index.json`.
* `index_logo.json` -- served **only** from the official dir; with no
  official copy present this always 404s (soft-fails client-side), even
  though ComfyFed ships its own placeholder file under `templates_data/` for
  historical reasons.
* Any other `*.json` -- resolved from the packaged dir first, then the
  official dir. A JSON file that comes from the official dir has `url`,
  `hash`, and `hash_type` stripped (keeping `name` + `directory`) from every
  entry of **`nodes[].properties.models`** -- the shape the real official
  library actually uses -- and, as a harmless superset, from a top-level
  `models` list too. The frontend's `hasDownloadMetadata` check
  (`settingStore-*.js`: `!!candidate.url && !!candidate.directory`) is
  applied to the missing-model candidates built by `getEmbeddedModels`
  (`node.properties?.models`), so the per-node location is the one that
  decides whether its browser-side "Download" button renders. In web mode
  that button is a plain `<a href>` that lands the file on the *viewer's*
  PC, not the worker actually running the graph -- so it would silently
  mislead a ComfyFed user. Stripping only the download keys (not the whole
  entry) keeps the model `name` visible to the missing-model panel; Task 3's
  `/prompt` rejection is where a worker-side download nudge actually
  belongs. ComfyFed's own template JSONs never carry download metadata
  (their guidance lives in sticky notes instead) so they pass through this
  step unchanged regardless of source.
* Non-JSON files (thumbnails/media) -- packaged dir first, then official
  dir, same `_MEDIA_TYPES` mapping. No subpaths are ever allowed in
  `filename`, from either source.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
from collections import OrderedDict
from importlib import resources

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, JSONResponse

from . import official_templates

logger = logging.getLogger(__name__)

_DATA_DIRNAME = "templates_data"
_ASSETS_SUBDIR = "assets"

# The templates the library ships, in the order `index.json` lists them. The
# first three carry several models each (loader nodes + a "缺模型？" note);
# the next two are zero-model templates (LoadVideo/LoadImage + video-
# compositing nodes only) that a brand-new worker can run with nothing
# downloaded; the next two (Phase 1.8b) carry exactly one model each (the
# shared Qwen3-VL text/vision encoder) behind their own "缺模型？" note. Phase
# 1.10 Task 1 added three more: comfyfed-flf2v-video (the same five-model H3
# stack as comfyfed-ref2v-video, first+last frame conditioning), comfyfed-
# video-trim (a third zero-model template), and comfyfed-image-upscale (one
# curated model, RealESRGAN_x4plus.pth).
# Content types stated outright rather than via `mimetypes`, whose Windows
# backend answers from the registry: there, `.webp` is frequently unknown and
# `.json` can come back as `text/plain`. The frontend *checks* that
# `templates/index.json` is served as JSON and silently shows an empty browser
# when it is not, so this cannot be left to the host's file associations.
_MEDIA_TYPES = {
    ".json": "application/json",
    ".webp": "image/webp",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".gif": "image/gif",
    # The official index has a handful of `{"mediaType":"audio",
    # "mediaSubtype":"mp3"}` templates whose preview will not play if the
    # thumbnail route falls through to application/octet-stream.
    ".mp3": "audio/mpeg",
}

# Files under the official dir that are library bookkeeping, not templates.
_NON_TEMPLATE_NAMES = frozenset({official_templates.MANIFEST_NAME})

TEMPLATE_NAMES = (
    "comfyfed-wuxia-t2i",
    "comfyfed-character-portrait",
    "comfyfed-ref2v-video",
    "comfyfed-video-concat",
    "comfyfed-image-intro-video",
    "comfyfed-image-to-prompt",
    "comfyfed-text-to-prompt",
    "comfyfed-flf2v-video",
    "comfyfed-video-trim",
    "comfyfed-image-upscale",
)


def templates_dir() -> str:
    """Filesystem path of the packaged `templates_data/` directory.

    Resolved through `importlib.resources` off the *package* (rather than
    treating `templates_data` as an importable sub-package, which it is not:
    it has no `__init__.py`, it is package data), so an installed wheel and a
    source checkout both answer the same way.
    """
    return str(resources.files(__package__).joinpath(_DATA_DIRNAME))


def assets_dir() -> str:
    return os.path.join(templates_dir(), _ASSETS_SUBDIR)


def asset_names() -> list[str]:
    """Sorted filenames of the input assets shipped with the templates."""
    try:
        return sorted(
            name for name in os.listdir(assets_dir())
            if os.path.isfile(os.path.join(assets_dir(), name))
        )
    except OSError:
        return []


def seed_staging(staging_dir: str) -> list[str]:
    """Copy packaged template assets into `staging_dir` if not already there.

    Returns the names actually copied. Existing files are left alone: the
    admin may have replaced one deliberately, and re-copying on every start
    would undo that. Failures are logged, never raised -- a missing thumbnail
    asset must not stop the server from booting.
    """
    copied: list[str] = []
    for name in asset_names():
        target = os.path.join(staging_dir, name)
        if os.path.exists(target):
            continue
        try:
            os.makedirs(staging_dir, exist_ok=True)
            shutil.copyfile(os.path.join(assets_dir(), name), target)
        except OSError as exc:
            logger.warning("comfyfed_server: could not seed template asset %s: %s", name, exc)
            continue
        copied.append(name)
    return copied


def _load_json(path: str) -> list | dict | None:
    """Best-effort JSON read; None on any missing/unreadable/malformed file."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


# (path -> (mtime, parsed JSON)) cache for the index files: `index.json` and
# `index.<locale>.json`, packaged and official copies alike. Each source file
# is its OWN independent cache entry, keyed on its own path/mtime -- there is
# no single combined key for "the packaged file + the official file"; a
# caller like `_merged_index` looks up the packaged and official paths as two
# separate `_load_json_cached` calls and concatenates their (independently
# cached) results fresh on every request. So a change to only one side (e.g.
# a fresh `official_templates.fetch()`) invalidates only that side's entry,
# not the other's. The key space is a small, fixed set of literal filenames
# (unlike the per-workflow cache below, this is never one entry per request),
# so a plain unbounded dict is fine -- mirrors `model_guide.harvest`'s (mtime
# signature, result) cache. Plain dict + mtime compare, no locks needed:
# FastAPI's threadpool may run this concurrently, but a rebuild is idempotent
# (worst case two threads re-read the same unchanged file and one write
# clobbers the other with an equal value), so nothing corrupts.
_index_json_cache: dict[str, tuple[float, list | dict | None]] = {}


def _load_json_cached(path: str) -> list | dict | None:
    """`_load_json` for a single file, memoized on `path`'s own mtime so a
    second request for that unchanged file does zero re-reads. Each `path` is
    an independent cache entry (see `_index_json_cache` above) -- this is not
    a combined cache over several files at once. A file that starts missing
    (no mtime) or goes missing between calls is never cached -- there is
    nothing to invalidate against, so it is simplest to just re-check every
    time."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        _index_json_cache.pop(path, None)
        return None

    cached = _index_json_cache.get(path)
    if cached is not None and cached[0] == mtime:
        return cached[1]

    data = _load_json(path)
    _index_json_cache[path] = (mtime, data)
    return data


_DOWNLOAD_KEYS = ("url", "hash", "hash_type")


def _strip_download_metadata(workflow):
    """Drop `url`/`hash`/`hash_type` from every model entry the frontend could
    turn into a Download button, keeping `name` + `directory`.

    The walk is fully recursive rather than enumerating known locations,
    because the real library keeps model metadata in more places than the
    obvious ones: `nodes[].properties.models` for plain graphs, a top-level
    `models` list in the documented schema, and -- the one live verification
    caught after the enumerating version shipped -- inside
    `definitions.subgraphs[].nodes[].properties.models` for workflows built
    around subgraphs (e.g. `image_z_image_turbo`). Any dict's `models` key
    whose value is a list gets its dict entries stripped; entries without a
    `name` are left untouched (they are not model records), and non-dict
    entries (the index's plain-string model *names*) pass through unchanged.
    """
    if isinstance(workflow, list):
        return [_strip_download_metadata(item) for item in workflow]
    if not isinstance(workflow, dict):
        return workflow

    result = {}
    for key, value in workflow.items():
        if key == "models" and isinstance(value, list):
            result[key] = [
                {k: v for k, v in entry.items() if k not in _DOWNLOAD_KEYS}
                if isinstance(entry, dict) and "name" in entry
                else entry
                for entry in value
            ]
        else:
            result[key] = _strip_download_metadata(value)
    return result


# (path -> (mtime, stripped JSON)) cache for official workflow files, bounded
# LRU: the official library can carry hundreds of `<name>.json` workflows, so
# an unbounded cache (unlike `_index_json_cache` above, whose key space is a
# handful of literal index filenames) would hold every one ever served for
# the process lifetime. `_MAX_STRIPPED_CACHE` caps it; the oldest entry is
# evicted first via `OrderedDict.move_to_end`/`popitem(last=False)`. Plain
# dict + mtime compare, no locks: FastAPI's threadpool may run this
# concurrently, but a rebuild is idempotent, so a race just re-strips the
# same file twice rather than corrupting anything.
_MAX_STRIPPED_CACHE = 256
_stripped_workflow_cache: "OrderedDict[str, tuple[float, dict]]" = OrderedDict()


def _cached_stripped_workflow(path: str) -> dict | None:
    """`_strip_download_metadata(_load_json(path))`, memoized on `path`'s
    mtime -- None if the file is missing/unreadable/malformed or not a JSON
    object (a workflow is always a dict; anything else is not our shape)."""
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        _stripped_workflow_cache.pop(path, None)
        return None

    cached = _stripped_workflow_cache.get(path)
    if cached is not None and cached[0] == mtime:
        _stripped_workflow_cache.move_to_end(path)
        return cached[1]

    workflow = _load_json(path)
    if not isinstance(workflow, dict):
        _stripped_workflow_cache.pop(path, None)
        return None

    stripped = _strip_download_metadata(workflow)
    _stripped_workflow_cache[path] = (mtime, stripped)
    _stripped_workflow_cache.move_to_end(path)
    while len(_stripped_workflow_cache) > _MAX_STRIPPED_CACHE:
        _stripped_workflow_cache.popitem(last=False)
    return stripped


def _merged_index(data_dir: str, index_name: str) -> list | None:
    """ComfyFed's categories from `index_name` (packaged) followed by the
    official library's categories from the same-named file in `official_dir`,
    if it exists and parses. None if neither side has anything to serve."""
    ours = _load_json_cached(os.path.join(templates_dir(), index_name))
    official = _load_json_cached(os.path.join(official_templates.official_dir(data_dir), index_name))

    if not isinstance(official, list):
        if official is not None:
            logger.debug("comfyfed_server: official %s is not a list of categories, ignoring", index_name)
        return ours

    ours_list = ours if isinstance(ours, list) else []
    return ours_list + official


def create_router(data_dir: str) -> APIRouter:
    """Serve `templates_data/`, merged with the official template library
    fetched into `official_templates.official_dir(data_dir)`, at
    `/comfy/templates/...`. See the module docstring for the merge rules.

    A plain route rather than a `StaticFiles` mount, because the panel's own
    static mount already owns `/comfy` and is registered later; routes are
    matched before it, so this one wins for the template paths and the SPA
    bundle keeps everything else.
    """
    r = APIRouter()

    @r.get("/comfy/templates/{filename}", include_in_schema=False)
    def template_file(filename: str):
        # No subpaths: the frontend only ever asks for files directly under
        # `templates/`, so anything with a separator in it is a traversal
        # attempt rather than a legitimate request. `:` is rejected too --
        # on Windows `os.path.join(dir, "C:x.json")` yields the *drive-
        # relative* `C:x.json`, which escapes both template roots.
        if (
            not filename
            or filename in (".", "..")
            or "/" in filename
            or "\\" in filename
            or ":" in filename
        ):
            raise HTTPException(status_code=404, detail="Not found")

        # Library bookkeeping is not a template and is not served.
        if filename in _NON_TEMPLATE_NAMES:
            raise HTTPException(status_code=404, detail="Not found")

        official_dir = official_templates.official_dir(data_dir)

        if filename == "index_logo.json":
            logo = _load_json(os.path.join(official_dir, filename))
            if logo is None:
                raise HTTPException(status_code=404, detail="Not found")
            return JSONResponse(logo)

        if filename == "index.json":
            merged = _merged_index(data_dir, filename)
            if merged is None:
                raise HTTPException(status_code=404, detail="Not found")
            return JSONResponse(merged)

        if filename.startswith("index.") and filename.endswith(".json") and filename != "index.json":
            official = _load_json_cached(os.path.join(official_dir, filename))
            if not isinstance(official, list):
                raise HTTPException(status_code=404, detail="Not found")
            ours = _load_json_cached(os.path.join(templates_dir(), "index.json"))
            ours_list = ours if isinstance(ours, list) else []
            return JSONResponse(ours_list + official)

        extension = os.path.splitext(filename)[1].lower()

        path = os.path.join(templates_dir(), filename)
        source = "packaged" if os.path.isfile(path) else None
        if source is None:
            official_path = os.path.join(official_dir, filename)
            if os.path.isfile(official_path):
                path = official_path
                source = "official"

        if source is None:
            raise HTTPException(status_code=404, detail="Not found")

        media_type = _MEDIA_TYPES.get(extension, "application/octet-stream")

        if source == "official" and extension == ".json":
            stripped = _cached_stripped_workflow(path)
            if stripped is not None:
                return JSONResponse(stripped)

        return FileResponse(path, media_type=media_type)

    return r
