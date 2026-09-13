import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { hub } from "./helpers/ws";
import { signRequest } from "../src/lib/signing";
import golden from "./fixtures/golden.json";

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM receipts").run();
  await db().prepare("DELETE FROM upload_tokens").run();
  delete (env as any).R2_S3_ACCOUNT_ID;
  delete (env as any).R2_S3_ACCESS_KEY_ID;
  delete (env as any).R2_S3_SECRET_ACCESS_KEY;
  delete (env as any).R2_S3_BUCKET;
});

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function adminSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

interface RawCallResult {
  status: number;
  body: any;
  headers: Headers;
}

/** Fires a request with an arbitrary body (FormData, raw bytes, or none)
 * straight through the worker export -- `helpers/http.ts`'s `call` only
 * supports JSON/raw-bytes bodies, not `multipart/form-data`, which every
 * `POST /api/jobs` test here needs. */
async function raw(
  path: string,
  opts: { method?: string; body?: BodyInit | null; headers?: Record<string, string>; cookie?: string | null } = {}
): Promise<RawCallResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const canCarryBody = method !== "GET" && method !== "HEAD";
  const request = new Request(`http://example.com${path}`, {
    method,
    headers,
    body: canCarryBody ? (opts.body ?? undefined) : undefined,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  let body: any = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

function multipartBody(fields: Record<string, string>, files: { field: string; filename: string; content: string }[] = []) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const f of files) form.append(f.field, new File([f.content], f.filename));
  return form;
}

async function submitJob(
  cookie: string | null,
  csrf: string,
  workflow: Record<string, unknown>,
  opts: { assets?: { filename: string; content: string }[]; requirements?: Record<string, unknown> } = {}
): Promise<RawCallResult> {
  const form = multipartBody(
    {
      workflow_json: JSON.stringify(workflow),
      ...(opts.requirements ? { requirements: JSON.stringify(opts.requirements) } : {}),
    },
    (opts.assets ?? []).map((a) => ({ field: "assets", filename: a.filename, content: a.content }))
  );
  return raw("/api/jobs", { method: "POST", body: form, cookie, headers: { "X-CSRF": csrf } });
}

const SIMPLE_WORKFLOW = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } },
};

// ---------------------------------------------------------------------------
// POST /api/jobs

