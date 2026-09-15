import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as dispatch from "../src/core/dispatch";
import * as scheduler from "../src/core/scheduler";
import * as split from "../src/core/split";
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
  await db().prepare("DELETE FROM worker_job_stats").run();
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
  opts: {
    hardware?: Record<string, unknown>;
    dynamic?: Record<string, unknown>;
    backend?: string;
    protocol?: number;
    autoFetch?: boolean;
    nodeClasses?: string[];
    modelInventory?: unknown[];
    peerUrl?: string | null;
  } = {}
): Promise<string> {
  const id = uniqueId(label);
  await db()
    .prepare(
      `INSERT INTO workers (id, name, pubkey, created_at, hardware, dynamic, backend, protocol, auto_fetch, node_classes, model_inventory, peer_url)
       VALUES (?, ?, 'pk', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      label,
      toSqliteTimestamp(now()),
      JSON.stringify(opts.hardware ?? {}),
      JSON.stringify(opts.dynamic ?? {}),
      opts.backend ?? "",
      opts.protocol ?? 1,
      opts.autoFetch ? 1 : 0,
      JSON.stringify(opts.nodeClasses ?? []),
      JSON.stringify(opts.modelInventory ?? []),
      opts.peerUrl ?? null
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
    requiredModels?: string[];
  } = {}
): Promise<string> {
  const id = opts.id ? uniqueId(opts.id) : uniqueId("j");
  await db()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, worker_id, last_worker_id, est_vram_gb, created_at, required_models)
       VALUES (?, '{}', ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.status ?? "queued",
      opts.workerId ?? null,
      opts.lastWorkerId ?? null,
      opts.estVramGb ?? null,
      toSqliteTimestamp(opts.createdAt ?? now()),
      JSON.stringify(opts.requiredModels ?? [])
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

  it("clears peer_url on the stale/offline transition (Phase 3.1 P2P)", async () => {
    const workerId = await makeWorker("w", { peerUrl: "http://192.168.1.5:8850" });
    await setWorkerLastSeen(workerId, new Date(now().getTime() - 200_000));

    await dispatch.requeueStale(db(), now());

    const worker = await getWorkerRow(workerId);
    expect(worker.status).toBe("offline");
    expect(worker.peer_url).toBeNull();
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

// --- assignJobs: two-tier fetch ranking (Phase 2.1 Task 7) -------------------
// Ports dispatch.py's `assign_jobs` fetch-tier docstring cases: tier 2
// (eligible_after_fetch) is only ever consulted when tier 1 (already has
// everything) is completely empty, and among tier-2 candidates the smallest
// total download wins.

const GB = 1024 ** 3;

describe("assignJobs (fetch tier)", () => {
  it("a directly-eligible worker always wins over one that would have to fetch first", async () => {
    const hasItId = await makeWorker("w_has_it", {
      protocol: 3,
      autoFetch: true,
      dynamic: { free_disk_gb: 100, free_vram_gb: 1 },
      modelInventory: [{ name: "ckpt.safetensors", size: 1 }],
    });
    const mustFetchId = await makeWorker("w_must_fetch", {
      protocol: 3,
      autoFetch: true,
      dynamic: { free_disk_gb: 100, free_vram_gb: 24 },
      modelInventory: [],
    });
    const jobId = await makeJob({ requiredModels: ["ckpt.safetensors"] });

    const assignments = await dispatch.assignJobs(db(), [hasItId, mustFetchId], { "ckpt.safetensors": 1 * GB });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.workerId).toBe(hasItId);
    expect(assignments[0]!.job.id).toBe(jobId);
  });

  it("among fetch-only candidates, the smallest total download wins", async () => {
    // Both need to fetch "a.safetensors"; w_small_dl already has
    // "b.safetensors" so its total download is 1 GB, while w_big_dl is
    // missing both and would have to download 2 GB total.
    const smallDownloadId = await makeWorker("w_small_dl", {
      protocol: 3,
      autoFetch: true,
      dynamic: { free_disk_gb: 100 },
      modelInventory: [{ name: "b.safetensors", size: 1 }],
    });
    const bigDownloadId = await makeWorker("w_big_dl", {
      protocol: 3,
      autoFetch: true,
      dynamic: { free_disk_gb: 100 },
      modelInventory: [],
    });
    const jobId = await makeJob({ requiredModels: ["a.safetensors", "b.safetensors"] });

    const assignments = await dispatch.assignJobs(db(), [smallDownloadId, bigDownloadId], {
      "a.safetensors": 1 * GB,
      "b.safetensors": 1 * GB,
    });

    expect(assignments).toHaveLength(1);
    expect(assignments[0]!.workerId).toBe(smallDownloadId);
    expect(assignments[0]!.job.id).toBe(jobId);
  });

  it("no worker is eligible_after_fetch without fetchableModels -- job stays queued", async () => {
    const workerId = await makeWorker("w1", { protocol: 3, autoFetch: true, dynamic: { free_disk_gb: 100 } });
    await makeJob({ requiredModels: ["ckpt.safetensors"] });

    const assignments = await dispatch.assignJobs(db(), [workerId]); // no fetchableModels arg
    expect(assignments).toEqual([]);
  });

  it("a worker that hasn't opted into auto_fetch never enters tier 2", async () => {
    const workerId = await makeWorker("w1", { protocol: 3, autoFetch: false, dynamic: { free_disk_gb: 100 } });
    await makeJob({ requiredModels: ["ckpt.safetensors"] });

    const assignments = await dispatch.assignJobs(db(), [workerId], { "ckpt.safetensors": 1 * GB });
    expect(assignments).toEqual([]);
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

describe("Phase 3.3 scheduler semantics", () => {
  async function makeSignedJob(
    id: string,
    opts: {
      signature?: string | null;
      models?: string[];
      estVramGb?: number | null;
      createdAt?: Date;
      splitCount?: number;
    } = {}
  ): Promise<string> {
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, signature, required_models, est_vram_gb, split_count)
         VALUES (?, '{}', 'queued', ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        toSqliteTimestamp(opts.createdAt ?? new Date()),
        opts.signature ?? "sig",
        JSON.stringify(opts.models ?? []),
        opts.estVramGb ?? null,
        opts.splitCount ?? 0
      )
      .run();
    return id;
  }

  async function setStats(workerId: string, signature: string, ewma: number): Promise<void> {
    await db()
      .prepare(
        "INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at) VALUES (?, ?, ?, 3, ?)"
      )
      .bind(workerId, signature, ewma, toSqliteTimestamp(new Date()))
      .run();
  }

  it("prefers a warm cache over a bigger but cold card", async () => {
    const inventory = [{ name: "diffusion_models/flux1-dev.safetensors", size: 22 }];
    const warm = await makeWorker("w_warm", { dynamic: { free_vram_gb: 16 }, modelInventory: inventory });
    const cold = await makeWorker("w_cold", { dynamic: { free_vram_gb: 48 }, modelInventory: inventory });
    await db()
      .prepare("UPDATE workers SET warm_models = ? WHERE id = ?")
      .bind(JSON.stringify(["flux1-dev.safetensors"]), warm)
      .run();
    const jobId = await makeSignedJob(uniqueId("j"), { models: ["flux1-dev.safetensors"] });

    const assignments = await dispatch.assignJobs(db(), [warm, cold]);
    expect(assignments.map((a) => [a.workerId, a.job.id])).toEqual([[warm, jobId]]);
  });

  it("prefers the historically faster worker", async () => {
    const slow = await makeWorker("w_slow", { dynamic: { free_vram_gb: 24 } });
    const fast = await makeWorker("w_fast", { dynamic: { free_vram_gb: 24 } });
    await setStats(slow, "sig", 90);
    await setStats(fast, "sig", 30);
    const jobId = await makeSignedJob(uniqueId("j"));

    const assignments = await dispatch.assignJobs(db(), [slow, fast]);
    expect(assignments.map((a) => [a.workerId, a.job.id])).toEqual([[fast, jobId]]);
  });

  it("spreads two heavy jobs across two cards", async () => {
    const big = await makeWorker("w_big", { dynamic: { free_vram_gb: 48 } });
    const small = await makeWorker("w_small", { dynamic: { free_vram_gb: 24 } });
    const start = new Date();
    const j1 = await makeSignedJob(uniqueId("j"), { estVramGb: 10, createdAt: new Date(start.getTime() - 10_000) });
    const j2 = await makeSignedJob(uniqueId("j"), { estVramGb: 10, createdAt: start });

    const assignments = await dispatch.assignJobs(db(), [big, small]);
    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((a) => a.workerId))).toEqual(new Set([big, small]));
    expect(new Set(assignments.map((a) => a.job.id))).toEqual(new Set([j1, j2]));
  });

  it("writes dispatch_info and warm_models on claim", async () => {
    // 這台 worker 必須真的有這個模型才會 eligible（沒有 fetchableModels 就沒有
    // tier 2）；inventory 條目刻意不帶 size，`findModel` 回 [true, null]，所以
    // loadSeconds 是 0 -- 這個測試釘的是 dispatch_info 的欄位有沒有寫進去。
    const workerId = await makeWorker("w1", {
      dynamic: { free_vram_gb: 24 },
      modelInventory: [{ name: "diffusion_models/flux1-dev.safetensors" }],
    });
    await setStats(workerId, "sig", 41.2);
    const jobId = await makeSignedJob(uniqueId("j"), { models: ["flux1-dev.safetensors"] });

    await dispatch.assignJobs(db(), [workerId]);

    const jobRow = await db()
      .prepare("SELECT dispatch_info FROM jobs WHERE id = ?")
      .bind(jobId)
      .first<{ dispatch_info: string }>();
    const info = JSON.parse(jobRow!.dispatch_info);
    expect(info.basis).toBe("signature");
    expect(info.predicted_seconds).toBeCloseTo(41.2, 6);
    expect(info.load_seconds).toBeCloseTo(0, 6);
    expect(info.fetch_seconds).toBeCloseTo(0, 6);
    expect(info.candidates).toBe(1);

    const workerRow = await db()
      .prepare("SELECT warm_models FROM workers WHERE id = ?")
      .bind(workerId)
      .first<{ warm_models: string }>();
    expect(JSON.parse(workerRow!.warm_models)).toEqual(["flux1-dev.safetensors"]);
  });

  it("dispatches a starved job ahead of newer ones", async () => {
    const workerId = await makeWorker("w1", { dynamic: { free_vram_gb: 24 } });
    const start = new Date();
    const old = await makeSignedJob(uniqueId("j_old"), {
      createdAt: new Date(start.getTime() - (scheduler.STARVE_SECONDS + 60) * 1000),
    });
    await makeSignedJob(uniqueId("j_new"), { createdAt: start });

    const assignments = await dispatch.assignJobs(db(), [workerId], null, null, start);
    expect(assignments.map((a) => a.job.id)).toEqual([old]);
  });

  it("still dispatches when the warm_models write fails", async () => {
    // claim 已經 commit 了，所以 warm_models 寫失敗絕不能讓 job 卡在
    // `assigned` 卻沒人收到 `job` frame（只能等 90 秒後的 requeueStale），
    // 也不能吃掉本 tick 剩下的配對。把欄位改名讓那個 UPDATE 真的丟例外 --
    // 比 mock 掉 queries 模組更貼近真實失敗。
    const workerId = await makeWorker("w1", { dynamic: { free_vram_gb: 24 } });
    const jobId = await makeSignedJob(uniqueId("j"));

    await db().prepare("ALTER TABLE workers RENAME COLUMN warm_models TO warm_models_broken").run();
    let assignments: dispatch.Assignment[];
    try {
      assignments = await dispatch.assignJobs(db(), [workerId]);
    } finally {
      await db().prepare("ALTER TABLE workers RENAME COLUMN warm_models_broken TO warm_models").run();
    }

    expect(assignments.map((a) => [a.workerId, a.job.id])).toEqual([[workerId, jobId]]);
    const job = await getJobRow(jobId);
    expect(job.status).toBe("assigned");
    expect(job.worker_id).toBe(workerId);
  });

  it("never dispatches a parent job", async () => {
    const workerId = await makeWorker("w1", { dynamic: { free_vram_gb: 24 } });
    await makeSignedJob(uniqueId("j_parent"), { splitCount: 2 });

    expect(await dispatch.assignJobs(db(), [workerId])).toEqual([]);
  });
});

describe("assignJobs 的拆分步驟 (§3.5)", () => {
  /** 一件可拆的 queued job：workflow 是真的（子 workflow 重寫要用），
   * `split_plan` 是送件時就算好存下來的那個 JSON。 */
  async function makeSplittableJob(
    label = "j_split",
    opts: { batchSize?: number; createdAt?: Date; requiredModels?: string[] } = {}
  ): Promise<string> {
    const batchSize = opts.batchSize ?? 4;
    const workflow: Record<string, unknown> = {
      "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: batchSize } },
      "2": { class_type: "KSampler", inputs: { latent_image: ["1", 0], steps: 20 } },
      "3": { class_type: "SaveImage", inputs: { images: ["2", 0] } },
    };
    const id = uniqueId(label);
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, signature, required_nodes, required_models, split_plan)
         VALUES (?, ?, 'queued', ?, 'sig', ?, ?, ?)`
      )
      .bind(
        id,
        JSON.stringify(workflow),
        toSqliteTimestamp(opts.createdAt ?? new Date()),
        JSON.stringify(["EmptyLatentImage", "KSampler", "SaveImage"]),
        JSON.stringify(opts.requiredModels ?? []),
        JSON.stringify({ source_node_id: "1", batch_size: batchSize })
      )
      .run();
    return id;
  }

  async function childrenOf(parentId: string) {
    const { results } = await db()
      .prepare("SELECT id, split_index FROM jobs WHERE parent_id = ? ORDER BY split_index ASC")
      .bind(parentId)
      .all<any>();
    return results;
  }

  it("splits a batch across the idle fleet and dispatches the children", async () => {
    const workers = [
      await makeWorker("ws0", { dynamic: { free_vram_gb: 24 } }),
      await makeWorker("ws1", { dynamic: { free_vram_gb: 24 } }),
      await makeWorker("ws2", { dynamic: { free_vram_gb: 24 } }),
    ];
    const parentId = await makeSplittableJob();

    const assignments = await dispatch.assignJobs(db(), workers);

    const children = await childrenOf(parentId);
    expect(children.map((c: any) => c.split_index)).toEqual([0, 1, 2]);
    expect(new Set(assignments.map((a) => a.job.id))).toEqual(new Set(children.map((c: any) => c.id)));
    const parent = await getJobRow(parentId);
    expect(parent.split_count).toBe(3);
    // 父 job 自己從沒被指派出去。
    expect(parent.worker_id).toBeNull();
  });

  it("moves the parent to assigned in the same tick as the children's claim", async () => {
    // §3.4：claim 一個子 job 成功的那一刻，父 job 也要跟著變成 `assigned`。
    // 少了這個推導，父 job 會一路停在 `queued` 直到第一個子 job 的 busy 心跳
    // 才把它推成 `running` —— console／面板在「worker 已經在拿圖了」的整段
    // 區間裡顯示的都是錯的狀態。父 job 自己永遠沒有 worker。
    const workers = [
      await makeWorker("ws-pa0", { dynamic: { free_vram_gb: 24 } }),
      await makeWorker("ws-pa1", { dynamic: { free_vram_gb: 24 } }),
      await makeWorker("ws-pa2", { dynamic: { free_vram_gb: 24 } }),
    ];
    const parentId = await makeSplittableJob("j_parent_assigned");

    const assignments = await dispatch.assignJobs(db(), workers);

    expect(assignments).toHaveLength(3);
    const children = await childrenOf(parentId);
    for (const child of children) {
      expect((await getJobRow((child as any).id)).status).toBe("assigned");
    }
    const parent = await getJobRow(parentId);
    expect(parent.status).toBe("assigned");
    expect(parent.worker_id).toBeNull();
  });

  it("does not split for a single idle worker", async () => {
    const workerId = await makeWorker("ws-solo", { dynamic: { free_vram_gb: 24 } });
    const parentId = await makeSplittableJob();

    const assignments = await dispatch.assignJobs(db(), [workerId]);

    expect(await childrenOf(parentId)).toEqual([]);
    expect(assignments.map((a) => a.job.id)).toEqual([parentId]);
  });

  it("caps the split at the batch size", async () => {
    const workers = [];
    for (let i = 0; i < 4; i++) workers.push(await makeWorker(`ws-cap${i}`, { dynamic: { free_vram_gb: 24 } }));
    const parentId = await makeSplittableJob("j_cap", { batchSize: 2 });

    await dispatch.assignJobs(db(), workers);

    expect((await childrenOf(parentId)).length).toBe(2);
  });

  it("leaves an earlier job's worker out of the split budget", async () => {
    const workers = [];
    for (let i = 0; i < 3; i++) workers.push(await makeWorker(`ws-budget${i}`, { dynamic: { free_vram_gb: 24 } }));
    const base = new Date(Date.now() - 60_000);
    await makeJob({ id: "j_plain", createdAt: base });
    const parentId = await makeSplittableJob("j_after", { createdAt: new Date(base.getTime() + 1000) });

    await dispatch.assignJobs(db(), workers);

    // `consumed` 的估計：前面那件不可拆的 job 會用掉一台，所以只剩 2 台。
    expect((await childrenOf(parentId)).length).toBe(2);
  });

  it("does not split a job no worker is eligible for", async () => {
    const workers = [];
    for (let i = 0; i < 3; i++) workers.push(await makeWorker(`ws-inel${i}`, { dynamic: { free_vram_gb: 24 } }));
    // 沒有任何 worker 有這個模型，也沒傳 fetchableModels -> 一律 ineligible。
    const parentId = await makeSplittableJob("j_inel", { requiredModels: ["nobody-has-this.safetensors"] });

    const assignments = await dispatch.assignJobs(db(), workers);

    expect(await childrenOf(parentId)).toEqual([]);
    expect(assignments).toEqual([]);
  });
});

