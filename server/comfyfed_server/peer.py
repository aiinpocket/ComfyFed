"""Phase 3.1 P2P addendum: server-side seeder tracking, grant issuance, and
bandwidth booking.

A puller agent asks the platform for a peer source (`POST
/api/agent/peer-grant`); the platform picks an online, protocol>=4 seeder
whose inventory has the requested (name, size_bytes) at the learned
consensus hash (`model_manifest.record_hash`) and advertises a `peer_url`
(`db.Worker.peer_url`), then issues a short-lived, platform-signed `Grant`
binding exactly that one (seeder, puller, file) triple. The seeder verifies
the grant itself before serving any bytes (`agent/comfyfed_agent/peerserve.py`,
Task 4) -- this module never talks to the seeder directly, it only mints
and books grants.

Grant issuance state lives in an in-memory dict (`_grants`), matching
`workers._seen_nonces`'s existing precedent for per-process, not
cross-replica, ephemeral state: a platform restart loses any outstanding
unbooked grant, which simply means that one in-flight transfer's bandwidth
never gets billed (the ledger is documentation, not the transfer's trust
root -- the seeder's own grant signature check is what actually gates
serving bytes, and that's stateless/pinned-key, unaffected by a restart).
"""

from __future__ import annotations

import json
import logging
import math
import threading
import time
import uuid
from typing import Optional

import sqlalchemy as sa
from fastapi import APIRouter, Depends, HTTPException
from nacl.exceptions import BadSignatureError
from nacl.signing import SigningKey, VerifyKey
from pydantic import BaseModel

from . import db, security, workers

logger = logging.getLogger(__name__)

# Global Constraints: TTL 600s (the FLOOR -- see `grant_ttl_seconds`), single
# file/puller/seeder per grant.
GRANT_TTL_SECONDS = 600

# 授權單存活時間的下限速率假設：agent 端 `peer_upload_limit_mbps` 預設 20 Mbps
# = 2.5 MB/s，所以一張授權單至少要能撐過「整個檔案以這個速率傳完」的時間。
#
# The slowest transfer rate a grant's TTL is sized for. It tracks the agent's
# DEFAULT ACTIVE upload cap (`peer_upload_limit_mbps = 20` Mbps ->
# 20_000_000 / 8 bytes per second, see
# `agent/comfyfed_agent/peerserve.py:PeerHTTPServer.set_upload_limit_mbps`).
# Keep the two in step: if the agent's default active cap drops, a grant
# sized by this constant stops covering a whole transfer again.
MIN_ASSUMED_RATE_BYTES_PER_SEC = 2_500_000

# M2 final-review fix: the same accepted range `agentws._parse_peer_upload_min_mbps`
# enforces at hello time, re-applied when the value is read back out of the
# stored `hardware` blob -- a row written by an older build (or edited in the
# DB) must not be able to reintroduce the absurd-TTL case.
MIN_PEER_UPLOAD_MBPS = 0.1
MAX_PEER_UPLOAD_MBPS = 100000.0

# M2 final-review fix: hard ceiling on a computed grant TTL -- 7 days. Even a
# legitimately slow seeder never needs longer than this for one file, and the
# cap keeps `expires_at` a sane integer no matter what rate/size arithmetic
# produced it. Parity: `cloud/src/core/peer.ts`'s `MAX_GRANT_TTL_SECONDS`.
MAX_GRANT_TTL_SECONDS = 604800


def _seeder_rate_bytes_per_sec(worker) -> float:
    """The rate a grant served by `worker` should be sized for.

    The seeder reports its own slowest configured P2P upload cap in hello
    (`peer_upload_min_mbps`, stashed into the `hardware` JSON blob by
    `agentws._handle_hello`). A user who capped their uplink BELOW the
    20 Mbps default would otherwise be under-TTL'd by a factor of
    default/actual -- a 5 Mbps seeder needs 4x the TTL a 20 Mbps one does.
    Missing/non-numeric/non-positive (an old agent, both caps unlimited, or
    a malformed value) degrades to `MIN_ASSUMED_RATE_BYTES_PER_SEC`, i.e.
    exactly the pre-existing behavior.
    """
    try:
        hardware = json.loads(getattr(worker, "hardware", None) or "{}")
    except (TypeError, ValueError):
        hardware = {}
    value = hardware.get("peer_upload_min_mbps") if isinstance(hardware, dict) else None
    if not isinstance(value, (int, float)) or isinstance(value, bool) or value <= 0:
        return MIN_ASSUMED_RATE_BYTES_PER_SEC
    if not math.isfinite(value):
        return MIN_ASSUMED_RATE_BYTES_PER_SEC
    if value < MIN_PEER_UPLOAD_MBPS or value > MAX_PEER_UPLOAD_MBPS:
        return MIN_ASSUMED_RATE_BYTES_PER_SEC
    return float(value) * 1_000_000 / 8


