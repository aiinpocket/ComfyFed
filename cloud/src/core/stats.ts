/**
 * Phase 3.3 §2.2-§2.4 / §2.6: 每台 worker 跑每種工作有多快。
 * Parity source: `server/comfyfed_server/stats.py` -- 上半是純函數（逐行對
 * 照），下半是薄薄的 D1 adapter。統計壞掉絕不能影響 job_done 主流程與收據
 * （spec §5），所以每個 adapter 都自己吞例外。
 */

import * as queries from "../db/queries";
import { toSqliteTimestamp } from "../db/queries";
import { extract, signature as computeSignature } from "./assess";

export const EWMA_ALPHA = 0.3;
export const SPEED_MIN = 0.1;
export const SPEED_MAX = 10.0;
export const DEFAULT_PREDICTED_SECONDS = 60.0;

export const BACKFILL_LIMIT = 500;
export const BACKFILL_SETTING_KEY = "stats_backfilled";

export type Basis = "signature" | "speed_index" | "fleet_default" | "none";

export interface StatRow {
  workerId: string;
  signature: string;
  ewmaSeconds: number;
  samples: number;
}

export function isValidExecSeconds(execSeconds: unknown): execSeconds is number {
  return typeof execSeconds === "number" && Number.isFinite(execSeconds) && execSeconds >= 0;
}

// --- 純函數層 --------------------------------------------------------------

/** 偶數個取中間兩個的平均，空的回 null -- ports `stats.median`. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const mid = Math.floor(ordered.length / 2);
  if (ordered.length % 2 === 1) return ordered[mid]!;
  return (ordered[mid - 1]! + ordered[mid]!) / 2;
}

/** §2.3 的 R(sig) -- ports `stats.fleet_reference`. */
export function fleetReference(
  rows: StatRow[],
  speedIndex: Map<string, number>,
  signature: string,
  excludeWorkerId: string | null
): number | null {
  const values = rows
    .filter((r) => r.signature === signature && r.workerId !== excludeWorkerId)
    .map((r) => r.ewmaSeconds * (speedIndex.get(r.workerId) ?? 1.0));
  return median(values);
}

/** Ports `stats.next_ewma`. */
export function nextEwma(previous: number | null, execSeconds: number): number {
  if (previous === null) return execSeconds;
  return EWMA_ALPHA * execSeconds + (1 - EWMA_ALPHA) * previous;
}

/** Ports `stats.next_speed_index` -- 沒有參考值或 exec<=0 一律維持原值。 */
export function nextSpeedIndex(current: number, reference: number | null, execSeconds: number): number {
  if (reference === null || execSeconds <= 0) return current;
  const ratio = reference / execSeconds;
  const blended = EWMA_ALPHA * ratio + (1 - EWMA_ALPHA) * current;
  return Math.max(SPEED_MIN, Math.min(SPEED_MAX, blended));
}

/** §2.4 的四階梯 -- ports `stats.predict`. */
export function predict(
  rows: StatRow[],
  speedIndex: Map<string, number>,
  signature: string | null,
  workerId: string
): { seconds: number; basis: Basis } {
  let ownSpeed = speedIndex.get(workerId) ?? 1.0;
  if (!(ownSpeed > 0)) ownSpeed = 1.0;

  if (signature) {
    for (const row of rows) {
      if (row.workerId === workerId && row.signature === signature) {
        return { seconds: row.ewmaSeconds, basis: "signature" };
      }
    }
    const reference = fleetReference(rows, speedIndex, signature, workerId);
    if (reference !== null) return { seconds: reference / ownSpeed, basis: "speed_index" };
  }

  const fleetMedian = median(rows.map((r) => r.ewmaSeconds));
  if (fleetMedian !== null) return { seconds: fleetMedian / ownSpeed, basis: "fleet_default" };

  return { seconds: DEFAULT_PREDICTED_SECONDS, basis: "none" };
}

// --- D1 adapter 層 ---------------------------------------------------------

export async function loadRows(db: D1Database): Promise<StatRow[]> {
  try {
    const { results } = await db
      .prepare("SELECT worker_id, signature, ewma_seconds, samples FROM worker_job_stats")
      .all<{ worker_id: string; signature: string; ewma_seconds: number; samples: number }>();
    return results.map((r) => ({
      workerId: r.worker_id,
      signature: r.signature,
      ewmaSeconds: r.ewma_seconds,
      samples: r.samples,
    }));
  } catch (err) {
    console.error("stats: loadRows failed", err);
    return [];
  }
}

