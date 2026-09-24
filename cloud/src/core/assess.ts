/**
 * Worker-eligibility judging, ported from the former Python server (2026-09);
 * this file is now the only implementation.
 *
 * Task 8 extends this file with the workflow-walking half (`extract`,
 * `estimateVram`) that `POST /api/jobs` needs to assess a freshly-submitted
 * workflow -- `model_nodes` (per-node model->node mapping for `/comfy/api`
 * guidance messages) is still Task 9's job and belongs here too when that
 * lands; both walk the same node/input shape, so extend `iterModelRefs`
 * below rather than writing a second walker (see its docstring).
 */

import type { Job, ModelInventoryEntry, Worker } from "../db/queries";
import { bytesToHex } from "../lib/hex";
import { modelBackends } from "./model_guide";

// ---------------------------------------------------------------------------
// Workflow extraction -- ports the former Python `_MODEL_FIELD_NAMES` /
// `_MODEL_EXTENSIONS` / `_ASSET_NODE_CLASSES` / `_ASSET_FIELD_NAMES` /
// `_is_model_value` / `_iter_model_refs` / `extract`.

const MODEL_FIELD_NAMES = new Set([
  "ckpt_name",
  "unet_name",
  "clip_name",
  "clip_name1",
  "clip_name2",
  "vae_name",
  "lora_name",
  "model_name",
  "control_net_name",
  "style_model_name",
  "upscale_model_name",
]);

const MODEL_EXTENSIONS = [".safetensors", ".ckpt", ".pt", ".pth", ".sft", ".gguf"];

/** Node classes whose inputs name a file the submitter must upload with the
 * job. Mirrored client-side in web/src/lib/workflow.ts -- keep in step. */
const ASSET_NODE_CLASSES = new Set(["LoadImage", "LoadImageMask", "LoadAudio", "LoadVideo"]);

const ASSET_FIELD_NAMES = ["image", "audio", "video", "file"] as const;

function isModelValue(fieldName: string, value: unknown): value is string {
  if (!MODEL_FIELD_NAMES.has(fieldName)) return false;
  if (typeof value !== "string") return false;
  return MODEL_EXTENSIONS.some((ext) => value.endsWith(ext));
}

function isPlainNode(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node);
}

/** Yield `[nodeId, classType, modelName]` for every model-valued input field
 * in `workflow`, in the workflow's own iteration order -- ports the former Python
 * `_iter_model_refs`. Single walker shared by `extract` (only needs the set
 * of names) and Task 9's future `model_nodes` (needs the originating node
 * too) -- extraction rules must never be duplicated between them. */
function* iterModelRefs(workflow: Record<string, unknown>): Generator<[string, string, string]> {
  for (const [nodeId, node] of Object.entries(workflow ?? {})) {
    if (!isPlainNode(node)) continue;
    const classType = typeof node.class_type === "string" ? node.class_type : "";
    const inputs = node.inputs;
    if (!isPlainNode(inputs)) continue;
    for (const [fieldName, value] of Object.entries(inputs)) {
      if (isModelValue(fieldName, value)) {
        yield [nodeId, classType, value];
      }
    }
  }
}

/** Map each model name referenced by `workflow` to the nodes that reference
 * it -- ports the former Python `model_nodes`. Returns `{model_name: [[node_id,
 * class_type], ...]}`, in workflow iteration order, using the SAME walker
 * (`iterModelRefs`) `extract` uses -- see that generator's docstring for why
 * this must never fork into a second walk. Used by `/comfy/api/prompt`'s
 * missing-model rejection to build per-node `node_errors` entries so the
 * ComfyUI panel's Errors tab can show guidance on the actual offending
 * node(s). */
export function modelNodes(workflow: Record<string, unknown>): Map<string, [string, string][]> {
  const result = new Map<string, [string, string][]>();
  for (const [nodeId, classType, modelName] of iterModelRefs(workflow)) {
    const list = result.get(modelName);
    if (list) list.push([nodeId, classType]);
    else result.set(modelName, [[nodeId, classType]]);
  }
  return result;
}

/** Extract nodes/models/assets referenced by a ComfyUI API-format workflow
 * -- ports the former Python `extract`. `workflow` maps node_id -> `{class_type,
 * inputs}`. */
export function extract(workflow: Record<string, unknown>): JobNeeds {
  const nodes = new Set<string>();
  const models = new Set<string>();
  const assets = new Set<string>();

  for (const node of Object.values(workflow ?? {})) {
    if (!isPlainNode(node)) continue;
    if (typeof node.class_type === "string") nodes.add(node.class_type);

    const inputs = node.inputs;
    if (!isPlainNode(inputs)) continue;

    if (typeof node.class_type === "string" && ASSET_NODE_CLASSES.has(node.class_type)) {
      for (const assetField of ASSET_FIELD_NAMES) {
        const value = inputs[assetField];
        if (typeof value === "string") assets.add(value);
      }
    }
  }

  for (const [, , modelName] of iterModelRefs(workflow)) {
    models.add(modelName);
  }

  return { nodes, models, estVramGb: null, assets };
}