def grant_ttl_seconds(size_bytes: int, rate_bytes_per_sec: float | None = None) -> int:
    """How long a grant for a `size_bytes` file must live.

    At the agent's default active upload cap (20 Mbps = 2.5 MB/s) a 6.5 GB
    model takes ~43 minutes, i.e. ~4x the flat 600 s TTL: every byte served
    after expiry went unaccounted (the seeder reports a grant once, at
    expiry) and any resume/retry after expiry was refused outright. So the
    TTL scales with the file: the estimated transfer time at
    `rate_bytes_per_sec`, times 1.5 for slack, plus the flat
    `GRANT_TTL_SECONDS` of setup/retry headroom -- never below the 600 s
    floor, so small files are unchanged in practice.

    `rate_bytes_per_sec` is the CHOSEN SEEDER's own reported cap when it has
    one (`_seeder_rate_bytes_per_sec`); omitted/invalid it falls back to
    `MIN_ASSUMED_RATE_BYTES_PER_SEC`, the 20 Mbps agent default.
    """
    try:
        size = max(0, int(size_bytes))
    except (TypeError, ValueError):
        size = 0
    rate = rate_bytes_per_sec
    if not isinstance(rate, (int, float)) or isinstance(rate, bool) or rate <= 0:
        rate = MIN_ASSUMED_RATE_BYTES_PER_SEC
    transfer = size / rate
    if not math.isfinite(transfer):
        # A rate small enough to overflow the division straight to infinity
        # (`math.ceil` would raise OverflowError). Nothing to compute: the
        # ceiling below is the answer. JS's `Math.ceil(Infinity)` flows into
        # the same `Math.min` naturally, so the two stacks still agree.
        return MAX_GRANT_TTL_SECONDS
    transfer = math.ceil(transfer)
    # ...and never longer than `MAX_GRANT_TTL_SECONDS` (M2): the divisor comes
    # from a worker-reported value, so the ceiling is what stops an absurd
    # `expires_at` from reaching the signed grant at all.
    return int(
        min(
            MAX_GRANT_TTL_SECONDS,
            max(GRANT_TTL_SECONDS, transfer * 1.5 + GRANT_TTL_SECONDS),
        )
    )

# M4 final-review fix: a grant whose transfer is still active when its TTL
# elapses must still be able to book its bandwidth -- the seeder's
# expiry-triggered report (peerserve.due_for_report fires at/after
# expires_at) would otherwise race a prune that deletes the grant at exactly
# that same boundary, guaranteeing every such report 404s and retries
# forever. Retain an expired grant for this long past `expires_at` before
# actually deleting it, so `peer_served` still finds it; issuance
# (`_active_grant_count`) already only counts grants with `expires_at > now`,
# so this retention window does not affect seeder selection.
_GRANT_RETENTION_SECONDS = 3600

# L1 final-review fix: hard cap on the in-memory grant book so an
# authenticated worker looping `POST /api/agent/peer-grant` can't grow it
# without bound even within the retention window above -- oldest-issued
# entries are evicted first once the cap is hit.
_MAX_GRANTS = 10000

# Global Constraints: agent protocol becomes 4 for P2P; older agents never
# advertise peer_url and are never picked as a seeder (see db.Worker.protocol).
_MIN_PEER_PROTOCOL = 4

# `peer-served`'s bytes_served upper bound: size_bytes * 1.05, matching the
# task brief's slack allowance for chunk overlap/retransmission bookkeeping
# without accepting an obviously-wrong (much larger) claim.
_BYTES_SERVED_SLACK = 1.05

