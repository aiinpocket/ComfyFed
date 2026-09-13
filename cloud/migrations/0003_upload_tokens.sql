-- One-time upload tokens for the presigned "direct" artifact upload protocol
-- (Task 8's `POST /api/agent/jobs/{id}/artifacts/presign`). A token is minted
-- server-side, handed back in the presign response as part of the raw-upload
-- URL (`/api/agent/jobs/{id}/artifacts/raw/{token}`), and is the SOLE
-- authentication for the subsequent unsigned `PUT` to that URL -- the token
-- itself proves the caller is the agent that just presigned this exact
-- (job_id, filename, sha256) upload.
--
-- `used` is flipped 0 -> 1 atomically (`UPDATE ... WHERE used = 0`) the
-- moment a PUT successfully verifies and stores its bytes, so a replayed PUT
-- against the same token is rejected (409) rather than double-processed.
-- `expires_at` is epoch-seconds (same shape as migrations/0002_nonces.sql's
-- `nonces.expires_at`) -- a short-lived (10 minute) value never compared
-- against a `toSqliteTimestamp` column.
CREATE TABLE upload_tokens (
    token      TEXT PRIMARY KEY,
    job_id     TEXT NOT NULL,
    filename   TEXT NOT NULL,
    sha256     TEXT NOT NULL,
    size       INTEGER,
    expires_at INTEGER NOT NULL,
    used       INTEGER NOT NULL DEFAULT 0
);
