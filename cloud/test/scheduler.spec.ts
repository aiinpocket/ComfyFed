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

  it("picks the cheaper rival when the feasible graph is deficient", () => {
    // job 0 / job 1 只配得上 worker 0，job 2 三台都行 -- 方陣但可行圖有缺口。
    const matrix = [
      [-1e9 + 10, Infinity, Infinity],
      [-1e9 + 30, Infinity, Infinity],
      [-1e9 + 20, -1e9 + 50, -1e9 + 60],
    ];
    const pairs = scheduler.solve(matrix);
    expect(pairs).toHaveLength(2);
    // job 2 拿它獨佔的其中一台，不跟人搶 worker 0。
    expect([1, 2]).toContain(pairs.find(([r]) => r === 2)![1]);
    // worker 0 給比較便宜的 job 0。
    expect(pairs).toEqual([
      [0, 0],
      [2, 1],
    ]);
  });

  it("does not quantise costs when a row is all forbidden", () => {
    // 固定哨兵 1e18 的 ulp 是 128，這兩列只差 121 -- 舊寫法會選到較貴的 [0, 1]。
    const matrix = [
      [Infinity, -1098999874.906086],
      [Infinity, -1098999996.121946],
    ];
    expect(scheduler.solve(matrix)).toEqual([[1, 1]]);
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

  // 2026-09-23 cross-backend §3.3：hold 判斷兩棧逐案相同。
  it("applies holds to every case exactly like Python does", () => {
    for (const c of (fixtures as any).hold_cases) {
      const jobs: scheduler.JobCandidate[] = c.jobs.map((j: any) => ({
        jobId: j.job_id, signature: j.signature, createdAt: new Date("2026-09-15T12:00:00Z"),
        isLight: j.is_light, requiredModels: j.required_models,
      }));
      const workers: scheduler.WorkerCandidate[] = c.workers.map((w: any) => ({
        workerId: w.worker_id, name: w.name, backend: w.backend, freeVramGb: w.free_vram_gb,
        warmModels: w.warm_models, inventory: w.inventory,
      }));
      const busy: scheduler.BusyWorker[] = c.busy.map((b: any) => ({
        workerId: b.worker_id, name: b.name, backend: b.backend, etaSeconds: b.eta_seconds,
        warmModels: b.warm_models, inventory: b.inventory,
      }));
      const pairs = new Map<string, scheduler.PairVerdict>();
      for (const [k, v] of Object.entries(c.pairs as Record<string, any>)) {
        const [jobId = "", workerId = ""] = k.split("|");
        pairs.set(scheduler.pairKey(jobId, workerId), { kind: v.kind, hasWarnings: v.has_warnings, totalFetchBytes: v.total_fetch_bytes });
      }
      const predictions = new Map<string, number>();
      for (const [k, v] of Object.entries(c.predictions as Record<string, number>)) {
        const [jobId = "", workerId = ""] = k.split("|");
        predictions.set(scheduler.pairKey(jobId, workerId), v);
      }
      const { pairs: out, holds } = scheduler.applyHolds(jobs, workers, busy, pairs, predictions);
      const held = jobs.flatMap((j) => workers.filter((w) => out.get(scheduler.pairKey(j.jobId, w.workerId))?.kind === scheduler.HELD_KIND).map((w) => `${j.jobId}|${w.workerId}`)).sort();
      expect(held, c.name).toEqual([...c.expected_held_pairs].sort());
      expect(holds.map((h) => [h.jobId, h.workerId]), c.name).toEqual(c.expected_holds.map((h: any) => [h.job_id, h.worker_id]));
      holds.forEach((h, i) => {
        expect(h.waitSeconds, c.name).toBeCloseTo(c.expected_holds[i].wait_seconds, 6);
        expect(h.runNowSeconds, c.name).toBeCloseTo(c.expected_holds[i].run_now_seconds, 6);
      });
    }
  });
});



// --- 2026-09-23 cross-backend dispatch: priors, remaining time, holds ------
// Ports the section of the same name from the original Python suite.

function busy(
  workerId = "nv",
  opts: { backend?: string; eta?: number; warm?: string[]; inventory?: unknown[] } = {}
): scheduler.BusyWorker {
  return {
    workerId,
    name: workerId,
    backend: opts.backend ?? "cuda",
    etaSeconds: opts.eta ?? 120,
    warmModels: opts.warm ?? [],
    inventory: (opts.inventory ?? []) as any,
  };
}

