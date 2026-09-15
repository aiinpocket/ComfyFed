import { describe, expect, it } from "vitest";
import * as scheduler from "../src/core/scheduler";
import fixtures from "./fixtures/scheduler_cases.json";

const NOW = new Date("2026-09-15T12:00:00Z");

function job(
  jobId = "j1",
  opts: { isLight?: boolean; models?: string[]; createdAt?: Date } = {}
): scheduler.JobCandidate {
  return {
    jobId,
    signature: "sig",
    createdAt: opts.createdAt ?? NOW,
    isLight: opts.isLight ?? false,
    requiredModels: opts.models ?? [],
  };
}

function worker(
  workerId = "w1",
  opts: { backend?: string; freeVramGb?: number; warm?: string[]; inventory?: unknown[] } = {}
): scheduler.WorkerCandidate {
  return {
    workerId,
    name: workerId,
    backend: opts.backend ?? "cuda",
    freeVramGb: opts.freeVramGb ?? 24,
    warmModels: opts.warm ?? [],
    inventory: (opts.inventory ?? []) as any,
  };
}

function pair(kind = "eligible", hasWarnings = false, totalFetchBytes = 0): scheduler.PairVerdict {
  return { kind, hasWarnings, totalFetchBytes };
}

function pairMap(entries: [string, string, scheduler.PairVerdict][]): Map<string, scheduler.PairVerdict> {
  return new Map(entries.map(([j, w, v]) => [scheduler.pairKey(j, w), v]));
}

function predMap(entries: [string, string, number][]): Map<string, number> {
  return new Map(entries.map(([j, w, v]) => [scheduler.pairKey(j, w), v]));
}

describe("loadSeconds", () => {
  it("is zero when every model is already warm", () => {
    const j = job("j1", { models: ["flux1-dev.safetensors"] });
    const w = worker("w1", {
      warm: ["flux1-dev.safetensors"],
      inventory: [{ name: "diffusion_models/flux1-dev.safetensors", size: 22 }],
    });
    expect(scheduler.loadSeconds(j, w)).toBe(0);
  });

  it("charges 1.5 seconds per GB of cold models", () => {
    const j = job("j1", { models: ["flux1-dev.safetensors"] });
    const w = worker("w1", { inventory: [{ name: "diffusion_models/flux1-dev.safetensors", size: 6 }] });
    expect(scheduler.loadSeconds(j, w)).toBeCloseTo(9, 10);
  });

  it("treats an unknown size as zero", () => {
    const j = job("j1", { models: ["mystery.safetensors"] });
    const w = worker("w1", { inventory: [{ name: "loras/mystery.safetensors" }] });
    expect(scheduler.loadSeconds(j, w)).toBe(0);
  });

  it("sums every cold model", () => {
    const j = job("j1", { models: ["a.safetensors", "b.safetensors"] });
    const w = worker("w1", {
      warm: ["a.safetensors"],
      inventory: [
        { name: "unet/a.safetensors", size: 10 },
        { name: "vae/b.safetensors", size: 2 },
      ],
    });
    expect(scheduler.loadSeconds(j, w)).toBeCloseTo(3, 10);
  });
});

describe("fetchSeconds", () => {
  it("is zero for a directly eligible pair", () => expect(scheduler.fetchSeconds(pair())).toBe(0));
  it("divides by 50 MB/s", () =>
    expect(scheduler.fetchSeconds(pair("eligible_after_fetch", false, 500_000_000))).toBeCloseTo(10, 10));
});

describe("lightPenalty", () => {
  it("is zero for a heavy job", () =>
    expect(scheduler.lightPenalty(job("j1"), worker("w1", { freeVramGb: 32 }))).toBe(0));
  it("punishes a real GPU and scales with free VRAM", () =>
    expect(scheduler.lightPenalty(job("j1", { isLight: true }), worker("w1", { freeVramGb: 32 }))).toBeCloseTo(220, 10));
  it("lets a weak backend off the 60 second charge", () =>
    expect(
      scheduler.lightPenalty(job("j1", { isLight: true }), worker("w1", { backend: "mps", freeVramGb: 0 }))
    ).toBe(0));
});

