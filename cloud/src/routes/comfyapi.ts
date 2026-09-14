/**
 * `/comfy/api/*` -- the ComfyUI-compatible surface, so the stock ComfyUI
 * frontend can drive the federation. Parity source:
 * `server/comfyfed_server/comfyapi.py`, read in full -- see that module's
 * docstring for the deliberate deviations from upstream ComfyUI this ports
 * (panel-shaped `/prompt` errors, `/object_info` as a fleet union/
 * intersection, flat asset staging, `prompt_id` == ComfyFed job id).
 *
 * EVERY route below requires only an authenticated, non-disabled session
 * (`requireUser`), no CSRF check -- mirrors `create_router`'s single
 * router-level `Depends(auth.require_user)` dependency. Phase 3.0 Task 4
 * widened the panel from admin-only to any logged-in user: what stays
 * per-role is not gate ACCESS but per-route SCOPE -- every panel-native
 * read/control below (`/queue`, `/history`, `/interrupt`, `/queue`
 * delete/clear, `/history` hide, `/view`) is additionally filtered to
 * `origin === "panel" AND user_id === <the session's own uid>`, including
 * for an admin session (full fleet visibility lives in the console's
 * `/api/jobs`, not here -- see comfyapi.py's module docstring). Nothing in
 * comfyapi.py adds `require_csrf` anywhere, `POST /prompt` included: the
 * stock ComfyUI frontend has no way to send our `X-CSRF` header, and the
 * session cookie is `SameSite`-scoped, which is what keeps this from being
 * cross-site submittable. This is a deliberate, whole-router deviation from
 * every OTHER state-changing route in this codebase, not a gap.
 *
 * `/comfy/ws` and `/comfy/api/ws` (the panel WebSocket) are NOT here -- Task
 * 7 wired those straight to the Hub DO in `index.ts`/`do/hub.ts`, mirroring
 * `create_ws_router` being a deliberately separate router in the Python
 * source (see its docstring for why).
 *
 * `job_outputs` is imported from `core/outputs.ts`, NOT re-derived here --
 * see that module's docstring for why a done job's outputs must never drift
 * between this file's `GET /history` and `do/hub.ts`'s WS `executed` event.
 * `assess.extract`/`assess.modelNodes` (the workflow walker) live in
 * `core/assess.ts`, extended by this task rather than duplicated.
 *
 * R2 key layout used by this file (beyond `lib/store.ts`'s `artifacts/` /
 * `job_inputs/`): `object_info/<worker_id>.json.gz` (written by
 * `routes/workers.ts`'s `POST /api/agent/object_info`) and
 * `staging/<filename>` (`lib/store.ts`'s `stagingKey`, written by this
 * file's `POST /upload/image`) -- the cloud equivalent of Python's flat
 * `<data_dir>/comfy_staging/` directory.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import * as queries from "../db/queries";
import type { Job } from "../db/queries";
import { toSqliteTimestamp, sqliteTimestampToEpochMs, resolvePlatformSeed } from "../db/queries";
import { extract, estimateVram, modelNodes, fleetWideGaps, partitionFleetFetchable, type FetchableModels } from "../core/assess";
import { jobOutputs } from "../core/outputs";
import * as modelGuide from "../core/model_guide";
import * as modelManifest from "../core/model_manifest";
import {
  sanitizePathComponent,
  sanitizePathComponentOrThrow,
  artifactKey,
  jobInputKey,
  stagingKey,
} from "../lib/store";
import { boundedGunzip } from "../lib/gzip";
import { requireUser, errorJson, SESSION_VAR } from "../lib/guard";
import { COMFYFED_EXT_JS } from "../core/comfyfed_ext";

const RUNNING_STATUSES = ["assigned", "running"];
const PENDING_STATUSES = ["queued"];
const HISTORY_STATUSES = ["done", "failed"];

const OBJECT_INFO_DIR = "object_info";
const OBJECT_INFO_MAX_BYTES = 32 * 1024 * 1024;

const OBJECT_INFO_MODE_KEY = "object_info_mode";
const OBJECT_INFO_MODES = new Set(["union", "intersection"]);
const DEFAULT_OBJECT_INFO_MODE = "union";

const WORKER_COUNT_HEADER = "X-ComfyFed-Worker-Count";

const COMFY_SETTINGS_KEY = "comfy_settings_json";

// ---------------------------------------------------------------------------
// Small shared helpers

/** Fire-and-forget the Hub DO's alarm re-arm -- see routes/jobs.ts's
 * `wakeHub` for the full rationale; kept as a small per-file copy rather
 * than a cross-route import, matching that file's own stated convention. */
