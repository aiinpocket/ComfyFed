/**
 * Atomic job dispatch, stale-worker requeue, and job status transitions.
 * Ported from `server/comfyfed_server/dispatch.py` -- see that module's
 * docstrings for the full rationale behind each function; only
 * cloud-specific deltas are called out here.
 *
 * Every function is a pure async function taking a `D1Database` plus
 * whatever data it needs -- no `Date.now()` calls inside this module. Time
 * always arrives as a `now: Date` parameter, exactly like the Python side
 * takes `now: datetime` for `requeue_stale`; the other Python functions
 * call `_utcnow()` internally, so the equivalent here takes `now` too so
 * callers (and tests) control the clock instead of it being implicit.
 */

import * as queries from "../db/queries";
import type { Job } from "../db/queries";
import { toSqliteTimestamp } from "../db/queries";
import { freeVramGb, needsFromJob, verdict, type FetchableModels } from "./assess";
import * as scheduler from "./scheduler";
import * as stats from "./stats";

const STALE_SECONDS = 90;

/** Statuses a worker is allowed to transition out of by reporting on a job. */
const OWNED_STATUSES: readonly string[] = ["assigned", "running"];

/** Statuses a job never leaves again. */
const TERMINAL_STATUSES: readonly string[] = ["done", "failed", "cancelled"];

/** Statuses `cancelJob` is willing to act on; anything else is a no-op. */
const CANCELLABLE_STATUSES: readonly string[] = ["queued", "assigned", "running"];

