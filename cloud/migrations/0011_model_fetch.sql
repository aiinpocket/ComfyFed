-- 2026-09-19 panel download button -> model_fetch job (spec §4), cloud parity
-- of the former Python server's alembic migration c4d5e6f7a8b9_model_fetch.
--
-- `kind` defaults to 'prompt' so every existing row (and every INSERT that
-- does not name the column) keeps its current meaning exactly; `fetch_entry`
-- holds the manifest entry signed at creation time and is NULL for anything
-- that is not a model_fetch job.

ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'prompt';
ALTER TABLE jobs ADD COLUMN fetch_entry TEXT;