describe("cost", () => {
  it("sums every component plus the legacy tiebreak", () => {
    const j = job("j1", { models: ["flux1-dev.safetensors"] });
    const w = worker("w1", { freeVramGb: 24, inventory: [{ name: "unet/flux1-dev.safetensors", size: 6 }] });
    expect(scheduler.cost(j, w, pair(), 40, true)).toBeCloseTo(40 + 9 + 0.000976, 9);
  });

  it("adds a million for a warned verdict", () => {
    const j = job();
    const w = worker("w1", { freeVramGb: 24 });
    const clean = scheduler.cost(j, w, pair(), 40, true);
    const warned = scheduler.cost(j, w, pair("eligible", true), 40, true);
    expect(warned - clean).toBeCloseTo(scheduler.WARN_PENALTY, 6);
  });

  it("prefers the smaller card for a light job's tiebreak", () => {
    const j = job("j1", { isLight: true });
    const small = scheduler.cost(j, worker("w_small", { freeVramGb: 8 }), pair(), 40, true);
    const big = scheduler.cost(j, worker("w_big", { freeVramGb: 8.0001 }), pair(), 40, true);
    expect(small).toBeLessThan(big);
  });

  it("is infinite for an ineligible pair", () =>
    expect(scheduler.cost(job(), worker(), pair("ineligible"), 40, true)).toBe(Infinity));

  it("is infinite for a fetch candidate when a tier-1 candidate exists", () => {
    const p = pair("eligible_after_fetch", false, 10);
    expect(scheduler.cost(job(), worker(), p, 40, true)).toBe(Infinity);
    expect(Number.isFinite(scheduler.cost(job(), worker(), p, 40, false))).toBe(true);
  });

  it("is infinite when any component is NaN or negative", () => {
    expect(scheduler.cost(job(), worker(), pair(), NaN, true)).toBe(Infinity);
    expect(scheduler.cost(job(), worker(), pair(), -1, true)).toBe(Infinity);
  });
});

describe("objective", () => {
  it("subtracts BIG so assigning always beats idling", () =>
    expect(scheduler.objective(100, 0)).toBeCloseTo(100 - scheduler.BIG, 6));
  it("rewards waiting one second per second", () =>
    expect(scheduler.objective(100, 30)).toBeCloseTo(100 - 30 - scheduler.BIG, 6));
  it("adds the starvation bonus past 300 seconds", () => {
    const starved = scheduler.objective(100, scheduler.STARVE_SECONDS);
    const fresh = scheduler.objective(100, scheduler.STARVE_SECONDS - 1);
    expect(fresh - starved).toBeCloseTo(scheduler.STARVE_BONUS + 1, 0);
  });
  it("keeps infinity infinite", () => expect(scheduler.objective(Infinity, 9999)).toBe(Infinity));
});

