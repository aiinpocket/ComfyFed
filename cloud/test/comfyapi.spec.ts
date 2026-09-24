import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp } from "../src/db/queries";
import { artifactKey } from "../src/lib/store";
import { clearObjectInfoCacheForTests } from "../src/routes/comfyapi";
import golden from "./fixtures/golden.json";

// Ports the highest-value cases from the original Python suite (1454 lines;
// this file covers auth gating, object_info union/intersection + staged-asset
// dropdown injection, the missing-model rejection's byte-shape + node_errors,
// origin scoping on queue/history/interrupt, history hide, /view traversal
// safety + job-scoped filename collisions, and the upload/settings/bootstrap
// routes).

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  await db().prepare("DELETE FROM login_attempts").run();
  clearObjectInfoCacheForTests();
  // R2 storage is shared across every test in this file (unlike D1, which
  // vitest-pool-workers isolates per test file) -- clear every prefix this
  // suite writes under so one test's staged/artifact/object_info state can
  // never leak into the next.
  for (const prefix of ["staging/", "object_info/", "artifacts/", "job_inputs/"]) {
    const listed = await store().list({ prefix });
    await Promise.all(listed.objects.map((o) => store().delete(o.key)));
  }
});

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function loginSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function registerWorker(
  cookie: string | null,
  csrf: string,
  name: string
): Promise<string> {
  const tokenRes = await call("/api/workers/tokens", { json: { name }, cookie, headers: { "X-CSRF": csrf } });
  const token = tokenRes.body.bundle.register_token;
  const kp = golden.keypairs[0]!;
  const reg = await call("/api/agent/register", { json: { token, name, pubkey: kp.pubkey_hex } });
  const workerId = reg.body.worker_id;
  // A freshly-registered worker's `status` column defaults to 'offline'
  // (only `agentws`'s `hello` handshake -- not exercised by this file --
  // flips it to 'online'); this suite's fleet-membership tests want a
  // "currently connected" worker, so mark it online right away.
  await setWorkerRow(workerId, { status: "online" });
  return workerId;
}

async function setWorkerRow(
  workerId: string,
  fields: {
    status?: string;
    disabled?: boolean;
    modelInventory?: unknown[];
    nodeClasses?: string[];
    objectInfoHash?: string;
    protocol?: number;
    autoFetch?: boolean;
    dynamic?: Record<string, unknown>;
    hardware?: Record<string, unknown>;
  }
): Promise<void> {
  if (fields.status !== undefined) {
    await db().prepare("UPDATE workers SET status = ? WHERE id = ?").bind(fields.status, workerId).run();
  }
  if (fields.disabled !== undefined) {
    await db().prepare("UPDATE workers SET disabled = ? WHERE id = ?").bind(fields.disabled ? 1 : 0, workerId).run();
  }
  if (fields.modelInventory !== undefined) {
    await db()
      .prepare("UPDATE workers SET model_inventory = ? WHERE id = ?")
      .bind(JSON.stringify(fields.modelInventory), workerId)
      .run();
  }
  if (fields.nodeClasses !== undefined) {
    await db()
      .prepare("UPDATE workers SET node_classes = ? WHERE id = ?")
      .bind(JSON.stringify(fields.nodeClasses), workerId)
      .run();
  }
  if (fields.objectInfoHash !== undefined) {
    await db().prepare("UPDATE workers SET object_info_hash = ? WHERE id = ?").bind(fields.objectInfoHash, workerId).run();
  }
  if (fields.protocol !== undefined) {
    await db().prepare("UPDATE workers SET protocol = ? WHERE id = ?").bind(fields.protocol, workerId).run();
  }
  if (fields.autoFetch !== undefined) {
    await db().prepare("UPDATE workers SET auto_fetch = ? WHERE id = ?").bind(fields.autoFetch ? 1 : 0, workerId).run();
  }
  if (fields.dynamic !== undefined) {
    await db().prepare("UPDATE workers SET dynamic = ? WHERE id = ?").bind(JSON.stringify(fields.dynamic), workerId).run();
  }
  if (fields.hardware !== undefined) {
    await db().prepare("UPDATE workers SET hardware = ? WHERE id = ?").bind(JSON.stringify(fields.hardware), workerId).run();
  }
}

async function seedObjectInfo(workerId: string, hash: string, payload: Record<string, unknown>): Promise<void> {
  await store().put(`object_info/${workerId}.json.gz`, await gzip(JSON.stringify(payload)));
  await setWorkerRow(workerId, { objectInfoHash: hash });
}

async function gzip(text: string): Promise<ArrayBuffer> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

/** Directly drives a queued job to `done` (or `failed`), bypassing the full
 * agent dispatch path -- this file only needs to exercise the panel-facing
 * history/view/queue surfaces, not re-verify dispatch itself (Task 3/8 own
 * that). */
async function finishJob(jobId: string, opts: { status: "done" | "failed"; resultFiles?: string[]; error?: string; bytes?: Uint8Array }): Promise<void> {
  const finishedAt = toSqliteTimestamp(new Date());
  await db()
    .prepare("UPDATE jobs SET status = ?, result_files = ?, error = ?, finished_at = ? WHERE id = ?")
    .bind(opts.status, JSON.stringify(opts.resultFiles ?? []), opts.error ?? null, finishedAt, jobId)
    .run();
  for (const name of opts.resultFiles ?? []) {
    await store().put(artifactKey(jobId, name), opts.bytes ?? new TextEncoder().encode("bytes"));
  }
}

const SIMPLE_PROMPT = {
  "1": { class_type: "KSampler", inputs: { seed: 1 } },
  "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
};

async function postPrompt(cookie: string | null, prompt: unknown = SIMPLE_PROMPT) {
  return call("/comfy/api/prompt", { json: { prompt }, cookie });
}

/** Creates a non-admin `role: "user"` account (via the admin-only
 * `/api/users` API) and logs in as it -- Phase 3.0 Task 10's panel per-user
 * scoping tests need a second, non-admin session distinct from
 * `loginSession()`'s admin. */
