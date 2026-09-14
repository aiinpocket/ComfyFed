"""Server-learned model hashes + the platform-signed fetch manifest.

Phase 2.1 Task 2 (model auto-distribution). Agents now optionally hash their
local model files and report `sha256` alongside `name`/`size` in their
`inventory` WS message (Phase 2.1 Task 1, `comfyfed_agent.hardware.scan_models`).
This module:

1. Learns a (name, size_bytes) -> sha256 consensus from those reports
   (`record_hash`, called from `agentws._handle_inventory` for every entry
   that carries a `sha256`). Two workers reporting DIFFERENT hashes for the
   same (name, size_bytes) is a same-name-different-content collision --
   never silently overwritten. The first-seen hash wins, a WARNING names
   both workers, and the model name is "poisoned" (excluded from the
   manifest) for the rest of this process's lifetime.

2. Builds the signed fetch manifest (`entries`): joins `model_guide`'s
   name -> download-source lookup (curated `SOURCES` first, `harvest()`
   fallback -- see model_guide.py) with the learned hashes above. Only a
   model with BOTH a known source URL and an agreed sha256 becomes a
   manifest entry, each carrying a platform Ed25519 signature over its own
   `name|directory|sha256|size_bytes` so an agent (or `comfyfed_server`
   dispatch code) can trust a fetched file without re-deriving trust from
   the HTTP connection it came over.

`size_bytes` is the inventory entry's EXACT `os.stat().st_size` (the
`size_bytes` field `hardware.scan_models` adds alongside the display/
compat `size` GB figure -- see its docstring), NOT `model_guide.
ModelSource.size_gb` (hand-curated, coarser, and describes the *expected*
download, not what a worker actually measured on disk) and NOT reconstructed
from the rounded-to-3dp `size` GB figure -- the signed trust payload must
pin the real byte length. An agent that hashes but predates the exact
`size_bytes` field is the one exception: `agentws._record_model_hashes`
falls back to `round(size * 1024**3)` for those reports and documents the
approximation there, at the one call site that needs it, rather than here.

A hash conflict is recorded directly on the `model_hashes` row (`conflict`,
added by migration `c9d0e1f2a3b4`) rather than in an in-memory, per-process
set -- this is a persistent replacement for an earlier in-memory
`_poisoned_names` design, which forgot every conflict on restart and had no
way to be consulted by a second replica behind a load balancer. `entries()`
now excludes any row with `conflict=True` as a plain SQL predicate: no
process/replica coordination needed, and a restart changes nothing about
which names are excluded.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends

from . import assess, auth, db, model_guide, peer, security, workers

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def record_hash(
    worker_id: str,
    name: str,
    size_bytes: int,
    sha256: str,
    chunk_sha256s: list[str] | None = None,
) -> None:
    """Learn one inventory entry's sha256 for (name, size_bytes), and (Phase
    3.1 addendum) its per-64-MiB-chunk hash list alongside it.

    `size_bytes` must be the EXACT byte count (an agent's `os.stat().
    st_size`, per `hardware.scan_models`'s `size_bytes` field) -- this is
    what the manifest signs, so a caller reconstructing it from the
    coarser, rounded-to-3-decimal-GB `size` field (only needed for an
    agent that hashes but predates exact `size_bytes` -- see
    `agentws._record_model_hashes`) must do so itself and document the
    approximation at that call site, not here.

    INSERT OR IGNORE semantics: a first report for (name, size_bytes) is
    stored as-is; a later report for the same key with a MATCHING sha256 is
    a no-op; a later report with a DIFFERENT sha256 is a genuine conflict --
    logged at WARNING with both worker ids, the existing row's sha256/
    first_worker_id are left untouched, and its `conflict` column is set to
    True so `entries()` excludes it. Persistent, not in-memory: unlike the
    old per-process poisoned-name set, this survives a restart and is
    visible to every replica immediately (see this module's docstring).

    `chunk_sha256s` (Phase 3.1 addendum, `db.ModelHash.chunk_sha256s`):
    stored (as JSON text) the FIRST time a reporter's whole-file hash
    matches/establishes consensus for (name, size_bytes) and no chunk list
    is on the row yet. Once a chunk list is stored it is never overwritten
    by a later, different one -- the whole-file hash is the sole trust
    root (final whole-file verification always runs on every P2P download
    regardless of chunk hashes), so a second reporter's differing chunk
    list is merely suspicious, not a poisoning event: logged once at
    WARNING and otherwise ignored, WITHOUT touching `conflict` (that stays
    reserved for a genuine whole-file sha256 disagreement). A report that
    disagrees on the whole-file hash never contributes its chunk list
    either -- see the conflict branch below.
    """
    chunk_json = json.dumps(chunk_sha256s) if chunk_sha256s else None

    with db.get_session() as session:
        existing = session.get(db.ModelHash, (name, size_bytes))
        if existing is None:
            session.add(
                db.ModelHash(
                    name=name,
                    size_bytes=size_bytes,
                    sha256=sha256,
                    first_worker_id=worker_id,
                    created_at=_utcnow(),
                    chunk_sha256s=chunk_json,
                )
            )
            session.commit()
            return

        if existing.sha256 == sha256:
            if chunk_json is not None:
                if existing.chunk_sha256s is None:
                    existing.chunk_sha256s = chunk_json
                    session.commit()
                elif existing.chunk_sha256s != chunk_json:
                    logger.warning(
                        "model_manifest: chunk_sha256s mismatch for %s "
                        "(size_bytes=%s) reported by worker %s -- whole-file "
                        "sha256 still agrees, so this is not a conflict; "
                        "keeping the first-seen chunk list (final whole-file "
                        "verification is the trust root regardless of any "
                        "chunk list)",
                        name,
                        size_bytes,
                        worker_id,
                    )
            return

        logger.warning(
            "model_manifest: sha256 conflict for %s (size_bytes=%s): "
            "worker %s reported %s, worker %s previously reported %s -- "
            "keeping the first-seen hash and excluding this name from the "
            "fetch manifest",
            name,
            size_bytes,
            worker_id,
            sha256,
            existing.first_worker_id,
            existing.sha256,
        )
        existing.conflict = True
        session.commit()


def _find_hash_row(rows: list, source_key: str):
    """First `model_hashes` row whose (inventory-relative) name matches
    `source_key` (a bare model_guide name), per `assess.matches_model_name`
    semantics -- same name-normalization an inventory entry uses to satisfy
    a workflow's loader value.
    """
    for row in rows:
        if assess.matches_model_name(row.name, source_key):
            return row
    return None


def _split_inventory_name(inventory_name: str) -> tuple[str, str]:
    """Split an inventory-relative model path (`"directory/name"`, the shape
    `hardware.scan_models` reports and `db.ModelHash.name` stores) into
    `(directory, name)`, the same one-level convention Task 5's agent-side
    `fetcher._inventory_name` reconstructs from and `peerserve._sanitize_peer_name`
    caps names at. A path with no `/` at all (no category) yields
    `("", inventory_name)`.
    """
    normalized = inventory_name.replace("\\", "/").lstrip("/")
    directory, separator, remainder = normalized.partition("/")
    if not separator:
        return "", normalized
    return directory, remainder


def _seeder_candidate_files(session) -> frozenset[tuple[str, int, str]]:
    """Every `(name, size_bytes, sha256)` triple currently offered by an
    online, protocol>=4, peer_url-advertising worker -- built ONCE per
    `entries()` call (final-review M3 fix) so the per-`model_hashes`-row loop
    below can answer "does this row have an online seeder right now?" with an
    O(1) set-membership check instead of calling `peer.online_seeders` (its
    own `db.Worker` query plus a fresh `json.loads` of every worker's
    `model_inventory`) once per row. Before this, R hash rows and W workers
    meant R worker queries and R x W inventory parses every `entries()` call
    (every 5s dispatch tick, per-request from jobs.py/comfyapi.py) -- this
    hoists the worker query and every inventory parse out of that loop
    entirely, to run exactly once.

    Same predicate as `peer.online_seeders` (online, protocol>=4, peer_url
    not null), reused as a plain SQL filter here since the module already
    defines `_MIN_PEER_PROTOCOL`, rather than re-deriving it.
    """
    query = (
        session.query(db.Worker)
        .filter(db.Worker.status != "offline")
        .filter(db.Worker.protocol >= peer._MIN_PEER_PROTOCOL)
        .filter(db.Worker.peer_url.isnot(None))
    )
    files: set[tuple[str, int, str]] = set()
    for worker in query.all():
        for inv_entry in peer._worker_inventory(worker):
            if not isinstance(inv_entry, dict):
                continue
            name = inv_entry.get("name")
            size_bytes = inv_entry.get("size_bytes")
            sha256 = inv_entry.get("sha256")
            if not isinstance(name, str) or not isinstance(sha256, str):
                continue
            if not isinstance(size_bytes, int) or isinstance(size_bytes, bool):
                continue
            files.add((name, size_bytes, sha256))
    return files


def _row_has_seeder(row: db.ModelHash, seeder_files: frozenset[tuple[str, int, str]]) -> bool:
    """Whether `row` (name, size_bytes, sha256) is in the batched
    `_seeder_candidate_files()` set -- the per-row replacement for calling
    `peer.online_seeders(session, row.name, row.size_bytes)` (see M3)."""
    return (row.name, row.size_bytes, row.sha256) in seeder_files


def _peer_only_entry(signing_key, row: db.ModelHash, seeder_files: frozenset[tuple[str, int, str]]) -> Optional[dict]:
    """Build a peer-only manifest entry for `row` (a non-conflicted
    `model_hashes` row with no known download source), or None when it has no
    online seeder right now.

    This is `entries()`'s embodiment of the task brief's `fetchable(name,
    size)` predicate for the peer branch: "consensus hash exists AND at least
    one online seeder offers it" -- `seeder_files`, the batched set built
    once per `entries()` call by `_seeder_candidate_files` (M3), replaces a
    direct `peer.online_seeders` call here so this stays a cheap set lookup
    per row instead of its own DB query + inventory parse.
    `url`/`backup_url` are None and `peer: True` marks the entry so a
    consumer (assess.verdict's protocol>=4 gate, the agent fetcher) knows
    this model has no URL fallback at all.
    """
    if not _row_has_seeder(row, seeder_files):
        return None

    directory, name = _split_inventory_name(row.name)

    # Same defensive `|` guard as the URL-sourced branch below -- an agent-
    # reported inventory name is untrusted input relative to this process.
    if "|" in name or "|" in directory:
        logger.warning(
            "model_manifest: skipping peer-only manifest candidate with a "
            "'|' in name or directory (payload delimiter): name=%r directory=%r",
            name,
            directory,
        )
        return None

    payload = f"{name}|{directory}|{row.sha256}|{row.size_bytes}"
    sig = signing_key.sign(payload.encode()).signature.hex()

    return {
        "name": name,
        "directory": directory,
        "url": None,
        "backup_url": None,
        "sha256": row.sha256,
        "size_bytes": row.size_bytes,
        "sig": sig,
        "peer": True,
    }


def peer_only_names(manifest_entries: list[dict]) -> frozenset[str]:
    """The subset of `entries()`'s output whose ONLY source is a peer (`url`
    is None) -- names a candidate fetching worker must be protocol>=4 to
    pull, per the task brief's eligibility gate. A model that has both a URL
    and an online seeder (`peer: True` alongside a real `url`) is NOT in this
    set: protocol>=3 stays sufficient for it, exactly as today, since the
    agent fetcher falls back to the URL chain when a peer pull fails.
    """
    return frozenset(e["name"] for e in manifest_entries if e.get("url") is None)


def entries(data_dir: str) -> list[dict]:
    """Build the signed fetch-manifest entry list.

    Two kinds of entries:

    1. URL-sourced: a known download source (curated or harvested, with a
       non-empty `official_url`) AND an agreed, non-conflicting learned
       sha256 (`model_hashes.conflict == False`). If that same (name,
       size_bytes) also has an online peer seeder right now
       (`peer.online_seeders`), the entry additionally carries `"peer":
       True` -- informative only, since the agent fetcher always tries a
       peer source first regardless of this flag (Task 5) -- so dispatch/
       assess never need a second code path to learn "this model also has a
       seeder".
    2. Peer-only (Phase 3.1): a `model_hashes` row with an agreed hash but NO
       known download source, that DOES have an online seeder right now --
       see `_peer_only_entry`. `url`/`backup_url` are None and `peer: True`.

    Every entry's `sig` is a platform Ed25519 signature (hex) over
    `f"{name}|{directory}|{sha256}|{size_bytes}"` -- unchanged shape for both
    kinds, the URL fields are simply not part of what's signed.
    """
    signing_key, _ = security.load_platform_keys(data_dir)

    names = set(model_guide.SOURCES.keys()) | set(model_guide.harvest(data_dir).keys())

    with db.get_session() as session:
        # Persistent exclusion (migration c9d0e1f2a3b4): a conflicted row is
        # never a candidate, full stop -- no in-memory set to consult, and
        # this is correct across a restart or another replica immediately.
        hash_rows = list(
            session.query(db.ModelHash).filter(db.ModelHash.conflict == False).all()  # noqa: E712
        )

        # M3 final-review fix: one worker query + one inventory parse per
        # worker for this whole call, instead of once per hash row below.
        seeder_files = _seeder_candidate_files(session)

        result: list[dict] = []
        used_rows: set[tuple[str, int]] = set()
        for name in sorted(names):
            source = model_guide.lookup(name, data_dir)
            if source is None or not source.official_url:
                continue

            row = _find_hash_row(hash_rows, name)
            if row is None:
                continue

            # Defensive: `|` is the field delimiter in the signed payload
            # below. `source.name`/`source.directory` should never
            # legitimately contain one (model filenames and category folders
            # don't use it), but a harvested entry's `name`/`directory` come
            # straight off a workflow JSON on disk -- untrusted input
            # relative to this process. Letting one through would let a
            # crafted `directory` value (e.g. containing an extra
            # `|1234|sha|`) shift which substring the signature is later
            # parsed as covering, forging a payload the platform never
            # actually intended to sign for.
            if "|" in source.name or "|" in source.directory:
                logger.warning(
                    "model_manifest: skipping manifest candidate with a '|' in "
                    "name or directory (payload delimiter): name=%r directory=%r",
                    source.name,
                    source.directory,
                )
                continue

            payload = f"{source.name}|{source.directory}|{row.sha256}|{row.size_bytes}"
            sig = signing_key.sign(payload.encode()).signature.hex()

            entry = {
                "name": source.name,
                "directory": source.directory,
                "url": source.official_url,
                "backup_url": source.backup_url,
                "sha256": row.sha256,
                "size_bytes": row.size_bytes,
                "sig": sig,
            }
            if _row_has_seeder(row, seeder_files):
                entry["peer"] = True
            result.append(entry)
            used_rows.add((row.name, row.size_bytes))

        # Phase 3.1: every remaining non-conflicted hash row (no known
        # download source at all) becomes a peer-only entry when it has an
        # online seeder right now.
        for row in hash_rows:
            key = (row.name, row.size_bytes)
            if key in used_rows:
                continue
            peer_entry = _peer_only_entry(signing_key, row, seeder_files)
            if peer_entry is not None:
                result.append(peer_entry)

    return result


def create_router(data_dir: str) -> APIRouter:
    """`/api/agent/manifest` (signed-agent auth) and `/api/models/manifest`
    (admin session auth) -- both return `{"entries": [...]}` from `entries()`.
    The agent route is also called internally by dispatch/auto-fetch code
    (Task 3/4), not just over HTTP.
    """
    r = APIRouter()

    @r.get("/api/agent/manifest")
    def agent_manifest(_worker: db.Worker = Depends(workers.verify_agent)):
        return {"entries": entries(data_dir)}

    @r.get("/api/models/manifest")
    def admin_manifest(_payload: dict = Depends(auth.require_admin)):
        return {"entries": entries(data_dir)}

    return r