async function wakeHub(env: Env): Promise<void> {
  try {
    const stub = env.HUB.get(env.HUB.idFromName("hub"));
    await stub.fetch("http://hub.internal/internal/wake", { method: "POST" });
  } catch (err) {
    console.warn("comfyapi: failed to wake the Hub DO", err);
  }
}

async function cancelJobViaHub(env: Env, jobId: string, reason: string): Promise<void> {
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  await stub.fetch("http://hub.internal/internal/cancel", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ job_id: jobId, reason }),
  });
}

function comfyError(
  errorType: string,
  message: string,
  details = "",
  nodeErrors: Record<string, unknown> = {}
): Response {
  return new Response(
    JSON.stringify({
      error: { type: errorType, message, details: details || message, extra_info: {} },
      node_errors: nodeErrors,
    }),
    { status: 400, headers: { "content-type": "application/json" } }
  );
}

function workflowOf(job: Job): Record<string, unknown> {
  try {
    const parsed = JSON.parse(job.workflowJson || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function resultFilesOf(job: Job): string[] {
  return job.resultFiles.filter((f): f is string => typeof f === "string");
}

const OUTPUT_NODE_CLASSES = new Set(["SaveImage", "SaveVideo", "SaveAudio", "SaveText"]);

function nodeIdsOfClass(workflow: Record<string, unknown>, classes: ReadonlySet<string>): string[] {
  const ids: string[] = [];
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (typeof node === "object" && node !== null && !Array.isArray(node)) {
      const classType = (node as Record<string, unknown>).class_type;
      if (typeof classType === "string" && classes.has(classType)) ids.push(nodeId);
    }
  }
  return ids.sort();
}

/** Builds ComfyUI's `[number, prompt_id, prompt, extra_data,
 * outputs_to_execute]` -- ports `_queue_entry`. */
function queueEntry(number: number, job: Job): unknown[] {
  const workflow = workflowOf(job);
  const extraData: Record<string, unknown> = {};
  if (job.createdAt) extraData.create_time = sqliteTimestampToEpochMs(job.createdAt);
  return [number, job.id, workflow, extraData, nodeIdsOfClass(workflow, OUTPUT_NODE_CLASSES)];
}

async function historyEntry(number: number, job: Job, store: R2Bucket): Promise<Record<string, unknown>> {
  const outputs = await jobOutputs({ id: job.id, workflowJson: job.workflowJson, resultFiles: job.resultFiles }, store);
  const succeeded = job.status === "done";
  const messages: unknown[] = [];
  if (!succeeded && job.error) {
    messages.push(["execution_error", { prompt_id: job.id, exception_message: job.error }]);
  }
  return {
    prompt: queueEntry(number, job),
    outputs,
    status: { status_str: succeeded ? "success" : "error", completed: succeeded, messages },
  };
}

/** Assigns each job ComfyUI's monotonic queue `number`, oldest = 1, across
 * EVERY job in the federation (not scoped to any origin) -- ports
 * `_numbers_by_job_id`. */
async function numbersByJobId(db: D1Database): Promise<Map<string, number>> {
  const jobs = await queries.getAllJobsOrderedByCreatedAt(db);
  const map = new Map<string, number>();
  jobs.forEach((job, index) => map.set(job.id, index + 1));
  return map;
}

/** Builds the signed manifest's name -> size_bytes map with ONE
 * `model_manifest.entries()` read -- shared by every submission-relaxation
 * call site in this file (and `routes/jobs.ts`'s own copy) so a single
 * request/tick never re-reads the manifest more than once. */
async function fetchableModelsMap(env: Env): Promise<FetchableModels> {
  const seed = await resolvePlatformSeed(env.DB, env.PLATFORM_ED25519_SEED);
  const entries = await modelManifest.entries(env.DB, env.STORE, seed);
  const map: FetchableModels = {};
  for (const e of entries) map[e.name] = e.size_bytes;
  return map;
}

// ---------------------------------------------------------------------------
// object_info merge

async function loadWorkerObjectInfo(store: R2Bucket, workerId: string): Promise<Record<string, unknown> | null> {
  try {
    const obj = await store.get(`${OBJECT_INFO_DIR}/${workerId}.json.gz`);
    if (!obj) return null;
    const gz = new Uint8Array(await obj.arrayBuffer());
    const decompressed = await boundedGunzip(gz, OBJECT_INFO_MAX_BYTES);
    const parsed = JSON.parse(new TextDecoder("utf-8").decode(decompressed));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function mergeObjectInfo(
  store: R2Bucket,
  fleet: [string, string][],
  mode: string
): Promise<Record<string, unknown>> {
  const workerInfos: Record<string, unknown>[] = [];
  for (const [workerId] of fleet) {
    const info = await loadWorkerObjectInfo(store, workerId);
    if (info) workerInfos.push(info);
  }

  const merged: Record<string, unknown> = {};
  for (const info of workerInfos) {
    for (const [nodeName, nodeDef] of Object.entries(info)) {
      if (!(nodeName in merged)) merged[nodeName] = nodeDef;
    }
  }

  if (mode === "intersection" && workerInfos.length > 0) {
    let common = new Set(Object.keys(workerInfos[0]!));
    for (const info of workerInfos.slice(1)) {
      const keys = new Set(Object.keys(info));
      common = new Set([...common].filter((k) => keys.has(k)));
    }
    for (const name of Object.keys(merged)) {
      if (!common.has(name)) delete merged[name];
    }
  }

  return merged;
}

// object_info merge cache: single newest entry only, keyed by the exact
// fleet (worker id + object_info hash, order-independent) and merge mode --
// ports comfyapi.py's `_object_info_cache`, module-level (per-isolate) here
// rather than process-level. Documented divergence: an isolate recycle
// (cold start, new deploy) drops the cache, unlike Python's long-lived
// process -- acceptable per task-9-brief.md ("module map resets per isolate
// = acceptable, note parity") since the alternative (DO storage or a KV
// namespace) buys a cross-isolate win this fleet-scale deployment doesn't
// need: a miss costs one R2 LIST-free set of GETs, not a slow rebuild.
let objectInfoCache: { key: string; value: Record<string, unknown> } | null = null;

function objectInfoCacheKey(fleet: [string, string][], mode: string): string {
  return `${fleet.map(([id, hash]) => `${id}:${hash}`).sort().join(",")}|${mode}`;
}

/** Test-only escape hatch, mirroring `clear_object_info_cache` (used by
 * Python's own test suite between apps). */
export function clearObjectInfoCacheForTests(): void {
  objectInfoCache = null;
}

// ---------------------------------------------------------------------------
// Staged-image injection into upload-node combo dropdowns -- ports
// `_merge_options` / `_UPLOAD_FIELD_EXTENSIONS` / `_with_staged_images`.

const UPLOAD_FIELD_EXTENSIONS: Record<string, Set<string>> = {
  image: new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]),
  audio: new Set([".wav", ".mp3", ".flac", ".ogg", ".m4a"]),
  file: new Set([".mp4", ".webm", ".mov", ".mkv", ".avi"]),
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i === -1 ? "" : name.slice(i).toLowerCase();
}

function mergeOptions(spec: unknown, names: string[]): unknown[] | null {
  if (!Array.isArray(spec) || spec.length === 0) return null;

  if (Array.isArray(spec[0])) {
    const existing = spec[0] as unknown[];
    const merged = [...existing, ...names.filter((n) => !existing.includes(n))];
    return [merged, ...spec.slice(1)];
  }

  if (spec[0] === "COMBO" && spec.length > 1 && typeof spec[1] === "object" && spec[1] !== null && !Array.isArray(spec[1])) {
    const config = spec[1] as Record<string, unknown>;
    const existing = config.options;
    if (!Array.isArray(existing)) return null;
    const merged = [...existing, ...names.filter((n) => !existing.includes(n))];
    return ["COMBO", { ...config, options: merged }, ...spec.slice(2)];
  }

  return null;
}

// n1 (final review): must be a deep structural check, not shallow ===, since
// `mergeOptions` always allocates a fresh options array/object for element 0
// even when `names` contributed nothing new -- a shallow `===` per element
// would never short-circuit the "nothing changed" skip below, so every
// request would copy the node def for no reason. Matches Python's `merged ==
// spec` (dict/list structural equality).
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null && !Array.isArray(a) && !Array.isArray(b)) {
    const aKeys = Object.keys(a as Record<string, unknown>);
    const bKeys = Object.keys(b as Record<string, unknown>);
    return (
      aKeys.length === bKeys.length &&
      aKeys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
    );
  }
  return false;
}

