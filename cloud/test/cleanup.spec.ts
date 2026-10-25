import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { cleanupExpired, RETENTION_DAYS } from "../src/core/cleanup";
import { toSqliteTimestamp } from "../src/db/queries";

// The daily retention sweep (index.ts's cron `scheduled` handler). Each test
// uses its own unique ids (the suite shares one D1/R2 like every other spec),
// and asserts both halves of the contract: expired data is gone, everything
// younger or still live is untouched.

function db(): D1Database {
  return (env as any).DB as D1Database;
}

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

const NOW = new Date("2026-10-25T12:00:00Z");

function daysAgo(days: number): string {
  return toSqliteTimestamp(new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000));
}

let seq = 0;
function uniqueId(base: string): string {
  seq += 1;
  return `${base}-${Date.now().toString(36)}-${seq}`;
}

async function insertJob(opts: {
  id: string;
  status?: string;
  finishedDaysAgo?: number | null;
  createdDaysAgo?: number;
  parentId?: string | null;
}): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, created_at, finished_at, parent_id)
       VALUES (?, '{}', ?, ?, ?, ?)`
    )
    .bind(
      opts.id,
      opts.status ?? "done",
      daysAgo(opts.createdDaysAgo ?? (opts.finishedDaysAgo ?? 0) + 1),
      opts.finishedDaysAgo === null || opts.finishedDaysAgo === undefined
        ? null
        : daysAgo(opts.finishedDaysAgo),
      opts.parentId ?? null
    )
    .run();
}

async function insertReceipt(opts: {
  id: string;
  jobId: string | null;
  kind?: string;
  createdDaysAgo: number;
}): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at, kind, billable, basis)
       VALUES (?, ?, 'w1', 1.5, 'sig', ?, ?, 1, 'exec')`
    )
    .bind(opts.id, opts.jobId, daysAgo(opts.createdDaysAgo), opts.kind ?? "completed")
    .run();
}

async function jobExists(id: string): Promise<boolean> {
  return (await db().prepare("SELECT 1 FROM jobs WHERE id = ?").bind(id).first()) !== null;
}

async function receiptExists(id: string): Promise<boolean> {
  return (await db().prepare("SELECT 1 FROM receipts WHERE id = ?").bind(id).first()) !== null;
}

