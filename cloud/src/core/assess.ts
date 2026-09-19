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
import { bytesToHex } from "../lib/hex";

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

/** Phase 3.1 P2P: hello.protocol below which an agent cannot pull from a
 * peer seeder at all (no chunk-table fields, no peer-grant support) -- see
 * `eligibleAfterFetch`/`partitionFleetFetchable`'s `peerOnlyModels` param. */
const MIN_PEER_FETCH_PROTOCOL = 4;

/** 2026-09-19 model_fetch (spec §6/§7): hello.protocol below which an agent
 * cannot be handed an UNVERIFIED-SOURCE manifest entry at all -- ports
 * assess.py's `_MIN_UNVERIFIED_FETCH_PROTOCOL`. Such an entry carries
 * `sha256: null` and a `name|directory|url|size_bytes|unverified` signature
 * payload; a protocol<=4 agent's `fetcher._validate_entry_shape` rejects a
 * null sha256 outright and its `_verify_entry_signature` only knows the
 * verified payload, so pushing one to it can only ever produce a refused
 * fetch. Same shape as `MIN_PEER_FETCH_PROTOCOL`: only required when a
 * missing model's entry actually IS unverified (see `eligibleAfterFetch`/
 * `partitionFleetFetchable`'s `unverifiedModels` parameter) -- every
 * ordinary manifest entry keeps its existing floor. */
export const MIN_UNVERIFIED_FETCH_PROTOCOL = 5;

/** `worker.protocol`, normalized the same way every fetch-eligibility gate
 * here needs it: missing/non-integer degrades to 1 (the oldest,
 * least-capable value), never throws -- ports assess.py's `_worker_protocol`.
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
 * knows about the field or not. Ports assess.py's `_DEFAULT_MAX_FETCH_GB`. */
const DEFAULT_MAX_FETCH_GB = 20.0;

/** This worker's configured auto-fetch budget (hello's optional
 * `max_fetch_gb`), stashed into the `hardware` JSON blob by `hub.ts`'s
 * `handleHello` alongside the agent-reported hardware fields.
 * Missing/non-numeric/non-positive degrades to `DEFAULT_MAX_FETCH_GB` -- the
 * same default the agent itself applies, so an old-or-silent agent is
 * treated exactly like a fresh one, never as "unlimited". Ports assess.py's
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
 * pre-2026-09-19 behavior. */
export function verdict(
  worker: Worker,
  needs: JobNeeds,
  requirementsOverride: Record<string, unknown>,
  allWorkers: Worker[],
  fetchableModels?: FetchableModels | null,
  peerOnlyModels?: ReadonlySet<string> | null,
  unverifiedModels?: ReadonlySet<string> | null
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

  if (eligibleAfterFetch(worker, missingModels, fetchableModels, dynamic, peerOnlyModels, unverifiedModels)) {
    return {
      kind: "eligible_after_fetch",
      reasons: [`missing_models:${missingModels.join(",")}`],
      missingModels,
      warnings,
    };
  }

  // L6 final-review fix (ports assess.py's verdict): a protocol<4 worker
  // blocked specifically because a missing model is peer-only gets a
  // distinguishable reason from the generic "unavailable" -- see the
  // Python docstring for why only this one condition (the protocol gate,
  // which this function has direct evidence for) is distinguished; a
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

  // 2026-09-19 model_fetch (ports assess.py's verdict): the same
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
