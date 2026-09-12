"""Worker register-token issuance and Ed25519 registration."""

from __future__ import annotations

import secrets
from typing import Optional

from fastapi import APIRouter, Cookie, Header, HTTPException
from pydantic import BaseModel

from . import auth, db, security

_PLATFORM_URL_KEY = "platform_url"


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


def _require_admin_with_csrf(
    cf_session: Optional[str],
    x_csrf: Optional[str],
) -> dict:
    payload = auth._read_session_payload(cf_session)
    if not payload or not payload.get("authenticated"):
        raise _error(401, "auth.required", "Login required.")
    if not x_csrf or x_csrf != payload.get("csrf"):
        raise _error(403, "auth.csrf", "CSRF token missing or invalid.")
    return payload


class IssueTokenBody(BaseModel):
    name: str


class RegisterBody(BaseModel):
    token: str
    name: Optional[str] = None
    pubkey: str


def create_router(data_dir: str) -> APIRouter:
    r = APIRouter()

    @r.post("/api/workers/tokens")
    def issue_token(
        body: IssueTokenBody,
        cf_session: Optional[str] = Cookie(default=None),
        x_csrf: Optional[str] = Header(default=None, alias="X-CSRF"),
    ):
        _require_admin_with_csrf(cf_session, x_csrf)

        token = secrets.token_urlsafe(24)
        with db.get_session() as session:
            session.add(db.RegisterToken(token=token, worker_name=body.name))
            row = session.get(db.Setting, _PLATFORM_URL_KEY)
            platform_url = row.value if row is not None else ""
            session.commit()

        _, verify_key = security.load_platform_keys(data_dir)
        return {
            "bundle": {
                "platform_url": platform_url,
                "platform_pubkey": bytes(verify_key).hex(),
                "register_token": token,
            }
        }

    @r.post("/api/agent/register")
    def register(body: RegisterBody):
        with db.get_session() as session:
            token_row = session.get(db.RegisterToken, body.token)
            if token_row is None:
                raise _error(401, "register.token_invalid", "Unknown register token.")
            if token_row.used:
                raise _error(409, "register.token_used", "Register token already used.")

            worker_name = body.name or token_row.worker_name
            worker = db.Worker(name=worker_name, pubkey=body.pubkey)
            session.add(worker)
            token_row.used = True
            session.commit()
            worker_id = worker.id

        signing_key, _ = security.load_platform_keys(data_dir)
        msg = f"{worker_id}|{body.pubkey}".encode()
        signature = signing_key.sign(msg).signature

        return {"worker_id": worker_id, "certificate": signature.hex()}

    @r.get("/api/workers")
    def list_workers(cf_session: Optional[str] = Cookie(default=None)):
        payload = auth._read_session_payload(cf_session)
        if not payload or not payload.get("authenticated"):
            raise _error(401, "auth.required", "Login required.")

        with db.get_session() as session:
            workers = session.query(db.Worker).all()
            return [
                {
                    "id": w.id,
                    "name": w.name,
                    "status": w.status,
                    "last_seen": w.last_seen.isoformat() if w.last_seen else None,
                    "disabled": w.disabled,
                }
                for w in workers
            ]

    @r.post("/api/workers/{worker_id}/disable")
    def disable_worker(
        worker_id: str,
        cf_session: Optional[str] = Cookie(default=None),
        x_csrf: Optional[str] = Header(default=None, alias="X-CSRF"),
    ):
        _require_admin_with_csrf(cf_session, x_csrf)

        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            if worker is None:
                raise _error(404, "workers.not_found", "Worker not found.")
            worker.disabled = True
            session.commit()

        return {"ok": True}

    return r
