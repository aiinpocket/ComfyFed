/**
 * 2026-09-19 配方（spec §5）的 cloud 孿生測試 —— 逐案對應
 * `tests/server/test_recipes.py`：檔案格式、參數驗證、渲染與三個端點，
 * 外加兩棧配方檔的 byte-parity 比對。
 *
 * Python 有三個測試在這裡沒有對應案例，因為那一棧的 loader 是「掃目錄、讀
 * 檔、壞檔跳過」，cloud 沒有檔案系統：配方是 `import` 進 bundle 的 JSON
 * （`src/core/recipes.ts`），壞掉的 JSON 在 build 期就爆，而不是 runtime 安
 * 靜地少一筆。那三個是 `test_packaged_recipe_resolves_through_importlib_
 * resources`／`test_broken_recipe_file_is_skipped_with_a_warning`／
 * `test_missing_recipe_directory_is_logged`；前者的意圖（打包沒漏檔）由本檔
 * 的 byte-parity 測試與 `loadRecipes()` 非空的斷言接手。
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import * as recipes from "../src/core/recipes";
import * as modelFetch from "../src/core/model_fetch";
import * as queries from "../src/db/queries";
import golden from "./fixtures/golden.json";

// See vitest.config.ts: every recipe JSON file is read at Node config time
// (workerd has no `fs`) and injected as a base64 global -- same pattern
// test/comfyfed-ext.spec.ts uses for the panel extension.
declare const __RECIPE_PARITY_B64__: Record<string, { server: string; cloud: string }>;

afterEach(async () => {
  // `stubHead` below spies on the module namespace (and one test spies on
  // `queries.getAllWorkers`); restore both so the next file sees the real
  // implementations -- same discipline as test/model_fetch.spec.ts.
  vi.restoreAllMocks();
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM api_tokens").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM users").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

interface Session {
  cookie: string | null;
  csrf: string;
}

async function adminSession(): Promise<Session> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const r = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  expect(r.status).toBe(200);
  return { cookie: r.setCookie, csrf: r.body.csrf };
}

async function bearerHeaders(session: Session): Promise<Record<string, string>> {
  const r = await call("/api/auth/tokens", {
    method: "POST",
    json: { name: "ai" },
    cookie: session.cookie,
    headers: { "X-CSRF": session.csrf },
  });
  expect(r.status).toBe(201);
  return { Authorization: `Bearer ${r.body.token}` };
}

function flux(): any {
  return recipes.loadRecipes()["flux-t2i"];
}

function loadedRecipeIds(): string[] {
  return Object.keys(recipes.loadRecipes());
}

/** Keys that live on `Object.prototype` and therefore "resolve" on any
 * object-literal map -- the I1 regression's whole surface. */
const PROTOTYPE_KEYS = ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"];

async function run(
  opts: { cookie?: string | null; headers?: Record<string, string> },
  params: unknown,
  recipeId = "flux-t2i"
) {
  return call(`/api/recipes/${recipeId}/run`, {
    method: "POST",
    json: { params },
    cookie: opts.cookie ?? null,
    headers: opts.headers,
  });
}

async function jobRow(jobId: string): Promise<any> {
  return db().prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<any>();
}

/** True if any `{"$param": ...}` marker survives anywhere in `value`. */
function hasParamMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasParamMarker);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 1 && keys[0] === "$param") return true;
    return Object.values(value as Record<string, unknown>).some(hasParamMarker);
  }
  return false;
}

const FOUR_MODELS = [
  "ae.safetensors",
  "clip_l.safetensors",
  "flux1-dev.safetensors",
  "t5xxl_fp16.safetensors",
];

function expectBadParams(fn: () => unknown, needle: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(recipes.RecipeError);
  expect((thrown as recipes.RecipeError).code).toBe("recipes.bad_params");
  expect((thrown as recipes.RecipeError).message).toContain(needle);
}

// --- 檔案 parity ---------------------------------------------------------

describe("recipe file parity", () => {
  it.each(Object.keys(__RECIPE_PARITY_B64__))(
    "cloud/src/core/recipes/%s.json is byte-identical to the packaged Python file",
    (recipeId) => {
      const pair = __RECIPE_PARITY_B64__[recipeId]!;
      expect(Buffer.from(pair.server, "base64").equals(Buffer.from(pair.cloud, "base64"))).toBe(true);
    }
  );

  // 「檔案 copy 過來了但忘了 `import` 進 BUNDLED」是這個 port 最容易犯、最安靜
  // 的錯：parity 測試會過（兩份檔案一樣），端點卻少一個配方。這條把「目錄裡有
  // 幾個檔」與「bundle 裡有幾個配方」釘在一起。
  it("bundles exactly the recipe files that exist on both sides", () => {
    expect(loadedRecipeIds().sort()).toEqual(Object.keys(__RECIPE_PARITY_B64__).sort());
  });
});

// --- 檔案與 loader ------------------------------------------------------