function withStagedImages(objectInfo: Record<string, unknown>, names: string[]): Record<string, unknown> {
  if (names.length === 0) return objectInfo;

  const known = new Set<string>();
  for (const exts of Object.values(UPLOAD_FIELD_EXTENSIONS)) for (const e of exts) known.add(e);

  function namesFor(fieldName: string): string[] {
    const exts = UPLOAD_FIELD_EXTENSIONS[fieldName]!;
    return names.filter((n) => exts.has(extOf(n)) || !known.has(extOf(n)));
  }

  const uploadFields: [string, string][] = [
    ["image", "image_upload"],
    ["audio", "audio_upload"],
    ["file", "video_upload"],
  ];

  let result: Record<string, unknown> = objectInfo;
  for (const [nodeName, nodeDef] of Object.entries(objectInfo)) {
    if (typeof nodeDef !== "object" || nodeDef === null || Array.isArray(nodeDef)) continue;
    const input = (nodeDef as Record<string, unknown>).input;
    if (typeof input !== "object" || input === null || Array.isArray(input)) continue;
    const required = (input as Record<string, unknown>).required;
    if (typeof required !== "object" || required === null || Array.isArray(required)) continue;

    for (const [fieldName, uploadFlag] of uploadFields) {
      const spec = (required as Record<string, unknown>)[fieldName];
      if (!Array.isArray(spec) || spec.length < 2 || typeof spec[1] !== "object" || spec[1] === null) continue;
      if (!(spec[1] as Record<string, unknown>)[uploadFlag]) continue;

      const merged = mergeOptions(spec, namesFor(fieldName));
      if (merged === null || deepEqual(merged, spec)) continue;

      if (result === objectInfo) result = { ...objectInfo };
      const patchedDef = { ...(result[nodeName] as Record<string, unknown>) };
      const patchedInput = { ...(patchedDef.input as Record<string, unknown>) };
      const patchedRequired = { ...((patchedInput.required as Record<string, unknown>) ?? {}) };
      patchedRequired[fieldName] = merged;
      patchedInput.required = patchedRequired;
      patchedDef.input = patchedInput;
      result[nodeName] = patchedDef;
    }
  }
  return result;
}

