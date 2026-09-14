/**
 * `GET /api/reports/contributions` -- parity source:
 * `server/comfyfed_server/receipts.py`, read in full.
 *
 * Aggregates dual-signed job receipts per worker over an optional
 * `from`/`to` date range. Headline `jobs`/`gpu_seconds` stay billable-only
 * (unchanged semantics from before non-billable receipts existed); failed
 * /cancelled receipts still show up in `unbilled_gpu_seconds` and the
 * per-receipt listing, just never in the headline numbers -- see
 * receipts.py's `contributions` docstring/comment, ported verbatim below.
 *
 * Receipt creation and the platform/worker dual-signature flow live in the
 * agent WebSocket (Task 6/7's do/hub.ts); this route only reports on the
 * resulting rows, same division of responsibility as the Python source.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import {
  getReceiptsInRange,
  getUsageRowsInRange,
  getWorkersByIds,
  toSqliteTimestamp,
  type Receipt,
  type UsageJoinRow,
} from "../db/queries";
import { requireAdmin, requireUser, errorJson, SESSION_VAR } from "../lib/guard";

/** Thrown by `parseDateParam` for a value that doesn't parse as ISO-8601 --
 * carries the original (untrimmed) input so the 400 response can quote it
 * back, matching receipts.py's `f"Not a valid ISO-8601 date: {value!r}"`. */
class BadDateError extends Error {
  constructor(public readonly value: string) {
    super(`bad date: ${value}`);
  }
}

/** Approximates Python's `repr()` for a plain string: single-quoted unless
 * the value contains a `'` and no `"`, in which case Python switches to
 * double quotes instead of escaping; a `\` or the chosen quote char inside
 * the value is backslash-escaped either way. `n3` (final review): the
 * previous `` `'${value}'` `` diverged from `{value!r}` (receipts.py:35) for
 * any value containing a quote character -- this query param is
 * user-supplied (`?from=`/`?to=`), so that's reachable, not hypothetical. */
function pyStrRepr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  const escaped = value.replace(/\\/g, "\\\\").replaceAll(quote, `\\${quote}`);
  return `${quote}${escaped}${quote}`;
}

// Accepts a date, or a date+time (space or "T" separated) with optional
// fractional seconds and an optional "Z"/"+HH:MM"/"-HH:MM" offset --
// roughly the subset of ISO-8601 Python's `datetime.fromisoformat` accepts,
// which is what receipts.py's `_parse_date` calls.
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Parses an ISO-8601 `from`/`to` query parameter into a `toSqliteTimestamp`
 * -shaped naive-UTC string, mirroring receipts.py's `_parse_date`: an
 * offset-aware input is converted to UTC and stripped of its offset before
 * comparison, since receipt timestamps are stored naive-UTC and comparing
 * an aware value against them would be meaningless. An unparseable value
 * throws `BadDateError` (the caller turns that into a 400).
 */
function parseDateParam(value: string): string {
  const match = ISO_DATE_RE.exec(value.trim());
  if (!match) throw new BadDateError(value);
  const [, y, mo, d, hh = "00", mi = "00", ss = "00", frac = "", offset] = match;
  const millis = Math.floor(Number(frac.padEnd(3, "0").slice(0, 3)) || 0);
  let epochMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi), Number(ss), millis);
  if (offset && offset !== "Z") {
    const sign = offset[0] === "-" ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    const oh = Number(digits.slice(0, 2));
    const om = Number(digits.slice(2, 4) || "0");
    epochMs -= sign * (oh * 3600_000 + om * 60_000);
  }
  return toSqliteTimestamp(new Date(epochMs));
}

interface ReceiptEntry {
  job_id: string;
  kind: string;
  billable: boolean;
  basis: string;
  gpu_seconds: number;
  acked: boolean;
}

interface WorkerAggregate {
  worker_id: string;
  name: string;
  jobs: number;
  gpu_seconds: number;
  unbilled_gpu_seconds: number;
  receipts: ReceiptEntry[];
}

function aggregate(receipts: Receipt[], names: Map<string, string>): WorkerAggregate[] {
  const byWorker = new Map<string, WorkerAggregate>();

  for (const rec of receipts) {
    let entry = byWorker.get(rec.workerId);
    if (!entry) {
      entry = {
        worker_id: rec.workerId,
        name: names.get(rec.workerId) ?? "",
        jobs: 0,
        gpu_seconds: 0,
        unbilled_gpu_seconds: 0,
        receipts: [],
      };
      byWorker.set(rec.workerId, entry);
    }

    if (rec.billable) {
      entry.jobs += 1;
      entry.gpu_seconds += rec.gpuSeconds;
    } else {
      entry.unbilled_gpu_seconds += rec.gpuSeconds;
    }

    entry.receipts.push({
      job_id: rec.jobId,
      kind: rec.kind,
      billable: rec.billable,
      basis: rec.basis,
      gpu_seconds: rec.gpuSeconds,
      acked: rec.workerSig !== null,
    });
  }

  return [...byWorker.values()];
}

