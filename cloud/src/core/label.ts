/**
 * Job 名稱（`jobs.label`）與成品類型的純函式 —— 自原 Python 伺服器移植
 * （2026-09）；本檔現為唯一實作。對應原 Python `jobs` 模組的 `LABEL_MAX_CHARS`、
 * `normalize_label`、`derive_label`、`ARTIFACT_KINDS`、`artifact_kind`
 * （2026-09-20 檔案頁 §2）。
 *
 * 這四個東西刻意獨立成一個沒有任何 env／D1／R2 相依的模組：它們是 server
 * 與 cloud 之間唯一必須**逐字一致**的邏輯（同一張 workflow 在兩邊送出必須
 * 得到同一個名稱，否則同一個使用者在自架與雲端看到的資料夾會不一樣），而
 * 能被 `test/label.spec.ts` 直接當函式呼叫、與 Python 那側同一組案例逐條
 * 對照的前提，就是它不需要先站起一個 Worker。
 */

// 2026-09-20 檔案頁 §2：`jobs.label` 的長度上限。截斷而不是拒絕 -- 名稱只是
// 給人看的資料夾名，一個過長的 `filename_prefix` 不該讓整張單建不起來。
export const LABEL_MAX_CHARS = 64;

// 檔案頁的縮圖要知道一個成品該用 `<img>`、`<video>` 還是純圖示。判斷只看副檔名
// （小寫），沒對到的一律 "other"。server（`jobs.ARTIFACT_KINDS`）與 cloud
// 必須逐字一致。
export const ARTIFACT_KINDS: Record<string, string> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  webp: "image",
  gif: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
};

/** `"image"` / `"video"` / `"other"` for an artifact filename. */
export function artifactKind(filename: unknown): string {
  if (typeof filename !== "string" || !filename.includes(".")) return "other";
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  // `Object.prototype` 上的名字（"constructor"、"toString"…）不是副檔名，
  // 但在物件字面值上查得到 —— 用 own-property 檢查擋掉，同 recipes.ts 的
  // 那道 prototype-key 防線。
  return Object.prototype.hasOwnProperty.call(ARTIFACT_KINDS, ext) ? ARTIFACT_KINDS[ext]! : "other";
}

/**
 * A caller-supplied label as it goes into the DB, or null.
 *
 * Strip, cut to `LABEL_MAX_CHARS`, and map "" (and anything that isn't a
 * string -- a JSON body can carry a number or a list where a name was
 * expected) to null, so "no name" has exactly ONE representation in the
 * column and the console never has to tell `""` from `NULL`.
 */
export function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim().slice(0, LABEL_MAX_CHARS) || null;
}

/**
 * Guess a job name from an API-format workflow's first Save node.
 *
 * 2026-09-20 檔案頁 §2.2: walk the nodes in **node-id string order** (the
 * same order on every host and in the self-hosted twin -- a dict's insertion
 * order is whatever the submitter's serializer happened to produce) and take
 * the first `class_type` starting with `Save` whose `inputs.filename_prefix`
 * is a non-empty string. ComfyUI allows `sub/dir/name` there and writes
 * `name_00001_.png`, so only the last segment is the name a user would
 * recognise.
 *
 * Returns null when nothing qualifies -- the job then has no label, and the
 * console falls back to its short id.
 */
export function deriveLabel(workflow: unknown): string | null {
  if (typeof workflow !== "object" || workflow === null || Array.isArray(workflow)) return null;
  const wf = workflow as Record<string, unknown>;
  // Python 的 `sorted(workflow, key=str)` 是對 str() 後的 key 做**碼點**
  // 排序；JS 的預設 `Array.sort()` 比的也是 UTF-16 碼元序，兩者只在
  // surrogate pair 與 U+E000..U+FFFF 的相對順序上會分歧，而 node id 實際上
  // 只有數字字串。明寫比較函式而不是靠預設值，是為了說清楚這是刻意選的序。
  const nodeIds = Object.keys(wf).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const nodeId of nodeIds) {
    const node = wf[nodeId];
    if (typeof node !== "object" || node === null || Array.isArray(node)) continue;
    const classType = (node as Record<string, unknown>)["class_type"];
    if (typeof classType !== "string" || !classType.startsWith("Save")) continue;
    const inputs = (node as Record<string, unknown>)["inputs"];
    const prefix =
      typeof inputs === "object" && inputs !== null && !Array.isArray(inputs)
        ? (inputs as Record<string, unknown>)["filename_prefix"]
        : null;
    if (typeof prefix !== "string") continue;
    // `rstrip("/")` -> 去掉結尾所有的 `/`（反斜線已在上一步換成 `/`）。
    const last = prefix.replace(/\\/g, "/").replace(/\/+$/, "").split("/").pop()!.trim();
    if (last) return last.slice(0, LABEL_MAX_CHARS);
  }
  return null;
}
