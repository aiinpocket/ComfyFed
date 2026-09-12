"""FastAPI application factory."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest

from . import agentws, auth, bootstrap, db, jobs, metrics, receipts, workers

logger = logging.getLogger(__name__)

_WEB_DIST_ENV_VAR = "COMFYFED_WEB_DIST"


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
        installed = session.get(db.Setting, bootstrap._ADMIN_PASSWORD_HASH_KEY) is not None

    if not installed:
        raise RuntimeError(
            "ComfyFed server is not installed yet. Run `comfyfed-server install` first."
        )

    bootstrap.ensure_installed(data_dir, lang=None, url=None, interactive=False)
    metrics.init()

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
    app.include_router(agentws.create_router(data_dir))

    @app.get("/metrics")
    async def metrics_endpoint(request: Request) -> Response:
        with db.get_session() as session:
            public = metrics.is_public(session)
        if not public:
            # Conditional auth: whether admin is required depends on a DB
            # setting, so this can't be a static `Depends(auth.require_admin)`
            # on the route. Reuse the same session-payload check it uses.
            payload = auth._read_session_payload(request.cookies.get("cf_session"))
            if not payload or not payload.get("authenticated"):
                raise auth._error(401, "auth.required", "Login required.")

        data = generate_latest(metrics.get_metrics().registry)
        return Response(content=data, media_type=CONTENT_TYPE_LATEST)

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
            if request.url.path.startswith("/api/"):
                return await _http_exception_handler(request, exc)
            return FileResponse(index_path)

        # Mounted last so it never shadows the API routers registered above.
        app.mount("/", StaticFiles(directory=web_dist, html=True), name="web")

    return app
