/**
 * 2026-09-19 job-retry：失敗計次、門檻判定、終局訊息彙整與不適任紀錄。
 * 自原 Python 伺服器移植（2026-09）；本檔現為唯一實作。
 *
 * 模組分兩層，和 `core/stats.ts` 同一個形狀：上半是完全不碰 D1 的純函式
 * （計次、門檻、`taskKey`、訊息彙整）；下半是薄薄的 `worker_task_failures`
 * adapter（upsert／清除／TTL 查詢）。
 *
 * 設計見 `docs/superpowers/specs/2026-09-19-job-retry-unsuitable-worker-design.md`。
 * 一句話：worker 回報 `job_failed` 不再是終局 -- 同一台對同一張 job 失敗
 * `MAX_FAILURES_PER_WORKER_PER_JOB` 次就對那張 job 出局，job 回 `queued` 等
 * 別台（包含現在離線／暫停、之後才上線、甚至還得先下載模型的）；累積到
 * `MAX_JOB_ATTEMPTS` 次、或全艦隊沒有任何一台有可能跑它，才真的終局失敗。
 *
 * 時間一律由呼叫端以 `now: Date` 傳進來（和 `core/dispatch.ts` 同一個約定），
 * 這個模組自己從不呼叫 `Date.now()`。
 */

import { exclusionKey, type ExclusionSet } from "./assess";
import type { Job } from "../db/queries";
import { sqliteTimestampToEpochMs, sqliteTimestampToIsoformat, toSqliteTimestamp } from "../db/queries";

/** 同一台 worker 對同一張 job 失敗這麼多次 -> 這張 job 不再派給它。 */
export const MAX_FAILURES_PER_WORKER_PER_JOB = 2;
/** 一張 job 所有 worker 加總的失敗次數上限；到了就終局失敗。 */
export const MAX_JOB_ATTEMPTS = 6;
/** (worker, task_key) 累積這麼多次失敗 -> 這台對這「類」任務算不適任。 */
export const UNSUITABLE_THRESHOLD = 2;
/** 不適任紀錄的有效期；過期的列不刪，只是查詢時不再生效。 */
export const UNSUITABLE_TTL_DAYS = 7;
/** 2026-09-19 線上實例：兩筆 9/14 之後再也沒上線的舊註冊（rtx5080-main／
 * rtx5080-fresh）讓 `anyPossibleWorker` 一直回 true，一張兩台在線 worker 都
 * 跑掛的 job 就永遠 queued 等它們。超過這麼多天沒有心跳（從未心跳就看
 * created_at）的 worker 不再算「有可能」跑得動任何 job。 */
export const POSSIBLE_WORKER_STALE_DAYS = 7;

/** 這台 worker 是否已經太久沒露面，不該再被當成「有可能」的候選。基準 =
 * `last_seen`，從未心跳過就退回 `created_at`（和 `dispatch.requeueStale` 的
 * `COALESCE(last_seen, created_at)` 同一個定義）。兩者都缺視為不 stale --
 * 寧可多等一輪，不要因為一個空欄位把 job 判死。Ports the former Python
 * `is_stale_worker`. */
export function isStaleWorker(worker: { lastSeen: string | null; createdAt: string | null }, now: Date): boolean {
  const reference = worker.lastSeen || worker.createdAt;
  if (!reference) return false;
  return sqliteTimestampToEpochMs(reference) < now.getTime() - POSSIBLE_WORKER_STALE_DAYS * 86_400_000;
}

/** 排除理由字串（console 的 assessment 面板直接顯示，兩棧逐字相同）。
 * `core/assess.ts` 刻意另外重寫一份同樣的字面值 -- 見那裡的註解。 */
export const FAILED_TWICE_REASON = "failed_twice_on_job";
export const UNSUITABLE_REASON_PREFIX = "unsuitable:";
/** `unsuitable:<task_key 前 N 字>` -- 簽章是 16 字雜湊（Python 端是 64 字），
 * 前 12 字已足以辨識，全寫進理由字串沒有可讀性。 */
export const UNSUITABLE_KEY_CHARS = 12;

/** 終局訊息裡每台 worker 的錯誤截這麼長；`worker_task_failures.last_error`
 * 存得長一點（下面的 500），因為它是給管理員診斷用的，不是給 job 列表顯示
 * 的。 */
