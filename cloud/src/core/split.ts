/**
 * Phase 3.3 §3: 批次拆分。Parity source: `server/comfyfed_server/split.py`。
 * 本檔上半是純函數（可拆判定、子 workflow 重寫、分片）；下半（Task 6）是父
 * job 狀態推導與輸出組裝，那部分要碰 D1。
 *
 * 一致性依據見 spec §3.1：`LatentFromBatch` 會設定 `batch_index`，ComfyUI 的
 * `prepare_noise` 因此逐片產生雜訊並只保留指定片，所以拆出來的第 i 張和整批
 * 跑的第 i 張是「同 seed 同構圖」-- 不是逐位元相同，差異等同於同一個 job 落
 * 在不同 GPU 上本來就有的差異。
 */

export const MAX_SPLIT = 8;

/** §3.2 條件 1：批次來源節點。 */
export const BATCH_SOURCE_CLASSES = ["EmptyLatentImage", "EmptySD3LatentImage"];

/** §3.2 條件 3：白名單，逐字取自 spec。名單外的任何節點（含所有自訂節點、
 * ImageBatch / LatentBatch / RepeatLatentBatch / RebatchLatents、影片節點）
 * 一律不可拆 -- 這是 allowlist，不是 denylist。 */
export const SPLIT_SAFE_CLASSES: ReadonlySet<string> = new Set([
  // 載入
  "CheckpointLoaderSimple",
  "UNETLoader",
  "DualCLIPLoader",
  "TripleCLIPLoader",
  "CLIPLoader",
  "VAELoader",
  "LoraLoader",
  "LoraLoaderModelOnly",
  "ControlNetLoader",
  "UpscaleModelLoader",
  "CLIPVisionLoader",
  "StyleModelLoader",
  "CLIPSetLastLayer",
  // 條件
  "CLIPTextEncode",
  "CLIPTextEncodeSDXL",
  "CLIPTextEncodeFlux",
  "ConditioningCombine",
  "ConditioningConcat",
  "ConditioningSetArea",
  "ConditioningSetAreaPercentage",
  "ConditioningZeroOut",
  "ConditioningSetTimestepRange",
  "FluxGuidance",
  "ControlNetApply",
  "ControlNetApplyAdvanced",
  // 模型調整
  "ModelSamplingFlux",
  "ModelSamplingSD3",
  "ModelSamplingDiscrete",
  // 取樣
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
  "RandomNoise",
  "KSamplerSelect",
  "BasicScheduler",
  "BasicGuider",
  "CFGGuider",
  "DisableNoise",
  // Latent / 影像
  "EmptyLatentImage",
  "EmptySD3LatentImage",
  "VAEDecode",
  "VAEDecodeTiled",
  "VAEEncode",
  "VAEEncodeForInpaint",
  "SetLatentNoiseMask",
  "LatentUpscale",
  "LatentUpscaleBy",
  "ImageScale",
  "ImageScaleBy",
  "ImageUpscaleWithModel",
  "ImageInvert",
  "ImageCrop",
  "ImagePadForOutpaint",
  "LoadImage",
  "LoadImageMask",
  "SaveImage",
  "PreviewImage",
]);

/** §3.2 條件 4：沿 LATENT 邊往上追時，允許「原封不動傳遞 latent 批次結構」
 * 的中繼節點。VAEEncode 之類「從別的型別造出 latent」的節點刻意不在這裡。 */
const LATENT_PASSTHROUGH_CLASSES: ReadonlySet<string> = new Set([
  "LatentUpscale",
  "LatentUpscaleBy",
  "SetLatentNoiseMask",
  "KSampler",
  "KSamplerAdvanced",
  "SamplerCustom",
  "SamplerCustomAdvanced",
]);

const LATENT_INPUT_FIELDS = ["latent_image", "samples"];

/** §3.2 條件 6：輸出節點。每一個都必須以批次來源為祖先，否則一條跟批次無關
 * 的側支線（例如 LoadImage -> VAEEncode -> VAEDecode -> SaveImage）會在每個
 * 子 workflow 都跑一次，輸出在父 job 被複製 k 份。 */
