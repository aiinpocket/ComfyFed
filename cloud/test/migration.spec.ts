import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

// Confirms the vitest-pool-workers D1 binding actually applied
// cloud/migrations/0001_initial.sql (declared via wrangler.jsonc's
// d1_databases[].migrations_dir) before this test file's requests run --
// i.e. every table from the consolidated Alembic-head schema exists with the
// columns Task 1's brief calls out by name (origin/panel_hidden, protocol,
// kind/billable/basis).
describe("D1 migration 0001_initial", () => {
  it("creates every table", async () => {
    const db = (env as any).DB as D1Database;
    const rows = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = rows.results.map((r) => r.name).filter((n) => !n.startsWith("sqlite_") && !n.startsWith("_cf_") && !n.startsWith("d1_"));
    expect(names.sort()).toEqual(
      [
        "jobs",
        "login_attempts",
        "model_hashes",
        "nonces",
        "p2p_grants",
        "receipts",
        "register_tokens",
        "settings",
        "upload_tokens",
        "users",
        "worker_job_stats",
        "workers",
      ].sort()
    );
  });

  it("jobs has origin, panel_hidden, last_worker_id, input_assets, result_hashes", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
    const names = new Set(cols.results.map((c) => c.name));
    for (const col of [
      "origin",
      "panel_hidden",
      "last_worker_id",
      "input_assets",
      "result_hashes",
      "est_vram_gb",
    ]) {
      expect(names.has(col), `jobs.${col} missing`).toBe(true);
    }
  });

  it("workers has protocol and object_info_hash", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(workers)").all<{ name: string }>();
    const names = new Set(cols.results.map((c) => c.name));
    expect(names.has("protocol")).toBe(true);
    expect(names.has("object_info_hash")).toBe(true);
  });

  it("receipts has kind, billable, basis", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(receipts)").all<{ name: string }>();
    const names = new Set(cols.results.map((c) => c.name));
    for (const col of ["kind", "billable", "basis"]) {
      expect(names.has(col), `receipts.${col} missing`).toBe(true);
    }
  });

  it("can insert and read a job row using declared defaults", async () => {
    const db = (env as any).DB as D1Database;
    await db
      .prepare(
        "INSERT INTO jobs (id, workflow_json, created_at) VALUES (?, ?, ?)"
      )
      .bind("job-1", "{}", new Date().toISOString())
      .run();
    const row = await db
      .prepare("SELECT status, origin, panel_hidden, progress FROM jobs WHERE id = ?")
      .bind("job-1")
      .first<{ status: string; origin: string; panel_hidden: number; progress: number }>();
    expect(row?.status).toBe("queued");
    expect(row?.origin).toBe("console");
    expect(row?.panel_hidden).toBe(0);
    expect(row?.progress).toBe(0);
  });
});

// Task 5's replay-protection store (verify_agent's nonce reuse check).
describe("D1 migration 0002_nonces", () => {
  it("creates the nonces table with a (worker_id, nonce) primary key", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(nonces)").all<{ name: string; pk: number }>();
    const byName = new Map(cols.results.map((c) => [c.name, c]));
    expect(byName.has("worker_id")).toBe(true);
    expect(byName.has("nonce")).toBe(true);
    expect(byName.has("expires_at")).toBe(true);
    expect(byName.get("worker_id")!.pk).toBeGreaterThan(0);
    expect(byName.get("nonce")!.pk).toBeGreaterThan(0);
  });

  it("rejects a duplicate (worker_id, nonce) pair", async () => {
    const db = (env as any).DB as D1Database;
    await db.prepare("INSERT INTO nonces (worker_id, nonce, expires_at) VALUES ('w1', 'n1', 100)").run();
    await expect(
      db.prepare("INSERT INTO nonces (worker_id, nonce, expires_at) VALUES ('w1', 'n1', 200)").run()
    ).rejects.toThrow();
  });
});