export const FINAL_ERROR_CHARS = 200;
export const LAST_ERROR_CHARS = 500;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Python 的 `s[:n]` 切的是 code point，JS 的 `String.slice` 切的是 UTF-16
 * code unit -- 對 ASCII 與 BMP 內的中文兩者相同，對 astral（emoji 之類）會
 * 把一個字元劈成兩半且長度算法不同。錯誤訊息裡什麼都可能出現，所以一律走
 * code point，讓兩棧的截斷結果逐字相同。 */
function sliceChars(value: string, count: number): string {
  return [...value].slice(0, count).join("");
}

// --- 純函式層 --------------------------------------------------------------

/** 一筆 `jobs.attempts` 的內容：這台在這張 job 上的失敗次數，加上它在這張
 * job 上的最後一個錯誤（舊形狀的列沒有，是 null）。 */
interface AttemptEntry {
  failures: number;
  lastError: string | null;
}

/** `jobs.attempts` 的防禦式解析，回 `Map<worker_id, {failures, lastError}>`。
 * Ports `retry._attempt_entries`.
 *
 * 欄位內容是 `{worker_id: {"failures": n, "last_error": str}}` -- per-job 的
 * 計數**跟**那台在這張 job 上的最後一個錯誤。錯誤存在 job 自己身上而不是跨
 * job 累計的 `worker_task_failures`，是因為終局訊息會被寫進這張 job 的
 * `error` 給這張 job 的擁有者看：引用別張 job（可能是別人的）的錯誤字串既誤
 * 導診斷，錯誤訊息又常含檔名與路徑，那是一條很細的跨使用者外洩路徑。
 *
 * 寬容兩種寫法：舊形狀的純數字（`{worker_id: n}`，這個功能第一版的欄位內容，
 * 也就是 migration 0012 之後、這個跟進之前寫下的列）照樣讀得出次數，只是沒有
 * 錯誤字串可引。壞掉的 JSON、不是物件、值不是非負整數的，一律當「沒有那一
 * 筆」-- `job_failed` 是唯一能把 job 從 `running` 推走的路徑，一列壞資料在這
 * 裡丟例外會讓那張 job 永遠卡住。
 *
 * 回 `Map` 而不是普通物件，是為了讓列舉順序完全等於 JSON 的書寫順序（Python
 * 的 `dict` 天生如此；JS 的普通物件會把整數式的 key 提前，雖然 worker id 是
 * uuid 不會踩到，但終局訊息的 worker 順序不值得賭在這個前提上）。 */
function attemptEntries(attemptsJson: string | null | undefined): Map<string, AttemptEntry> {
  const result = new Map<string, AttemptEntry>();
  let value: unknown;
  try {
    value = JSON.parse(attemptsJson || "{}");
  } catch {
    return result;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return result;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    // JSON 的 key 一定是字串，所以 Python 的 `isinstance(key, str)` 這裡不需要。
    let count: unknown;
    let error: string | null = null;
    if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
      const envelope = entry as Record<string, unknown>;
      count = envelope.failures;
      error = typeof envelope.last_error === "string" ? envelope.last_error : null;
    } else {
      // 舊形狀：值就是次數本身。
      count = entry;
    }
    // 擋掉字串／浮點數／負數（Python 另外擋 bool，JS 的 `typeof true ===
    // "boolean"` 已經被 `typeof count !== "number"` 擋掉）。
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) continue;
    result.set(key, { failures: count, lastError: error });
  }
  return result;
}

/** `{worker_id: failures}` -- 排除判定與 API 一直以來的形狀。
 * Ports `retry.attempts_dict`. */
export function attemptsDict(attemptsJson: string | null | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const [key, entry] of attemptEntries(attemptsJson)) result[key] = entry.failures;
  return result;
}

/** `{worker_id: last_error}`，只含真的有存到錯誤字串的那幾台。
 *
 * 終局彙整訊息的唯一來源（見 `attemptEntries`），也是 `/api/jobs*` 的
 * `attempt_errors` 欄。Ports `retry.attempt_errors`. */
export function attemptErrors(attemptsJson: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of attemptEntries(attemptsJson)) {
    if (entry.lastError !== null) result[key] = entry.lastError;
  }
  return result;
}

