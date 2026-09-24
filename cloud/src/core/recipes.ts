/**
 * 配方（recipe）：把一張跑得通的 workflow 包成「幾個參數」的送單入口。
 * Ported from the former Python server (2026-09); this file is now the only implementation.
 *
 * A recipe is a packaged, parameterised ComfyUI workflow. The point is the
 * MCP server (and any other non-expert caller): an AI agent should be able to
 * ask for "a picture of a red fox, 1024x1024" without holding a whole
 * API-format node graph in its head, and without ComfyFed having to trust
 * whatever graph it would otherwise invent.
 *
 * 檔案（spec §5.1）：`src/core/recipes/<id>.json`，原本與 Python 那一側的
 * 同名 JSON **逐位元相同**，現在只剩 `cloud/src/core/recipes/<id>.json` 這一份
 * （`test/recipes.spec.ts` 的 parity 測試比對兩份檔案）。Python 掃目錄讀檔、壞檔跳過並留 log；Worker
 * 沒有檔案系統，配方是 `import` 進 bundle 的 JSON —— 壞掉的 JSON 在 build 期
 * 就爆，而不是 runtime 安靜地少一筆，所以那一側的 loader 故障模式（缺目錄、
 * 壞檔）在這裡結構上不存在。新增一個配方 = 多一個 `import` 加進 `BUNDLED`。
 *
 * 每個檔案是：
 *
 *     {"id", "title"/{zh-TW,en}, "description", "params": [...],
 *      "required_models": [...], "workflow": {API-format 節點圖}}
 *
 * `workflow` 裡凡是可調的位置，檔內寫成 `{"$param": "<name>"}` 標記，**不寫
 * 字面值** —— 渲染時整個物件被換成該參數的值（型別保留）。這樣「配方檔」與
 * 「這次要跑的值」永遠是分開的兩件事，檔案本身不會偷偷夾帶預設值。
 */

import chromaT2I from "./recipes/chroma-t2i.json";
import fluxT2I from "./recipes/flux-t2i.json";
import h3T2V from "./recipes/h3-t2v.json";
import * as assess from "./assess";
import * as modelFetch from "./model_fetch";
import * as queries from "../db/queries";
import type { Env } from "../env";

export type Recipe = Record<string, any>;

/** `seed` 的哨兵值：使用者要「隨機」時送 -1，伺服器換成一個真的隨機值，並把
 * 換好的值回報給呼叫端（回應的 `params`），這樣同一張圖才重現得出來。 */
const RANDOM_SEED_SENTINEL = -1;
const SEED_SPACE = 2 ** 32;

/** 這個陣列的順序不決定端點的順序 —— 對外的順序由 `sortedRecipes()` 依
 * `order` 決定（§12.1）。新增配方 = `cp` 一份 Python 那側的檔案過來、加一個
 * `import`、把它加進這裡（`test/recipes.spec.ts` 的 parity 測試會同時檢查
 * 「兩份檔案逐位元相同」與「檔案有沒有真的被 import 進 bundle」）。 */
const BUNDLED: Recipe[] = [chromaT2I as Recipe, fluxT2I as Recipe, h3T2V as Recipe];

/** 配方層的錯誤，帶著要送進錯誤信封的 `code`／`message`。
 *
 * 只有 `recipes.bad_params`（使用者給錯參數，400）與 `recipes.bad_recipe`
 * （配方檔本身壞了，500）兩種來源 —— 路由端據此決定狀態碼。 */
export class RecipeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function badParams(message: string): RecipeError {
  return new RecipeError("recipes.bad_params", message);
}

/** `RecipeError.code` -> HTTP 狀態碼，`routes/recipes.ts` 的唯一對照表：
 * 使用者給錯參數是 400，配方檔自己壞掉是 500。 */
export function statusForCode(code: string): number {
  return code === "recipes.bad_params" ? 400 : 500;
}

