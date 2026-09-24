/**
 * Phase 3.3 §2.4-§2.5: 成本模型與整體配對。
 * 自原 Python 伺服器移植（2026-09）；本檔現為唯一實作。全部是純函數，不碰
 * D1、不讀時鐘（`now` 由呼叫端傳）。改了算式，`cloud/test/fixtures/
 * scheduler_cases.json`（釘住算式的黃金 fixture）必須同一個 commit 一起改。
 */

import { findModel } from "./assess";
import type { ModelInventoryEntry } from "../db/queries";

export const LOAD_SEC_PER_GB = 1.5;
export const FETCH_BYTES_PER_SEC = 50e6;
export const STARVE_SECONDS = 300;
/** 等待超過 STARVE_SECONDS 再多減這麼多，確保只要有合格 worker 一定本 tick 派出。 */
export const STARVE_BONUS = 1e8;
export const AGE_WEIGHT = 1.0;
export const BIG = 1e9;
export const WARN_PENALTY = 1_000_000.0;
export const LIGHT_BACKEND_PENALTY = 60.0;
export const LIGHT_VRAM_WEIGHT = 5.0;

/** 2026-09-23 cross-backend dispatch (spec: docs/superpowers/specs/
 * 2026-09-23-cross-backend-dispatch-design.md) -- ports
 * `scheduler.BACKEND_SPEED_PRIOR`: a worker that has never completed a job
 * has no learned `speed_index`; until it does, its backend supplies a prior
 * so the first predictions are in the right order of magnitude (an Apple M4
 * Pro measured ~1/8 of an RTX 5080 on fp8 Chroma, and worse on emulated int8
 * video). 1.0 = "fleet average NVIDIA card". */
export const BACKEND_SPEED_PRIOR: Record<string, number> = { cuda: 1.0, rocm: 0.7, mps: 0.12, cpu: 0.03 };
export const DEFAULT_SPEED_PRIOR = 0.5;

/** Wait-or-run-now (§3): a job is HELD off an idle worker when a currently
 * busy worker is expected to finish it sooner even after waiting for it.
 * The margin absorbs estimate error -- we only hold when waiting is clearly
 * better, never on a coin flip. Ports `scheduler.HOLD_MARGIN_*`. */
export const HOLD_MARGIN_RATIO = 1.25;
export const HOLD_MARGIN_SECONDS = 30.0;
/** A running job that has already taken longer than this multiple of its own
 * prediction has an unknown remaining time: nobody is held for that worker. */
export const OVERDUE_FACTOR = 2.0;
/** Remaining time never drops below this fraction of the prediction, so a
 * worker "about to finish" for the last ten minutes cannot hold a job with
 * an ETA of 0. */
export const MIN_REMAINING_FRACTION = 0.1;
export const HELD_KIND = "held";

const WEAK_BACKENDS = ["mps", "cpu"];

export interface JobCandidate {
  jobId: string;
  signature: string | null;
  createdAt: Date;
  /** 無 required_models 且無 est_vram_gb。 */
  isLight: boolean;
  requiredModels: string[];
}

export interface WorkerCandidate {
  workerId: string;
  name: string;
  backend: string;
  freeVramGb: number;
  /** 最近一次被指派的 job 的 required_models（§2.2）。 */
  warmModels: string[];
  inventory: ModelInventoryEntry[];
}

export interface PairVerdict {
  kind: string; // "eligible" | "eligible_after_fetch" | "ineligible"
  hasWarnings: boolean;
  totalFetchBytes: number;
}

/** `pairs` / `predictions` 的鍵。TS 沒有 tuple key，用一個不可能出現在 id 裡
 * 的 NUL 分隔字串取代 Python 的 `(job_id, worker_id)`。 */
