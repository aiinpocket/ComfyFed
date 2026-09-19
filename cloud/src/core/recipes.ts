/**
 * 配方（recipe）：把一張跑得通的 workflow 包成「幾個參數」的送單入口。
 * Parity source: `server/comfyfed_server/recipes.py`, ported case for case.
 *
 * A recipe is a packaged, parameterised ComfyUI workflow. The point is the
 * MCP server (and any other non-expert caller): an AI agent should be able to
 * ask for "a picture of a red fox, 1024x1024" without holding a whole
 * API-format node graph in its head, and without ComfyFed having to trust
 * whatever graph it would otherwise invent.
 *
 * 檔案（spec §5.1）：`src/core/recipes/<id>.json`，與 Python 那一側的
 * `comfyfed_server/recipes/<id>.json` **逐位元相同**（`test/recipes.spec.ts`
 * 的 parity 測試比對兩份檔案）。Python 掃目錄讀檔、壞檔跳過並留 log；Worker
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

import fluxT2I from "./recipes/flux-t2i.json";

export type Recipe = Record<string, any>;

/** `seed` 的哨兵值：使用者要「隨機」時送 -1，伺服器換成一個真的隨機值，並把
 * 換好的值回報給呼叫端（回應的 `params`），這樣同一張圖才重現得出來。 */
const RANDOM_SEED_SENTINEL = -1;
const SEED_SPACE = 2 ** 32;

const BUNDLED: Recipe[] = [fluxT2I as Recipe];

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

/** `{recipe_id: 配方檔內容}`，依檔內 `id` 建索引。 */
export function loadRecipes(): Record<string, Recipe> {
  const loaded: Record<string, Recipe> = {};
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
    title: { ...(recipe.title ?? {}) },
    description: { ...(recipe.description ?? {}) },
    params: [...(recipe.params ?? [])],
    required_models: [...(recipe.required_models ?? [])],
  };
  if (includeWorkflow) {
    view.workflow = { ...(recipe.workflow ?? {}) };
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
    const values: unknown[] = spec.values ?? [];
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
  const specs: Recipe[] = recipe.params ?? [];
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
  return render(recipe.workflow ?? {}, params) as Record<string, unknown>;
}