/** `workerId` 對這張 job 再失敗一次，順手記下它這一次的錯誤。
 *
 * 回 `[newJson, thisWorkerFailures, total]`：新的 JSON 字串（直接寫回
 * `jobs.attempts`）、這台 worker 現在的失敗次數、以及所有 worker 的總失敗次數
 * （拿去和 `MAX_JOB_ATTEMPTS` 比）。Ports `retry.bump_attempts`.
 *
 * 錯誤存進去之前先截 `FINAL_ERROR_CHARS` 字：它最後會進終局彙整訊息，而那個
 * 訊息會進 `jobs.error`，一段 CUDA traceback 可以有好幾 KB。不傳 `error`
 * （或傳 null）就只加一次計數，保留舊的錯誤字串。
 *
 * JSON 的空白和 Python 的 `json.dumps` 不同（`{"w1":{"failures":1}}` vs
 * `{"w1": {"failures": 1}}`），這是刻意不對齊的：這個字串只會被自己這一棧
 * 寫、被 `attemptEntries` 讀回來，從來不跨棧逐位元比對。 */
export function bumpAttempts(
  attemptsJson: string | null | undefined,
  workerId: string,
  error?: string | null
): [newJson: string, mine: number, total: number] {
  const entries = attemptEntries(attemptsJson);
  const previous = entries.get(workerId);
  const storedError =
    error === undefined || error === null ? (previous?.lastError ?? null) : sliceChars(error, FINAL_ERROR_CHARS);
  entries.set(workerId, { failures: (previous?.failures ?? 0) + 1, lastError: storedError });

  const payload: Record<string, { failures: number; last_error?: string }> = {};
  let total = 0;
  for (const [key, entry] of entries) {
    payload[key] = entry.lastError !== null ? { failures: entry.failures, last_error: entry.lastError } : { failures: entry.failures };
    total += entry.failures;
  }
  return [JSON.stringify(payload), entries.get(workerId)!.failures, total];
}

/** 這台 worker 對這張 job 是不是已經出局（失敗達 `MAX_FAILURES_...`）。
 * Ports `retry.is_excluded_for_job`. */
export function isExcludedForJob(attemptsJson: string | null | undefined, workerId: string): boolean {
  return (attemptsDict(attemptsJson)[workerId] ?? 0) >= MAX_FAILURES_PER_WORKER_PER_JOB;
}

/** 這台 worker 對這張 job 失敗過嗎（哪怕只有一次）？
 * Ports `retry.has_failed_job`.
 *
 * `dispatch.tryReadopt` 的守衛：門檻是 1，不是
 * `MAX_FAILURES_PER_WORKER_PER_JOB` -- 「斷線了又回來」的信任窗口不該給一台
 * 已經親口說過「這張我跑失敗了」的 worker。見那邊的說明。 */
export function hasFailedJob(attemptsJson: string | null | undefined, workerId: string): boolean {
  return attemptEntries(attemptsJson).has(workerId);
}

/** `unsuitable:<task_key 前 12 字>` -- 兩棧逐字相同的排除理由字串。
 * Ports `retry.unsuitable_reason`. */
export function unsuitableReason(key: string | null | undefined): string {
  return `${UNSUITABLE_REASON_PREFIX}${sliceChars(key || "", UNSUITABLE_KEY_CHARS)}`;
}

/** 終局失敗時寫進 `jobs.error` 的彙整訊息。
 *
 * `pairs` 是 `[worker 顯示名, 那台的最後一個錯誤]` 的清單，`total` 是
 * 總嘗試次數。zh-TW 先、en 後（平台其他雙語訊息的慣例），每台的錯誤截
 * `FINAL_ERROR_CHARS` 字 -- 一段 CUDA traceback 可以有好幾 KB，六台份塞進一個
 * job 列會讓 console 的 job 列表整個爛掉。訊息逐位元對齊
 * `retry.summarize_final_error`（含全形分號與全形冒號）。 */
export function summarizeFinalError(pairs: [name: string, error: string][], total: number): string {
  const n = pairs.length;
  const detail = pairs
    .map(([name, error]) => `${name}: ${sliceChars(error || "", FINAL_ERROR_CHARS)}`)
    .join("；");
  return `已在 ${n} 台 worker 嘗試 ${total} 次全部失敗 / failed on ${n} workers after ${total} attempts：${detail}`;
}

/** 這張 job 屬於哪一「類」任務 -- 不適任紀錄的分類鍵。Ports `retry.task_key`.
 *
 * 1. `job.signature`（`assess.signature` 算的工作指紋：工作流結構＋需求）非空
 *    就是它；
 * 2. 否則 `kind === "model_fetch"` 的下載單用 `model_fetch:<模型名>`；
 * 3. 都沒有（舊的、沒補簽章的 job）-> null，代表「不分類、不記錄」。這條 job
 *    照樣重試，只是不會留下跨 job 的不適任紀錄。 */