async function userSession(
  admin: { cookie: string | null; csrf: string },
  username: string
): Promise<{ cookie: string | null; csrf: string }> {
  const password = "a-long-enough-password1";
  await call("/api/users", {
    json: { username, role: "user", password },
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
  const login = await call("/api/auth/login", { json: { username, password } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

// --- auth --------------------------------------------------------------

describe("every /comfy/api route requires an authenticated session (any role, Phase 3.0 Task 4/10)", () => {
  const routes: [string, string][] = [
    ["GET", "/comfy/api/object_info"],
    ["GET", "/comfy/api/queue"],
    ["GET", "/comfy/api/history"],
    ["GET", "/comfy/api/history/abc"],
    ["GET", "/comfy/api/view?filename=x.png"],
    ["POST", "/comfy/api/prompt"],
    ["POST", "/comfy/api/interrupt"],
    ["POST", "/comfy/api/queue"],
    ["POST", "/comfy/api/history"],
  ];

  for (const [method, path] of routes) {
    it(`${method} ${path} -> 401 without a session`, async () => {
      const r = await call(path, { method });
      expect(r.status).toBe(401);
    });
  }
});

// --- object_info ---------------------------------------------------------

describe("GET /comfy/api/object_info", () => {
  it("is empty with X-ComfyFed-No-Workers when no worker is online", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/api/object_info", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });

  it("unions online, enabled workers' node classes, first-worker-wins", async () => {
    const { cookie, csrf } = await loginSession();
    const w1 = await registerWorker(cookie, csrf, "w1");
    const w2 = await registerWorker(cookie, csrf, "w2");
    await seedObjectInfo(w1, "h1", { NodeA: { from: "w1" }, NodeShared: { from: "w1" } });
    await seedObjectInfo(w2, "h2", { NodeB: { from: "w2" }, NodeShared: { from: "w2" } });

    const r = await call("/comfy/api/object_info", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(Object.keys(r.body).sort()).toEqual(["NodeA", "NodeB", "NodeShared"]);
    expect(r.body.NodeShared).toEqual({ from: "w1" }); // first-worker-wins (created_at order)
  });

  it("reports the fleet size in the X-ComfyFed-Worker-Count header", async () => {
    const { cookie, csrf } = await loginSession();
    const w1 = await registerWorker(cookie, csrf, "w1");
    await seedObjectInfo(w1, "h1", { NodeA: {} });

    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/comfy/api/object_info", { headers: { Cookie: cookie ?? "" } }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("X-ComfyFed-Worker-Count")).toBe("1");
  });

  it("intersection mode keeps only node classes every online worker defines", async () => {
    const { cookie, csrf } = await loginSession();
    const w1 = await registerWorker(cookie, csrf, "w1");
    const w2 = await registerWorker(cookie, csrf, "w2");
    await seedObjectInfo(w1, "h1", { Shared: {}, OnlyW1: {} });
    await seedObjectInfo(w2, "h2", { Shared: {}, OnlyW2: {} });

    await call("/api/settings", { json: { object_info_mode: "intersection" }, cookie, headers: { "X-CSRF": csrf } });

    const r = await call("/comfy/api/object_info", { method: "GET", cookie });
    expect(Object.keys(r.body)).toEqual(["Shared"]);
  });

  it("a worker that is offline or disabled is excluded from the fleet", async () => {
    const { cookie, csrf } = await loginSession();
    const w1 = await registerWorker(cookie, csrf, "w1");
    await seedObjectInfo(w1, "h1", { NodeA: {} });
    await setWorkerRow(w1, { status: "offline" });

    const r = await call("/comfy/api/object_info", { method: "GET", cookie });
    expect(r.body).toEqual({});
  });

  it("offers a staged filename in an upload node's image dropdown", async () => {
    const { cookie, csrf } = await loginSession();
    const w1 = await registerWorker(cookie, csrf, "w1");
    await seedObjectInfo(w1, "h1", {
      LoadImage: {
        input: {
          required: {
            image: [["existing.png"], { image_upload: true }],
          },
        },
      },
    });

    // Build the multipart request directly -- helpers/http.ts's `call` only
    // supports json/rawBody bodies.
    const form = new FormData();
    form.set("image", new File([new Uint8Array([1, 2, 3])], "ref.png", { type: "image/png" }));
    const uploadReq = new Request("http://example.com/comfy/api/upload/image", {
      method: "POST",
      headers: { Cookie: cookie ?? "" },
      body: form,
    });
    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    const uploadRes = await worker.fetch(uploadReq, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(uploadRes.status).toBe(200);

    const r = await call("/comfy/api/object_info", { method: "GET", cookie });
    expect(r.body.LoadImage.input.required.image[0]).toEqual(["existing.png", "ref.png"]);
  });
});

// --- POST /prompt ----------------------------------------------------------

describe("POST /comfy/api/prompt", () => {
  it("creates a job visible via /api/jobs", async () => {
    const { cookie } = await loginSession();
    const r = await postPrompt(cookie);
    expect(r.status).toBe(200);
    expect(r.body.node_errors).toEqual({});
    const jobId = r.body.prompt_id;

    const list = await call("/api/jobs", { method: "GET", cookie });
    expect(list.body.some((j: any) => j.id === jobId && j.origin === "panel")).toBe(true);
  });

  it("rejects a non-dict prompt", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/api/prompt", { json: { prompt: "nope" }, cookie });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("invalid_prompt");
  });

  it("rejects a body with no prompt key", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/api/prompt", { json: { not_prompt: {} }, cookie });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("no_prompt");
  });

  it("rejects an unstaged asset reference with a comfy-shaped error and persists nothing", async () => {
    const { cookie } = await loginSession();
    const prompt = { "1": { class_type: "LoadImage", inputs: { image: "ref.png" } } };
    const r = await postPrompt(cookie, prompt);
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("invalid_prompt");
    expect(r.body.error.message + (r.body.error.details ?? "")).toContain("ref.png");
    expect(r.body.node_errors).toEqual({});

    const list = await call("/api/jobs", { method: "GET", cookie });
    expect(list.body).toHaveLength(0);
  });

  const FLUX_PROMPT = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev.safetensors" } },
    "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
  };

  it("rejects with the byte-parity zh-TW missing-model shape and per-node node_errors", async () => {
    const { cookie, csrf } = await loginSession();
    const w1 = await registerWorker(cookie, csrf, "runner-1");
    await setWorkerRow(w1, { modelInventory: [{ name: "diffusion_models/other.safetensors", size: 1.0 }] });

    const r = await postPrompt(cookie, FLUX_PROMPT);
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("prompt.missing_models");

    const message = r.body.error.message;
    expect(message).toBe("缺少模型：flux1-dev.safetensors，無法執行——詳見下方下載指引");
    expect(message).not.toContain("\n");

    const details = r.body.error.details;
    expect(details).toContain(
      "官方載點：https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"
    );
    expect(details).toContain(
      "備份載點：https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors"
    );

    const nodeErrors = r.body.node_errors;
    expect(Object.keys(nodeErrors)).toEqual(["1"]);
    const entry = nodeErrors["1"];
    expect(entry.class_type).toBe("UNETLoader");
    expect(entry.dependent_outputs).toEqual([]);
    expect(entry.errors).toHaveLength(1);
    const err = entry.errors[0];
    expect(err.type).toBe("comfyfed.missing_model");
    expect(err.message).toBe("缺少模型：flux1-dev.safetensors，無法執行——詳見下方下載指引");
    expect(err.extra_info).toEqual({});
    expect(err.details).toContain("官方載點：");
    expect(err.details).not.toContain("無法執行：聯邦裡所有已註冊的 worker");

    const list = await call("/api/jobs", { method: "GET", cookie });
    expect(list.body).toHaveLength(0);
  });

  it("node_errors: one model referenced by two nodes gets an entry under each node id", async () => {
    const { cookie, csrf } = await loginSession();
    await registerWorker(cookie, csrf, "runner-1");
    const prompt = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "flux1-dev.safetensors" } },
      "2": { class_type: "UNETLoader", inputs: { unet_name: "flux1-dev.safetensors" } },
    };
    const r = await postPrompt(cookie, prompt);
    expect(r.status).toBe(400);
    const nodeErrors = r.body.node_errors;
    expect(Object.keys(nodeErrors).sort()).toEqual(["1", "2"]);
    expect(nodeErrors["1"].class_type).toBe("CheckpointLoaderSimple");
    expect(nodeErrors["2"].class_type).toBe("UNETLoader");
    for (const id of ["1", "2"]) {
      expect(nodeErrors[id].errors).toHaveLength(1);
      expect(nodeErrors[id].errors[0].message).toBe("缺少模型：flux1-dev.safetensors，無法執行——詳見下方下載指引");
    }
  });

  it("node_errors: two models referenced by one node both land on that node", async () => {
    const { cookie, csrf } = await loginSession();
    await registerWorker(cookie, csrf, "runner-1");
    const prompt = {
      "1": {
        class_type: "DualCLIPLoader",
        inputs: { clip_name1: "clip_l.safetensors", clip_name2: "t5xxl_fp16.safetensors" },
      },
    };
    const r = await postPrompt(cookie, prompt);
    expect(r.status).toBe(400);
    const entry = r.body.node_errors["1"];
    expect(entry.errors).toHaveLength(2);
    const messages = new Set(entry.errors.map((e: any) => e.message));
    expect(messages).toEqual(
      new Set([
        "缺少模型：clip_l.safetensors，無法執行——詳見下方下載指引",
        "缺少模型：t5xxl_fp16.safetensors，無法執行——詳見下方下載指引",
      ])
    );
  });

  it("Phase 3.2: queues a zero-holder curated model via its guide hash alone", async () => {
    // flux1-dev.safetensors is curated with an operator-vouched sha256/
    // sizeBytes in model_guide.SOURCES -- the manifest signs a zero-holder
    // entry for it straight from those values, with NO worker ever having
    // reported an inventory hash (model_manifest.recordHash is never called
    // here). An online, opted-in, disk-capable worker is then enough to
    // queue the job instead of 400ing with a manual-download prompt.
    const { cookie, csrf } = await loginSession();
    const fetcher = await registerWorker(cookie, csrf, "fetcher");
    await setWorkerRow(fetcher, {
      protocol: 3,
      autoFetch: true,
      dynamic: { free_disk_gb: 100.0 },
      hardware: { max_fetch_gb: 100 },
    });

    const r = await postPrompt(cookie, FLUX_PROMPT);
    expect(r.status).toBe(200);
  });

  it("Phase 3.2: a genuinely unknown model still 400s even with a fetch-capable worker standing by", async () => {
    // Unlike the 11 curated models, a name with neither a curated guide hash
    // nor a harvested source nor a learned consensus never gets a manifest
    // entry at all -- still a hard 400.
    const { cookie, csrf } = await loginSession();
    const fetcher = await registerWorker(cookie, csrf, "fetcher");
    await setWorkerRow(fetcher, { protocol: 3, autoFetch: true, dynamic: { free_disk_gb: 100.0 } });

    const prompt = {
      "1": { class_type: "UNETLoader", inputs: { unet_name: "totally_unknown_model.safetensors" } },
    };
    const r = await postPrompt(cookie, prompt);
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("prompt.missing_models");
  });

  it("still queues with zero workers registered", async () => {
    const { cookie } = await loginSession();
    const r = await postPrompt(cookie, FLUX_PROMPT);
    expect(r.status).toBe(200);
  });

  it("queues when the only worker with the model is offline (fleet-wide, not online-only)", async () => {
    const { cookie, csrf } = await loginSession();
    const w1 = await registerWorker(cookie, csrf, "runner-1");
    await setWorkerRow(w1, { status: "offline", modelInventory: [{ name: "flux1-dev.safetensors", size: 1 }] });
    const r = await postPrompt(cookie, FLUX_PROMPT);
    expect(r.status).toBe(200);
  });

  it("queues when a disabled worker has the model", async () => {
    const { cookie, csrf } = await loginSession();
    const w1 = await registerWorker(cookie, csrf, "runner-1");
    await setWorkerRow(w1, { disabled: true, modelInventory: [{ name: "flux1-dev.safetensors", size: 1 }] });
    const r = await postPrompt(cookie, FLUX_PROMPT);
    expect(r.status).toBe(200);
  });
});

// --- queue / interrupt (origin scoping) -------------------------------------

describe("origin scoping: interrupt and queue mutations only ever touch panel jobs", () => {
  it("POST /interrupt is a no-op 200 when nothing is running", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/api/interrupt", { method: "POST", cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({});
  });

  it("POST /queue delete only cancels named panel-origin jobs, ignoring a console-origin id", async () => {
    const { cookie, csrf } = await loginSession();
    const panelJob = (await postPrompt(cookie)).body.prompt_id;

    // A console-origin job, submitted the way /api/jobs expects (multipart).
    const form = new FormData();
    form.set("workflow_json", JSON.stringify(SIMPLE_PROMPT));
    const consoleReq = new Request("http://example.com/api/jobs", {
      method: "POST",
      headers: { Cookie: cookie ?? "", "X-CSRF": csrf },
      body: form,
    });
    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    const consoleRes = await worker.fetch(consoleReq, env as any, ctx);
    await waitOnExecutionContext(ctx);
    const consoleJob = (await consoleRes.json<{ job_id: string }>()).job_id;

    const r = await call("/comfy/api/queue", {
      json: { delete: [panelJob, consoleJob] },
      cookie,
    });
    expect(r.status).toBe(200);

    const panelRow = await db().prepare("SELECT status FROM jobs WHERE id = ?").bind(panelJob).first<{ status: string }>();
    const consoleRow = await db().prepare("SELECT status FROM jobs WHERE id = ?").bind(consoleJob).first<{ status: string }>();
    expect(panelRow?.status).toBe("cancelled");
    expect(consoleRow?.status).toBe("queued");
  });

  it("POST /interrupt still answers 200 empty when the Hub DO call throws (M1, panel fire-and-forget parity)", async () => {
    const { cookie } = await loginSession();
    const jobId = (await postPrompt(cookie)).body.prompt_id;
    await db().prepare("UPDATE jobs SET status = 'running' WHERE id = ?").bind(jobId).run();

    const hub = (env as any).HUB;
    const getSpy = vi.spyOn(hub, "get").mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error("DO evicted")),
    });
    try {
      const r = await call("/comfy/api/interrupt", { method: "POST", cookie });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({});
    } finally {
      getSpy.mockRestore();
    }
  });

  it("POST /queue delete still answers 200 when the Hub DO call throws for one job (M1)", async () => {
    const { cookie, csrf } = await loginSession();
    const panelJob = (await postPrompt(cookie)).body.prompt_id;

    const hub = (env as any).HUB;
    const getSpy = vi.spyOn(hub, "get").mockReturnValue({
      fetch: vi.fn().mockRejectedValue(new Error("DO evicted")),
    });
    try {
      const r = await call("/comfy/api/queue", { json: { delete: [panelJob] }, cookie });
      expect(r.status).toBe(200);
    } finally {
      getSpy.mockRestore();
    }
  });
});

