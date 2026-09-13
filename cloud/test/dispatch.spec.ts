import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as dispatch from "../src/core/dispatch";
import { toSqliteTimestamp } from "../src/db/queries";

// Ports the pure-dispatch-logic assertions of tests/server/test_dispatch.py
// (ranking tie-breaks incl. light-vs-heavy, weak-backend preference, readopt
// gates, stale requeue recording last_worker_id, cancel clearing worker_id)
// against a real (miniflare) D1 instance. WS-level integration (job_cancelled
// pushes, live re-adoption) stays out of scope here -- that's Task 6's Hub DO.

function db(): D1Database {
  return (env as any).DB as D1Database;
}

// vitest-pool-workers isolates storage per test FILE, not per `it()` (unlike
// the Python suite's fresh-sqlite-per-test fixture via `db.init_db` in a
// pytest tmp_path fixture) -- a D1 binding's storage survives between tests
// in the same file. `assignJobs` in particular queries every queued job
// table-wide, so a previous test's leftover row would otherwise leak into a
// later test's ranking. Clear the mutable tables after every test to
// restore per-test isolation.
afterEach(async () => {
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM receipts").run();
});

function now(): Date {
  return new Date();
}

// This spec file's D1 instance is shared across every `it()` in the file
// (vitest-pool-workers isolates storage per FILE, not per test -- unlike
// the Python suite's fresh-sqlite-per-test fixture), so every inserted row
// needs an id unique across the whole file. A counter suffix keeps ids
// readable while guaranteeing that.
let idCounter = 0;
function uniqueId(base: string): string {
  idCounter += 1;
  return `${base}-${idCounter}`;
}

async function makeWorker(
  label = "w",
  opts: { hardware?: Record<string, unknown>; dynamic?: Record<string, unknown>; backend?: string } = {}
): Promise<string> {
  const id = uniqueId(label);
  await db()
    .prepare(
      `INSERT INTO workers (id, name, pubkey, created_at, hardware, dynamic, backend)
       VALUES (?, ?, 'pk', ?, ?, ?, ?)`
    )
    .bind(
      id,
      label,
      toSqliteTimestamp(now()),
      JSON.stringify(opts.hardware ?? {}),
      JSON.stringify(opts.dynamic ?? {}),
      opts.backend ?? ""
    )
    .run();
  return id;
}

async function setWorkerLastSeen(id: string, lastSeen: Date): Promise<void> {
  await db().prepare("UPDATE workers SET last_seen = ? WHERE id = ?").bind(toSqliteTimestamp(lastSeen), id).run();
}

async function makeJob(
  opts: {
    id?: string;
    status?: string;
    workerId?: string | null;
    lastWorkerId?: string | null;
    estVramGb?: number | null;
    createdAt?: Date;
  } = {}
): Promise<string> {
  const id = opts.id ? uniqueId(opts.id) : uniqueId("j");
  await db()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, worker_id, last_worker_id, est_vram_gb, created_at)
       VALUES (?, '{}', ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.status ?? "queued",
      opts.workerId ?? null,
      opts.lastWorkerId ?? null,
      opts.estVramGb ?? null,
      toSqliteTimestamp(opts.createdAt ?? now())
    )
    .run();
  return id;
}

async function getJobRow(id: string) {
  return db().prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<any>();
}

async function getWorkerRow(id: string) {
  return db().prepare("SELECT * FROM workers WHERE id = ?").bind(id).first<any>();
}

// --- requeueStale ----------------------------------------------------------

