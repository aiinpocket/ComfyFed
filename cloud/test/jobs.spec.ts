import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { hub } from "./helpers/ws";
import { signRequest } from "../src/lib/signing";
import golden from "./fixtures/golden.json";

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
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
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

/** Creates a non-admin `role: "user"` account (via the admin-only `/api/users`
 * API) and logs in as it -- Phase 3.0 Task 10's two-user isolation tests need
 * a second, non-admin session distinct from `adminSession()`'s. Returns the
 * new session's cookie/csrf plus its uid, so a test can assert a job it owns
 * is visible while one owned by the OTHER session's uid isn't. */
async function userSession(
  admin: { cookie: string | null; csrf: string },
  username: string
): Promise<{ cookie: string | null; csrf: string; uid: string }> {
  const password = "a-long-enough-password1";
  const created = await call("/api/users", {
    json: { username, role: "user", password },
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
  const login = await call("/api/auth/login", { json: { username, password } });
  return { cookie: login.setCookie, csrf: login.body.csrf, uid: created.body.id };
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
  const bodyToSend = canCarryBody ? (opts.body ?? undefined) : undefined;
  const request = new Request(`http://example.com${path}`, {
    method,
    headers,
    body: bodyToSend,
    // Required by the fetch spec whenever the body is a ReadableStream
    // (used by the size-limiting streaming test below to send a body with
    // no Content-Length header at all, forcing the mid-stream enforcement
    // path rather than the Content-Length pre-check).
    ...(bodyToSend instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
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

  it("stores a signature on the inserted job row", async () => {
    const { cookie, csrf } = await adminSession();
    const workflow = { "1": { class_type: "KSampler", inputs: { steps: 20 } } };
    const form = new FormData();
    form.set("workflow_json", JSON.stringify(workflow));
    const res = await raw("/api/jobs", { method: "POST", body: form, cookie, headers: { "X-CSRF": csrf } });
    expect(res.status).toBe(200);
    const row = await db().prepare("SELECT signature FROM jobs WHERE id = ?").bind(res.body.job_id).first<{ signature: string | null }>();
    expect(row?.signature).toMatch(/^[0-9a-f]{16}$/);
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
  // Phase 2.1 Task 7: POST /api/jobs now rejects a submission whose models
  // are missing fleet-wide AND unfetchable (no signed manifest entry, or no
  // online opted-in worker) -- see jobs.ts's `unfetchableMissingModels`.
  // `worker` was just registered with an empty inventory, so it must claim
  // to already have SIMPLE_WORKFLOW's `sd15.safetensors` (this helper's
  // whole point is testing artifact upload, not model assessment) or the
  // submit below would 400 instead of returning a job id.
  await db()
    .prepare("UPDATE workers SET model_inventory = ? WHERE id = ?")
    .bind(JSON.stringify([{ name: "sd15.safetensors", size: 2.0 }]), worker.workerId)
    .run();

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

  it("413s a chunked (no Content-Length) PUT that exceeds the declared size DURING the stream, without ever storing the full oversized object", async () => {
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

    // A hand-built ReadableStream body carries no Content-Length header at
    // all (unlike a plain Uint8Array body, which fetch sets automatically),
    // so the pre-check based on that header cannot be what catches this --
    // only the mid-stream counting TransformStream can. Each chunk alone is
    // under the declared size; only their sum exceeds it, and the sum is
    // well over a naive single-chunk check too.
    const chunks = [
      new TextEncoder().encode("aa"),
      new TextEncoder().encode("bb"),
      new TextEncoder().encode("cc-this-pushes-it-over-the-declared-limit-by-a-lot"),
    ];
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(chunks[i++]!);
        } else {
          controller.close();
        }
      },
    });

    const put = await raw(pr.body.url, { method: "PUT", body: stream as unknown as BodyInit });
    expect(put.status).toBe(413);

    // No full (or partial) object should be left behind -- the streaming
    // guard's cleanup deletes whatever R2 had started writing.
    const stored = await store().get(`artifacts/${jobId}/out.bin`);
    expect(stored).toBeNull();
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

  it("400s a presign body missing a numeric size (m4, final review)", async () => {
    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"))))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    const presignPath = `/api/agent/jobs/${jobId}/artifacts/presign`;
    for (const badBody of [
      JSON.stringify({ filename: "out.bin", sha256 }), // size omitted entirely
      JSON.stringify({ filename: "out.bin", sha256, size: "12" }), // string, not numeric
      JSON.stringify({ filename: "out.bin", sha256, size: -1 }), // negative
      JSON.stringify({ filename: "out.bin", sha256, size: null }),
    ]) {
      const pr = await signedCall(worker, "POST", presignPath, new TextEncoder().encode(badBody));
      expect(pr.status).toBe(400);
      expect(pr.body.error.code).toBe("jobs.bad_asset_name");
      // Bilingual: contains both the zh-TW and English halves joined by " / ".
      expect(pr.body.error.message).toContain("/");
    }
  });

  it("prunes expired upload_tokens rows on the presign write path (m3, final review)", async () => {
    const worker = await registerWorker();
    const jobId = await createAssignedJob(worker);
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("x"))))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Seed an already-expired row directly (as if a prior presign call's
    // token TTL lapsed without ever being used or pruned).
    await db()
      .prepare("INSERT INTO upload_tokens (token, job_id, filename, sha256, size, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("stale-token", jobId, "old.bin", sha256, 1, Math.floor(Date.now() / 1000) - 3600)
      .run();

    const presignPath = `/api/agent/jobs/${jobId}/artifacts/presign`;
    const presignBody = new TextEncoder().encode(JSON.stringify({ filename: "new.bin", sha256, size: 1 }));
    const pr = await signedCall(worker, "POST", presignPath, presignBody);
    expect(pr.status).toBe(200);

    const stale = await db().prepare("SELECT 1 FROM upload_tokens WHERE token = ?").bind("stale-token").first();
    expect(stale).toBeNull();
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

  it("502s with a bilingual error envelope when the Hub DO call throws (M1)", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);

    const hub = (env as any).HUB;
    const getSpy = vi.spyOn(hub, "get").mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error("DO evicted")),
    });
    try {
      const r = await call(`/api/jobs/${submit.body.job_id}/cancel`, { method: "POST", cookie, headers: { "X-CSRF": csrf } });
      expect(r.status).toBe(502);
      expect(r.body.error.code).toBe("jobs.hub_unavailable");
      expect(r.body.error.message).toContain("/");
    } finally {
      getSpy.mockRestore();
    }
  });

  it("502s when the Hub DO answers non-OK for cancel (M1)", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);

    const hub = (env as any).HUB;
    const getSpy = vi.spyOn(hub, "get").mockReturnValue({
      fetch: vi.fn().mockResolvedValue(new Response("boom", { status: 500 })),
    });
    try {
      const r = await call(`/api/jobs/${submit.body.job_id}/cancel`, { method: "POST", cookie, headers: { "X-CSRF": csrf } });
      expect(r.status).toBe(502);
      expect(r.body.error.code).toBe("jobs.hub_unavailable");
    } finally {
      getSpy.mockRestore();
    }
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

  it("carries kind/fetch_entry in the job JSON (2026-09-19 model_fetch, spec §4)", async () => {
    // Console's Jobs/JobDetail reads these to show the model name, the source
    // url and whether the entry is unverified -- ports jobs.py's `_job_dict`.
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const promptId = submit.body.job_id;

    const promptDetail = await call(`/api/jobs/${promptId}`, { method: "GET", cookie });
    expect(promptDetail.body.kind).toBe("prompt");
    expect(promptDetail.body.fetch_entry).toBeNull();

    const entry = { name: "unknown_vae.safetensors", directory: "vae", unverified: true };
    await db()
      .prepare("UPDATE jobs SET kind = 'model_fetch', fetch_entry = ? WHERE id = ?")
      .bind(JSON.stringify(entry), promptId)
      .run();
    const fetchDetail = await call(`/api/jobs/${promptId}`, { method: "GET", cookie });
    expect(fetchDetail.body.kind).toBe("model_fetch");
    expect(fetchDetail.body.fetch_entry).toEqual(entry);
  });

  it("carries attempts/attempt_errors/retry_count in the job JSON (2026-09-19 job-retry, spec §8)", async () => {
    // JobDetail 用它畫「嘗試紀錄」-- ports jobs.py's `_job_dict` and
    // tests/server/test_agent_ws.py's
    // `test_jobs_api_exposes_attempts_and_retry_count` /
    // `test_attempt_errors_are_recorded_per_job_and_exposed_by_the_api`.
    // 形狀：`attempts` 維持 `{worker_id: 次數}`，per-worker 的最後錯誤放在
    // 新的 `attempt_errors: {worker_id: 錯誤}`（per-job，不是 `/api/workers`
    // 的跨 job `unsuitable[]`）。
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;

    const fresh = await call(`/api/jobs/${jobId}`, { method: "GET", cookie });
    expect(fresh.body.attempts).toEqual({});
    expect(fresh.body.attempt_errors).toEqual({});
    expect(fresh.body.retry_count).toBe(0);

    await db()
      .prepare("UPDATE jobs SET attempts = ?, retry_count = 2 WHERE id = ?")
      .bind(JSON.stringify({ "w-1": { failures: 2, last_error: "boom" } }), jobId)
      .run();

    const listed = await call("/api/jobs", { method: "GET", cookie });
    const rows = Array.isArray(listed.body) ? listed.body : listed.body.jobs;
    const row = rows.find((j: any) => j.id === jobId);
    expect(row.attempts).toEqual({ "w-1": 2 });
    expect(row.attempt_errors).toEqual({ "w-1": "boom" });
    expect(row.retry_count).toBe(2);

    const detail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie });
    expect(detail.body.attempts).toEqual({ "w-1": 2 });
    expect(detail.body.attempt_errors).toEqual({ "w-1": "boom" });
    expect(detail.body.retry_count).toBe(2);
  });

  it("still reads an attempts column written before the envelope existed", async () => {
    // migration 0012 之後、這個跟進之前寫下的列是純數字形狀；次數照樣讀得
    // 出來，只是沒有錯誤字串可引。
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;
    await db()
      .prepare("UPDATE jobs SET attempts = ? WHERE id = ?")
      .bind(JSON.stringify({ "w-old": 2 }), jobId)
      .run();

    const detail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie });
    expect(detail.body.attempts).toEqual({ "w-old": 2 });
    expect(detail.body.attempt_errors).toEqual({});
  });

  it("keeps the attempts API shape flat whatever the column holds", async () => {
    // 契約測試，不是實作細節測試：`jobs.attempts` 的**儲存**形狀在 fix round 1
    // 為了 per-job 的最後錯誤改成巢狀，但 **API 形狀不變** -- `attempts` 永遠
    // 是扁平的 `{worker_id: 次數}`，錯誤另外放在 `attempt_errors`。web console
    // 是照 API 形狀寫的，所以這裡釘死，免得哪天有人「順手」把儲存形狀直接吐
    // 出去。Ports tests/server/test_jobs.py's `_job_dict` attempts block.
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;

    const withAttempts = async (raw: string) => {
      await db().prepare("UPDATE jobs SET attempts = ? WHERE id = ?").bind(raw, jobId).run();
      return (await call(`/api/jobs/${jobId}`, { method: "GET", cookie })).body;
    };

    const nested = await withAttempts(JSON.stringify({ w1: { failures: 2, last_error: "boom" } }));
    expect(nested.attempts).toEqual({ w1: 2 });
    expect(nested.attempt_errors).toEqual({ w1: "boom" });

    // 新舊混在同一列：兩種都讀得出次數，只有巢狀那一筆有錯誤字串。
    const mixed = await withAttempts(JSON.stringify({ w1: { failures: 2, last_error: "boom" }, w2: 1 }));
    expect(mixed.attempts).toEqual({ w1: 2, w2: 1 });
    expect(mixed.attempt_errors).toEqual({ w1: "boom" });

    // 空值與壞 JSON 都退回空 map，不是 500。
    for (const raw of ["{}", "not json"]) {
      const degraded = await withAttempts(raw);
      expect(degraded.attempts).toEqual({});
      expect(degraded.attempt_errors).toEqual({});
    }
  });

  it("requeues a failed job, clearing the previous attempt's outcome", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;
    await db()
      .prepare(
        "UPDATE jobs SET status = 'failed', error = 'boom', progress = 0.5, started_at = '2026-01-01 00:00:00.000000', dispatch_info = ? WHERE id = ?"
      )
      .bind(JSON.stringify({ predicted_seconds: 12.5, basis: "signature" }), jobId)
      .run();

    const r = await call(`/api/jobs/${jobId}/retry`, { method: "POST", cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(200);
    expect(r.body.job_id).toBe(jobId);

    const detail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie });
    expect(detail.body.status).toBe("queued");
    expect(detail.body.error).toBeNull();
    expect(detail.body.progress).toBe(0);
    expect(detail.body.started_at).toBeNull();
    // Final-review M5：上一代的 predicted_seconds/basis 對這一次重試沒意義，
    // 留著只會讓 console 顯示舊數字。
    expect(detail.body.dispatch_info).toEqual({});
  });

  it("clears the split plan and count so the retry never re-splits (§3.6)", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;
    await db()
      .prepare(
        "UPDATE jobs SET status = 'failed', split_count = 2, split_plan = ?, dispatch_info = ? WHERE id = ?"
      )
      .bind(JSON.stringify({ source_node_id: "1", batch_size: 4 }), JSON.stringify({ basis: "signature" }), jobId)
      .run();

    expect((await call(`/api/jobs/${jobId}/retry`, { method: "POST", cookie, headers: { "X-CSRF": csrf } })).status).toBe(200);

    const row = (await db()
      .prepare("SELECT status, split_count, split_plan, dispatch_info FROM jobs WHERE id = ?")
      .bind(jobId)
      .first<any>())!;
    expect(row.status).toBe("queued");
    expect(row.split_count).toBe(0);
    expect(row.split_plan).toBeNull();
    expect(row.dispatch_info).toBe("{}"); // Final-review M5
  });

  it("stores a split plan at submission for a batch workflow (§3.2)", async () => {
    const { cookie, csrf } = await adminSession();
    const batchWorkflow = {
      "1": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 4 } },
      "2": { class_type: "KSampler", inputs: { latent_image: ["1", 0], steps: 20 } },
      "3": { class_type: "VAEDecode", inputs: { samples: ["2", 0] } },
      "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
    };
    const submit = await submitJob(cookie, csrf, batchWorkflow as any);
    const row = (await db().prepare("SELECT split_plan FROM jobs WHERE id = ?").bind(submit.body.job_id).first<any>())!;
    expect(JSON.parse(row.split_plan)).toEqual({ source_node_id: "1", batch_size: 4 });

    // SIMPLE_WORKFLOW 沒有批次來源 -> 不可拆 -> NULL。
    const plain = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    const plainRow = (await db().prepare("SELECT split_plan FROM jobs WHERE id = ?").bind(plain.body.job_id).first<any>())!;
    expect(plainRow.split_plan).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Phase 3.0 Task 10: job ownership & panel scoping -- parity port of the
