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

import { afterEach, describe, expect, it } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import * as recipes from "../src/core/recipes";

// See vitest.config.ts: both recipe JSON files are read at Node config time
// (workerd has no `fs`) and injected as base64 globals -- same pattern
// test/comfyfed-ext.spec.ts uses for the panel extension.
declare const __RECIPE_FLUX_SERVER_B64__: string;
declare const __RECIPE_FLUX_CLOUD_B64__: string;

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM api_tokens").run();
  await db().prepare("DELETE FROM jobs").run();
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
  it("cloud/src/core/recipes/flux-t2i.json is byte-identical to the packaged Python file", () => {
    const serverBytes = Buffer.from(__RECIPE_FLUX_SERVER_B64__, "base64");
    const cloudBytes = Buffer.from(__RECIPE_FLUX_CLOUD_B64__, "base64");
    expect(serverBytes.equals(cloudBytes)).toBe(true);
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
