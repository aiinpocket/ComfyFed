/**
 * Worker-eligibility judging, ported from `server/comfyfed_server/assess.py`.
 *
 * Task 8 extends this file with the workflow-walking half (`extract`,
 * `estimateVram`) that `POST /api/jobs` needs to assess a freshly-submitted
 * workflow -- `model_nodes` (per-node model->node mapping for `/comfy/api`
 * guidance messages) is still Task 9's job and belongs here too when that
 * lands; both walk the same node/input shape, so extend `iterModelRefs`
 * below rather than writing a second walker (see its docstring).
 */

import type { Job, ModelInventoryEntry, Worker } from "../db/queries";

// ---------------------------------------------------------------------------
// Workflow extraction -- ports assess.py's `_MODEL_FIELD_NAMES` /
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

const MODEL_EXTENSIONS = [".safetensors", ".ckpt", ".pt", ".sft", ".gguf"];

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
 * in `workflow`, in the workflow's own iteration order -- ports assess.py's
 * `_iter_model_refs`. Single walker shared by `extract` (only needs the set
 * of names) and Task 9's future `model_nodes` (needs the originating node
 * too) -- see assess.py's module docstring for why extraction rules must
 * never be duplicated between them. */
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
 * it -- ports assess.py's `model_nodes`. Returns `{model_name: [[node_id,
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
 * -- ports assess.py's `extract`. `workflow` maps node_id -> `{class_type,
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

const VRAM_FUDGE_FACTOR = 1.15;

/** Estimate a job's peak VRAM: the largest single referenced model x 1.15
 * -- ports assess.py's `estimate_vram`. Returns null if no referenced model
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

// ---------------------------------------------------------------------------
// Phase 2.1: eligible_after_fetch (server-signed manifest auto-download) --
// ports assess.py's `_MIN_AUTO_FETCH_PROTOCOL` / `_FETCH_DISK_MARGIN` /
// `_BYTES_PER_GB` / `_worker_fetch_capacity_ok` / `_eligible_after_fetch` /
// `partition_fleet_fetchable` / `fleet_wide_gaps`.

/** `fetchableModels` maps a missing model's name (workflow-declared,
 * category-relative shape -- same as `needs.models`) to its exact
 * `size_bytes`, as published by `model_manifest.entries()`. */
export type FetchableModels = Record<string, number>;

/** hello.protocol below which an agent cannot receive fetch_models at all
 * (it predates lazy hashing / lazy inventory sha256). */
const MIN_AUTO_FETCH_PROTOCOL = 3;

/** free_disk_gb must exceed the total download size by this factor -- not
 * just clear it -- so a fetch never lands a worker at (near-)zero free disk. */
const FETCH_DISK_MARGIN = 1.2;

const BYTES_PER_GB = 1024 ** 3;

/** Protocol/auto_fetch/disk-margin gate, independent of WHICH models are
 * missing -- shared by `verdict`'s per-candidate gate and
 * `partitionFleetFetchable`'s fleet-wide submission-time gate. Ports
 * `assess._worker_fetch_capacity_ok`. */
function workerFetchCapacityOk(worker: Worker, dynamic: Record<string, unknown>, totalMissingGb: number): boolean {
  const protocol = typeof worker.protocol === "number" && Number.isInteger(worker.protocol) ? worker.protocol : 1;
  if (protocol < MIN_AUTO_FETCH_PROTOCOL) return false;
  if (!worker.autoFetch) return false;

  const freeDiskGb = asNumber(dynamic["free_disk_gb"]);
  if (freeDiskGb === null) {
    // Unknown free disk cannot prove the margin holds -- refuse rather than
    // warn (unlike the VRAM offload gate above).
    return false;
  }
  return freeDiskGb > FETCH_DISK_MARGIN * totalMissingGb;
}

/** All the eligible_after_fetch gates -- ports `assess._eligible_after_fetch`. */
function eligibleAfterFetch(
  worker: Worker,
  missingModels: string[],
  fetchableModels: FetchableModels | null | undefined,
  dynamic: Record<string, unknown>
): boolean {
  const map = fetchableModels ?? {};
  if (!missingModels.every((name) => Object.prototype.hasOwnProperty.call(map, name))) return false;

  const totalMissingGb = missingModels.reduce((sum, name) => sum + map[name]!, 0) / BYTES_PER_GB;
  return workerFetchCapacityOk(worker, dynamic, totalMissingGb);
}

/** Splits a fleet-wide "missing from every worker" model set into
 * `[fetchable, unfetchable]` for the submission-relaxation matrix -- ports
 * `assess.partition_fleet_fetchable`. See that Python docstring for why this
 * is a single COMBINED gate over the whole manifest-covered subset, not a
 * per-model one. */
export function partitionFleetFetchable(
  missingModels: ReadonlySet<string>,
  fetchableModels: FetchableModels | null | undefined,
  onlineEnabledWorkers: Worker[]
): [fetchable: Set<string>, unfetchable: Set<string>] {
  const map = fetchableModels ?? {};
  const manifestCovered = new Set([...missingModels].filter((name) => Object.prototype.hasOwnProperty.call(map, name)));
  const notInManifest = new Set([...missingModels].filter((name) => !manifestCovered.has(name)));

  if (manifestCovered.size === 0) return [new Set(), new Set(missingModels)];

  const totalMissingGb = [...manifestCovered].reduce((sum, name) => sum + map[name]!, 0) / BYTES_PER_GB;
  const canFetch = onlineEnabledWorkers.some((worker) => workerFetchCapacityOk(worker, worker.dynamic, totalMissingGb));
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
 * same behavior as before this parameter existed. */
export function verdict(
  worker: Worker,
  needs: JobNeeds,
  requirementsOverride: Record<string, unknown>,
  allWorkers: Worker[],
  fetchableModels?: FetchableModels | null
): Verdict {
  const reasons: string[] = [];
  const warnings: string[] = [];

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
  if (ramGb === null) {
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

  if (eligibleAfterFetch(worker, missingModels, fetchableModels, dynamic)) {
    return {
      kind: "eligible_after_fetch",
      reasons: [`missing_models:${missingModels.join(",")}`],
      missingModels,
      warnings,
    };
  }

  return {
    kind: "ineligible",
    reasons: [`missing_models_unavailable:${missingModels.join(",")}`],
    missingModels,
    warnings: [],
  };
}
