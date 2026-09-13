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
import { freeVramGb, needsFromJob, verdict } from "./assess";

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

/** Lexicographic tuple comparison over comparable primitives (numbers,
 * strings, or 0/1 for booleans) -- the TS stand-in for Python's tuple
 * `.sort()`, used to reproduce `assign_jobs`' ranking keys exactly. */
function compareTuples(a: readonly (number | string)[], b: readonly (number | string)[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i]!;
    const bv = b[i]!;
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return a.length - b.length;
}

/** Rank idle workers per queued job and atomically claim the best pair, one
 * job at a time, oldest job first. Ports `dispatch.assign_jobs` -- see its
 * docstring for the full ranking rationale (clean-beats-warned, then the
 * Phase 1.9 light-job preference for zero-model jobs, then heavy-job
 * biggest-free-VRAM, with worker name / id as deterministic tie-breaks).
 *
 * Each worker is claimed for at most one job per call. The claim itself is
 * atomic via `queries.claimJob`'s `WHERE status = 'queued'` re-check, so a
 * job claimed by a concurrent tick a moment ago is skipped rather than
 * double-assigned.
 */
export async function assignJobs(db: D1Database, idleWorkerIds: string[]): Promise<Assignment[]> {
  if (idleWorkerIds.length === 0) return [];

  const idleWorkers = await queries.getWorkersByIds(db, idleWorkerIds);
  if (idleWorkers.length === 0) return [];
  const workersById = new Map(idleWorkers.map((w) => [w.id, w] as const));

  const allWorkers = await queries.getAllWorkers(db);
  const queuedJobs = await queries.getQueuedJobsOrderedByCreatedAt(db);

  const availableWorkerIds = new Set(workersById.keys());
  const assignments: Assignment[] = [];

  for (const job of queuedJobs) {
    if (availableWorkerIds.size === 0) break;

    const needs = needsFromJob(job);
    const isLight = needs.models.size === 0 && !needs.estVramGb;

    let best: { workerId: string; keys: (number | string)[] } | null = null;
    for (const candidateId of availableWorkerIds) {
      const worker = workersById.get(candidateId);
      if (!worker) continue;
      const v = verdict(worker, needs, job.requirements, allWorkers);
      if (v.kind !== "eligible") continue;

      const hasWarnings = v.warnings.length > 0 ? 1 : 0;
      const keys: (number | string)[] = isLight
        ? [
            hasWarnings,
            // Zero-model work needs no GPU at all: a weak-backend
            // (mps/cpu) worker beats a real GPU, then SMALLEST free VRAM
            // first, so the biggest cards stay free for jobs that need
            // them.
            worker.backend !== "mps" && worker.backend !== "cpu" ? 1 : 0,
            freeVramGb(worker),
            worker.name,
            candidateId,
          ]
        : [
            // Heavy job: clean beats warned, then largest free VRAM first
            // (negated so ascending sort puts it first), then name/id.
            hasWarnings,
            -freeVramGb(worker),
            worker.name,
            candidateId,
          ];

      if (best === null || compareTuples(keys, best.keys) < 0) {
        best = { workerId: candidateId, keys };
      }
    }

    if (best === null) continue;

    const claimed = await queries.claimJob(db, job.id, best.workerId);
    if (!claimed) continue;

    const updatedJob = await queries.getJobById(db, job.id);
    if (!updatedJob) continue; // defensive: cannot happen once claimed
    assignments.push({ workerId: best.workerId, job: updatedJob });
    availableWorkerIds.delete(best.workerId);
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