# Ordered exactly as the signed payload joins them (Global Constraints:
# `grant_id|name|size_bytes|sha256|seeder_id|puller_id|expires_at`).
_GRANT_FIELDS = ("grant_id", "name", "size_bytes", "sha256", "seeder_id", "puller_id", "expires_at")

# In-memory grant book: grant_id -> {**grant fields, "booked": bool}.
# Pruned opportunistically by `_prune_expired` on each issuance/booking call,
# same pattern as `workers._prune_nonces`.
_grants: dict[str, dict] = {}

# Guards claim (check-not-booked-then-mark-booked) on `_grants` entries.
# `peer_served` runs the claim under this lock BEFORE the DB insert, so two
# concurrent requests for the same grant_id (e.g. a client retry racing the
# original request across a threadpool dispatch) can never both observe
# `booked is False` and both proceed -- only one can flip it under the lock.
# If the DB insert after the claim fails, the caller re-acquires this lock to
# un-mark the grant so a legitimate retry can still succeed.
_grant_lock = threading.Lock()


def _error(status_code: int, code: str, message: str = "") -> HTTPException:
    return HTTPException(status_code=status_code, detail={"code": code, "message": message or code})


def _prune_expired(now: float) -> None:
    """Delete grants that are past their RETENTION window (`_GRANT_RETENTION_SECONDS`
    past `expires_at`), not merely past `expires_at` itself -- see
    `_GRANT_RETENTION_SECONDS`'s docstring (M4) for why an exact-TTL prune
    guarantees an expiry-triggered `peer_served` 404s."""
    expired = [grant_id for grant_id, g in _grants.items() if g["expires_at"] + _GRANT_RETENTION_SECONDS <= now]
    for grant_id in expired:
        del _grants[grant_id]


def _evict_oldest_beyond_cap() -> None:
    """L1 final-review fix: hard cap `_grants` at `_MAX_GRANTS`, evicting the
    oldest-issued entries first (dict insertion order) once issuance would
    exceed it -- bounds the in-memory book even for grants still inside
    their retention window."""
    overflow = len(_grants) - _MAX_GRANTS
    if overflow <= 0:
        return
    for grant_id in list(_grants.keys())[:overflow]:
        del _grants[grant_id]


def _grant_payload(grant: dict) -> str:
    return "|".join(str(grant[field]) for field in _GRANT_FIELDS)


def sign_grant(signing_key: SigningKey, grant: dict) -> str:
    """Sign `grant`'s fields (pipe-joined, `_GRANT_FIELDS` order) with the
    platform Ed25519 key -- mirrors `model_manifest.entries()`'s manifest-
    entry signing convention.

    Raises `ValueError` if any field's string form contains `|` (the payload
    delimiter): Global Constraints requires this be rejected at issuance
    rather than let a crafted field shift what the signature is later parsed
    as covering (same rationale as `model_manifest.entries()`'s `|` guard).
    """
    for field in _GRANT_FIELDS:
        value = str(grant[field])
        if "|" in value:
            raise ValueError(f"grant field {field!r} contains the '|' payload delimiter: {value!r}")
    return signing_key.sign(_grant_payload(grant).encode()).signature.hex()


def verify_grant(verify_key: VerifyKey, grant: dict, sig: str) -> bool:
    """Whether `sig` (hex) is `verify_key`'s valid signature over `grant`'s
    fields, the grant is field-shape-valid, and it has not expired (against
    `time.time()`). Never raises -- a missing/wrong-typed field, a bad hex
    string, and a bad signature all just read as "not valid" (fail-closed,
    matching `workers.verify_agent`'s treatment of a malformed signature).
    Task 4's seeder-side gate reuses this same check before serving bytes.
    """
    try:
        if not isinstance(grant, dict):
            return False
        for field in _GRANT_FIELDS:
            if field not in grant:
                return False
        for field in ("size_bytes", "expires_at"):
            value = grant[field]
            if not isinstance(value, int) or isinstance(value, bool):
                return False
        if grant["expires_at"] <= time.time():
            return False
        verify_key.verify(_grant_payload(grant).encode(), bytes.fromhex(sig))
        return True
    except (BadSignatureError, ValueError, TypeError, KeyError):
        return False