describe("loadRecipes", () => {
  it("loads the packaged recipe and declares its models", () => {
    const recipe = flux();
    expect(recipe.id).toBe("flux-t2i");
    expect([...recipe.required_models].sort()).toEqual(FOUR_MODELS);
    expect(recipe.title["zh-TW"]).toBeTruthy();
    expect(recipe.title.en).toBeTruthy();
    expect(recipe.params.map((p: any) => p.name).sort()).toEqual(
      ["guidance", "height", "prompt", "seed", "steps", "width"]
    );
  });

  it("keeps every parameter in the workflow as a marker", () => {
    const workflow = flux().workflow;
    expect(workflow["4"].inputs.text).toEqual({ $param: "prompt" });
    expect(workflow["5"].inputs.guidance).toEqual({ $param: "guidance" });
    expect(workflow["8"].inputs.steps).toEqual({ $param: "steps" });
    expect(workflow["9"].inputs.noise_seed).toEqual({ $param: "seed" });
    expect(workflow["10"].inputs.width).toEqual({ $param: "width" });
    expect(workflow["10"].inputs.height).toEqual({ $param: "height" });
    expect(workflow["13"].inputs.filename_prefix).toBe("comfyfed_recipe");
  });
});

// --- validateParams -----------------------------------------------------

describe("validateParams", () => {
  it("fills defaults and resolves the random seed", () => {
    const resolved = recipes.validateParams(flux(), { prompt: "x" });
    expect(resolved.prompt).toBe("x");
    expect(resolved.width).toBe(768);
    expect(resolved.height).toBe(768);
    expect(resolved.steps).toBe(8);
    expect(resolved.guidance).toBe(3.5);
    expect(Number.isInteger(resolved.seed)).toBe(true);
    expect(resolved.seed as number).toBeGreaterThanOrEqual(0);
    expect(resolved.seed as number).toBeLessThanOrEqual(2 ** 32 - 1);
  });

  it("keeps an explicit seed", () => {
    expect(recipes.validateParams(flux(), { prompt: "x", seed: 42 }).seed).toBe(42);
  });

  it("rejects a missing required param", () => {
    expectBadParams(() => recipes.validateParams(flux(), {}), "prompt");
  });

  const BAD: Array<[string, Record<string, unknown>]> = [
    ["width", { width: 300 }], // 非 16 的倍數
    ["width", { width: 128 }], // 低於 min
    ["width", { width: 4096 }], // 高於 max
    ["steps", { steps: 0 }], // 低於 min
    ["steps", { steps: 3.5 }], // integer 不收浮點
    ["steps", { steps: true }], // integer 不收 bool
    ["guidance", { guidance: true }], // number 也不收 bool
    ["guidance", { guidance: "3.5" }], // number 不收字串
    ["prompt", { prompt: 7 }], // string 不收數字
    ["nope", { nope: 1 }], // 未知參數
  ];

  it.each(BAD)("rejects a bad value for %s", (needle, bad) => {
    expectBadParams(() => recipes.validateParams(flux(), { prompt: "x", ...bad }), needle);
  });

  it("accepts an integer where a number is declared", () => {
    expect(recipes.validateParams(flux(), { prompt: "x", guidance: 4 }).guidance).toBe(4);
  });
});

// --- renderWorkflow -----------------------------------------------------

describe("renderWorkflow", () => {
  it("leaves no markers behind and does not mutate the recipe", () => {
    const recipe = flux();
    const params = recipes.validateParams(recipe, { prompt: "a cat", steps: 12 });
    const rendered = recipes.renderWorkflow(recipe, params) as any;

    expect(hasParamMarker(rendered)).toBe(false);
    expect(rendered["4"].inputs.text).toBe("a cat");
    expect(rendered["8"].inputs.steps).toBe(12);
    expect(rendered["9"].inputs.noise_seed).toBe(params.seed);
    // 原始配方不能被就地改寫
    expect(flux().workflow["4"].inputs.text).toEqual({ $param: "prompt" });
  });
});

// --- publicView ---------------------------------------------------------

describe("publicView", () => {
  it("hides the workflow unless asked", () => {
    const recipe = flux();
    expect(recipes.publicView(recipe, false)).not.toHaveProperty("workflow");
    expect(recipes.publicView(recipe, true).workflow).toEqual(recipe.workflow);
  });

  it("does not hand out the cached containers", () => {
    const view = recipes.publicView(flux(), true);
    (view.params as unknown[]).push({ name: "injected" });
    (view.required_models as unknown[]).push("evil.safetensors");
    expect(flux().params.length).toBe(6);
    expect(flux().required_models).not.toContain("evil.safetensors");
  });
});

// --- GET 端點 -----------------------------------------------------------

describe("GET /api/recipes", () => {
  it("requires login", async () => {
    expect((await call("/api/recipes", { method: "GET" })).status).toBe(401);
  });

  it("omits the workflow", async () => {
    const session = await adminSession();
    const r = await call("/api/recipes", { method: "GET", cookie: session.cookie });
    expect(r.status).toBe(200);
    const entry = r.body.find((e: any) => e.id === "flux-t2i");
    expect(entry).not.toHaveProperty("workflow");
    expect([...entry.required_models].sort()).toEqual(FOUR_MODELS);
    expect(entry.params[0].name).toBe("prompt");
  });

  it("includes the workflow on the single-recipe route", async () => {
    const session = await adminSession();
    const r = await call("/api/recipes/flux-t2i", { method: "GET", cookie: session.cookie });
    expect(r.status).toBe(200);
    expect(r.body.workflow["4"].inputs.text).toEqual({ $param: "prompt" });
  });

  it("404s an unknown recipe", async () => {
    const session = await adminSession();
    const r = await call("/api/recipes/nope", { method: "GET", cookie: session.cookie });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("recipes.not_found");
  });

  // Fix round 1 / I1 regression: the recipe map used to be an object
  // literal, so `loadRecipes()["constructor"]` was NOT undefined and this
  // route answered 200 with an empty recipe body. Python's
  // `load_recipes().get(recipe_id)` returns None for these, so 404 is the
  // parity answer.
  it.each(PROTOTYPE_KEYS)("404s the Object.prototype key %j", async (recipeId) => {
    const session = await adminSession();
    const r = await call(`/api/recipes/${recipeId}`, { method: "GET", cookie: session.cookie });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("recipes.not_found");
  });

  it.each(PROTOTYPE_KEYS)("does not treat %j as a loaded recipe", (recipeId) => {
    expect(loadedRecipeIds()).not.toContain(recipeId);
    expect(recipes.loadRecipes()[recipeId]).toBeUndefined();
  });
});

