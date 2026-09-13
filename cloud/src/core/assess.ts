/**
 * Worker-eligibility judging, ported from `server/comfyfed_server/assess.py`.
 *
 * Scope note for future readers: this file currently carries only the
 * subset of assess.py that `core/dispatch.ts`'s `assignJobs` cannot rank
 * without -- `verdict()`, `needsFromJob()`, and the small model-matching
 * helpers `verdict()` calls. assess.py's workflow-walking half (`extract`,
 * `model_nodes`, `estimate_vram`, and the `/comfy/api` guidance-message
 * wiring) is Task 9's job (`comfyapi.ts` / `model_guide.ts` per the phase
 * plan) and belongs in this same file when that lands -- extend it here
 * rather than creating a second assess module.
 */

import type { Job, ModelInventoryEntry, Worker } from "../db/queries";

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

/** Judge whether `worker` can run a job needing `needs` -- ports
 * `assess.verdict`. `requirementsOverride` is the job's advanced-override
 * dict (`min_vram_gb`, `min_free_disk_gb`, `gpu_name_contains`, `backend`).
 * `allWorkers` is the full federation worker list, used to determine
 * whether a model missing from `worker`'s own inventory is fetchable from
 * a peer. */
export function verdict(
  worker: Worker,
  needs: JobNeeds,
  requirementsOverride: Record<string, unknown>,
  allWorkers: Worker[]
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

  const otherWorkers = allWorkers.filter((w) => w !== worker);
  let totalMissingSize = 0;
  let allAvailableElsewhere = true;
  for (const modelName of missingModels) {
    let foundSize: number | null = null;
    for (const other of otherWorkers) {
      const [found, size] = findModel(other.modelInventory, modelName);
      if (!found) continue;
      const candidate = size ?? 0;
      if (foundSize === null || candidate > foundSize) foundSize = candidate;
    }
    if (foundSize === null) {
      allAvailableElsewhere = false;
      break;
    }
    totalMissingSize += foundSize;
  }

  const freeDiskGb = asNumber(dynamic["free_disk_gb"]);
  const diskOk = freeDiskGb === null ? true : freeDiskGb >= totalMissingSize;

  if (allAvailableElsewhere && diskOk) {
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
