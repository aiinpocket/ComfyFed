-- Fix round 1 (Task 7 review, m1 promoted to a real fix): a hash conflict
-- for a (name, size_bytes) key used to be tracked ONLY in the Hub Durable
-- Object's in-memory `poisonedModelNames` set -- unreachable from any plain
-- HTTP route and forgotten on DO eviction. Persisting it directly on the
-- `model_hashes` row (mirrors server/alembic/versions/c9d0e1f2a3b4) makes
-- exclusion a plain SQL predicate any route/DO can apply on its own, with no
-- coordination needed.
ALTER TABLE model_hashes ADD COLUMN conflict INTEGER NOT NULL DEFAULT 0;