// Python Task 3's `_require_owner_or_admin` (jobs.py) two-user coverage.
// Two non-admin users, each owning one job, plus the admin -- every route
// below must let a user see/act on their OWN job, 404 (never 403, so a
// non-owner can't distinguish "not mine" from "doesn't exist") on the
// OTHER user's, and let admin reach both with the list additionally
// carrying a `username` field.

describe("Phase 3.0: two-user job ownership scoping", () => {
  it("GET /api/jobs: admin sees every job with usernames; each user sees only their own", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    const aliceSubmit = await submitJob(alice.cookie, alice.csrf, SIMPLE_WORKFLOW);
    const bobSubmit = await submitJob(bob.cookie, bob.csrf, SIMPLE_WORKFLOW);
    expect(aliceSubmit.status).toBe(200);
    expect(bobSubmit.status).toBe(200);

    const adminList = await call("/api/jobs", { method: "GET", cookie: admin.cookie });
    expect(adminList.status).toBe(200);
    expect(adminList.body).toHaveLength(2);
    const byId = Object.fromEntries(adminList.body.map((j: any) => [j.id, j]));
    expect(byId[aliceSubmit.body.job_id].username).toBe("alice");
    expect(byId[bobSubmit.body.job_id].username).toBe("bob");

    const aliceList = await call("/api/jobs", { method: "GET", cookie: alice.cookie });
    expect(aliceList.status).toBe(200);
    expect(aliceList.body).toHaveLength(1);
    expect(aliceList.body[0].id).toBe(aliceSubmit.body.job_id);
    expect(aliceList.body[0].username).toBe("alice");

    const bobList = await call("/api/jobs", { method: "GET", cookie: bob.cookie });
    expect(bobList.body).toHaveLength(1);
    expect(bobList.body[0].id).toBe(bobSubmit.body.job_id);
  });

  it("GET /api/jobs/{id}: 404s for a non-owner non-admin user, 200s for the owner and for admin", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");
    const submit = await submitJob(alice.cookie, alice.csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;

    const asOwner = await call(`/api/jobs/${jobId}`, { method: "GET", cookie: alice.cookie });
    expect(asOwner.status).toBe(200);

    const asOther = await call(`/api/jobs/${jobId}`, { method: "GET", cookie: bob.cookie });
    expect(asOther.status).toBe(404);
    expect(asOther.body.error.code).toBe("jobs.not_found");

    const asAdmin = await call(`/api/jobs/${jobId}`, { method: "GET", cookie: admin.cookie });
    expect(asAdmin.status).toBe(200);
  });

  it("GET /api/jobs/{id}/assessment: 404s for a non-owner non-admin user", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");
    const submit = await submitJob(alice.cookie, alice.csrf, SIMPLE_WORKFLOW);

    const asOther = await call(`/api/jobs/${submit.body.job_id}/assessment`, { method: "GET", cookie: bob.cookie });
    expect(asOther.status).toBe(404);
  });

  it("GET /api/jobs/{id}/artifacts/{filename}: 404s for a non-owner non-admin user, 200s for the owner", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");
    const submit = await submitJob(alice.cookie, alice.csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;
    await store().put(`artifacts/${jobId}/out.png`, "alices-bytes");

    const asOther = await call(`/api/jobs/${jobId}/artifacts/out.png`, { method: "GET", cookie: bob.cookie });
    expect(asOther.status).toBe(404);

    const asOwner = await call(`/api/jobs/${jobId}/artifacts/out.png`, { method: "GET", cookie: alice.cookie });
    expect(asOwner.status).toBe(200);
    expect(asOwner.body).toBe("alices-bytes");
  });

  it("POST /api/jobs/{id}/cancel: 404s for a non-owner non-admin user, succeeds for the owner", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");
    const submit = await submitJob(alice.cookie, alice.csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;

    const asOther = await call(`/api/jobs/${jobId}/cancel`, {
      method: "POST",
      cookie: bob.cookie,
      headers: { "X-CSRF": bob.csrf },
    });
    expect(asOther.status).toBe(404);
    expect(asOther.body.error.code).toBe("jobs.not_found");

    const detailUnchanged = await call(`/api/jobs/${jobId}`, { method: "GET", cookie: alice.cookie });
    expect(detailUnchanged.body.status).toBe("queued");

    const asOwner = await call(`/api/jobs/${jobId}/cancel`, {
      method: "POST",
      cookie: alice.cookie,
      headers: { "X-CSRF": alice.csrf },
    });
    expect(asOwner.status).toBe(200);
  });

  it("POST /api/jobs/{id}/cancel: admin can cancel another user's job", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const submit = await submitJob(alice.cookie, alice.csrf, SIMPLE_WORKFLOW);

    const asAdmin = await call(`/api/jobs/${submit.body.job_id}/cancel`, {
      method: "POST",
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(asAdmin.status).toBe(200);
  });

  it("POST /api/jobs/{id}/retry: 404s for a non-owner non-admin user, succeeds for the owner", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");
    const submit = await submitJob(alice.cookie, alice.csrf, SIMPLE_WORKFLOW);
    const jobId = submit.body.job_id;
    await db().prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(jobId).run();

    const asOther = await call(`/api/jobs/${jobId}/retry`, {
      method: "POST",
      cookie: bob.cookie,
      headers: { "X-CSRF": bob.csrf },
    });
    expect(asOther.status).toBe(404);

    const asOwner = await call(`/api/jobs/${jobId}/retry`, {
      method: "POST",
      cookie: alice.cookie,
      headers: { "X-CSRF": alice.csrf },
    });
    expect(asOwner.status).toBe(200);
  });

  it("POST /api/jobs stamps user_id with the submitting session's own uid", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const submit = await submitJob(alice.cookie, alice.csrf, SIMPLE_WORKFLOW);

    const row = await db().prepare("SELECT user_id FROM jobs WHERE id = ?").bind(submit.body.job_id).first<any>();
    expect(row.user_id).toBe(alice.uid);
  });
});

