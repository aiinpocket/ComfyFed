-- Phase 3.4 P2P NAT 穿越，cloud parity of
-- server/alembic/versions/b3c4d5e6f7a8_peer_nat.py.

ALTER TABLE workers ADD COLUMN peer_lan_url TEXT;
ALTER TABLE workers ADD COLUMN peer_nat TEXT NOT NULL DEFAULT 'lan';
ALTER TABLE workers ADD COLUMN peer_reachable INTEGER;
ALTER TABLE workers ADD COLUMN peer_checked_at TEXT;
ALTER TABLE workers ADD COLUMN remote_ip TEXT;