/** Thrown by `parsePoolParam` for a `pool` query param that's missing, not a
 * valid number, or negative -- carries the finished `{code, message}` 400
 * body so the route can hand it straight to `errorJson`. */
class BadPoolError extends Error {
  constructor(message: string) {
    super(message);
  }
}

// Final review finding #10: plain-decimal grammar, applied to the trimmed
// string BEFORE `Number()` ever sees it -- byte-for-byte the same pattern
// as receipts.py's `_POOL_RE`. `Number()` alone accepts forms beyond plain
// decimal notation that `Number.isFinite` cannot catch on their own --
// notably `"0x10"` (hex 16, perfectly finite) -- and Python's `float()`
// separately accepts `"1_0"` (underscore digit-group separator), which this
// same regex also kills so both stacks reject it identically.
const POOL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/** Parses the `pool` query parameter for `/api/reports/payout` -- mirrors
 * receipts.py's `_parse_pool`. Declared as a plain string (Hono's
 * `c.req.query` already gives us that) so a bad value becomes our own
 * `reports.bad_pool` 400, consistent with `parseDateParam`/`reports.bad_date`,
 * rather than a framework validation error. `raw === undefined` (param
 * absent) mirrors FastAPI handing `_parse_pool` a Python `None` -- `None!r`
 * is the bare word `None`, not a quoted string, so that case is special-cased
 * rather than routed through `pyStrRepr`. */
function parsePoolParam(raw: string | undefined): number {
  if (raw === undefined) {
    throw new BadPoolError("Not a valid number: None");
  }
  const trimmed = raw.trim();
  if (!POOL_RE.test(trimmed)) {
    throw new BadPoolError(`Not a valid number: ${pyStrRepr(raw)}`);
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new BadPoolError(`Not a valid number: ${pyStrRepr(raw)}`);
  }
  if (value < 0) {
    throw new BadPoolError("pool must be non-negative");
  }
  return value;
}

interface UsageAggregate {
  user_id: string | null;
  username: string | null;
  jobs: number;
  gpu_seconds: number;
  unbilled_gpu_seconds: number;
}

/** Shared aggregation for `/usage` and `/my-usage` -- mirrors receipts.py's
 * `_usage_rows` grouping step (the join itself lives in
 * `getUsageRowsInRange`). Same billable/unbilled split as `aggregate()`
 * above; a `null` `user_id` (missing job, or job with no `user_id`) groups
 * into a single row rather than being dropped -- `Map` distinguishes a
 * `null` key from every string key, same as Python's dict keyed by
 * `Optional[str]`. Sorted by `gpu_seconds` descending, matching `_usage_rows`'
 * `sorted(..., reverse=True)`. */
function aggregateUsage(rows: UsageJoinRow[]): UsageAggregate[] {
  const byUser = new Map<string | null, UsageAggregate>();

  for (const row of rows) {
    let entry = byUser.get(row.userId);
    if (!entry) {
      entry = {
        user_id: row.userId,
        username: row.username,
        jobs: 0,
        gpu_seconds: 0,
        unbilled_gpu_seconds: 0,
      };
      byUser.set(row.userId, entry);
    }

    if (row.billable) {
      entry.jobs += 1;
      entry.gpu_seconds += row.gpuSeconds;
    } else {
      entry.unbilled_gpu_seconds += row.gpuSeconds;
    }
  }

  return [...byUser.values()].sort((a, b) => b.gpu_seconds - a.gpu_seconds);
}

/** Parses the shared `from`/`to` query params for a request, converting a
 * `BadDateError` into the same `reports.bad_date` 400 body `/contributions`
 * returns. A `Response` result means "already responded" -- callers must
 * check for that (`instanceof Response`) before continuing. */