// ---------------------------------------------------------------------------
// Console job assets vs the configured per-file cap. Parity twin:
// tests/server/test_jobs.py's upload-limit block.

describe("POST /api/jobs upload limits", () => {
  it("413s an asset over the configured per-file cap, before creating the job", async () => {
    const { cookie, csrf } = await adminSession();
    const limitsSet = await call("/api/settings", {
      json: { upload_max_file_mb: 1 },
      cookie,
      headers: { "X-CSRF": csrf },
    });
    expect(limitsSet.status).toBe(200);

    const workflow = { "1": { class_type: "LoadImage", inputs: { image: "photo.png" } } };
    const r = await submitJob(cookie, csrf, workflow, {
      assets: [{ filename: "photo.png", content: "x".repeat(1024 * 1024 + 1) }],
    });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("jobs.asset_too_large");
    expect(r.body.error.message).toContain("1 MB 單檔上限");
    expect(r.body.error.message).toContain("1 MB per-file upload limit");

    const rows = await db().prepare("SELECT COUNT(*) AS n FROM jobs").first<any>();
    expect(rows.n).toBe(0);

    const ok = await submitJob(cookie, csrf, workflow, {
      assets: [{ filename: "photo.png", content: "x".repeat(1024 * 1024) }],
    });
    expect(ok.status).toBe(200);
  });

  it("does not charge job assets against the per-user storage quota", async () => {
    // `job_inputs/` is job-scoped result storage: a user at 100% of their
    // personal quota can still submit work.
    const { cookie, csrf } = await adminSession();
    expect(
      (await call("/api/settings", { json: { upload_user_quota_gb: 0.1 }, cookie, headers: { "X-CSRF": csrf } })).status
    ).toBe(200);
    const uid = (await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<any>()).id;
    const key = `staging/${uid}/full.bin`;
    await (env as any).STORE.put(key, new Uint8Array(100 * 1024 * 1024).fill(122));
    try {
      const workflow = { "1": { class_type: "LoadImage", inputs: { image: "photo.png" } } };
      const r = await submitJob(cookie, csrf, workflow, { assets: [{ filename: "photo.png", content: "pixels" }] });
      expect(r.status).toBe(200);
    } finally {
      await (env as any).STORE.delete(key);
    }
  });
});

