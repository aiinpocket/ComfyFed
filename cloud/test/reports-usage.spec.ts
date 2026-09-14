/**
 * `GET /api/reports/usage` / `/my-usage` / `/payout` -- parity source:
 * `server/comfyfed_server/receipts.py` (`usage`/`my_usage`/`payout` routes,
 * backed by `_usage_rows`/`_parse_pool`), read in full; test coverage
 * mirrors `tests/server/test_receipts.py`'s "Task 5" section (lines
 * ~594-830), read in full.
 *
 * `/contributions`'s own spec (reports.spec.ts) already covers from/to date
 * parsing and the `{value!r}`-quoting 400 body in detail; this file only
 * re-checks that the same date filtering applies to these three routes, not
 * the parsing edge cases again.
 */

import { afterEach, describe, expect, it } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp } from "../src/db/queries";

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM receipts").run();
  await db().prepare("DELETE FROM jobs").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

interface Session {
  cookie: string | null;
  csrf: string;
}

async function adminSession(): Promise<Session> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function createUser(admin: Session, username: string, password: string): Promise<string> {
  const r = await call("/api/users", {
    json: { username, role: "user", password },
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
  expect(r.status).toBe(200);
  return r.body.id;
}

async function loginAs(username: string, password: string): Promise<Session> {
  const r = await call("/api/auth/login", { json: { username, password } });
  expect(r.status).toBe(200);
  return { cookie: r.setCookie, csrf: r.body.csrf };
}

async function insertWorker(id: string, name: string): Promise<void> {
  await db()
    .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES (?, ?, 'pk', ?)")
    .bind(id, name, toSqliteTimestamp(new Date()))
    .run();
}

async function insertJob(id: string, userId: string | null): Promise<void> {
  await db()
    .prepare("INSERT INTO jobs (id, workflow_json, user_id, created_at) VALUES (?, '{}', ?, ?)")
    .bind(id, userId, toSqliteTimestamp(new Date()))
    .run();
}

interface ReceiptFixture {
  id: string;
  jobId: string;
  workerId: string;
  gpuSeconds: number;
  kind?: string;
  billable?: boolean;
  createdAt?: string;
}

async function insertReceipt(r: ReceiptFixture): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, worker_sig, created_at, kind, billable, basis)
       VALUES (?, ?, ?, ?, 'sig', NULL, ?, ?, ?, 'exec')`
    )
    .bind(
      r.id,
      r.jobId,
      r.workerId,
      r.gpuSeconds,
      r.createdAt ?? toSqliteTimestamp(new Date()),
      r.kind ?? "completed",
      (r.billable ?? true) ? 1 : 0
    )
    .run();
}

describe("GET /api/reports/usage", () => {
  it("401s without a session", async () => {
    const r = await call("/api/reports/usage", { method: "GET" });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("403s for a non-admin session", async () => {
    const admin = await adminSession();
    await createUser(admin, "alice", "alice-pw-123");
    const alice = await loginAs("alice", "alice-pw-123");
    const r = await call("/api/reports/usage", { method: "GET", cookie: alice.cookie });
    expect(r.status).toBe(403);
  });

  it("aggregates per user, folding null/orphan receipts into one null row, sorted gpu_seconds DESC", async () => {
    const admin = await adminSession();
    await insertWorker("w1", "alpha");
    const aliceId = await createUser(admin, "alice", "alice-pw-123");
    const bobId = await createUser(admin, "bob", "bob-pw-123");

    await insertJob("job-alice-1", aliceId);
    await insertJob("job-alice-2", aliceId);
    await insertJob("job-bob-1", bobId);
    await insertJob("job-legacy", null);

    await insertReceipt({ id: "r1", jobId: "job-alice-1", workerId: "w1", gpuSeconds: 10 });
    await insertReceipt({
      id: "r2",
      jobId: "job-alice-2",
      workerId: "w1",
      gpuSeconds: 3,
      kind: "failed",
      billable: false,
    });
    await insertReceipt({ id: "r3", jobId: "job-bob-1", workerId: "w1", gpuSeconds: 5 });
    await insertReceipt({ id: "r4", jobId: "job-legacy", workerId: "w1", gpuSeconds: 7 });
    // Orphan: no matching job row at all (job_id doesn't reference anything).
    await insertReceipt({ id: "r5", jobId: "job-does-not-exist", workerId: "w1", gpuSeconds: 2 });

    const r = await call("/api/reports/usage", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(200);
    const rows: any[] = r.body;
    const byUser = new Map(rows.map((row) => [row.user_id, row]));

    expect(byUser.get(aliceId)).toEqual({
      user_id: aliceId,
      username: "alice",
      jobs: 1,
      gpu_seconds: 10,
      unbilled_gpu_seconds: 3,
    });
    expect(byUser.get(bobId)).toEqual({
      user_id: bobId,
      username: "bob",
      jobs: 1,
      gpu_seconds: 5,
      unbilled_gpu_seconds: 0,
    });
    // job-legacy's user_id is null AND r5 is a genuine orphan (no job row) --
    // both fold into the SAME single {user_id: null} row.
    expect(byUser.get(null)).toEqual({
      user_id: null,
      username: null,
      jobs: 2,
      gpu_seconds: 9,
      unbilled_gpu_seconds: 0,
    });
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.gpu_seconds)).toEqual([...rows.map((row) => row.gpu_seconds)].sort((a, b) => b - a));
  });

  it("returns an empty list when there are no receipts", async () => {
    const admin = await adminSession();
    const r = await call("/api/reports/usage", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("filters by from/to range, same semantics as /contributions", async () => {
    const admin = await adminSession();
    await insertWorker("w1", "alpha");
    const aliceId = await createUser(admin, "alice", "alice-pw-123");
    await insertJob("job-old", aliceId);
    await insertJob("job-recent", aliceId);
    await insertReceipt({
      id: "old",
      jobId: "job-old",
      workerId: "w1",
      gpuSeconds: 10,
      createdAt: "2020-01-01 00:00:00.000000",
    });
    await insertReceipt({
      id: "recent",
      jobId: "job-recent",
      workerId: "w1",
      gpuSeconds: 20,
      createdAt: "2026-06-01 00:00:00.000000",
    });

    const r = await call("/api/reports/usage?from=2026-01-01&to=2026-12-31", {
      method: "GET",
      cookie: admin.cookie,
    });
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ user_id: aliceId, jobs: 1, gpu_seconds: 20 });

    const rAll = await call("/api/reports/usage", { method: "GET", cookie: admin.cookie });
    expect(rAll.body[0]).toMatchObject({ jobs: 2, gpu_seconds: 30 });
  });

  it("400s on a malformed from date", async () => {
    const admin = await adminSession();
    const r = await call("/api/reports/usage?from=not-a-date", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("reports.bad_date");
  });
});

describe("GET /api/reports/my-usage", () => {
  it("401s without a session", async () => {
    const r = await call("/api/reports/my-usage", { method: "GET" });
    expect(r.status).toBe(401);
  });

  it("allows any authenticated user, not just admin", async () => {
    const admin = await adminSession();
    const r = await call("/api/reports/my-usage", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(200);
    expect(r.body.jobs).toBe(0);
  });

  it("is isolated to the session user, ignoring other users' receipts", async () => {
    const admin = await adminSession();
    await insertWorker("w1", "alpha");
    const aliceId = await createUser(admin, "alice", "alice-pw-123");
    const bobId = await createUser(admin, "bob", "bob-pw-123");
    await insertJob("job-alice-1", aliceId);
    await insertJob("job-bob-1", bobId);
    await insertReceipt({ id: "r1", jobId: "job-alice-1", workerId: "w1", gpuSeconds: 12 });
    await insertReceipt({ id: "r2", jobId: "job-bob-1", workerId: "w1", gpuSeconds: 99 });

    const alice = await loginAs("alice", "alice-pw-123");
    const r = await call("/api/reports/my-usage", { method: "GET", cookie: alice.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      user_id: aliceId,
      username: "alice",
      jobs: 1,
      gpu_seconds: 12,
      unbilled_gpu_seconds: 0,
    });
  });

  it("returns a zeroed row (not 404/empty) when the session user has no receipts", async () => {
    const admin = await adminSession();
    const carolId = await createUser(admin, "carol", "carol-pw-123");
    const carol = await loginAs("carol", "carol-pw-123");
    const r = await call("/api/reports/my-usage", { method: "GET", cookie: carol.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      user_id: carolId,
      username: "carol",
      jobs: 0,
      gpu_seconds: 0,
      unbilled_gpu_seconds: 0,
    });
  });

  it("filters by from/to range, scoped to the session user", async () => {
    const admin = await adminSession();
    await insertWorker("w1", "alpha");
    const aliceId = await createUser(admin, "alice", "alice-pw-123");
    await insertJob("job-old", aliceId);
    await insertJob("job-recent", aliceId);
    await insertReceipt({
      id: "old",
      jobId: "job-old",
      workerId: "w1",
      gpuSeconds: 10,
      createdAt: "2020-01-01 00:00:00.000000",
    });
    await insertReceipt({
      id: "recent",
      jobId: "job-recent",
      workerId: "w1",
      gpuSeconds: 20,
      createdAt: "2026-06-01 00:00:00.000000",
    });

    const alice = await loginAs("alice", "alice-pw-123");
    const r = await call("/api/reports/my-usage?from=2026-01-01&to=2026-12-31", {
      method: "GET",
      cookie: alice.cookie,
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ jobs: 1, gpu_seconds: 20 });
  });
});

describe("GET /api/reports/payout", () => {
  it("401s without a session", async () => {
    const r = await call("/api/reports/payout?pool=10", { method: "GET" });
    expect(r.status).toBe(401);
  });

  it("403s for a non-admin session", async () => {
    const admin = await adminSession();
    await createUser(admin, "alice", "alice-pw-123");
    const alice = await loginAs("alice", "alice-pw-123");
    const r = await call("/api/reports/payout?pool=10", { method: "GET", cookie: alice.cookie });
    expect(r.status).toBe(403);
  });

  it("computes ratio/amount from billable gpu_seconds only, sorted gpu_seconds DESC", async () => {
    const admin = await adminSession();
    await insertWorker("w1", "alpha");
    await insertWorker("w2", "beta");
    await insertReceipt({ id: "j1", jobId: "j1", workerId: "w1", gpuSeconds: 30 });
    await insertReceipt({ id: "j2", jobId: "j2", workerId: "w1", gpuSeconds: 999, kind: "failed", billable: false });
    await insertReceipt({ id: "j3", jobId: "j3", workerId: "w2", gpuSeconds: 10 });

    const r = await call("/api/reports/payout?pool=100", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(200);
    expect(r.body.total_gpu_seconds).toBe(40);
    expect(r.body.pool).toBe(100);
    const byWorker = new Map(r.body.workers.map((w: any) => [w.worker_id, w]));
    expect(byWorker.get("w1")).toMatchObject({ name: "alpha", gpu_seconds: 30, ratio: 0.75, amount: 75 });
    expect(byWorker.get("w2")).toMatchObject({ name: "beta", gpu_seconds: 10, ratio: 0.25, amount: 25 });
    expect(r.body.workers.map((w: any) => w.gpu_seconds)).toEqual([30, 10]);
  });

  it("returns an empty workers list on a zero total instead of dividing by zero", async () => {
    const admin = await adminSession();
    const r = await call("/api/reports/payout?pool=50", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ total_gpu_seconds: 0, pool: 50, workers: [] });
  });

  it("400s reports.bad_pool on a missing pool", async () => {
    const admin = await adminSession();
    const r = await call("/api/reports/payout", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("reports.bad_pool");
  });

  it("400s reports.bad_pool on a non-numeric pool", async () => {
    const admin = await adminSession();
    const r = await call("/api/reports/payout?pool=not-a-number", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("reports.bad_pool");
  });

  it("400s reports.bad_pool on a negative pool", async () => {
    const admin = await adminSession();
    const r = await call("/api/reports/payout?pool=-5", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("reports.bad_pool");
  });

  it("filters by from/to range -- only in-range billable receipts feed the pool split", async () => {
    const admin = await adminSession();
    await insertWorker("w1", "alpha");
    await insertReceipt({
      id: "old",
      jobId: "job-old",
      workerId: "w1",
      gpuSeconds: 10,
      createdAt: "2020-01-01 00:00:00.000000",
    });
    await insertReceipt({
      id: "recent",
      jobId: "job-recent",
      workerId: "w1",
      gpuSeconds: 20,
      createdAt: "2026-06-01 00:00:00.000000",
    });

    const r = await call("/api/reports/payout?from=2026-01-01&to=2026-12-31&pool=100", {
      method: "GET",
      cookie: admin.cookie,
    });
    expect(r.status).toBe(200);
    expect(r.body.total_gpu_seconds).toBe(20);
  });
});