/** `{recipe_id: 配方檔內容}`，依檔內 `id` 建索引。
 *
 * **`Object.create(null)`，不是 `{}`**：這張表唯一的用途就是拿使用者送來的
 * `recipeId` 查值，而字面量物件繼承 `Object.prototype`，於是
 * `loadRecipes()["constructor"]` 不是 `undefined`——`GET /api/recipes/constructor`
 * 會 200、`POST /api/recipes/toString/run` 甚至會建出一筆空 workflow 的 job。
 * Python 那側 `dict.get(recipe_id)` 對這些 id 一律 `None` → 404，所以有原型
 * 的表是 parity 破綻。沒有原型 = 查不到就是 `undefined`，呼叫端的
 * `=== undefined` 判斷才成立（`routes/recipes.ts` 另外再用 `Object.hasOwn`
 * 把這件事釘死一次，深度防禦）。 */
export function loadRecipes(): Record<string, Recipe> {
  const loaded: Record<string, Recipe> = Object.create(null);
  for (const recipe of BUNDLED) {
    loaded[String(recipe.id)] = recipe;
  }
  return loaded;
}

/** 端點回傳的形狀（spec §5.2）。
 *
 * 清單不帶 `workflow`：節點圖比其他所有欄位加起來還大好幾倍，而挑配方的人
 * 只需要看得懂的那幾個欄位；要圖的人再打單筆端點。
 *
 * 回傳的容器是淺複本：`loadRecipes()` 的結果是 bundle 裡那一份物件本身，讓
 * 呼叫端拿到指向它的同一個陣列遲早會有人就地改到它，而那會污染整個 isolate
 * 的配方定義。 */
export function publicView(recipe: Recipe, includeWorkflow: boolean): Record<string, unknown> {
  const view: Record<string, unknown> = {
    id: recipe.id,
    // `||`（不是 `??`）與 Python 的 `dict(recipe.get("title") or {})` 同強度：
    // 手改壞的配方檔裡 `"params": 0` 這種純量也退回空容器，而不是讓展開運算
    // 子丟 TypeError 變成 500。
    title: { ...(recipe.title || {}) },
    description: { ...(recipe.description || {}) },
    order: recipeOrder(recipe),
    // `=== true`（不是 truthy）：`nsfw_ok` 是對外的承諾，一個手改成 `"yes"`
    // 的配方檔不該因此被宣告成「可以出 NSFW」。同 Python 的 `is True`。
    nsfw_ok: recipe.nsfw_ok === true,
    params: [...(recipe.params || [])],
    required_models: [...(recipe.required_models || [])],
  };
  if (includeWorkflow) {
    view.workflow = { ...(recipe.workflow || {}) };
  }
  return view;
}

/** Python `repr()` 的最小子集，只為了讓錯誤訊息在兩棧長得一樣：字串加單
 * 引號，其他原樣。 */
function pyRepr(value: unknown): string {
  return typeof value === "string" ? `'${value}'` : String(value);
}

function checkNumberRange(spec: Recipe, name: string, value: number): void {
  const minimum = spec.min;
  const maximum = spec.max;
  if (minimum != null && value < minimum) {
    throw badParams(`${name}: must be >= ${minimum} (got ${value}).`);
  }
  if (maximum != null && value > maximum) {
    throw badParams(`${name}: must be <= ${maximum} (got ${value}).`);
  }

  const step = spec.step;
  if (step) {
    // 以 min 為原點算倍數：解析度類的參數（width/height）min 本來就是 step
    // 的倍數，但把原點寫死成 0 會在別的配方上給出錯誤答案。
    const origin = minimum != null ? minimum : 0;
    const offset = value - origin;
    const offGrid = Number.isInteger(step) && Number.isInteger(offset)
      ? offset % step !== 0
      : Math.abs(offset / step - Math.round(offset / step)) > 1e-9;
    if (offGrid) {
      throw badParams(`${name}: must be a multiple of ${step} (got ${value}).`);
    }
  }
}

