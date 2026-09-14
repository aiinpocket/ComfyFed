"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from . import (
    agentws,
    auth,
    bootstrap,
    comfy_frontend,
    comfyapi,
    db,
    installer_routes,
    jobs,
    metrics,
    model_manifest,
    peer,
    receipts,
    templates,
    users,
    workers,
)

logger = logging.getLogger(__name__)

_WEB_DIST_ENV_VAR = "COMFYFED_WEB_DIST"

_COMFY_PREFIX = "/comfy"
_COMFY_API_PREFIX = "/comfy/api"

# Shown at `/comfy` when the operator has not fetched the frontend bundle yet.
# Deliberately a self-contained, dependency-free page: the console's own SPA
# is a different app, and this has to render even if `web/dist` is missing.
_COMFY_NOTICE_HTML = """<!doctype html>
<html lang="zh-TW"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ComfyFed — 工作流編輯器尚未安裝 / Workflow editor not installed</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#0f1115;color:#e6e8ec;font:15px/1.65 system-ui,"Noto Sans TC",sans-serif}
 main{max-width:44rem;padding:2.5rem}
 h1{font-size:1.3rem;margin:0 0 1.2rem}
 h2{font-size:1rem;margin:1.8rem 0 .5rem;color:#9aa4b2;font-weight:600}
 code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 pre{background:#171a21;border:1px solid #262b36;border-radius:8px;padding:.9rem 1rem;overflow-x:auto}
 a{color:#7aa2f7}
 p{margin:.5rem 0}
</style></head><body><main>
<h1>工作流編輯器尚未安裝 / Workflow editor not installed</h1>
<h2>繁體中文</h2>
<p>內嵌的 ComfyUI 工作流編輯器需要先把官方前端靜態檔抓下來。請在伺服器上執行：</p>
<pre>comfyfed-server fetch-comfy-ui --data-dir &lt;你的 data 目錄&gt;</pre>
<p>抓完之後<strong>重新啟動伺服器</strong>，再回到這一頁即可。</p>
<h2>English</h2>
<p>The embedded ComfyUI workflow editor needs the official frontend bundle. On the server, run:</p>
<pre>comfyfed-server fetch-comfy-ui --data-dir &lt;your data dir&gt;</pre>
<p>Then <strong>restart the server</strong> and reload this page.</p>
<p><a href="/">&larr; 回到 Console / Back to the console</a></p>
</main></body></html>
"""


def _error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        body = _error_body(detail["code"], detail.get("message", detail["code"]))
    else:
        body = _error_body("http_error", str(detail))
    return JSONResponse(status_code=exc.status_code, content=body)


async def _validation_exception_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    """Render FastAPI's request-validation errors in the same error envelope.

    Without this, a malformed body/query returns FastAPI's default
    `{"detail": [...]}` shape, which the console's `parseError` cannot read --
    so a validation failure surfaced as a bare "http_error" with no message.
    """
    try:
        first = exc.errors()[0]
        location = ".".join(str(part) for part in first.get("loc", ()) if part != "body")
        message = f"{location}: {first.get('msg', 'invalid')}" if location else str(first.get("msg", "invalid"))
    except Exception:
        message = "Request validation failed."
    return JSONResponse(status_code=422, content=_error_body("validation_error", message))


def _find_web_dist() -> str | None:
    """Locate the built SPA's `web/dist` directory.

    Checked in order: the `COMFYFED_WEB_DIST` env var override, then the path
    relative to this package's location in the repo layout
    (`server/comfyfed_server/app.py` -> `../../web/dist`). Returns None (and
    the caller logs a warning) if neither exists, so tests and API-only
    deployments never require the SPA to be built.
    """
    override = os.environ.get(_WEB_DIST_ENV_VAR)
    if override and os.path.isdir(override):
        return override

    here = os.path.dirname(os.path.abspath(__file__))
    candidate = os.path.normpath(os.path.join(here, "..", "..", "web", "dist"))
    if os.path.isdir(candidate):
        return candidate

    return None


