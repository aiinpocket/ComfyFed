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

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from . import assess, auth, db, model_guide, security, workers

logger = logging.getLogger(__name__)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def record_hash(worker_id: str, name: str, size_bytes: int, sha256: str) -> None:
    """Learn one inventory entry's sha256 for (name, size_bytes).

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
    """
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
                )
            )
            session.commit()
            return

        if existing.sha256 == sha256:
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


def entries(data_dir: str) -> list[dict]:
    """Build the signed fetch-manifest entry list.

    Only models with BOTH a known download source (curated or harvested,
    with a non-empty `official_url`) AND an agreed, non-conflicting learned
    sha256 (`model_hashes.conflict == False`) become entries. Each entry's
    `sig` is a platform Ed25519 signature (hex) over
    `f"{name}|{directory}|{sha256}|{size_bytes}"`.
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

    result: list[dict] = []
    for name in sorted(names):
        source = model_guide.lookup(name, data_dir)
        if source is None or not source.official_url:
            continue

        row = _find_hash_row(hash_rows, name)
        if row is None:
            continue

        # Defensive: `|` is the field delimiter in the signed payload below.
        # `source.name`/`source.directory` should never legitimately contain
        # one (model filenames and category folders don't use it), but a
        # harvested entry's `name`/`directory` come straight off a workflow
        # JSON on disk -- untrusted input relative to this process. Letting
        # one through would let a crafted `directory` value (e.g.
        # containing an extra `|1234|sha|`) shift which substring the
        # signature is later parsed as covering, forging a payload the
        # platform never actually intended to sign for.
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

        result.append(
            {
                "name": source.name,
                "directory": source.directory,
                "url": source.official_url,
                "backup_url": source.backup_url,
                "sha256": row.sha256,
                "size_bytes": row.size_bytes,
                "sig": sig,
            }
        )

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