function parseDateRange(
  c: Context<{ Bindings: Env }>
): { start: string | null; end: string | null } | Response {
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");
  try {
    return {
      start: fromParam ? parseDateParam(fromParam) : null,
      end: toParam ? parseDateParam(toParam) : null,
    };
  } catch (err) {
    if (err instanceof BadDateError) {
      return errorJson(c, 400, "reports.bad_date", `Not a valid ISO-8601 date: ${pyStrRepr(err.value)}`);
    }
    throw err;
  }
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/reports/contributions", requireAdmin, async (c) => {
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");

  let start: string | null = null;
  let end: string | null = null;
  try {
    if (fromParam) start = parseDateParam(fromParam);
    if (toParam) end = parseDateParam(toParam);
  } catch (err) {
    if (err instanceof BadDateError) {
      return errorJson(c, 400, "reports.bad_date", `Not a valid ISO-8601 date: ${pyStrRepr(err.value)}`);
    }
    throw err;
  }

  const receipts = await getReceiptsInRange(c.env.DB, start, end);

  const workerIds = [...new Set(receipts.map((r) => r.workerId))];
  const workers = workerIds.length > 0 ? await getWorkersByIds(c.env.DB, workerIds) : [];
  const names = new Map(workers.map((w) => [w.id, w.name]));

  return c.json(aggregate(receipts, names));
});

/**
 * `GET /api/reports/usage` -- parity source: receipts.py's `usage` route
 * (backed by `_usage_rows`). Admin-only, per-user aggregation of every
 * receipt in the optional `from`/`to` range, joined through `jobs.user_id`
 * to `users.username`; a receipt with no job or a job with no `user_id`
 * aggregates into a single `{user_id: null, username: null}` row instead of
 * being dropped. Sorted by `gpu_seconds` descending.
 */
app.get("/api/reports/usage", requireAdmin, async (c) => {
  const range = parseDateRange(c);
  if (range instanceof Response) return range;

  const rows = await getUsageRowsInRange(c.env.DB, range.start, range.end);
  return c.json(aggregateUsage(rows));
});

/**
 * `GET /api/reports/my-usage` -- parity source: receipts.py's `my_usage`
 * route. Any authenticated user (not admin-only); scoped to the session
 * user's own receipts via `onlyUserId`. Returns a single object rather than
 * a list -- the session user's aggregated row if they have any receipts in
 * range, else a zeroed row with their own `user_id`/`username`, matching
 * `my_usage`'s fallback when `_usage_rows` comes back empty.
 */
app.get("/api/reports/my-usage", requireUser, async (c) => {
  const range = parseDateRange(c);
  if (range instanceof Response) return range;

  const user = c.get(SESSION_VAR).user;
  const rows = await getUsageRowsInRange(c.env.DB, range.start, range.end, user.uid);
  const aggregated = aggregateUsage(rows);
  if (aggregated.length > 0) return c.json(aggregated[0]);

  return c.json({
    user_id: user.uid,
    username: user.username,
    jobs: 0,
    gpu_seconds: 0,
    unbilled_gpu_seconds: 0,
  });
});

/**
 * `GET /api/reports/payout` -- parity source: receipts.py's `payout` route.
 * Admin-only; splits a `pool` amount across workers in proportion to their
 * billable `gpu_seconds` over the optional `from`/`to` range. `pool` is
 * required, must parse as a non-negative number, or this 400s
 * `reports.bad_pool` (see `parsePoolParam`). A zero total (no billable
 * receipts in range) short-circuits to an empty `workers` list rather than
 * dividing by zero, matching `payout`'s `if total_gpu_seconds == 0` branch.
 */
app.get("/api/reports/payout", requireAdmin, async (c) => {
  let poolValue: number;
  try {
    poolValue = parsePoolParam(c.req.query("pool"));
  } catch (err) {
    if (err instanceof BadPoolError) {
      return errorJson(c, 400, "reports.bad_pool", err.message);
    }
    throw err;
  }

  const range = parseDateRange(c);
  if (range instanceof Response) return range;

  const receipts = (await getReceiptsInRange(c.env.DB, range.start, range.end)).filter((r) => r.billable);

  const totals = new Map<string, number>();
  for (const rec of receipts) {
    totals.set(rec.workerId, (totals.get(rec.workerId) ?? 0) + rec.gpuSeconds);
  }

  const totalGpuSeconds = [...totals.values()].reduce((sum, v) => sum + v, 0);
  if (totalGpuSeconds === 0) {
    return c.json({ total_gpu_seconds: 0, pool: poolValue, workers: [] });
  }

  const workerIds = [...totals.keys()];
  const workers = workerIds.length > 0 ? await getWorkersByIds(c.env.DB, workerIds) : [];
  const names = new Map(workers.map((w) => [w.id, w.name]));

  const payoutWorkers = [...totals.entries()]
    .map(([workerId, gpuSeconds]) => ({
      worker_id: workerId,
      name: names.get(workerId) ?? "",
      gpu_seconds: gpuSeconds,
      ratio: gpuSeconds / totalGpuSeconds,
      amount: poolValue * (gpuSeconds / totalGpuSeconds),
    }))
    .sort((a, b) => b.gpu_seconds - a.gpu_seconds);

  return c.json({ total_gpu_seconds: totalGpuSeconds, pool: poolValue, workers: payoutWorkers });
});

export default app;
