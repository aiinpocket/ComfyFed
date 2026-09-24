-- Consolidated schema, equivalent to the Python server's Alembic head
-- (the former Python server's alembic history, 2026-09).
--
-- Source revisions consolidated here, in order:
--   fdcf5a609e43  initial schema
--   a1b2c3d4e5f6  add job input_assets
--   b2c3d4e5f6a7  add worker object_info_hash
--   c3d4e5f6a7b8  add job result_hashes
--   d4e5f6a7b8c9  add job last_worker_id
--   e5f6a7b8c9d0  job origin, panel_hidden
--   f6a7b8c9d0e1  receipt kind, billable, basis
--   a7b8c9d0e1f2  worker protocol
--
-- Types: SQLite/D1 has no native BOOLEAN; the Python side stores booleans as
-- INTEGER 0/1 via SQLAlchemy's Boolean type on SQLite, so columns that are
-- `Mapped[bool]` here are declared INTEGER NOT NULL DEFAULT 0/1 to match.

CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE workers (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    pubkey            TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'offline',
    last_seen         TEXT,
    disabled          INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL,
    hardware          TEXT NOT NULL DEFAULT '{}',
    dynamic           TEXT NOT NULL DEFAULT '{}',
    backend           TEXT NOT NULL DEFAULT '',
    torch_version     TEXT NOT NULL DEFAULT '',
    node_classes      TEXT NOT NULL DEFAULT '[]',
    model_inventory   TEXT NOT NULL DEFAULT '[]',
    object_info_hash  TEXT NOT NULL DEFAULT '',
    -- Agent protocol version reported in `hello` (see agentws._handle_hello).
    -- 1 = pre-Phase-1.9 agent (no guaranteed exec_seconds, no job_cancelled
    -- push support); 2 = current comfyfed-agent.
    protocol          INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE register_tokens (
    token       TEXT PRIMARY KEY,
    worker_name TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE jobs (
    id               TEXT PRIMARY KEY,
    workflow_json    TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'queued',
    worker_id        TEXT,
    -- The worker that most recently held this job before it went back to
    -- `queued` (a stale-worker requeue). Lets dispatch.try_readopt tell "you
    -- blipped offline and are back" apart from "someone else owns it now".
    last_worker_id   TEXT,
    progress         REAL NOT NULL DEFAULT 0,
    created_at       TEXT NOT NULL,
    started_at       TEXT,
    finished_at      TEXT,
    error            TEXT,
    result_files     TEXT NOT NULL DEFAULT '[]',
    requirements     TEXT NOT NULL DEFAULT '{}',
    required_nodes   TEXT NOT NULL DEFAULT '[]',
    required_models  TEXT NOT NULL DEFAULT '[]',
    est_vram_gb      REAL,
    input_assets     TEXT NOT NULL DEFAULT '[]',
    result_hashes    TEXT NOT NULL DEFAULT '{}',
    -- Who submitted this job: "panel" (the ComfyUI-compatible surface at
    -- /comfy/api/*) or "console" (ComfyFed's own /api/jobs).
    origin           TEXT NOT NULL DEFAULT 'console',
    -- Soft-delete flag for the panel's own history view only (GET
    -- /comfy/api/history excludes these); the row is never actually deleted
    -- because receipts reference jobs by id. Console's /api/jobs ignores
    -- this entirely.
    panel_hidden     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE receipts (
    id           TEXT PRIMARY KEY,
    job_id       TEXT NOT NULL,
    worker_id    TEXT NOT NULL,
    gpu_seconds  REAL NOT NULL,
    platform_sig TEXT NOT NULL,
    worker_sig   TEXT,
    created_at   TEXT NOT NULL,
    -- What kind of job outcome this receipt records: "completed" | "failed"
    -- | "cancelled" -- see agentws._create_and_push_receipt /
    -- _create_and_push_failure_receipt / _mint_cancelled_receipt.
    kind         TEXT NOT NULL DEFAULT 'completed',
    -- Whether this receipt counts toward billed GPU time. Failed and
    -- cancelled runs still record gpu_seconds (capacity/health reporting)
    -- but must never be billed.
    billable     INTEGER NOT NULL DEFAULT 1,
    -- How `gpu_seconds` was derived: "exec" (agent-measured GPU execution
    -- time) or "wall" (wall-clock fallback).
    basis        TEXT NOT NULL DEFAULT 'exec'
);

CREATE TABLE login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL
);