describe("requeueStale", () => {
  it("records last_worker_id, clears worker_id, resets progress, and offlines the worker", async () => {
    const workerId = await makeWorker();
    await setWorkerLastSeen(workerId, new Date(now().getTime() - 200_000));
    await db().prepare("UPDATE jobs SET progress = 0").run(); // no-op, keeps parity readable
    const jobId = await makeJob({ status: "assigned", workerId });

    const requeued = await dispatch.requeueStale(db(), now());

    expect(requeued).toEqual([jobId]);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("queued");
    expect(job.worker_id).toBeNull();
    expect(job.progress).toBe(0);
    expect(job.last_worker_id).toBe(workerId);
    const worker = await getWorkerRow(workerId);
    expect(worker.status).toBe("offline");
  });

  it("leaves a worker that heartbeated recently alone", async () => {
    const workerId = await makeWorker();
    await setWorkerLastSeen(workerId, new Date(now().getTime() - 5_000));
    const jobId = await makeJob({ status: "running", workerId });

    const requeued = await dispatch.requeueStale(db(), now());

    expect(requeued).toEqual([]);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("running");
  });
});

// --- cancelJob ---------------------------------------------------------------

describe("cancelJob", () => {
  for (const status of ["assigned", "running"]) {
    it(`owned job (${status}) returns the owner and sets error/finished_at`, async () => {
      const workerId = await makeWorker();
      const jobId = await makeJob({ status, workerId });

      const result = await dispatch.cancelJob(db(), jobId, "user requested", now());

      expect(result).toBe(workerId);
      const job = await getJobRow(jobId);
      expect(job.status).toBe("cancelled");
      expect(job.error).toBe("user requested");
      expect(job.finished_at).not.toBeNull();
    });
  }

  it("queued job returns null but still cancels", async () => {
    const jobId = await makeJob({ status: "queued" });

    const result = await dispatch.cancelJob(db(), jobId, "user requested", now());

    expect(result).toBeNull();
    const job = await getJobRow(jobId);
    expect(job.status).toBe("cancelled");
    expect(job.error).toBe("user requested");
    expect(job.finished_at).not.toBeNull();
  });

  for (const status of ["done", "failed", "cancelled"]) {
    it(`is a no-op on a terminal job (${status})`, async () => {
      const jobId = await makeJob({ status });

      expect(await dispatch.cancelJob(db(), jobId, "too late", now())).toBeNull();
      const job = await getJobRow(jobId);
      expect(job.status).toBe(status);
      expect(job.error).toBeNull();
    });
  }

  it("unknown job is a no-op", async () => {
    expect(await dispatch.cancelJob(db(), "no-such-job", "x", now())).toBeNull();
  });

  it("clears worker_id and records last_worker_id", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "running", workerId });

    expect(await dispatch.cancelJob(db(), jobId, "user requested", now())).toBe(workerId);

    const job = await getJobRow(jobId);
    expect(job.worker_id).toBeNull();
    expect(job.last_worker_id).toBe(workerId);
  });
});

// --- tryReadopt --------------------------------------------------------------

describe("tryReadopt", () => {
  it("restores ownership on a matching blip", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "queued", workerId: null, lastWorkerId: workerId });

    expect(await dispatch.tryReadopt(db(), jobId, workerId)).toBe(true);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("assigned");
    expect(job.worker_id).toBe(workerId);
  });

  it("refuses when last_worker_id differs", async () => {
    const workerId = await makeWorker("w1");
    const otherId = await makeWorker("w2");
    const jobId = await makeJob({ status: "queued", workerId: null, lastWorkerId: otherId });

    expect(await dispatch.tryReadopt(db(), jobId, workerId)).toBe(false);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("queued");
    expect(job.worker_id).toBeNull();
  });

  it("refuses when the job is assigned to someone else", async () => {
    const workerId = await makeWorker("w1");
    const otherId = await makeWorker("w2");
    const jobId = await makeJob({ status: "assigned", workerId: otherId, lastWorkerId: workerId });

    expect(await dispatch.tryReadopt(db(), jobId, workerId)).toBe(false);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("assigned");
    expect(job.worker_id).toBe(otherId);
  });

  it("refuses a terminal job", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "done", workerId: null, lastWorkerId: workerId });

    expect(await dispatch.tryReadopt(db(), jobId, workerId)).toBe(false);
  });

  it("refuses a cancelled job even though cancel cleared worker_id", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "running", workerId });
    await dispatch.cancelJob(db(), jobId, "user requested", now());

    expect(await dispatch.tryReadopt(db(), jobId, workerId)).toBe(false);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("cancelled");
    expect(job.worker_id).toBeNull();
  });
});