def create_app(data_dir: str) -> FastAPI:
    """Build the ComfyFed server FastAPI app.

    Assumes the server has already been installed via `comfyfed-server install`
    (or a prior `bootstrap.ensure_installed(...)` call, as tests do). If the
    server is not yet installed, this raises rather than silently installing
    with a password nobody sees.
    """
    db.init_db(os.path.join(data_dir, bootstrap._DB_FILENAME))
    with db.get_session() as session:
        installed = bootstrap._is_installed(session)

    if not installed:
        raise RuntimeError(
            "ComfyFed server is not installed yet. Run `comfyfed-server install` first."
        )

    bootstrap.ensure_installed(data_dir, lang=None, url=None, interactive=False)
    metrics.init()

    # Put the template library's input images where every user's panel looks
    # for uploads, so a freshly opened template's `LoadImage` already
    # resolves for any account -- the shared pseudo-uid namespace, not any
    # one user's own staging directory (final review finding #1).
    seeded = templates.seed_staging(comfyapi.staging_dir(data_dir, comfyapi.SHARED_STAGING_UID))
    if seeded:
        logger.info("comfyfed_server: seeded template assets into staging: %s", ", ".join(seeded))

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        task = agentws.start_background_task()
        try:
            yield
        finally:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    app = FastAPI(title="ComfyFed", lifespan=lifespan)
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.add_exception_handler(RequestValidationError, _validation_exception_handler)
    app.include_router(auth.router)
    app.include_router(auth.settings_router)
    app.include_router(workers.create_router(data_dir))
    app.include_router(jobs.create_router(data_dir))
    app.include_router(receipts.create_router())
    app.include_router(users.create_router())
    app.include_router(agentws.create_router(data_dir))
    app.include_router(model_manifest.create_router(data_dir))
    app.include_router(peer.create_router(data_dir))
    app.include_router(comfyapi.create_router(data_dir))
    app.include_router(comfyapi.create_ws_router())
    app.include_router(templates.create_router(data_dir))
    app.include_router(installer_routes.create_router(data_dir))

    @app.get("/metrics")
    async def metrics_endpoint(request: Request) -> Response:
        with db.get_session() as session:
            public = metrics.is_public(session)
        if not public:
            # Conditional auth: whether admin is required depends on a DB
            # setting, so this can't be a static `Depends(auth.require_admin)`
            # on the route. Reuse the same session-resolution `require_admin`
            # itself is built on, so a disabled user or a stale (epoch-
            # mismatched) cookie is rejected here exactly as everywhere else.
            with db.get_session() as session:
                user = auth.resolve_session_user(session, request)
            if user is None or user.role != "admin":
                raise auth._error(401, "auth.required", "Login required.")

        data = generate_latest(metrics.get_metrics().registry)
        return Response(content=data, media_type=CONTENT_TYPE_LATEST)

    # --- embedded ComfyUI workflow editor (`/comfy`) --------------------
    #
    # Registered after every router so `/comfy/api/*` (which authenticates
    # itself) is matched by `comfyapi`'s routes, never by the static mount,
    # and before the SPA mount at `/` so `/comfy` is not swallowed by it.
    comfy_root = comfy_frontend.frontend_dir(data_dir)
    comfy_present = comfy_frontend.is_populated(data_dir)

    @app.middleware("http")
    async def _comfy_session_gate(request: Request, call_next):
        """Require a logged-in, non-disabled session for the panel and its
        static assets -- any role, not just admin.

        `/comfy/api/*` is excluded: those routes carry their own
        `require_user` dependency and must answer with JSON/401 rather than
        a redirect, because the ComfyUI frontend's fetches cannot follow a
        login redirect meaningfully. Everything else under `/comfy` is a page
        or asset a browser is loading directly, so an unauthenticated hit is
        sent to the console login at `/`.

        Phase 3.0 Task 4: the panel became a per-user workspace -- ANY
        authenticated user may open it now (Task 1's admin-only gate was
        explicitly a placeholder pending this task, since only admin
        accounts existed yet). Per-role SCOPE (what a session sees once
        inside) is enforced by `comfyapi`'s routes and the panel WS
        handshake, not by this gate.
        """
        path = request.url.path
        in_panel = path == _COMFY_PREFIX or path.startswith(_COMFY_PREFIX + "/")
        in_api = path == _COMFY_API_PREFIX or path.startswith(_COMFY_API_PREFIX + "/")
        if in_panel and not in_api:
            with db.get_session() as session:
                user = auth.resolve_session_user(session, request)
            if user is None:
                return RedirectResponse("/", status_code=302)
        return await call_next(request)

    @app.get("/comfy", include_in_schema=False)
    async def _comfy_root() -> Response:
        """Send `/comfy` to `/comfy/` -- the trailing slash is load-bearing.

        The ComfyUI frontend derives its API base from its own location:
        `api_base = location.pathname.split('/').slice(0, -1).join('/')`. At
        `/comfy/` that yields `/comfy`, so every call becomes
        `/comfy/api/...` and lands on our compat router. At `/comfy` (no
        slash) it would yield `""` and the panel would hammer `/api/...`,
        which is ComfyFed's own federation API. Starlette's own
        redirect-slashes cannot help here because the SPA mount at `/`
        matches `/comfy` first.
        """
        return RedirectResponse("/comfy/", status_code=307)

    if comfy_present:
        app.mount("/comfy", StaticFiles(directory=comfy_root, html=True), name="comfy")
    else:
        logger.info(
            "comfyfed_server: %s not populated; /comfy serves the fetch-comfy-ui notice.",
            comfy_root,
        )

        @app.get("/comfy/", include_in_schema=False)
        async def _comfy_notice() -> HTMLResponse:
            return HTMLResponse(_COMFY_NOTICE_HTML)

    web_dist = _find_web_dist()
    if web_dist is None:
        logger.warning(
            "comfyfed_server: web/dist not found (set %s or build the SPA); running API-only.",
            _WEB_DIST_ENV_VAR,
        )
    else:
        index_path = os.path.join(web_dist, "index.html")

        @app.exception_handler(404)
        async def _spa_fallback(request: Request, exc: HTTPException) -> JSONResponse | FileResponse:
            # `/api/` is ComfyFed's own API and `/comfy` is the embedded
            # ComfyUI panel (its `/comfy/api/` compat surface included).
            # Neither is part of the console SPA, so a 404 there must stay a
            # 404 -- returning index.html would turn a missing panel asset
            # into an HTML body the ComfyUI frontend then tries to parse.
            path = request.url.path
            if path.startswith("/api/") or path == _COMFY_PREFIX or path.startswith(_COMFY_PREFIX + "/"):
                return await _http_exception_handler(request, exc)
            return FileResponse(index_path)

        # Mounted last so it never shadows the API routers registered above.
        app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")

    return app
