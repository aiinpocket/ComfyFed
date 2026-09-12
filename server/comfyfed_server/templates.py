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
ours sets both, so the three templates always have a home.

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
"""

from __future__ import annotations

import logging
import os
import shutil
from importlib import resources

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)

_DATA_DIRNAME = "templates_data"
_ASSETS_SUBDIR = "assets"

# The three templates the library ships, in the order `index.json` lists them.
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
}

TEMPLATE_NAMES = (
    "comfyfed-wuxia-t2i",
    "comfyfed-character-portrait",
    "comfyfed-ref2v-video",
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


def create_router() -> APIRouter:
    """Serve `templates_data/` at `/comfy/templates/...`.

    A plain route rather than a `StaticFiles` mount, because the panel's own
    static mount already owns `/comfy` and is registered later; routes are
    matched before it, so this one wins for the template paths and the SPA
    bundle keeps everything else.
    """
    r = APIRouter()

    @r.get("/comfy/templates/{filename}", include_in_schema=False)
    def template_file(filename: str) -> FileResponse:
        # No subpaths: the frontend only ever asks for files directly under
        # `templates/`, so anything with a separator in it is a traversal
        # attempt rather than a legitimate request.
        if not filename or filename in (".", "..") or "/" in filename or "\\" in filename:
            raise HTTPException(status_code=404, detail="Not found")
        path = os.path.join(templates_dir(), filename)
        if not os.path.isfile(path):
            raise HTTPException(status_code=404, detail="Not found")
        extension = os.path.splitext(filename)[1].lower()
        return FileResponse(path, media_type=_MEDIA_TYPES.get(extension, "application/octet-stream"))

    return r