// --- run ----------------------------------------------------------------

describe("POST /api/recipes/{id}/run", () => {
  it("creates a rendered job", async () => {
    const session = await adminSession();
    const r = await run(
      { cookie: session.cookie, headers: { "X-CSRF": session.csrf } },
      { prompt: "a red fox", steps: 10 }
    );
    expect(r.status).toBe(201);
    const body = r.body;
    expect(body.recipe_id).toBe("flux-t2i");
    expect(body.params.prompt).toBe("a red fox");
    expect(body.params.steps).toBe(10);
    expect(body.params.width).toBe(768);
    expect(body.params.seed).toBeGreaterThanOrEqual(0);
    expect(body.params.seed).toBeLessThanOrEqual(2 ** 32 - 1);

    const job = await jobRow(body.job_id);
    expect(job).not.toBeNull();
    expect(job.status).toBe("queued");
    expect(job.origin).toBe("console");
    const stored = JSON.parse(job.workflow_json);
    expect(stored["4"].inputs.text).toBe("a red fox");
    expect(stored["8"].inputs.steps).toBe(10);
    expect(stored["9"].inputs.noise_seed).toBe(body.params.seed);
    expect(hasParamMarker(stored)).toBe(false);
    expect(JSON.parse(job.required_models).sort()).toEqual(FOUR_MODELS);
    expect(job.signature).toBeTruthy();
  });

  it("rejects a run without CSRF", async () => {
    const session = await adminSession();
    const r = await run({ cookie: session.cookie }, { prompt: "x" });
    expect(r.status).toBe(403);
  });

  it("accepts a bearer token", async () => {
    const session = await adminSession();
    const headers = await bearerHeaders(session);

    const r = await run({ headers }, { prompt: "from ai" });
    expect(r.status).toBe(201);
    const job = await jobRow(r.body.job_id);
    expect(JSON.parse(job.workflow_json)["4"].inputs.text).toBe("from ai");
  });

  it("rejects bad params with the error envelope, naming the FIRST declared one", async () => {
    // 兩個錯（缺 prompt、width 非 16 倍數）時，回報的是宣告順序上的第一個。
    const session = await adminSession();
    const r = await run({ cookie: session.cookie, headers: { "X-CSRF": session.csrf } }, { width: 300 });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("recipes.bad_params");
    expect(r.body.error.message).toContain("prompt");
  });

  it("rejects a non-multiple width", async () => {
    const session = await adminSession();
    const r = await run(
      { cookie: session.cookie, headers: { "X-CSRF": session.csrf } },
      { prompt: "x", width: 300 }
    );
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("recipes.bad_params");
    expect(r.body.error.message).toContain("width");
  });

  it("rejects zero steps", async () => {
    const session = await adminSession();
    const r = await run(
      { cookie: session.cookie, headers: { "X-CSRF": session.csrf } },
      { prompt: "x", steps: 0 }
    );
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("steps");
  });

  it("rejects unknown params", async () => {
    const session = await adminSession();
    const r = await run(
      { cookie: session.cookie, headers: { "X-CSRF": session.csrf } },
      { prompt: "x", bogus: 1 }
    );
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("bogus");
  });

  it("names the parameter when the prompt is missing", async () => {
    const session = await adminSession();
    const r = await run({ cookie: session.cookie, headers: { "X-CSRF": session.csrf } }, {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("recipes.bad_params");
    expect(r.body.error.message).toContain("prompt");
  });

  it("404s an unknown recipe", async () => {
    const session = await adminSession();
    const r = await run(
      { cookie: session.cookie, headers: { "X-CSRF": session.csrf } },
      { prompt: "x" },
      "nope"
    );
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("recipes.not_found");
  });

  // Fix round 1 / I1 regression: `POST /api/recipes/toString/run` used to
  // resolve `Object.prototype.toString` as a "recipe", see no declared
  // params and no workflow, and actually CREATE a job with an empty
  // workflow (201). It must 404 before anything is inserted.
  it.each(PROTOTYPE_KEYS)("404s a run against the Object.prototype key %j, creating no job", async (recipeId) => {
    const session = await adminSession();
    // 空 params 是原始災情的形狀：沒有宣告參數可驗、沒有 workflow 可渲染，
    // 於是整條路一路通到 `createJobFromWorkflow` 並回 201。
    const r = await run({ cookie: session.cookie, headers: { "X-CSRF": session.csrf } }, {}, recipeId);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("recipes.not_found");

    const jobs = await db().prepare("SELECT COUNT(*) AS n FROM jobs").first<{ n: number }>();
    expect(jobs!.n).toBe(0);
  });

  it("gives two runs different random seeds", async () => {
    const session = await adminSession();
    const seeds = new Set<number>();
    for (let i = 0; i < 6; i++) {
      const r = await run({ cookie: session.cookie, headers: { "X-CSRF": session.csrf } }, { prompt: "x" });
      seeds.add(r.body.params.seed);
    }
    expect(seeds.size).toBeGreaterThan(1);
  });
});

// --- 合成配方（I1／M2） --------------------------------------------------

const SYNTHETIC = {
  id: "synthetic",
  params: [
    { name: "orphan", type: "string" },
    { name: "flag", type: "boolean", default: false },
    { name: "mode", type: "enum", values: ["fast", "slow"], default: "fast" },
    { name: "ratio", type: "number", default: 1.0, min: 0.5, step: 0.25 },
  ],
  workflow: { "1": { class_type: "X", inputs: { flag: { $param: "flag" } } } },
};

function synthetic(overrides: Record<string, unknown> = {}): any {
  return { ...JSON.parse(JSON.stringify(SYNTHETIC)), ...overrides };
}

describe("synthetic recipes", () => {
  it("makes a param with neither default nor required a 400, not a 500", () => {
    // 配方作者漏寫 default 是配方的 bug，但使用者的請求不該因此收到 5xx。
    expectBadParams(() => recipes.validateParams(synthetic(), {}), "orphan");
  });

  it("validates booleans, enums and float steps", () => {
    const resolved = recipes.validateParams(synthetic(), {
      orphan: "x",
      flag: true,
      mode: "slow",
      ratio: 1.75,
    });
    expect(resolved).toEqual({ orphan: "x", flag: true, mode: "slow", ratio: 1.75 });

    for (const [bad, needle] of [
      [{ flag: 1 }, "flag"],
      [{ mode: "medium" }, "mode"],
      [{ ratio: 1.1 }, "ratio"],
      [{ ratio: 0.25 }, "ratio"],
    ] as Array<[Record<string, unknown>, string]>) {
      expectBadParams(() => recipes.validateParams(synthetic(), { orphan: "x", ...bad }), needle);
    }
  });

  it("treats an unknown param type as a recipe fault, not a user fault", () => {
    const recipe = synthetic({ params: [{ name: "weird", type: "colour", default: "red" }] });
    let thrown: unknown;
    try {
      recipes.validateParams(recipe, {});
    } catch (err) {
      thrown = err;
    }
    expect((thrown as recipes.RecipeError).code).toBe("recipes.bad_recipe");
  });

  it("treats a marker for an undeclared param as a recipe fault", () => {
    const recipe = synthetic({
      workflow: { "1": { class_type: "X", inputs: { a: { $param: "nowhere" } } } },
    });
    const params = recipes.validateParams(recipe, { orphan: "x" });
    let thrown: unknown;
    try {
      recipes.renderWorkflow(recipe, params);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as recipes.RecipeError).code).toBe("recipes.bad_recipe");
  });
});

// A run whose recipe is itself malformed answers 500 `recipes.bad_recipe`
// (spec §5.1 / recipes.py's route). There is no malformed recipe in the
// bundle to reach that branch through HTTP, so this drives the same helper
// the route uses and pins the status mapping next to it.
describe("bad_recipe status mapping", () => {
  it("maps recipes.bad_recipe to 500 and recipes.bad_params to 400", () => {
    expect(recipes.statusForCode("recipes.bad_params")).toBe(400);
    expect(recipes.statusForCode("recipes.bad_recipe")).toBe(500);
  });
});

// =======================================================================
// 2026-09-20 spec §12：NSFW 預設配方（chroma-t2i／h3-t2v）＋ model_sources
// 自動下載。逐案對應 `tests/server/test_recipes.py` 的 §12 區塊：清單順序、
// nsfw_ok、衍生參數 length、missing_models、run 時的 model_fetch_jobs。
// =======================================================================

const CHROMA_UNET = "Chroma1-HD-fp8mixed.safetensors";
const CHROMA_URL =
  "https://huggingface.co/Comfy-Org/Chroma1-HD_repackaged/resolve/main/" +
  "split_files/diffusion_models/Chroma1-HD-fp8mixed.safetensors";
const CHROMA_INVENTORY_NAME = "diffusion_models/Chroma1-HD-fp8mixed.safetensors";
const CHROMA_SIZE = 9193379316;

function recipe(recipeId: string): any {
  return recipes.loadRecipes()[recipeId];
}

/** The single node of `classType`; fails loudly when there are 0 or 2. */
function node(workflow: any, classType: string): any {
  const found = nodes(workflow, classType);
  expect(found, `${classType}: expected exactly one, got ${found.length}`).toHaveLength(1);
  return found[0];
}

function nodes(workflow: any, classType: string): any[] {
  return Object.values(workflow).filter((n: any) => n.class_type === classType);
}

function rendered(recipeId: string, params: Record<string, unknown>): { workflow: any; params: any } {
  const r = recipe(recipeId);
  const resolved = recipes.derivedParams(r, recipes.validateParams(r, params));
  return { workflow: recipes.renderWorkflow(r, resolved) as any, params: resolved };
}

/** 一台「線上、開了 auto_fetch、protocol 夠新、磁碟夠」的 worker --
 * `createFetchJob` 的 row 7 需要有人接得住這次下載才會建 job。同
 * test/model_fetch.spec.ts 的 `registerWorker`。 */
async function registerFetchWorker(
  session: Session,
  opts: { name?: string; models?: unknown[] } = {}
): Promise<string> {
  const name = opts.name ?? "w1";
  const tokenRes = await call("/api/workers/tokens", {
    json: { name },
    cookie: session.cookie,
    headers: { "X-CSRF": session.csrf },
  });
  const token = tokenRes.body.bundle.register_token;
  const reg = await call("/api/agent/register", {
    json: { token, name, pubkey: golden.keypairs[0]!.pubkey_hex },
  });
  const workerId = reg.body.worker_id;
  await db()
    .prepare(
      "UPDATE workers SET status = ?, protocol = ?, auto_fetch = ?, dynamic = ?, hardware = ?, model_inventory = ? WHERE id = ?"
    )
    .bind(
      "online",
      5,
      1,
      JSON.stringify({ free_disk_gb: 500.0 }),
      JSON.stringify({ max_fetch_gb: 100 }),
      JSON.stringify(opts.models ?? []),
      workerId
    )
    .run();
  return workerId;
}

/** Point the HEAD probe at `impl` for this test -- the twin of the Python
 * suite's `monkeypatch.setattr(model_fetch, "head_size_bytes", ...)`.
 * `core/recipes.ts` reads `modelFetch.headSizeBytes` off the module namespace
 * on every request for exactly this reason. */
function stubHead(impl: (url: string) => Promise<number>): void {
  vi.spyOn(modelFetch, "headSizeBytes").mockImplementation(impl as typeof modelFetch.headSizeBytes);
}

function fakeHead(): void {
  stubHead(async () => CHROMA_SIZE);
}

function headRaising(code: string): void {
  stubHead(async () => {
    throw new modelFetch.HeadError(code);
  });
}

async function liveWorkers(): Promise<queries.Worker[]> {
  return queries.getAllWorkers(db());
}

// --- 清單順序與旗標 -----------------------------------------------------

describe("recipe ordering and flags (§12.1)", () => {
  it("orders the list by `order`, not by id", async () => {
    // AI 端把清單第一個當預設，所以順序是規格的一部分。字母序會給出
    // chroma -> flux -> h3，那會讓 flux 變成「第二推薦」。
    const session = await adminSession();
    const r = await call("/api/recipes", { method: "GET", cookie: session.cookie });
    expect(r.status).toBe(200);
    expect(r.body.map((e: any) => e.id)).toEqual(["chroma-t2i", "h3-t2v", "flux-t2i"]);
    expect(r.body.map((e: any) => e.order)).toEqual([10, 20, 30]);
  });

  it("declares nsfw_ok per recipe", async () => {
    const session = await adminSession();
    const r = await call("/api/recipes", { method: "GET", cookie: session.cookie });
    const flags = Object.fromEntries(r.body.map((e: any) => [e.id, e.nsfw_ok]));
    expect(flags).toEqual({ "chroma-t2i": true, "h3-t2v": true, "flux-t2i": false });
  });

  it("carries the new fields on the single-recipe view", async () => {
    const session = await adminSession();
    const r = await call("/api/recipes/chroma-t2i", { method: "GET", cookie: session.cookie });
    expect(r.body.order).toBe(10);
    expect(r.body.nsfw_ok).toBe(true);
    expect(r.body.missing_models).toEqual([CHROMA_UNET]);
    expect(r.body).toHaveProperty("workflow");
  });

  it("sorts an order-less recipe last and ignores a boolean order", () => {
    // `recipeOrder` 的預設值（10_000）：忘了標順序的配方絕不該因為檔名靠前就
    // 變成 AI 端的預設。
    expect(recipes.recipeOrder({ id: "x" })).toBe(10_000);
    expect(recipes.recipeOrder({ id: "x", order: true })).toBe(10_000);
    expect(recipes.recipeOrder({ id: "x", order: 3 })).toBe(3);
  });
});

// --- chroma-t2i 的圖 ----------------------------------------------------

describe("chroma-t2i graph", () => {
  it("renders the spec model set", () => {
    const { workflow } = rendered("chroma-t2i", { prompt: "a red fox" });
    expect(node(workflow, "UNETLoader").inputs.unet_name).toBe(CHROMA_UNET);
    const clip = node(workflow, "CLIPLoader").inputs;
    expect(clip.clip_name).toBe("t5xxl_fp16.safetensors");
    expect(clip.type).toBe("chroma");
    expect(node(workflow, "VAELoader").inputs.vae_name).toBe("ae.safetensors");
    expect([...recipe("chroma-t2i").required_models].sort()).toEqual(
      [CHROMA_UNET, "t5xxl_fp16.safetensors", "ae.safetensors"].sort()
    );
  });

  it("matches the official template settings", () => {
    const { workflow, params } = rendered("chroma-t2i", { prompt: "a red fox" });
    const tokenizer = node(workflow, "T5TokenizerOptions").inputs;
    expect(tokenizer.min_padding).toBe(1);
    expect(tokenizer.min_length).toBe(0);
    expect(node(workflow, "ModelSamplingAuraFlow").inputs.shift).toBe(1);
    expect(node(workflow, "KSamplerSelect").inputs.sampler_name).toBe("euler");
    const scheduler = node(workflow, "BasicScheduler").inputs;
    expect(scheduler.scheduler).toBe("beta");
    expect(scheduler.steps).toBe(26);
    expect(scheduler.denoise).toBe(1);
    expect(node(workflow, "CFGGuider").inputs.cfg).toBe(3.5);
    expect(node(workflow, "SaveImage").inputs.filename_prefix).toBe("comfyfed_recipe");
    expect(params.width).toBe(1024);
    expect(params.height).toBe(1024);
  });

  it("keeps the negative sentence a default, not a literal in the graph", () => {
    const r = recipe("chroma-t2i");
    const negativeSpec = r.params.find((p: any) => p.name === "negative");
    expect(negativeSpec.default.startsWith("This low quality greyscale unfinished sketch")).toBe(true);
    expect(negativeSpec.default).toContain("excessive bloom");

    const { workflow } = rendered("chroma-t2i", { prompt: "fox" });
    expect(new Set(nodes(workflow, "CLIPTextEncode").map((n) => n.inputs.text))).toEqual(
      new Set(["fox", negativeSpec.default])
    );

    const override = rendered("chroma-t2i", { prompt: "fox", negative: "blurry" }).workflow;
    expect(new Set(nodes(override, "CLIPTextEncode").map((n) => n.inputs.text))).toEqual(
      new Set(["fox", "blurry"])
    );
  });

  it("flows cfg, steps and seed into the graph", () => {
    const { workflow, params } = rendered("chroma-t2i", {
      prompt: "fox",
      cfg: 4.5,
      steps: 12,
      seed: 7,
    });
    expect(node(workflow, "CFGGuider").inputs.cfg).toBe(4.5);
    expect(node(workflow, "BasicScheduler").inputs.steps).toBe(12);
    expect(node(workflow, "RandomNoise").inputs.noise_seed).toBe(7);
    expect(params.seed).toBe(7);
  });
});

// --- h3-t2v 的圖與衍生的 length ----------------------------------------

describe("h3-t2v derived length (§12.1)", () => {
  const CASES: Array<[number, number]> = [
    [5, 124], // 規格點名的範本值
    [1, 39], // max(5, 24) = 24 -> 24 + (5 - 24 % 17) % 17 = 24 + 15
    [10, 243], // 240 -> 240 + 3
  ];

  it.each(CASES)("derives length from seconds=%s -> %s", (seconds, length) => {
    // `length` 不是宣告的參數，是伺服器照 §12.1 的式子算出來的衍生值
    // （範本用 ComfyMathExpression 節點算，配方改由伺服器算）。
    const { workflow, params } = rendered("h3-t2v", { prompt: "x", seconds });
    expect(params.length).toBe(length);
    expect(node(workflow, "MiniMaxH3ImageToVideo").inputs.length).toBe(length);
  });

  it("always lands on the model's 17k+5 grid", () => {
    for (const seconds of [1, 2, 3.5, 5, 7, 10]) {
      const { params } = rendered("h3-t2v", { prompt: "x", seconds });
      expect((params.length - 5) % 17).toBe(0);
      expect(params.length).toBeGreaterThanOrEqual(5);
    }
  });

  it("leaves other recipes untouched", () => {
    const resolved = recipes.validateParams(flux(), { prompt: "x" });
    expect(recipes.derivedParams(flux(), resolved)).toEqual(resolved);
  });

  // Task 8 review 的 parked minor：一個非數值的 `seconds` 曾讓 `_h3_length`
  // 回空 dict，於是 `{"$param": "length"}` 變成「未宣告的參數」-> bad_recipe
  // -> 500。使用者送錯型別永遠是 400。
  it("refuses a non-numeric seconds with bad_params, not bad_recipe", () => {
    expectBadParams(() => recipes.derivedParams(recipe("h3-t2v"), { seconds: "five" }), "seconds");
    expectBadParams(() => recipes.derivedParams(recipe("h3-t2v"), { seconds: true }), "seconds");
    expectBadParams(() => recipes.derivedParams(recipe("h3-t2v"), {}), "seconds");
  });
});

describe("h3-t2v graph", () => {
  it("uses the uncensored encoder and the turbo LoRA on the sampling path", () => {
    const { workflow } = rendered("h3-t2v", { prompt: "x" });
    const clip = node(workflow, "CLIPLoader").inputs;
    expect(clip.clip_name).toBe("qwen3vl_32b_heretic_minimax_h3_nvfp4.safetensors");
    expect(clip.type).toBe("minimax");
    expect(node(workflow, "UNETLoader").inputs.unet_name).toBe(
      "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    );
    const lora = node(workflow, "LoraLoaderModelOnly").inputs;
    expect(lora.lora_name).toBe("minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors");
    expect(lora.strength_model).toBe(1);
    // LoRA 必須真的在取樣路徑上：BasicGuider／BasicScheduler 吃的是 LoRA 的
    // 輸出，不是裸 UNET（範本的 ComfySwitchNode 預設走裸 UNET，配方不走那條）。
    const loraId = Object.keys(workflow).find(
      (k) => workflow[k].class_type === "LoraLoaderModelOnly"
    )!;
    expect(node(workflow, "BasicGuider").inputs.model).toEqual([loraId, 0]);
    expect(node(workflow, "BasicScheduler").inputs.model).toEqual([loraId, 0]);
  });

  it("matches the spec sampler and output settings", () => {
    const { workflow, params } = rendered("h3-t2v", { prompt: "x" });
    expect(node(workflow, "KSamplerSelect").inputs.sampler_name).toBe("res_multistep");
    const scheduler = node(workflow, "BasicScheduler").inputs;
    expect(scheduler.scheduler).toBe("simple");
    expect(scheduler.steps).toBe(8);
    expect(scheduler.denoise).toBe(1);
    expect(node(workflow, "CreateVideo").inputs.fps).toBe(24);
    const save = node(workflow, "SaveVideo").inputs;
    expect(save.filename_prefix).toBe("video/comfyfed_recipe");
    expect(save.format).toBe("auto");
    expect(save.codec).toBe("auto");
    expect(new Set(nodes(workflow, "VAELoader").map((n) => n.inputs.vae_name))).toEqual(
      new Set(["minimax_h3_video_vae_fp16.safetensors", "minimax_h3_audio_vae_fp32.safetensors"])
    );
    // 純文字 = MiniMaxH3ImageToVideo 不接任何影像輸入。
    expect(new Set(Object.keys(node(workflow, "MiniMaxH3ImageToVideo").inputs))).toEqual(
      new Set(["clip", "vae", "prompt", "width", "height", "length"])
    );
    expect(params.width).toBe(1280);
    expect(params.steps).toBe(8);
  });
});

// --- 每個配方都渲染得乾淨 -----------------------------------------------

describe("every packaged recipe", () => {
  it("renders without leftover markers", () => {
    for (const [recipeId, r] of Object.entries(recipes.loadRecipes())) {
      const resolved = recipes.derivedParams(r, recipes.validateParams(r, { prompt: "x" }));
      const out = recipes.renderWorkflow(r, resolved);
      expect(hasParamMarker(out), recipeId).toBe(false);
      expect(Object.keys(out).length, recipeId).toBeGreaterThan(0);
    }
  });

  it("declares order and nsfw_ok", () => {
    for (const [recipeId, r] of Object.entries(recipes.loadRecipes())) {
      expect(Number.isInteger(r.order), recipeId).toBe(true);
      expect(typeof r.nsfw_ok, recipeId).toBe("boolean");
    }
  });

  it("declares only model_sources urls that are on the fetch allowlist", () => {
    // `model_sources` 的 url 會被原樣簽進 unverified entry 送給 worker，所以
    // 它必須在 `model_fetch.TRUSTED_ORIGINS` 內 -- 不然 run 只會安靜地跳過。
    for (const [recipeId, r] of Object.entries(recipes.loadRecipes())) {
      for (const source of recipes.modelSources(r)) {
        expect(modelFetch.isTrustedUrl(source.url), `${recipeId}: ${source.url}`).toBe(true);
        expect(source.name).toBeTruthy();
        expect(source.directory).toBeTruthy();
      }
    }
  });

  it("gives chroma-t2i the spec's model source", () => {
    expect(recipes.modelSources(recipe("chroma-t2i"))).toEqual([
      { name: CHROMA_UNET, directory: "diffusion_models", url: CHROMA_URL },
    ]);
  });

  it("drops a malformed model_sources entry instead of passing it on", () => {
    expect(
      recipes.modelSources({
        id: "x",
        model_sources: [
          { name: "a.safetensors", url: "https://huggingface.co/a" }, // directory 可省
          { name: "", directory: "vae", url: "https://huggingface.co/b" },
          { name: "c.safetensors", directory: "vae" },
          "not an object",
        ],
      })
    ).toEqual([{ name: "a.safetensors", directory: "", url: "https://huggingface.co/a" }]);
    expect(recipes.modelSources({ id: "x" })).toEqual([]);
    expect(recipes.modelSources({ id: "x", model_sources: "nope" })).toEqual([]);
  });
});

// --- missing_models -----------------------------------------------------

describe("missingModels (§12.2)", () => {
  it("lists the chroma unet when nobody has it", async () => {
    await adminSession();
    expect(recipes.missingModels(await liveWorkers(), recipe("chroma-t2i"))).toEqual([CHROMA_UNET]);
  });

  it("is empty once a worker reports it", async () => {
    const session = await adminSession();
    await registerFetchWorker(session, { models: [{ name: CHROMA_INVENTORY_NAME, size: 9.2 }] });
    expect(recipes.missingModels(await liveWorkers(), recipe("chroma-t2i"))).toEqual([]);
  });

  it("ignores disabled and deleted workers", async () => {
    const session = await adminSession();
    const workerId = await registerFetchWorker(session, {
      models: [{ name: CHROMA_INVENTORY_NAME, size: 9.2 }],
    });

    await db().prepare("UPDATE workers SET disabled = 1 WHERE id = ?").bind(workerId).run();
    expect(recipes.missingModels(await liveWorkers(), recipe("chroma-t2i"))).toEqual([CHROMA_UNET]);

    await db().prepare("UPDATE workers SET disabled = 0, deleted = 1 WHERE id = ?").bind(workerId).run();
    expect(recipes.missingModels(await liveWorkers(), recipe("chroma-t2i"))).toEqual([CHROMA_UNET]);
  });

  it("is empty for a recipe without sources", async () => {
    await adminSession();
    const workers = await liveWorkers();
    expect(recipes.missingModels(workers, flux())).toEqual([]);
    expect(recipes.missingModels(workers, recipe("h3-t2v"))).toEqual([]);
  });

  it("is reported per recipe on the list endpoint", async () => {
    const session = await adminSession();
    const r = await call("/api/recipes", { method: "GET", cookie: session.cookie });
    const byId = Object.fromEntries(r.body.map((e: any) => [e.id, e]));
    expect(byId["chroma-t2i"].missing_models).toEqual([CHROMA_UNET]);
    expect(byId["flux-t2i"].missing_models).toEqual([]);
    expect(byId["h3-t2v"].missing_models).toEqual([]);
  });

  // Task 8 review 的 parked minor：清單端點每筆配方各查一次 worker 表，會把一個
  // O(1) 的查詢變成 O(配方數)。Python 那側整批共用一個 session；這裡整批共用
  // 一次 `getAllWorkers`。
  it("reads the worker table exactly once for the whole list", async () => {
    const session = await adminSession();
    const spy = vi.spyOn(queries, "getAllWorkers");
    const r = await call("/api/recipes", { method: "GET", cookie: session.cookie });
    expect(r.status).toBe(200);
    expect(r.body.length).toBeGreaterThan(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// --- run 的 model_fetch_jobs -------------------------------------------

describe("POST /api/recipes/{id}/run model_fetch_jobs (§12.2)", () => {
  function csrf(session: Session) {
    return { cookie: session.cookie, headers: { "X-CSRF": session.csrf } };
  }

  it("queues a model_fetch for a missing source", async () => {
    const session = await adminSession();
    await registerFetchWorker(session);
    fakeHead();

    const r = await run(csrf(session), { prompt: "a fox" }, "chroma-t2i");
    expect(r.status).toBe(201);
    expect(r.body.model_fetch_jobs).toHaveLength(1);
    const entry = r.body.model_fetch_jobs[0];
    expect(entry.name).toBe(CHROMA_UNET);
    expect(entry.reused).toBe(false);

    const fetchJob = await jobRow(entry.job_id);
    expect(fetchJob.kind).toBe("model_fetch");
    expect(JSON.parse(fetchJob.required_models)).toEqual([CHROMA_UNET]);
    const signed = JSON.parse(fetchJob.fetch_entry);
    expect(signed.url).toBe(CHROMA_URL);
    expect(signed.size_bytes).toBe(CHROMA_SIZE);
    expect(signed.directory).toBe("diffusion_models");

    // 真正的那筆 prompt job 照常建立、照常排隊。
    const promptJob = await jobRow(r.body.job_id);
    expect(promptJob.status).toBe("queued");
    expect(promptJob.kind).not.toBe("model_fetch");
    expect(hasParamMarker(JSON.parse(promptJob.workflow_json))).toBe(false);
  });

  it("reuses the same fetch job on a second run", async () => {
    const session = await adminSession();
    await registerFetchWorker(session);
    fakeHead();

    const first = (await run(csrf(session), { prompt: "a" }, "chroma-t2i")).body;
    const second = (await run(csrf(session), { prompt: "b" }, "chroma-t2i")).body;
    expect(second.model_fetch_jobs[0].reused).toBe(true);
    expect(second.model_fetch_jobs[0].job_id).toBe(first.model_fetch_jobs[0].job_id);
  });

  it("still succeeds when the HEAD probe fails", async () => {
    // HEAD 失敗（gated／size_unknown）只是「這次下載排不出來」，不是「不准送
    // 單」-- job 照建，`model_fetch_jobs` 空著。
    const session = await adminSession();
    headRaising("gated");

    const r = await run(csrf(session), { prompt: "a" }, "chroma-t2i");
    expect(r.status).toBe(201);
    expect(r.body.model_fetch_jobs).toEqual([]);
    expect(await jobRow(r.body.job_id)).not.toBeNull();
  });

  it("is still refused when nothing can supply the model", async () => {
    // 自動下載沒有鬆開既有的建單防線：有 worker 在線、模型缺、又排不出下載
    // 時，`jobs.missing_models` 那道 400 照樣擋 -- 豁免只給「這次真的排出了一
    // 筆 model_fetch job」的那些名字。
    const session = await adminSession();
    await registerFetchWorker(session);
    headRaising("gated");

    const r = await run(csrf(session), { prompt: "a" }, "chroma-t2i");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("jobs.missing_models");
  });

  it("still succeeds when no worker can fetch", async () => {
    const session = await adminSession();
    fakeHead();
    const r = await run(csrf(session), { prompt: "a" }, "chroma-t2i");
    expect(r.status).toBe(201);
    expect(r.body.model_fetch_jobs).toEqual([]);
  });

  it("skips the fetch when a worker already has the model", async () => {
    const session = await adminSession();
    await registerFetchWorker(session, { models: [{ name: CHROMA_INVENTORY_NAME, size: 9.2 }] });
    fakeHead();
    const r = await run(csrf(session), { prompt: "a" }, "chroma-t2i");
    expect(r.status).toBe(201);
    expect(r.body.model_fetch_jobs).toEqual([]);
  });

  it("reports an empty list for a recipe without sources", async () => {
    const session = await adminSession();
    const r = await run(csrf(session), { prompt: "a" });
    expect(r.status).toBe(201);
    expect(r.body.model_fetch_jobs).toEqual([]);
  });

  it("returns the derived length in params for h3", async () => {
    const session = await adminSession();
    const r = await run(csrf(session), { prompt: "a", seconds: 5 }, "h3-t2v");
    expect(r.status).toBe(201);
    expect(r.body.params.length).toBe(124);
    const stored = JSON.parse((await jobRow(r.body.job_id)).workflow_json);
    expect(node(stored, "MiniMaxH3ImageToVideo").inputs.length).toBe(124);
    expect(hasParamMarker(stored)).toBe(false);
  });

  it("still rejects length as a user-supplied param", async () => {
    // `length` 是衍生值，不是使用者能送的參數 -- 送了要被當成未知參數擋掉。
    const session = await adminSession();
    const r = await run(csrf(session), { prompt: "a", length: 999 }, "h3-t2v");
    expect(r.status).toBe(400);
    expect(r.body.error.message).toContain("length");
  });

  it("answers 400, not 500, for a non-numeric seconds", async () => {
    const session = await adminSession();
    const r = await run(csrf(session), { prompt: "a", seconds: "five" }, "h3-t2v");
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("recipes.bad_params");
    expect(r.body.error.message).toContain("seconds");
  });
});