async function stagedImageNames(store: R2Bucket): Promise<string[]> {
  const listed = await store.list({ prefix: "staging/" });
  return listed.objects.map((o) => o.key.slice("staging/".length)).sort();
}

// ---------------------------------------------------------------------------
// Comfy settings JSON blob (Task 9 ruling: one D1 settings row,
// `comfy_settings_json`, holding the whole dict as a JSON string -- NOT R2.
// Mirrors Python's `_load_settings`/`_save_settings`, which persist a single
// `comfy_settings.json` file next to the DB; ComfyFed has exactly one admin,
// so a single row is the direct equivalent with no per-user split needed.

async function loadComfySettings(db: D1Database): Promise<Record<string, unknown>> {
  const raw = await queries.getSetting(db, COMFY_SETTINGS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function saveComfySettings(db: D1Database, values: Record<string, unknown>): Promise<void> {
  await queries.setSetting(db, COMFY_SETTINGS_KEY, JSON.stringify(values));
}

// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

app.use("/comfy/api/*", requireUser);

// --- GET /comfy/api/object_info -------------------------------------------

app.get("/comfy/api/object_info", async (c) => {
  const fleetWorkers = await queries.getOnlineEnabledWorkers(c.env.DB);
  const fleet: [string, string][] = fleetWorkers.map((w) => [w.id, w.objectInfoHash || ""]);
  const modeRaw = await queries.getSetting(c.env.DB, OBJECT_INFO_MODE_KEY);
  const mode = modeRaw && OBJECT_INFO_MODES.has(modeRaw) ? modeRaw : DEFAULT_OBJECT_INFO_MODE;

  if (fleet.length === 0) {
    return c.json({}, 200, { "X-ComfyFed-No-Workers": "1", [WORKER_COUNT_HEADER]: "0" });
  }

  const key = objectInfoCacheKey(fleet, mode);
  let merged: Record<string, unknown>;
  if (objectInfoCache && objectInfoCache.key === key) {
    merged = objectInfoCache.value;
  } else {
    merged = await mergeObjectInfo(c.env.STORE, fleet, mode);
    objectInfoCache = { key, value: merged };
  }

  const names = await stagedImageNames(c.env.STORE);
  return c.json(withStagedImages(merged, names), 200, { [WORKER_COUNT_HEADER]: String(fleet.length) });
});

// --- GET /comfy/api/workflow_templates -------------------------------------

app.get("/comfy/api/workflow_templates", (c) => c.json({}));

// --- POST /comfy/api/prompt ------------------------------------------------

app.post("/comfy/api/prompt", async (c) => {
  const user = c.get(SESSION_VAR).user;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return comfyError("no_prompt", "No prompt provided");
  }
  const bodyObj = body as Record<string, unknown>;
  if (!("prompt" in bodyObj)) {
    return comfyError("no_prompt", "No prompt provided");
  }
  const prompt = bodyObj.prompt;
  if (typeof prompt !== "object" || prompt === null || Array.isArray(prompt) || Object.keys(prompt).length === 0) {
    return comfyError("invalid_prompt", "Prompt must be a non-empty API-format object");
  }
  const promptObj = prompt as Record<string, unknown>;

  const needs = extract(promptObj);
  const allWorkers = await queries.getAllWorkers(c.env.DB);
  const [missingModelsSet, missingNodesSet] = fleetWideGaps(needs, allWorkers);

  // Phase 2.1: a model missing from every worker's inventory is no longer
  // automatically a dead end -- if the manifest has a signed entry for it
  // AND at least one online, opted-in worker can fetch the whole missing set
  // (see assess.partitionFleetFetchable), it queues normally instead of
  // being refused. Only the genuinely-unfetchable remainder still blocks
  // submission. ONE manifest read for this whole request.
  let blocking = missingModelsSet;
  if (missingModelsSet.size > 0) {
    const onlineWorkers = await queries.getOnlineEnabledWorkers(c.env.DB);
    const fetchableMap = await fetchableModelsMap(c.env);
    const [, unfetchable] = partitionFleetFetchable(missingModelsSet, fetchableMap, onlineWorkers);
    blocking = unfetchable;
  }

  if (blocking.size > 0) {
    const names = [...blocking].sort();
    let guidance = await modelGuide.guidanceMessage(names, c.env.STORE);
    if (missingNodesSet.size > 0) {
      guidance += "\n\n" + modelGuide.missingNodesNote([...missingNodesSet].sort());
    }

    const nodeErrors: Record<string, { class_type: string; dependent_outputs: unknown[]; errors: unknown[] }> = {};
    const modelNodeMap = modelNodes(promptObj);
    for (const name of names) {
      for (const [nodeId, classType] of modelNodeMap.get(name) ?? []) {
        const entry = nodeErrors[nodeId] ?? (nodeErrors[nodeId] = { class_type: classType, dependent_outputs: [], errors: [] });
        entry.errors.push({
          type: "comfyfed.missing_model",
          message: modelGuide.guidanceSummary([name]),
          details: await modelGuide.modelGuidanceBlock(name, c.env.STORE),
          extra_info: {},
        });
      }
    }

    return comfyError("prompt.missing_models", modelGuide.guidanceSummary(names), guidance, nodeErrors);
  }

  // Staged-asset resolution -- ports `_default_resolve_asset`: every needed
  // asset name is looked up in R2 `staging/<name>` (flat, no subfolders,
  // reusable across prompts, same as Python's `comfy_staging/` directory).
  const resolved = new Map<string, R2ObjectBody>();
  for (const name of [...needs.assets].sort()) {
    let key: string;
    try {
      key = stagingKey(name);
    } catch {
      continue;
    }
    const obj = await c.env.STORE.get(key);
    if (obj) resolved.set(name, obj);
  }

  const missingAssets = [...needs.assets].filter((n) => !resolved.has(n)).sort();
  if (missingAssets.length > 0) {
    return comfyError(
      "invalid_prompt",
      "Prompt references input files that are not available: " + missingAssets.join(", "),
      "Upload the referenced input files before queueing this prompt."
    );
  }

  const estVramGb = estimateVram(needs.models, allWorkers);
  const jobId = crypto.randomUUID();
  await queries.insertJob(c.env.DB, {
    id: jobId,
    workflowJson: JSON.stringify(promptObj),
    requirements: {},
    requiredNodes: [...needs.nodes].sort(),
    requiredModels: [...needs.models].sort(),
    estVramGb,
    inputAssets: [...needs.assets].sort(),
    origin: "panel",
    createdAt: toSqliteTimestamp(new Date()),
    userId: user.uid,
  });

  for (const [name, obj] of resolved) {
    await c.env.STORE.put(jobInputKey(jobId, name), await obj.arrayBuffer());
  }

  const queuedJobs = await queries.listJobs(c.env.DB, PENDING_STATUSES);
  const number = queuedJobs.length;

  await wakeHub(c.env);

  return c.json({ prompt_id: jobId, number, node_errors: {} });
});

// --- POST /comfy/api/upload/image ------------------------------------------

app.post("/comfy/api/upload/image", async (c) => {
  const form = await c.req.parseBody().catch(() => null);
  if (!form) return c.body(null, 400);
  const image = form["image"];
  if (!(image instanceof File) || !image.name) return c.body(null, 400);

  let filename: string;
  try {
    filename = sanitizePathComponentOrThrow(image.name, "asset filename");
  } catch {
    return c.body(null, 400);
  }

  const content = await image.arrayBuffer();
  await c.env.STORE.put(stagingKey(filename), content);

  return c.json({ name: filename, subfolder: "", type: "input" });
});

// --- GET /comfy/api/queue ----------------------------------------------------

app.get("/comfy/api/queue", async (c) => {
  const user = c.get(SESSION_VAR).user;
  const numbers = await numbersByJobId(c.env.DB);
  const rows = await queries.getJobsByStatusAndOrigin(c.env.DB, [...RUNNING_STATUSES, ...PENDING_STATUSES], {
    origin: "panel",
    userId: user.uid,
  });
  const running = rows.filter((j) => RUNNING_STATUSES.includes(j.status)).map((j) => queueEntry(numbers.get(j.id) ?? 0, j));
  const pending = rows.filter((j) => PENDING_STATUSES.includes(j.status)).map((j) => queueEntry(numbers.get(j.id) ?? 0, j));
  return c.json({ queue_running: running, queue_pending: pending });
});

// --- POST /comfy/api/interrupt -----------------------------------------------

app.post("/comfy/api/interrupt", async (c) => {
  const user = c.get(SESSION_VAR).user;
  const running = await queries.getJobsByStatusAndOrigin(c.env.DB, RUNNING_STATUSES, {
    origin: "panel",
    userId: user.uid,
  });
  const job = running[0];
  if (job) {
    // Fire-and-forget, matching Python's /interrupt (comfyapi.py) which
    // returns 200 unconditionally with no DO/dispatcher equivalent to fail --
    // if the Hub DO is unreachable we log and still answer 200 empty, same as
    // the sibling /comfy/api/queue cancel loop below, rather than surfacing a
    // 502 on a route the panel UI doesn't check the body of.
    try {
      await cancelJobViaHub(c.env, job.id, "interrupted from panel");
    } catch (err) {
      console.warn("comfyapi: interrupt cancel failed for job", job.id, err);
    }
  }
  return c.json({});
});

// --- POST /comfy/api/queue (delete/clear) ------------------------------------

app.post("/comfy/api/queue", async (c) => {
  const user = c.get(SESSION_VAR).user;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const bodyObj = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  const candidates = await queries.getJobsByStatusAndOrigin(c.env.DB, [...PENDING_STATUSES, ...RUNNING_STATUSES], {
    origin: "panel",
    userId: user.uid,
  });

  let jobIds: string[];
  if (bodyObj.clear) {
    jobIds = candidates.map((j) => j.id);
  } else {
    const requested = Array.isArray(bodyObj.delete) ? bodyObj.delete.filter((v): v is string => typeof v === "string") : [];
    const requestedSet = new Set(requested);
    jobIds = requestedSet.size > 0 ? candidates.filter((j) => requestedSet.has(j.id)).map((j) => j.id) : [];
  }

  for (const jobId of jobIds) {
    try {
      await cancelJobViaHub(c.env, jobId, "removed from panel queue");
    } catch (err) {
      console.warn("comfyapi: cancel failed for job", jobId, err);
    }
  }

  return c.json({});
});

// --- GET /comfy/api/history ---------------------------------------------------

app.get("/comfy/api/history", async (c) => {
  const user = c.get(SESSION_VAR).user;
  const maxItemsParam = c.req.query("max_items");
  const numbers = await numbersByJobId(c.env.DB);
  let rows = await queries.getJobsByStatusAndOrigin(c.env.DB, HISTORY_STATUSES, {
    origin: "panel",
    excludePanelHidden: true,
    orderBy: "finished_at",
    userId: user.uid,
  });

  if (maxItemsParam !== undefined) {
    const maxItems = Number.parseInt(maxItemsParam, 10);
    if (Number.isFinite(maxItems) && maxItems >= 0) {
      rows = maxItems === 0 ? [] : rows.slice(-maxItems);
    }
  }

  const out: Record<string, unknown> = {};
  for (const job of rows) {
    out[job.id] = await historyEntry(numbers.get(job.id) ?? 0, job, c.env.STORE);
  }
  return c.json(out);
});

// --- GET /comfy/api/history/{prompt_id} --------------------------------------

app.get("/comfy/api/history/:promptId", async (c) => {
  const user = c.get(SESSION_VAR).user;
  const promptId = c.req.param("promptId");
  const job = await queries.getJobById(c.env.DB, promptId);
  if (
    !job ||
    !HISTORY_STATUSES.includes(job.status) ||
    job.panelHidden ||
    job.origin !== "panel" ||
    job.userId !== user.uid
  ) {
    // Upstream returns {} for an unknown prompt id, never a 404.
    return c.json({});
  }
  const numbers = await numbersByJobId(c.env.DB);
  return c.json({ [job.id]: await historyEntry(numbers.get(job.id) ?? 0, job, c.env.STORE) });
});

// --- POST /comfy/api/history (hide) ------------------------------------------

app.post("/comfy/api/history", async (c) => {
  const user = c.get(SESSION_VAR).user;
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    body = null;
  }
  const bodyObj = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};

  if (bodyObj.clear) {
    await queries.hidePanelHistoryJobs(c.env.DB, undefined, { userId: user.uid });
    return c.json({});
  }

  const requested = Array.isArray(bodyObj.delete) ? bodyObj.delete.filter((v): v is string => typeof v === "string") : [];
  if (requested.length === 0) return c.json({});

  await queries.hidePanelHistoryJobs(c.env.DB, requested, { userId: user.uid });
  return c.json({});
});

