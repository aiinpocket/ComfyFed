-- Phase 3.0 multi-user: `users` table, `jobs.user_id`, `login_attempts.
-- username`, plus the one-time data migration that promotes the legacy
-- single-admin `settings.admin_password_hash` row into the first `users`
-- row. Parity source: server/alembic/versions/d0e1f2a3b4c5_users_multiuser.py.
--
-- Types: `disabled`/`session_epoch` follow this file's existing convention
-- (INTEGER 0/1 for booleans, since D1/SQLite has no native BOOLEAN -- see
-- 0001_initial.sql's header comment). `created_at` is a `toSqliteTimestamp`-
-- shaped string (see db/queries.ts), same as every other timestamp column in
-- this schema.
CREATE TABLE users (
    id             TEXT PRIMARY KEY,
    username       TEXT NOT NULL UNIQUE,
    password_hash  TEXT NOT NULL,
    role           TEXT NOT NULL,
    disabled       INTEGER NOT NULL DEFAULT 0,
    session_epoch  INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT NOT NULL
);

-- Nullable: pre-migration jobs get backfilled below (to the migrated admin
-- user, if any); a brand-new install has no jobs yet to backfill.
ALTER TABLE jobs ADD COLUMN user_id TEXT;

-- Nullable: pre-migration login_attempts rows predate per-username backoff
-- and are simply left with a NULL username (they age out of the 10-minute
-- backoff window on their own and are never queried by the new
-- per-username-filtered query).
ALTER TABLE login_attempts ADD COLUMN username TEXT;

-- Data migration -- mirrors the Alembic revision's `if row is not None:`
-- guard as a plain `INSERT ... SELECT ... FROM settings WHERE key = ...`:
-- this is a no-op (inserts zero rows) when the setting is absent, e.g. a
-- brand-new deployment that will instead create its admin row via
-- `/api/setup`. D1/SQLite has no `uuid4()`; `lower(hex(randomblob(16)))`
-- produces an equivalent 32-hex-char random id. `created_at` uses the same
-- `YYYY-MM-DD HH:MM:SS.ffffff` shape `toSqliteTimestamp` writes elsewhere
-- (sqlite's `%f` gives millisecond precision -- `SS.SSS` -- so the trailing
-- `000` pads it out to the full 6 fractional digits, exactly like
-- `toSqliteTimestamp` zero-pads JS's own millisecond clock).
INSERT INTO users (id, username, password_hash, role, disabled, session_epoch, created_at)
SELECT lower(hex(randomblob(16))), 'admin', value, 'admin', 0, 0,
       strftime('%Y-%m-%d %H:%M:%f', 'now') || '000'
FROM settings
WHERE key = 'admin_password_hash';

-- Point every pre-existing job at the migrated admin user (if one was just
-- created above; NULL id makes this a no-op on a fresh install with no such
-- setting and therefore no such user).
UPDATE jobs
SET user_id = (SELECT id FROM users WHERE username = 'admin')
WHERE (SELECT id FROM users WHERE username = 'admin') IS NOT NULL;

-- Credentials now live in `users`, not `settings` -- retire the old key.
DELETE FROM settings WHERE key = 'admin_password_hash';
