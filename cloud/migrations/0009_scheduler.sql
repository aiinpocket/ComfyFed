-- Phase 3.3 排程優化與批次拆分，cloud parity of
-- server/alembic/versions/a2b3c4d5e6f7_scheduler_and_split.py.

ALTER TABLE jobs ADD COLUMN signature TEXT;
ALTER TABLE jobs ADD COLUMN dispatch_info TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN parent_id TEXT;
ALTER TABLE jobs ADD COLUMN split_index INTEGER;
ALTER TABLE jobs ADD COLUMN split_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN split_plan TEXT;

ALTER TABLE workers ADD COLUMN speed_index REAL NOT NULL DEFAULT 1.0;
ALTER TABLE workers ADD COLUMN warm_models TEXT NOT NULL DEFAULT '[]';

CREATE TABLE worker_job_stats (
  worker_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  ewma_seconds REAL NOT NULL,
  samples INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (worker_id, signature)
);

CREATE INDEX ix_worker_job_stats_signature ON worker_job_stats (signature);
CREATE INDEX ix_jobs_parent_id ON jobs (parent_id);