def _worker_inventory(worker: db.Worker) -> list:
    try:
        value = json.loads(worker.model_inventory or "[]")
    except (TypeError, ValueError):
        return []
    return value if isinstance(value, list) else []


def _worker_has_consensus_file(worker: db.Worker, name: str, size_bytes: int, sha256: str) -> bool:
    """Whether `worker`'s reported inventory contains an entry for exactly
    (name, size_bytes) at the learned consensus `sha256`.

    Exact-name comparison (not `assess.matches_model_name`'s loader-relative
    leniency): `model_hashes.name` is the SAME inventory-relative path an
    agent's own `model_inventory` entries use (both come from the identical
    `hardware.scan_models` report -- see `model_manifest.record_hash`'s
    docstring), so there is no root mismatch to reconcile here.
    """
    for entry in _worker_inventory(worker):
        if not isinstance(entry, dict):
            continue
        if entry.get("name") != name:
            continue
        entry_size = entry.get("size_bytes")
        if not isinstance(entry_size, int) or isinstance(entry_size, bool) or entry_size != size_bytes:
            continue
        if entry.get("sha256") == sha256:
            return True
    return False


def online_seeders(
    session,
    name: str,
    size_bytes: int,
    *,
    exclude_worker_id: Optional[str] = None,
    puller_remote_ip: Optional[str] = None,
) -> list[db.Worker]:
    """Online, protocol>=4, peer_url-advertising, platform-verified-reachable
    workers whose inventory has (name, size_bytes) at the learned consensus
    hash.

    Phase 3.4 §4.2 adds the reachability half of the predicate: a seeder must
    either have passed the platform's own `/peer/health` probe
    (`peer_reachable = 1`, see `peerhealth.refresh`) OR sit behind the same
    public IP as the puller with a LAN address to offer. `puller_remote_ip`
    is what enables that second arm -- callers that have no particular puller
    in mind (`model_manifest._seeder_candidate_files`'s "does this file have
    a seeder at all" question) omit it and get the conservative predicate,
    which is the right default: better to under-report one seeder than to
    dispatch a job on the promise of a peer nobody can reach.

    The single seeder predicate, used by both grant issuance below and (Task
    6) `assess`'s fetchable check -- see this module's docstring and the plan's
    Global Constraints ruling against implementing it twice and risking drift.

    A `model_hashes` row that's conflicted (two workers disagreed on the
    whole-file hash) never has a seeder: the platform doesn't know which
    reported hash, if either, is genuine, so it can't hand out a grant that
    claims an authoritative `sha256`.

    "Online" mirrors `assess._online_enabled_workers`'s definition EXCEPT
    `disabled`: seeding eligibility is deliberately decoupled from a worker's
    disabled status (spec: 種子資格與 worker 停用狀態脫鉤 -- disabled means "does
    not take dispatched jobs", not "stops sharing models it already holds";
    a worker can be parked from job dispatch with `disabled=true` while
    remaining a seeder, and separately turn off peer-serving entirely with
    its own `peer_serve=false`). Only a genuinely offline worker can't serve
    a byte, so `status != "offline"` is the only liveness predicate here.
    """
    hash_row = session.get(db.ModelHash, (name, size_bytes))
    if hash_row is None or hash_row.conflict:
        return []

    # Accepted (review L6): a soft-deleted worker stays seeder-eligible until
    # `dispatch.requeue_stale` flips it offline, i.e. at most ~90s. The worst
    # case is one wasted round trip -- its `peer_served` receipt mint is
    # refused by `workers.verify_agent` -- so no `deleted` filter here.
    # Phase 3.4 §4.2：種子必須是「平台驗證過連得到」的，**或**跟拉方在同一
    # 個公網 IP 後面（⇒ 幾乎一定同一個 NAT）且有區網位址可用 —— 後者正是
    # 家用環境最常見的情形：兩台都在同一台路由器後面，誰都不必對外開埠。
    reachable_or_lan_neighbour = db.Worker.peer_reachable == 1
    if puller_remote_ip:
        reachable_or_lan_neighbour = sa.or_(
            reachable_or_lan_neighbour,
            sa.and_(
                db.Worker.remote_ip == puller_remote_ip,
                db.Worker.peer_lan_url.isnot(None),
            ),
        )

    query = (
        session.query(db.Worker)
        .filter(db.Worker.status != "offline")
        .filter(db.Worker.protocol >= _MIN_PEER_PROTOCOL)
        .filter(db.Worker.peer_url.isnot(None))
        .filter(reachable_or_lan_neighbour)
    )
    if exclude_worker_id is not None:
        query = query.filter(db.Worker.id != exclude_worker_id)

    return [
        w
        for w in query.all()
        if _worker_has_consensus_file(w, name, size_bytes, hash_row.sha256)
    ]