// --- Phase 3.3 §3.7: the console sees parents, children only on request -----
//
// JSON-shape parity with the Python stack: the same keys, the same nesting as
// `jobs.py`'s `_job_dict` / `_job_dict_full` (tests/server/test_jobs.py).

describe("split families on the console API (§3.7)", () => {
  async function makeSplitFamily(uid: string | null = null): Promise<void> {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, split_count, user_id)
         VALUES ('p', '{}', 'done', ?, 2, ?)`
      )
      .bind(now, uid)
      .run();
    for (let index = 0; index < 2; index++) {
      await db()
        .prepare(
          `INSERT INTO jobs (id, workflow_json, status, created_at, parent_id, split_index,
                             worker_id, progress, result_files, user_id)
           VALUES (?, '{}', 'done', ?, 'p', ?, ?, 1.0, ?, ?)`
        )
        .bind(`c${index}`, now, index, `w${index}`, JSON.stringify([`c${index}.png`]), uid)
        .run();
      await db()
        .prepare(
          `INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, kind, billable, created_at)
           VALUES (?, ?, ?, ?, 'sig', 'completed', 1, ?)`
        )
        .bind(`r${index}`, `c${index}`, `w${index}`, 10 * (index + 1), now)
        .run();
    }
  }

  it("hides children from GET /api/jobs by default", async () => {
    const { cookie } = await adminSession();
    await makeSplitFamily();
    const r = await call("/api/jobs", { method: "GET", cookie });
    expect(r.body.map((j: any) => j.id)).toEqual(["p"]);
    expect(r.body[0].split_count).toBe(2);
    expect(r.body[0].parent_id).toBeNull();
  });

  it("lists everything with ?include_children=1", async () => {
    const { cookie } = await adminSession();
    await makeSplitFamily();
    const r = await call("/api/jobs?include_children=1", { method: "GET", cookie });
    expect(r.body.map((j: any) => j.id).sort()).toEqual(["c0", "c1", "p"]);
    const c0 = r.body.find((j: any) => j.id === "c0");
    expect(c0.parent_id).toBe("p");
    expect(c0.split_index).toBe(0);
  });

  it("returns children and gpu_seconds_total for a parent", async () => {
    const { cookie } = await adminSession();
    await makeSplitFamily();
    const r = await call("/api/jobs/p", { method: "GET", cookie });
    expect(r.body.receipt).toBeNull();
    expect(r.body.split_count).toBe(2);
    expect(r.body.gpu_seconds_total).toBeCloseTo(30);
    expect(r.body.children).toEqual([
      { id: "c0", split_index: 0, status: "done", worker_id: "w0", progress: 1, gpu_seconds: 10, error: null },
      { id: "c1", split_index: 1, status: "done", worker_id: "w1", progress: 1, gpu_seconds: 20, error: null },
    ]);
    expect(r.body.outputs).toEqual([
      { job_id: "c0", filename: "c0.png" },
      { job_id: "c1", filename: "c1.png" },
    ]);
  });

  it("gives a plain job empty children and no outputs key", async () => {
    const { cookie, csrf } = await adminSession();
    const submit = await submitJob(cookie, csrf, { "1": { class_type: "KSampler", inputs: {} } });
    const r = await call(`/api/jobs/${submit.body.job_id}`, { method: "GET", cookie });
    expect(r.body.children).toEqual([]);
    expect(r.body.gpu_seconds_total).toBe(0);
    expect(r.body.split_count).toBe(0);
    expect(r.body.outputs).toBeUndefined();
  });

  it("reports a child with no receipt as gpu_seconds: null", async () => {
    const { cookie } = await adminSession();
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, split_count) VALUES ('p', '{}', 'running', ?, 1)`
      )
      .bind(now)
      .run();
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, parent_id, split_index)
         VALUES ('c0', '{}', 'running', ?, 'p', 0)`
      )
      .bind(now)
      .run();
    const r = await call("/api/jobs/p", { method: "GET", cookie });
    expect(r.body.children[0].gpu_seconds).toBeNull();
    expect(r.body.gpu_seconds_total).toBe(0);
  });

  it("carries dispatch_info on both the list and the detail view", async () => {
    const { cookie } = await adminSession();
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, dispatch_info) VALUES ('j1', '{}', 'assigned', ?, ?)`
      )
      .bind(
        now,
        JSON.stringify({ predicted_seconds: 41.2, basis: "signature", load_seconds: 0, fetch_seconds: 0, candidates: 3 })
      )
      .run();
    const detail = await call("/api/jobs/j1", { method: "GET", cookie });
    expect(detail.body.dispatch_info.basis).toBe("signature");
    expect(detail.body.dispatch_info.predicted_seconds).toBeCloseTo(41.2);

    const list = await call("/api/jobs", { method: "GET", cookie });
    expect(list.body[0].dispatch_info.candidates).toBe(3);
  });
});

