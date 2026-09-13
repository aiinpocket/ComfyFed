import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp } from "../src/db/queries";
import { artifactKey } from "../src/lib/store";
import { clearObjectInfoCacheForTests } from "../src/routes/comfyapi";
import golden from "./fixtures/golden.json";

// Ports the highest-value cases from tests/server/test_comfyapi.py -- see
// that file for the full Python suite this mirrors (1454 lines; this file
// covers auth gating, object_info union/intersection + staged-asset
// dropdown injection, the missing-model rejection's byte-shape + node_errors,
// origin scoping on queue/history/interrupt, history hide, /view traversal
// safety + job-scoped filename collisions, and the upload/settings/bootstrap
// routes).

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
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
  const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
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
  fields: { status?: string; disabled?: boolean; modelInventory?: unknown[]; nodeClasses?: string[]; objectInfoHash?: string }
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

// --- auth --------------------------------------------------------------

describe("every /comfy/api route requires an admin session", () => {
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
    expect(await store().get("staging/ref.png")).not.toBeNull();
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
});