export function taskKey(job: Pick<Job, "signature" | "kind" | "fetchEntry">): string | null {
  if (job.signature) return job.signature;
  if ((job.kind || "prompt") !== "model_fetch") return null;

  let entry: unknown;
  try {
    entry = JSON.parse(job.fetchEntry || "{}");
  } catch {
    return null;
  }
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
  const name = (entry as Record<string, unknown>).name;
  if (typeof name !== "string" || !name) return null;
  return `model_fetch:${name}`;
}

// --- D1 adapter 層 ----------------------------------------------------------

/** 一列 `worker_task_failures`，`GET /api/workers` 的 `unsuitable` 陣列形狀
 * （`active` 由 `isActive` 算，不是欄位）。 */
export interface UnsuitableRow {
  task_key: string;
  failures: number;
  last_error: string | null;
  last_job_id: string | null;
  updated_at: string | null;
  active: boolean;
}

interface FailureRow {
  worker_id: string;
  task_key: string;
  failures: number;
  last_error: string | null;
  last_job_id: string | null;
  updated_at: string | null;
}

/** `worker_task_failures[workerId, key].failures += 1`（不存在就建）。
 *
 * `key` 為 null 是合法的 no-op：`taskKey` 分不出類別的 job（舊的、沒簽章的）
 * 照樣重試，只是不留跨 job 的紀錄。Ports `retry.record_failure` -- Python 端
 * 刻意不自己 commit（由呼叫端連同 `jobs.attempts` 一起 commit），D1 沒有跨
 * 語句交易的 seam，所以這裡是獨立一句；呼叫端（`do/hub.ts` 的
 * `recordFailedAttempt`）緊接著寫 `jobs.attempts`。 */
export async function recordFailure(
  db: D1Database,
  workerId: string,
  key: string | null,
  error: string | null,
  jobId: string | null,
  now: Date
): Promise<void> {
  if (!key) return;
  const truncated = sliceChars(error || "", LAST_ERROR_CHARS);
  await db
    .prepare(
      `INSERT INTO worker_task_failures (worker_id, task_key, failures, last_error, last_job_id, updated_at)
       VALUES (?, ?, 1, ?, ?, ?)
       ON CONFLICT(worker_id, task_key) DO UPDATE SET
         failures = worker_task_failures.failures + 1,
         last_error = excluded.last_error,
         last_job_id = excluded.last_job_id,
         updated_at = excluded.updated_at`
    )
    .bind(workerId, key, truncated, jobId, toSqliteTimestamp(now))
    .run();
}

/** 成功跑完同類任務 -> 刪掉那一列（自動解除不適任）。Ports
 * `retry.clear_failure`. */
export async function clearFailure(db: D1Database, workerId: string, key: string | null): Promise<void> {
  if (!key) return;
  await db
    .prepare("DELETE FROM worker_task_failures WHERE worker_id = ? AND task_key = ?")
    .bind(workerId, key)
    .run();
}

/** 只清一個 `(worker, task_key)`，回傳刪了幾列（0 或 1）-- `DELETE
 * /api/workers/{id}/unsuitable/{task_key}` 的冪等回應用它。 */
export async function clearOneFailure(db: D1Database, workerId: string, key: string): Promise<number> {
  const result = await db
    .prepare("DELETE FROM worker_task_failures WHERE worker_id = ? AND task_key = ?")
    .bind(workerId, key)
    .run();
  return result.meta.changes ?? 0;
}

/** 清掉這台 worker 的全部不適任紀錄，回傳刪了幾列。Ports
 * `retry.clear_worker_failures`. */
export async function clearWorkerFailures(db: D1Database, workerId: string): Promise<number> {
  const result = await db
    .prepare("DELETE FROM worker_task_failures WHERE worker_id = ?")
    .bind(workerId)
    .run();
  return result.meta.changes ?? 0;
}

/** 達門檻、且 `updated_at` 還在 TTL 內 -- ports `retry._is_active`。
 * `updated_at` 是 null（理論上不會有，欄位 NOT NULL）就當過期：無法證明它還
 * 新鮮的紀錄不該拿來擋派工。 */