def _seeder_urls(seeder: db.Worker, puller_remote_ip: Optional[str]) -> list[str]:
    """拉方該依序嘗試的位址（spec §5）：

    1. 拉方與種子的 `remote_ip` 相同且種子有 `peer_lan_url`
       → `[peer_lan_url, peer_url]`（同一個 NAT，區網直連最快，而且很多
       家用路由器不支援 hairpin，對外位址反而連不回來）。
    2. 否則 → `[peer_url]`（此時種子必為 `peer_reachable = 1`）。

    回傳前**保序去重**：`peer_nat = "lan"` 的種子兩欄是同一個值（沒開埠，
    通告的就是區網位址），第 1 種情形會產生 `[x, x]`，讓拉方在同一個位址
    上白試兩次。

    cloud parity: `cloud/src/core/peer.ts` 的 `seederUrls`。
    """
    if puller_remote_ip and seeder.remote_ip == puller_remote_ip and seeder.peer_lan_url:
        return _dedupe([seeder.peer_lan_url, seeder.peer_url])
    return [seeder.peer_url]


def _dedupe(urls: list[str]) -> list[str]:
    """保序去重（`dict.fromkeys` 的語意，寫開只為了讓 cloud 那邊照抄）。"""
    seen: set[str] = set()
    out: list[str] = []
    for url in urls:
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _active_grant_count(worker_id: str, now: float) -> int:
    """Unexpired, unbooked grants currently seeded by `worker_id` -- the
    "fewest active grants" tiebreak for picking among multiple seeders.
    """
    return sum(
        1
        for g in _grants.values()
        if g["seeder_id"] == worker_id and g["expires_at"] > now and not g["booked"]
    )


class PeerGrantRequest(BaseModel):
    name: str
    size_bytes: int


class PeerServedRequest(BaseModel):
    grant_id: str
    bytes_served: int