describe("solve (Hungarian)", () => {
  it("returns nothing for an empty matrix", () => expect(scheduler.solve([])).toEqual([]));

  it("finds the known optimum of a 4x4", () => {
    const matrix = [
      [82, 83, 69, 92],
      [77, 37, 49, 92],
      [11, 69, 5, 86],
      [8, 9, 98, 23],
    ];
    const pairs = scheduler.solve(matrix);
    expect(pairs).toHaveLength(4);
    expect(pairs.map(([r]) => r).sort()).toEqual([0, 1, 2, 3]);
    expect(pairs.map(([, c]) => c).sort()).toEqual([0, 1, 2, 3]);
    const total = pairs.reduce((sum, [r, c]) => sum + matrix[r]![c]!, 0);
    expect(total).toBeCloseTo(140, 10);
  });

  it("handles 3 jobs x 5 workers and avoids forbidden cells", () => {
    const matrix = [
      [10, Infinity, 30, 40, 50],
      [Infinity, 20, 35, 45, 55],
      [60, 70, 15, 80, 90],
    ];
    expect(scheduler.solve(matrix)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it("drops every pair when the matrix is all forbidden", () => {
    expect(scheduler.solve([[Infinity, Infinity], [Infinity, Infinity]])).toEqual([]);
  });

  it("treats NaN as forbidden", () => {
    expect(scheduler.solve([[NaN, 5], [5, NaN]])).toEqual([
      [0, 1],
      [1, 0],
    ]);
  });

  it("accepts finite negative costs", () => {
    expect(scheduler.solve([[-1e9 + 5, -1e9 + 50], [-1e9 + 40, -1e9 + 10]])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

  it("is deterministic on ties", () => {
    const matrix = [[1, 1], [1, 1]];
    expect(scheduler.solve(matrix)).toEqual(scheduler.solve(matrix));
    expect(scheduler.solve(matrix)).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });
});

describe("match", () => {
  it("gives two heavy jobs one card each instead of the same card", () => {
    const jobs = [job("j1"), job("j2")];
    const workers = [worker("w_big", { freeVramGb: 32 }), worker("w_small", { freeVramGb: 12 })];
    const pairs = pairMap(jobs.flatMap((j) => workers.map((w) => [j.jobId, w.workerId, pair()] as [string, string, scheduler.PairVerdict])));
    const preds = predMap(jobs.flatMap((j) => workers.map((w) => [j.jobId, w.workerId, 40] as [string, string, number])));
    const result = scheduler.match(jobs, workers, pairs, preds, NOW);
    expect(result).toHaveLength(2);
    expect(result.map(([, c]) => c).sort()).toEqual([0, 1]);
  });

  it("prefers the warm cache over a bigger but cold card", () => {
    const jobs = [job("j1", { models: ["flux1-dev.safetensors"] })];
    const workers = [
      worker("w_warm", { freeVramGb: 16, warm: ["flux1-dev.safetensors"], inventory: [{ name: "unet/flux1-dev.safetensors", size: 22 }] }),
      worker("w_cold", { freeVramGb: 48, inventory: [{ name: "unet/flux1-dev.safetensors", size: 22 }] }),
    ];
    const pairs = pairMap(workers.map((w) => ["j1", w.workerId, pair()] as [string, string, scheduler.PairVerdict]));
    const preds = predMap(workers.map((w) => ["j1", w.workerId, 40] as [string, string, number]));
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[0, 0]]);
  });

  it("prefers the historically faster worker", () => {
    const jobs = [job("j1")];
    const workers = [worker("w_slow"), worker("w_fast")];
    const pairs = pairMap(workers.map((w) => ["j1", w.workerId, pair()] as [string, string, scheduler.PairVerdict]));
    const preds = predMap([["j1", "w_slow", 90], ["j1", "w_fast", 30]]);
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[0, 1]]);
  });

  it("prefers a clean worker over a warned one", () => {
    const jobs = [job("j1")];
    const workers = [worker("w_warn", { freeVramGb: 48 }), worker("w_clean", { freeVramGb: 8 })];
    const pairs = pairMap([
      ["j1", "w_warn", pair("eligible", true)],
      ["j1", "w_clean", pair()],
    ]);
    const preds = predMap([["j1", "w_warn", 10], ["j1", "w_clean", 40]]);
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[0, 1]]);
  });

  it("prefers a worker that already has the model over one that must download", () => {
    const jobs = [job("j1", { models: ["flux1-dev.safetensors"] })];
    const workers = [
      worker("w_have", { freeVramGb: 8, inventory: [{ name: "unet/flux1-dev.safetensors", size: 22 }] }),
      worker("w_fetch", { freeVramGb: 48 }),
    ];
    const pairs = pairMap([
      ["j1", "w_have", pair()],
      ["j1", "w_fetch", pair("eligible_after_fetch", false, 1)],
    ]);
    const preds = predMap([["j1", "w_have", 40], ["j1", "w_fetch", 1]]);
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[0, 0]]);
  });

  it("lets a starved job jump a fresh one for the only worker", () => {
    const starved = job("j_old", { createdAt: new Date(NOW.getTime() - (scheduler.STARVE_SECONDS + 10) * 1000) });
    const fresh = job("j_new");
    const jobs = [fresh, starved];
    const workers = [worker("w1")];
    const pairs = pairMap(jobs.map((j) => [j.jobId, "w1", pair()] as [string, string, scheduler.PairVerdict]));
    const preds = predMap(jobs.map((j) => [j.jobId, "w1", 40] as [string, string, number]));
    expect(scheduler.match(jobs, workers, pairs, preds, NOW)).toEqual([[1, 0]]);
  });
});

describe("shared fixture parity", () => {
  it("solves every hungarian case exactly like Python does", () => {
    for (const c of (fixtures as any).hungarian_cases) {
      const matrix = (c.matrix as (number | null)[][]).map((row) => row.map((v) => (v === null ? Infinity : v)));
      expect(scheduler.solve(matrix), c.name).toEqual(c.expected_pairs.map((p: number[]) => [p[0], p[1]]));
    }
  });

  it("costs every case exactly like Python does", () => {
    for (const c of (fixtures as any).cost_cases) {
      const j: scheduler.JobCandidate = {
        jobId: c.job.job_id,
        signature: c.job.signature,
        createdAt: new Date(`${c.job.created_at}Z`),
        isLight: c.job.is_light,
        requiredModels: c.job.required_models,
      };
      const w: scheduler.WorkerCandidate = {
        workerId: c.worker.worker_id,
        name: c.worker.name,
        backend: c.worker.backend,
        freeVramGb: c.worker.free_vram_gb,
        warmModels: c.worker.warm_models,
        inventory: c.worker.inventory,
      };
      const p: scheduler.PairVerdict = {
        kind: c.pair.kind,
        hasWarnings: c.pair.has_warnings,
        totalFetchBytes: c.pair.total_fetch_bytes,
      };
      expect(scheduler.cost(j, w, p, c.predicted_seconds, c.tier1_exists), c.name).toBeCloseTo(c.expected_cost, 9);
    }
  });
});