// --- assignJobs: heavy-job ranking -------------------------------------------

describe("assignJobs (heavy job ranking)", () => {
  it("prefers a clean worker over a warned worker", async () => {
    const warnedId = await makeWorker("w_warn", { hardware: { vram_gb: 8, ram_gb: 64 } });
    const cleanId = await makeWorker("w_clean", { hardware: { vram_gb: 24, ram_gb: 64 } });
    const jobId = await makeJob({ estVramGb: 20 });

    const assignments = await dispatch.assignJobs(db(), [warnedId, cleanId]);

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.workerId).toBe(cleanId);
    expect(assignments[0]!.job.id).toBe(jobId);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("assigned");
    expect(job.worker_id).toBe(cleanId);
  });

  it("ties are broken by largest free VRAM", async () => {
    const smallId = await makeWorker("w_small", { dynamic: { free_vram_gb: 4 } });
    const bigId = await makeWorker("w_big", { dynamic: { free_vram_gb: 12 } });
    const jobId = await makeJob({ estVramGb: 1 });

    const assignments = await dispatch.assignJobs(db(), [smallId, bigId]);

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.workerId).toBe(bigId);
    expect(assignments[0]!.job.id).toBe(jobId);
  });

  it("is unchanged by the light-job preference", async () => {
    const macId = await makeWorker("w_mac", { backend: "mps", dynamic: { free_vram_gb: 0 } });
    const bigCudaId = await makeWorker("w_cuda_big", { backend: "cuda", dynamic: { free_vram_gb: 32 } });
    const jobId = await makeJob({ estVramGb: 10 });

    const assignments = await dispatch.assignJobs(db(), [macId, bigCudaId]);

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.workerId).toBe(bigCudaId);
    expect(assignments[0]!.job.id).toBe(jobId);
  });
});

// --- assignJobs: light-job (Phase 1.9) preference ----------------------------

describe("assignJobs (light job preference)", () => {
  it("prefers an mps worker over a 32GB cuda worker for a zero-model job", async () => {
    const macId = await makeWorker("w_mac", { backend: "mps", dynamic: { free_vram_gb: 0 } });
    const bigCudaId = await makeWorker("w_cuda_big", { backend: "cuda", dynamic: { free_vram_gb: 32 } });
    const jobId = await makeJob(); // no models, no est_vram_gb -> light

    const assignments = await dispatch.assignJobs(db(), [macId, bigCudaId]);

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.workerId).toBe(macId);
    expect(assignments[0]!.job.id).toBe(jobId);
  });

  it("prefers the smallest free VRAM among cuda workers", async () => {
    const smallCudaId = await makeWorker("w_cuda_small", { backend: "cuda", dynamic: { free_vram_gb: 8 } });
    const bigCudaId = await makeWorker("w_cuda_big", { backend: "cuda", dynamic: { free_vram_gb: 24 } });
    const jobId = await makeJob();

    const assignments = await dispatch.assignJobs(db(), [smallCudaId, bigCudaId]);

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.workerId).toBe(smallCudaId);
    expect(assignments[0]!.job.id).toBe(jobId);
  });
});

// --- assignJobs: claim/tick semantics -----------------------------------------