// --- GET /comfy/api/view ------------------------------------------------------

function guessMediaType(filename: string): string {
  const ext = extOf(filename);
  const map: Record<string, string> = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".flac": "audio/flac",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".txt": "text/plain",
  };
  return map[ext] ?? "application/octet-stream";
}

app.get("/comfy/api/view", async (c) => {
  const user = c.get(SESSION_VAR).user;
  const filenameRaw = c.req.query("filename") ?? "";
  const type = c.req.query("type") ?? "output";
  const subfolder = c.req.query("subfolder") ?? "";

  let safeName: string;
  try {
    safeName = sanitizePathComponent(filenameRaw, "filename");
  } catch {
    return c.body(null, 400);
  }

  if (type === "input") {
    if (subfolder) return c.body(null, 404);
    const obj = await c.env.STORE.get(stagingKey(safeName));
    if (!obj) return c.body(null, 404);
    return new Response(obj.body, { headers: { "content-type": guessMediaType(safeName) } });
  }

  if (type !== "output") return c.body(null, 404);

  let jobId: string;
  if (subfolder) {
    try {
      jobId = sanitizePathComponent(subfolder, "subfolder");
    } catch {
      return c.body(null, 400);
    }
    const job = await queries.getJobById(c.env.DB, jobId);
    if (!job || !resultFilesOf(job).includes(safeName) || job.origin !== "panel" || job.userId !== user.uid) {
      return c.body(null, 404);
    }
  } else {
    // Legacy fallback for links minted before outputs carried a subfolder:
    // scan this user's OWN done panel jobs newest-first for the filename --
    // same scope as every other panel-native route, so this fallback can't
    // be used to read another user's (or the console's) artifact just by
    // omitting `subfolder`.
    const done = await queries.getJobsByStatusAndOrigin(c.env.DB, ["done"], { origin: "panel", userId: user.uid });
    // n2 (final review): two-key sort matching comfyapi.py's `ORDER BY
    // finished_at DESC, created_at DESC` -- `updateJobDone` always sets
    // `finished_at`, so today ties never reach the tiebreaker, but comparing
    // by `finished_at` alone (falling back to `created_at` only when
    // `finished_at` is entirely absent) would silently drop the tiebreak the
    // day that invariant changes.
    const cmp = (x: string | null, y: string | null): number => {
      if (x === y) return 0;
      if (x === null) return 1; // null sorts oldest (DESC puts it last)
      if (y === null) return -1;
      return x < y ? 1 : -1;
    };
    const newestFirst = done.slice().sort((a, b) => cmp(a.finishedAt, b.finishedAt) || cmp(a.createdAt, b.createdAt));
    const found = newestFirst.find((job) => resultFilesOf(job).includes(safeName));
    if (!found) return c.body(null, 404);
    jobId = found.id;
  }

  let key: string;
  try {
    key = artifactKey(jobId, safeName);
  } catch {
    return c.body(null, 404);
  }
  const obj = await c.env.STORE.get(key);
  if (!obj) return c.body(null, 404);

  return new Response(obj.body, { headers: { "content-type": guessMediaType(safeName) } });
});