describe("cleanupExpired", () => {
  it("deletes an expired terminal job, its receipts, and its R2 objects", async () => {
    const id = uniqueId("old-done");
    await insertJob({ id, status: "done", finishedDaysAgo: RETENTION_DAYS + 1 });
    await insertReceipt({ id: `${id}-r`, jobId: id, createdDaysAgo: RETENTION_DAYS + 1 });
    await store().put(`artifacts/${id}/out.png`, "png-bytes");
    await store().put(`artifacts/${id}/out2.png`, "png-bytes");
    await store().put(`job_inputs/${id}/in.png`, "png-bytes");

    const result = await cleanupExpired(db(), store(), NOW);

    expect(await jobExists(id)).toBe(false);
    expect(await receiptExists(`${id}-r`)).toBe(false);
    expect(await store().head(`artifacts/${id}/out.png`)).toBeNull();
    expect(await store().head(`artifacts/${id}/out2.png`)).toBeNull();
    expect(await store().head(`job_inputs/${id}/in.png`)).toBeNull();
    expect(result.jobsDeleted).toBeGreaterThanOrEqual(1);
    expect(result.objectsDeleted).toBeGreaterThanOrEqual(3);
  });

  it("keeps a terminal job younger than the cutoff, with its receipt and objects", async () => {
    const id = uniqueId("recent-done");
    await insertJob({ id, status: "done", finishedDaysAgo: RETENTION_DAYS - 1 });
    await insertReceipt({ id: `${id}-r`, jobId: id, createdDaysAgo: RETENTION_DAYS - 1 });
    await store().put(`artifacts/${id}/out.png`, "png-bytes");

    await cleanupExpired(db(), store(), NOW);

    expect(await jobExists(id)).toBe(true);
    expect(await receiptExists(`${id}-r`)).toBe(true);
    expect(await store().head(`artifacts/${id}/out.png`)).not.toBeNull();
  });

  it("never touches a non-terminal job, however old", async () => {
    const running = uniqueId("old-running");
    const queued = uniqueId("old-queued");
    await insertJob({ id: running, status: "running", finishedDaysAgo: null, createdDaysAgo: 400 });
    await insertJob({ id: queued, status: "queued", finishedDaysAgo: null, createdDaysAgo: 400 });

    await cleanupExpired(db(), store(), NOW);

    expect(await jobExists(running)).toBe(true);
    expect(await jobExists(queued)).toBe(true);
  });

  it("ages a terminal row with no finished_at by created_at instead of keeping it forever", async () => {
    const id = uniqueId("no-finished");
    await insertJob({ id, status: "failed", finishedDaysAgo: null, createdDaysAgo: RETENTION_DAYS + 5 });

    await cleanupExpired(db(), store(), NOW);

    expect(await jobExists(id)).toBe(false);
  });

  it("keeps an expired parent while any child is too young, then deletes the family together", async () => {
    const parent = uniqueId("split-parent");
    const oldChild = uniqueId("split-old-child");
    const youngChild = uniqueId("split-young-child");
    await insertJob({ id: parent, status: "done", finishedDaysAgo: RETENTION_DAYS + 10 });
    await insertJob({ id: oldChild, status: "done", finishedDaysAgo: RETENTION_DAYS + 10, parentId: parent });
    await insertJob({ id: youngChild, status: "done", finishedDaysAgo: 1, parentId: parent });

    await cleanupExpired(db(), store(), NOW);

    // The young child shields the whole family -- a child must never outlive
    // its parent.
    expect(await jobExists(parent)).toBe(true);
    expect(await jobExists(oldChild)).toBe(true);
    expect(await jobExists(youngChild)).toBe(true);

    // Once every child is past retention, parent and children go together.
    const later = new Date(NOW.getTime() + (RETENTION_DAYS + 2) * 24 * 60 * 60 * 1000);
    await cleanupExpired(db(), store(), later);
    expect(await jobExists(parent)).toBe(false);
    expect(await jobExists(oldChild)).toBe(false);
    expect(await jobExists(youngChild)).toBe(false);
  });

  it("purges old p2p_upload receipts (job_id NULL) and keeps young ones", async () => {
    const oldId = uniqueId("p2p-old");
    const youngId = uniqueId("p2p-young");
    await insertReceipt({ id: oldId, jobId: null, kind: "p2p_upload", createdDaysAgo: RETENTION_DAYS + 1 });
    await insertReceipt({ id: youngId, jobId: null, kind: "p2p_upload", createdDaysAgo: 1 });

    await cleanupExpired(db(), store(), NOW);

    expect(await receiptExists(oldId)).toBe(false);
    expect(await receiptExists(youngId)).toBe(true);
  });

  it("purges stale worker_task_failures rows and keeps fresh ones", async () => {
    const staleWorker = uniqueId("wtf-stale");
    const freshWorker = uniqueId("wtf-fresh");
    await db()
      .prepare(
        `INSERT INTO worker_task_failures (worker_id, task_key, failures, updated_at)
         VALUES (?, 'k', 2, ?), (?, 'k', 2, ?)`
      )
      .bind(staleWorker, daysAgo(RETENTION_DAYS + 1), freshWorker, daysAgo(1))
      .run();

    const result = await cleanupExpired(db(), store(), NOW);

    const stale = await db()
      .prepare("SELECT 1 FROM worker_task_failures WHERE worker_id = ?")
      .bind(staleWorker)
      .first();
    const fresh = await db()
      .prepare("SELECT 1 FROM worker_task_failures WHERE worker_id = ?")
      .bind(freshWorker)
      .first();
    expect(stale).toBeNull();
    expect(fresh).not.toBeNull();
    expect(result.taskFailuresDeleted).toBeGreaterThanOrEqual(1);
  });

  it("does not touch R2 prefixes of other jobs sharing no id", async () => {
    const oldId = uniqueId("old-a");
    const keepId = uniqueId("keep-b");
    await insertJob({ id: oldId, status: "done", finishedDaysAgo: RETENTION_DAYS + 1 });
    await insertJob({ id: keepId, status: "done", finishedDaysAgo: 1 });
    await store().put(`artifacts/${oldId}/x.png`, "a");
    await store().put(`artifacts/${keepId}/x.png`, "b");

    await cleanupExpired(db(), store(), NOW);

    expect(await store().head(`artifacts/${oldId}/x.png`)).toBeNull();
    expect(await store().head(`artifacts/${keepId}/x.png`)).not.toBeNull();
  });
});