/** 單一參數的型別／範圍檢查，回傳要用的值。 */
function coerce(spec: Recipe, name: string, value: unknown): unknown {
  const kind = spec.type ?? "string";

  if (kind === "string") {
    if (typeof value !== "string") throw badParams(`${name}: expected a string.`);
    return value;
  }

  if (kind === "boolean") {
    if (typeof value !== "boolean") throw badParams(`${name}: expected true or false.`);
    return value;
  }

  if (kind === "integer") {
    // Python 那邊要多擋一次 `bool`（它是 `int` 的子類）；JS 的 `true` 本來
    // 就不是 number，`typeof` 這一關就擋掉了 —— 同一個裁示、同一則訊息。
    if (typeof value !== "number" || !Number.isInteger(value)) {
      throw badParams(`${name}: expected an integer.`);
    }
    checkNumberRange(spec, name, value);
    return value;
  }

  if (kind === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw badParams(`${name}: expected a number.`);
    }
    checkNumberRange(spec, name, value);
    return value;
  }

  if (kind === "enum") {
    const values: unknown[] = spec.values || [];
    if (!values.includes(value)) {
      throw badParams(`${name}: must be one of [${values.map(pyRepr).join(", ")}].`);
    }
    return value;
  }

  throw new RecipeError("recipes.bad_recipe", `${name}: unknown parameter type ${pyRepr(kind)}.`);
}

/** 套預設、驗型別／範圍／enum，回傳「這次實際要用的」完整參數。
 *
 * 回傳的物件是解析完的結果：預設值已填、`seed == -1` 已換成真的隨機值，所以
 * 呼叫端（渲染、回應的 `params`）拿到的就是跑這張圖的全部事實。 */
export function validateParams(recipe: Recipe, params: Record<string, unknown>): Record<string, unknown> {
  const specs: Recipe[] = recipe.params || [];
  const byName = new Map<string, Recipe>();
  for (const spec of specs) {
    if (spec !== null && typeof spec === "object" && !Array.isArray(spec)) {
      byName.set(String(spec.name), spec);
    }
  }

  const given = { ...(params ?? {}) };
  const unknownNames = Object.keys(given).filter((name) => !byName.has(name)).sort();
  if (unknownNames.length > 0) {
    const known = [...byName.keys()].sort().join(", ");
    throw badParams(`${unknownNames[0]}: unknown parameter (known: ${known}).`);
  }

  const resolved: Record<string, unknown> = {};
  for (const [name, spec] of byName) {
    let value: unknown;
    if (Object.prototype.hasOwnProperty.call(given, name)) {
      value = given[name];
    } else if (Object.prototype.hasOwnProperty.call(spec, "default")) {
      value = spec.default;
    } else if (spec.required) {
      throw badParams(`${name}: required.`);
    } else {
      // 宣告了、沒給、也沒有 default：配方檔的 bug（作者漏了 default），但
      // 那是**這一次請求**沒辦法完成的原因，所以回 400 點名該參數，而不是讓
      // 它一路漏到渲染階段變成 500 —— 一個合法的請求永遠不該因為配方作者的
      // 疏忽收到 5xx。
      throw badParams(`${name}: no value given and the recipe declares no default.`);
    }
    resolved[name] = coerce(spec, name, value);
  }

  if (resolved.seed === RANDOM_SEED_SENTINEL) {
    resolved.seed = randomSeed();
  }
  return resolved;
}

/** Python 的 `secrets.randbelow(2**32)`，Workers 版：一個密碼學等級的 32 位
 * 元隨機整數（0 ~ 2**32 - 1）。 */
function randomSeed(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0]! % SEED_SPACE;
}

