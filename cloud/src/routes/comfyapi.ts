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
 * `staging/<uid>/<filename>` (`lib/store.ts`'s `stagingKey`, written by this
 * file's `POST /upload/image`) -- the cloud equivalent of Python's per-user
 * `<data_dir>/comfy_staging/<uid>/` directory (final review finding #1:
 * namespaced per uid so one user can never view or overwrite another's
 * staged upload; `SHARED_STAGING_UID` is the one deliberate exception for
 * platform-shipped template samples every user can see).
 */

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../env";
import * as queries from "../db/queries";
import type { Job } from "../db/queries";
import { toSqliteTimestamp, sqliteTimestampToEpochMs, resolvePlatformSeed } from "../db/queries";
import { extract, estimateVram, modelNodes, signature, fleetWideGaps, partitionFleetFetchable, type FetchableModels } from "../core/assess";
import { peerOnlyNames } from "../core/model_manifest";
import { jobOutputs } from "../core/outputs";
import * as split from "../core/split";
import * as modelGuide from "../core/model_guide";
import * as modelManifest from "../core/model_manifest";
import {
  sanitizePathComponent,
  sanitizePathComponentOrThrow,
  sanitizeRelativePathOrThrow,
  artifactKey,
  jobInputKey,
  stagingKey,
  userdataKey,
  userdataPrefix,
  SHARED_STAGING_UID,
} from "../lib/store";
import { boundedGunzip } from "../lib/gzip";
import { requireUser, errorJson, SESSION_VAR } from "../lib/guard";
import { COMFYFED_EXT_JS } from "../core/comfyfed_ext";

const RUNNING_STATUSES = ["assigned", "running"];
const PENDING_STATUSES = ["queued"];
const HISTORY_STATUSES = ["done", "failed"];

const OBJECT_INFO_DIR = "object_info";
import { readLimits, tooLargeMessage, uploadRejection } from "../lib/limits";

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
async function fetchableModelsMap(env: Env): Promise<{ map: FetchableModels; peerOnlyModels: ReadonlySet<string> }> {
  const seed = await resolvePlatformSeed(env.DB, env.PLATFORM_ED25519_SEED);
  const entries = await modelManifest.entries(env.DB, env.STORE, seed);
  const map: FetchableModels = {};
  for (const e of entries) map[e.name] = e.size_bytes;
  return { map, peerOnlyModels: peerOnlyNames(entries) };
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

/** Filenames sitting in `uid`'s own staging namespace, plus the shared
 * packaged template samples every user can see. Final review finding #1:
 * the staging listing used to be one flat, process-wide R2 prefix, so every
 * user's `/object_info` dropdown listed every other user's staged uploads. */
async function stagedImageNames(store: R2Bucket, uid: string): Promise<string[]> {
  const names = new Set<string>();
  for (const namespace of [uid, SHARED_STAGING_UID]) {
    const prefix = `staging/${namespace}/`;
    const listed = await store.list({ prefix });
    for (const o of listed.objects) names.add(o.key.slice(prefix.length));
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Comfy settings JSON blob -- one D1 settings row PER USER, holding the
// whole dict as a JSON string -- NOT R2. Mirrors Python's per-uid
// `comfy_settings.<uid>.json` files (final review finding #7): now that any
// role reaches `/comfy/api/*`, one global row meant a regular user's write
// silently overwrote every other user's, including admins'. The original
// Task 9 single-row key (`comfy_settings_json`, no suffix) is kept as a
// read-only legacy fallback default: a user who has never written their own
// settings reads it if present, so nobody's editor appears to reset.

function userComfySettingsKey(uid: string): string {
  return `${COMFY_SETTINGS_KEY}:${uid}`;
}

function parseSettingsBlob(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function loadComfySettings(db: D1Database, uid: string): Promise<Record<string, unknown>> {
  const own = parseSettingsBlob(await queries.getSetting(db, userComfySettingsKey(uid)));
  if (own !== null) return own;
  return parseSettingsBlob(await queries.getSetting(db, COMFY_SETTINGS_KEY)) ?? {};
}

async function saveComfySettings(db: D1Database, uid: string, values: Record<string, unknown>): Promise<void> {
  await queries.setSetting(db, userComfySettingsKey(uid), JSON.stringify(values));
}

// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

app.use("/comfy/api/*", requireUser);

// --- GET /comfy/api/object_info -------------------------------------------

app.get("/comfy/api/object_info", async (c) => {
  const user = c.get(SESSION_VAR).user;
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

  const names = await stagedImageNames(c.env.STORE, user.uid);
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
    const { map: fetchableMap, peerOnlyModels } = await fetchableModelsMap(c.env);
    const [, unfetchable] = partitionFleetFetchable(missingModelsSet, fetchableMap, onlineWorkers, peerOnlyModels);
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
    let obj: R2ObjectBody | null = null;
    try {
      obj = await c.env.STORE.get(stagingKey(user.uid, name));
      if (!obj) {
        // Shared, packaged template samples are resolvable for every user
        // (final review finding #1: real uploads are namespaced per uid,
        // but the platform-shipped samples stay public by design).
        obj = await c.env.STORE.get(stagingKey(SHARED_STAGING_UID, name));
      }
    } catch {
      continue;
    }
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
    signature: await signature(promptObj, needs),
    // Phase 3.3 §3.2：送件時就判定可不可拆。panel 這條路沒有 requirements
    // 可帶，所以只剩平台設定 split_batches 這個開關。
    splitPlan: split.planForJob(promptObj, {}, await split.splitBatchesEnabled(c.env.DB)),
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
  const user = c.get(SESSION_VAR).user;
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
  const key = stagingKey(user.uid, filename);
  // Same per-file cap and per-user quota the `/userdata` save enforces: this
  // route had NO limit at all, so the staging namespace was the way around
  // the other one. `head` gives the bytes an overwrite frees, which must not
  // be charged twice.
  const existing = await c.env.STORE.head(key);
  const rejected = await uploadRejection(c, user.uid, content.byteLength, {
    tooLargeCode: "upload.too_large",
    replacingBytes: existing?.size ?? 0,
  });
  if (rejected) return rejected;
  await c.env.STORE.put(key, content);

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
    // Userdata files are almost all JSON (workflows, keybinding presets,
    // node templates, the bookmark index); the panel calls `.json()` on
    // them regardless of the header, but sending the honest type keeps a
    // hand-opened URL readable in the browser.
    ".json": "application/json",
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
    let obj = await c.env.STORE.get(stagingKey(user.uid, safeName));
    if (!obj) {
      // Shared, packaged template samples are visible to every user;
      // anything else in another user's own namespace stays unreachable.
      obj = await c.env.STORE.get(stagingKey(SHARED_STAGING_UID, safeName));
    }
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

// --- userdata (panel-side saved files) ----------------------------------------
//
// Ports comfyapi.py's `/userdata` section -- see that module for the pinned
// frontend's exact call shapes (`listUserDataFullInfo`, `getUserData`,
// `storeUserData`, `deleteUserData`, `moveUserData`) this answers, and for
// why a listing's `path` is relative to the REQUESTED `dir` rather than to
// the user root. Storage is R2 `userdata/<uid>/<relative path>`
// (`lib/store.ts`'s `userdataKey`), the twin of Python's
// `<data_dir>/comfy_userdata/<uid>/` tree, namespaced per uid so one user can
// never reach another's saved workflows.
//
// These routes MUST be registered here (in the comfyapi router mounted by
// index.ts) rather than anywhere later: `index.ts` has a catch-all
// `app.all("/comfy/api/*")` JSON 404 for unimplemented panel endpoints, and
// only a route mounted before it wins.

// The per-file ceiling and the per-user storage quota are no longer constants
// here: both are admin-configurable platform settings (`upload_max_file_mb`,
// default 50, and `upload_user_quota_gb`, default 5), read through
// `readLimits` on every write. See lib/limits.ts for the parse, the bounds,
// and why job artifacts/inputs sit outside the quota.
const USERDATA_BAD_PATH_MESSAGE = "路徑不合法。 / Invalid path.";
const USERDATA_NOT_FOUND_MESSAGE = "檔案不存在。 / File not found.";
const USERDATA_EXISTS_MESSAGE = "檔案已存在。 / File already exists.";

function qbool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Defense in depth for the CSRF-free mutating `/comfy/api/userdata` routes.
 * This router carries no `X-CSRF` check (the pinned ComfyUI frontend cannot
 * send the header), so cross-site protection rests on the session cookie's
 * `SameSite=Lax`. Lax already blocks the cross-site POST, but these routes
 * now DELETE a user's saved workflows, so a second, independent control is
 * cheap: if the browser told us an `Origin` and its host is not our own,
 * refuse. An ABSENT `Origin` passes -- non-browser clients send none, and
 * neither does a same-origin GET navigation. Supplement to SameSite, never a
 * replacement. Mirrors comfyapi.py's `_origin_rejected`. */
function originRejected(c: Context<{ Bindings: Env }>): Response | null {
  const origin = c.req.header("origin");
  if (!origin) return null;
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    originHost = "";
  }
  const host = c.req.header("host") ?? new URL(c.req.url).host;
  if (!originHost || originHost !== host) {
    return userdataError(c, 403, "userdata.bad_origin", "跨站請求已被拒絕。 / Cross-origin request refused.");
  }
  return null;
}

/** Same bilingual envelope shape Python's userdata routes answer with. */
function userdataError(c: Context<{ Bindings: Env }>, status: number, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status as any);
}

/** `{path, size, modified}` -- `modified` is unix SECONDS (a float in
 * Python; R2 only records whole-millisecond upload times, so this is
 * `uploaded / 1000`), matching what the pinned frontend's `UserFile.save()`
 * normalizes. */
function userdataInfo(path: string, size: number, uploaded: Date | undefined): Record<string, unknown> {
  return { path, size, modified: (uploaded ? uploaded.getTime() : Date.now()) / 1000 };
}

app.get("/comfy/api/userdata", async (c) => {
  const user = c.get(SESSION_VAR).user;
  const dir = c.req.query("dir") ?? "";
  let prefix: string;
  try {
    prefix = userdataPrefix(user.uid, dir);
  } catch {
    return userdataError(c, 400, "userdata.bad_path", USERDATA_BAD_PATH_MESSAGE);
  }

  const recurse = qbool(c.req.query("recurse"));
  const fullInfo = qbool(c.req.query("full_info"));
  const split = qbool(c.req.query("split"));

  // R2 LIST is paginated (1000 keys per page by default); a user with a lot
  // of saved workflows must still see all of them.
  // PARKED: the drain is unbounded (no per-user object-count or byte ceiling
  // anywhere). Fine at trusted-circle scale -- authenticated users only, and
  // a runaway tree only slows that user's own page loads. A capped drain with
  // a truncation marker is the future work if the circle ever widens.
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.STORE.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const rels = objects
    .map((o) => o.key.slice(prefix.length))
    .filter((rel) => rel.length > 0 && (recurse || !rel.includes("/")));
  const byRel = new Map(objects.map((o) => [o.key.slice(prefix.length), o]));
  rels.sort();

  // A missing "directory" is simply an empty prefix in R2 -- an empty array,
  // 200, same as Python's missing-dir answer.
  if (fullInfo) {
    return c.json(rels.map((rel) => userdataInfo(rel, byRel.get(rel)!.size, byRel.get(rel)!.uploaded)));
  }
  if (split) {
    return c.json(rels.map((rel) => [rel, ...rel.split("/")]));
  }
  return c.json(rels);
});

// Registered BEFORE the plain `POST /comfy/api/userdata/:path` below: the
// `{.+}` params match slashes, so a move URL would otherwise be swallowed by
// that route with the whole `<src>/move/<dest>` as its path.
//
// PARKED divergence: this route matches on the still-encoded path, so a plain
// save whose own segments happen to be `.../move/...` (`POST
// /comfy/api/userdata/workflows%2Fmove%2Fx.json`) falls through to the plain
// POST below and is stored (200), while Python's ASGI server decodes the path
// before routing and matches the move route there (404). Accepted: inherited
// from upstream's URL shape, and the pinned frontend never names a workflow
// file or folder `move`.
app.post("/comfy/api/userdata/:src{.+}/move/:dest{.+}", async (c) => {
  const rejectedOrigin = originRejected(c);
  if (rejectedOrigin) return rejectedOrigin;
  const user = c.get(SESSION_VAR).user;
  let srcKey: string;
  let destKey: string;
  let destRel: string;
  try {
    srcKey = userdataKey(user.uid, c.req.param("src"));
    destRel = sanitizeRelativePathOrThrow(c.req.param("dest"), "userdata path");
    destKey = userdataKey(user.uid, destRel);
  } catch {
    return userdataError(c, 400, "userdata.bad_path", USERDATA_BAD_PATH_MESSAGE);
  }

  const source = await c.env.STORE.get(srcKey);
  if (!source) {
    return userdataError(c, 404, "userdata.not_found", "來源檔案不存在。 / Source file not found.");
  }
  // `overwrite` defaults to FALSE here (upstream's default, and what the
  // pinned frontend's rename flow sends) -- the opposite of the plain POST
  // below, where a re-save is the normal case.
  if (destKey !== srcKey && !qbool(c.req.query("overwrite"), false)) {
    const existing = await c.env.STORE.head(destKey);
    if (existing) {
      return userdataError(c, 409, "userdata.exists", "目標檔案已存在。 / Destination already exists.");
    }
  }

  // `source.size` comes free off the R2 object we already fetched, so the
  // configured per-file ceiling the plain POST enforces applies to a move too
  // -- without it a pre-existing oversized object would be materialised whole
  // in the isolate by `arrayBuffer()` below. Only the CAP applies here, not
  // the quota: a move is copy+delete of bytes the user is already charged
  // for, so total usage is unchanged (and refusing it would strand a file a
  // user at quota is trying to reorganise).
  const moveLimits = await readLimits(c.env.DB);
  if (source.size > moveLimits.maxFileBytes) {
    return userdataError(c, 413, "userdata.too_large", tooLargeMessage(moveLimits));
  }

  // PARKED: this is a copy+delete, not an atomic rename (R2 has no rename,
  // and Python's `os.replace` is atomic) -- if the `delete` throws after the
  // `put` succeeded, the destination exists and the source survives, so the
  // client's retry sees the 409 for a move it believes failed. Acceptable at
  // handshake level: nothing is lost, and the user can delete the leftover.
  const bytes = await source.arrayBuffer();
  const written = await c.env.STORE.put(destKey, bytes);
  if (destKey !== srcKey) await c.env.STORE.delete(srcKey);
  return c.json(userdataInfo(destRel, bytes.byteLength, written?.uploaded));
});

app.get("/comfy/api/userdata/:path{.+}", async (c) => {
  const user = c.get(SESSION_VAR).user;
  let key: string;
  let rel: string;
  try {
    rel = sanitizeRelativePathOrThrow(c.req.param("path"), "userdata path");
    key = userdataKey(user.uid, rel);
  } catch {
    return userdataError(c, 400, "userdata.bad_path", USERDATA_BAD_PATH_MESSAGE);
  }
  const obj = await c.env.STORE.get(key);
  if (!obj) return userdataError(c, 404, "userdata.not_found", USERDATA_NOT_FOUND_MESSAGE);
  return new Response(obj.body, { headers: { "content-type": guessMediaType(rel) } });
});

app.post("/comfy/api/userdata/:path{.+}", async (c) => {
  const rejectedOrigin = originRejected(c);
  if (rejectedOrigin) return rejectedOrigin;
  const user = c.get(SESSION_VAR).user;
  let key: string;
  let rel: string;
  try {
    rel = sanitizeRelativePathOrThrow(c.req.param("path"), "userdata path");
    key = userdataKey(user.uid, rel);
  } catch {
    return userdataError(c, 400, "userdata.bad_path", USERDATA_BAD_PATH_MESSAGE);
  }

  // `overwrite` defaults to TRUE, matching upstream and the pinned
  // frontend's own default -- a plain workflow re-save sends
  // `overwrite=true`, "Save as" sends `overwrite=false` and relies on this
  // 409 to warn about clobbering.
  if (!qbool(c.req.query("overwrite"), true)) {
    const existing = await c.env.STORE.head(key);
    if (existing) return userdataError(c, 409, "userdata.exists", USERDATA_EXISTS_MESSAGE);
  }

  // Refuse an oversized body off the DECLARED length before reading a byte
  // of it, mirroring comfyapi.py's identical short-circuit. The post-read
  // check below stays: a lying or absent `Content-Length` must never be a
  // way past the cap, so this is an extra, cheaper rejection and never a
  // substitute for measuring the real bytes.
  const limits = await readLimits(c.env.DB);
  const declared = c.req.header("content-length");
  if (declared && /^\d+$/.test(declared) && Number(declared) > limits.maxFileBytes) {
    return userdataError(c, 413, "userdata.too_large", tooLargeMessage(limits));
  }

  const body = await c.req.arrayBuffer();
  // Overwriting an existing save frees its bytes, so they are not charged
  // twice -- otherwise a plain re-save of an unchanged workflow would fail
  // at exactly 100% of quota.
  const replaced = await c.env.STORE.head(key);
  const rejected = await uploadRejection(c, user.uid, body.byteLength, {
    tooLargeCode: "userdata.too_large",
    replacingBytes: replaced?.size ?? 0,
    limits,
  });
  if (rejected) return rejected;

  // PARITY NOTE: no file-vs-directory collision is possible here -- R2 has no
  // directories, so `userdata/<uid>/workflows` and
  // `userdata/<uid>/workflows/a.json` are two independent keys and both
  // writes succeed. comfyapi.py answers 409 `conflict` for that same pair
  // because a real filesystem cannot hold both; the divergence is
  // storage-shaped and deliberate.
  const written = await c.env.STORE.put(key, body);
  // Always the full_info entry, whatever `full_info` said -- the pinned
  // frontend guards its read with `typeof body === "object"` and only ever
  // pulls `size`/`modified` out of it.
  return c.json(userdataInfo(rel, body.byteLength, written?.uploaded));
});

app.delete("/comfy/api/userdata/:path{.+}", async (c) => {
  const rejectedOrigin = originRejected(c);
  if (rejectedOrigin) return rejectedOrigin;
  const user = c.get(SESSION_VAR).user;
  let key: string;
  try {
    key = userdataKey(user.uid, c.req.param("path"));
  } catch {
    return userdataError(c, 400, "userdata.bad_path", USERDATA_BAD_PATH_MESSAGE);
  }
  const existing = await c.env.STORE.head(key);
  if (!existing) return userdataError(c, 404, "userdata.not_found", USERDATA_NOT_FOUND_MESSAGE);
  await c.env.STORE.delete(key);
  return c.body(null, 204);
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

app.get("/comfy/api/settings", async (c) =>
  c.json(await loadComfySettings(c.env.DB, c.get(SESSION_VAR).user.uid))
);

app.get("/comfy/api/settings/:settingId", async (c) => {
  const settings = await loadComfySettings(c.env.DB, c.get(SESSION_VAR).user.uid);
  return c.json(settings[c.req.param("settingId")] ?? null);
});

app.post("/comfy/api/settings", async (c) => {
  const uid = c.get(SESSION_VAR).user.uid;
  let incoming: unknown;
  try {
    incoming = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  if (typeof incoming !== "object" || incoming === null || Array.isArray(incoming)) {
    return c.body(null, 400);
  }
  const current = await loadComfySettings(c.env.DB, uid);
  await saveComfySettings(c.env.DB, uid, { ...current, ...(incoming as Record<string, unknown>) });
  return c.body(null, 200);
});

app.post("/comfy/api/settings/:settingId", async (c) => {
  const uid = c.get(SESSION_VAR).user.uid;
  let value: unknown;
  try {
    value = await c.req.json();
  } catch {
    return c.body(null, 400);
  }
  const settings = await loadComfySettings(c.env.DB, uid);
  settings[c.req.param("settingId")] = value;
  await saveComfySettings(c.env.DB, uid, settings);
  return c.body(null, 200);
});

export default app;