// --- history -----------------------------------------------------------------

describe("GET/POST /comfy/api/history", () => {
  it("reports a done job's shape and excludes it once hidden", async () => {
    const { cookie } = await loginSession();
    const jobId = (await postPrompt(cookie)).body.prompt_id;
    await finishJob(jobId, { status: "done", resultFiles: ["out.png"] });

    const before = await call("/comfy/api/history", { method: "GET", cookie });
    expect(before.body[jobId].status).toEqual({ status_str: "success", completed: true, messages: [] });
    expect(before.body[jobId].outputs["2"].images[0]).toEqual({ filename: "out.png", subfolder: jobId, type: "output" });

    const hide = await call("/comfy/api/history", { json: { delete: [jobId] }, cookie });
    expect(hide.status).toBe(200);

    const after = await call("/comfy/api/history", { method: "GET", cookie });
    expect(after.body[jobId]).toBeUndefined();

    const byId = await call(`/comfy/api/history/${jobId}`, { method: "GET", cookie });
    expect(byId.body).toEqual({});
  });

  it("includes a failed job with an execution_error message", async () => {
    const { cookie } = await loginSession();
    const jobId = (await postPrompt(cookie)).body.prompt_id;
    await finishJob(jobId, { status: "failed", error: "boom" });

    const r = await call("/comfy/api/history", { method: "GET", cookie });
    expect(r.body[jobId].status.status_str).toBe("error");
    expect(r.body[jobId].status.messages).toEqual([["execution_error", { prompt_id: jobId, exception_message: "boom" }]]);
  });

  it("history clear hides every panel job but never a console-origin one", async () => {
    const { cookie, csrf } = await loginSession();
    const panelJob = (await postPrompt(cookie)).body.prompt_id;
    await finishJob(panelJob, { status: "done", resultFiles: ["a.png"] });

    const form = new FormData();
    form.set("workflow_json", JSON.stringify(SIMPLE_PROMPT));
    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    const consoleRes = await worker.fetch(
      new Request("http://example.com/api/jobs", {
        method: "POST",
        headers: { Cookie: cookie ?? "", "X-CSRF": csrf },
        body: form,
      }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);
    const consoleJob = (await consoleRes.json<{ job_id: string }>()).job_id;
    await finishJob(consoleJob, { status: "done", resultFiles: ["b.png"] });

    const r = await call("/comfy/api/history", { json: { clear: true }, cookie });
    expect(r.status).toBe(200);

    const afterHistory = await call("/comfy/api/history", { method: "GET", cookie });
    expect(afterHistory.body).toEqual({});

    const consoleRow = await db().prepare("SELECT panel_hidden FROM jobs WHERE id = ?").bind(consoleJob).first<{ panel_hidden: number }>();
    expect(consoleRow?.panel_hidden).toBe(0);
  });
});

// --- /view -------------------------------------------------------------------

describe("GET /comfy/api/view", () => {
  it("streams a done job's artifact", async () => {
    const { cookie } = await loginSession();
    const jobId = (await postPrompt(cookie)).body.prompt_id;
    await finishJob(jobId, { status: "done", resultFiles: ["out.png"], bytes: new TextEncoder().encode("IMGDATA") });

    const r = await call("/comfy/api/view?filename=out.png", { method: "GET", cookie });
    expect(r.status).toBe(200);
  });

  it("scopes a colliding filename to its own job via subfolder", async () => {
    const { cookie } = await loginSession();
    const name = "ComfyUI_00001_.png";
    const job1 = (await postPrompt(cookie)).body.prompt_id;
    await finishJob(job1, { status: "done", resultFiles: [name], bytes: new TextEncoder().encode("FIRST") });
    const job2 = (await postPrompt(cookie)).body.prompt_id;
    await finishJob(job2, { status: "done", resultFiles: [name], bytes: new TextEncoder().encode("SECOND") });

    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");

    async function viewText(subfolder: string): Promise<string> {
      const ctx = createExecutionContext();
      const res = await worker.fetch(
        new Request(`http://example.com/comfy/api/view?filename=${name}&type=output&subfolder=${subfolder}`, {
          headers: { Cookie: cookie ?? "" },
        }),
        env as any,
        ctx
      );
      await waitOnExecutionContext(ctx);
      return res.text();
    }

    expect(await viewText(job1)).toBe("FIRST");
    expect(await viewText(job2)).toBe("SECOND");
  });

  it("404s for a subfolder job that never produced the named file", async () => {
    const { cookie } = await loginSession();
    const job1 = (await postPrompt(cookie)).body.prompt_id;
    await finishJob(job1, { status: "done", resultFiles: ["mine.png"] });
    const job2 = (await postPrompt(cookie)).body.prompt_id;
    await finishJob(job2, { status: "done", resultFiles: ["other.png"] });

    const r = await call(`/comfy/api/view?filename=mine.png&type=output&subfolder=${job2}`, { method: "GET", cookie });
    expect(r.status).toBe(404);
  });

  it("rejects a path-traversal subfolder with 400", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/api/view?filename=out.png&type=output&subfolder=../../etc", { method: "GET", cookie });
    expect(r.status).toBe(400);
  });

  it("rejects a path-traversal filename with 400", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/api/view?filename=../../etc/passwd", { method: "GET", cookie });
    expect(r.status).toBe(400);
  });

  it("404s for an unknown filename", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/api/view?filename=missing.png", { method: "GET", cookie });
    expect(r.status).toBe(404);
  });

  it("type=input 404s until the staged file exists, then serves it", async () => {
    const { cookie } = await loginSession();
    const before = await call("/comfy/api/view?filename=ref.png&type=input", { method: "GET", cookie });
    expect(before.status).toBe(404);

    const form = new FormData();
    form.set("image", new File([new TextEncoder().encode("STAGED")], "ref.png", { type: "image/png" }));
    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    await worker.fetch(
      new Request("http://example.com/comfy/api/upload/image", { method: "POST", headers: { Cookie: cookie ?? "" }, body: form }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);

    const after = await call("/comfy/api/view?filename=ref.png&type=input", { method: "GET", cookie });
    expect(after.status).toBe(200);
  });
});