// 2026-09-19 job-retry §6：`exclusions` 命中時的兩種理由字串（兩棧逐字相同，
// console 的評估面板直接顯示）。故意在這裡重寫一份字面值而不是 import
// `core/retry.ts` -- 這個模組是純判定層，刻意不依賴任何碰 D1 的模組（`stats`
// 對 `isValidExecSeconds` 也是同一個取捨）。`retry.ts` 那份才是規格來源，兩
// 邊由 assess.spec.ts 的逐字斷言釘住，並與原 Python 版的 `_FAILED_TWICE_REASON`
// / `_UNSUITABLE_REASON_PREFIX` 對照。
const FAILED_TWICE_REASON = "failed_twice_on_job";
const UNSUITABLE_REASON_PREFIX = "unsuitable:";
const UNSUITABLE_KEY_CHARS = 12;

/** Python 的 `frozenset[tuple[str, str]]` 在 TS 裡沒有等價物（`Set` 比的是
 * 物件身分，不是內容），所以每一對 `(worker_id, job_id|task_key)` 一律先過
 * `exclusionKey` 壓成一個字串再進 `Set`。分隔符用 NUL：worker id 是 uuid、
 * job id 是 uuid、task_key 是簽章或 `model_fetch:<名稱>`，沒有一個可能含
 * NUL，所以兩段永遠不會黏在一起造成假命中。 */
export type ExclusionSet = ReadonlySet<string>;

export function exclusionKey(workerId: string, other: string): string {
  return `${workerId}\u0000${other}`;
}

/** 2026-09-19 job-retry §6：`verdict` 的排除輸入。三個都省略（既有每一個呼叫
 * 端）= 這個功能出現以前的行為，一模一樣。 */
export interface VerdictExclusions {
  /** 正在評估的那張 job 的 id，拿去和 `(worker_id, job_id)` 對。 */
  jobId?: string | null;
  /** `retry.taskKey(job)`，拿去和 `(worker_id, task_key)` 對。 */
  taskKey?: string | null;
  exclusions?: ExclusionSet | null;
}

const VRAM_FUDGE_FACTOR = 1.15;

/** Estimate a job's peak VRAM: the largest single referenced model x 1.15
 * -- ports the former Python `estimate_vram`. Returns null if no referenced model
 * has a known size anywhere in `workers`. */
export function estimateVram(models: ReadonlySet<string>, workers: Worker[]): number | null {
  let largest: number | null = null;
  for (const modelName of models) {
    for (const worker of workers) {
      const [, size] = findModel(worker.modelInventory, modelName);
      if (size !== null && (largest === null || size > largest)) largest = size;
    }
  }
  return largest === null ? null : largest * VRAM_FUDGE_FACTOR;
}

// 2026-09-23 cross-backend §4: on unified memory (Apple silicon) the weights,
// the activations, the OS and every other app share ONE pool, and macOS
// starts compressing/swapping -- then kernel-panicking -- well before it is
// full (observed: a 50 GB model set on a 64 GB M4 Pro). Only this fraction of
// the pool is treated as usable for the RESIDENT set of a job. Ports
// the former Python `UNIFIED_USABLE_FRACTION` / `UNIFIED_MEMORY_REASON`.
export const UNIFIED_USABLE_FRACTION = 0.85;
export const UNIFIED_MEMORY_REASON = "memory";

/** Sum of every referenced model's size x 1.15 -- the resident set on a
 * machine with no separate VRAM to offload to. Companion of `estimateVram`
 * (largest single model), which is the right gate for a discrete GPU. Sizes
 * come from anywhere in the federation, as there. null when no referenced
 * model has a known size. Ports the former Python `estimate_resident_gb`. */
export function estimateResidentGb(models: ReadonlySet<string>, workers: Worker[]): number | null {
  let total = 0;
  let known = false;
  for (const modelName of models) {
    let largest: number | null = null;
    for (const worker of workers) {
      const [, size] = findModel(worker.modelInventory, modelName);
      if (size !== null && (largest === null || size > largest)) largest = size;
    }
    if (largest !== null) {
      total += largest;
      known = true;
    }
  }
  return known ? total * VRAM_FUDGE_FACTOR : null;
}

/** The unified pool size a worker reported (`vram_gb` with
 * `unified_memory: true`), or null for a discrete-GPU / older agent. Ports
 * the former Python `unified_memory_gb`. */
export function unifiedMemoryGb(hardware: Record<string, unknown>): number | null {
  if (hardware["unified_memory"] !== true) return null;
  const vramGb = hardware["vram_gb"];
  if (typeof vramGb !== "number" || Number.isNaN(vramGb) || vramGb <= 0) return null;
  return vramGb;
}

export interface JobNeeds {
  nodes: Set<string>;
  models: Set<string>;
  estVramGb: number | null;
  assets: Set<string>;
}

export type VerdictKind = "eligible" | "eligible_after_fetch" | "ineligible";

export interface Verdict {
  kind: VerdictKind;
  reasons: string[];
  missingModels: string[];
  warnings: string[];
}

/** Rebuild a `JobNeeds` from the requirements already persisted on a job
 * row -- mirrors `assess.needs_from_job`. `assets` is deliberately empty:
 * input assets are uploaded at submission time and play no part in worker
 * eligibility. */
