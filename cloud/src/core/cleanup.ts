/**
 * Scheduled retention cleanup (the Worker's cron trigger, see index.ts's
 * `scheduled` handler and wrangler.jsonc's `triggers.crons`).
 *
 * Purges data older than `RETENTION_DAYS` (60) to keep D1 and R2 from
 * growing without bound:
 *
 *  * Terminal jobs (`done` / `failed` / `cancelled`) whose
 *    `COALESCE(finished_at, created_at)` is past the cutoff -- the row, its
 *    receipts, and every R2 object under `artifacts/<id>/` and
 *    `job_inputs/<id>/`. Receipts are deleted WITH their job on purpose:
 *    usage reporting (`getUsageRowsInRange`) attributes a receipt through a
 *    LEFT JOIN on jobs, so a receipt that outlived its job would only ever
 *    materialize as an unattributable `{username: null}` row. The 60-day
 *    window is the platform's stated retention for the whole job record.
 *  * A split parent goes only when every one of its children is ALSO past
 *    retention (terminal + old), and then parent and children are deleted
 *    together -- a child row must never outlive its parent (its status
 *    aggregation reads the parent) nor dangle off a deleted one.
 *    Children are never deleted on their own.
 *  * `p2p_upload` receipts older than the cutoff -- they carry `job_id NULL`
 *    (worker-side bandwidth, see migrations/0007), so the job sweep above
 *    never reaches them.
 *  * `worker_task_failures` rows not updated since the cutoff. They stop
 *    gating dispatch after `UNSUITABLE_TTL_DAYS` (7) anyway; past 60 days
 *    they are stale diagnostics, not history worth a table scan.
 *
 * Non-goals, deliberately: `staging/` uploads (a user's working files, not
 * job debris), `userdata/` (saved workflows), `models/` + `model_hashes`
 * (shared cache, re-downloading is the expensive case), `object_info/`
 * (overwritten per worker on every reconnect), `worker_job_stats` (tiny,
 * and the scheduler's only duration memory), and non-terminal jobs of any
 * age -- a queued/assigned/running row is live state, never garbage.
 *
 * Bounded per run: at most `MAX_JOBS_PER_RUN` parent jobs per invocation
 * (children ride along uncounted), so one cron tick stays well inside the
 * Workers CPU budget even after a long backlog; the next tick continues
 * where this one stopped. Oldest first, so a backlog drains in order.
 */
import * as queries from "../db/queries";

export const RETENTION_DAYS = 60;
export const MAX_JOBS_PER_RUN = 200;

/** Statuses the sweep may touch. Everything else is live state. */
const TERMINAL = "('done', 'failed', 'cancelled')";

/** D1's documented bound is 100 bound parameters per statement; chunk id
 * lists well under it. */
const ID_CHUNK = 50;

/** R2's `delete` accepts at most 1000 keys per call. */
const R2_DELETE_CHUNK = 1000;

export interface CleanupResult {
  cutoff: string;
  jobsDeleted: number;
  receiptsDeleted: number;
  objectsDeleted: number;
  taskFailuresDeleted: number;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Every R2 key under `prefix`, following list pagination to the end. */
async function listAllKeys(store: R2Bucket, prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, cursor });
    for (const obj of page.objects) keys.push(obj.key);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return keys;
}

export async function cleanupExpired(
  db: D1Database,
  store: R2Bucket,
  now: Date = new Date()
): Promise<CleanupResult> {
  const cutoff = queries.toSqliteTimestamp(
    new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
  );

  // Expired top-level jobs whose entire split family (if any) is also
  // expired. `COALESCE(finished_at, created_at)` -- a cancelled row always
  // has finished_at (markJobCancelled sets it), but defensively a terminal
  // row missing one ages by creation rather than living forever.
  const { results: parents } = await db
    .prepare(
      `SELECT id FROM jobs j
       WHERE j.parent_id IS NULL
         AND j.status IN ${TERMINAL}
         AND COALESCE(j.finished_at, j.created_at) < ?1
         AND NOT EXISTS (
           SELECT 1 FROM jobs c
           WHERE c.parent_id = j.id
             AND (c.status NOT IN ${TERMINAL}
                  OR COALESCE(c.finished_at, c.created_at) >= ?1)
         )
       ORDER BY COALESCE(j.finished_at, j.created_at), j.id
       LIMIT ?2`
    )
    .bind(cutoff, MAX_JOBS_PER_RUN)
    .all<{ id: string }>();

  const ids: string[] = parents.map((row) => row.id);
  for (const group of chunk(ids, ID_CHUNK)) {
    const marks = group.map(() => "?").join(", ");
    const { results: children } = await db
      .prepare(`SELECT id FROM jobs WHERE parent_id IN (${marks})`)
      .bind(...group)
      .all<{ id: string }>();
    for (const row of children) ids.push(row.id);
  }

  // R2 first, rows second: if a delete batch dies midway, the leftover rows
  // still name their prefixes and the next tick retries the same objects
  // (R2 delete of an already-gone key is a no-op). Rows-first would orphan
  // unreferenced objects forever.
  let objectsDeleted = 0;
  for (const id of ids) {
    const keys = [
      ...(await listAllKeys(store, `artifacts/${id}/`)),
      ...(await listAllKeys(store, `job_inputs/${id}/`)),
    ];
    for (const group of chunk(keys, R2_DELETE_CHUNK)) {
      await store.delete(group);
      objectsDeleted += group.length;
    }
  }

  let receiptsDeleted = 0;
  let jobsDeleted = 0;
  for (const group of chunk(ids, ID_CHUNK)) {
    const marks = group.map(() => "?").join(", ");
    const receipts = await db
      .prepare(`DELETE FROM receipts WHERE job_id IN (${marks})`)
      .bind(...group)
      .run();
    receiptsDeleted += receipts.meta.changes ?? 0;
    const jobs = await db
      .prepare(`DELETE FROM jobs WHERE id IN (${marks})`)
      .bind(...group)
      .run();
    jobsDeleted += jobs.meta.changes ?? 0;
  }

  const p2p = await db
    .prepare("DELETE FROM receipts WHERE kind = 'p2p_upload' AND created_at < ?")
    .bind(cutoff)
    .run();
  receiptsDeleted += p2p.meta.changes ?? 0;

  const failures = await db
    .prepare("DELETE FROM worker_task_failures WHERE updated_at < ?")
    .bind(cutoff)
    .run();

  return {
    cutoff,
    jobsDeleted,
    receiptsDeleted,
    objectsDeleted,
    taskFailuresDeleted: failures.meta.changes ?? 0,
  };
}