export async function loadSpeedIndex(db: D1Database): Promise<Map<string, number>> {
  try {
    const { results } = await db
      .prepare("SELECT id, speed_index FROM workers")
      .all<{ id: string; speed_index: number }>();
    return new Map(results.map((r) => [r.id, typeof r.speed_index === "number" ? r.speed_index : 1.0]));
  } catch (err) {
    console.error("stats: loadSpeedIndex failed", err);
    return new Map();
  }
}

/** §2.3 -- ports `stats.record_completion`. */
export async function recordCompletion(
  db: D1Database,
  workerId: string,
  signature: string | null,
  execSeconds: number | null,
  now: Date
): Promise<void> {
  if (!signature || !isValidExecSeconds(execSeconds)) return;

  try {
    const rows = await loadRows(db);
    const speedIndex = await loadSpeedIndex(db);

    const existing = rows.find((r) => r.workerId === workerId && r.signature === signature) ?? null;
    const ewma = nextEwma(existing ? existing.ewmaSeconds : null, execSeconds);
    const samples = (existing?.samples ?? 0) + 1;

    await db
      .prepare(
        `INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (worker_id, signature) DO UPDATE SET
           ewma_seconds = excluded.ewma_seconds,
           samples = excluded.samples,
           updated_at = excluded.updated_at`
      )
      .bind(workerId, signature, ewma, samples, toSqliteTimestamp(now))
      .run();

    // 參考值算在 EWMA 更新「之前」的快照（`rows`）上，且排除自己 -- 否則這
    // 一筆會同時當觀測值和參考值，自我校正成 1.0。
    const reference = fleetReference(rows, speedIndex, signature, workerId);
    const current = speedIndex.get(workerId) ?? 1.0;
    const updated = nextSpeedIndex(current, reference, execSeconds);
    if (updated !== current) {
      await db.prepare("UPDATE workers SET speed_index = ? WHERE id = ?").bind(updated, workerId).run();
    }
  } catch (err) {
    console.error(`stats: recordCompletion failed for worker ${workerId} signature ${signature}`, err);
  }
}

/** §2.6 -- ports `stats.backfill_if_needed`；在 Hub DO 第一次 tick 時呼叫。
 *
 * Final-review I3：舊版本在迴圈裡逐筆呼叫 `recordCompletion`，每一筆都重讀
 * 一整張 `worker_job_stats` 加一整張 `workers`，再寫回去 -- 500 筆就是 500
 * 次全表讀 + 1000 次寫，全在 DO alarm 裡。現在改成：讀一次、在記憶體裡用
 * 同一組純函數（`nextEwma` / `nextSpeedIndex` / `fleetReference`）依序重放，
 * 最後一次 `db.batch` 把結果寫出去。重放的順序、快照時點（參考值算在
 * EWMA 更新「之前」的快照上、且排除自己）跟 `recordCompletion` 逐行一致，
 * 所以 N 筆回填的結果等於 N 次順序 `recordCompletion`。
 *
 * 旗標只在寫入成功之後才設；這裡不再吞例外，讓它丟回 `hub.ts`，
 * 那邊會把 per-instance 的 `statsBackfillDone` 留在 false，下一個 tick 再試。 */