function isActive(row: FailureRow, now: Date): boolean {
  if ((row.failures || 0) < UNSUITABLE_THRESHOLD) return false;
  if (!row.updated_at) return false;
  // `toSqliteTimestamp` 的字串是零填補的固定寬度 UTC，字典序＝時間序，所以
  // 直接比字串就等價於比 datetime（既有的 `getStaleWorkers` 也是這樣比的）。
  return row.updated_at >= toSqliteTimestamp(new Date(now.getTime() - UNSUITABLE_TTL_DAYS * MS_PER_DAY));
}

/** 現在生效中的 `(worker_id, task_key)` 排除集合（`exclusionKey` 壓成字串）。
 *
 * 一個 dispatch tick 只查一次，整批傳給 `assess.verdict`（見
 * `dispatch.assignJobs` 的 `exclusions`）。過期的列留著不刪 -- 它是管理員診斷
 * 「這台過去在這類任務上翻過車」的歷史，只是不再擋派工。
 *
 * 門檻與 TTL 兩個條件都下在 SQL 裡（final review Minor 3）：這張表只增不
 * 減，而 tick 每 5 秒有活可派就查一次，整表撈回來再用 JS 濾等於讓成本跟著
 * 「歷史」長。`updated_at IS NULL` 的列在 SQL 三值邏輯裡不滿足 `>=`，自然
 * 被濾掉 -- 和 `isActive` 一樣把無法證明新鮮的紀錄當過期。字串比較等價於
 * 時間比較的理由見 `isActive`。Ports `retry.active_unsuitable`. */
export async function activeUnsuitable(db: D1Database, now: Date): Promise<Set<string>> {
  const cutoff = toSqliteTimestamp(new Date(now.getTime() - UNSUITABLE_TTL_DAYS * MS_PER_DAY));
  const { results } = await db
    .prepare(
      "SELECT worker_id, task_key FROM worker_task_failures WHERE failures >= ? AND updated_at >= ?"
    )
    .bind(UNSUITABLE_THRESHOLD, cutoff)
    .all<Pick<FailureRow, "worker_id" | "task_key">>();
  const pairs = new Set<string>();
  for (const row of results) {
    pairs.add(exclusionKey(row.worker_id, row.task_key));
  }
  return pairs;
}

/** `GET /api/workers` 每台 worker 的 `unsuitable` 陣列。
 *
 * 門檻未達／TTL 已過的列照樣列出來，只是 `active: false`（console 畫成灰字）
 * -- 管理員要看得到「這台失敗過一次」和「這台上個月不適任過」，那是決定要不要
 * 手動清除的依據。
 *
 * `includePrivate === false` 時 `last_error` 與 `last_job_id` 一律回 null
 * （final review I1）：`worker_task_failures` 是**跨 job、跨使用者**累積的，
 * 那兩欄一個是別人 job 的 id、一個是最多 500 字的失敗原文（常含檔名、模型
 * 名稱與絕對路徑）。jobs 本身是 owner-or-admin 才看得到（`isOwnerOrAdmin`，
 * 連存在與否都藏），這條 API 不能從側門漏同樣的東西給任何登入使用者。參數
 * 刻意沒有預設值：新的呼叫端必須明講自己是哪一種讀者。Ports
 * `retry.unsuitable_rows_for_worker`. */
export async function unsuitableRowsForWorker(
  db: D1Database,
  workerId: string,
  now: Date,
  includePrivate: boolean
): Promise<UnsuitableRow[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM worker_task_failures WHERE worker_id = ? ORDER BY updated_at DESC, task_key ASC"
    )
    .bind(workerId)
    .all<FailureRow>();
  return results.map((row) => ({
    task_key: row.task_key,
    failures: row.failures || 0,
    last_error: includePrivate ? row.last_error : null,
    last_job_id: includePrivate ? row.last_job_id : null,
    updated_at: row.updated_at ? sqliteTimestampToIsoformat(row.updated_at) : null,
    active: isActive(row, now),
  }));
}

/** 這張 job 自己的 `attempts` 裡已達門檻的 `(worker, job_id)` 對，加進
 * `pairs`。dispatch tick 與 `anyPossibleWorker` 共用同一份定義。 */
export function addJobAttemptExclusions(
  pairs: Set<string>,
  jobId: string,
  attemptsJson: string | null | undefined
): void {
  for (const [candidateId, failures] of Object.entries(attemptsDict(attemptsJson))) {
    if (failures >= MAX_FAILURES_PER_WORKER_PER_JOB) pairs.add(exclusionKey(candidateId, jobId));
  }
}

export type { ExclusionSet };