export function needsFromJob(job: Job): JobNeeds {
  return {
    nodes: new Set(job.requiredNodes),
    models: new Set(job.requiredModels),
    estVramGb: job.estVramGb,
    assets: new Set(),
  };
}

/** Free VRAM for ranking purposes, from the worker's `dynamic` heartbeat
 * snapshot. Missing/non-numeric is treated as 0 rather than raising --
 * mirrors `dispatch._free_vram_gb`. */
export function freeVramGb(worker: Worker): number {
  const value = worker.dynamic["free_vram_gb"];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeModelPath(name: string): string {
  return String(name).replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Whether an inventory entry satisfies a model a workflow asks for --
 * ports `assess.matches_model_name`. The two names are relative to
 * different roots (see that function's Python docstring); comparing them
 * with `===` fails for every real deployment. */
export function matchesModelName(inventoryName: string, neededName: string): boolean {
  const inventory = normalizeModelPath(inventoryName);
  const needed = normalizeModelPath(neededName);
  if (!inventory || !needed) return false;
  if (inventory === needed) return true;

  const slashIndex = inventory.indexOf("/");
  if (slashIndex !== -1 && inventory.slice(slashIndex + 1) === needed) return true;

  return inventory.endsWith("/" + needed);
}

/** Look `neededName` up in one worker's inventory -- ports `assess.find_model`.
 * Returns `[found, bestKnownSizeGb]`; when several entries match, the
 * largest known size wins (errs high, not low). */
export function findModel(
  inventory: ModelInventoryEntry[],
  neededName: string
): [found: boolean, sizeGb: number | null] {
  let found = false;
  let bestSize: number | null = null;
  for (const entry of inventory) {
    const name = entry?.name;
    if (typeof name !== "string" || !matchesModelName(name, neededName)) continue;
    found = true;
    const size = entry.size;
    if (typeof size === "number" && Number.isFinite(size)) {
      if (bestSize === null || size > bestSize) bestSize = size;
    }
  }
  return [found, bestSize];
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Python `round(x, 1)` for the reason strings (`memory:46.0>40.8`); the
 * `.toFixed(1)` keeps the trailing `.0` Python prints for a whole number. */
function round1(value: number): string {
  return (Math.round(value * 10) / 10).toFixed(1);
}

// ---------------------------------------------------------------------------
// Phase 2.1: eligible_after_fetch (server-signed manifest auto-download) --
// ports the former Python `_MIN_AUTO_FETCH_PROTOCOL` / `_FETCH_DISK_MARGIN` /
// `_BYTES_PER_GB` / `_worker_fetch_capacity_ok` / `_eligible_after_fetch` /
// `partition_fleet_fetchable` / `fleet_wide_gaps`.

/** `fetchableModels` maps a missing model's name (workflow-declared,
 * category-relative shape -- same as `needs.models`) to its exact
 * `size_bytes`, as published by `model_manifest.entries()`. */
export type FetchableModels = Record<string, number>;

/** hello.protocol below which an agent cannot receive fetch_models at all
 * (it predates lazy hashing / lazy inventory sha256). */
const MIN_AUTO_FETCH_PROTOCOL = 3;

/** Phase 3.1 P2P: hello.protocol below which an agent cannot pull from a
 * peer seeder at all (no chunk-table fields, no peer-grant support) -- see
 * `eligibleAfterFetch`/`partitionFleetFetchable`'s `peerOnlyModels` param. */
const MIN_PEER_FETCH_PROTOCOL = 4;

/** 2026-09-19 model_fetch (spec §6/§7): hello.protocol below which an agent
 * cannot be handed an UNVERIFIED-SOURCE manifest entry at all -- ports
 * the former Python `_MIN_UNVERIFIED_FETCH_PROTOCOL`. Such an entry carries
 * `sha256: null` and a `name|directory|url|size_bytes|unverified` signature
 * payload; a protocol<=4 agent's `fetcher._validate_entry_shape` rejects a
 * null sha256 outright and its `_verify_entry_signature` only knows the
 * verified payload, so pushing one to it can only ever produce a refused
 * fetch. Same shape as `MIN_PEER_FETCH_PROTOCOL`: only required when a
 * missing model's entry actually IS unverified (see `eligibleAfterFetch`/
 * `partitionFleetFetchable`'s `unverifiedModels` parameter) -- every
 * ordinary manifest entry keeps its existing floor. */
export const MIN_UNVERIFIED_FETCH_PROTOCOL = 5;

/** 2026-09-19 model_fetch (final-review I1): hello.protocol below which an
 * agent cannot be handed a `kind=model_fetch` JOB at all -- ports the former Python
 * `_MIN_MODEL_FETCH_PROTOCOL`. Distinct from `MIN_UNVERIFIED_FETCH_PROTOCOL`
 * in WHAT it keys off: that one gates an unverified *entry*, this one gates
 * the *job kind*, whatever its entry.
 *
 * The entry-keyed gate is not enough on its own. Spec §5.1 row 4 dispatches a
 * name the manifest already covers as its VERIFIED entry, which leaves
 * `unverifiedModels` empty -- and a worker that has meanwhile learned the
 * model itself has no missing model at all, so no model-name-keyed gate can
 * ever fire. A protocol 3/4 agent does not know the `kind` field, so it
 * treats such a push as an ordinary prompt: it sends a stage-less busy
 * heartbeat (setting `started_at`, which spec §8 says is never set) and then
 * runs the `{}` placeholder workflow, which fails. */
export const MIN_MODEL_FETCH_PROTOCOL = MIN_UNVERIFIED_FETCH_PROTOCOL;

/** The `reasons` string a model_fetch job's refusal carries when the ONLY
 * thing wrong with a candidate is its protocol version -- ports the former Python
 * `MODEL_FETCH_PROTOCOL_REASON`. */
export const MODEL_FETCH_PROTOCOL_REASON = "model_fetch_protocol";

/** `backend_unsupported:<worker backend or "unknown">:<model,...>` -- ports
 * the former Python `BACKEND_UNSUPPORTED_REASON` (2026-09-20: models default to
 * NVIDIA-only, see `model_guide.modelBackends`). */
export const BACKEND_UNSUPPORTED_REASON = "backend_unsupported";

/** Whether `worker` may be handed a `kind=model_fetch` job at all -- ports
 * the former Python `model_fetch_protocol_ok`.
 *
 * Deliberately exported and deliberately NOT folded into `verdict`: `verdict`
 * judges a job's *needs* (`JobNeeds`), which carry no kind, so the two callers
 * that do know the job row -- `dispatch.assignJobs` (the per-worker verdict
 * path) and `model_fetch.createFetchJob` (the submission-time `no_worker`
 * decision) -- apply it themselves against the same single predicate. */
export function modelFetchProtocolOk(worker: Worker): boolean {
  return workerProtocol(worker) >= MIN_MODEL_FETCH_PROTOCOL;
}

/** `worker.protocol`, normalized the same way every fetch-eligibility gate
 * here needs it: missing/non-integer degrades to 1 (the oldest,
 * least-capable value), never throws -- ports the former Python `_worker_protocol`.
 * Single helper so `workerFetchCapacityOk` and the peer-protocol check below
 * can't drift on this normalization. */
function workerProtocol(worker: Worker): number {
  return typeof worker.protocol === "number" && Number.isInteger(worker.protocol) ? worker.protocol : 1;
}

/** free_disk_gb must exceed the total download size by this factor -- not
 * just clear it -- so a fetch never lands a worker at (near-)zero free disk. */
const FETCH_DISK_MARGIN = 1.2;

const BYTES_PER_GB = 1024 ** 3;

/** Fallback budget assumed for a worker whose hello never reported
 * `max_fetch_gb` at all (Phase 3.2 F1 fix) -- missing/malformed, or hello
 * simply predates the field. Mirrors the agent's own default
 * (`agent/comfyfed_agent/config.py`'s `AgentConfig.max_fetch_gb`) so a fleet
 * that never customized the setting behaves identically whether the server
 * knows about the field or not. Ports the former Python `_DEFAULT_MAX_FETCH_GB`. */
const DEFAULT_MAX_FETCH_GB = 20.0;

/** This worker's configured auto-fetch budget (hello's optional
 * `max_fetch_gb`), stashed into the `hardware` JSON blob by `hub.ts`'s
 * `handleHello` alongside the agent-reported hardware fields.
 * Missing/non-numeric/non-positive degrades to `DEFAULT_MAX_FETCH_GB` -- the
 * same default the agent itself applies, so an old-or-silent agent is
 * treated exactly like a fresh one, never as "unlimited". Ports the former Python
 * `_worker_max_fetch_gb`. */
function workerMaxFetchGb(worker: Worker): number {
  const value = worker.hardware["max_fetch_gb"];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_FETCH_GB;
  return value;
}

/** Protocol/auto_fetch/budget/disk-margin gate, independent of WHICH models
 * are missing -- shared by `verdict`'s per-candidate gate and
 * `partitionFleetFetchable`'s fleet-wide submission-time gate. Ports
 * `assess._worker_fetch_capacity_ok`. */
function workerFetchCapacityOk(worker: Worker, dynamic: Record<string, unknown>, totalMissingGb: number): boolean {
  if (workerProtocol(worker) < MIN_AUTO_FETCH_PROTOCOL) return false;
  if (!worker.autoFetch) return false;

  // Phase 3.2 F1 fix: a worker that would refuse the download itself
  // (the agent's own max_fetch_gb check) must not be counted fetch-capable
  // here -- otherwise the platform queues a job guaranteed to fail
  // post-dispatch instead of 400ing at submission time with an actionable
  // reason.
  if (totalMissingGb > workerMaxFetchGb(worker)) return false;

  const freeDiskGb = asNumber(dynamic["free_disk_gb"]);
  if (freeDiskGb === null) {
    // Unknown free disk cannot prove the margin holds -- refuse rather than
    // warn (unlike the VRAM offload gate above).
    return false;
  }
  return freeDiskGb > FETCH_DISK_MARGIN * totalMissingGb;
}

/** All the eligible_after_fetch gates -- ports `assess._eligible_after_fetch`.
 *
 * `peerOnlyModels` (Phase 3.1 P2P; a subset of `fetchableModels`'s keys,
 * `model_manifest.peerOnlyNames`'s shape) names missing models whose ONLY
 * manifest source is a peer seeder, no URL at all. When any missing model
 * this worker needs falls in that set, the worker must ALSO be protocol>=4
 * (peer-pull capable) -- a protocol-3 worker can auto-fetch a URL-sourced
 * model fine, but has no way to speak the peer-grant/chunk-pull protocol for
 * a peer-only one. Undefined/empty (every pre-3.1 caller) means "nothing is
 * peer-only", identical to the pre-Task-6 behavior.
 *
 * `unverifiedModels` (2026-09-19 model_fetch; likewise a subset of
 * `fetchableModels`'s keys) names missing models whose entry is an
 * unverified-source one (`sha256: null`, url-in-signature). Those need
 * protocol>=5 for the same reason peer-only ones need >=4: an older agent
 * cannot even validate the entry's shape or signature. Undefined/empty means
 * "nothing is unverified", identical to the pre-2026-09-19 behavior. */
function eligibleAfterFetch(
  worker: Worker,
  missingModels: string[],
  fetchableModels: FetchableModels | null | undefined,
  dynamic: Record<string, unknown>,
  peerOnlyModels?: ReadonlySet<string> | null,
  unverifiedModels?: ReadonlySet<string> | null
): boolean {
  const map = fetchableModels ?? {};
  if (!missingModels.every((name) => Object.prototype.hasOwnProperty.call(map, name))) return false;

  const peerOnly = peerOnlyModels ?? new Set<string>();
  if (missingModels.some((name) => peerOnly.has(name)) && workerProtocol(worker) < MIN_PEER_FETCH_PROTOCOL) {
    return false;
  }

  const unverified = unverifiedModels ?? new Set<string>();
  if (
    missingModels.some((name) => unverified.has(name)) &&
    workerProtocol(worker) < MIN_UNVERIFIED_FETCH_PROTOCOL
  ) {
    return false;
  }

  const totalMissingGb = missingModels.reduce((sum, name) => sum + map[name]!, 0) / BYTES_PER_GB;
  return workerFetchCapacityOk(worker, dynamic, totalMissingGb);
}

/** Splits a fleet-wide "missing from every worker" model set into
 * `[fetchable, unfetchable]` for the submission-relaxation matrix -- ports
 * `assess.partition_fleet_fetchable`. See that Python docstring for why this
 * is a single COMBINED gate over the whole manifest-covered subset, not a
 * per-model one.
 *
 * `peerOnlyModels` (Phase 3.1 P2P, `model_manifest.peerOnlyNames`'s shape):
 * when the manifest-covered subset includes any name with no URL source at
 * all, a candidate worker must ALSO be protocol>=4 -- same rule
 * `eligibleAfterFetch` applies per-candidate, evaluated once here against
 * the combined subset.
 *
 * `unverifiedModels` (2026-09-19 model_fetch) is the same idea one notch
 * higher: an unverified-source entry in the combined subset requires a
 * candidate at protocol>=5. Undefined/empty means "nothing is unverified". */
export function partitionFleetFetchable(
  missingModels: ReadonlySet<string>,
  fetchableModels: FetchableModels | null | undefined,
  onlineEnabledWorkers: Worker[],
  peerOnlyModels?: ReadonlySet<string> | null,
  unverifiedModels?: ReadonlySet<string> | null
): [fetchable: Set<string>, unfetchable: Set<string>] {
  const map = fetchableModels ?? {};
  const manifestCovered = new Set([...missingModels].filter((name) => Object.prototype.hasOwnProperty.call(map, name)));
  const notInManifest = new Set([...missingModels].filter((name) => !manifestCovered.has(name)));

  if (manifestCovered.size === 0) return [new Set(), new Set(missingModels)];

  const peerOnly = peerOnlyModels ?? new Set<string>();
  const requiresPeerProtocol = [...manifestCovered].some((name) => peerOnly.has(name));
  const unverified = unverifiedModels ?? new Set<string>();
  const requiresUnverifiedProtocol = [...manifestCovered].some((name) => unverified.has(name));

  const totalMissingGb = [...manifestCovered].reduce((sum, name) => sum + map[name]!, 0) / BYTES_PER_GB;
  const canFetch = onlineEnabledWorkers.some(
    (worker) =>
      workerFetchCapacityOk(worker, worker.dynamic, totalMissingGb) &&
      (!requiresPeerProtocol || workerProtocol(worker) >= MIN_PEER_FETCH_PROTOCOL) &&
      (!requiresUnverifiedProtocol || workerProtocol(worker) >= MIN_UNVERIFIED_FETCH_PROTOCOL)
  );
  if (canFetch) return [manifestCovered, notInManifest];

  return [new Set(), new Set(missingModels)];
}

/** `[models, node classes]` that NOT ONE worker in `allWorkers` can supply --
 * ports `assess.fleet_wide_gaps`. Deliberately every worker passed in,
 * whatever its status/disabled (see that Python docstring). */
export function fleetWideGaps(
  needs: JobNeeds,
  allWorkers: Worker[]
): [missingModels: Set<string>, missingNodes: Set<string>] {
  if (allWorkers.length === 0) return [new Set(), new Set()];

  const inventories = allWorkers.map((w) => w.modelInventory);
  const nodeClassSets = allWorkers.map((w) => new Set(w.nodeClasses)).filter((s) => s.size > 0);

  const missingModels = new Set(
    [...needs.models].filter((name) => !inventories.some((inventory) => findModel(inventory, name)[0]))
  );

  let missingNodes = new Set<string>();
  if (nodeClassSets.length > 0) {
    missingNodes = new Set([...needs.nodes].filter((node) => !nodeClassSets.some((classes) => classes.has(node))));
  }

  return [missingModels, missingNodes];
}

/** Judge whether `worker` can run a job needing `needs` -- ports
 * `assess.verdict`. `requirementsOverride` is the job's advanced-override
 * dict (`min_vram_gb`, `min_free_disk_gb`, `gpu_name_contains`, `backend`).
 * `allWorkers` is the full federation worker list (kept for callers/other
 * assessment helpers that need it; `verdict` itself no longer searches peer
 * inventories for a missing model -- see `fetchableModels` below).
 *
 * `fetchableModels` is the signed manifest's name -> size_bytes map
 * (`model_manifest.entries()`'s shape). Undefined/null (the default) means
 * "nothing is fetchable" -- a caller that doesn't compile it gets the exact
 * same behavior as before this parameter existed.
 *
 * `peerOnlyModels` (Phase 3.1 P2P, `model_manifest.peerOnlyNames`'s shape):
 * see `eligibleAfterFetch`'s docstring. Undefined/null means "nothing is
 * peer-only", identical to the pre-3.1 behavior.
 *
 * `unverifiedModels` (2026-09-19 model_fetch): see `eligibleAfterFetch`'s
 * docstring. Undefined/null means "nothing is unverified", identical to the
 * pre-2026-09-19 behavior.
 *
 * 2026-09-19 job-retry §6: `opts.exclusions` is a set of `(worker_id,
 * job_id)` and `(worker_id, task_key)` pairs (via `exclusionKey`) compiled
 * ONCE per dispatch tick -- see `core/retry.ts`'s `activeUnsuitable` and
 * `do/hub.ts`'s tick. A hit on either makes this worker `ineligible` with a
 * verbatim reason -- `failed_twice_on_job` (this worker already failed THIS
 * job `retry.MAX_FAILURES_PER_WORKER_PER_JOB` times) or
 * `unsuitable:<task_key[:12]>` (this worker has a live unsuitable record for
 * this CLASS of job). `opts.jobId`/`opts.taskKey` are what the pairs are
 * matched against; the whole argument defaults to undefined, so every caller
 * that predates this feature keeps its exact previous behavior. Ports the
 * keyword-only `job_id`/`task_key`/`exclusions` of the former Python `verdict`. */
/** 2026-09-23: whether this Apple-silicon worker's running ComfyUI has the
 * agent's MPS quantization shim, per the hello `hardware` blob -- ports
 * the former Python `mps_shim_active`. Only an `mps` worker can say so; anything
 * but a literal `true` is false. */
export function mpsShimActive(worker: Worker): boolean {
  if ((worker.backend || "") !== "mps") return false;
  const hardware = worker.hardware;
  if (!hardware || typeof hardware !== "object" || Array.isArray(hardware)) return false;
  return (hardware as Record<string, unknown>).mps_quant_compat === true;
}

export function verdict(
  worker: Worker,
  needs: JobNeeds,
  requirementsOverride: Record<string, unknown>,
  allWorkers: Worker[],
  fetchableModels?: FetchableModels | null,
  peerOnlyModels?: ReadonlySet<string> | null,
  unverifiedModels?: ReadonlySet<string> | null,
  opts?: VerdictExclusions
): Verdict {
  const reasons: string[] = [];
  const warnings: string[] = [];

  // 2026-09-19 job-retry §6: checked FIRST, and it is a hard reason like
  // nodes/vram/override -- a worker that has already failed this job twice
  // must not come back as `eligible_after_fetch` either (downloading the
  // model again would only earn the same failure a third time).
  const exclusions = opts?.exclusions;
  if (exclusions && exclusions.size > 0) {
    const jobId = opts?.jobId;
    const taskKey = opts?.taskKey;
    if (jobId && exclusions.has(exclusionKey(worker.id, jobId))) {
      reasons.push(FAILED_TWICE_REASON);
    }
    if (taskKey && exclusions.has(exclusionKey(worker.id, taskKey))) {
      reasons.push(`${UNSUITABLE_REASON_PREFIX}${[...taskKey].slice(0, UNSUITABLE_KEY_CHARS).join("")}`);
    }
  }

  const hardware = worker.hardware;
  const dynamic = worker.dynamic;

  // Phase 1 workers that have never connected report node_classes == [].
  // Empty is "unknown", not "supports nothing" -- skip the check entirely.
  if (worker.nodeClasses.length > 0) {
    const known = new Set(worker.nodeClasses);
    const missingNodes = [...needs.nodes].filter((n) => !known.has(n));
    if (missingNodes.length > 0) {
      reasons.push(`missing_nodes:${missingNodes.sort().join(",")}`);
    }
  }

  // VRAM: a hard gate only when the weights fit NOWHERE (VRAM + system RAM).
  // Between "fits in VRAM alone" and "fits with offload" is eligible-with-warning.
  const vramGb = asNumber(hardware["vram_gb"]);
  let ramGb = asNumber(hardware["ram_gb"]);
  // 2026-09-23 §4: unified memory. `vram_gb` IS the RAM, so the discrete-GPU
  // "VRAM + system RAM" ceiling below would double count it; the resident
  // set is gated against the one pool here instead, and `ram_gb` is
  // blanked so the offload path below degrades to at most a warning.
  // Ports the same block in the former Python `verdict`.
  const unifiedGb = unifiedMemoryGb(hardware);
  if (unifiedGb !== null) {
    ramGb = null;
    if (needs.models.size > 0) {
      const resident = estimateResidentGb(needs.models, allWorkers);
      const usable = Math.round(unifiedGb * UNIFIED_USABLE_FRACTION * 10) / 10;
      if (resident !== null && resident > usable) {
        reasons.push(`${UNIFIED_MEMORY_REASON}:${round1(resident)}>${round1(usable)}`);
      }
    }
  }
  if (ramGb === null) {
    // Older agents report no total RAM; free RAM from the last heartbeat is
    // the closest available stand-in.
    ramGb = asNumber(dynamic["free_ram_gb"]);
  }

  if (needs.estVramGb !== null && vramGb !== null && needs.estVramGb > vramGb) {
    if (ramGb === null) {
      warnings.push(`vram_offload:${needs.estVramGb}>${vramGb}`);
    } else if (needs.estVramGb > vramGb + ramGb) {
      reasons.push(`vram:${needs.estVramGb}>${vramGb}+${ramGb}`);
    } else {
      warnings.push(`vram_offload:${needs.estVramGb}>${vramGb}`);
    }
  }

  const minVramGb = requirementsOverride["min_vram_gb"];
  if (minVramGb !== undefined && minVramGb !== null) {
    if (vramGb === null || vramGb < (minVramGb as number)) {
      reasons.push("override:min_vram_gb");
    }
  }

  const minFreeDiskGb = requirementsOverride["min_free_disk_gb"];
  if (minFreeDiskGb !== undefined && minFreeDiskGb !== null) {
    const freeDiskGb = asNumber(dynamic["free_disk_gb"]);
    if (freeDiskGb === null || freeDiskGb < (minFreeDiskGb as number)) {
      reasons.push("override:min_free_disk_gb");
    }
  }

  const wantBackend = requirementsOverride["backend"];
  if (typeof wantBackend === "string" && wantBackend) {
    const haveBackend = worker.backend || "";
    if (wantBackend !== haveBackend) {
      reasons.push(`backend:${wantBackend}!=${haveBackend}`);
    }
  }

  const gpuNameContains = requirementsOverride["gpu_name_contains"];
  if (typeof gpuNameContains === "string" && gpuNameContains) {
    const gpuName = typeof hardware["gpu_name"] === "string" ? (hardware["gpu_name"] as string) : "";
    if (!gpuName.includes(gpuNameContains)) {
      reasons.push("override:gpu_name_contains");
    }
  }

  // 2026-09-20 (user directive): anything that loads a model goes to NVIDIA
  // only. A non-cuda worker ("mps", "rocm", "") is eligible for a model job
  // only when EVERY model it needs is explicitly marked for that backend in
  // the guide; nothing is today, so Macs get the zero-model editing jobs.
  // Ports the former Python block of the same name.
  // 2026-09-23 exception: a Mac whose RUNNING ComfyUI carries the agent's
  // fp8/int8 MPS shim (`hardware.mps_quant_compat === true`) runs the same
  // quantized workflows an NVIDIA worker does, so it is treated like cuda
  // here (slower -- its backend speed prior / learned `speed_index` puts that
  // into `predicted_seconds`, see `scheduler.speedPrior`).
  const haveBackend = worker.backend || "";
  if (needs.models.size > 0 && haveBackend !== "cuda" && !mpsShimActive(worker)) {
    const unsupported = [...needs.models].filter((name) => !modelBackends(name).has(haveBackend)).sort();
    if (unsupported.length > 0) {
      reasons.push(`${BACKEND_UNSUPPORTED_REASON}:${haveBackend || "unknown"}:${unsupported.join(",")}`);
    }
  }

  const missingModels = [...needs.models]
    .filter((name) => !findModel(worker.modelInventory, name)[0])
    .sort();

  if (reasons.length > 0) {
    // Hard reasons always win over model status; a warning is dropped since
    // it explains how an eligible job will run, and this one will not run.
    return { kind: "ineligible", reasons, missingModels, warnings: [] };
  }

  if (missingModels.length === 0) {
    return { kind: "eligible", reasons: [], missingModels: [], warnings };
  }

  if (eligibleAfterFetch(worker, missingModels, fetchableModels, dynamic, peerOnlyModels, unverifiedModels)) {
    return {
      kind: "eligible_after_fetch",
      reasons: [`missing_models:${missingModels.join(",")}`],
      missingModels,
      warnings,
    };
  }

  // L6 final-review fix (ports the former Python verdict): a protocol<4 worker
  // blocked specifically because a missing model is peer-only gets a
  // distinguishable reason from the generic "unavailable" -- only this one
  // condition (the protocol gate, which this function has direct evidence
  // for) is distinguished; a
  // peer-only model whose seeder is currently offline still falls into the
  // generic branch below, same as a model that never existed.
  const fetchable = fetchableModels || {};
  const peerOnlySet = peerOnlyModels || new Set<string>();
  const blockedByPeerProtocol =
    missingModels.every((name) => name in fetchable) &&
    missingModels.some((name) => peerOnlySet.has(name)) &&
    workerProtocol(worker) < MIN_PEER_FETCH_PROTOCOL;
  if (blockedByPeerProtocol) {
    return {
      kind: "ineligible",
      reasons: [`missing_models_peer_protocol:${missingModels.join(",")}`],
      missingModels,
      warnings: [],
    };
  }

  // 2026-09-19 model_fetch (ports the former Python verdict): the same
  // distinguishability argument one notch up. A worker blocked purely because
  // a missing model's entry is an unverified-source one its protocol cannot
  // validate is NOT "this model exists nowhere" -- and
  // `model_fetch.createFetchJob` renders these reason strings verbatim into
  // the panel's `no_worker` 400 (spec §5.1 row 7), so the button must be able
  // to say "your agent is too old" rather than "no worker can fetch right
  // now".
  const unverifiedSet = unverifiedModels || new Set<string>();
  const blockedByUnverifiedProtocol =
    missingModels.every((name) => name in fetchable) &&
    missingModels.some((name) => unverifiedSet.has(name)) &&
    workerProtocol(worker) < MIN_UNVERIFIED_FETCH_PROTOCOL;
  if (blockedByUnverifiedProtocol) {
    return {
      kind: "ineligible",
      reasons: [`missing_models_unverified_protocol:${missingModels.join(",")}`],
      missingModels,
      warnings: [],
    };
  }

  return {
    kind: "ineligible",
    reasons: [`missing_models_unavailable:${missingModels.join(",")}`],
    missingModels,
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Phase 3.3 §2.1: 工作簽章 -- Python parity source: assess.signature.

const STEP_NODE_CLASSES = ["KSampler", "KSamplerAdvanced", "BasicScheduler"];
const LATENT_SIZE_NODE_CLASSES = ["EmptyLatentImage", "EmptySD3LatentImage"];
const MPX_UNIT = 262144; // 0.25 MPx 級距

function literalInt(inputs: Record<string, unknown>, field: string): number | null {
  const value = inputs[field];
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value;
}

/** 穩定的「這是哪一種工作」指紋：sha256 的前 16 個 hex 字。Ports
 * `assess.signature` -- canonical JSON 的鍵順序、`nodes` 的 (class, count)
 * 排序、`mpx` 的整數除法都必須和 Python 逐位元一致，否則兩棧的統計互相
 * 讀不到對方的資料。 */
export async function signature(workflow: Record<string, unknown>, needs: JobNeeds): Promise<string> {
  const counts = new Map<string, number>();
  let steps = 0;
  let pixels = 0;
  let batch = 0;
  let hasBatchNode = false;

  for (const node of Object.values(workflow ?? {})) {
    if (typeof node !== "object" || node === null) continue;
    const classType = (node as Record<string, unknown>).class_type;
    if (typeof classType !== "string") continue;
    counts.set(classType, (counts.get(classType) ?? 0) + 1);

    const inputs = (node as Record<string, unknown>).inputs;
    if (typeof inputs !== "object" || inputs === null) continue;
    const inputRecord = inputs as Record<string, unknown>;

    if (STEP_NODE_CLASSES.includes(classType)) {
      steps += literalInt(inputRecord, "steps") ?? 0;
    }
    if (LATENT_SIZE_NODE_CLASSES.includes(classType)) {
      hasBatchNode = true;
      pixels += (literalInt(inputRecord, "width") ?? 0) * (literalInt(inputRecord, "height") ?? 0);
      batch += literalInt(inputRecord, "batch_size") ?? 0;
    }
  }

  // Python 的 `sorted(counts.items())` 是 (class_type, count) 的字典序；
  // class_type 唯一，所以只比第一項就等價。
  const nodes = [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const models = [...needs.models].sort();

  // json.dumps(..., sort_keys=True, separators=(",", ":")) 的等價輸出：鍵序
  // batch < models < mpx < nodes < steps（字典序），沒有多餘空白。
  const canonical = JSON.stringify({
    batch: hasBatchNode && batch > 0 ? batch : 1,
    models,
    mpx: Math.floor(pixels / MPX_UNIT),
    nodes,
    steps,
  });

  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return bytesToHex(new Uint8Array(digest)).slice(0, 16);
}
