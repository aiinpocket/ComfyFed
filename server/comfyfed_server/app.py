"""FastAPI application factory."""

from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from . import auth, bootstrap, db


def _error_body(code: str, message: str) -> dict:
    return {"error": {"code": code, "message": message}}


async def _http_exception_handler(request: Request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    if isinstance(detail, dict) and "code" in detail:
        body = _error_body(detail["code"], detail.get("message", detail["code"]))
    else:
        body = _error_body("http_error", str(detail))
    return JSONResponse(status_code=exc.status_code, content=body)


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

    app = FastAPI(title="ComfyFed")
    app.add_exception_handler(HTTPException, _http_exception_handler)
    app.include_router(auth.router)

    return app
