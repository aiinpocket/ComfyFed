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
      ["jobs", "login_attempts", "nonces", "receipts", "register_tokens", "settings", "workers"].sort()
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