// --- upload/image ------------------------------------------------------------

describe("POST /comfy/api/upload/image", () => {
  it("requires an admin session", async () => {
    const r = await call("/comfy/api/upload/image", { method: "POST" });
    expect(r.status).toBe(401);
  });

  it("copies a staged asset into the job's inputs at prompt submission", async () => {
    const { cookie } = await loginSession();
    const form = new FormData();
    form.set("image", new File([new TextEncoder().encode("STAGED")], "ref.png", { type: "image/png" }));
    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    const uploadRes = await worker.fetch(
      new Request("http://example.com/comfy/api/upload/image", { method: "POST", headers: { Cookie: cookie ?? "" }, body: form }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(await uploadRes.json()).toEqual({ name: "ref.png", subfolder: "", type: "input" });

    const prompt = { "1": { class_type: "LoadImage", inputs: { image: "ref.png" } } };
    const r = await postPrompt(cookie, prompt);
    expect(r.status).toBe(200);
    const jobId = r.body.prompt_id;

    const inputObj = await store().get(`job_inputs/${jobId}/ref.png`);
    expect(inputObj).not.toBeNull();
    expect(await inputObj!.text()).toBe("STAGED");

    // Copy, not move -- the staged file is still there for reuse.
    const adminRow = await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>();
    expect(await store().get(`staging/${adminRow!.id}/ref.png`)).not.toBeNull();
  });
});

async function uploadImage(cookie: string | null, filename: string, content: string): Promise<Response> {
  const form = new FormData();
  form.set("image", new File([new TextEncoder().encode(content)], filename, { type: "image/png" }));
  const worker = (await import("../src/index")).default;
  const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("http://example.com/comfy/api/upload/image", { method: "POST", headers: { Cookie: cookie ?? "" }, body: form }),
    env as any,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

describe("panel input staging is isolated between users (final review finding #1)", () => {
  it("B cannot view or overwrite A's staged input; A's next /prompt uses her own file", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    await uploadImage(alice.cookie, "reference.png", "ALICE-BYTES");

    // Bob cannot view Alice's staged file even though he knows its exact name.
    const bobView = await call("/comfy/api/view?filename=reference.png&type=input", { method: "GET", cookie: bob.cookie });
    expect(bobView.status).toBe(404);

    // Bob's own object_info dropdown does not list Alice's staged file.
    const w1 = await registerWorker(admin.cookie, admin.csrf, "w1");
    await seedObjectInfo(w1, "h1", {
      LoadImage: { input: { required: { image: [[], { image_upload: true }] } } },
    });
    const bobObjectInfo = await call("/comfy/api/object_info", { method: "GET", cookie: bob.cookie });
    expect(bobObjectInfo.body.LoadImage?.input?.required?.image?.[0] ?? []).not.toContain("reference.png");

    // Bob uploads a same-named file -- it must NOT overwrite Alice's.
    const bobUpload = await uploadImage(bob.cookie, "reference.png", "BOB-BYTES");
    expect(bobUpload.status).toBe(200);

    const aliceRow = await db().prepare("SELECT id FROM users WHERE username = 'alice'").first<{ id: string }>();
    const aliceStaged = await store().get(`staging/${aliceRow!.id}/reference.png`);
    expect(await aliceStaged!.text()).toBe("ALICE-BYTES");

    // Alice's own next /prompt still resolves against her own file.
    const prompt = { "1": { class_type: "LoadImage", inputs: { image: "reference.png" } } };
    const r = await postPrompt(alice.cookie, prompt);
    expect(r.status).toBe(200);
    const jobId = r.body.prompt_id;
    const jobInput = await store().get(`job_inputs/${jobId}/reference.png`);
    expect(await jobInput!.text()).toBe("ALICE-BYTES");
  });
});

// --- bootstrap / settings ------------------------------------------------------

describe("panel bootstrap routes", () => {
  const emptyShapeCases: [string, unknown][] = [
    ["/comfy/api/features", {}],
    ["/comfy/api/users", { storage: "server", migrated: false }],
    ["/comfy/api/extensions", ["/api/comfyfed-ext/comfyfed.js"]],
    ["/comfy/api/embeddings", []],
    ["/comfy/api/models", []],
    ["/comfy/api/i18n", {}],
    ["/comfy/api/global_subgraphs", {}],
    ["/comfy/api/folder_paths", {}],
    ["/comfy/api/workflow_templates", {}],
  ];

  for (const [path, expected] of emptyShapeCases) {
    it(`${path} returns the empty upstream shape`, async () => {
      const { cookie } = await loginSession();
      const r = await call(path, { method: "GET", cookie });
      expect(r.status).toBe(200);
      expect(r.body).toEqual(expected);
    });
  }

  it("system_stats reports no local devices and the online worker count", async () => {
    const { cookie, csrf } = await loginSession();
    await registerWorker(cookie, csrf, "w1");
    const r = await call("/comfy/api/system_stats", { method: "GET", cookie });
    expect(r.body.devices).toEqual([]);
    expect(r.body.system.comfyfed_online_workers).toBe(1);
  });

  it("GET /prompt reports queue_remaining", async () => {
    const { cookie } = await loginSession();
    await postPrompt(cookie);
    const r = await call("/comfy/api/prompt", { method: "GET", cookie });
    expect(r.body).toEqual({ exec_info: { queue_remaining: 1 } });
  });

  it("the packaged extension JS is served and requires a session", async () => {
    const anon = await call("/comfy/api/comfyfed-ext/comfyfed.js", { method: "GET" });
    expect(anon.status).toBe(401);

    const { cookie } = await loginSession();
    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/comfy/api/comfyfed-ext/comfyfed.js", { headers: { Cookie: cookie ?? "" } }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("comfyfed.hideLoginButton");
  });

  it("panel settings round-trip and persist across requests", async () => {
    const { cookie } = await loginSession();
    const first = await call("/comfy/api/settings", { json: { theme: "dark" }, cookie });
    expect(first.status).toBe(200);

    const single = await call("/comfy/api/settings/theme", { method: "GET", cookie });
    expect(single.body).toBe("dark");

    const unset = await call("/comfy/api/settings/unset-key", { method: "GET", cookie });
    expect(unset.body).toBeNull();

    await call("/comfy/api/settings/theme", { json: "light", cookie });
    const after = await call("/comfy/api/settings", { method: "GET", cookie });
    expect(after.body).toEqual({ theme: "light" });
  });

  it("settings are isolated between users, with the pre-existing legacy blob as a fallback default (final review finding #7)", async () => {
    const admin = await loginSession();
    // A legacy, pre-Task-4 global row (no per-uid suffix), as if written
    // before this fix shipped.
    await db()
      .prepare("INSERT INTO settings (key, value) VALUES ('comfy_settings_json', ?)")
      .bind(JSON.stringify({ theme: "legacy-theme" }))
      .run();

    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    // Alice has never written her own settings -- she reads the legacy blob.
    const aliceBefore = await call("/comfy/api/settings", { method: "GET", cookie: alice.cookie });
    expect(aliceBefore.body).toEqual({ theme: "legacy-theme" });

    // Alice writes her own setting -- forks her OWN row from here on.
    await call("/comfy/api/settings", { json: { zoom: 2.0 }, cookie: alice.cookie });
    const aliceAfter = await call("/comfy/api/settings", { method: "GET", cookie: alice.cookie });
    expect(aliceAfter.body).toEqual({ theme: "legacy-theme", zoom: 2.0 });

    // Bob, who has also never written his own settings, still reads the
    // legacy blob -- Alice's write did not touch it.
    const bobBefore = await call("/comfy/api/settings", { method: "GET", cookie: bob.cookie });
    expect(bobBefore.body).toEqual({ theme: "legacy-theme" });

    // Bob's own write is independent of Alice's.
    await call("/comfy/api/settings", { json: { theme: "bobs-theme" }, cookie: bob.cookie });
    const bobAfter = await call("/comfy/api/settings", { method: "GET", cookie: bob.cookie });
    expect(bobAfter.body).toEqual({ theme: "bobs-theme" });

    // Alice's settings are untouched by Bob's write.
    const aliceStill = await call("/comfy/api/settings", { method: "GET", cookie: alice.cookie });
    expect(aliceStill.body).toEqual({ theme: "legacy-theme", zoom: 2.0 });
  });
});

// ---------------------------------------------------------------------------
// Phase 3.0 Task 10: panel per-user scoping -- parity port of the Python
// Task 4 rule that the panel is a per-user workspace for EVERY role,
// including admin: every panel-native read/control is scoped to
// `origin === "panel" AND user_id === <the session's own uid>`, so a second
// user's (or admin's own OTHER surface's) panel jobs never leak across.

describe("Phase 3.0: panel per-user scoping", () => {
  it("a non-admin user can reach the panel surface (widened from admin-only in Task 4)", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");

    const r = await postPrompt(alice.cookie);
    expect(r.status).toBe(200);
    expect(typeof r.body.prompt_id).toBe("string");

    const queue = await call("/comfy/api/queue", { method: "GET", cookie: alice.cookie });
    expect(queue.status).toBe(200);
  });

  it("GET /queue: each user's panel queue shows only their own pending/running jobs", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    const aliceJob = (await postPrompt(alice.cookie)).body.prompt_id;
    const bobJob = (await postPrompt(bob.cookie)).body.prompt_id;

    const aliceQueue = await call("/comfy/api/queue", { method: "GET", cookie: alice.cookie });
    const aliceIds = [...aliceQueue.body.queue_running, ...aliceQueue.body.queue_pending].map((e: any) => e[1]);
    expect(aliceIds).toContain(aliceJob);
    expect(aliceIds).not.toContain(bobJob);

    const bobQueue = await call("/comfy/api/queue", { method: "GET", cookie: bob.cookie });
    const bobIds = [...bobQueue.body.queue_running, ...bobQueue.body.queue_pending].map((e: any) => e[1]);
    expect(bobIds).toContain(bobJob);
    expect(bobIds).not.toContain(aliceJob);
  });

  it("admin's own panel excludes another user's panel jobs -- full fleet visibility lives in the console, not here", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");

    const aliceJob = (await postPrompt(alice.cookie)).body.prompt_id;
    const adminJob = (await postPrompt(admin.cookie)).body.prompt_id;

    const adminQueue = await call("/comfy/api/queue", { method: "GET", cookie: admin.cookie });
    const adminIds = [...adminQueue.body.queue_running, ...adminQueue.body.queue_pending].map((e: any) => e[1]);
    expect(adminIds).toContain(adminJob);
    expect(adminIds).not.toContain(aliceJob);

    // The console's /api/jobs list, by contrast, is admin's full-fleet view.
    const consoleList = await call("/api/jobs", { method: "GET", cookie: admin.cookie });
    const consoleIds = consoleList.body.map((j: any) => j.id);
    expect(consoleIds).toContain(aliceJob);
    expect(consoleIds).toContain(adminJob);
  });

  it("GET /history: each user's panel history shows only their own done jobs", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    const aliceJob = (await postPrompt(alice.cookie)).body.prompt_id;
    const bobJob = (await postPrompt(bob.cookie)).body.prompt_id;
    await finishJob(aliceJob, { status: "done", resultFiles: ["a.png"] });
    await finishJob(bobJob, { status: "done", resultFiles: ["b.png"] });

    const aliceHistory = await call("/comfy/api/history", { method: "GET", cookie: alice.cookie });
    expect(aliceHistory.body[aliceJob]).toBeDefined();
    expect(aliceHistory.body[bobJob]).toBeUndefined();

    const bobHistory = await call("/comfy/api/history", { method: "GET", cookie: bob.cookie });
    expect(bobHistory.body[bobJob]).toBeDefined();
    expect(bobHistory.body[aliceJob]).toBeUndefined();

    // GET /history/{id} (upstream's "{}" for an unresolvable id) also
    // refuses to resolve another user's job.
    const aliceByBobId = await call(`/comfy/api/history/${bobJob}`, { method: "GET", cookie: alice.cookie });
    expect(aliceByBobId.body).toEqual({});
  });

  it("POST /history hide (delete + clear) never touches another user's panel jobs", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    const aliceJob = (await postPrompt(alice.cookie)).body.prompt_id;
    const bobJob = (await postPrompt(bob.cookie)).body.prompt_id;
    await finishJob(aliceJob, { status: "done", resultFiles: ["a.png"] });
    await finishJob(bobJob, { status: "done", resultFiles: ["b.png"] });

    // Alice's explicit delete-by-id naming Bob's job must not hide it.
    await call("/comfy/api/history", { json: { delete: [bobJob] }, cookie: alice.cookie });
    const bobRow = await db().prepare("SELECT panel_hidden FROM jobs WHERE id = ?").bind(bobJob).first<{ panel_hidden: number }>();
    expect(bobRow?.panel_hidden).toBe(0);

    // Alice's clear must only hide her own, never Bob's.
    await call("/comfy/api/history", { json: { clear: true }, cookie: alice.cookie });
    const aliceRow = await db().prepare("SELECT panel_hidden FROM jobs WHERE id = ?").bind(aliceJob).first<{ panel_hidden: number }>();
    const bobRowAfter = await db().prepare("SELECT panel_hidden FROM jobs WHERE id = ?").bind(bobJob).first<{ panel_hidden: number }>();
    expect(aliceRow?.panel_hidden).toBe(1);
    expect(bobRowAfter?.panel_hidden).toBe(0);
  });

  it("POST /interrupt only ever cancels the caller's own running panel job", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    const aliceJob = (await postPrompt(alice.cookie)).body.prompt_id;
    const bobJob = (await postPrompt(bob.cookie)).body.prompt_id;
    await db().prepare("UPDATE jobs SET status = 'running' WHERE id IN (?, ?)").bind(aliceJob, bobJob).run();

    await call("/comfy/api/interrupt", { method: "POST", cookie: alice.cookie });

    const aliceRow = await db().prepare("SELECT status FROM jobs WHERE id = ?").bind(aliceJob).first<{ status: string }>();
    const bobRow = await db().prepare("SELECT status FROM jobs WHERE id = ?").bind(bobJob).first<{ status: string }>();
    expect(aliceRow?.status).toBe("cancelled");
    expect(bobRow?.status).toBe("running");
  });

  it("POST /queue delete only cancels the caller's own named job, ignoring another user's id", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    const aliceJob = (await postPrompt(alice.cookie)).body.prompt_id;
    const bobJob = (await postPrompt(bob.cookie)).body.prompt_id;

    await call("/comfy/api/queue", { json: { delete: [aliceJob, bobJob] }, cookie: alice.cookie });

    const aliceRow = await db().prepare("SELECT status FROM jobs WHERE id = ?").bind(aliceJob).first<{ status: string }>();
    const bobRow = await db().prepare("SELECT status FROM jobs WHERE id = ?").bind(bobJob).first<{ status: string }>();
    expect(aliceRow?.status).toBe("cancelled");
    expect(bobRow?.status).toBe("queued");
  });

  it("GET /view: 404s for another user's panel output (both the subfolder and legacy fallback paths)", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    const aliceJob = (await postPrompt(alice.cookie)).body.prompt_id;
    await finishJob(aliceJob, { status: "done", resultFiles: ["out.png"], bytes: new TextEncoder().encode("alices-bytes") });

    // Owner can view it (subfolder-qualified).
    const asOwner = await call(`/comfy/api/view?filename=out.png&subfolder=${aliceJob}`, { method: "GET", cookie: alice.cookie });
    expect(asOwner.status).toBe(200);
    expect(asOwner.body).toBe("alices-bytes");

    // Another user, naming the exact same subfolder (job id), is refused.
    const asOther = await call(`/comfy/api/view?filename=out.png&subfolder=${aliceJob}`, { method: "GET", cookie: bob.cookie });
    expect(asOther.status).toBe(404);

    // The subfolder-less legacy fallback must not let Bob find Alice's file
    // by filename alone either.
    const asOtherLegacy = await call("/comfy/api/view?filename=out.png", { method: "GET", cookie: bob.cookie });
    expect(asOtherLegacy.status).toBe(404);
  });

  it("POST /prompt stamps user_id with the submitting session's own uid", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const jobId = (await postPrompt(alice.cookie)).body.prompt_id;

    const row = await db().prepare("SELECT origin, user_id FROM jobs WHERE id = ?").bind(jobId).first<any>();
    expect(row.origin).toBe("panel");
    const aliceRow = await db().prepare("SELECT id FROM users WHERE username = 'alice'").first<{ id: string }>();
    expect(row.user_id).toBe(aliceRow!.id);
  });
});