describe("子 job 動了就推導父 job (§3.4/§3.6)", () => {
  async function makeSplitFamily(
    label: string,
    childStatuses: string[],
    workerIds: (string | null)[] = []
  ): Promise<{ parentId: string; childIds: string[] }> {
    const parentId = uniqueId(label);
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, split_count, split_plan)
         VALUES (?, '{}', 'queued', ?, ?, ?)`
      )
      .bind(
        parentId,
        toSqliteTimestamp(new Date()),
        childStatuses.length,
        JSON.stringify({ source_node_id: "1", batch_size: 4 })
      )
      .run();
    const childIds: string[] = [];
    for (let i = 0; i < childStatuses.length; i++) {
      const childId = `${parentId}-c${i}`;
      childIds.push(childId);
      await db()
        .prepare(
          `INSERT INTO jobs (id, workflow_json, status, worker_id, created_at, parent_id, split_index)
           VALUES (?, '{}', ?, ?, ?, ?, ?)`
        )
        .bind(childId, childStatuses[i]!, workerIds[i] ?? null, toSqliteTimestamp(new Date()), parentId, i)
        .run();
    }
    return { parentId, childIds };
  }

  it("cancelling a child cancels the parent and the siblings", async () => {
    const { parentId, childIds } = await makeSplitFamily("p-cancel", ["queued", "running"], [null, "w7"]);
    const startedAt = toSqliteTimestamp(new Date(Date.now() - 30_000));
    await db().prepare("UPDATE jobs SET started_at = ? WHERE id = ?").bind(startedAt, childIds[1]!).run();
    const owners: split.CascadeCancelled[] = [];

    await dispatch.cancelJob(db(), childIds[0]!, "cancelled by admin", now(), owners);

    expect((await getJobRow(parentId)).status).toBe("cancelled");
    expect((await getJobRow(childIds[1]!)).status).toBe("cancelled");
    // 裁決：串聯取消的 owner 要回到呼叫端，Hub 才推得出 `job_cancelled`。第三個
    // 元素是取消當下的 `started_at`（只有真的在 running 的才有），Hub 拿它
    // mint 那張 cancelled 收據。
    expect(owners).toEqual([[childIds[1]!, "w7", startedAt]]);
  });

  it("does not flag a cascade-cancelled sibling that never started as running", async () => {
    // 只是 assigned（沒有 `started_at`）的兄弟不算 running -> 不該有收據。
    const { childIds } = await makeSplitFamily("p-cancel-idle", ["queued", "assigned"], [null, "w7"]);
    const owners: split.CascadeCancelled[] = [];

    await dispatch.cancelJob(db(), childIds[0]!, "cancelled by admin", now(), owners);

    expect(owners).toEqual([[childIds[1]!, "w7", null]]);
  });

  it("marking a child running moves the parent to running", async () => {
    const { parentId, childIds } = await makeSplitFamily("p-run", ["assigned", "queued"], ["w1", null]);

    expect(await dispatch.markRunning(db(), childIds[0]!, "w1", now())).toBe(true);

    expect((await getJobRow(parentId)).status).toBe("running");
  });

  it("a failed child fails the parent and cancels the siblings", async () => {
    const { parentId, childIds } = await makeSplitFamily("p-fail", ["running", "running"], ["w1", "w2"]);
    const startedAt = toSqliteTimestamp(new Date(Date.now() - 30_000));
    await db().prepare("UPDATE jobs SET started_at = ? WHERE id = ?").bind(startedAt, childIds[1]!).run();
    const owners: split.CascadeCancelled[] = [];

    expect(await dispatch.markFailed(db(), childIds[0]!, "w1", "CUDA OOM", now(), owners)).toBe(true);

    const parent = await getJobRow(parentId);
    expect(parent.status).toBe("failed");
    expect(parent.error).toBe("子任務 1/2：CUDA OOM");
    const sibling = await getJobRow(childIds[1]!);
    expect(sibling.status).toBe("cancelled");
    expect(sibling.worker_id).toBeNull();
    expect(sibling.last_worker_id).toBe("w2");
    expect(owners).toEqual([[childIds[1]!, "w2", startedAt]]);
  });

  it("the parent is done only once every child is done", async () => {
    const { parentId, childIds } = await makeSplitFamily("p-done", ["running", "running"], ["w1", "w2"]);

    expect(await dispatch.markDone(db(), childIds[0]!, "w1", ["a.png"], now())).toBe(true);
    expect((await getJobRow(parentId)).status).toBe("running");

    expect(await dispatch.markDone(db(), childIds[1]!, "w2", ["b.png"], now())).toBe(true);
    expect((await getJobRow(parentId)).status).toBe("done");
  });

  it("requeueStale pulls the parent back from running", async () => {
    const workerId = await makeWorker("w-stale-split");
    await setWorkerLastSeen(workerId, new Date(Date.now() - 600_000));
    const { parentId, childIds } = await makeSplitFamily("p-stale", ["running", "queued"], [workerId, null]);
    await db().prepare("UPDATE jobs SET status = 'running' WHERE id = ?").bind(parentId).run();

    expect(await dispatch.requeueStale(db(), now())).toEqual([childIds[0]!]);

    expect((await getJobRow(parentId)).status).toBe("queued");
  });

  it("treats a retried parent (split_count 0) as a plain job", async () => {
    const { parentId, childIds } = await makeSplitFamily("p-retried-dispatch", ["done", "done"]);
    await db()
      .prepare("UPDATE jobs SET split_count = 0, split_plan = NULL, status = 'queued' WHERE id = ?")
      .bind(parentId)
      .run();

    // 子 job 早就 done、也不歸誰，所以這個轉移不成立；父 job 完全不受影響。
    expect(await dispatch.markDone(db(), childIds[0]!, "w1", [], now())).toBe(false);
    expect((await getJobRow(parentId)).status).toBe("queued");
  });
});
