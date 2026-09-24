/**
 * Atomic job dispatch, stale-worker requeue, and job status transitions.
 * Ported from the former Python server (2026-09); this file is now the only
 * implementation. Cloud-specific deltas are called out inline.
 *
 * Every function is a pure async function taking a `D1Database` plus
 * whatever data it needs -- no `Date.now()` calls inside this module. Time
 * always arrives as a `now: Date` parameter, exactly like the Python side
 * takes `now: datetime` for `requeue_stale`; the other Python functions
 * call `_utcnow()` internally, so the equivalent here takes `now` too so
 * callers (and tests) control the clock instead of it being implicit.
 */

import * as queries from "../db/queries";
import type { Job, Worker } from "../db/queries";
import { toSqliteTimestamp } from "../db/queries";
import {
  freeVramGb,
  modelFetchProtocolOk,
  needsFromJob,
  verdict,
  MODEL_FETCH_PROTOCOL_REASON,
  type ExclusionSet,
  type FetchableModels,
} from "./assess";
import * as retry from "./retry";
import * as scheduler from "./scheduler";
import * as split from "./split";
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
export const MAX_JOBS_PER_TICK = 64;
export const JOBS_PER_IDLE_WORKER = 8;

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

/** 2026-09-23 cross-backend §3.1 -- ports `dispatch._busy_worker_candidates`：
 * 把正在忙的 worker 變成「可以等」的候選。
 *
 * 剩餘時間 = claim 時寫進 `dispatch_info` 的預估（含 fetch／load）減去已經
 * 跑了多久（`started_at`；還沒開始執行、例如還在下載模型的，算 0）。預估缺
 * 失、或已經超時到 `OVERDUE_FACTOR` 倍的，剩餘時間視為未知 -- 這台就不當
 * 候選，沒有人會為它等。回傳 (候選, workerId -> Worker row)。 */
async function busyWorkerCandidates(
  db: D1Database,
  allWorkers: Worker[],
  busyWorkerIds: string[],
  now: Date
): Promise<{ candidates: scheduler.BusyWorker[]; rows: Map<string, Worker> }> {
  const candidates: scheduler.BusyWorker[] = [];
  const rows = new Map<string, Worker>();
  if (busyWorkerIds.length === 0) return { candidates, rows };
  const byId = new Map(allWorkers.map((w) => [w.id, w] as const));
  const running = await queries.getJobsForWorkersInStatuses(db, busyWorkerIds, ["assigned", "running"]);
  const startedMs = (job: Job): number => (job.startedAt ? new Date(`${job.startedAt}Z`).getTime() : now.getTime());
  const currentByWorker = new Map<string, Job>();
  for (const job of running) {
    if (!job.workerId) continue;
    // 一台 worker 一次只跑一件；有兩筆就取最早開始的那筆當「目前這件」。
    const prev = currentByWorker.get(job.workerId);
    if (!prev || startedMs(job) < startedMs(prev)) currentByWorker.set(job.workerId, job);
  }

  for (const workerId of [...busyWorkerIds].sort()) {
    const worker = byId.get(workerId);
    const job = currentByWorker.get(workerId);
    if (!worker || !job || worker.deleted) continue;
    const info = job.dispatchInfo;
    let predicted = 0;
    for (const key of ["predicted_seconds", "load_seconds", "fetch_seconds"]) {
      const value = info[key];
      if (typeof value === "number") predicted += value || 0;
    }
    const elapsed = job.startedAt ? (now.getTime() - startedMs(job)) / 1000 : 0;
    const eta = scheduler.remainingSeconds(predicted, elapsed);
    if (eta === null) continue;
    candidates.push({
      workerId: worker.id,
      name: worker.name || "",
      backend: worker.backend || "",
      etaSeconds: eta,
      warmModels: [...needsFromJob(job).models].sort(),
      inventory: worker.modelInventory,
    });
    rows.set(worker.id, worker);
  }
  return { candidates, rows };
}

/** Python `json.dumps(dict) == dict` twin for `recordHolds`: key-order
 * insensitive equality of two flat dispatch_info objects. */
function sameDispatchInfo(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  return keysA.every((key, i) => key === keysB[i] && a[key] === b[key]);
}