// ---------------------------------------------------------------------------
// Unimplemented /comfy/api/* endpoints must 404 as JSON, never fall through
// to the SPA asset fallback (live-caught: `experiment/models` came back as
// 200 + index.html and the panel's .json() threw a red toast on every load).

describe("unmatched /comfy/api/* routes", () => {
  it("returns JSON 404, not the SPA's index.html", async () => {
    const admin = await loginSession();
    for (const path of ["/comfy/api/experiment/models", "/comfy/api/definitely/not/a/route"]) {
      const res = await call(path, { method: "GET", cookie: admin.cookie });
      expect(res.status).toBe(404);
      // Parsed body with our error shape proves JSON came back, not the
      // SPA's index.html (which would fail call()'s JSON parse or carry no
      // `error` field).
      expect(res.body.error).toBe("not_found");
    }
  });

  it("leaves real comfy api routes and the SPA page itself untouched", async () => {
    const admin = await loginSession();
    const real = await call("/comfy/api/embeddings", { method: "GET", cookie: admin.cookie });
    expect(real.status).toBe(200);
    expect(real.body).toEqual([]);
  });
});

// --- Phase 3.3 §3.7: the panel only ever sees the parent ---------------------
//
// JSON-shape parity with the original Python suite: the same keys and
// nesting the Python `/history` / `/queue` surfaces return.

