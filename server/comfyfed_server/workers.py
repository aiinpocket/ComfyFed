"""Worker register-token issuance and Ed25519 registration."""

from __future__ import annotations

import json
import secrets
import time
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from pydantic import BaseModel
from sqlalchemy import update

from . import auth, db, security

_PLATFORM_URL_KEY = "platform_url"

_NONCE_TTL_SECONDS = 300
_MAX_TS_SKEW_SECONDS = 120

# In-memory replay-protection store, keyed by (worker_id, nonce) -> monotonic
# expiry. Pruned opportunistically on each check. Not shared across processes;
# fine for a single-process server.
_seen_nonces: dict[tuple[str, str], float] = {}


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


def _json_or(raw: Optional[str], default):
    """Decode a JSON text column, falling back to `default` on bad/empty data."""
    try:
        value = json.loads(raw or "")
    except (TypeError, ValueError):
        return default
    if type(value) is not type(default):
        return default
    return value


def _prune_nonces(now_monotonic: float) -> None:
    expired = [key for key, expiry in _seen_nonces.items() if expiry <= now_monotonic]
    for key in expired:
        del _seen_nonces[key]


async def verify_agent(
    request: Request,
    x_worker_id: Optional[str] = Header(default=None, alias="X-Worker-Id"),
    x_ts: Optional[str] = Header(default=None, alias="X-Ts"),
    x_nonce: Optional[str] = Header(default=None, alias="X-Nonce"),
    x_sig: Optional[str] = Header(default=None, alias="X-Sig"),
) -> db.Worker:
    """Verify an Ed25519-signed agent request, enforcing replay protection.

    On success returns the `db.Worker` row. Raises 401 `agent.bad_signature`
    for missing/malformed headers, an unknown worker, a bad signature, or a
    stale timestamp (without distinguishing which, to avoid leaking worker
    existence); 403 `agent.worker_disabled` for a disabled worker; 409
    `agent.replay` for a reused nonce.
    """
    if not x_worker_id or not x_ts or not x_nonce or not x_sig:
        raise _error(401, "agent.bad_signature", "Missing signature headers.")

    with db.get_session() as session:
        worker = session.get(db.Worker, x_worker_id)
        if worker is None:
            raise _error(401, "agent.bad_signature", "Invalid signature.")

        try:
            ts = int(x_ts)
        except ValueError:
            raise _error(401, "agent.bad_signature", "Invalid signature.")

        if abs(time.time() - ts) > _MAX_TS_SKEW_SECONDS:
            raise _error(401, "agent.bad_signature", "Invalid signature.")

        body = await request.body()
        message = f"{request.method.upper()}\n{request.url.path}\n{x_ts}\n{x_nonce}\n".encode() + body

        # Signature must be validated BEFORE any disabled-worker check: if we
        # returned 403 for a disabled worker without checking the signature
        # first, an attacker who merely guesses a worker_id could use the
        # 401-vs-403 distinction as an oracle for worker existence/status.
        try:
            VerifyKey(bytes.fromhex(worker.pubkey)).verify(message, bytes.fromhex(x_sig))
        except (BadSignatureError, ValueError):
            raise _error(401, "agent.bad_signature", "Invalid signature.")

        if worker.disabled:
            raise _error(403, "agent.worker_disabled", "Worker is disabled.")

        now_monotonic = time.monotonic()
        _prune_nonces(now_monotonic)
        nonce_key = (x_worker_id, x_nonce)
        if nonce_key in _seen_nonces:
            raise _error(409, "agent.replay", "Nonce already used.")
        _seen_nonces[nonce_key] = now_monotonic + _NONCE_TTL_SECONDS

        return worker


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

    @r.post("/api/agent/ping")
    def ping(_worker: db.Worker = Depends(verify_agent)):
        return {"ok": True}

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
                    # Hardware summary for the console's worker cards. Stored
                    # as JSON text columns; decoded defensively so one bad row
                    # cannot break the whole listing.
                    "hardware": _json_or(w.hardware, {}),
                    "dynamic": _json_or(w.dynamic, {}),
                    "backend": w.backend,
                    "torch_version": w.torch_version,
                    "model_count": len(_json_or(w.model_inventory, [])),
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