// --- panel bootstrap ----------------------------------------------------------

app.get("/comfy/api/features", (c) => c.json({}));

app.get("/comfy/api/users", (c) => c.json({ storage: "server", migrated: false }));

app.get("/comfy/api/extensions", (c) => c.json(["/api/comfyfed-ext/comfyfed.js"]));

app.get("/comfy/api/comfyfed-ext/comfyfed.js", (c) =>
  c.body(COMFYFED_EXT_JS, 200, { "content-type": "application/javascript" })
);

app.get("/comfy/api/embeddings", (c) => c.json([]));

app.get("/comfy/api/models", (c) => c.json([]));

app.get("/comfy/api/i18n", (c) => c.json({}));

app.get("/comfy/api/global_subgraphs", (c) => c.json({}));

app.get("/comfy/api/folder_paths", (c) => c.json({}));

app.get("/comfy/api/system_stats", async (c) => {
  const online = await queries.getOnlineEnabledWorkers(c.env.DB);
  return c.json({
    system: {
      os: "comfyfed",
      comfyui_version: "comfyfed",
      python_version: "",
      pytorch_version: "",
      embedded_python: false,
      argv: [],
      comfyfed_online_workers: online.length,
    },
    devices: [],
  });
});

app.get("/comfy/api/prompt", async (c) => {
  const remaining = await queries.countQueueRemaining(c.env.DB);
  return c.json({ exec_info: { queue_remaining: remaining } });
});

app.get("/comfy/api/settings", async (c) => c.json(await loadComfySettings(c.env.DB)));

app.get("/comfy/api/settings/:settingId", async (c) => {
  const settings = await loadComfySettings(c.env.DB);
  return c.json(settings[c.req.param("settingId")] ?? null);
});

app.post("/comfy/api/settings", async (c) => {
  let incoming: unknown;
  try {
    incoming = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    return c.body(null, 400);
  }
  const current = await loadComfySettings(c.env.DB);
  await saveComfySettings(c.env.DB, { ...current, ...(incoming as Record<string, unknown>) });
  return c.body(null, 200);
});

app.post("/comfy/api/settings/:settingId", async (c) => {
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  const settings = await loadComfySettings(c.env.DB);
  settings[c.req.param("settingId")] = value;
  await saveComfySettings(c.env.DB, settings);
  return c.body(null, 200);
});

export default app;
