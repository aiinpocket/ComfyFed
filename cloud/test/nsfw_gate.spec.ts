import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import * as nsfwGate from "../src/core/nsfw_gate";

// Ports the original Python suite case for case: signal extraction, the
// rule layer, the Claude classifier (fake fetch), `checkSubmission`'s
// short-circuits, the settings key, and the refusal envelopes on the console
// and panel submit routes.

afterEach(async () => {
  vi.restoreAllMocks();
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM login_attempts").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

interface Session {
  cookie: string | null;
  csrf: string;
}

async function adminSession(): Promise<Session> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function restrictedUser(admin: Session, username = "alice"): Promise<Session & { uid: string }> {
  const password = "a-long-password1";
  const created = await call("/api/users", {
    json: { username, role: "user", password },
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
  const patched = await call(`/api/users/${created.body.id}`, {
    method: "PATCH",
    json: { nsfw_allowed: false },
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
  expect(patched.status).toBe(200);
  const login = await call("/api/auth/login", { json: { username, password } });
  return { cookie: login.setCookie, csrf: login.body.csrf, uid: created.body.id };
}

function workflow(positive = "a cat on a sofa", negative = "blurry", model = "sd_xl_base_1.0.safetensors") {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: model } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: positive, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["1", 1] } },
    "4": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], seed: 1 } },
  };
}

async function submitConsole(session: Session, wf: unknown) {
  const form = new FormData();
  form.set("workflow_json", JSON.stringify(wf));
  const headers: Record<string, string> = { "X-CSRF": session.csrf };
  if (session.cookie) headers["Cookie"] = session.cookie;
  const worker = (await import("../src/index")).default;
  const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
  const request = new Request("http://example.com/api/jobs", { method: "POST", headers, body: form });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: await response.json<any>() };
}

// --- extractSignals -------------------------------------------------------------

describe("extractSignals", () => {
  it("separates positive from negative and collects model names", () => {
    const s = nsfwGate.extractSignals(workflow("a cat", "nsfw, nude", "foo.safetensors"));
    expect(s.modelNames).toEqual(["foo.safetensors"]);
    expect(s.positiveTexts).toEqual(["a cat"]);
  });

  it("treats prompt-named fields as positive", () => {
    const wf = { "1": { class_type: "SomeCustomNode", inputs: { prompt: "hello", seed: 3 } } };
    expect(nsfwGate.extractSignals(wf).positiveTexts).toEqual(["hello"]);
  });

  it("tolerates garbage", () => {
    expect(nsfwGate.signalsEmpty(nsfwGate.extractSignals({ "1": "nope", "2": { inputs: 5 } }))).toBe(true);
    expect(nsfwGate.signalsEmpty(nsfwGate.extractSignals("not an object"))).toBe(true);
  });
});

// --- ruleVerdict ------------------------------------------------------------------

describe("ruleVerdict", () => {
  it("denies on the recipe flag", () => {
    expect(nsfwGate.ruleVerdict({ modelNames: [], positiveTexts: [] }, { recipeNsfwOk: true })).not.toBeNull();
  });

  it.each(["Qwen3-VL-4b-Heretic.safetensors", "ponyXL_NSFW.ckpt", "flux-uncensored.gguf"])(
    "denies on model keyword %s",
    (model) => {
      expect(nsfwGate.ruleVerdict(nsfwGate.extractSignals(workflow("a cat", "blurry", model)))).not.toBeNull();
    }
  );

  it.each(["a nude woman", "NSFW art", "全裸的女人", "hardcore porn scene"])("denies on prompt %s", (prompt) => {
    expect(nsfwGate.ruleVerdict(nsfwGate.extractSignals(workflow(prompt)))).not.toBeNull();
  });

  it.each([
    "a castle in sussex",
    "a cat wearing a hat",
    "sexton beetle",
    "summa cum laude portrait",
    "visible to the naked eye",
    "explicit architectural detail",
    "grilled chicken breasts",
    "same-sex couple holding hands",
  ])("does not overmatch %s", (prompt) => {
    expect(nsfwGate.ruleVerdict(nsfwGate.extractSignals(workflow(prompt)))).toBeNull();
  });

  it("ignores the negative prompt", () => {
    expect(nsfwGate.ruleVerdict(nsfwGate.extractSignals(workflow("a cat", "nsfw, nude, naked")))).toBeNull();
  });

  it("follows a link into a prompt field (Primitive -> CLIPTextEncode.text)", () => {
    const wf = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
      "9": { class_type: "PrimitiveNode", inputs: { value: "a nude woman" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: ["9", 0], clip: ["1", 1] } },
      "3": { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["1", 1] } },
      "4": { class_type: "KSampler", inputs: { positive: ["2", 0], negative: ["3", 0] } },
    };
    const signals = nsfwGate.extractSignals(wf);
    expect(signals.positiveTexts).toEqual(["a nude woman"]);
    expect(nsfwGate.ruleVerdict(signals)).not.toBeNull();
  });

  it("negative walk crosses conditioning nodes", () => {
    const wf = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "m.safetensors" } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["1", 1] } },
      "3": { class_type: "CLIPTextEncode", inputs: { text: "nsfw, nude", clip: ["1", 1] } },
      "5": { class_type: "CLIPTextEncode", inputs: { text: "lowres", clip: ["1", 1] } },
      "6": { class_type: "ConditioningCombine", inputs: { conditioning_1: ["3", 0], conditioning_2: ["5", 0] } },
      "7": { class_type: "ConditioningSetTimestepRange", inputs: { conditioning: ["6", 0], start: 0, end: 1 } },
      "4": { class_type: "KSampler", inputs: { positive: ["2", 0], negative: ["7", 0] } },
    };
    const signals = nsfwGate.extractSignals(wf);
    expect(signals.positiveTexts).toEqual(["a cat"]);
    expect(nsfwGate.ruleVerdict(signals)).toBeNull();
  });
});