function render(value: unknown, params: Record<string, unknown>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => render(item, params));
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1 && entries[0]![0] === "$param") {
      const name = String(entries[0]![1]);
      if (!Object.prototype.hasOwnProperty.call(params, name)) {
        throw new RecipeError(
          "recipes.bad_recipe",
          `workflow references undeclared parameter ${pyRepr(name)}.`
        );
      }
      return params[name];
    }
    const out: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      out[key] = render(item, params);
    }
    return out;
  }
  return value;
}

/** 深走 `workflow`，把每個 `{"$param": name}` 換成 `params[name]`。
 *
 * 回傳的是一份新的結構，bundle 裡的配方檔不會被就地改寫（同一個 isolate 的
 * 下一次 run 還要拿到原封不動的標記）。 */
export function renderWorkflow(recipe: Recipe, params: Record<string, unknown>): Record<string, unknown> {
  return render(recipe.workflow || {}, params) as Record<string, unknown>;
}

// --- spec §12：順序／NSFW 旗標／衍生參數／缺模型自動下載 -------------------
// Ported from the former Python server's matching section.

/** 沒寫 `order` 的配方排在所有有寫的後面（spec §12.1 只要求「依 `order` 升
 * 冪」，沒說沒寫的怎麼辦 —— 排最後，因為 AI 端把第一個當預設，而一個忘了標
 * 順序的配方絕不該因為檔名剛好靠前就變成預設。 */
const DEFAULT_ORDER = 10_000;

/** 配方在 `GET /api/recipes` 的排序鍵（spec §12.1）。
 *
 * `Number.isInteger` 同時擋掉 Python 那側另外點名的 `bool`（JS 的 `true` 本
 * 來就不是 number）與浮點數，行為與 `isinstance(order, int)` 一致。 */
export function recipeOrder(recipe: Recipe): number {
  const order = recipe.order;
  return typeof order === "number" && Number.isInteger(order) ? order : DEFAULT_ORDER;
}

/** `[[id, recipe]]`，依 `order` 升冪、同 order 再依 id。
 *
 * AI 客戶端把第一個當預設（§12.3），所以這個順序是對外的承諾，不是排版。
 * id 當第二鍵只是為了「同 order 時每次回一樣的順序」—— 一個會抖動的預設比
 * 一個錯的預設更難查。 */
export function sortedRecipes(): Array<[string, Recipe]> {
  return Object.entries(loadRecipes()).sort(([idA, a], [idB, b]) => {
    const byOrder = recipeOrder(a) - recipeOrder(b);
    if (byOrder !== 0) return byOrder;
    return idA < idB ? -1 : idA > idB ? 1 : 0;
  });
}

/** 配方宣告的「缺了可以去哪裡抓」一筆（§12.2）。 */
export interface ModelSource {
  name: string;
  directory: string;
  url: string;
}

/** 配方宣告的「缺了可以去哪裡抓」清單（§12.2），只留形狀合法的項目。
 *
 * 形狀壞掉的項目在這裡就丟掉並留一行 log，而不是讓它一路走到
 * `createFetchJob` 再被 `bad_request` 擋下來：那條路徑的錯誤訊息是寫給
 * 「按了面板下載鈕的人」看的，對一個配方檔的打字錯誤毫無幫助。 */
export function modelSources(recipe: Recipe): ModelSource[] {
  const raw = recipe.model_sources;
  if (!Array.isArray(raw)) return [];
  const out: ModelSource[] = [];
  for (const source of raw) {
    if (source === null || typeof source !== "object" || Array.isArray(source)) continue;
    const name = source.name;
    // `directory` 可以不寫（模型落在 models 根目錄），但寫了就必須是字串 ——
    // 同 Python 的 `source.get("directory", "")`：**缺鍵**才退回空字串，寫成
    // `null` 是壞掉的項目，不是「不寫」。
    const directory = "directory" in source ? source.directory : "";
    const url = source.url;
    if (!(typeof name === "string" && name && typeof directory === "string" && typeof url === "string" && url)) {
      console.warn(`recipes: ${recipe.id} has a malformed model_sources entry`, source);
      continue;
    }
    out.push({ name, directory, url });
  }
  return out;
}

