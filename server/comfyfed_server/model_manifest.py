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

`size_bytes` is derived from the inventory's `size` (GIGABYTES, 3dp -- see
`agentws._normalize_models`), NOT from `model_guide.ModelSource.size_gb`
(hand-curated, coarser, and describes the *expected* download, not what a
worker actually measured on disk). Rounding a GB-precision float back to
bytes is inherently approximate, but it is the only size information the
wire contract carries; the composite (name, size_bytes) primary key still
does its job of separating genuinely different files reported under the
same name.

The poisoned-name set is an in-memory, per-process, module-level `set`. It
is NOT persisted and NOT shared across server processes/replicas -- a
restart (or a second replica behind a load balancer) forgets it and would
re-admit a previously-poisoned name unless the conflicting hash rows are
still both present in `model_hashes` (they are, so the very next reporting
worker's entry reproduces the same conflict and re-poisons it; the only
gap is a brief window right after restart during which a stale manifest
entry could theoretically be served).
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends

from . import assess, auth, db, model_guide, security, workers

logger = logging.getLogger(__name__)

# Model names (as reported in inventory -- i.e. relative to the agent's
# models root, NOT model_guide's bare name) that have a hash conflict
# between two or more workers. Excluded from `entries()` until the process
# restarts. Per-process, in-memory, documented above -- never persisted.
_poisoned_names: set[str] = set()


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def poisoned_names() -> frozenset[str]:
    """Read-only snapshot of the current poisoned-name set (tests, admin UI)."""
    return frozenset(_poisoned_names)


def record_hash(worker_id: str, name: str, size_gb: float, sha256: str) -> None:
    """Learn one inventory entry's sha256 for (name, size).

    `size_gb` is the inventory's `size` field (GB, see module docstring);
    converted to an integer byte count for the `model_hashes` PK. INSERT OR
    IGNORE semantics: a first report for (name, size_bytes) is stored as-is;
    a later report for the same key with a MATCHING sha256 is a no-op; a
    later report with a DIFFERENT sha256 is a genuine conflict -- logged at
    WARNING with both worker ids, the existing row is left untouched, and
    `name` is added to the poisoned set so `entries()` excludes it.
    """
    size_bytes = round(size_gb * (1024 ** 3))

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
        _poisoned_names.add(name)


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
    with a non-empty `official_url`) AND an agreed, non-poisoned learned
    sha256 become entries. Each entry's `sig` is a platform Ed25519
    signature (hex) over `f"{name}|{directory}|{sha256}|{size_bytes}"`.
    """
    signing_key, _ = security.load_platform_keys(data_dir)

    names = set(model_guide.SOURCES.keys()) | set(model_guide.harvest(data_dir).keys())

    with db.get_session() as session:
        hash_rows = list(session.query(db.ModelHash).all())

    result: list[dict] = []
    for name in sorted(names):
        source = model_guide.lookup(name, data_dir)
        if source is None or not source.official_url:
            continue

        row = _find_hash_row(hash_rows, name)
        if row is None or row.name in _poisoned_names:
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
