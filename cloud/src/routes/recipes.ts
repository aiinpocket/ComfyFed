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
import {
  derivedParams,
  ensureModelFetches,
  loadRecipes,
  missingModels,
  publicView,
  renderWorkflow,
  sortedRecipes,
  statusForCode,
  validateParams,
  RecipeError,
  type Recipe,
} from "../core/recipes";
import * as queries from "../db/queries";
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

/** 加上 `missing_models`（§12.2），整批共用**一次** worker 查詢 —— 清單端點
 * 每筆配方各查一次會把一個 O(1) 的查詢變成 O(配方數)。同 Python 那側整批共用
 * 一個 DB session 的 `_with_missing`。 */
async function withMissing(
  env: Env,
  recipesToView: Array<[Recipe, boolean]>
): Promise<Array<Record<string, unknown>>> {
  // `getAllWorkers` 已在 SQL 濾掉軟刪除的；停用的由 `missingModels` 濾。
  const workers = await queries.getAllWorkers(env.DB);
  return recipesToView.map(([recipe, includeWorkflow]) => ({
    ...publicView(recipe, includeWorkflow),
    missing_models: missingModels(workers, recipe),
  }));
}

app.get("/api/recipes", requireUser, async (c) => {
  // 依 `order` 升冪（§12.1）：AI 端把第一個當預設，所以順序是對外的承諾。
  return c.json(await withMissing(c.env, sortedRecipes().map(([, recipe]) => [recipe, false])));
});

app.get("/api/recipes/:recipeId", requireUser, async (c) => {
  const recipeId = c.req.param("recipeId");
  const recipe = findRecipe(recipeId);
  if (recipe === null) {
    return errorJson(c, 404, "recipes.not_found", `No such recipe: ${recipeId}`);
  }
  return c.json((await withMissing(c.env, [[recipe, true]]))[0]!);
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
    // 順序固定：驗證宣告過的參數 -> 疊上伺服器算的衍生值（§12.1 的 h3
    // `length`）-> 渲染。
    params = derivedParams(recipe, validateParams(recipe, givenParams));
    workflow = renderWorkflow(recipe, params);
  } catch (err) {
    if (err instanceof RecipeError) {
      return errorJson(c, statusForCode(err.code), err.code, err.message);
    }
    throw err;
  }

  const user = c.get(SESSION_VAR).user;

  // 建單**之前**先排下載（§12.2）：先建 job 再排下載也能跑，但那樣一個在這
  // 中間失敗的請求會留下一筆永遠等不到模型的 job，而先排下載最壞只是多一筆
  // model_fetch job —— 那筆有去重，下一次 run 會直接重用。
  const fetchJobs = await ensureModelFetches(c.env, recipe, user.uid);

  let jobId: string;
  try {
    jobId = await createJobFromWorkflow(c.env, user, workflow, {}, [], {
      // 豁免只給「這次真的排出了一筆 model_fetch job」的那些名字：它們現在確
      // 實沒有任何 worker 有，但已經有一筆下載在路上，所以不算「整個聯邦都拿
      // 不到」。HEAD 失敗／沒有 worker 接得住時 `fetchJobs` 是空的，
      // `jobs.missing_models` 那道 400 照樣擋。
      fetching: new Set(fetchJobs.map((entry) => entry.name)),
    });
  } catch (err) {
    if (err instanceof JobCreationError) {
      return errorJson(c, err.status, err.code, err.message);
    }
    throw err;
  }

  // 201：這個端點的產物是一筆新的 job（`POST /api/jobs` 歷史上回 200，不動
  // 它以免既有 console／e2e 破）。
  return c.json({ job_id: jobId, recipe_id: recipeId, params, model_fetch_jobs: fetchJobs }, 201);
});

export default app;
