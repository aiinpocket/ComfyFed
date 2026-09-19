/**
 * `/api/recipes/*` -- parity source: `server/comfyfed_server/recipes.py`'s
 * `create_router` (2026-09-19 spec §5.2).
 *
 * 三條 route 走 `requireUser`；`run` 走 `requireCsrfUser`，所以 API token 的
 * bearer 呼叫也能送單（bearer 跳過 CSRF）。`run` 不自己建單：渲染完就交給
 * `routes/jobs.ts` 的 `createJobFromWorkflow`，與 console 的 `POST /api/jobs`
 * 是同一條建單路徑（同 `origin="console"`、同 signature／requirements 推導、
 * 同派工），兩個入口不可能漂移。
 *
 * 配方的載入／驗證／渲染全部在 `core/recipes.ts`；這裡只做 HTTP。
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { errorJson, requireUser, requireCsrfUser, SESSION_VAR } from "../lib/guard";
import { loadRecipes, publicView, renderWorkflow, statusForCode, validateParams, RecipeError, type Recipe } from "../core/recipes";
import { createJobFromWorkflow, JobCreationError } from "./jobs";

const app = new Hono<{ Bindings: Env }>();

/** 查一個使用者送來的 `recipeId`，查不到回 `null`。
 *
 * `Object.hasOwn` 是這裡的重點：`recipeId` 完全由呼叫端決定，而
 * `constructor`／`toString`／`__proto__` 這些 `Object.prototype` 上的鍵在字面量
 * 物件上「查得到值」。`loadRecipes()` 已經改用 `Object.create(null)` 讓它們查
 * 不到，這一層是深度防禦：就算哪天有人把那張表改回字面量物件，這三條 route
 * 仍然只認「配方檔真的宣告過的 id」，其餘一律 404 `recipes.not_found`，與
 * Python `load_recipes().get(recipe_id)` 的行為一致。 */
function findRecipe(recipeId: string): Recipe | null {
  const all = loadRecipes();
  return Object.hasOwn(all, recipeId) ? all[recipeId]! : null;
}

app.get("/api/recipes", requireUser, (c) => {
  const entries = Object.entries(loadRecipes()).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return c.json(entries.map(([, recipe]) => publicView(recipe, false)));
});

app.get("/api/recipes/:recipeId", requireUser, (c) => {
  const recipeId = c.req.param("recipeId");
  const recipe = findRecipe(recipeId);
  if (recipe === null) {
    return errorJson(c, 404, "recipes.not_found", `No such recipe: ${recipeId}`);
  }
  return c.json(publicView(recipe, true));
});

app.post("/api/recipes/:recipeId/run", requireCsrfUser, async (c) => {
  const recipeId = c.req.param("recipeId");
  const recipe = findRecipe(recipeId);
  if (recipe === null) {
    return errorJson(c, 404, "recipes.not_found", `No such recipe: ${recipeId}`);
  }

  const body = await c.req.json<{ params?: unknown }>().catch(() => ({}) as any);
  const givenParams =
    body?.params !== null && typeof body?.params === "object" && !Array.isArray(body?.params)
      ? (body.params as Record<string, unknown>)
      : {};

  let params: Record<string, unknown>;
  let workflow: Record<string, unknown>;
  try {
    params = validateParams(recipe, givenParams);
    workflow = renderWorkflow(recipe, params);
  } catch (err) {
    if (err instanceof RecipeError) {
      return errorJson(c, statusForCode(err.code), err.code, err.message);
    }
    throw err;
  }

  const user = c.get(SESSION_VAR).user;
  let jobId: string;
  try {
    jobId = await createJobFromWorkflow(c.env, user, workflow, {}, []);
  } catch (err) {
    if (err instanceof JobCreationError) {
      return errorJson(c, err.status, err.code, err.message);
    }
    throw err;
  }

  // 201：這個端點的產物是一筆新的 job（`POST /api/jobs` 歷史上回 200，不動
  // 它以免既有 console／e2e 破）。
  return c.json({ job_id: jobId, recipe_id: recipeId, params }, 201);
});

export default app;