describe("assignJobs (claim and tick semantics)", () => {
  it("assigns both jobs, oldest first, in one tick", async () => {
    const workerA = await makeWorker("w_a");
    const workerB = await makeWorker("w_b");
    const base = now();
    const oldJobId = await makeJob({ id: "j_old", createdAt: new Date(base.getTime() - 10_000) });
    const newJobId = await makeJob({ id: "j_new", createdAt: base });

    const assignments = await dispatch.assignJobs(db(), [workerA, workerB]);

    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((a) => a.job.id))).toEqual(new Set([oldJobId, newJobId]));
    expect(new Set(assignments.map((a) => a.workerId))).toEqual(new Set([workerA, workerB]));
    expect((await getJobRow(oldJobId)).status).toBe("assigned");
    expect((await getJobRow(newJobId)).status).toBe("assigned");
  });

  it("skips gracefully when the job was already claimed concurrently", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob();
    await db()
      .prepare("UPDATE jobs SET status = 'assigned', worker_id = 'someone-else' WHERE id = ?")
      .bind(jobId)
      .run();

    const assignments = await dispatch.assignJobs(db(), [workerId]);

    expect(assignments).toEqual([]);
    expect((await getJobRow(jobId)).worker_id).toBe("someone-else");
  });

  it("ignores unknown worker ids", async () => {
    expect(await dispatch.assignJobs(db(), ["no-such-worker"])).toEqual([]);
  });

  it("returns empty for an empty idle list", async () => {
    await makeJob();
    expect(await dispatch.assignJobs(db(), [])).toEqual([]);
  });

  it("gives each worker at most one job per tick", async () => {
    const workerId = await makeWorker();
    const job1 = await makeJob({ id: "j1" });
    const job2 = await makeJob({ id: "j2" });

    const assignments = await dispatch.assignJobs(db(), [workerId]);

    expect(assignments).toHaveLength(1);
    expect([job1, job2]).toContain(assignments[0]!.job.id);
    const statuses = [(await getJobRow(job1)).status, (await getJobRow(job2)).status].sort();
    expect(statuses).toEqual(["assigned", "queued"]);
  });
});

// --- markRunning / markDone / markFailed / resolveOwnedJob -------------------

describe("owned-job transitions", () => {
  it("markRunning moves an assigned job to running for its owner", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "assigned", workerId });

    expect(await dispatch.markRunning(db(), jobId, workerId, now())).toBe(true);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("running");
    expect(job.started_at).not.toBeNull();
  });

  it("markRunning refuses a job owned by someone else (forgery)", async () => {
    const owner = await makeWorker("owner");
    const attacker = await makeWorker("attacker");
    const jobId = await makeJob({ status: "assigned", workerId: owner });

    expect(await dispatch.markRunning(db(), jobId, attacker, now())).toBe(false);
    expect((await getJobRow(jobId)).status).toBe("assigned");
  });

  it("markDone completes a running job and stores result_files", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "running", workerId });

    expect(await dispatch.markDone(db(), jobId, workerId, ["a.png"], now())).toBe(true);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("done");
    expect(JSON.parse(job.result_files)).toEqual(["a.png"]);
    expect(job.finished_at).not.toBeNull();
  });

  it("markFailed fails a running job with the given error", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "running", workerId });

    expect(await dispatch.markFailed(db(), jobId, workerId, "boom", now())).toBe(true);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toBe("boom");
  });

  it("resolveOwnedJob reports unknown_job for a nonexistent id", async () => {
    const result = await dispatch.resolveOwnedJob(db(), "no-such-job", "w1", ["assigned"]);
    expect(result).toEqual({ ok: false, reason: "unknown_job" });
  });

  it("resolveOwnedJob reports not_owner_stale_terminal for a cancelled job the worker used to own", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "running", workerId });
    await dispatch.cancelJob(db(), jobId, "user requested", now());

    const result = await dispatch.resolveOwnedJob(db(), jobId, workerId, ["running"]);
    expect(result).toEqual({ ok: false, reason: "not_owner_stale_terminal" });
  });

  it("resolveOwnedJob reports wrong_status_transient for a repeat heartbeat", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "running", workerId });

    const result = await dispatch.resolveOwnedJob(db(), jobId, workerId, ["assigned"]);
    expect(result).toEqual({ ok: false, reason: "wrong_status_transient" });
  });

  it("resolveOwnedJob reports wrong_status_terminal for re-transitioning a finished job", async () => {
    const workerId = await makeWorker();
    const jobId = await makeJob({ status: "done", workerId });

    const result = await dispatch.resolveOwnedJob(db(), jobId, workerId, ["assigned", "running"]);
    expect(result).toEqual({ ok: false, reason: "wrong_status_terminal" });
  });
});