def create_router(data_dir: str) -> APIRouter:
    r = APIRouter()

    @r.post("/api/agent/peer-grant")
    def peer_grant(body: PeerGrantRequest, worker: db.Worker = Depends(workers.verify_agent)):
        now = time.time()
        _prune_expired(now)

        with db.get_session() as session:
            hash_row = session.get(db.ModelHash, (body.name, body.size_bytes))
            if hash_row is None or hash_row.conflict:
                raise _error(404, "peer.no_model", "No consensus hash for this model.")

            # Spec: the platform verifies the requester actually lacks the
            # file before handing out a grant for it (拉方確缺此檔) -- checked
            # against the requester's OWN reported inventory, same predicate
            # `online_seeders` uses for a candidate seeder.
            if _worker_has_consensus_file(worker, body.name, body.size_bytes, hash_row.sha256):
                raise _error(400, "peer.already_has_model", "You already have this model.")

            seeders = online_seeders(
                session,
                body.name,
                body.size_bytes,
                exclude_worker_id=worker.id,
                puller_remote_ip=worker.remote_ip,
            )
            if not seeders:
                raise _error(404, "peer.no_seeder", "No online seeder for this model.")

            seeder = min(seeders, key=lambda w: (_active_grant_count(w.id, now), w.name))

            grant_id = uuid.uuid4().hex
            # TTL is sized for THIS seeder's own reported upload cap (parity:
            # cloud/src/routes/peer.ts does the same with `seederRateBytesPerSec`).
            expires_at = int(now) + grant_ttl_seconds(
                body.size_bytes, _seeder_rate_bytes_per_sec(seeder)
            )
            grant = {
                "grant_id": grant_id,
                "name": body.name,
                "size_bytes": body.size_bytes,
                "sha256": hash_row.sha256,
                "seeder_id": seeder.id,
                "puller_id": worker.id,
                "expires_at": expires_at,
            }
            signing_key, _ = security.load_platform_keys(data_dir)
            try:
                sig = sign_grant(signing_key, grant)
            except ValueError as exc:
                # A field (in practice only `name`, an agent-reported path)
                # contains the payload delimiter -- refuse the request with
                # the module's typed 400 error rather than let the ValueError
                # escape as an unhandled 500.
                raise _error(400, "peer.invalid_field", str(exc)) from exc

            _grants[grant_id] = {**grant, "booked": False}
            _evict_oldest_beyond_cap()

            chunk_sha256s = json.loads(hash_row.chunk_sha256s) if hash_row.chunk_sha256s else None
            seeder_urls = _seeder_urls(seeder, worker.remote_ip)

        return {
            "grant": {**grant, "sig": sig},
            # 舊 agent 只看 `peer_url`，就是清單的第一個 —— 行為不變。
            "peer_url": seeder_urls[0],
            "seeder_urls": seeder_urls,
            "chunk_sha256s": chunk_sha256s,
        }

    @r.post("/api/agent/peer-served")
    def peer_served(body: PeerServedRequest, worker: db.Worker = Depends(workers.verify_agent)):
        now = time.time()
        _prune_expired(now)

        # Claim atomically under `_grant_lock`: check-not-booked and
        # mark-booked happen as one step, BEFORE the DB insert below, so two
        # concurrent calls for the same grant_id (a client retry racing the
        # original across the threadpool) can't both pass the `booked` check
        # and both insert a receipt (TOCTOU double-booking). Only one thread
        # can hold the lock at a time, so only one can observe `booked is
        # False` and flip it.
        with _grant_lock:
            grant = _grants.get(body.grant_id)
            if grant is None:
                raise _error(404, "peer.no_grant", "Grant not found or expired.")
            if grant["seeder_id"] != worker.id:
                raise _error(403, "peer.not_seeder", "Only the grant's seeder may report bandwidth served.")
            if grant["booked"]:
                raise _error(409, "peer.already_booked", "This grant has already been booked.")
            if body.bytes_served <= 0 or body.bytes_served > grant["size_bytes"] * _BYTES_SERVED_SLACK:
                raise _error(400, "peer.bad_bytes", "bytes_served is out of bounds for this grant.")
            grant["booked"] = True

        # Dedicated signing string for p2p receipts: agentws._sign_and_store_receipt's
        # f"{job_id}|{worker_id}|{gpu_seconds:.1f}" helper is NOT reused here --
        # job_id is always NULL for a p2p_upload receipt, and stringifying
        # None into that payload would silently sign the literal text "None"
        # rather than reflect the receipt's actual (job-less) nature. Canonical
        # pipe-joined payload, mirroring the same signing convention:
        # f"p2p_upload|{grant_id}|{worker_id}|{bytes_served}".
        try:
            payload = f"p2p_upload|{body.grant_id}|{worker.id}|{body.bytes_served}"
            signing_key, _ = security.load_platform_keys(data_dir)
            platform_sig = signing_key.sign(payload.encode()).signature.hex()

            with db.get_session() as session:
                receipt = db.Receipt(
                    job_id=None,
                    worker_id=worker.id,
                    gpu_seconds=0.0,
                    platform_sig=platform_sig,
                    worker_sig=None,
                    kind="p2p_upload",
                    billable=False,
                    basis="wall",
                    bytes=body.bytes_served,
                )
                session.add(receipt)
                session.commit()
                receipt_id = receipt.id
        except Exception:
            # DB insert failed after the claim above already marked the
            # grant booked -- un-mark it under the same lock so a legitimate
            # client retry can still succeed instead of permanently wedging
            # on a grant nothing ever actually booked.
            with _grant_lock:
                still_present = _grants.get(body.grant_id)
                if still_present is not None:
                    still_present["booked"] = False
            raise

        return {"ok": True, "receipt_id": receipt_id}

    return r
