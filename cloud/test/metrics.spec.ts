import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp } from "../src/db/queries";

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM jobs").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function adminSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function insertWorker(
  id: string,
  name: string,
  status: string,
  dynamic: Record<string, unknown> = {}
): Promise<void> {
  await db()
    .prepare("INSERT INTO workers (id, name, pubkey, status, created_at, dynamic) VALUES (?, ?, 'pk', ?, ?, ?)")
    .bind(id, name, status, toSqliteTimestamp(new Date()), JSON.stringify(dynamic))
    .run();
}

async function insertJob(opts: {
  id: string;
  status?: string;
  createdAt: string;
  startedAt?: string | null;
  finishedAt?: string | null;
}): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, created_at, started_at, finished_at)
       VALUES (?, '{}', ?, ?, ?, ?)`
    )
    .bind(opts.id, opts.status ?? "queued", opts.createdAt, opts.startedAt ?? null, opts.finishedAt ?? null)
    .run();
}

const ALL_METRIC_NAMES = [
  "comfyfed_worker_up",
  "comfyfed_worker_free_vram_gb",
  "comfyfed_worker_free_ram_gb",
  "comfyfed_worker_free_disk_gb",
  "comfyfed_job_wait_seconds",
  "comfyfed_job_run_seconds",
  "comfyfed_ws_reconnects_total",
  "comfyfed_jobs_queued",
];

describe("GET /metrics", () => {
  it("is public by default (no metrics_public row)", async () => {
    const r = await call("/metrics", { method: "GET" });
    expect(r.status).toBe(200);
    expect(typeof r.body).toBe("string");
  });

  it("401s when metrics_public is set to false and there's no session", async () => {
    await db().prepare("INSERT INTO settings (key, value) VALUES ('metrics_public', 'false')").run();
    const r = await call("/metrics", { method: "GET" });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("200s when metrics_public is false but an admin session is present", async () => {
    await db().prepare("INSERT INTO settings (key, value) VALUES ('metrics_public', 'false')").run();
    const { cookie } = await adminSession();
    const r = await call("/metrics", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(typeof r.body).toBe("string");
  });

  it("401s for a plain user-role session when metrics_public is false (final review finding #2)", async () => {
    await db().prepare("INSERT INTO settings (key, value) VALUES ('metrics_public', 'false')").run();
    const admin = await adminSession();
    const password = "a-long-enough-password1";
    await call("/api/users", {
      json: { username: "alice", role: "user", password },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    const login = await call("/api/auth/login", { json: { username: "alice", password } });
    const r = await call("/metrics", { method: "GET", cookie: login.setCookie });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("serves Prometheus 0.0.4 text content-type", async () => {
    const request = new Request("http://example.com/metrics");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/plain; version=0.0.4; charset=utf-8");
  });

  it("contains every metric name with HELP/TYPE lines", async () => {
    const r = await call("/metrics", { method: "GET" });
    expect(r.status).toBe(200);
    const text = r.body as string;
    for (const name of ALL_METRIC_NAMES) {
      expect(text).toContain(`# HELP ${name} `);
      expect(text).toContain(`# TYPE ${name} `);
    }
    // The unreconstructable counter renders header-only (no data points) --
    // see metrics.ts's docstring. Only the HELP/TYPE comment lines mention
    // it; there is no bare sample line (name followed by a numeric value).
    expect(text).not.toMatch(/^comfyfed_ws_reconnects_total[{ ]/m);
  });

  it("reports worker_up and dynamic gauges from D1 worker rows", async () => {
    await insertWorker("w1", "alpha", "online", { free_vram_gb: 12.5, free_ram_gb: 8 });
    await insertWorker("w2", "beta", "offline", {});
    const r = await call("/metrics", { method: "GET" });
    const text = r.body as string;
    expect(text).toContain('comfyfed_worker_up{worker="alpha"} 1');
    expect(text).toContain('comfyfed_worker_up{worker="beta"} 0');
    expect(text).toContain('comfyfed_worker_free_vram_gb{worker="alpha"} 12.5');
    expect(text).toContain('comfyfed_worker_free_ram_gb{worker="alpha"} 8');
    // beta reported no dynamic fields -- gauge left unset (no sample), not zeroed.
    expect(text.includes('comfyfed_worker_free_vram_gb{worker="beta"}')).toBe(false);
  });

  it("computes the queued-jobs gauge fresh from D1", async () => {
    await insertJob({ id: "j1", status: "queued", createdAt: toSqliteTimestamp(new Date()) });
    await insertJob({ id: "j2", status: "queued", createdAt: toSqliteTimestamp(new Date()) });
    await insertJob({ id: "j3", status: "done", createdAt: toSqliteTimestamp(new Date()) });
    const r = await call("/metrics", { method: "GET" });
    const text = r.body as string;
    expect(text).toContain("comfyfed_jobs_queued 2");
  });

  it("buckets job wait/run seconds from job timestamps (value sanity check)", async () => {
    const base = Date.UTC(2025, 0, 1, 0, 0, 0);
    const created = toSqliteTimestamp(new Date(base));
    const started = toSqliteTimestamp(new Date(base + 10_000)); // 10s wait
    const finished = toSqliteTimestamp(new Date(base + 10_000 + 40_000)); // 40s run
    await insertJob({ id: "j1", status: "done", createdAt: created, startedAt: started, finishedAt: finished });

    const r = await call("/metrics", { method: "GET" });
    const text = r.body as string;

    // wait=10s falls in buckets le=15,60,300,900,3600,+Inf (buckets: 1,5,15,60,300,900,3600)
    expect(text).toContain('comfyfed_job_wait_seconds_bucket{le="1.0"} 0');
    expect(text).toContain('comfyfed_job_wait_seconds_bucket{le="5.0"} 0');
    expect(text).toContain('comfyfed_job_wait_seconds_bucket{le="15.0"} 1');
    expect(text).toContain('comfyfed_job_wait_seconds_bucket{le="+Inf"} 1');
    expect(text).toContain("comfyfed_job_wait_seconds_sum 10");
    expect(text).toContain("comfyfed_job_wait_seconds_count 1");

    // run=40s falls in buckets le=60,180,... (buckets: 5,30,60,180,600,1800,3600,7200)
    expect(text).toContain('comfyfed_job_run_seconds_bucket{le="5.0"} 0');
    expect(text).toContain('comfyfed_job_run_seconds_bucket{le="30.0"} 0');
    expect(text).toContain('comfyfed_job_run_seconds_bucket{le="60.0"} 1');
    expect(text).toContain('comfyfed_job_run_seconds_bucket{le="+Inf"} 1');
    expect(text).toContain("comfyfed_job_run_seconds_sum 40");
    expect(text).toContain("comfyfed_job_run_seconds_count 1");
  });

  it("excludes jobs that never started from the wait/run histograms", async () => {
    await insertJob({ id: "j1", status: "queued", createdAt: toSqliteTimestamp(new Date()) });
    const r = await call("/metrics", { method: "GET" });
    const text = r.body as string;
    expect(text).toContain("comfyfed_job_wait_seconds_count 0");
    expect(text).toContain("comfyfed_job_run_seconds_count 0");
  });
});
