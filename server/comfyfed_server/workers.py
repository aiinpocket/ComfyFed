"""Worker register-token issuance and Ed25519 registration."""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import secrets
import time
import zlib
from typing import Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import FileResponse
from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey
from pydantic import BaseModel
from sqlalchemy import update

from . import auth, db, metrics, security, storage

_PLATFORM_URL_KEY = "platform_url"

_RELEASES_DIRNAME = "releases"
_OBJECT_INFO_DIRNAME = "object_info"
_MAX_OBJECT_INFO_BYTES = 32 * 1024 * 1024

# Hard cap on the COMPRESSED upload, checked against Content-Length before a
# single byte is read. A real ComfyUI `/object_info` gzips to a couple of MB
# at most, so 8MB is generous; the point is that without it the decompressed
# cap alone is no protection -- a body has to be fully buffered and fully
# inflated before it can be measured.
_MAX_OBJECT_INFO_COMPRESSED_BYTES = 8 * 1024 * 1024

# zlib window size selecting a gzip (rather than zlib or raw deflate) stream.
_GZIP_WBITS = 31

# Chunk requested per `decompressobj.decompress` call while inflating.
_DECOMPRESS_CHUNK_BYTES = 1024 * 1024
_AGENT_VERSION_DEFAULT = "0.1.0"
_AGENT_LATEST_KEY = "agent_latest"
_AGENT_MIN_SUPPORTED_KEY = "agent_min_supported"
_AGENT_WHEEL_URL_KEY = "agent_wheel_url"
_AGENT_WHEEL_SHA256_KEY = "agent_wheel_sha256"
_AGENT_WHEEL_SIG_KEY = "agent_wheel_sig"

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


