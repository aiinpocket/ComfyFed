-- Phase 3.1 addendum (成員間 P2P 分塊傳輸), Task 8 cloud parity. Mirrors
-- server/alembic/versions/e1f2a3b4c5d6_p2p.py (Task 1) + the p2p_grants
-- in-memory book of the former Python peer module (Task 3), persisted
-- here in D1 instead (see queries.ts's p2p_grants helpers docstring for
-- why an in-memory dict is not Workers-correct).

-- Task 1/2: per-64-MiB-chunk sha256 list learned alongside the whole-file
-- consensus hash -- see core/model_manifest.ts's recordHash docstring for
-- the "stored on first report, never overwritten" rule this backs.
ALTER TABLE model_hashes ADD COLUMN chunk_sha256s TEXT;

-- Task 1: the agent's advertised peer-serving endpoint (e.g.
-- "http://192.168.1.5:8850"), set from hello.peer_url when the agent has
-- peer_serve enabled and a usable advertise host -- see do/hub.ts's
-- handleHello / the agentws._parse_peer_url mirror. Hello-only, cleared on
-- the stale/offline transition (dispatch.ts's requeueStale).
ALTER TABLE workers ADD COLUMN peer_url TEXT;

-- Task 3: receipts.bytes (nullable INTEGER, the p2p_upload kind's actual
-- bytes served) and receipts.job_id becoming nullable (a p2p_upload receipt
-- has no job at all). 0001_initial.sql declared job_id TEXT NOT NULL, and
-- SQLite/D1 has no ALTER COLUMN -- table-rebuild pattern: create the new
-- shape, copy every row (bytes defaults NULL for pre-existing rows), drop
-- the old table, rename. No indexes existed on receipts to recreate.
CREATE TABLE receipts_new (
    id           TEXT PRIMARY KEY,
    job_id       TEXT,
    worker_id    TEXT NOT NULL,
    gpu_seconds  REAL NOT NULL,
    platform_sig TEXT NOT NULL,
    worker_sig   TEXT,
    created_at   TEXT NOT NULL,
    kind         TEXT NOT NULL DEFAULT 'completed',
    billable     INTEGER NOT NULL DEFAULT 1,
    basis        TEXT NOT NULL DEFAULT 'exec',
    -- Actual bytes served for a p2p_upload receipt; NULL for every other
    -- kind. Only p2p_upload may have a NULL job_id (Global Constraints).
    bytes        INTEGER
);

INSERT INTO receipts_new (id, job_id, worker_id, gpu_seconds, platform_sig, worker_sig, created_at, kind, billable, basis, bytes)
SELECT id, job_id, worker_id, gpu_seconds, platform_sig, worker_sig, created_at, kind, billable, basis, NULL
FROM receipts;

DROP TABLE receipts;
ALTER TABLE receipts_new RENAME TO receipts;

-- Task 3: the grant book (the former Python peer module's in-memory
-- `_grants` dict, ported to D1 -- a Worker isolate's in-memory state is not
-- reliable/shared across requests, so this is the Workers-correct
-- equivalent, not a stylistic choice). Atomic booking is a single
-- `UPDATE ... WHERE grant_id = ? AND booked = 0` checked against
-- `meta.changes`, the D1 analogue of peer.py's `_grant_lock`-guarded
-- check-then-set (see core/peer.ts).
CREATE TABLE p2p_grants (
    grant_id    TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    size_bytes  INTEGER NOT NULL,
    sha256      TEXT NOT NULL,
    seeder_id   TEXT NOT NULL,
    puller_id   TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    booked      INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
);