const OUTPUT_CLASSES: ReadonlySet<string> = new Set(["SaveImage", "PreviewImage"]);

const SPLIT_NODE_ID = "cfsplit";

export interface SplitPlan {
  sourceNodeId: string;
  batchSize: number;
}

interface NodeEntry {
  nodeId: string;
  classType: string;
  inputs: Record<string, unknown>;
}

function nodes(workflow: Record<string, unknown> | null | undefined): NodeEntry[] {
  const result: NodeEntry[] = [];
  for (const [nodeId, node] of Object.entries(workflow ?? {})) {
    if (typeof node !== "object" || node === null) continue;
    const record = node as Record<string, unknown>;
    if (typeof record.class_type !== "string") continue;
    const inputs = typeof record.inputs === "object" && record.inputs !== null ? (record.inputs as Record<string, unknown>) : {};
    result.push({ nodeId: String(nodeId), classType: record.class_type, inputs });
  }
  return result;
}

function literalInt(inputs: Record<string, unknown>, field: string): number | null {
  const value = inputs[field];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

/** ComfyUI API 格式的接線是 `[node_id, slot]`；回傳來源 node_id 字串，不論
 * slot 是多少。用於條件 6 的祖先追溯（那邊刻意忽略 slot）。 */
function linkTarget(value: unknown): string | null {
  if (Array.isArray(value) && value.length >= 1 && (typeof value[0] === "string" || typeof value[0] === "number")) {
    return String(value[0]);
  }
  return null;
}

/** 跟 `linkTarget` 一樣，但只有接線指向 slot 0 才算數。條件 4 的 latent 追溯
 * 要用這個 -- 接到 `[source, 1]`（來源節點的第二個輸出）不算追到批次來源，
 * 因為那不是 `LatentFromBatch` 會重寫的那個輸出槽。 */
function linkTargetSlot0(value: unknown): string | null {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    typeof value[1] === "number" &&
    value[1] === 0
  ) {
    return String(value[0]);
  }
  return null;
}

function reachesBatchSource(
  nodeId: string | null,
  sourceNodeId: string,
  byId: Map<string, NodeEntry>,
  seen: Set<string>
): boolean {
  if (nodeId === null || seen.has(nodeId)) return false;
  seen.add(nodeId);
  if (nodeId === sourceNodeId) return true;
  const entry = byId.get(nodeId);
  if (!entry) return false;
  if (!LATENT_PASSTHROUGH_CLASSES.has(entry.classType)) return false;
  for (const field of LATENT_INPUT_FIELDS) {
    if (field in entry.inputs) {
      return reachesBatchSource(linkTargetSlot0(entry.inputs[field]), sourceNodeId, byId, seen);
    }
  }
  return false;
}

function hasAncestor(
  nodeId: string | null,
  sourceNodeId: string,
  byId: Map<string, NodeEntry>,
  seen: Set<string>
): boolean {
  if (nodeId === null || seen.has(nodeId)) return false;
  seen.add(nodeId);
  if (nodeId === sourceNodeId) return true;
  const entry = byId.get(nodeId);
  if (!entry) return false;
  for (const value of Object.values(entry.inputs)) {
    const parentId = linkTarget(value);
    if (parentId !== null && hasAncestor(parentId, sourceNodeId, byId, seen)) return true;
  }
  return false;
}