def _canonical_message(
    method: str, path: str, query: str, ts: str, nonce: str, body: bytes
) -> bytes:
    """Build the exact byte string an agent request's signature covers.

    Format (must stay identical to `comfyfed_agent.signing.signed_headers`):

        {METHOD}\\n{path}[?{query}]\\n{ts}\\n{nonce}\\n{body}

    The query string is part of the signed request target: without it, a
    signature captured for `?from=A` could be replayed against `?from=B`
    within the timestamp window on any route that reads query parameters.
    It is appended only when non-empty, so paths without a query sign
    byte-for-byte the same string they always did.
    """
    target = f"{path}?{query}" if query else path
    return f"{method.upper()}\n{target}\n{ts}\n{nonce}\n".encode() + body


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
    for missing/malformed headers, an unknown OR SOFT-DELETED worker, a bad
    signature, or a stale timestamp (without distinguishing which, to avoid
    leaking worker existence); 403 `agent.worker_disabled` for a disabled
    (but not deleted) worker; 409 `agent.replay` for a reused nonce.

    A deleted worker is indistinguishable from an unknown one here, on
    purpose and for parity with the cloud twin (`lib/verify_agent.ts`, whose
    `queries.getWorkerById` filters `deleted = 0` and so yields the same 401
    `agent.bad_signature`), and with the WS handshake's single 4401 close.
    `disabled` alone keeps its 403: a pause is a state the agent should hear
    about and stop for, a delete is a row the agent may no longer learn
    anything about.
    """
    if not x_worker_id or not x_ts or not x_nonce or not x_sig:
        raise _error(401, "agent.bad_signature", "Missing signature headers.")

    with db.get_session() as session:
        worker = session.get(db.Worker, x_worker_id)
        if worker is None or worker.deleted:
            # Deleted reads as unknown, and does so BEFORE the signature is
            # checked: there is nothing to leak, since the response is
            # byte-identical to the one an id-guesser gets for an id that
            # was never real.
            raise _error(401, "agent.bad_signature", "Invalid signature.")

        try:
            ts = int(x_ts)
        except ValueError:
            raise _error(401, "agent.bad_signature", "Invalid signature.")

        if abs(time.time() - ts) > _MAX_TS_SKEW_SECONDS:
            raise _error(401, "agent.bad_signature", "Invalid signature.")

        body = await request.body()
        message = _canonical_message(
            request.method, request.url.path, request.url.query, x_ts, x_nonce, body
        )

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


async def limit_object_info_upload(request: Request) -> None:
    """Reject an oversized `/api/agent/object_info` body from its Content-Length.

    Declared as the FIRST dependency on that route, ahead of `verify_agent`,
    on purpose: FastAPI resolves dependencies in signature order and
    `verify_agent` has to buffer the whole body to check the signature over
    it. Checking the declared length here is the only point at which the
    upload can still be refused without reading it.
    """
    raw_length = request.headers.get("content-length")
    if raw_length is None:
        return
    try:
        length = int(raw_length)
    except ValueError:
        raise _error(400, "agent.bad_object_info", "Invalid Content-Length.")
    if length > _MAX_OBJECT_INFO_COMPRESSED_BYTES:
        raise _error(
            413,
            "agent.object_info_too_large",
            "Compressed object_info exceeds the upload size limit.",
        )


class ObjectInfoTooLarge(Exception):
    """Raised by `bounded_gunzip` when the inflated stream passes its cap."""


def bounded_gunzip(gzip_bytes: bytes, max_bytes: Optional[int] = None) -> bytes:
    """Gunzip `gzip_bytes`, aborting as soon as the output passes `max_bytes`.

    `gzip.decompress` inflates the whole stream before anything can be
    measured, which makes the decompressed size limit unenforceable: a few
    hundred KB of gzipped zeros expands to gigabytes and the process is
    already out of memory by the time `len()` is consulted. Inflating
    incrementally with a `max_length` bound means a bomb costs at most one
    chunk past the cap.

    Raises `ObjectInfoTooLarge` past the cap, and `zlib.error` (which the
    caller maps to a 400) for anything that is not a valid gzip stream.
    """
    # Resolved at call time, not as a default argument, so the cap stays a
    # single mutable module-level knob (tests shrink it).
    if max_bytes is None:
        max_bytes = _MAX_OBJECT_INFO_BYTES

    decompressor = zlib.decompressobj(wbits=_GZIP_WBITS)
    chunks: list[bytes] = []
    total = 0
    data = gzip_bytes
    while True:
        chunk = decompressor.decompress(data, _DECOMPRESS_CHUNK_BYTES)
        # After the first call the remaining input lives in unconsumed_tail;
        # feeding it back in is how a max_length-bounded loop makes progress.
        data = decompressor.unconsumed_tail
        if chunk:
            total += len(chunk)
            if total > max_bytes:
                raise ObjectInfoTooLarge()
            chunks.append(chunk)
        elif not data:
            break
        if decompressor.eof and not data:
            break
    if not decompressor.eof:
        raise zlib.error("truncated gzip stream")
    return b"".join(chunks)


def object_info_path(data_dir: str, worker_id: str) -> str:
    """Path to a worker's stored gzipped `/object_info` snapshot.

    `worker_id` must already be a trusted value (the verified worker's own
    `id`, never anything client-supplied) -- sanitized here anyway as
    defense in depth, matching every other place a caller-influenced value
    becomes a path segment (see `storage.sanitize_path_component`).
    """
    safe_id = storage.sanitize_path_component(worker_id, what="worker id")
    return os.path.join(data_dir, _OBJECT_INFO_DIRNAME, f"{safe_id}.json.gz")


def load_object_info(data_dir: str, worker_id: str) -> Optional[dict]:
    """Read, gunzip, and parse a worker's stored `/object_info` snapshot.

    Produces interface for Task 2 (embedded ComfyUI editor panel): callers
    just need the worker id and the server's data dir. Returns None if the
    file is missing, not valid gzip, or not valid JSON -- never raises.
    """
    try:
        path = object_info_path(data_dir, worker_id)
    except ValueError:
        return None

    try:
        with open(path, "rb") as f:
            raw = f.read()
        decompressed = gzip.decompress(raw)
        return json.loads(decompressed)
    except (OSError, gzip.BadGzipFile, json.JSONDecodeError, UnicodeDecodeError, EOFError):
        return None


def _write_object_info(data_dir: str, worker_id: str, gzip_bytes: bytes) -> None:
    """Atomically write a worker's gzipped object_info snapshot to disk."""
    path = object_info_path(data_dir, worker_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp_path = f"{path}.tmp-{os.getpid()}"
    with open(tmp_path, "wb") as f:
        f.write(gzip_bytes)
    os.replace(tmp_path, path)


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

    @r.post("/api/agent/object_info")
    async def upload_object_info(
        request: Request,
        _limit: None = Depends(limit_object_info_upload),
        x_oi_hash: Optional[str] = Header(default=None, alias="X-OI-Hash"),
        worker: db.Worker = Depends(verify_agent),
    ):
        if not x_oi_hash:
            raise _error(400, "agent.bad_object_info", "Missing X-OI-Hash header.")

        body = await request.body()
        if len(body) > _MAX_OBJECT_INFO_COMPRESSED_BYTES:
            # A chunked upload has no Content-Length for the dependency above
            # to check, so the actual size is re-checked here.
            raise _error(
                413,
                "agent.object_info_too_large",
                "Compressed object_info exceeds the upload size limit.",
            )

        try:
            decompressed = bounded_gunzip(body)
        except ObjectInfoTooLarge:
            raise _error(
                413, "agent.object_info_too_large", "Decompressed object_info exceeds the size limit."
            )
        except (zlib.error, OSError, EOFError):
            raise _error(400, "agent.bad_object_info", "Invalid gzip payload.")

        try:
            json.loads(decompressed)
        except (TypeError, ValueError):
            raise _error(400, "agent.bad_object_info", "Payload is not valid JSON.")

        actual_hash = hashlib.sha256(decompressed).hexdigest()
        if actual_hash != x_oi_hash:
            raise _error(400, "agent.bad_object_info", "X-OI-Hash does not match the payload.")

        # worker.id comes from verify_agent (the signature-verified worker),
        # never from anything client-supplied -- so the stored path can't be
        # steered to another worker's file.
        _write_object_info(data_dir, worker.id, body)

        with db.get_session() as session:
            w = session.get(db.Worker, worker.id)
            if w is not None:
                w.object_info_hash = actual_hash
                session.commit()

        return {"ok": True}

    @r.get("/api/workers")
    def list_workers(_user: auth.SessionUser = Depends(auth.require_user)):
        with db.get_session() as session:
            # Soft-deleted workers are gone as far as every user-visible
            # surface is concerned (see `db.Worker.deleted`); only the
            # reports/payout endpoints still resolve them, by id.
            workers = session.query(db.Worker).filter(db.Worker.deleted == False).all()  # noqa: E712
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
                    # Phase 3.1 P2P: set from the agent's `hello.peer_url`
                    # when it opts into serving chunks to other workers (see
                    # agentws._parse_peer_url). Readable by any logged-in user
                    # now (see require_user above): workers are SHARED
                    # infrastructure, so a peer address is fleet metadata every
                    # user's own workflows already resolve chunks against, not
                    # per-user private data. Mutations (token issue, disable,
                    # delete) stay admin-only on their own routes.
                    "peer_url": w.peer_url,
                    # Phase 3.4 §6: the console's P2P column renders the NAT
                    # mode, the LAN address and a reachability badge from
                    # these three (cloud parity: routes/workers.ts). Same
                    # "fleet metadata, not private data" reasoning as
                    # `peer_url` above -- `peer_reachable` is literally the
                    # platform's own verdict on a shared endpoint.
                    "peer_lan_url": w.peer_lan_url,
                    "peer_nat": w.peer_nat,
                    "peer_reachable": w.peer_reachable,
                }
                for w in workers
            ]

    @r.get("/api/agent/version")
    def agent_version():
        with db.get_session() as session:

            def _setting(key: str, default: Optional[str]) -> Optional[str]:
                row = session.get(db.Setting, key)
                return row.value if row is not None else default

            # A stored RELATIVE wheel path ("/api/agent/releases/<file>") is
            # not something an agent can GET: its self-updater hands
            # `wheel_url` straight to its HTTP client, so every in-place
            # update failed with "Failed to download wheel" and the old build
            # kept running (live-caught on the cloud twin, which stores a
            # relative path). Serve an ABSOLUTE URL by prefixing the
            # configured platform_url; older agents -- the very ones that
            # must be able to update -- cannot join the path themselves, so
            # this is the platform's job. Left untouched only when
            # platform_url is unset (nothing sane to prefix).
            wheel_url = _setting(_AGENT_WHEEL_URL_KEY, None)
            if wheel_url and not wheel_url.lower().startswith(("http://", "https://")):
                platform_url = (_setting(_PLATFORM_URL_KEY, "") or "").rstrip("/")
                if platform_url:
                    wheel_url = platform_url + ("" if wheel_url.startswith("/") else "/") + wheel_url
            return {
                "latest": _setting(_AGENT_LATEST_KEY, _AGENT_VERSION_DEFAULT),
                "min_supported": _setting(_AGENT_MIN_SUPPORTED_KEY, _AGENT_VERSION_DEFAULT),
                "wheel_url": wheel_url,
                "sha256": _setting(_AGENT_WHEEL_SHA256_KEY, None),
                "platform_sig": _setting(_AGENT_WHEEL_SIG_KEY, None),
            }

    @r.get("/api/agent/releases/{filename}")
    def agent_release(filename: str):
        safe_name = os.path.basename(filename)
        path = os.path.join(data_dir, _RELEASES_DIRNAME, safe_name)
        if not os.path.isfile(path):
            raise _error(404, "agent.release_not_found", "Release file not found.")
        return FileResponse(path)

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

    @r.delete("/api/workers/{worker_id}")
    # MUST stay a sync `def` (review L9): `agentws.kick_worker` below blocks on
    # `run_coroutine_threadsafe(...).result()`, which needs this to run on a
    # threadpool thread. Making it `async def` would deadlock it on its own loop.
    def delete_worker(
        worker_id: str,
        _payload: dict = Depends(auth.require_csrf),
    ):
        """Admin soft delete: the worker vanishes from the console, dispatch
        and metrics, and can never reconnect -- but its row survives so the
        receipts and jobs pointing at it keep resolving in the billing
        reports. Same admin+CSRF gate as `disable_worker` above
        (`require_csrf` already hangs off `require_admin`).

        Already-deleted is 404, identical to unknown: from every caller's
        point of view the worker no longer exists, and telling the two apart
        would leak that an id was once real.
        """
        with db.get_session() as session:
            worker = session.get(db.Worker, worker_id)
            if worker is None or worker.deleted:
                raise _error(404, "workers.not_found", "Worker not found.")
            worker_name = worker.name
            worker.deleted = True
            # Belt and braces: every pre-existing gate (dispatch, the agent
            # WS handshake, signed agent requests) already refuses a disabled
            # worker, so flipping both means nothing can serve a deleted
            # worker even on a path that predates `deleted`.
            worker.disabled = True
            session.commit()

        # Imported lazily: `agentws` imports this module at load time, so a
        # module-level import here would be circular.
        from . import agentws

        agentws.kick_worker(worker_id)
        _forget_worker_metrics(worker_name)

        return {"ok": True}

    return r


