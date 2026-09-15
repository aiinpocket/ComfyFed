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

import * as queries from "../db/queries";
import { toSqliteTimestamp, type Job } from "../db/queries";
import { needsFromJob, verdict, type FetchableModels } from "./assess";

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

// --- DB 層（§3.4-§3.6）------------------------------------------------------
// Parity source: `split.py` 的同名函式。

export const SPLIT_BATCHES_SETTING_KEY = "split_batches";

/** 子 job 被兄弟拖著一起收攤時寫進 `error` 的理由（見 `refreshParent`）。 */
const SIBLING_FAILED_REASON = "sibling failed";
const SIBLING_CANCELLED_REASON = "sibling cancelled";

/** 還沒終止、因此會被串聯取消掃到的狀態。 */
const LIVE_STATUSES: readonly string[] = ["queued", "assigned", "running"];

/** 平台設定 `split_batches`（預設 true）。任何非 "0" 的值都算開啟，和其他
 * boolean 設定的寬鬆讀法一致 -- ports `split.split_batches_enabled`. */
export async function splitBatchesEnabled(db: D1Database): Promise<boolean> {
  try {
    const value = await queries.getSetting(db, SPLIT_BATCHES_SETTING_KEY);
    return value === null || value === undefined ? true : value !== "0";
  } catch (err) {
    console.error("split: failed to read the split_batches setting", err);
    return true;
  }
}

/** 送件時算一次，回傳要存進 `jobs.split_plan` 的 JSON 字串（不可拆 = null）
 * -- ports `split.plan_for_job`. */
export function planForJob(
  workflow: Record<string, unknown>,
  requirements: Record<string, unknown> | null,
  splitBatches: boolean
): string | null {
  const plan = splitPlan(workflow, requirements, splitBatches);
  if (plan === null) return null;
  return JSON.stringify({ source_node_id: plan.sourceNodeId, batch_size: plan.batchSize });
}

function planFromJson(raw: string | null): SplitPlan | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const record = data as Record<string, unknown>;
  const sourceNodeId = record.source_node_id;
  const batchSize = record.batch_size;
  if (
    typeof sourceNodeId !== "string" ||
    typeof batchSize !== "number" ||
    !Number.isInteger(batchSize) ||
    batchSize < 2
  ) {
    return null;
  }
  return { sourceNodeId, batchSize };
}

/** `parentId` 的子 job，依 split_index 排序 -- ports `split.children_of`. */
export async function childrenOf(db: D1Database, parentId: string): Promise<Job[]> {
  return queries.getChildJobs(db, parentId);
}

/** §3.3 + §3.5 -- ports `split.create_children`；回傳實際建立的子 job 數，
 * 0 = 沒拆。
 *
 * 父 job 的 `split_count` 更新與每一個子 job 的 INSERT 全部放進同一個
 * `db.batch([...])`：D1 沒有別的跨 statement 交易 seam，而 spec §5 要求「拆到
 * 一半失敗 -> 父 job 維持原狀」-- 批次是全成或全不成，所以中途失敗不會留下
 * 「父 job 已標成已拆但只有 3 個子 job」這種狀態。本輪當作不可拆處理，下個
 * tick 重試。 */