export function pairKey(jobId: string, workerId: string): string {
  return `${jobId}\u0000${workerId}`;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** §2.4 -- ports `scheduler.load_seconds`. */
export function loadSeconds(job: JobCandidate, worker: WorkerCandidate): number {
  const warm = new Set(worker.warmModels);
  let totalGb = 0;
  for (const name of job.requiredModels) {
    if (warm.has(name)) continue;
    const [, sizeGb] = findModel(worker.inventory, name);
    if (sizeGb !== null) totalGb += sizeGb;
  }
  return totalGb * LOAD_SEC_PER_GB;
}

/** §2.4 -- ports `scheduler.fetch_seconds`. */
export function fetchSeconds(pair: PairVerdict): number {
  if (pair.kind !== "eligible_after_fetch") return 0;
  return pair.totalFetchBytes / FETCH_BYTES_PER_SEC;
}

/** §2.4 -- ports `scheduler.light_penalty`. */
export function lightPenalty(job: JobCandidate, worker: WorkerCandidate): number {
  if (!job.isLight) return 0;
  const backendPenalty = WEAK_BACKENDS.includes(worker.backend) ? 0 : LIGHT_BACKEND_PENALTY;
  return backendPenalty + worker.freeVramGb * LIGHT_VRAM_WEIGHT;
}

/** 只用來打破完全相等的舊排序鍵 -- ports `scheduler._legacy_tiebreak`. */
function legacyTiebreak(job: JobCandidate, worker: WorkerCandidate): number {
  if (job.isLight) return worker.freeVramGb / 1000;
  return (1000 - worker.freeVramGb) / 1e6;
}

/** §2.4 的 `cost(j, w)` -- ports `scheduler.cost`；不可用一律 Infinity。 */
export function cost(
  job: JobCandidate,
  worker: WorkerCandidate,
  pair: PairVerdict,
  predictedSeconds: number,
  tier1Exists: boolean
): number {
  if (pair.kind !== "eligible" && pair.kind !== "eligible_after_fetch") return Infinity;
  if (pair.kind === "eligible_after_fetch" && tier1Exists) return Infinity;

  const components = [
    predictedSeconds,
    loadSeconds(job, worker),
    fetchSeconds(pair),
    lightPenalty(job, worker),
    pair.hasWarnings ? WARN_PENALTY : 0,
    legacyTiebreak(job, worker),
  ];
  let total = 0;
  for (const component of components) {
    if (!finite(component) || component < 0) return Infinity;
    total += component;
  }
  return total;
}

/** §2.5 第 4 條 -- ports `scheduler.objective`. */
export function objective(costValue: number, waitSeconds: number): number {
  if (!finite(costValue)) return Infinity;
  const wait = finite(waitSeconds) && waitSeconds > 0 ? waitSeconds : 0;
  let value = costValue - AGE_WEIGHT * wait - BIG;
  if (wait >= STARVE_SECONDS) value -= STARVE_BONUS;
  return value;
}

/** The `speed_index` a worker with no completed job is assumed to have --
 * ports `scheduler.speed_prior`. */
export function speedPrior(backend: string): number {
  return BACKEND_SPEED_PRIOR[backend || ""] ?? DEFAULT_SPEED_PRIOR;
}

/** §3.1 -- ports `scheduler.remaining_seconds`: how much longer a running
 * job is expected to take, or null when that is unknowable (no usable
 * prediction, or already overdue past `OVERDUE_FACTOR` -- the estimate was
 * wrong and must not anchor a hold). */
export function remainingSeconds(predicted: number, elapsed: number): number | null {
  if (!finite(predicted) || predicted <= 0 || !finite(elapsed) || elapsed < 0) return null;
  if (elapsed > predicted * OVERDUE_FACTOR) return null;
  return Math.max(predicted - elapsed, predicted * MIN_REMAINING_FRACTION);
}

/** A worker currently executing a job, as a candidate to WAIT for -- ports
 * `scheduler.BusyWorker`. */
export interface BusyWorker {
  workerId: string;
  name: string;
  backend: string;
  /** Expected seconds until its current job finishes (`remainingSeconds`). */
  etaSeconds: number;
  /** required_models of the job it is running: those will be warm. */
  warmModels: string[];
  inventory: ModelInventoryEntry[];
}

/** Ports `scheduler.BusyWorker.as_worker`. */
export function busyAsWorker(busy: BusyWorker): WorkerCandidate {
  return {
    workerId: busy.workerId,
    name: busy.name,
    backend: busy.backend,
    freeVramGb: 0,
    warmModels: busy.warmModels,
    inventory: busy.inventory,
  };
}

/** Why a job was kept queued this tick: `workerId` is expected to finish it
 * at `waitSeconds` from now, the best idle worker only at `runNowSeconds`
 * (Infinity when no idle worker was eligible at all) -- ports
 * `scheduler.Hold`. */
export interface Hold {
  jobId: string;
  workerId: string;
  waitSeconds: number;
  runNowSeconds: number;
}

/** §3.2 -- ports `scheduler.wait_cost`: expected completion if `job` waits
 * for `busy` -- its remaining time, plus everything already promised to it
 * this tick, plus the same `cost` an idle worker would be charged.
 * `tier1Exists=false`: a busy worker that must fetch is still a real
 * option, the fetch time is in. */
export function waitCost(
  job: JobCandidate,
  busy: BusyWorker,
  pair: PairVerdict,
  predictedSeconds: number,
  queueAheadSeconds: number
): number {
  const base = cost(job, busyAsWorker(busy), pair, predictedSeconds, false);
  if (!finite(base)) return Infinity;
  const total = busy.etaSeconds + queueAheadSeconds + base;
  return finite(total) && total >= 0 ? total : Infinity;
}

/**
 * §3.3 -- ports `scheduler.apply_holds`: decide, job by job in queue order,
 * whether waiting for a busy worker beats every idle worker that could run
 * it now.
 *
 * Returns a copy of `pairs` in which each (job, idle worker) cell that lost
 * to waiting is marked `HELD_KIND` (so `cost` treats it as unavailable),
 * plus one `Hold` per job that ended up with no idle option left. Jobs are
 * walked oldest first and each held job is added to its chosen busy
 * worker's `queueAhead`, so the fifth job waiting for the same card sees
 * the four in front of it and may well go to the Mac after all.
 *
 * Never strands a job: a hold only exists relative to a busy worker that
 * is eligible and has a known ETA. With no busy workers (`busyWorkers`
 * empty) this is the identity, which is also what every caller that
 * predates the feature gets.
 */
export function applyHolds(
  jobs: JobCandidate[],
  workers: WorkerCandidate[],
  busyWorkers: BusyWorker[],
  pairs: Map<string, PairVerdict>,
  predictions: Map<string, number>
): { pairs: Map<string, PairVerdict>; holds: Hold[] } {
  const out = new Map(pairs);
  const holds: Hold[] = [];
  if (busyWorkers.length === 0) return { pairs: out, holds };

  const tier1 = new Map<string, boolean>();
  for (const job of jobs) {
    tier1.set(
      job.jobId,
      workers.some((w) => pairs.get(pairKey(job.jobId, w.workerId))?.kind === "eligible")
    );
  }
  const queueAhead = new Map<string, number>(busyWorkers.map((b) => [b.workerId, 0]));

  for (const job of jobs) {
    let bestWait = Infinity;
    let bestBusy: BusyWorker | null = null;
    for (const busy of busyWorkers) {
      const pair = pairs.get(pairKey(job.jobId, busy.workerId));
      if (!pair) continue;
      const predicted = predictions.get(pairKey(job.jobId, busy.workerId)) ?? 60;
      const value = waitCost(job, busy, pair, predicted, queueAhead.get(busy.workerId)!);
      if (value < bestWait) {
        bestWait = value;
        bestBusy = busy;
      }
    }
    if (bestBusy === null) continue;

    let runNow = Infinity;
    let finiteBefore = 0;
    for (const worker of workers) {
      const key = pairKey(job.jobId, worker.workerId);
      const pair = pairs.get(key);
      if (!pair) continue;
      const predicted = predictions.get(key) ?? 60;
      const value = cost(job, worker, pair, predicted, tier1.get(job.jobId)!);
      if (!finite(value)) continue;
      finiteBefore += 1;
      runNow = Math.min(runNow, value);
      if (value > bestWait * HOLD_MARGIN_RATIO + HOLD_MARGIN_SECONDS) {
        out.set(key, { kind: HELD_KIND, hasWarnings: pair.hasWarnings, totalFetchBytes: pair.totalFetchBytes });
      }
    }

    const stillRunnable = workers.some((w) => {
      const key = pairKey(job.jobId, w.workerId);
      const pair = out.get(key);
      if (!pair) return false;
      return finite(cost(job, w, pair, predictions.get(key) ?? 60, tier1.get(job.jobId)!));
    });
    if (stillRunnable) continue;
    // Waiting (or: nothing idle could run it anyway). Either way this job
    // is next in line on `bestBusy`, so later jobs must queue behind it.
    const own = predictions.get(pairKey(job.jobId, bestBusy.workerId)) ?? 60;
    queueAhead.set(
      bestBusy.workerId,
      queueAhead.get(bestBusy.workerId)! + own + loadSeconds(job, busyAsWorker(bestBusy))
    );
    if (finiteBefore > 0) {
      holds.push({ jobId: job.jobId, workerId: bestBusy.workerId, waitSeconds: bestWait, runNowSeconds: runNow });
    }
  }
  return { pairs: out, holds };
}

/** Ports `scheduler.build_matrix`. */
export function buildMatrix(
  jobs: JobCandidate[],
  workers: WorkerCandidate[],
  pairs: Map<string, PairVerdict>,
  predictions: Map<string, number>,
  now: Date
): number[][] {
  const tier1 = new Map<string, boolean>();
  for (const job of jobs) {
    tier1.set(
      job.jobId,
      workers.some((w) => pairs.get(pairKey(job.jobId, w.workerId))?.kind === "eligible")
    );
  }

  return jobs.map((job) => {
    const waitSeconds = (now.getTime() - job.createdAt.getTime()) / 1000;
    return workers.map((worker) => {
      const pair = pairs.get(pairKey(job.jobId, worker.workerId));
      if (!pair) return Infinity;
      const predicted = predictions.get(pairKey(job.jobId, worker.workerId)) ?? 60;
      return objective(cost(job, worker, pair, predicted, tier1.get(job.jobId)!), waitSeconds);
    });
  });
}

/**
 * 最小成本配對（Kuhn–Munkres / Hungarian，O(n³)）-- ports `scheduler.solve`
 * 逐行。非有限值（Infinity / -Infinity / NaN）視為禁止並在回傳前剔除；
 * 有限負值完全合法（目標函數刻意是負的）。
 *
 * 值域正規化：有限格平移成 `v - minV`，禁止格與補位格一律填
 * `M = (n + 1) * range + 1`。真實配對的總成本差距最多 `n * range < M`，所以
 * 最小化總成本會先最大化真實配對數、再最小化真實成本。不能用固定哨兵
 * （`ulp(1e18) = 128`）：可行圖有缺口時哨兵級的 delta 會進 potential，把整個
 * 成本模型量化掉。
 *
 * 決定性：挑 `delta` 用嚴格小於，平手時永遠選欄位索引最小的那個，和 Python
 * 版一致。呼叫端要先把 jobs 依 `(createdAt, jobId)`、workers 依
 * `(name, workerId)` 排好，這個保證才有意義。
 */
export function solve(matrix: number[][]): [number, number][] {
  const rowsN = matrix.length;
  const colsN = matrix.reduce((max, row) => Math.max(max, row.length), 0);
  const n = Math.max(rowsN, colsN);
  if (n === 0) return [];

  let minV = Infinity;
  let maxV = -Infinity;
  for (const row of matrix) {
    for (const value of row) {
      if (!finite(value)) continue;
      if (value < minV) minV = value;
      if (value > maxV) maxV = value;
    }
  }
  if (!finite(minV)) return [];
  const valueRange = Math.max(maxV - minV, 1);
  const bigCell = (n + 1) * valueRange + 1;

  // 1-indexed 工作矩陣。
  const a: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let value = bigCell;
      if (i < rowsN && j < matrix[i]!.length) {
        const raw = matrix[i]![j]!;
        if (finite(raw)) value = raw - minV;
      }
      a[i + 1]![j + 1] = value;
    }
  }

  const u = new Array<number>(n + 1).fill(0);
  const v = new Array<number>(n + 1).fill(0);
  const p = new Array<number>(n + 1).fill(0);
  const way = new Array<number>(n + 1).fill(0);

  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array<number>(n + 1).fill(Infinity);
    const used = new Array<boolean>(n + 1).fill(false);
    for (;;) {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity;
      let j1 = 0;
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue;
        const cur = a[i0]![j]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]!] = u[p[j]!]! + delta;
          v[j] = v[j]! - delta;
        } else {
          minv[j] = minv[j]! - delta;
        }
      }
      j0 = j1;
      if (p[j0] === 0) break;
    }
    for (;;) {
      const j1 = way[j0]!;
      p[j0] = p[j1]!;
      j0 = j1;
      if (j0 === 0) break;
    }
  }

  const result: [number, number][] = [];
  for (let j = 1; j <= n; j++) {
    const i = p[j]!;
    if (i === 0) continue;
    const row = i - 1;
    const col = j - 1;
    if (row >= rowsN || col >= colsN || col >= matrix[row]!.length) continue;
    if (!finite(matrix[row]![col]!)) continue;
    result.push([row, col]);
  }
  result.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return result;
}

/** `buildMatrix` + `solve` -- ports `scheduler.match`. */
export function match(
  jobs: JobCandidate[],
  workers: WorkerCandidate[],
  pairs: Map<string, PairVerdict>,
  predictions: Map<string, number>,
  now: Date
): [number, number][] {
  return solve(buildMatrix(jobs, workers, pairs, predictions, now));
}