def _forget_worker_metrics(worker_name: str) -> None:
    """Drop a deleted worker's per-worker gauge samples.

    The gauges are labelled by NAME (see `metrics.Metrics`) and nothing else
    ever clears a label, so a deleted worker would otherwise keep exporting
    `comfyfed_worker_up{worker="..."} 0` forever and page whoever alerts on
    it. `remove` raises KeyError for a label set that was never set (a worker
    that never heartbeated), which is not an error here. Best-effort in full:
    metrics must never fail the delete.

    Names are NOT unique (`register_worker` mints a fresh row from a
    caller-supplied name every time), so a name still claimed by a live row --
    the same machine re-registered as "rig-7", the stale old row then deleted
    -- must keep its samples: dropping them would blank the LIVE worker's
    gauges until its next heartbeat. Hence the guard query below: forget the
    labels only once no non-deleted row answers to this name.
    """
    with db.get_session() as session:
        survivor = (
            session.query(db.Worker.id)
            .filter(db.Worker.name == worker_name)
            .filter(db.Worker.deleted == False)  # noqa: E712
            .first()
        )
    if survivor is not None:
        return

    try:
        m = metrics.get_metrics()
    except RuntimeError:
        return
    for gauge in (m.worker_up, m.worker_free_vram_gb, m.worker_free_ram_gb, m.worker_free_disk_gb):
        try:
            gauge.remove(worker_name)
        except (KeyError, ValueError):
            pass