describe("split families on the panel surface (§3.7)", () => {
  const SPLIT_WORKFLOW = JSON.stringify({ "2": { class_type: "SaveImage", inputs: {} } });

  /** Parent + children written straight to D1 (the splitting itself is
   * split.spec.ts / dispatch.spec.ts' business), all `origin: "panel"` and
   * owned by `uid` -- children inherit both from the parent. */
  async function makeSplitFamily(uid: string, opts: { parentStatus?: string; childStatuses?: string[] } = {}) {
    const parentStatus = opts.parentStatus ?? "done";
    const childStatuses = opts.childStatuses ?? ["done", "done"];
    const now = toSqliteTimestamp(new Date());
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, finished_at, input_assets, origin, user_id, split_count)
         VALUES ('p', ?, ?, ?, ?, '[]', 'panel', ?, ?)`
      )
      .bind(SPLIT_WORKFLOW, parentStatus, now, parentStatus === "done" ? now : null, uid, childStatuses.length)
      .run();
    for (let index = 0; index < childStatuses.length; index++) {
      const status = childStatuses[index]!;
      const files = status === "done" ? [`c${index}.png`] : [];
      await db()
        .prepare(
          `INSERT INTO jobs (id, workflow_json, status, created_at, finished_at, input_assets, origin,
                             user_id, parent_id, split_index, result_files)
           VALUES (?, ?, ?, ?, ?, '[]', 'panel', ?, 'p', ?, ?)`
        )
        .bind(`c${index}`, SPLIT_WORKFLOW, status, now, status === "done" ? now : null, uid, index, JSON.stringify(files))
        .run();
      for (const name of files) {
        await store().put(artifactKey(`c${index}`, name), new TextEncoder().encode(`bytes-${index}`));
      }
    }
  }

  async function adminUid(): Promise<string> {
    const row = await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<any>();
    return row.id;
  }

  it("hides children from /history and merges their outputs into the parent", async () => {
    const { cookie } = await loginSession();
    await makeSplitFamily(await adminUid());

    const r = await call("/comfy/api/history", { method: "GET", cookie });
    expect(Object.keys(r.body)).toEqual(["p"]);
    expect(r.body.p.outputs["2"].images).toEqual([
      { filename: "c0.png", subfolder: "c0", type: "output" },
      { filename: "c1.png", subfolder: "c1", type: "output" },
    ]);
  });

  it("answers {} for a child's id on /history/:promptId", async () => {
    const { cookie } = await loginSession();
    await makeSplitFamily(await adminUid());

    expect((await call("/comfy/api/history/c0", { method: "GET", cookie })).body).toEqual({});
    expect(Object.keys((await call("/comfy/api/history/p", { method: "GET", cookie })).body)).toEqual(["p"]);
  });

  it("hides children from /queue", async () => {
    const { cookie } = await loginSession();
    await makeSplitFamily(await adminUid(), { parentStatus: "running", childStatuses: ["running", "queued"] });

    const r = await call("/comfy/api/queue", { method: "GET", cookie });
    const ids = [...r.body.queue_running, ...r.body.queue_pending].map((entry: any[]) => entry[1]);
    expect(ids).toEqual(["p"]);
  });

  it("hides the whole family when the parent is hidden from history", async () => {
    const { cookie } = await loginSession();
    await makeSplitFamily(await adminUid());

    const hide = await call("/comfy/api/history", { json: { delete: ["p"] }, cookie });
    expect(hide.status).toBe(200);
    expect((await call("/comfy/api/history", { method: "GET", cookie })).body).toEqual({});
  });

  /** `call()` parses JSON; these two need the raw body/status of a binary
   * artifact response, so they go through the worker directly (same shape the
   * colliding-filename test above uses). */
  async function viewRaw(cookie: string | null): Promise<Response> {
    const worker = (await import("../src/index")).default;
    const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/comfy/api/view?filename=c1.png&type=output&subfolder=c1", {
        headers: { Cookie: cookie ?? "" },
      }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("serves a child's file through the child id as the /view subfolder", async () => {
    const { cookie } = await loginSession();
    await makeSplitFamily(await adminUid());

    const r = await viewRaw(cookie);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("bytes-1");
  });

  it("refuses another user's child file", async () => {
    const admin = await loginSession();
    const other = await userSession(admin, "mallory");
    await makeSplitFamily(await adminUid());

    expect((await viewRaw(other.cookie)).status).toBe(404);
  });

  it("keeps each child as the owner of a colliding filename", async () => {
    // Every worker numbers `ComfyUI_00001_.png` from its own counter, so two
    // children of one parent routinely produce the SAME filename -- each
    // entry must keep ITS OWN child as the subfolder.
    const { cookie } = await loginSession();
    await makeSplitFamily(await adminUid());
    await db()
      .prepare("UPDATE jobs SET result_files = ? WHERE parent_id = 'p'")
      .bind(JSON.stringify(["ComfyUI_00001_.png"]))
      .run();

    const r = await call("/comfy/api/history", { method: "GET", cookie });
    expect(r.body.p.outputs["2"].images).toEqual([
      { filename: "ComfyUI_00001_.png", subfolder: "c0", type: "output" },
      { filename: "ComfyUI_00001_.png", subfolder: "c1", type: "output" },
    ]);
  });
});

// --- 2026-09-20 檔案頁 §2：面板送的單也要有名稱 ---

describe("POST /comfy/api/prompt label (檔案頁 §2)", () => {
  it("derives the label from the Save node", async () => {
    // 面板沒有地方填名稱，所以 `/comfy/api/prompt` 只能靠 `deriveLabel` ——
    // 名稱在 insertJob 之前推好，面板端一行都不用改。
    const { cookie } = await loginSession();
    const prompt = {
      "1": { class_type: "KSampler", inputs: { seed: 1 } },
      "2": { class_type: "SaveImage", inputs: { images: ["1", 0], filename_prefix: "wuxia/opening-shot" } },
    };
    const r = await postPrompt(cookie, prompt);
    expect(r.status).toBe(200);
    const row = await db()
      .prepare("SELECT label FROM jobs WHERE id = ?")
      .bind(r.body.prompt_id)
      .first<{ label: string | null }>();
    expect(row!.label).toBe("opening-shot");
  });

  it("has no label without a filename_prefix", async () => {
    const { cookie } = await loginSession();
    const r = await postPrompt(cookie);
    expect(r.status).toBe(200);
    const row = await db()
      .prepare("SELECT label FROM jobs WHERE id = ?")
      .bind(r.body.prompt_id)
      .first<{ label: string | null }>();
    expect(row!.label).toBeNull();
  });
});