/** worker inventory 用的名字：`<directory>/<name>`（agent 的 `scan_models`
 * 回報的就是相對 models 根目錄的路徑）。 */
function inventoryPath(source: ModelSource): string {
  const directory = source.directory.replace(/^\/+|\/+$/g, "");
  return directory ? `${directory}/${source.name}` : source.name;
}

/** `model_sources` 裡「聯邦內沒有任何活著的 worker 持有」的那些 name。
 *
 * 「活著」= 未軟刪除且未停用（§12.2）。停用與刪除的差別在這裡刻意抹平：兩者
 * 都不會被派工，所以它們手上的檔案不能算數 —— 這跟 `model_fetch` 的
 * `fleetHasModel`「連離線的都算」是不同的問題（那個問的是「要不要再抓一
 * 份」，這個問的是「現在派得出這張圖嗎」）。
 *
 * 比對交給 `assess.findModel`／`matchesModelName`，也就是派工時用的同一把尺；
 * 自己寫一次字串比對遲早會跟派工的答案打架。
 *
 * `workers` 由呼叫端給（`queries.getAllWorkers` 的結果，軟刪除已在 SQL 濾
 * 掉），停用在這裡濾。這是 Python 的 `missing_models(session, recipe)` 改成
 * 「共用一次查詢」的形狀：清單端點有三個配方，每筆各查一次 worker 表會把一個
 * O(1) 的查詢變成 O(配方數)。 */
export function missingModels(workers: queries.Worker[], recipe: Recipe): string[] {
  const sources = modelSources(recipe);
  if (sources.length === 0) return [];

  const inventories = workers.filter((w) => !w.disabled).map((w) => w.modelInventory);
  return sources
    .filter((source) => {
      const needed = inventoryPath(source);
      return !inventories.some((inventory) => assess.findModel(inventory, needed)[0]);
    })
    .map((source) => source.name);
}

/** `ensureModelFetches` 回報的一筆（§12.2 的 `model_fetch_jobs`）。欄位名是
 * 對外的 wire shape，所以是 snake_case 的 `job_id`，與 Python 同字。 */
export interface ModelFetchStarted {
  name: string;
  job_id: string;
  reused: boolean;
}

/** 對每個「缺」的 `model_sources` 項目建一筆 `kind=model_fetch` job。
 *
 * 回 `[{name, job_id, reused}]`（§12.2）。去重、HEAD 探測、白名單、「有沒有
 * worker 接得住」全部交給 `model_fetch.createFetchJob` —— 那是面板下載鈕走的
 * 同一條路，所以配方觸發的下載與人手動觸發的下載不可能有兩套規則。
 *
 * `FetchRequestError` 一律吞掉只留 log：下載排不出來（來源要登入、沒有夠格的
 * worker、網域不在白名單）是「這張圖會等久一點」，不是「這次送單不合法」。送
 * 單本身照常成功，job 排在佇列裡，等模型到位就派得出去。
 *
 * `head` 每次都從模組命名空間上現讀（`modelFetch.headSizeBytes`），與
 * `routes/comfyapi.ts` 的下載鈕同一個寫法：那個晚綁定就是測試的唯一接縫
 * （`vi.spyOn(modelFetch, "headSizeBytes")`），production 這側則沒有任何可寫
 * 的開關。 */