export async function backfillIfNeeded(db: D1Database): Promise<boolean> {
  if ((await queries.getSetting(db, BACKFILL_SETTING_KEY)) === "1") return false;

  const any = await db.prepare("SELECT 1 AS present FROM worker_job_stats LIMIT 1").first<{ present: number }>();
  if (any) {
    await queries.setSetting(db, BACKFILL_SETTING_KEY, "1");
    return false;
  }

  const { results } = await db
    .prepare(
      `SELECT r.worker_id AS worker_id, r.gpu_seconds AS gpu_seconds, r.created_at AS created_at,
              j.id AS job_id, j.signature AS signature, j.workflow_json AS workflow_json
       FROM receipts r JOIN jobs j ON j.id = r.job_id
       WHERE r.kind = 'completed' AND r.billable = 1
       ORDER BY r.created_at DESC
       LIMIT ?`
    )
    .bind(BACKFILL_LIMIT)
    .all<{
      worker_id: string;
      gpu_seconds: number;
      created_at: string;
      job_id: string;
      signature: string | null;
      workflow_json: string;
    }>();

  const replay = [...results].reverse(); // 依 created_at 由舊到新

  // 讀一次，全程在記憶體裡演進。`worker_job_stats` 這時一定是空的
  // （上面的 `any` 檢查已經提前返回），還是照讀一次保持與
  // `recordCompletion` 同形。
  const rowsMap = new Map<string, StatRow & { updatedAt: Date }>();
  const speedIndex = await loadSpeedIndex(db);
  // `loadSpeedIndex` 只列真實存在的 worker。收據裡的 worker 已被刪除時，
  // `recordCompletion` 算出來的 UPDATE 是空轉（沒有那一列），而且下一筆重讀
  // 時也拿不到它 -- 所以這裡也只把已知 worker 的新值寫回記憶體地圖。
  const knownWorkers = new Set(speedIndex.keys());
  const signatureWrites = new Map<string, string>();
  const speedWrites = new Map<string, number>();

  for (const row of replay) {
    let signature = row.signature;
    if (!signature) {
      let workflow: unknown;
      try {
        workflow = JSON.parse(row.workflow_json || "{}");
      } catch {
        continue;
      }
      if (typeof workflow !== "object" || workflow === null) continue;
      const wf = workflow as Record<string, unknown>;
      signature = await computeSignature(wf, extract(wf));
      signatureWrites.set(row.job_id, signature);
    }
    // `gpu_seconds` 是回填唯一能拿到的執行秒數代理值（收據沒存原始
    // exec_seconds；它本身就是 min(exec_seconds, wall)）。
    const execSeconds = row.gpu_seconds;
    // `recordCompletion` 的兩道前置閘門，一字不漏地搬過來。
    if (!signature || !isValidExecSeconds(execSeconds)) continue;

    const snapshot = [...rowsMap.values()];
    const key = `${row.worker_id} ${signature}`;
    const existing = rowsMap.get(key) ?? null;
    rowsMap.set(key, {
      workerId: row.worker_id,
      signature,
      ewmaSeconds: nextEwma(existing ? existing.ewmaSeconds : null, execSeconds),
      samples: (existing?.samples ?? 0) + 1,
      updatedAt: new Date(`${row.created_at}Z`),
    });

    // 參考值算在 EWMA 更新「之前」的快照上，且排除自己。
    const reference = fleetReference(snapshot, speedIndex, signature, row.worker_id);
    const current = speedIndex.get(row.worker_id) ?? 1.0;
    const updated = nextSpeedIndex(current, reference, execSeconds);
    if (updated !== current) {
      if (knownWorkers.has(row.worker_id)) speedIndex.set(row.worker_id, updated);
      speedWrites.set(row.worker_id, updated);
    }
  }

  const statements: D1PreparedStatement[] = [];
  for (const [jobId, sig] of signatureWrites) {
    statements.push(db.prepare("UPDATE jobs SET signature = ? WHERE id = ?").bind(sig, jobId));
  }
  for (const row of rowsMap.values()) {
    statements.push(
      db
        .prepare(
          `INSERT INTO worker_job_stats (worker_id, signature, ewma_seconds, samples, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (worker_id, signature) DO UPDATE SET
             ewma_seconds = excluded.ewma_seconds,
             samples = excluded.samples,
             updated_at = excluded.updated_at`
        )
        .bind(row.workerId, row.signature, row.ewmaSeconds, row.samples, toSqliteTimestamp(row.updatedAt))
    );
  }
  for (const [workerId, value] of speedWrites) {
    statements.push(db.prepare("UPDATE workers SET speed_index = ? WHERE id = ?").bind(value, workerId));
  }
  // 上限：最多 BACKFILL_LIMIT(500) 筆簽章補寫 + 500 列統計 + 機隊台數的
  // speed_index，實務上是幾百條序列。
  if (statements.length > 0) await db.batch(statements);

  // 旗標只在寫入成功之後才設。
  await queries.setSetting(db, BACKFILL_SETTING_KEY, "1");
  return true;
}