export function isTerminal(status: string): boolean {
  return TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// assignJobs

export interface Assignment {
  workerId: string;
  job: Job;
}

/** 一個 tick 最多評估這麼多件 queued job（外加所有已餓死的）。 */
const MAX_JOBS_PER_TICK = 64;
const JOBS_PER_IDLE_WORKER = 8;

function dispatchInfoJson(
  predictedSeconds: number,
  basis: string,
  loadSeconds: number,
  fetchSeconds: number,
  candidates: number
): string {
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  return JSON.stringify({
    predicted_seconds: round3(predictedSeconds),
    basis,
    load_seconds: round3(loadSeconds),
    fetch_seconds: round3(fetchSeconds),
    candidates,
  });
}

/**
 * Phase 3.3 §2.5：整體配對。Ports `dispatch.assign_jobs` -- 見該 docstring 的
 * 完整理由。流程：取 queued job（排除 `split_count > 0` 的父 job，最多
 * `min(64, 8 x idle)` 件外加所有餓死的）-> 每對算 verdict + `stats.predict`
 * -> `scheduler.match` -> 逐一原子 claim 並寫 `dispatch_info` /
 * `warm_models`。
 *
 * 保留的既有語意（見 `scheduler.cost`）：乾淨贏過警告、已經有模型的贏過要
 * 下載的（tier 1 存在時 tier 2 一律 Infinity）、輕工作留大卡。
 *
 * 決定性：jobs 依 `(created_at, id)`（SQL 已排好）、workers 依 `(name, id)`
 * 排序後才進矩陣，Hungarian 平手取最小索引，所以和 Python 端同一組輸入得到
 * 同一個配對。
 */
export async function assignJobs(
  db: D1Database,
  idleWorkerIds: string[],
  fetchableModels?: FetchableModels | null,
  peerOnlyModels?: ReadonlySet<string> | null,
  now: Date = new Date()
): Promise<Assignment[]> {
  if (idleWorkerIds.length === 0) return [];

  // `getWorkersByIds` deliberately does not filter soft-deleted rows (it is
  // also the reports lookup, which must keep resolving them), so dispatch
  // eligibility excludes them here: an admin can delete a worker while its
  // socket is still being torn down, and this tick must not hand it a job.
  // `getAllWorkers` below already filters, so the seeder/feasibility view
  // drops it too. Mirrors dispatch.py's `deleted == False` filters.
  const idleWorkers = (await queries.getWorkersByIds(db, idleWorkerIds)).filter((w) => !w.deleted);
  if (idleWorkers.length === 0) return [];
  idleWorkers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const allWorkers = await queries.getAllWorkers(db);
  const queuedJobs = await queries.getQueuedJobsForDispatch(db);

  const limit = Math.min(MAX_JOBS_PER_TICK, JOBS_PER_IDLE_WORKER * idleWorkers.length);
  const starveCutoffMs = now.getTime() - scheduler.STARVE_SECONDS * 1000;
  const head = queuedJobs.slice(0, limit);
  const headIds = new Set(head.map((j) => j.id));
  const starved = queuedJobs
    .slice(limit)
    .filter((j) => new Date(`${j.createdAt}Z`).getTime() <= starveCutoffMs && !headIds.has(j.id));
  const selectedJobs = [...head, ...starved];
  if (selectedJobs.length === 0) return [];

  const statRows = await stats.loadRows(db);
  const speedIndex = new Map(allWorkers.map((w) => [w.id, w.speedIndex] as const));

  const workerCandidates: scheduler.WorkerCandidate[] = idleWorkers.map((w) => ({
    workerId: w.id,
    name: w.name,
    backend: w.backend,
    freeVramGb: freeVramGb(w),
    warmModels: w.warmModels,
    inventory: w.modelInventory,
  }));

  const jobCandidates: scheduler.JobCandidate[] = [];
  const pairs = new Map<string, scheduler.PairVerdict>();
  const predictions = new Map<string, number>();
  const bases = new Map<string, string>();

  for (const job of selectedJobs) {
    const needs = needsFromJob(job);
    const isLight = needs.models.size === 0 && !needs.estVramGb;
    jobCandidates.push({
      jobId: job.id,
      signature: job.signature,
      createdAt: new Date(`${job.createdAt}Z`),
      isLight,
      requiredModels: [...needs.models].sort(),
    });

    for (const worker of idleWorkers) {
      const v = verdict(worker, needs, job.requirements, allWorkers, fetchableModels, peerOnlyModels);
      const totalFetchBytes =
        v.kind === "eligible_after_fetch"
          ? v.missingModels.reduce((sum, name) => sum + (fetchableModels?.[name] ?? 0), 0)
          : 0;
      const key = scheduler.pairKey(job.id, worker.id);
      pairs.set(key, { kind: v.kind, hasWarnings: v.warnings.length > 0, totalFetchBytes });
      const { seconds, basis } = stats.predict(statRows, speedIndex, job.signature, worker.id);
      predictions.set(key, seconds);
      bases.set(key, basis);
    }
  }

  const matched = scheduler.match(jobCandidates, workerCandidates, pairs, predictions, now);

  const assignments: Assignment[] = [];
  for (const [jobIndex, workerIndex] of matched) {
    const job = selectedJobs[jobIndex]!;
    const worker = idleWorkers[workerIndex]!;
    const jobCandidate = jobCandidates[jobIndex]!;
    const workerCandidate = workerCandidates[workerIndex]!;
    const key = scheduler.pairKey(job.id, worker.id);
    const pair = pairs.get(key)!;

    const candidateCount = idleWorkers.filter((w) => {
      const kind = pairs.get(scheduler.pairKey(job.id, w.id))!.kind;
      return kind === "eligible" || kind === "eligible_after_fetch";
    }).length;

    const info = dispatchInfoJson(
      predictions.get(key)!,
      bases.get(key)!,
      scheduler.loadSeconds(jobCandidate, workerCandidate),
      scheduler.fetchSeconds(pair),
      candidateCount
    );

    const claimed = await queries.claimJob(db, job.id, worker.id, info);
    if (!claimed) continue;

    // §2.2：熱快取在「被指派」當下就成立，不等 job 完成。
    //
    // 包 try/catch 是必要的，不是保險：claim 已經 commit 了（D1 沒有讓我們把
    // 兩個 UPDATE 綁在一個交易裡的 seam，Python 端則是同一個 session 交易，
    // 寫失敗會連 claim 一起 rollback）。這裡讓例外逃出去的話，job 會卡在
    // `assigned` 卻沒有人收到 `job` frame -- 要等 90 秒後的 requeueStale 才
    // 救得回來 -- 而且本 tick 剩下的配對全部一起丟掉。熱快取親和只是最佳化，
    // 絕不值得賠上一次派工。
    try {
      await queries.setWorkerWarmModels(db, worker.id, jobCandidate.requiredModels);
    } catch (err) {
      console.warn(`dispatch: setWorkerWarmModels failed for worker ${worker.id}`, err);
    }

    const updatedJob = await queries.getJobById(db, job.id);
    if (!updatedJob) continue; // defensive: cannot happen once claimed
    assignments.push({ workerId: worker.id, job: updatedJob });
  }

  return assignments;
}

// ---------------------------------------------------------------------------
// requeueStale

/** Requeue assigned/running jobs of workers that haven't checked in for
 * more than 90s (falling back to `created_at` when a worker never
 * heartbeated at all), and mark those workers offline. Returns the ids of
 * jobs actually requeued -- ports `dispatch.requeue_stale`. */
export async function requeueStale(db: D1Database, now: Date): Promise<string[]> {
  const cutoff = new Date(now.getTime() - STALE_SECONDS * 1000);
  const cutoffTimestamp = toSqliteTimestamp(cutoff);

  const staleWorkers = await queries.getStaleWorkers(db, cutoffTimestamp);
  const requeued: string[] = [];
  for (const worker of staleWorkers) {
    const jobIds = await queries.requeueJobsForWorker(db, worker.id);
    requeued.push(...jobIds);
    await queries.markWorkerOffline(db, worker.id);
  }
  return requeued;
}

// ---------------------------------------------------------------------------
// cancelJob

/** Move a queued/assigned/running job to `cancelled`, releasing ownership
 * the same way `requeueStale` does (`last_worker_id` recorded,
 * `worker_id` cleared). Returns the worker id that owned the job at the
 * moment of cancellation (null if it was still unowned/queued, or if the
 * job doesn't exist / is already terminal). Ports `dispatch.cancel_job` --
 * see its docstring for why ownership release here matters beyond tidiness. */
export async function cancelJob(db: D1Database, jobId: string, reason: string, now: Date): Promise<string | null> {
  const job = await queries.getJobById(db, jobId);
  if (job === null || !CANCELLABLE_STATUSES.includes(job.status)) return null;

  const owningWorkerId = job.workerId;
  await queries.updateJobCancelled(db, jobId, reason, toSqliteTimestamp(now), owningWorkerId);
  return owningWorkerId;
}

// ---------------------------------------------------------------------------
// tryReadopt

/** Restore ownership of a job to `workerId` if it's the worker's own job
 * blipping back (still `queued` AND `last_worker_id === workerId`), not
 * someone else's. Ports `dispatch.try_readopt`; the claim is atomic via
 * `queries.readoptJob`'s single conditional UPDATE. */
export async function tryReadopt(db: D1Database, jobId: string, workerId: string): Promise<boolean> {
  return queries.readoptJob(db, jobId, workerId);
}

// ---------------------------------------------------------------------------
// Owned-job gate

/**
 * Reasons `resolveOwnedJob` can refuse a worker-driven status transition.
 * This is the pure-data twin of `dispatch._owned_job`'s WARNING/DEBUG log
 * split, deliberately without any logging: `_owned_job`'s job is to decide
 * whether a transition is allowed and *why not*, while deciding how loudly
 * to complain about a refusal (rate limiting, log levels) is connection
 * plumbing that belongs to the Hub Durable Object (Task 6), not this pure
 * module.
 *
 *  - "unknown_job": no job with this id exists (Python: WARNING).
 *  - "not_owner_forgery": owned by someone else right now, and this worker
 *    never owned it or didn't lose it to a terminal transition -- the
 *    genuinely-suspicious case (Python: WARNING).
 *  - "not_owner_stale_terminal": owned by someone else now, but this worker
 *    used to own it and it ended (cancelled) since -- a stale message from
 *    a worker that hasn't caught up yet, not forgery (Python: DEBUG).
 *  - "wrong_status_terminal": this worker still owns it, but it already
 *    finished -- re-transitioning a terminal job is always wrong (Python:
 *    WARNING).
 *  - "wrong_status_transient": this worker owns it, but it isn't in one of
 *    the statuses the caller wanted (e.g. a repeat heartbeat) -- normal
 *    steady state (Python: DEBUG).
 */
export type OwnedJobRefusal =
  | "unknown_job"
  | "not_owner_forgery"
  | "not_owner_stale_terminal"
  | "wrong_status_terminal"
  | "wrong_status_transient";

export type OwnedJobResult = { ok: true; job: Job } | { ok: false; reason: OwnedJobRefusal };

/** Fetch `jobId` only if `workerId` currently owns it in one of `statuses`.
 * Ports `dispatch._owned_job`'s ownership/status gate (not its logging --
 * see `OwnedJobRefusal`). */
export async function resolveOwnedJob(
  db: D1Database,
  jobId: string | null | undefined,
  workerId: string,
  statuses: readonly string[]
): Promise<OwnedJobResult> {
  if (!jobId) return { ok: false, reason: "unknown_job" };

  const job = await queries.getJobById(db, jobId);
  if (job === null) return { ok: false, reason: "unknown_job" };

  if (job.workerId !== workerId) {
    const wasOursAndIsOver = job.lastWorkerId === workerId && isTerminal(job.status);
    return { ok: false, reason: wasOursAndIsOver ? "not_owner_stale_terminal" : "not_owner_forgery" };
  }

  if (!statuses.includes(job.status)) {
    return { ok: false, reason: isTerminal(job.status) ? "wrong_status_terminal" : "wrong_status_transient" };
  }

  return { ok: true, job };
}

// ---------------------------------------------------------------------------
// mark* transitions

/** Move an assigned job of `workerId` to running. Returns whether it acted.
 * Ports `dispatch.mark_running` (metrics observation is the caller's job in
 * the cloud port -- Task 6/12 -- this module stays metrics-free). */
export async function markRunning(db: D1Database, jobId: string, workerId: string, now: Date): Promise<boolean> {
  const result = await resolveOwnedJob(db, jobId, workerId, ["assigned"]);
  if (!result.ok) return false;
  await queries.updateJobRunning(db, jobId, toSqliteTimestamp(now));
  return true;
}

/** Complete an assigned/running job of `workerId`. Returns whether it
 * acted. Ports `dispatch.mark_done`. */
export async function markDone(
  db: D1Database,
  jobId: string,
  workerId: string,
  resultFiles: unknown[],
  now: Date
): Promise<boolean> {
  const result = await resolveOwnedJob(db, jobId, workerId, OWNED_STATUSES);
  if (!result.ok) return false;
  await queries.updateJobDone(db, jobId, resultFiles, toSqliteTimestamp(now));
  return true;
}

/** Fail an assigned/running job of `workerId`. Returns whether it acted.
 * Ports `dispatch.mark_failed`. */
export async function markFailed(
  db: D1Database,
  jobId: string,
  workerId: string,
  error: string,
  now: Date
): Promise<boolean> {
  const result = await resolveOwnedJob(db, jobId, workerId, OWNED_STATUSES);
  if (!result.ok) return false;
  await queries.updateJobFailed(db, jobId, error, toSqliteTimestamp(now));
  return true;
}
