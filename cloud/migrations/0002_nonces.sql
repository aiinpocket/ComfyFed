-- Replay-protection store for signed agent requests (Task 5), the D1
-- equivalent of workers.py's in-process `_seen_nonces: dict[tuple[str, str],
-- float]`. A worker's (worker_id, nonce) pair is remembered for
-- `_NONCE_TTL_SECONDS` (300s, see src/lib/verify_agent.ts) after first use;
-- a reused pair within that window is rejected as a replay.
--
-- D1 has no long-lived process to prune this in the background the way
-- Python's `_prune_nonces` runs opportunistically inside `verify_agent` on
-- every call -- the cloud port keeps that same "prune opportunistically on
-- every verification" shape (see verifyAgentRequest), just against this
-- table instead of the in-memory dict.
--
-- expires_at is an epoch-seconds INTEGER (not a `toSqliteTimestamp` string)
-- since nonce expiry is a short-lived (300s) monotonic-ish comparison against
-- `Date.now() / 1000`, not a value ever surfaced to a human or compared
-- against other sqlite-timestamp columns.
CREATE TABLE nonces (
    worker_id  TEXT NOT NULL,
    nonce      TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (worker_id, nonce)
);
