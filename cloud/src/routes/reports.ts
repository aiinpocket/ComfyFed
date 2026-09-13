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

import { Hono } from "hono";
import type { Env } from "../env";
import { getReceiptsInRange, getWorkersByIds, toSqliteTimestamp, type Receipt } from "../db/queries";
import { requireAdmin, errorJson } from "../lib/guard";

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

export default app;
