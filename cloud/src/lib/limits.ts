/**
 * Admin-configurable upload limits and the per-user storage quota. Ported
 * from the former Python server (2026-09) -- same two settings keys, same
 * defaults, same bounds, same error codes, same bilingual messages.
 *
 * * `upload_max_file_mb` (default 50) -- the ceiling for ONE uploaded file,
 *   on every route that accepts user bytes: the panel's
 *   `POST /comfy/api/userdata/<path>` save and its `move` guard, the panel's
 *   `POST /comfy/api/upload/image` staging upload, and the console's
 *   `POST /api/jobs` asset uploads. Before this module that cap was a
 *   hardcoded 5 MB on the userdata routes alone; the other two had none.
 * * `upload_user_quota_gb` (default 5) -- the total one user may keep in
 *   storage: their two personal R2 namespaces, `staging/<uid>/` and
 *   `userdata/<uid>/`, PLUS (2026-09-24) the bytes of their jobs -- outputs
 *   under `artifacts/<job_id>/` and inputs under `job_inputs/<job_id>/`.
 *
 * Both parse DEFENSIVELY (unparseable / out of range / missing -> the
 * default): a `settings` row is hand-editable and must never be able to
 * throw inside an upload route.
 *
 * 2026-09-24 配額納入 job 位元組：成品與輸入以前被明文排除（「那是聯邦做出來
 * 的結果，不是使用者自己留的檔」），但實務上一個帳號的空間大多正是被成品吃
 * 掉的。每次上傳逐張 job 去 list R2 太慢，所以 job 的位元組是 `jobs` 表上的
 * 計數器（`artifact_bytes` / `input_bytes`，migration 0017），由寫入與刪除
 * 成品／輸入的路徑維護，這裡只做一次 `SUM`（`queries.userJobBytes`）。
 * Job bytes are COUNTERS on the jobs table, kept by the artifact/input
 * write and delete paths, not listed from R2 on every upload.
 */

import type { Context } from "hono";
import type { Env } from "../env";
import { getSetting, getUserById, userJobBytes } from "../db/queries";
import { errorJson } from "./guard";
import { stagingPrefix, userdataPrefix } from "./store";

export const UPLOAD_MAX_FILE_MB_KEY = "upload_max_file_mb";
export const UPLOAD_USER_QUOTA_GB_KEY = "upload_user_quota_gb";

export const DEFAULT_UPLOAD_MAX_FILE_MB = 50;
export const DEFAULT_UPLOAD_USER_QUOTA_GB = 5;

export const MIN_UPLOAD_MAX_FILE_MB = 1;
export const MAX_UPLOAD_MAX_FILE_MB = 1024;
export const MIN_UPLOAD_USER_QUOTA_GB = 0.1;
export const MAX_UPLOAD_USER_QUOTA_GB = 1024;

const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;

/** Shared error code for every quota refusal, on both stacks and every route
 * -- nobody should have to learn a different code per upload surface to
 * recognise "you are out of space". */
export const QUOTA_EXCEEDED_CODE = "quota_exceeded";

export interface UploadLimits {
  maxFileMb: number;
  quotaGb: number;
  maxFileBytes: number;
  quotaBytes: number;
}

function limitsOf(maxFileMb: number, quotaGb: number): UploadLimits {
  return {
    maxFileMb,
    quotaGb,
    maxFileBytes: maxFileMb * BYTES_PER_MB,
    quotaBytes: Math.trunc(quotaGb * BYTES_PER_GB),
  };
}

/** `upload_max_file_mb` as an integer in [1, 1024]; the default otherwise. */
export function parseMaxFileMb(raw: unknown): number {
  const value = Number(typeof raw === "string" ? raw.trim() : raw);
  if (!Number.isFinite(value)) return DEFAULT_UPLOAD_MAX_FILE_MB;
  const whole = Math.trunc(value);
  if (whole < MIN_UPLOAD_MAX_FILE_MB || whole > MAX_UPLOAD_MAX_FILE_MB) return DEFAULT_UPLOAD_MAX_FILE_MB;
  return whole;
}