export async function createChildren(db: D1Database, parentId: string, k: number): Promise<number> {
  try {
    const parent = await queries.getJobById(db, parentId);
    if (!parent || parent.status !== "queued" || parent.splitCount !== 0) return 0;
    const plan = planFromJson(parent.splitPlan);
    if (plan === null) return 0;

    let workflow: unknown;
    try {
      workflow = JSON.parse(parent.workflowJson || "{}");
    } catch {
      return 0;
    }
    if (typeof workflow !== "object" || workflow === null) return 0;
    const wf = workflow as Record<string, unknown>;

    // 子 workflow 多了一個 `LatentFromBatch`，資格判定（§2.3 的 requiredNodes
    // 檢查）必須看得到它，否則子 job 會被派給一台其實跑不動它的 worker。
    const childNodes = [...new Set([...parent.requiredNodes, "LatentFromBatch"])].sort();
    const ranges = partition(plan.batchSize, k);
    const children: queries.NewChildJob[] = [];
    for (let index = 0; index < ranges.length; index++) {
      const [start, length] = ranges[index]!;
      const childJson = childWorkflow(wf, plan, start, length);
      if (childJson === null) return 0;
      children.push({
        id: crypto.randomUUID(),
        parentId: parent.id,
        splitIndex: index,
        workflowJson: JSON.stringify(childJson),
        // 承襲父 job，保住在佇列中的位置與派工資格判定。
        createdAt: parent.createdAt,
        signature: parent.signature,
        requiredNodes: childNodes,
        requiredModels: parent.requiredModels,
        estVramGb: parent.estVramGb,
        requirements: parent.requirements,
        inputAssets: parent.inputAssets,
        origin: parent.origin,
        userId: parent.userId,
      });
    }
    if (children.length < 1) return 0;

    const results = await db.batch([
      queries.markJobSplitStatement(db, parent.id, children.length),
      ...children.map((child) => queries.childJobInsertStatement(db, child, children.length)),
    ]);
    // 搶輸的情況（別人先 claim 或先拆了這件父 job）：UPDATE 動到 0 列，批次裡
    // 的每個 INSERT 的守衛條件也因此不成立，所以一個子 job 都沒進去。
    if ((results[0]?.meta.changes ?? 0) !== 1) return 0;
    return children.length;
  } catch (err) {
    console.error(`split: createChildren failed for parent ${parentId}`, err);
    return 0;
  }
}

/** §3.5 -- ports `split.create_children_for_tick`；回傳有沒有真的拆出東西。
 *
 * `consumed` 是「前面的 job 大概會用掉幾台 worker」的估計而不是精確保留 --
 * 真正的配對是後面的 Hungarian 在做，這裡寧可少拆不多拆。 */
export async function createChildrenForTick(
  db: D1Database,
  queuedJobs: Job[],
  workers: queries.Worker[],
  allWorkers: queries.Worker[],
  fetchableModels?: FetchableModels | null,
  peerOnlyModels?: ReadonlySet<string> | null
): Promise<boolean> {
  const totalWorkers = workers.length;
  let consumed = 0;
  let splitAny = false;

  for (const job of queuedJobs) {
    const needs = needsFromJob(job);
    const eligible = workers.filter((w) => {
      const kind = verdict(w, needs, job.requirements, allWorkers, fetchableModels, peerOnlyModels).kind;
      return kind === "eligible" || kind === "eligible_after_fetch";
    }).length;

    const plan = planFromJson(job.splitPlan);
    if (plan === null) {
      if (eligible > 0) consumed += 1;
      continue;
    }

    const available = Math.min(eligible, totalWorkers) - consumed;
    const k = Math.min(plan.batchSize, available, MAX_SPLIT);
    if (k >= 2) {
      const created = await createChildren(db, job.id, k);
      if (created >= 2) {
        consumed += created;
        splitAny = true;
        continue;
      }
    }
    if (eligible > 0) consumed += 1;
  }

  return splitAny;
}

/** §3.4 -- ports `split.refresh_parent`；回傳 `{ changed, status }`。
 *
 * `splitCount === 0`（不是父 job，或重試後被重設）一律回
 * `{ changed: false, status: null }` -- 這是「重試一律不再拆」那條規則的實作
 * 點：所有以父 job 推導的函數都只在 `splitCount > 0` 時看子 job。
 *
 * `cancelledOwners`，給了的話，會被 push 上這一次串聯取消掉的
 * `[childId, workerId]`（只收取消當下真的有 owner 的那些），讓呼叫端（Hub）
 * 對那台 worker 推一次 `job_cancelled`。 */