/** 2026-09-23 cross-backend §3.4 -- ports `dispatch._record_holds`：把 hold
 * 的理由寫進 `jobs.dispatch_info`，console 才能說「在等 POKAI-HOME 做完（預估
 * 6 分後開始）比現在派給 Mac（預估 2 小時）快」。不再 hold 的 job 把舊的
 * held 資訊清掉。只寫有變化的列。 */
async function recordHolds(
  db: D1Database,
  jobs: Job[],
  holds: scheduler.Hold[],
  busyWorkers: scheduler.BusyWorker[]
): Promise<void> {
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  const names = new Map(busyWorkers.map((b) => [b.workerId, b.name] as const));
  const heldByJob = new Map(holds.map((h) => [h.jobId, h] as const));
  for (const job of jobs) {
    const info = job.dispatchInfo;
    const hold = heldByJob.get(job.id);
    let newInfo: Record<string, unknown>;
    if (hold) {
      newInfo = {
        held_for: hold.workerId,
        held_for_name: names.get(hold.workerId) ?? "",
        wait_seconds: round3(hold.waitSeconds),
        run_now_seconds: Number.isFinite(hold.runNowSeconds) ? round3(hold.runNowSeconds) : null,
      };
    } else if ("held_for" in info) {
      newInfo = {};
    } else {
      continue;
    }
    if (!sameDispatchInfo(newInfo, info)) {
      await queries.updateQueuedJobDispatchInfo(db, job.id, JSON.stringify(newInfo));
    }
  }
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
 *
 * 2026-09-23 cross-backend §3：`busyWorkerIds` 是這一刻正在執行 job 的
 * worker（連線狀態 busy/dispatched）。對每件 queued job 另外估「等它做完再
 * 接」要多久（`scheduler.waitCost`）；若明顯比任何 idle worker 立刻做還快，
 * 這件就先 hold 住不派（`scheduler.applyHolds`），下一個 tick 重算。hold 只
 * 相對於「活著、可用、剩餘時間可估」的 busy worker 存在，所以只要還有任何
 * idle 且合格的 worker，job 不會永遠卡住。預設 undefined = 舊行為。
 */
export async function assignJobs(
  db: D1Database,
  idleWorkerIds: string[],
  fetchableModels?: FetchableModels | null,
  peerOnlyModels?: ReadonlySet<string> | null,
  now: Date = new Date(),
  /** 2026-09-19 model_fetch (spec §7): 未驗證來源項目的名字集合，原封不動
   * 透傳給 `verdict` 當 protocol>=5 門檻 -- ports `dispatch.assign_jobs`'s
   * `unverified_models`. 刻意排在 `now` 後面而不是 Python 的參數位置：
   * `now` 是這一棧多出來的可注入時鐘，既有呼叫端都用位置參數傳它，插隊會
   * 悄悄把時鐘餵成集合。 */
  unverifiedModels?: ReadonlySet<string> | null,
  /** 2026-09-19 job-retry §6：`(worker_id, job_id)` 與 `(worker_id, task_key)`
   * 的排除集合（`assess.exclusionKey` 壓成字串），由 `do/hub.ts` 的 dispatch
   * tick 一個 tick 建一次（見 `retry.activeUnsuitable`）。這裡只負責對每一對
   * (job, worker) 把 job 自己的 id／`taskKey` 一起傳給 `assess.verdict`；命中
   * 就是 `ineligible`，於是那一對在 `scheduler.match` 的成本矩陣裡是 ∞，永遠
   * 不會被選中。Ports `dispatch.assign_jobs`'s `exclusions`. */
  exclusions?: ExclusionSet | null,
  /** 2026-09-23 cross-backend §3：正在執行 job 的 worker id（見上）。同樣排在
   * 既有位置參數之後 -- ports `dispatch.assign_jobs`'s `busy_worker_ids`. */
  busyWorkerIds?: string[] | null
): Promise<Assignment[]> {
  if (idleWorkerIds.length === 0) return [];

  // `getWorkersByIds` deliberately does not filter soft-deleted rows (it is
  // also the reports lookup, which must keep resolving them), so dispatch
  // eligibility excludes them here: an admin can delete a worker while its
  // socket is still being torn down, and this tick must not hand it a job.
  // `getAllWorkers` below already filters, so the seeder/feasibility view
  // drops it too. Mirrors the former Python `deleted == False` filters.
  const idleWorkers = (await queries.getWorkersByIds(db, idleWorkerIds)).filter((w) => !w.deleted);
  if (idleWorkers.length === 0) return [];
  idleWorkers.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const allWorkers = await queries.getAllWorkers(db);
  const queuedJobs = await queries.getQueuedJobsForDispatch(db);

  // §3.5：配對之前先決定要不要拆。拆過之後 queued 清單變了（父 job 的
  // `split_count` 現在 > 0，`getQueuedJobsForDispatch` 再也撈不到它；取而代之
  // 的是它的子 job），所以重讀一次 -- 從這裡往下一律用 `jobsForMatching`，
  // 絕不能有任何一處還看著舊的 `queuedJobs`，否則被取代的父 job 會被派工。
  let jobsForMatching = queuedJobs;
  if (await split.createChildrenForTick(db, queuedJobs, idleWorkers, allWorkers, fetchableModels, peerOnlyModels)) {
    jobsForMatching = await queries.getQueuedJobsForDispatch(db);
  }

  const limit = Math.min(MAX_JOBS_PER_TICK, JOBS_PER_IDLE_WORKER * idleWorkers.length);
  const starveCutoffMs = now.getTime() - scheduler.STARVE_SECONDS * 1000;
  const head = jobsForMatching.slice(0, limit);
  const headIds = new Set(head.map((j) => j.id));
  const starved = jobsForMatching
    .slice(limit)
    .filter((j) => new Date(`${j.createdAt}Z`).getTime() <= starveCutoffMs && !headIds.has(j.id));
  // Final-review C1：餓死集合也要封頂（與原 Python 版同步）。未封頂時，
  // 一個塞住超過 `STARVE_SECONDS` 的大佇列會把全部 queued job 丟進 O(n³)
  // 的 Hungarian，在 DO alarm 裡跑。`starved` 已依 `created_at, id` 排序，
  // `slice(0, limit)` 取的就是最舊的那些；剩下的下一個 tick 再排。
  const selectedJobs = [...head, ...starved.slice(0, limit)];
  if (selectedJobs.length === 0) return [];

  const statRows = await stats.loadRows(db);
  // 2026-09-23 §2：沒有任何統計列的 worker 用後端先驗，有列的用學到的值。
  const speedIndex = new Map(
    allWorkers.map((w) => [w.id, stats.effectiveSpeedIndex(statRows, w.id, w.backend || "", w.speedIndex)] as const)
  );

  // §3.1：busy worker 與它們目前那件 job 的剩餘時間。
  const { candidates: busyWorkers, rows: busyRows } = await busyWorkerCandidates(
    db,
    allWorkers,
    busyWorkerIds ?? [],
    now
  );

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
    const jobTaskKey = retry.taskKey(job);
    const isLight = needs.models.size === 0 && !needs.estVramGb;
    jobCandidates.push({
      jobId: job.id,
      signature: job.signature,
      createdAt: new Date(`${job.createdAt}Z`),
      isLight,
      requiredModels: [...needs.models].sort(),
    });

    for (const worker of idleWorkers) {
      let v = verdict(
        worker,
        needs,
        job.requirements,
        allWorkers,
        fetchableModels,
        peerOnlyModels,
        unverifiedModels,
        { jobId: job.id, taskKey: jobTaskKey, exclusions }
      );
      // 2026-09-19 model_fetch (final-review I1): EVERY model_fetch job needs
      // protocol>=5, not just one whose entry happens to be unverified.
      // `verdict` only sees `JobNeeds`, which carries no kind, and its
      // model-keyed gates cannot fire at all for a verified entry (row 4) or
      // for a worker that already holds the model -- so the kind gate is
      // applied here, where the job row is in hand. Ports the same block in
      // the former Python `assign_jobs`.
      if (job.kind === "model_fetch" && !modelFetchProtocolOk(worker)) {
        v = {
          kind: "ineligible",
          reasons: [`${MODEL_FETCH_PROTOCOL_REASON}:${job.id}`],
          missingModels: v.missingModels,
          warnings: [],
        };
      }
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

  // §3.2：對每對 (job, busy worker) 也算 verdict 與預估，供 hold 判斷。
  if (busyWorkers.length > 0) {
    for (const job of selectedJobs) {
      const needs = needsFromJob(job);
      const jobTaskKey = retry.taskKey(job);
      for (const busy of busyWorkers) {
        const workerRow = busyRows.get(busy.workerId)!;
        const v = verdict(workerRow, needs, job.requirements, allWorkers, fetchableModels, peerOnlyModels, unverifiedModels, {
          jobId: job.id,
          taskKey: jobTaskKey,
          exclusions,
        });
        const totalFetchBytes =
          v.kind === "eligible_after_fetch"
            ? v.missingModels.reduce((sum, name) => sum + (fetchableModels?.[name] ?? 0), 0)
            : 0;
        const key = scheduler.pairKey(job.id, busy.workerId);
        pairs.set(key, { kind: v.kind, hasWarnings: v.warnings.length > 0, totalFetchBytes });
        predictions.set(key, stats.predict(statRows, speedIndex, job.signature, busy.workerId).seconds);
      }
    }
  }

  const held = scheduler.applyHolds(jobCandidates, workerCandidates, busyWorkers, pairs, predictions);
  await recordHolds(db, selectedJobs, held.holds, busyWorkers);

  const matched = scheduler.match(jobCandidates, workerCandidates, held.pairs, predictions, now);

  const assignments: Assignment[] = [];
  for (const [jobIndex, workerIndex] of matched) {
    const job = selectedJobs[jobIndex]!;
    const worker = idleWorkers[workerIndex]!;
    const jobCandidate = jobCandidates[jobIndex]!;
    const workerCandidate = workerCandidates[workerIndex]!;
    const key = scheduler.pairKey(job.id, worker.id);
    const pair = held.pairs.get(key)!;

    const candidateCount = idleWorkers.filter((w) => {
      const kind = held.pairs.get(scheduler.pairKey(job.id, w.id))!.kind;
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

    // §3.4：子 job 被 claim 成 `assigned` 的那一刻，父 job 也要跟著從 `queued`
    // 變成 `assigned`。少了這一步，父 job 會一路停在 `queued` 直到第一個子 job
    // 的 busy 心跳把它推成 `running` —— console／面板在「worker 已經在拿圖了」
    // 的整段區間裡顯示的都是錯的狀態，而且 §3.4 表格的
    // `[... assigned] -> assigned` 那一列在正常派工流程上永遠走不到。
    //
    // try/catch 的理由和上面的熱快取一樣：claim 已經 commit 了，讓例外逃出去
    // 會連本 tick 剩下的配對一起丟掉。父 job 的顯示狀態絕不值得賠上一次派工，
    // 而且下一次子 job 轉移時會自己補算回來。
    if (updatedJob.parentId) {
      try {
        await split.childStatusChanged(db, updatedJob.id, now);
      } catch (err) {
        console.warn(`dispatch: childStatusChanged failed for child ${updatedJob.id}`, err);
      }
    }
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
    // Phase 3.3 §3.4：子 job 被 requeue 之後父 job 可能要從 running 退回
    // assigned/queued。requeue 從不產生 failed/cancelled，所以不會串聯取消。
    for (const jobId of jobIds) {
      await split.childStatusChanged(db, jobId, now);
    }
  }
  return requeued;
}

// 2026-09-19 線上實例：部署當下 job 被派給一台 worker，推送落在斷線的舊
// socket 上，agent 重連後一直回報 idle（沒有 job_id），而 `requeueStale`
// 只看 worker 心跳 -- worker 明明在心跳，job 就永遠 `assigned`。連續這麼多
// 次「idle 且沒有 job_id」的心跳（心跳間隔 30s，所以至少隔了一個週期；一次
// 就收會撞上「推送剛送出、agent 的週期心跳還在路上」和「job_done 與 idle
// 心跳前後腳」這兩種正常時序）之後，這台名下仍 assigned/running 的 job 全
// 部收回排隊。Ports the former Python `ORPHAN_IDLE_BEATS`.
export const ORPHAN_IDLE_BEATS = 2;

/** 把 `workerId` 名下仍 assigned/running、但它自己說閒著的 job 收回 `queued`。
 * 欄位變化與 `requeueStale` 完全相同（`requeueJobsForWorker`），不算失敗嘗
 * 試、不發收據、不動 worker 狀態（它在線）。Ports the former Python
 * `requeue_orphaned`. */
export async function requeueOrphaned(db: D1Database, workerId: string, now: Date): Promise<string[]> {
  const jobIds = await queries.requeueJobsForWorker(db, workerId);
  for (const jobId of jobIds) {
    await split.childStatusChanged(db, jobId, now);
  }
  return jobIds;
}

// ---------------------------------------------------------------------------
// cancelJob

/** Move a queued/assigned/running job to `cancelled`, releasing ownership
 * the same way `requeueStale` does (`last_worker_id` recorded,
 * `worker_id` cleared). Returns the worker id that owned the job at the
 * moment of cancellation (null if it was still unowned/queued, or if the
 * job doesn't exist / is already terminal). Ports `dispatch.cancel_job` --
 * see its docstring for why ownership release here matters beyond tidiness.
 *
 * Phase 3.3 §3.6: cancelling a CHILD cancels the whole family -- the parent
 * moves to `cancelled` and the surviving siblings with it (see
 * `split.refreshParent`). `cancelledOwners`, when given, collects
 * `[childId, workerId, startedAtIfRunning]` for each sibling that still had a
 * live owner so the caller can push `job_cancelled` to those workers too (and
 * mint a cancelled receipt for the ones that were really running); the return value
 * stays exactly what it always was (the worker that owned `jobId` itself).
 * Cancelling a PARENT does not cascade from here -- it has no `parentId` --
 * `hub.handleInternalCancel` walks its children explicitly instead. */
export async function cancelJob(
  db: D1Database,
  jobId: string,
  reason: string,
  now: Date,
  cancelledOwners?: split.CascadeCancelled[]
): Promise<string | null> {
  const job = await queries.getJobById(db, jobId);
  if (job === null || !CANCELLABLE_STATUSES.includes(job.status)) return null;

  const owningWorkerId = job.workerId;
  await queries.updateJobCancelled(db, jobId, reason, toSqliteTimestamp(now), owningWorkerId);
  await split.childStatusChanged(db, jobId, now, cancelledOwners);
  return owningWorkerId;
}

// ---------------------------------------------------------------------------
// tryReadopt

/**
 * Restore ownership of a job to `workerId` if it's the worker's own job
 * blipping back (still `queued` AND `last_worker_id === workerId`), not
 * someone else's. Ports `dispatch.try_readopt`; the claim is atomic via
 * `queries.readoptJob`'s single conditional UPDATE.
 *
 * 2026-09-19 job-retry — the THIRD condition, and the reason it exists:
 * before that feature, `status === "queued" AND last_worker_id === W` could
 * only ever be produced by `requeueStale`, i.e. by W actually vanishing for
 * 90 seconds. `requeueForRetry` now produces exactly the same pair
 * deliberately (spec §5 requires `last_worker_id = W`), while W is still
 * connected — so without a guard, a worker could send `job_failed` and then
 * `job_done` for the same job, re-adopt it here, have it marked `done`, mint
 * a BILLABLE receipt for work it just said it could not do, and clear its own
 * unsuitable record. Worse, it could do that after being excluded by
 * `failed_twice_on_job`, bypassing the exclusion entirely. Unlike the stale
 * path, that is a state the worker can manufacture on demand.
 *
 * The discriminator is `(this worker has already failed this job) AND (it
 * never reported starting this time)`:
 *
 *  * `requeueForRetry` ALWAYS runs right after an attempt was counted
 *    (`hub.recordFailedAttempt`), so W is in `attempts`, and it ALWAYS clears
 *    `started_at` — both halves hold on every retry requeue, so the attack is
 *    blocked in every case.
 *  * `requeueStale` writes NEITHER, so an ordinary blip re-adoption is
 *    completely unaffected.
 *
 * `started_at IS NOT NULL` alone would NOT have been a sound test, which is
 * why both halves are needed: `requeueStale` sweeps `assigned` jobs too, and
 * an `assigned` job has no `started_at` (only `markRunning` sets one), so
 * that condition on its own would refuse a legitimate blip from a worker that
 * went quiet before its first busy heartbeat. The only re-adoption this pair
 * gives up is one by a worker that both failed this job before AND never
 * reported starting it this time — which has no result worth trusting anyway,
 * and simply means the job is dispatched again.
 *
 * The check reads the row first because `attempts` is JSON the database
 * cannot filter on; the atomic conditional UPDATE below is unchanged and
 * still settles any race with a concurrent claim.
 */
export async function tryReadopt(db: D1Database, jobId: string, workerId: string): Promise<boolean> {
  const job = await queries.getJobById(db, jobId);
  if (job === null) return false;
  if (job.startedAt === null && retry.hasFailedJob(job.attempts, workerId)) {
    console.info(
      `dispatch: refusing to re-adopt job ${jobId} for worker ${workerId} -- ` +
        "it already failed this job and never reported starting it"
    );
    return false;
  }
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
  // Phase 3.3 §3.4：子 job 動了就重算父 job（不是子 job 的話是 no-op）。
  await split.childStatusChanged(db, jobId, now);
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
  // Phase 3.3 §3.4：最後一個子 job 完成時父 job 才會翻成 done。
  await split.childStatusChanged(db, jobId, now);
  return true;
}

/**
 * 2026-09-19 job-retry §5：非終局失敗 -- 把 `workerId` 的 job 送回佇列。
 * Ports `dispatch.requeue_for_retry`.
 *
 * `markFailed` 的重試孿生：同一道 `resolveOwnedJob` 閘門（一個 worker 永遠只
 * 能轉移它此刻真的擁有、而且還沒終局的 job），但套的是 §5 的 requeue 欄位而
 * 不是 `failed`（見 `queries.updateJobRequeuedForRetry`）。
 *
 * `attempts` 不在這裡動：計次在 `do/hub.ts` 的 `job_failed` 分流裡跟
 * `worker_task_failures` 一起做完，這個函式只負責「怎麼放回佇列」，好讓終局／
 * 非終局兩條路的計次邏輯只有一份。
 *
 * §3.4：子 job 被送回佇列後父 job 要跟著重算（可能從 running 退回
 * assigned/queued）-- 和 `requeueStale` 同一個呼叫，而且因為這條路從不產生
 * `failed`/`cancelled`，兄弟永遠不會被連坐取消。連坐只發生在真的終局的
 * `markFailed` 上。
 */
export async function requeueForRetry(
  db: D1Database,
  jobId: string,
  workerId: string,
  error: string,
  now: Date
): Promise<boolean> {
  const result = await resolveOwnedJob(db, jobId, workerId, OWNED_STATUSES);
  if (!result.ok) return false;
  await queries.updateJobRequeuedForRetry(db, jobId, workerId, error);
  await split.childStatusChanged(db, jobId, now);
  return true;
}

/** Fail an assigned/running job of `workerId`. Returns whether it acted.
 * Ports `dispatch.mark_failed`.
 *
 * Phase 3.3 §3.4/§3.6: failing a CHILD also fails its parent and
 * cascade-cancels the surviving siblings. `cancelledOwners`, when given,
 * collects `[childId, workerId, startedAtIfRunning]` for each sibling that
 * still had a live owner, so the Hub can push `job_cancelled` to those
 * workers. */
export async function markFailed(
  db: D1Database,
  jobId: string,
  workerId: string,
  error: string,
  now: Date,
  cancelledOwners?: split.CascadeCancelled[]
): Promise<boolean> {
  const result = await resolveOwnedJob(db, jobId, workerId, OWNED_STATUSES);
  if (!result.ok) return false;
  await queries.updateJobFailed(db, jobId, error, toSqliteTimestamp(now));
  await split.childStatusChanged(db, jobId, now, cancelledOwners);
  return true;
}
