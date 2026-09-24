-- Phase 2.1 (model auto-fetch), Task 7 cloud parity. Mirrors
-- the former Python server's `ModelHash` model and `Worker.auto_fetch`
-- column (upstream Tasks 1-4).
--
-- `model_hashes` is the server-learned (name, size_bytes) -> sha256
-- consensus table `model_manifest.record_hash` reads/writes -- see
-- `core/model_manifest.ts`'s docstring for the conflict/poison rule this
-- backs. PRIMARY KEY (name, size_bytes) gives the same "first write wins,
-- INSERT OR IGNORE" semantics D1's `ON CONFLICT DO NOTHING` reproduces.
CREATE TABLE model_hashes (
    name             TEXT NOT NULL,
    size_bytes       INTEGER NOT NULL,
    sha256           TEXT NOT NULL,
    first_worker_id  TEXT NOT NULL,
    created_at       TEXT NOT NULL,
    PRIMARY KEY (name, size_bytes)
);

-- Agent-side opt-in for manifest-based model auto-fetch (hello.auto_fetch,
-- see agentws._handle_hello / do/hub.ts's handleHello). Off by default --
-- workers keep sovereignty over unattended downloads.
ALTER TABLE workers ADD COLUMN auto_fetch INTEGER NOT NULL DEFAULT 0;