const FLUX = "flux1-dev.safetensors";
const FLUX_INV = [{ name: "unet/flux1-dev.safetensors", size: 6 }];

describe("speedPrior", () => {
  it("orders backends and defaults unknown to half", () => {
    expect(scheduler.speedPrior("cuda")).toBe(1.0);
    expect(scheduler.speedPrior("cuda")).toBeGreaterThan(scheduler.speedPrior("rocm"));
    expect(scheduler.speedPrior("rocm")).toBeGreaterThan(scheduler.speedPrior("mps"));
    expect(scheduler.speedPrior("mps")).toBeGreaterThan(scheduler.speedPrior("cpu"));
    expect(scheduler.speedPrior("")).toBe(scheduler.DEFAULT_SPEED_PRIOR);
    expect(scheduler.speedPrior("tpu")).toBe(scheduler.DEFAULT_SPEED_PRIOR);
  });
});

describe("remainingSeconds", () => {
  it("subtracts elapsed with a floor and gives up when overdue", () => {
    expect(scheduler.remainingSeconds(600, 100)).toBeCloseTo(500, 10);
    // 已經跑到 95%：剩餘不會低於預估的 10%
    expect(scheduler.remainingSeconds(600, 570)).toBeCloseTo(60, 10);
    // 超時到 2 倍以上：未知
    expect(scheduler.remainingSeconds(600, 1201)).toBeNull();
    expect(scheduler.remainingSeconds(0, 10)).toBeNull();
    expect(scheduler.remainingSeconds(Infinity, 10)).toBeNull();
    expect(scheduler.remainingSeconds(600, -1)).toBeNull();
  });
});

describe("waitCost", () => {
  it("is eta plus queue plus the same cost an idle worker pays", () => {
    const j = job("j1", { models: [FLUX] });
    const b = busy("nv", { eta: 100, inventory: FLUX_INV });
    // 100 (eta) + 50 (queue ahead) + 40 (predicted) + 9 (load 6 GB) + tiebreak
    expect(scheduler.waitCost(j, b, pair(), 40, 50)).toBeCloseTo(199.0 + 0.001, 3);
    expect(scheduler.waitCost(j, b, pair("ineligible"), 40, 0)).toBe(Infinity);
    // 需要下載的 busy worker 仍是選項（不受 tier1 排除），下載時間算進去
    const fetch = pair("eligible_after_fetch", false, 500_000_000);
    expect(scheduler.waitCost(j, b, fetch, 40, 0)).toBeCloseTo(100 + 40 + 9 + 10 + 0.001, 3);
  });
});

function holdSetup(macPredicted = 7200, nvPredicted = 500, nvEta = 300) {
  const j = job("j1", { models: [FLUX] });
  const mac = worker("mac", { backend: "mps", freeVramGb: 0, inventory: FLUX_INV, warm: [FLUX] });
  const nv = busy("nv", { eta: nvEta, inventory: FLUX_INV, warm: [FLUX] });
  const pairs = pairMap([
    ["j1", "mac", pair()],
    ["j1", "nv", pair()],
  ]);
  const predictions = predMap([
    ["j1", "mac", macPredicted],
    ["j1", "nv", nvPredicted],
  ]);
  return { j, mac, nv, pairs, predictions };
}