/** `upload_user_quota_gb` as a number in [0.1, 1024]; the default otherwise.
 * Decimals are meaningful (0.5 GB is a sane quota on a small deployment), so
 * unlike the MB cap this one is NOT rounded. */
export function parseUserQuotaGb(raw: unknown): number {
  const value = Number(typeof raw === "string" ? raw.trim() : raw);
  if (!Number.isFinite(value)) return DEFAULT_UPLOAD_USER_QUOTA_GB;
  if (value < MIN_UPLOAD_USER_QUOTA_GB || value > MAX_UPLOAD_USER_QUOTA_GB) return DEFAULT_UPLOAD_USER_QUOTA_GB;
  return value;
}

function overrideInRange(value: number, low: number, high: number): boolean {
  return Number.isFinite(value) && value >= low && value <= high;
}

/** Current limits from the `settings` table, with `uid`'s own overrides
 * (`users.max_file_mb` / `users.quota_gb`, 2026-09-20) laid on top when one
 * is given. Parity: the former Python `read_limits(session, uid)`.
 *
 * An unusable override (out of range, NaN) falls back to the PLATFORM value,
 * not the module default: the admin's global setting is the next-most-specific
 * intent, and a hand-edited `users` row must never silently widen a quota. */
export async function readLimits(db: D1Database, uid?: string): Promise<UploadLimits> {
  const [mb, gb, user] = await Promise.all([
    getSetting(db, UPLOAD_MAX_FILE_MB_KEY),
    getSetting(db, UPLOAD_USER_QUOTA_GB_KEY),
    uid !== undefined ? getUserById(db, uid) : Promise.resolve(null),
  ]);
  let maxFileMb = parseMaxFileMb(mb);
  let quotaGb = parseUserQuotaGb(gb);
  if (user !== null) {
    if (user.maxFileMb !== null && overrideInRange(user.maxFileMb, MIN_UPLOAD_MAX_FILE_MB, MAX_UPLOAD_MAX_FILE_MB)) {
      maxFileMb = Math.trunc(user.maxFileMb);
    }
    if (user.quotaGb !== null && overrideInRange(user.quotaGb, MIN_UPLOAD_USER_QUOTA_GB, MAX_UPLOAD_USER_QUOTA_GB)) {
      quotaGb = user.quotaGb;
    }
  }
  return limitsOf(maxFileMb, quotaGb);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Human-readable size, matching web/src/lib/format.ts's `formatBytes` and
 * the former Python `format_bytes` exactly, so the number quoted in an error reads
 * the same as the console's own usage line. */
export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value === 0) return "0 B";
  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** exponent;
  const rounded = exponent === 0 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded} ${BYTE_UNITS[exponent]}`;
}

export function tooLargeMessage(limits: UploadLimits): string {
  return (
    `檔案超過 ${limits.maxFileMb} MB 單檔上限，無法上傳。` +
    ` / File exceeds the ${limits.maxFileMb} MB per-file upload limit.`
  );
}

export function quotaMessage(usedBytes: number, limits: UploadLimits): string {
  const used = formatBytes(usedBytes);
  const total = formatBytes(limits.quotaBytes);
  return (
    `儲存空間不足（已用 ${used} / 配額 ${total}），請先刪除部分檔案。` +
    ` / Storage quota exceeded (used ${used} of ${total}); delete some files first.`
  );
}

/** Does one file of `size` break the configured per-file cap? The single
 * definition of that comparison, asked by every upload route rather than
 * each spelling out `> mb * 1024 * 1024` itself. */
export function fileCapExceeded(size: number, limits: UploadLimits): boolean {
  return size > limits.maxFileBytes;
}

/** Summed `size` of every object under one R2 prefix.
 *
 * Paginates: `R2Bucket.list` returns at most 1000 keys per page, so a user
 * with more saved files than that would otherwise be undercounted -- and an
 * undercount is a quota that silently stops applying to exactly the accounts
 * it matters most for. Exported so the pagination can be unit-tested against
 * a stub bucket without writing 1000+ real objects.
 */
export async function prefixBytes(store: R2Bucket, prefix: string): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, cursor });
    for (const object of page.objects) total += object.size;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return total;
}

/** The three pieces of one user's usage, and their sum -- what `usageBytes`
 * adds up, broken out so the staging listing and the admin user list can
 * show where the space went. Ports the former Python `usage_breakdown`. */
export interface UsageBreakdown {
  staging: number;
  userdata: number;
  jobs: number;
  total: number;
}

/** `uid`'s usage by namespace: `staging/<uid>/` and `userdata/<uid>/` are
 * listed from R2 (two cheap list calls at trusted-circle scale, paginated by
 * `prefixBytes`); `jobs` is ONE `SUM` over the per-job counters (see the
 * module docstring for why job bytes are counters rather than a listing). */
export async function usageBreakdown(db: D1Database, store: R2Bucket, uid: string): Promise<UsageBreakdown> {
  const [staging, userdata, jobs] = await Promise.all([
    prefixBytes(store, stagingPrefix(uid)),
    prefixBytes(store, userdataPrefix(uid)),
    userJobBytes(db, uid),
  ]);
  return { staging, userdata, jobs, total: staging + userdata + jobs };
}

/** Total bytes `uid` currently keeps: staging + userdata + job bytes
 * (artifacts and inputs, from the jobs-table counters). The single number
 * every quota check compares against. Ports the former Python `usage_bytes`. */
export async function usageBytes(db: D1Database, store: R2Bucket, uid: string): Promise<number> {
  return (await usageBreakdown(db, store, uid)).total;
}

/** The bilingual quota message if this write would not fit, else `null`.
 *
 * `replacingBytes` is the size of the object this write OVERWRITES (0 for a
 * fresh key): those bytes disappear when the write lands, so charging for
 * them would make re-saving an unchanged workflow fail at exactly 100% of
 * quota. */
export async function quotaRejection(
  db: D1Database,
  store: R2Bucket,
  uid: string,
  incomingBytes: number,
  limits: UploadLimits,
  replacingBytes = 0
): Promise<string | null> {
  const used = await usageBytes(db, store, uid);
  const projected = used - Math.min(replacingBytes, used) + incomingBytes;
  return projected > limits.quotaBytes ? quotaMessage(used, limits) : null;
}

/** The 413 to return for this write, or `null` if it may proceed.
 *
 * ONE definition of "is this upload allowed", shared by every route that
 * accepts user bytes (panel userdata save + move, panel staging upload)
 * rather than re-implemented per route: first the per-file cap, then the
 * per-user quota over staging + userdata + job bytes. The twin of
 * the former Python `upload_rejection`.
 *
 * `tooLargeCode` is the only per-route difference -- each surface keeps the
 * error code its own clients already recognise; the quota refusal is
 * `QUOTA_EXCEEDED_CODE` everywhere.
 */
export async function uploadRejection(
  c: Context<{ Bindings: Env }>,
  uid: string,
  incomingBytes: number,
  options: { tooLargeCode: string; replacingBytes?: number; limits?: UploadLimits }
): Promise<Response | null> {
  const limits = options.limits ?? (await readLimits(c.env.DB, uid));
  if (fileCapExceeded(incomingBytes, limits)) {
    return errorJson(c, 413, options.tooLargeCode, tooLargeMessage(limits));
  }
  const over = await quotaRejection(
    c.env.DB,
    c.env.STORE,
    uid,
    incomingBytes,
    limits,
    options.replacingBytes ?? 0
  );
  if (over !== null) return errorJson(c, 413, QUOTA_EXCEEDED_CODE, over);
  return null;
}
