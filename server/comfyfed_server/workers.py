"""Worker register-token issuance and Ed25519 registration."""

from __future__ import annotations

import secrets
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import update

from . import auth, db, security

_PLATFORM_URL_KEY = "platform_url"


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


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
        _payload: dict = Depends(auth.require_csrf),
    ):
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

            worker_name = body.name or token_row.worker_name

            # Atomically claim the token: only one concurrent request can flip
            # used=0 -> used=1. The loser sees rowcount == 0 and gets a 409,
            # even if it read the row before the winner's commit.
            result = session.execute(
                update(db.RegisterToken)
                .where(db.RegisterToken.token == body.token, db.RegisterToken.used == False)  # noqa: E712
                .values(used=True)
            )
            if result.rowcount != 1:
                session.rollback()
                raise _error(409, "register.token_used", "Register token already used.")

            worker = db.Worker(name=worker_name, pubkey=body.pubkey)
            session.add(worker)
            session.commit()
            worker_id = worker.id

        signing_key, _ = security.load_platform_keys(data_dir)
        msg = f"{worker_id}|{body.pubkey}".encode()
        signature = signing_key.sign(msg).signature

        return {"worker_id": worker_id, "certificate": signature.hex()}

    @r.get("/api/workers")
    def list_workers(_payload: dict = Depends(auth.require_admin)):
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
        _payload: dict = Depends(auth.require_csrf),
    ):
        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            if worker is None:
                raise _error(404, "workers.not_found", "Worker not found.")
            worker.disabled = True
            session.commit()

        return {"ok": True}

    return r