export async function ensureModelFetches(
  env: Env,
  recipe: Recipe,
  userId: string | null
): Promise<ModelFetchStarted[]> {
  const sources = modelSources(recipe);
  if (sources.length === 0) return [];

  let missing: Set<string>;
  try {
    missing = new Set(missingModels(await queries.getAllWorkers(env.DB), recipe));
  } catch (err) {
    // DB 出事不該讓送單整條掛掉。
    console.error(`recipes: could not compute missing models for ${recipe.id}`, err);
    return [];
  }

  const started: ModelFetchStarted[] = [];
  for (const source of sources) {
    if (!missing.has(source.name)) continue;
    try {
      const { jobId, reused } = await modelFetch.createFetchJob(
        env,
        { name: source.name, directory: source.directory, url: source.url, userId },
        { head: modelFetch.headSizeBytes }
      );
      started.push({ name: source.name, job_id: jobId, reused });
    } catch (err) {
      if (err instanceof modelFetch.FetchRequestError) {
        console.warn(
          `recipes: ${recipe.id} -- no auto-fetch for ${source.name} (${err.code}): ${err.message}`
        );
        continue;
      }
      throw err;
    }
  }
  return started;
}

/** `h3-t2v` 的 `length`（幀數），由 `seconds` 依 §12.1 的式子算出。
 *
 * 模型只吃 17k+5 的幀數格點（object_info 的 `length` 也寫 `step: 17`、
 * `min: 5`），所以秒數先換算成 24 fps 的幀數，再往上補到最近的格點：
 * `seconds=5` → 120 → 124（＝官方範本的值）。官方範本用一顆
 * `ComfyMathExpression` 節點算，配方不搬那顆節點 —— 圖裡只放算好的整數，因為
 * AI 端送的是秒數，而「秒數怎麼變成幀數」是平台該負責的事。
 *
 * 型別不對就丟 `recipes.bad_params`（400），不是回一個空物件：回空物件會讓
 * `{"$param": "length"}` 變成「配方引用了未宣告的參數」→ `bad_recipe` → 500，
 * 而那是使用者送錯型別，不是配方壞了。正常路徑上 `validateParams` 早就擋下
 * 來了（`seconds` 宣告為 `number`），所以這條只在有人直接呼叫這個模組時才會
 * 走到 —— 它仍然必須給出「使用者的錯」那個答案。 */
function h3Length(params: Record<string, unknown>): Record<string, unknown> {
  const seconds = params.seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) {
    throw badParams("seconds: expected a number.");
  }
  const frames = Math.max(5, Math.round(seconds * 24));
  // `%` 在 JS 是餘數不是模：`(5 - 24 % 17) % 17` 給 -2（Python 給 15），那會
  // 把 length 算成 22 —— 一個不在 17k+5 格點上的幀數，模型直接拒收。所以取模
  // 走 `((x % n) + n) % n`，與 Python 的 `%` 同號。
  const pad = (((5 - (frames % 17)) % 17) + 17) % 17;
  return { length: frames + pad };
}

/** `{recipe_id: 算衍生值的函式}`。衍生值刻意不寫成配方檔裡的運算式：配方檔是
 * 資料，不是程式碼，一個能在檔裡寫運算式的格式就是一個可以被塞進任意運算的
 * 格式。要加新的衍生值就在這裡加一個具名函式。
 *
 * `Object.create(null)` 的理由同 `loadRecipes()`：查的鍵是配方 id，而字面量
 * 物件上 `DERIVED["constructor"]` 不是 `undefined`。 */
const DERIVED: Record<string, (params: Record<string, unknown>) => Record<string, unknown>> =
  Object.assign(Object.create(null), { "h3-t2v": h3Length });

/** 在已驗證的參數上疊出衍生值，回傳「渲染真正要用的」那份。
 *
 * 順序是固定的：先 `validateParams`（宣告過的參數），再這裡（衍生值），最後
 * `renderWorkflow`。所以 `{"$param": "length"}` 在 `h3-t2v` 裡合法，即使
 * `length` 不是宣告的參數 —— 但使用者仍然送不進 `length`（`validateParams`
 * 會把它當未知參數擋掉），衍生值只能由伺服器算。 */
export function derivedParams(recipe: Recipe, params: Record<string, unknown>): Record<string, unknown> {
  const resolved = { ...(params ?? {}) };
  const compute = DERIVED[String(recipe.id)];
  if (compute === undefined) return resolved;
  return { ...resolved, ...compute(resolved) };
}