describe("POST /api/jobs", () => {
  it("401s without a session", async () => {
    const form = multipartBody({ workflow_json: "{}" });
    const r = await raw("/api/jobs", { method: "POST", body: form });
    expect(r.status).toBe(401);
  });

  it("403s without X-CSRF", async () => {
    const { cookie } = await adminSession();
    const form = multipartBody({ workflow_json: "{}" });
    const r = await raw("/api/jobs", { method: "POST", body: form, cookie });
    expect(r.status).toBe(403);
  });

  it("400s on invalid workflow_json", async () => {
    const { cookie, csrf } = await adminSession();
    const form = multipartBody({ workflow_json: "not json" });
    const r = await raw("/api/jobs", { method: "POST", body: form, cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("jobs.invalid_workflow");
  });

  it("400s when the workflow references an asset that wasn't uploaded", async () => {
    const { cookie, csrf } = await adminSession();
    const workflow = { "1": { class_type: "LoadImage", inputs: { image: "photo.png" } } };
    const r = await submitJob(cookie, csrf, workflow);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("jobs.missing_assets");
    expect(r.body.error.message).toContain("photo.png");
  });

  it("400s on a path-traversal asset filename", async () => {
    const { cookie, csrf } = await adminSession();
    const workflow = { "1": { class_type: "LoadImage", inputs: { image: "photo.png" } } };
    const r = await submitJob(cookie, csrf, workflow, { assets: [{ filename: "../../etc/passwd", content: "x" }] });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("jobs.bad_asset_name");
  });

  it("creates a queued job, stores the uploaded asset in R2, and wakes the Hub alarm", async () => {
    const { cookie, csrf } = await adminSession();
    const workflow = { "1": { class_type: "LoadImage", inputs: { image: "photo.png" } } };
    const r = await submitJob(cookie, csrf, workflow, { assets: [{ filename: "photo.png", content: "pixel-bytes" }] });
    expect(r.status).toBe(200);
    expect(typeof r.body.job_id).toBe("string");

    const stored = await store().get(`job_inputs/${r.body.job_id}/photo.png`);
    expect(stored).not.toBeNull();
    expect(await stored!.text()).toBe("pixel-bytes");

    const list = await call("/api/jobs", { method: "GET", cookie });
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(r.body.job_id);
    expect(list.body[0].status).toBe("queued");
    expect(list.body[0].origin).toBe("console");
    expect(list.body[0].input_assets).toEqual(["photo.png"]);

  });

  it("wakes the Hub DO's /internal/wake endpoint (trivial handler)", async () => {
    const stub = hub();
    const res = await stub.fetch("http://hub.internal/internal/wake", { method: "POST" });
    expect(res.status).toBe(202);
  });

  it("accepts a job with no assets and no models (light job)", async () => {
    const { cookie, csrf } = await adminSession();
    const r = await submitJob(cookie, csrf, { "1": { class_type: "Note", inputs: {} } });
    expect(r.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// GET /api/jobs, GET /api/jobs/{id}, GET /api/jobs/{id}/assessment

describe("GET /api/jobs/{id}", () => {
  it("404s for an unknown job", async () => {
    const { cookie } = await adminSession();
    const r = await call("/api/jobs/does-not-exist", { method: "GET", cookie });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("jobs.not_found");
  });

  it("returns the full detail shape with a null receipt for a fresh job", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const r = await call(`/api/jobs/${submit.body.job_id}`, { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("queued");
    expect(r.body.workflow_json).toEqual(SIMPLE_WORKFLOW);
    expect(r.body.required_models).toEqual(["sd15.safetensors"]);
    expect(r.body.receipt).toBeNull();
  });
});

describe("GET /api/jobs/{id}/assessment", () => {
  it("404s for an unknown job", async () => {
    const { cookie } = await adminSession();
    const r = await call("/api/jobs/nope/assessment", { method: "GET", cookie });
    expect(r.status).toBe(404);
  });

  it("returns an empty worker list when no workers are registered", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const r = await call(`/api/jobs/${submit.body.job_id}/assessment`, { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body.workers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Agent-side signed routes: input download, legacy multipart artifact
// upload, presign (direct + s3), raw PUT, confirm.

interface RegisteredWorker {
  workerId: string;
  seedHex: string;
}

async function registerWorker(name = "gpu-box"): Promise<RegisteredWorker> {
  const { cookie, csrf } = await adminSession();
  const tokenRes = await call("/api/workers/tokens", { json: { name }, cookie, headers: { "X-CSRF": csrf } });
  const kp = golden.keypairs[0]!;
  const r = await call("/api/agent/register", { json: { token: tokenRes.body.bundle.register_token, pubkey: kp.pubkey_hex } });
  return { workerId: r.body.worker_id, seedHex: kp.seed_hex };
}

async function signedCall(
  worker: RegisteredWorker,
  method: string,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {}
): Promise<RawCallResult> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = await signRequest(worker.seedHex, method, path, "", ts, nonce, body);
  return raw(path, {
    method,
    body,
    headers: {
      "X-Worker-Id": worker.workerId,
      "X-Ts": ts,
      "X-Nonce": nonce,
      "X-Sig": sig,
      ...headers,
    },
  });
}

async function createAssignedJob(worker: RegisteredWorker, workflow: Record<string, unknown> = SIMPLE_WORKFLOW): Promise<string> {
  const { cookie, csrf } = await adminSession();
  const submit = await submitJob(cookie, csrf, workflow);
  const jobId = submit.body.job_id;
  await db().prepare("UPDATE jobs SET status = 'assigned', worker_id = ? WHERE id = ?").bind(worker.workerId, jobId).run();
  return jobId;
}

describe("GET /api/agent/jobs/{id}/inputs/{filename}", () => {
  it("streams a stored input asset for the owning worker", async () => {
    const worker = await registerWorker();
    const { cookie, csrf } = await adminSession();
    const workflow = { "1": { class_type: "LoadImage", inputs: { image: "photo.png" } } };
    const submit = await submitJob(cookie, csrf, workflow, { assets: [{ filename: "photo.png", content: "pixel-bytes" }] });
    const jobId = submit.body.job_id;
    await db().prepare("UPDATE jobs SET status = 'assigned', worker_id = ? WHERE id = ?").bind(worker.workerId, jobId).run();

    const path = `/api/agent/jobs/${jobId}/inputs/photo.png`;
    const r = await signedCall(worker, "GET", path, new Uint8Array());
    expect(r.status).toBe(200);
    expect(r.body).toBe("pixel-bytes");
  });

  it("403s when the job isn't assigned to this worker", async () => {
    const worker = await registerWorker();
    const other = await registerWorker("other-box");
    const { cookie, csrf } = await adminSession();
    const workflow = { "1": { class_type: "LoadImage", inputs: { image: "photo.png" } } };
    const submit = await submitJob(cookie, csrf, workflow, { assets: [{ filename: "photo.png", content: "x" }] });
    await db().prepare("UPDATE jobs SET status = 'assigned', worker_id = ? WHERE id = ?").bind(other.workerId, submit.body.job_id).run();

    const path = `/api/agent/jobs/${submit.body.job_id}/inputs/photo.png`;
    const r = await signedCall(worker, "GET", path, new Uint8Array());
    expect(r.status).toBe(403);
  });
});

describe("POST /api/agent/jobs/{id}/artifacts (legacy multipart)", () => {
  it("stores the artifact and records its sha256", async () => {
    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);

    const content = "rendered-image-bytes";
    const form = new FormData();
    form.append("file", new File([content], "out.png"));
    const encoded = new Response(form);
    const contentType = encoded.headers.get("content-type")!;
    const bodyBuf = new Uint8Array(await encoded.arrayBuffer());

    const path = `/api/agent/jobs/${jobId}/artifacts`;
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const sig = await signRequest(worker.seedHex, "POST", path, "", ts, nonce, bodyBuf);

    const r = await raw(path, {
      method: "POST",
      body: bodyBuf,
      headers: {
        "content-type": contentType,
        "X-Worker-Id": worker.workerId,
        "X-Ts": ts,
        "X-Nonce": nonce,
        "X-Sig": sig,
      },
    });
    expect(r.status).toBe(200);
    expect(r.body.stored).toBe("out.png");

    const stored = await store().get(`artifacts/${jobId}/out.png`);
    expect(await stored!.text()).toBe(content);

    const detail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie: (await adminSession()).cookie });
    expect(detail.body.result_hashes["out.png"]).toBe(r.body.sha256);
  });
});

describe("POST /api/agent/jobs/{id}/artifacts/presign + raw PUT (direct mode)", () => {
  it("issues a one-time token and accepts a matching PUT", async () => {
    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);
    const content = new TextEncoder().encode("streamed-artifact-bytes");
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const presignPath = `/api/agent/jobs/${jobId}/artifacts/presign`;
    const presignBody = new TextEncoder().encode(JSON.stringify({ filename: "out.bin", sha256, size: content.length }));
    const pr = await signedCall(worker, "POST", presignPath, presignBody);
    expect(pr.status).toBe(200);
    expect(pr.body.mode).toBe("direct");
    expect(pr.body.url).toMatch(new RegExp(`^/api/agent/jobs/${jobId}/artifacts/raw/`));

    const put = await raw(pr.body.url, { method: "PUT", body: content });
    expect(put.status).toBe(200);
    expect(put.body.sha256).toBe(sha256);

    const stored = await store().get(`artifacts/${jobId}/out.bin`);
    expect(new TextDecoder().decode(await stored!.arrayBuffer())).toBe("streamed-artifact-bytes");

    // Replay: the token is single-use.
    const replay = await raw(pr.body.url, { method: "PUT", body: content });
    expect(replay.status).toBe(409);
  });

  it("413s a PUT whose Content-Length exceeds the declared size", async () => {
    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);
    const declaredContent = new TextEncoder().encode("small");
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", declaredContent)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const presignPath = `/api/agent/jobs/${jobId}/artifacts/presign`;
    const presignBody = new TextEncoder().encode(
      JSON.stringify({ filename: "out.bin", sha256, size: declaredContent.length })
    );
    const pr = await signedCall(worker, "POST", presignPath, presignBody);

    const oversized = new TextEncoder().encode("this-is-way-too-large-for-the-declared-size");
    const put = await raw(pr.body.url, {
      method: "PUT",
      body: oversized,
      headers: { "content-length": String(oversized.length) },
    });
    expect(put.status).toBe(413);
  });

  it("400s a PUT whose bytes don't match the declared sha256", async () => {
    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);
    const declaredContent = new TextEncoder().encode("expected-bytes");
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", declaredContent)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const presignPath = `/api/agent/jobs/${jobId}/artifacts/presign`;
    const presignBody = new TextEncoder().encode(
      JSON.stringify({ filename: "out.bin", sha256, size: declaredContent.length })
    );
    const pr = await signedCall(worker, "POST", presignPath, presignBody);

    const wrongContent = new TextEncoder().encode("wrong-content!");
    expect(wrongContent.length).toBe(declaredContent.length);
    const put = await raw(pr.body.url, {
      method: "PUT",
      body: wrongContent,
      headers: { "content-length": String(wrongContent.length) },
    });
    expect(put.status).toBe(400);
    expect(put.body.error.code).toBe("artifact.hash_mismatch");
  });

  it("404s a PUT against an unknown token", async () => {
    const r = await raw("/api/agent/jobs/some-job/artifacts/raw/does-not-exist", {
      method: "PUT",
      body: new Uint8Array([1, 2, 3]),
    });
    expect(r.status).toBe(404);
  });
});

describe("POST /api/agent/jobs/{id}/artifacts/presign (s3 mode)", () => {
  it("returns a presigned S3 PUT URL when R2_S3_* env is fully configured", async () => {
    (env as any).R2_S3_ACCOUNT_ID = "test-account";
    (env as any).R2_S3_ACCESS_KEY_ID = "AKIATESTEXAMPLE";
    (env as any).R2_S3_SECRET_ACCESS_KEY = "test-secret-key";
    (env as any).R2_S3_BUCKET = "comfyfed-store";

    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);
    const content = new TextEncoder().encode("s3-mode-bytes");
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", content)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const presignPath = `/api/agent/jobs/${jobId}/artifacts/presign`;
    const presignBody = new TextEncoder().encode(JSON.stringify({ filename: "out.bin", sha256, size: content.length }));
    const pr = await signedCall(worker, "POST", presignPath, presignBody);
    expect(pr.status).toBe(200);
    expect(pr.body.mode).toBe("s3");
    expect(pr.body.url).toContain("test-account.r2.cloudflarestorage.com");
    expect(pr.body.url).toContain("X-Amz-Signature=");
  });

  it("confirm records the claimed hash after HEADing the R2 object", async () => {
    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);
    // Simulate the agent's direct-to-R2 PUT (which this Worker never sees
    // in s3 mode) by writing the object straight into the bucket.
    await store().put(`artifacts/${jobId}/direct.bin`, "already-uploaded");

    const confirmPath = `/api/agent/jobs/${jobId}/artifacts/confirm`;
    const fakeSha = "a".repeat(64);
    const body = new TextEncoder().encode(JSON.stringify({ filename: "direct.bin", sha256: fakeSha }));
    const r = await signedCall(worker, "POST", confirmPath, body);
    expect(r.status).toBe(200);
    expect(r.body.sha256).toBe(fakeSha);

    const detail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie: (await adminSession()).cookie });
    expect(detail.body.result_hashes["direct.bin"]).toBe(fakeSha);
  });

  it("confirm 404s when the object was never written", async () => {
    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);
    const confirmPath = `/api/agent/jobs/${jobId}/artifacts/confirm`;
    const body = new TextEncoder().encode(JSON.stringify({ filename: "missing.bin", sha256: "a".repeat(64) }));
    const r = await signedCall(worker, "POST", confirmPath, body);
    expect(r.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Console artifact download

describe("GET /api/jobs/{id}/artifacts/{filename}", () => {
  it("404s for a missing artifact", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const r = await call(`/api/jobs/${submit.body.job_id}/artifacts/missing.png`, { method: "GET", cookie });
    expect(r.status).toBe(404);
  });

  it("streams a stored artifact", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    await store().put(`artifacts/${submit.body.job_id}/out.png`, "final-bytes");
    const r = await call(`/api/jobs/${submit.body.job_id}/artifacts/out.png`, { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body).toBe("final-bytes");
  });
});

// ---------------------------------------------------------------------------
// POST /api/jobs/{id}/cancel, POST /api/jobs/{id}/retry

describe("POST /api/jobs/{id}/cancel", () => {
  it("404s for an unknown job", async () => {
    const { cookie, csrf } = await adminSession();
    const r = await call("/api/jobs/nope/cancel", { method: "POST", cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(404);
  });

  it("cancels a queued job", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const r = await call(`/api/jobs/${submit.body.job_id}/cancel`, { method: "POST", cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("cancelled");

    const detail = await call(`/api/jobs/${submit.body.job_id}`, { method: "GET", cookie });
    expect(detail.body.status).toBe("cancelled");
  });

  it("409s cancelling an already-terminal job", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    await call(`/api/jobs/${submit.body.job_id}/cancel`, { method: "POST", cookie, headers: { "X-CSRF": csrf } });
    const again = await call(`/api/jobs/${submit.body.job_id}/cancel`, { method: "POST", cookie, headers: { "X-CSRF": csrf } });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("jobs.already_terminal");
    expect(again.body.status).toBe("cancelled");
  });
});

describe("POST /api/jobs/{id}/retry", () => {
  it("409s a job that isn't failed", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const r = await call(`/api/jobs/${submit.body.job_id}/retry`, { method: "POST", cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("jobs.not_retryable");
  });

  it("requeues a failed job, clearing the previous attempt's outcome", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;
    await db()
      .prepare("UPDATE jobs SET status = 'failed', error = 'boom', progress = 0.5, started_at = '2026-01-01 00:00:00.000000' WHERE id = ?")
      .bind(jobId)
      .run();

    const r = await call(`/api/jobs/${jobId}/retry`, { method: "POST", cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(200);
    expect(r.body.job_id).toBe(jobId);

    const detail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie });
    expect(detail.body.status).toBe("queued");
    expect(detail.body.error).toBeNull();
    expect(detail.body.progress).toBe(0);
    expect(detail.body.started_at).toBeNull();
  });
});
