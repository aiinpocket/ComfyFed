/**
 * `GET /metrics` -- Prometheus text exposition, parity source:
 * `server/comfyfed_server/metrics.py` (metric names/help/type/buckets) +
 * `app.py`'s `/metrics` route (the `metrics_public` gate). Hand-rendered
 * (0.0.4 text format) rather than pulling in a Prometheus client dep --
 * see progress.md's pre-flight ruling ("metrics ported as Prometheus text
 * (cheap), not dropped").
 *
 * Python's `Metrics` is a per-process object mutated incrementally from
 * call sites scattered across agentws.py/dispatch.py (worker connect/
 * disconnect, job dispatch/done/failed, heartbeat dynamic payloads) and
 * read back at scrape time via `generate_latest(registry)`. A Cloudflare
 * Worker has no equivalent long-lived process to accumulate that state in
 * between requests, so every metric here is instead recomputed straight
 * from D1 on each scrape -- the same pattern Python's own
 * `_QueuedJobsCollector` already uses for `comfyfed_jobs_queued` (a custom
 * collector that queries fresh every scrape rather than being updated
 * incrementally), just applied uniformly:
 *
 *  - `comfyfed_worker_up` / `_free_{vram,ram,disk}_gb`: read straight off
 *    the current `workers` row (status, `dynamic` JSON) instead of the
 *    connect/heartbeat event that would have `.set()` it in Python. Concretely
 *    more complete than Python's version too: Python only has a sample for
 *    a worker that has gone through at least one connect/heartbeat or
 *    stale-eviction event (lazy per-label creation), so a worker that has
 *    never connected has no `worker_up` sample at all; ours reports every
 *    registered worker's current state on every scrape.
 *  - `comfyfed_job_wait_seconds` / `_run_seconds`: Python observes one
 *    sample per job transition (`mark_running` / `mark_done` /
 *    `mark_failed` in dispatch.py) into a process-lifetime histogram. We
 *    reconstruct the same distribution by recomputing
 *    `started_at - created_at` / `finished_at - started_at` for every job
 *    row that has reached that point, on every scrape -- a full-history
 *    histogram rather than a since-last-restart one, but bucketed
 *    identically (see `_JOB_WAIT_BUCKETS`/`_JOB_RUN_BUCKETS`, copied
 *    verbatim from metrics.py).
 *  - `comfyfed_ws_reconnects_total`: NOT reconstructable from D1 -- the
 *    schema has no column recording reconnect counts anywhere (only the
 *    live event exists in Python, `agentws.py`'s handshake handler calling
 *    `.labels(worker=...).inc()`). Rendered as HELP/TYPE only, with no
 *    sample lines. That degrades to the same shape Python's own output has
 *    for a freshly-`init()`'d registry before any worker has ever
 *    reconnected (a labelled Counter with no `.labels()` calls yet emits
 *    nothing) -- not a fabricated value, just the honest "no data" case.
 *    A durable per-worker reconnect counter would need Hub DO storage
 *    (do/hub.ts), which is out of this task's scope (Task 12 = reports.ts
 *    + metrics.ts only).
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { getAllWorkers, getAllJobsOrderedByCreatedAt, getSetting, sqliteTimestampToEpochMs } from "../db/queries";
import { readSession, errorJson } from "../lib/guard";
import { MESSAGES } from "../core/auth";

const METRICS_PUBLIC_KEY = "metrics_public";

// Copied verbatim from metrics.py's `_JOB_WAIT_BUCKETS`/`_JOB_RUN_BUCKETS`.
const JOB_WAIT_BUCKETS = [1, 5, 15, 60, 300, 900, 3600];
const JOB_RUN_BUCKETS = [5, 30, 60, 180, 600, 1800, 3600, 7200];

function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');
}

function formatLabels(labels: Record<string, string>): string {
  const keys = Object.keys(labels);
  if (keys.length === 0) return "";
  return `{${keys.map((k) => `${k}="${escapeLabelValue(labels[k]!)}"`).join(",")}}`;
}

/** Renders a number the way prometheus_client's text formatter does: plain
 * decimal, no exponent notation, no trailing ".0" stripped (bucket bounds
 * below are formatted separately since Python renders those as floats). */
function formatValue(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return String(n);
}

/** Bucket bounds are declared as ints in metrics.py but prometheus_client
 * stores/renders Histogram bucket bounds as floats (e.g. `le="300.0"`). */
function formatBucketBound(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n);
}

interface Sample {
  labels?: Record<string, string>;
  value: number;
}