// --- classifyWithClaude -----------------------------------------------------------

function fakeFetch(text: string, status = 200, capture?: { url?: string; init?: RequestInit }): typeof fetch {
  return (async (url: any, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.init = init;
    }
    return new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("classifyWithClaude", () => {
  const signals = { modelNames: ["x.safetensors"], positiveTexts: ["some prompt"] };

  it("sends the Haiku request and reads DENY", async () => {
    const captured: { url?: string; init?: RequestInit } = {};
    const verdict = await nsfwGate.classifyWithClaude("sk-test", signals, fakeFetch("DENY", 200, captured));
    expect(verdict).toBe(true);
    expect(captured.url).toBe("https://api.anthropic.com/v1/messages");
    const headers = captured.init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(captured.init!.body as string);
    expect(body.model).toBe(nsfwGate.NSFW_CHECK_MODEL);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toBe(nsfwGate.classifierInput(signals));
    expect(body.messages[0].content).toContain("x.safetensors");
    expect(body.messages[0].content).toContain("some prompt");
  });

  it("reads ALLOW", async () => {
    expect(await nsfwGate.classifyWithClaude("k", signals, fakeFetch(" allow\n"))).toBe(false);
  });

  it.each([
    ["maybe?", 200],
    ["DENY", 500],
    ["DENY", 401],
  ])("returns null when there is no usable verdict (%s, %s)", async (text, status) => {
    expect(await nsfwGate.classifyWithClaude("k", signals, fakeFetch(text, status))).toBeNull();
  });

  it("returns null on a network error", async () => {
    const boom = (async () => {
      throw new TypeError("boom");
    }) as unknown as typeof fetch;
    expect(await nsfwGate.classifyWithClaude("k", signals, boom)).toBeNull();
  });

  it("matches the Python classifier_input byte for byte", () => {
    expect(nsfwGate.classifierInput({ modelNames: [], positiveTexts: [] })).toBe(
      "Model files:\n- (none)\n\nPositive prompts:\n- (none)"
    );
  });
});

// --- checkSubmission --------------------------------------------------------------

describe("checkSubmission", () => {
  it("allows a default user without looking at the workflow", async () => {
    const admin = await adminSession();
    const created = await call("/api/users", {
      json: { username: "bob", role: "user", password: "a-long-password1" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    const classify = vi.fn(async () => true);
    expect(await nsfwGate.checkSubmission(env as any, created.body.id, workflow("nude"), { classify })).toBeNull();
    expect(await nsfwGate.checkSubmission(env as any, "ghost", workflow("nude"), { classify })).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });

  it("rule layer denies without an API key", async () => {
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    const classify = vi.fn(async () => false);
    expect(await nsfwGate.checkSubmission(env as any, alice.uid, workflow("a nude woman"), { classify })).toBe(
      nsfwGate.REJECTION_MESSAGE
    );
    expect(await nsfwGate.checkSubmission(env as any, alice.uid, workflow(), { recipeNsfwOk: true, classify })).toBe(
      nsfwGate.REJECTION_MESSAGE
    );
    expect(classify).not.toHaveBeenCalled();
  });

  it("clean workflow without a key is allowed and never calls the classifier", async () => {
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    const classify = vi.fn(async () => true);
    expect(await nsfwGate.checkSubmission(env as any, alice.uid, workflow("a cat"), { classify })).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });

  it("uses the classifier when a key is set; null verdict = allow", async () => {
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    const saved = await call("/api/settings", {
      json: { nsfw_check_api_key: "sk-test-123" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.nsfw_check_api_key_set).toBe(true);
    expect(JSON.stringify(saved.body)).not.toContain("sk-test-123");

    const classify = vi.fn(async (apiKey: string, signals: nsfwGate.Signals) => {
      expect(apiKey).toBe("sk-test-123");
      expect(signals.positiveTexts).toEqual(["a cat"]);
      return true;
    });
    expect(await nsfwGate.checkSubmission(env as any, alice.uid, workflow("a cat"), { classify })).toBe(
      nsfwGate.REJECTION_MESSAGE
    );
    expect(classify).toHaveBeenCalledTimes(1);

    const noVerdict = vi.fn(async () => null);
    expect(await nsfwGate.checkSubmission(env as any, alice.uid, workflow("a cat"), { classify: noVerdict })).toBeNull();
  });

  it("skips the classifier when there is nothing to classify", async () => {
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    await call("/api/settings", {
      json: { nsfw_check_api_key: "sk-test-123" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    const classify = vi.fn(async () => true);
    const bare = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };
    expect(await nsfwGate.checkSubmission(env as any, alice.uid, bare, { classify })).toBeNull();
    expect(classify).not.toHaveBeenCalled();
  });
});

// --- settings ---------------------------------------------------------------------

describe("settings.nsfw_check_api_key", () => {
  it("reports unset by default and clears on empty", async () => {
    const admin = await adminSession();
    const get = () => call("/api/settings", { method: "GET", cookie: admin.cookie });
    expect((await get()).body.nsfw_check_api_key_set).toBe(false);
    await call("/api/settings", { json: { nsfw_check_api_key: "sk-x" }, cookie: admin.cookie, headers: { "X-CSRF": admin.csrf } });
    expect((await get()).body.nsfw_check_api_key_set).toBe(true);
    const cleared = await call("/api/settings", {
      json: { nsfw_check_api_key: "" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(cleared.body.nsfw_check_api_key_set).toBe(false);
    expect(await nsfwGate.readApiKey(db())).toBe("");
  });

  it("rejects a key with whitespace", async () => {
    const admin = await adminSession();
    const r = await call("/api/settings", {
      json: { nsfw_check_api_key: "sk-a b" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("settings.bad_nsfw_check_api_key");
  });
});

// --- routes -----------------------------------------------------------------------

describe("submit routes", () => {
  it("console submit is refused with 403 nsfw_not_allowed and no job row", async () => {
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    const refused = await submitConsole(alice, workflow("a nude woman"));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe(nsfwGate.NSFW_NOT_ALLOWED_CODE);
    expect(refused.body.error.message).toContain("聯絡管理員");
    const count = await db().prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(count!.n).toBe(0);

    const ok = await submitConsole(alice, workflow("a cat"));
    expect(ok.status).toBe(200);
    expect(typeof ok.body.job_id).toBe("string");
  });

  it("the route reaches the classifier through the module namespace", async () => {
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    await call("/api/settings", {
      json: { nsfw_check_api_key: "sk-test-123" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    const spy = vi.spyOn(nsfwGate, "classifyWithClaude").mockResolvedValue(true);
    const refused = await submitConsole(alice, workflow("a cat"));
    expect(refused.status).toBe(403);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("panel prompt is refused with the ComfyUI error envelope", async () => {
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    const r = await call("/comfy/api/prompt", {
      json: { prompt: workflow("a nude woman") },
      cookie: alice.cookie,
      headers: { "X-CSRF": alice.csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.type).toBe("comfyfed." + nsfwGate.NSFW_NOT_ALLOWED_CODE);
    expect(r.body.error.details).toContain("聯絡管理員");
    const count = await db().prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("recipe run is refused before any model_fetch job is queued", async () => {
    // `chroma-t2i` declares nsfw_ok: true AND model_sources: the gate must
    // run before the download is scheduled, or a refused user still gets a
    // 9 GB NSFW model pulled onto the fleet.
    const modelFetch = await import("../src/core/model_fetch");
    const head = vi.spyOn(modelFetch, "headSizeBytes").mockRejectedValue(new Error("must not probe"));
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    const r = await call("/api/recipes/chroma-t2i/run", {
      method: "POST",
      json: { params: { prompt: "a cat" } },
      cookie: alice.cookie,
      headers: { "X-CSRF": alice.csrf },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe(nsfwGate.NSFW_NOT_ALLOWED_CODE);
    expect(head).not.toHaveBeenCalled();
    const count = await db().prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("re-allowing the user lifts the gate", async () => {
    const admin = await adminSession();
    const alice = await restrictedUser(admin);
    await call(`/api/users/${alice.uid}`, {
      method: "PATCH",
      json: { nsfw_allowed: true },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    const ok = await submitConsole(alice, workflow("a nude woman"));
    expect(ok.status).toBe(200);
  });
});