export async function refreshParent(
  db: D1Database,
  parentId: string,
  now: Date,
  cancelledOwners?: [string, string][]
): Promise<{ changed: boolean; status: string | null }> {
  const parent = await queries.getJobById(db, parentId);
  if (!parent || parent.splitCount <= 0) return { changed: false, status: null };

  const children = await queries.getChildJobs(db, parentId);
  if (children.length === 0) return { changed: false, status: null };

  const total = children.length;
  const nowStamp = toSqliteTimestamp(now);
  const patch = {
    status: parent.status,
    progress: parent.progress,
    startedAt: parent.startedAt,
    finishedAt: parent.finishedAt,
    error: parent.error,
    workerId: parent.workerId,
  };
  let cascade: Job[] = [];
  let cascadeReason = SIBLING_FAILED_REASON;

  const failed = children.find((c) => c.status === "failed");
  const cancelled = children.find((c) => c.status === "cancelled");
  const live = (c: Job) => LIVE_STATUSES.includes(c.status);

  if (failed) {
    patch.status = "failed";
    patch.error = `子任務 ${(failed.splitIndex ?? 0) + 1}/${total}：${failed.error ?? ""}`;
    patch.finishedAt = patch.finishedAt ?? nowStamp;
    cascade = children.filter(live);
  } else if (cancelled) {
    patch.status = "cancelled";
    patch.error = cancelled.error;
    patch.finishedAt = patch.finishedAt ?? nowStamp;
    cascadeReason = SIBLING_CANCELLED_REASON;
    cascade = children.filter(live);
  } else if (children.every((c) => c.status === "done")) {
    patch.status = "done";
    const finishes = children.map((c) => c.finishedAt).filter((f): f is string => f !== null);
    patch.finishedAt = finishes.length > 0 ? finishes.slice().sort()[finishes.length - 1]! : nowStamp;
    patch.progress = 1;
  } else if (children.some((c) => c.status === "running")) {
    patch.status = "running";
    const starts = children.map((c) => c.startedAt).filter((s): s is string => s !== null);
    if (starts.length > 0) patch.startedAt = starts.slice().sort()[0]!;
    patch.progress = children.reduce((sum, c) => sum + (c.progress || 0), 0) / total;
  } else if (children.some((c) => c.status === "assigned")) {
    patch.status = "assigned";
    // 父 job 從來沒有自己的 worker：它的工作分散在子 job 身上。
    patch.workerId = null;
  } else {
    patch.status = "queued";
    patch.progress = 0;
  }

  // `workerId` 必須進這個比較：assigned 分支唯一的改動就是把它清成 null，
  // 少了這一項那次 `worker_id = NULL` 的寫入會被整個跳過。（Python 端無條件
  // commit，所以那邊沒有這個陷阱。）
  const changed =
    patch.status !== parent.status ||
    patch.progress !== parent.progress ||
    patch.startedAt !== parent.startedAt ||
    patch.finishedAt !== parent.finishedAt ||
    patch.error !== parent.error ||
    patch.workerId !== parent.workerId;

  if (changed) await queries.updateParentDerived(db, parentId, patch);

  // 串聯取消刻意不走 `dispatch.cancelJob`：那個函式尾端會呼叫
  // `childStatusChanged` -> 回到這裡，變成互相遞迴。寫的欄位和它一模一樣
  // （status/error/finished_at + 所有權釋放），所有權釋放是載重的 -- 見
  // `dispatch.cancelJob` 的 docstring。
  for (const child of cascade) {
    await queries.updateJobCancelled(db, child.id, cascadeReason, nowStamp, child.workerId);
    if (child.workerId && cancelledOwners) cancelledOwners.push([child.id, child.workerId]);
  }

  return { changed, status: patch.status };
}

/** 子 job 狀態／進度變動後的統一入口 -- ports `split.child_status_changed`.
 * 不是子 job 就什麼都不做並回 null。 */
export async function childStatusChanged(
  db: D1Database,
  jobId: string,
  now: Date,
  cancelledOwners?: [string, string][]
): Promise<string | null> {
  const job = await queries.getJobById(db, jobId);
  if (!job || !job.parentId) return null;
  const { status } = await refreshParent(db, job.parentId, now, cancelledOwners);
  return status;
}

/** §3.4 -- ports `split.parent_outputs`：`[[childId, filename], ...]`，依
 * split_index 再依各自檔案順序，所以和整批一次跑的輸出順序一致。childId 是
 * 面板 `/view` 用來找到真正持有檔案的那個 job 的 `subfolder`。 */
export async function parentOutputs(db: D1Database, parent: Job): Promise<[string, string][]> {
  if (!parent || parent.splitCount <= 0) return [];
  const outputs: [string, string][] = [];
  for (const child of await queries.getChildJobs(db, parent.id)) {
    for (const name of child.resultFiles) {
      if (typeof name === "string") outputs.push([child.id, name]);
    }
  }
  return outputs;
}