// --- Final-review: split families × ownership, and child retry -------------
//
// Mirrors tests/server/test_job_scoping.py's re-opened ownership × split
// coverage: `?include_children=1` opens up the CHILD filter, never the OWNER
// one, and a child row is owner-or-admin scoped exactly like any other job.

describe("split families × ownership (final review)", () => {
  async function makeOwnedSplitFamily(prefix: string, uid: string | null): Promise<void> {
    const now = new Date().toISOString().slice(0, 19).replace("T", " ");
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, split_count, user_id)
         VALUES (?, '{}', 'done', ?, 2, ?)`
      )
      .bind(`${prefix}p`, now, uid)
      .run();
    for (let index = 0; index < 2; index++) {
      await db()
        .prepare(
          `INSERT INTO jobs (id, workflow_json, status, created_at, parent_id, split_index, user_id)
           VALUES (?, '{}', 'done', ?, ?, ?, ?)`
        )
        .bind(`${prefix}c${index}`, now, `${prefix}p`, index, uid)
        .run();
    }
  }

  it("?include_children=1 still only shows the caller's own family", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");
    await makeOwnedSplitFamily("a", alice.uid);
    await makeOwnedSplitFamily("b", bob.uid);

    const r = await call("/api/jobs?include_children=1", { method: "GET", cookie: alice.cookie });

    expect(r.body.map((j: any) => j.id).sort()).toEqual(["ac0", "ac1", "ap"]);
  });

  it("GET /api/jobs/{child of another user} is 404", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");
    await makeOwnedSplitFamily("a", alice.uid);

    const asOther = await call("/api/jobs/ac0", { method: "GET", cookie: bob.cookie });
    expect(asOther.status).toBe(404);
    expect(asOther.body.error.code).toBe("jobs.not_found");

    const asOwner = await call("/api/jobs/ac0", { method: "GET", cookie: alice.cookie });
    expect(asOwner.status).toBe(200);
    expect(asOwner.body.parent_id).toBe("ap");
  });

  it("POST /api/jobs/{child}/retry is 409 jobs.not_retryable, even for its owner", async () => {
    // Final-review I2: requeueing one slice behind its parent's back would
    // resurrect a job the failure cascade already settled, and the parent's
    // derived status/progress would never account for it.
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    await makeOwnedSplitFamily("a", alice.uid);
    await db().prepare("UPDATE jobs SET status = 'failed' WHERE id = 'ac0'").run();

    const r = await call("/api/jobs/ac0/retry", {
      method: "POST",
      cookie: alice.cookie,
      headers: { "X-CSRF": alice.csrf },
    });

    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("jobs.not_retryable");
    const row = await db().prepare("SELECT status, parent_id FROM jobs WHERE id = 'ac0'").first<any>();
    expect(row.status).toBe("failed");
    expect(row.parent_id).toBe("ap");
  });

  it("POST /api/jobs/{parent}/retry still works", async () => {
    const admin = await adminSession();
    const alice = await userSession(admin, "alice");
    await makeOwnedSplitFamily("a", alice.uid);
    await db().prepare("UPDATE jobs SET status = 'failed' WHERE id = 'ap'").run();

    const r = await call("/api/jobs/ap/retry", {
      method: "POST",
      cookie: alice.cookie,
      headers: { "X-CSRF": alice.csrf },
    });

    expect(r.status).toBe(200);
    const row = await db().prepare("SELECT status, split_count FROM jobs WHERE id = 'ap'").first<any>();
    expect(row.status).toBe("queued");
    expect(row.split_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-20 spec §12.2: `createJobFromWorkflow`'s `fetching` exemption is a
// keyword option only `routes/recipes.ts` passes (it knows which names it just
// queued a `kind=model_fetch` job for). The console's multipart submit must
// not be able to claim one -- otherwise any submitter could name a model and
// walk straight past the `jobs.missing_models` gate.

describe("POST /api/jobs fetching exemption", () => {
  it("cannot be claimed from the multipart body", async () => {
    const { cookie, csrf } = await adminSession();
    await registerWorker();

    // Baseline: one online worker, no inventory -> the model is fleet-wide
    // missing and not in the signed manifest, so the gate refuses.
    const refused = await submitJob(cookie, csrf, SIMPLE_WORKFLOW);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe("jobs.missing_models");

    // The same submit with every spelling of an exemption the wire could
    // carry still gets the same 400.
    for (const fields of [
      { fetching: "sd15.safetensors" },
      { fetching: JSON.stringify(["sd15.safetensors"]) },
    ]) {
      const form = multipartBody({ workflow_json: JSON.stringify(SIMPLE_WORKFLOW), ...fields });
      const r = await raw("/api/jobs", { method: "POST", body: form, cookie, headers: { "X-CSRF": csrf } });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("jobs.missing_models");
    }

    const rows = await db().prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(rows!.n).toBe(0);
  });
});
