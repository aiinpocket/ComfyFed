import { afterEach, describe, expect, it } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp } from "../src/db/queries";

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM receipts").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function adminSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function insertWorker(id: string, name: string): Promise<void> {
  await db()
    .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES (?, ?, 'pk', ?)")
    .bind(id, name, toSqliteTimestamp(new Date()))
    .run();
}

interface ReceiptFixture {
  id: string;
  jobId: string;
  workerId: string;
  gpuSeconds: number;
  kind: string;
  billable: boolean;
  basis: string;
  workerSig: string | null;
  createdAt?: string;
}

async function insertReceipt(r: ReceiptFixture): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, worker_sig, created_at, kind, billable, basis)
       VALUES (?, ?, ?, ?, 'sig', ?, ?, ?, ?, ?)`
    )
    .bind(
      r.id,
      r.jobId,
      r.workerId,
      r.gpuSeconds,
      r.workerSig,
      r.createdAt ?? toSqliteTimestamp(new Date()),
      r.kind,
      r.billable ? 1 : 0,
      r.basis
    )
    .run();
}

describe("GET /api/reports/contributions", () => {
  it("401s without a session", async () => {
    const r = await call("/api/reports/contributions", { method: "GET" });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("aggregates mixed billable/unbilled receipts across two workers", async () => {
    const { cookie } = await adminSession();
    await insertWorker("w1", "alpha");
    await insertWorker("w2", "beta");

    // w1: one billable (acked), one unbilled/failed (not acked).
    await insertReceipt({
      id: "r1",
      jobId: "j1",
      workerId: "w1",
      gpuSeconds: 10,
      kind: "completed",
      billable: true,
      basis: "exec",
      workerSig: "worker-sig-1",
    });
    await insertReceipt({
      id: "r2",
      jobId: "j2",
      workerId: "w1",
      gpuSeconds: 3,
      kind: "failed",
      billable: false,
      basis: "wall",
      workerSig: null,
    });

    // w2: one billable (unacked), one billable (acked).
    await insertReceipt({
      id: "r3",
      jobId: "j3",
      workerId: "w2",
      gpuSeconds: 5,
      kind: "completed",
      billable: true,
      basis: "exec",
      workerSig: null,
    });
    await insertReceipt({
      id: "r4",
      jobId: "j4",
      workerId: "w2",
      gpuSeconds: 7,
      kind: "cancelled",
      billable: false,
      basis: "wall",
      workerSig: "worker-sig-4",
    });

    const r = await call("/api/reports/contributions", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      {
        worker_id: "w1",
        name: "alpha",
        jobs: 1,
        gpu_seconds: 10,
        unbilled_gpu_seconds: 3,
        receipts: [
          { job_id: "j1", kind: "completed", billable: true, basis: "exec", gpu_seconds: 10, acked: true },
          { job_id: "j2", kind: "failed", billable: false, basis: "wall", gpu_seconds: 3, acked: false },
        ],
      },
      {
        worker_id: "w2",
        name: "beta",
        jobs: 1,
        gpu_seconds: 5,
        unbilled_gpu_seconds: 7,
        receipts: [
          { job_id: "j3", kind: "completed", billable: true, basis: "exec", gpu_seconds: 5, acked: false },
          { job_id: "j4", kind: "cancelled", billable: false, basis: "wall", gpu_seconds: 7, acked: true },
        ],
      },
    ]);
  });

  it("returns an empty list when there are no receipts", async () => {
    const { cookie } = await adminSession();
    const r = await call("/api/reports/contributions", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("names an unknown worker id as empty string (worker row missing)", async () => {
    const { cookie } = await adminSession();
    await insertReceipt({
      id: "r1",
      jobId: "j1",
      workerId: "ghost",
      gpuSeconds: 1,
      kind: "completed",
      billable: true,
      basis: "exec",
      workerSig: null,
    });
    const r = await call("/api/reports/contributions", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body[0].name).toBe("");
  });

  it("filters by from/to range", async () => {
    const { cookie } = await adminSession();
    await insertWorker("w1", "alpha");
    await insertReceipt({
      id: "old",
      jobId: "j-old",
      workerId: "w1",
      gpuSeconds: 1,
      kind: "completed",
      billable: true,
      basis: "exec",
      workerSig: null,
      createdAt: "2020-01-01 00:00:00.000000",
    });
    await insertReceipt({
      id: "new",
      jobId: "j-new",
      workerId: "w1",
      gpuSeconds: 2,
      kind: "completed",
      billable: true,
      basis: "exec",
      workerSig: null,
      createdAt: "2030-01-01 00:00:00.000000",
    });

    const r = await call("/api/reports/contributions?from=2025-01-01&to=2035-01-01", {
      method: "GET",
      cookie,
    });
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0].receipts).toEqual([
      { job_id: "j-new", kind: "completed", billable: true, basis: "exec", gpu_seconds: 2, acked: false },
    ]);
  });

  it("400s on a malformed from date", async () => {
    const { cookie } = await adminSession();
    const r = await call("/api/reports/contributions?from=not-a-date", { method: "GET", cookie });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("reports.bad_date");
    expect(r.body.error.message).toBe("Not a valid ISO-8601 date: 'not-a-date'");
  });

  it("repr()-quotes a malformed date containing a single quote like Python's {value!r} (n3, final review)", async () => {
    const { cookie } = await adminSession();
    const r = await call("/api/reports/contributions?from=" + encodeURIComponent("o'clock"), { method: "GET", cookie });
    expect(r.status).toBe(400);
    // Python's repr("o'clock") switches to double quotes rather than
    // backslash-escaping the apostrophe: "o'clock".
    expect(r.body.error.message).toBe('Not a valid ISO-8601 date: "o\'clock"');
  });
});