// Task 9's `users` table, `jobs.user_id`, `login_attempts.username` (Phase
// 3.0 multi-user). The `admin_password_hash` -> `users` data migration itself
// is exercised end-to-end via `/api/setup` in test/auth.spec.ts (there is no
// legacy `admin_password_hash` row for this fresh-install test DB to migrate
// FROM -- vitest-pool-workers always applies every migration, 0001..0006,
// against a brand-new D1 instance, so the data-migration's `INSERT ...
// SELECT ... WHERE EXISTS`-shaped guard is a guaranteed no-op here).
describe("D1 migration 0006_users", () => {
  it("creates the users table with the expected columns and defaults", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(users)").all<{ name: string }>();
    const names = new Set(cols.results.map((c) => c.name));
    for (const col of ["id", "username", "password_hash", "role", "disabled", "session_epoch", "created_at"]) {
      expect(names.has(col), `users.${col} missing`).toBe(true);
    }

    await db
      .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'zed', 'hash', 'user', '2026-01-01 00:00:00.000000')")
      .run();
    const row = await db
      .prepare("SELECT disabled, session_epoch FROM users WHERE id = 'u1'")
      .first<{ disabled: number; session_epoch: number }>();
    expect(row?.disabled).toBe(0);
    expect(row?.session_epoch).toBe(0);

    await db.prepare("DELETE FROM users").run();
  });

  it("rejects a duplicate username (UNIQUE constraint)", async () => {
    const db = (env as any).DB as D1Database;
    await db
      .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'zed', 'hash', 'user', '2026-01-01 00:00:00.000000')")
      .run();
    await expect(
      db
        .prepare("INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u2', 'zed', 'hash', 'user', '2026-01-01 00:00:00.000000')")
        .run()
    ).rejects.toThrow();
    await db.prepare("DELETE FROM users").run();
  });

  it("jobs has a nullable user_id column and login_attempts has a nullable username column", async () => {
    const db = (env as any).DB as D1Database;
    const jobCols = await db.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
    expect(jobCols.results.some((c) => c.name === "user_id")).toBe(true);

    const attemptCols = await db.prepare("PRAGMA table_info(login_attempts)").all<{ name: string }>();
    expect(attemptCols.results.some((c) => c.name === "username")).toBe(true);
  });
});

// Phase 3.1 addendum (P2P), Task 8 cloud parity.
describe("D1 migration 0007_p2p", () => {
  it("model_hashes has chunk_sha256s and workers has peer_url", async () => {
    const db = (env as any).DB as D1Database;
    const hashCols = await db.prepare("PRAGMA table_info(model_hashes)").all<{ name: string }>();
    expect(hashCols.results.some((c) => c.name === "chunk_sha256s")).toBe(true);

    const workerCols = await db.prepare("PRAGMA table_info(workers)").all<{ name: string }>();
    expect(workerCols.results.some((c) => c.name === "peer_url")).toBe(true);
  });

  it("receipts has a nullable job_id and a bytes column, preserving every other column", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(receipts)").all<{ name: string; notnull: number }>();
    const byName = new Map(cols.results.map((c) => [c.name, c]));
    expect(byName.get("job_id")?.notnull).toBe(0);
    expect(byName.has("bytes")).toBe(true);
    for (const col of ["id", "worker_id", "gpu_seconds", "platform_sig", "worker_sig", "created_at", "kind", "billable", "basis"]) {
      expect(byName.has(col), `receipts.${col} missing after rebuild`).toBe(true);
    }

    // A p2p_upload-shaped row with a NULL job_id must insert cleanly.
    await db
      .prepare(
        `INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at, kind, billable, basis, bytes)
         VALUES ('r-p2p', NULL, 'w1', 0, 'sig', '2026-01-01 00:00:00.000000', 'p2p_upload', 0, 'wall', 1234)`
      )
      .run();
    const row = await db.prepare("SELECT job_id, bytes FROM receipts WHERE id = 'r-p2p'").first<{ job_id: string | null; bytes: number }>();
    expect(row?.job_id).toBeNull();
    expect(row?.bytes).toBe(1234);
    await db.prepare("DELETE FROM receipts WHERE id = 'r-p2p'").run();
  });

  it("preserves existing receipt rows across the table rebuild", async () => {
    // vitest-pool-workers applies every migration in order against a fresh
    // D1 instance, so there is no pre-0007 data to actually migrate here --
    // this instead confirms a row inserted the OLD way (NOT NULL job_id,
    // no bytes) still round-trips through the post-rebuild schema.
    const db = (env as any).DB as D1Database;
    await db
      .prepare(
        `INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at, kind, billable, basis)
         VALUES ('r-old', 'job-1', 'w1', 5.0, 'sig', '2026-01-01 00:00:00.000000', 'completed', 1, 'exec')`
      )
      .run();
    const row = await db
      .prepare("SELECT job_id, bytes, kind, billable FROM receipts WHERE id = 'r-old'")
      .first<{ job_id: string; bytes: number | null; kind: string; billable: number }>();
    expect(row?.job_id).toBe("job-1");
    expect(row?.bytes).toBeNull();
    expect(row?.kind).toBe("completed");
    expect(row?.billable).toBe(1);
    await db.prepare("DELETE FROM receipts WHERE id = 'r-old'").run();
  });

  it("creates the p2p_grants table with grant_id as primary key", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(p2p_grants)").all<{ name: string; pk: number }>();
    const byName = new Map(cols.results.map((c) => [c.name, c]));
    expect(byName.get("grant_id")?.pk).toBeGreaterThan(0);
    for (const col of ["name", "size_bytes", "sha256", "seeder_id", "puller_id", "expires_at", "booked", "created_at"]) {
      expect(byName.has(col), `p2p_grants.${col} missing`).toBe(true);
    }

    await db
      .prepare(
        `INSERT INTO p2p_grants (grant_id, name, size_bytes, sha256, seeder_id, puller_id, expires_at, created_at)
         VALUES ('g1', 'n', 1, 'h', 's', 'p', 100, 1)`
      )
      .run();
    const row = await db.prepare("SELECT booked FROM p2p_grants WHERE grant_id = 'g1'").first<{ booked: number }>();
    expect(row?.booked).toBe(0);
    await db.prepare("DELETE FROM p2p_grants WHERE grant_id = 'g1'").run();

    await expect(
      db
        .prepare(
          `INSERT INTO p2p_grants (grant_id, name, size_bytes, sha256, seeder_id, puller_id, expires_at, created_at)
           VALUES ('g2', 'n', 1, 'h', 's', 'p', 100, 1)`
        )
        .run()
    ).resolves.toBeDefined();
    await expect(
      db
        .prepare(
          `INSERT INTO p2p_grants (grant_id, name, size_bytes, sha256, seeder_id, puller_id, expires_at, created_at)
           VALUES ('g2', 'n2', 2, 'h2', 's2', 'p2', 200, 2)`
        )
        .run()
    ).rejects.toThrow();
    await db.prepare("DELETE FROM p2p_grants WHERE grant_id = 'g2'").run();
  });
});