describe("applyHolds", () => {
  it("keeps a job off the slow idle worker when waiting is clearly faster", () => {
    const { j, mac, nv, pairs, predictions } = holdSetup();
    const { pairs: out, holds } = scheduler.applyHolds([j], [mac], [nv], pairs, predictions);
    const macPair = out.get(scheduler.pairKey("j1", "mac"))!;
    expect(macPair.kind).toBe(scheduler.HELD_KIND);
    expect(scheduler.cost(j, mac, macPair, 7200, true)).toBe(Infinity);
    expect(holds).toHaveLength(1);
    expect(holds[0]!.workerId).toBe("nv");
    expect(holds[0]!.waitSeconds).toBeCloseTo(800, 2); // 300 eta + 500 predicted
    expect(holds[0]!.runNowSeconds).toBeCloseTo(7200, 2);
  });

  it("does not hold when waiting is not clearly better", () => {
    // 等 NVIDIA：300 + 500 = 800；Mac 立刻做 900 -- 900 < 800*1.25+30，不 hold
    const { j, mac, nv, pairs, predictions } = holdSetup(900);
    const { pairs: out, holds } = scheduler.applyHolds([j], [mac], [nv], pairs, predictions);
    expect(out.get(scheduler.pairKey("j1", "mac"))!.kind).toBe("eligible");
    expect(holds).toEqual([]);
  });

  it("is the identity without busy workers", () => {
    const { j, mac, pairs, predictions } = holdSetup();
    const { pairs: out, holds } = scheduler.applyHolds([j], [mac], [], pairs, predictions);
    expect([...out.entries()]).toEqual([...pairs.entries()]);
    expect(holds).toEqual([]);
  });

  it("ignores a busy worker that is ineligible for the job", () => {
    const { j, mac, nv, pairs, predictions } = holdSetup();
    pairs.set(scheduler.pairKey("j1", "nv"), pair("ineligible"));
    const { pairs: out, holds } = scheduler.applyHolds([j], [mac], [nv], pairs, predictions);
    expect(out.get(scheduler.pairKey("j1", "mac"))!.kind).toBe("eligible");
    expect(holds).toEqual([]);
  });

  it("queues held jobs behind each other so the slow worker gets the overflow", () => {
    const mac = worker("mac", { backend: "mps", freeVramGb: 0, inventory: FLUX_INV, warm: [FLUX] });
    const nv = busy("nv", { eta: 300, inventory: FLUX_INV, warm: [FLUX] });
    const jobs = [1, 2, 3, 4].map((i) => job(`j${i}`, { models: [FLUX] }));
    const pairs = new Map<string, scheduler.PairVerdict>();
    const predictions = new Map<string, number>();
    for (const j of jobs) {
      pairs.set(scheduler.pairKey(j.jobId, "mac"), pair());
      pairs.set(scheduler.pairKey(j.jobId, "nv"), pair());
      predictions.set(scheduler.pairKey(j.jobId, "mac"), 2000);
      predictions.set(scheduler.pairKey(j.jobId, "nv"), 500);
    }
    const { pairs: out, holds } = scheduler.applyHolds(jobs, [mac], [nv], pairs, predictions);
    // j1: 等 800 vs 2000 -> hold；j2: 等 1300 vs 2000 -> hold (2000 > 1655)；
    // j3: 等 1800 vs 2000 -> 2000 < 2280，不 hold -> Mac 接；j4 同 j3。
    expect(new Set(holds.map((h) => h.jobId))).toEqual(new Set(["j1", "j2"]));
    expect(out.get(scheduler.pairKey("j3", "mac"))!.kind).toBe("eligible");
    expect(out.get(scheduler.pairKey("j4", "mac"))!.kind).toBe("eligible");
  });

  it("counts a job with no idle option in the busy queue without a hold", () => {
    const mac = worker("mac", { backend: "mps", freeVramGb: 0, inventory: FLUX_INV, warm: [FLUX] });
    const nv = busy("nv", { eta: 300, inventory: FLUX_INV, warm: [FLUX] });
    const j1 = job("j1", { models: [FLUX] }); // Mac 不合格，只能等 nv
    const j2 = job("j2", { models: [FLUX] });
    const pairs = pairMap([
      ["j1", "mac", pair("ineligible")],
      ["j1", "nv", pair()],
      ["j2", "mac", pair()],
      ["j2", "nv", pair()],
    ]);
    const predictions = predMap([
      ["j1", "mac", 1000],
      ["j1", "nv", 500],
      ["j2", "mac", 1000],
      ["j2", "nv", 500],
    ]);
    const { pairs: out, holds } = scheduler.applyHolds([j1, j2], [mac], [nv], pairs, predictions);
    // j1 排在 nv 前面（300+500），所以 j2 等 nv 要 1300 > 1000 -> 不 hold；且 j1 不算 hold（本來就沒 idle 選項）
    expect(holds).toEqual([]);
    expect(out.get(scheduler.pairKey("j2", "mac"))!.kind).toBe("eligible");
  });
});

describe("cost (2026-09-23)", () => {
  it("no longer carries a flat backend penalty", () => {
    // 2026-09-23：後端差異改由 speed prior / 學到的 speed_index 進 predicted_seconds
    const j = job("j1", { models: [FLUX] });
    const nv = worker("nv", { backend: "cuda", freeVramGb: 24, inventory: FLUX_INV });
    const mac = worker("mac", { backend: "mps", freeVramGb: 0, inventory: FLUX_INV });
    const a = scheduler.cost(j, nv, pair(), 40, true);
    const b = scheduler.cost(j, mac, pair(), 40, true);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });
});