/** §3.2 -- ports `split.split_plan`：六個條件全部成立才回傳計畫。 */
export function splitPlan(
  workflow: Record<string, unknown>,
  requirements?: Record<string, unknown> | null,
  splitBatches = true
): SplitPlan | null {
  if (!splitBatches) return null;
  if (requirements && requirements.split === false) return null;

  const entries = nodes(workflow);
  if (entries.length === 0) return null;
  const byId = new Map(entries.map((e) => [e.nodeId, e] as const));

  // 條件 1
  const sources = entries
    .filter((e) => BATCH_SOURCE_CLASSES.includes(e.classType))
    .map((e) => ({ nodeId: e.nodeId, batchSize: literalInt(e.inputs, "batch_size") }))
    .filter((s): s is { nodeId: string; batchSize: number } => s.batchSize !== null && s.batchSize >= 2);
  if (sources.length !== 1) return null;
  const { nodeId: sourceNodeId, batchSize } = sources[0]!;

  // 條件 2
  for (const entry of entries) {
    if (entry.nodeId !== sourceNodeId && "batch_size" in entry.inputs) return null;
  }

  // 條件 3
  for (const entry of entries) {
    if (!SPLIT_SAFE_CLASSES.has(entry.classType)) return null;
  }

  // 條件 4
  for (const entry of entries) {
    if (!(entry.classType.startsWith("KSampler") || entry.classType.startsWith("SamplerCustom"))) continue;
    const latentField = LATENT_INPUT_FIELDS.find((f) => f in entry.inputs);
    if (latentField === undefined) continue; // KSamplerSelect 之類不吃 latent
    if (!reachesBatchSource(linkTargetSlot0(entry.inputs[latentField]), sourceNodeId, byId, new Set())) {
      return null;
    }
  }

  // 條件 6
  for (const entry of entries) {
    if (!OUTPUT_CLASSES.has(entry.classType)) continue;
    if (!hasAncestor(entry.nodeId, sourceNodeId, byId, new Set())) return null;
  }

  return { sourceNodeId, batchSize };
}

function freeSplitNodeId(workflow: Record<string, unknown>): string {
  if (!(SPLIT_NODE_ID in workflow)) return SPLIT_NODE_ID;
  let index = 1;
  while (`${SPLIT_NODE_ID}_${index}` in workflow) index += 1;
  return `${SPLIT_NODE_ID}_${index}`;
}

/** §3.3 -- ports `split.child_workflow`；找不到任何引用來源節點的輸入時回
 * null 並記 warning（理論上被 §3.2 條件 4 擋掉，見 spec §5）。 */
export function childWorkflow(
  workflow: Record<string, unknown>,
  plan: SplitPlan,
  start: number,
  length: number
): Record<string, unknown> | null {
  const child = JSON.parse(JSON.stringify(workflow)) as Record<string, unknown>;
  const splitNodeId = freeSplitNodeId(child);

  let rewired = 0;
  for (const node of Object.values(child)) {
    if (typeof node !== "object" || node === null) continue;
    const inputs = (node as Record<string, unknown>).inputs;
    if (typeof inputs !== "object" || inputs === null) continue;
    const inputRecord = inputs as Record<string, unknown>;
    for (const [field, value] of Object.entries(inputRecord)) {
      if (linkTargetSlot0(value) === plan.sourceNodeId) {
        inputRecord[field] = [splitNodeId, 0];
        rewired += 1;
      }
    }
  }

  if (rewired === 0) {
    console.warn(`split: no input references batch source node ${plan.sourceNodeId}; refusing to split`);
    return null;
  }

  child[splitNodeId] = {
    class_type: "LatentFromBatch",
    inputs: { samples: [plan.sourceNodeId, 0], batch_index: start, length },
  };
  return child;
}

/** §3.3 -- ports `split.partition`：前 `B mod k` 段長 `ceil(B/k)`，其餘
 * `floor(B/k)`；`k` 先夾在 `1..min(batchSize, MAX_SPLIT)`。 */
export function partition(batchSize: number, k: number): [number, number][] {
  const count = Math.max(1, Math.min(k, batchSize, MAX_SPLIT));
  const base = Math.floor(batchSize / count);
  const remainder = batchSize % count;
  const ranges: [number, number][] = [];
  let start = 0;
  for (let index = 0; index < count; index++) {
    const length = base + (index < remainder ? 1 : 0);
    ranges.push([start, length]);
    start += length;
  }
  return ranges;
}