function renderGauge(name: string, help: string, samples: Sample[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} gauge`];
  for (const s of samples) {
    lines.push(`${name}${formatLabels(s.labels ?? {})} ${formatValue(s.value)}`);
  }
  return lines.join("\n");
}

function renderHistogram(name: string, help: string, bucketBounds: number[], values: number[]): string {
  const lines = [`# HELP ${name} ${help}`, `# TYPE ${name} histogram`];
  let cumulative = 0;
  const sorted = [...values].sort((a, b) => a - b);
  for (const bound of bucketBounds) {
    cumulative = sorted.filter((v) => v <= bound).length;
    lines.push(`${name}_bucket{le="${formatBucketBound(bound)}"} ${cumulative}`);
  }
  lines.push(`${name}_bucket{le="+Inf"} ${values.length}`);
  const sum = values.reduce((a, b) => a + b, 0);
  lines.push(`${name}_sum ${formatValue(sum)}`);
  lines.push(`${name}_count ${values.length}`);
  return lines.join("\n");
}

/** HELP/TYPE only, no samples -- see the module docstring's
 * `comfyfed_ws_reconnects_total` explanation. */
function renderEmptyCounter(name: string, help: string): string {
  return [`# HELP ${name} ${help}`, `# TYPE ${name} counter`].join("\n");
}

function numericDynamicField(dynamic: Record<string, unknown>, key: string): number | null {
  const raw = dynamic[key];
  if (raw === undefined || raw === null) return null;
  const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(value) ? value : null;
}

async function renderMetrics(env: Env): Promise<string> {
  const workers = await getAllWorkers(env.DB);
  const jobs = await getAllJobsOrderedByCreatedAt(env.DB);

  const workerUpSamples: Sample[] = workers.map((w) => ({
    labels: { worker: w.name },
    value: w.status === "online" || w.status === "busy" ? 1 : 0,
  }));

  const dynamicSamples = (key: string): Sample[] => {
    const out: Sample[] = [];
    for (const w of workers) {
      const value = numericDynamicField(w.dynamic, key);
      if (value !== null) out.push({ labels: { worker: w.name }, value });
    }
    return out;
  };

  const waitSeconds: number[] = [];
  const runSeconds: number[] = [];
  for (const job of jobs) {
    if (job.startedAt) {
      waitSeconds.push(
        Math.max(0, (sqliteTimestampToEpochMs(job.startedAt) - sqliteTimestampToEpochMs(job.createdAt)) / 1000)
      );
    }
    if (job.finishedAt && job.startedAt) {
      runSeconds.push(
        Math.max(0, (sqliteTimestampToEpochMs(job.finishedAt) - sqliteTimestampToEpochMs(job.startedAt)) / 1000)
      );
    }
  }

  const queuedCount = jobs.filter((j) => j.status === "queued").length;

  const blocks = [
    renderGauge("comfyfed_worker_up", "1 if the worker is connected (online/busy), 0 if offline.", workerUpSamples),
    renderGauge(
      "comfyfed_worker_free_vram_gb",
      "Free VRAM in GB, from the worker's last heartbeat.",
      dynamicSamples("free_vram_gb")
    ),
    renderGauge(
      "comfyfed_worker_free_ram_gb",
      "Free system RAM in GB, from the worker's last heartbeat.",
      dynamicSamples("free_ram_gb")
    ),
    renderGauge(
      "comfyfed_worker_free_disk_gb",
      "Free disk space in GB, from the worker's last heartbeat.",
      dynamicSamples("free_disk_gb")
    ),
    renderHistogram(
      "comfyfed_job_wait_seconds",
      "Seconds a job waited in queue before it started running.",
      JOB_WAIT_BUCKETS,
      waitSeconds
    ),
    renderHistogram(
      "comfyfed_job_run_seconds",
      "Seconds a job spent running, from start to done/failed.",
      JOB_RUN_BUCKETS,
      runSeconds
    ),
    renderEmptyCounter(
      "comfyfed_ws_reconnects_total",
      "Count of successful agent WebSocket handshakes, per worker."
    ),
    renderGauge("comfyfed_jobs_queued", "Number of jobs currently queued.", [{ value: queuedCount }]),
  ];

  return blocks.join("\n") + "\n";
}

/** Whether GET /metrics should be reachable without admin auth -- mirrors
 * metrics.py's `is_public`: defaults to true (public) when the
 * `metrics_public` setting row is unset, stored as the strings
 * 'true'/'false' like other boolean settings. */
async function isPublic(db: D1Database): Promise<boolean> {
  const value = await getSetting(db, METRICS_PUBLIC_KEY);
  if (value === null) return true;
  return value !== "false";
}

const app = new Hono<{ Bindings: Env }>();

app.get("/metrics", async (c) => {
  if (!(await isPublic(c.env.DB))) {
    const payload = await readSession(c);
    if (!payload || !payload.authenticated) {
      return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
    }
  }

  const body = await renderMetrics(c.env);
  // Matches Python's `CONTENT_TYPE_LATEST` from prometheus_client.
  return c.text(body, 200, { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" });
});

export default app;