// Phase 3.3 Task 1 cloud parity.
describe("D1 migration 0009_scheduler", () => {
  it("adds the scheduler/split columns to jobs with the right defaults", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(jobs)").all<{ name: string }>();
    const names = new Set(cols.results.map((c) => c.name));
    for (const col of ["signature", "dispatch_info", "parent_id", "split_index", "split_count", "split_plan"]) {
      expect(names.has(col), `jobs.${col} missing`).toBe(true);
    }

    await db
      .prepare("INSERT INTO jobs (id, workflow_json, created_at) VALUES ('job-0009', '{}', '2026-01-01 00:00:00.000000')")
      .run();
    const row = await db
      .prepare("SELECT signature, dispatch_info, parent_id, split_index, split_count, split_plan FROM jobs WHERE id = 'job-0009'")
      .first<any>();
    expect(row.signature).toBeNull();
    expect(row.dispatch_info).toBe("{}");
    expect(row.parent_id).toBeNull();
    expect(row.split_index).toBeNull();
    expect(row.split_count).toBe(0);
    expect(row.split_plan).toBeNull();
    await db.prepare("DELETE FROM jobs WHERE id = 'job-0009'").run();
  });

  it("adds workers.speed_index and workers.warm_models with defaults", async () => {
    const db = (env as any).DB as D1Database;
    await db
      .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES ('w-0009', 'w', 'pk', '2026-01-01 00:00:00.000000')")
      .run();
    const row = await db
      .prepare("SELECT speed_index, warm_models FROM workers WHERE id = 'w-0009'")
      .first<{ speed_index: number; warm_models: string }>();
    expect(row?.speed_index).toBe(1.0);
    expect(row?.warm_models).toBe("[]");
    await db.prepare("DELETE FROM workers WHERE id = 'w-0009'").run();
  });

  it("creates worker_job_stats keyed by (worker_id, signature)", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(worker_job_stats)").all<{ name: string; pk: number }>();
    const byName = new Map(cols.results.map((c) => [c.name, c]));
    expect(byName.get("worker_id")!.pk).toBeGreaterThan(0);
    expect(byName.get("signature")!.pk).toBeGreaterThan(0);
    for (const col of ["ewma_seconds", "samples", "updated_at"]) {
      expect(byName.has(col), `worker_job_stats.${col} missing`).toBe(true);
    }

    await db
      .prepare("INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at) VALUES ('w1', 's1', 10.0, 1, '2026-01-01 00:00:00.000000')")
      .run();
    await expect(
      db
        .prepare("INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at) VALUES ('w1', 's1', 20.0, 2, '2026-01-01 00:00:00.000000')")
        .run()
    ).rejects.toThrow();
    await db.prepare("DELETE FROM worker_job_stats").run();
  });
});

describe("D1 migration 0010_peer_nat", () => {
  it("adds the five P2P NAT columns to workers with the right defaults", async () => {
    const db = (env as any).DB as D1Database;
    const cols = await db.prepare("PRAGMA table_info(workers)").all<{ name: string }>();
    const names = new Set(cols.results.map((c) => c.name));
    for (const col of ["peer_lan_url", "peer_nat", "peer_reachable", "peer_checked_at", "remote_ip"]) {
      expect(names.has(col), `workers.${col} missing`).toBe(true);
    }

    await db
      .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES ('w-0010', 'w', 'pk', '2026-01-01 00:00:00.000000')")
      .run();
    const row = await db
      .prepare("SELECT peer_lan_url, peer_nat, peer_reachable, peer_checked_at, remote_ip FROM workers WHERE id = 'w-0010'")
      .first<any>();
    expect(row.peer_lan_url).toBeNull();
    expect(row.peer_nat).toBe("lan");
    expect(row.peer_reachable).toBeNull();
    expect(row.peer_checked_at).toBeNull();
    expect(row.remote_ip).toBeNull();
    await db.prepare("DELETE FROM workers WHERE id = 'w-0010'").run();
  });
});
