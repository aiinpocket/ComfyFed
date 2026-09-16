/**
 * `/api/jobs/*` and `/api/agent/jobs/*` -- parity source:
 * `server/comfyfed_server/jobs.py`, read in full, plus `storage.py`'s
 * `LocalStore`/`sanitize_path_component` (ported to `lib/store.ts`'s R2
 * layout: `artifacts/<job_id>/<filename>`, `job_inputs/<job_id>/<filename>`).
 *
 * Routes ported: `POST /api/jobs` (console submit, multipart assets -> R2
 * `job_inputs/`), `GET /api/jobs` (list, optional `?status=a,b`), `GET
 * /api/jobs/{id}` (detail incl. embedded receipt), `GET
 * /api/jobs/{id}/assessment` (per-worker verdicts), `GET
 * /api/agent/jobs/{id}/inputs/{filename}` (signed input download), `POST
 * /api/agent/jobs/{id}/artifacts` (signed legacy multipart upload,
 * X-Artifact-SHA256 verify), `GET /api/jobs/{id}/artifacts/{filename}`
 * (console download), `POST /api/jobs/{id}/cancel` (-> Hub DO
 * `/internal/cancel`), `POST /api/jobs/{id}/retry`.
 *
 * NEW (Task 8, no Python parity -- cloud-only presign protocol): `POST
 * /api/agent/jobs/{id}/artifacts/presign` (signed JSON -> one-time-token
 * "direct" mode, or an aws4-sigv4-presigned R2 S3 PUT URL when
 * `R2_S3_*` env is fully configured), `PUT
 * /api/agent/jobs/{id}/artifacts/raw/{token}` (unsigned -- the token IS the
 * auth -- streams the body to R2 while hashing via `crypto.DigestStream`),
 * `POST /api/agent/jobs/{id}/artifacts/confirm` (signed, S3-mode only --
 * HEADs the R2 object the agent uploaded directly and records its claimed
 * hash; see that handler for why this is a deliberate trust boundary, not a
 * gap).
 *
 * The job-creation path also pokes the Hub Durable Object's alarm
 * (`/internal/wake`, a trivial handler added in `do/hub.ts`) after inserting
 * a queued job, so a freshly-submitted console job is picked up on the next
 * 5s tick rather than waiting for some unrelated event (a WS handshake, a
 * cancel) to re-arm the alarm first.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import * as queries from "../db/queries";
import { toSqliteTimestamp, sqliteTimestampToIsoformat } from "../db/queries";
import type { Job, Receipt } from "../db/queries";
import { extract, estimateVram, needsFromJob, signature, verdict, fleetWideGaps, partitionFleetFetchable, type JobNeeds, type FetchableModels } from "../core/assess";
import { peerOnlyNames } from "../core/model_manifest";
import { sanitizePathComponentOrThrow, artifactKey, jobInputKey } from "../lib/store";
import { fileCapExceeded, readLimits, tooLargeMessage } from "../lib/limits";
import { verifyAgentRequest, type VerifyAgentResult } from "../lib/verify_agent";
import { requireUser, requireCsrfUser, errorJson, SESSION_VAR } from "../lib/guard";
import { bytesToBase64Url } from "../lib/base64";
import { bytesToHex } from "../lib/hex";
import { presignUrl, r2S3Host } from "../lib/sigv4";
import { bilingualMessage } from "../core/auth";
import * as modelGuide from "../core/model_guide";
import * as modelManifest from "../core/model_manifest";
import * as split from "../core/split";
import { resolvePlatformSeed } from "../db/queries";

// Cloud-only (no Python parity source -- the monolith calls its dispatcher
// in-process and has no DO that can be unreachable), so bilingual like
// SETUP_MESSAGES rather than the English-only Python-ported strings above.
const HUB_UNAVAILABLE = {
  en: "Cancel could not be delivered; try again.",
  zhTW: "取消請求無法送達，請再試一次。",
};

// Also cloud-only (Task 8's presign protocol has no Python parity source).
const PRESIGN_SIZE_REQUIRED = {
  en: "A numeric 'size' (bytes) is required.",
  zhTW: "必須提供數值型別的 size（位元組數）。",
};

const UPLOAD_TOKEN_TTL_SECONDS = 600;
const S3_PRESIGN_TTL_SECONDS = 600;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------
// Small shared helpers (duplicated in spirit from routes/workers.ts, which
// keeps the same small per-file copies rather than a cross-route import)

/** Manually pumps `readable` into `writable` chunk-by-chunk. See the caller
 * in the raw-PUT route for why this can't just be `readable.pipeTo(writable)`
 * when `writable` belongs to a `FixedLengthStream`. Propagates a write
 * failure (e.g. `FixedLengthStream`'s "too many bytes" throw) by rejecting,
 * same as `pipeTo` would. */
async function pumpStream(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>): Promise<void> {
  const reader = readable.getReader();
  const writer = writable.getWriter();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
    await writer.close();
  } catch (err) {
    await writer.abort(err).catch(() => undefined);
    throw err;
  }
}

function requestInfo(url: string): { path: string; query: string } {
  const u = new URL(url);
  return { path: u.pathname, query: u.search ? u.search.slice(1) : "" };
}

async function verifyAgent(
  c: { env: Env; req: { method: string; header: (name: string) => string | undefined; url: string } },
  body: Uint8Array
): Promise<VerifyAgentResult> {
  const { path, query } = requestInfo(c.req.url);
  return verifyAgentRequest(
    c.env.DB,
    {
      workerId: c.req.header("X-Worker-Id") ?? null,
      ts: c.req.header("X-Ts") ?? null,
      nonce: c.req.header("X-Nonce") ?? null,
      sig: c.req.header("X-Sig") ?? null,
    },
    { method: c.req.method, path, query, body }
  );
}

/** Fire-and-forget the Hub DO's alarm re-arm -- best-effort, never blocks or
 * fails the caller's response (a missed wake just means the next tick picks
 * the job up 5s later via whatever else re-arms the alarm, or the next
 * request through this same helper). */
async function wakeHub(env: Env): Promise<void> {
  try {
    const stub = env.HUB.get(env.HUB.idFromName("hub"));
    await stub.fetch("http://hub.internal/internal/wake", { method: "POST" });
  } catch (err) {
    console.warn("jobs: failed to wake the Hub DO", err);
  }
}

// ---------------------------------------------------------------------------
// Job -> JSON dict shaping -- ports jobs.py's `_job_dict` / `_job_dict_full`
// / `_receipt_dict` exactly (field names/shape).

/** Ports jobs.py's `_job_dict`. `hub` (optional) enables the Phase 2.1
 * transient model-auto-fetch progress fields (stage/fetch_pct/fetch_model,
 * NOT a Job column -- see `do/hub.ts`'s `fetchProgress` field docstring):
 * added only while the job is actually in that phase, mirroring
 * `agentws._fetch_progress`'s "omit rather than send an explicit null" for a
 * field the agent didn't report a valid value for. Callers that don't have
 * (or don't need) a `hub` binding skip the extra DO round-trip entirely. */
async function jobDict(job: Job, hub?: DurableObjectNamespace): Promise<Record<string, unknown>> {
  const d: Record<string, unknown> = {
    id: job.id,
    status: job.status,
    origin: job.origin,
    progress: job.progress,
    worker_id: job.workerId,
    created_at: job.createdAt ? sqliteTimestampToIsoformat(job.createdAt) : null,
    error: job.error,
    result_files: job.resultFiles,
    input_assets: job.inputAssets,
    est_vram_gb: job.estVramGb,
    // Phase 3.3 §3.7: splitting and the dispatch rationale, shared by the list
    // and the detail page. `parent_id`/`split_index` are null on an ordinary
    // job; they only ever carry a value on a child, which `GET /api/jobs`
    // hides unless `?include_children=1` asks for it.
    split_count: job.splitCount,
    parent_id: job.parentId,
    split_index: job.splitIndex,
    dispatch_info: job.dispatchInfo,
  };
  if (hub) {
    const progress = await queries.getFetchProgress(hub, job.id);
    if (progress) {
      if (progress.stage !== null) d.stage = progress.stage;
      if (progress.fetch_pct !== null) d.fetch_pct = progress.fetch_pct;
      if (progress.fetch_model !== null) d.fetch_model = progress.fetch_model;
    }
  }
  return d;
}

function receiptDict(receipt: Receipt): Record<string, unknown> {
  return {
    gpu_seconds: receipt.gpuSeconds,
    kind: receipt.kind,
    billable: receipt.billable,
    basis: receipt.basis,
    acked: receipt.workerSig !== null,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `[children, gpuSecondsTotal]` for a parent -- ports jobs.py's
 * `_children_summary`. One receipts query per child (D1 has no `IN (...)`
 * helper here and a parent has at most `MAX_SPLIT` children), summing only
 * BILLABLE receipts. A child with no receipt yet (still running, or cancelled
 * before it started) reports `gpu_seconds: null` -- distinct from a genuine
 * 0 -- and contributes nothing to the total. */
async function childrenSummary(
  db: D1Database,
  parentId: string
): Promise<[Record<string, unknown>[], number]> {
  const children = await split.childrenOf(db, parentId);
  const summary: Record<string, unknown>[] = [];
  let total = 0;
  for (const child of children) {
    const receipts = await queries.getReceiptsForJob(db, child.id);
    const billable = receipts.filter((r) => r.billable);
    const gpuSeconds = billable.length > 0 ? billable.reduce((sum, r) => sum + r.gpuSeconds, 0) : null;
    if (gpuSeconds !== null) total += gpuSeconds;
    summary.push({
      id: child.id,
      split_index: child.splitIndex,
      status: child.status,
      worker_id: child.workerId,
      progress: child.progress,
      gpu_seconds: gpuSeconds,
      error: child.error,
    });
  }
  return [summary, total];
}

async function jobDictFull(
  job: Job,
  receipt: Receipt | null,
  db: D1Database,
  hub?: DurableObjectNamespace
): Promise<Record<string, unknown>> {
  const d: Record<string, unknown> = {
    ...(await jobDict(job, hub)),
    workflow_json: parseJsonObject(job.workflowJson),
    requirements: job.requirements,
    required_nodes: job.requiredNodes,
    required_models: job.requiredModels,
    started_at: job.startedAt ? sqliteTimestampToIsoformat(job.startedAt) : null,
    finished_at: job.finishedAt ? sqliteTimestampToIsoformat(job.finishedAt) : null,
    result_hashes: job.resultHashes,
  };

  // Phase 3.3 §3.7: a parent job has no receipt of its own (each child mints
  // one), so `receipt` is always null there and the detail page reads
  // `children` / `gpu_seconds_total` instead. `outputs` gives it the
  // (child, filename) pairs it needs to link each merged output at
  // `/api/jobs/<child>/artifacts/<file>` -- the parent's own `result_files`
  // column is always empty and the bytes live under the child that made them.
  if (job.splitCount > 0) {
    d.receipt = null;
    const [children, gpuSecondsTotal] = await childrenSummary(db, job.id);
    d.children = children;
    d.gpu_seconds_total = gpuSecondsTotal;
    d.outputs = (await split.parentOutputs(db, job)).map(([jobId, filename]) => ({
      job_id: jobId,
      filename,
    }));
  } else {
    d.receipt = receipt ? receiptDict(receipt) : null;
    d.children = [];
    d.gpu_seconds_total = receipt ? receipt.gpuSeconds : 0;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Owner-or-admin gate for the per-job CONSOLE routes (Phase 3.0 parity port
// of jobs.py's `_require_owner_or_admin`) -- NOT the agent-facing artifact
// routes below, which have their own worker-ownership gate.

/** Whether `user` may see/act on `job` under the owner-or-admin rule: an
 * admin always may; anyone else only if `job.userId` is their own uid.
 * Returns a boolean rather than throwing (unlike Python's exception-raising
 * `_require_owner_or_admin`) so every call site can answer with jobs.ts's
 * own existing 404 `errorJson`, keeping the "non-owner gets the SAME 404 a
 * nonexistent job would" contract explicit at each call site rather than
 * hidden inside a thrown error. */
function isOwnerOrAdmin(job: Job, user: { uid: string; role: string }): boolean {
  return user.role === "admin" || job.userId === user.uid;
}

// ---------------------------------------------------------------------------
// Ownership gate shared by every /api/agent/jobs/{id}/artifacts* route --
// ports jobs.py's `upload_job_artifact` inline check (owns_it OR the blip
// re-adoption window).

function workerOwnsArtifactUpload(job: Job, workerId: string): boolean {
  const ownsIt = job.workerId === workerId && (job.status === "assigned" || job.status === "running");
  const inBlipWindow = job.status === "queued" && job.lastWorkerId === workerId;
  return ownsIt || inBlipWindow;
}

// ---------------------------------------------------------------------------
// Submission-relaxation gate (Phase 2.1 Task 7) -- ports jobs.py's
// `unfetchable_missing_models`: the console submit predicate, fleet-wide
// missing models that are ALSO not fetchable by anyone (see
// `assess.partitionFleetFetchable`). Builds the manifest's name -> size_bytes
// map with exactly ONE `model_manifest.entries()` read per request.

async function unfetchableMissingModels(env: Env, needs: JobNeeds): Promise<Set<string>> {
  const allWorkers = await queries.getAllWorkers(env.DB);
  const [missingModels] = fleetWideGaps(needs, allWorkers);
  if (missingModels.size === 0) return new Set();

  const onlineWorkers = await queries.getOnlineEnabledWorkers(env.DB);
  const seed = await resolvePlatformSeed(env.DB, env.PLATFORM_ED25519_SEED);
  const manifestEntries = await modelManifest.entries(env.DB, env.STORE, seed);
  const fetchableMap: FetchableModels = {};
  for (const e of manifestEntries) fetchableMap[e.name] = e.size_bytes;

  const [, unfetchable] = partitionFleetFetchable(missingModels, fetchableMap, onlineWorkers, peerOnlyNames(manifestEntries));
  return unfetchable;
}

const app = new Hono<{ Bindings: Env }>();

// --- POST /api/jobs -----------------------------------------------------

app.post("/api/jobs", requireCsrfUser, async (c) => {
  const user = c.get(SESSION_VAR).user;
  const contentType = c.req.header("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return errorJson(c, 400, "jobs.invalid_workflow", "Expected multipart/form-data.");
  }

  const form = await c.req.parseBody({ all: true });
  const workflowJsonText = typeof form["workflow_json"] === "string" ? (form["workflow_json"] as string) : "";
  const requirementsText = typeof form["requirements"] === "string" ? (form["requirements"] as string) : undefined;

  let workflow: Record<string, unknown>;
  try {
    const parsed = JSON.parse(workflowJsonText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    workflow = parsed as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, "jobs.invalid_workflow", "workflow_json is not valid JSON.");
  }

  let requirements: Record<string, unknown> = {};
  if (requirementsText) {
    try {
      const parsed = JSON.parse(requirementsText);
      requirements = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return errorJson(c, 400, "jobs.invalid_workflow", "requirements is not valid JSON.");
    }
  }

  const rawAssets = form["assets"];
  const assetFiles: File[] = Array.isArray(rawAssets)
    ? rawAssets.filter((f): f is File => f instanceof File)
    : rawAssets instanceof File
      ? [rawAssets]
      : [];

  const uploadedNames: string[] = [];
  // Same admin-configured per-file cap the panel's uploads obey
  // (`upload_max_file_mb`, default 50) -- an asset submitted with a job is
  // user bytes like any other, and this route had no ceiling at all. Checked
  // BEFORE the job row is inserted, so a refused submit leaves nothing
  // behind. The per-user QUOTA deliberately does not apply here: these bytes
  // land in `job_inputs/<job_id>/`, job-scoped result storage outside the
  // quota, exactly like artifacts (see lib/limits.ts).
  const uploadLimits = await readLimits(c.env.DB);
  for (const file of assetFiles) {
    try {
      uploadedNames.push(sanitizePathComponentOrThrow(file.name || "", "asset filename"));
    } catch {
      return errorJson(c, 400, "jobs.bad_asset_name", `Invalid asset filename: ${JSON.stringify(file.name ?? "")}`);
    }
    if (fileCapExceeded(file.size, uploadLimits)) {
      return errorJson(c, 413, "jobs.asset_too_large", tooLargeMessage(uploadLimits));
    }
  }

  const needs = extract(workflow);
  const available = new Set(uploadedNames);
  const missing = [...needs.assets].filter((name) => !available.has(name)).sort();
  if (missing.length > 0) {
    return errorJson(
      c,
      400,
      "jobs.missing_assets",
      `Workflow references assets that were not uploaded: ${missing.join(", ")}`
    );
  }

  const unfetchable = await unfetchableMissingModels(c.env, needs);
  if (unfetchable.size > 0) {
    const names = [...unfetchable].sort();
    return errorJson(c, 400, "jobs.missing_models", await modelGuide.guidanceMessage(names, c.env.STORE));
  }

  const allWorkers = await queries.getAllWorkers(c.env.DB);
  const estVramGb = estimateVram(needs.models, allWorkers);

  const jobId = crypto.randomUUID();
  await queries.insertJob(c.env.DB, {
    id: jobId,
    workflowJson: workflowJsonText,
    requirements,
    requiredNodes: [...needs.nodes].sort(),
    requiredModels: [...needs.models].sort(),
    estVramGb,
    inputAssets: [...available].sort(),
    origin: "console",
    createdAt: toSqliteTimestamp(new Date()),
    userId: user.uid,
    signature: await signature(workflow, needs),
    // Phase 3.3 §3.2：送件時就判定可不可拆（含 requirements.split 與平台設定
    // split_batches）；不可拆存 NULL。
    splitPlan: split.planForJob(workflow, requirements, await split.splitBatchesEnabled(c.env.DB)),
  });

  for (const [file, filename] of assetFiles.map((f, i) => [f, uploadedNames[i]!] as const)) {
    await c.env.STORE.put(jobInputKey(jobId, filename), await file.arrayBuffer());
  }

  await wakeHub(c.env);

  return c.json({ job_id: jobId });
});

// --- GET /api/jobs -------------------------------------------------------

app.get("/api/jobs", requireUser, async (c) => {
  const user = c.get(SESSION_VAR).user;
  const isAdmin = user.role === "admin";
  const statusParam = c.req.query("status");
  const statuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;
  // Any value but an explicit "0" (or an empty one) opts in. NOT byte-identical
  // to Python's `include_children: int = 0` FastAPI param, which 422s on a
  // non-numeric value; here a non-numeric value is simply truthy. The opt-in
  // is a display toggle, so the lenient reading costs nothing -- documented
  // rather than "fixed" so the difference is explicit if it ever matters.
  const includeChildrenParam = c.req.query("include_children");
  const includeChildren = includeChildrenParam !== undefined && includeChildrenParam !== "" && includeChildrenParam !== "0";
  const jobs = await queries.listJobs(c.env.DB, statuses, {
    ...(isAdmin ? {} : { userId: user.uid }),
    includeChildren,
  });

  if (isAdmin) {
    const userIds = [...new Set(jobs.map((j) => j.userId).filter((id): id is string => id !== null))];
    const usernameById = await queries.getUsernamesByIds(c.env.DB, userIds);
    return c.json(
      await Promise.all(
        jobs.map(async (job) => ({ ...(await jobDict(job, c.env.HUB)), username: usernameById.get(job.userId ?? "") ?? null }))
      )
    );
  }

  // Non-admin: every row here is already the caller's own (filtered above),
  // so the username is always the caller's own -- included anyway so admin
  // and non-admin list items share the same shape.
  return c.json(
    await Promise.all(jobs.map(async (job) => ({ ...(await jobDict(job, c.env.HUB)), username: user.username })))
  );
});

// --- GET /api/jobs/{id} ---------------------------------------------------

app.get("/api/jobs/:jobId", requireUser, async (c) => {
  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (!isOwnerOrAdmin(job, c.get(SESSION_VAR).user)) return errorJson(c, 404, "jobs.not_found", "Job not found.");

  const receipts = await queries.getReceiptsForJob(c.env.DB, jobId);
  // Newest first -- a retried job can accumulate more than one receipt
  // across attempts; the detail view shows the latest.
  const receipt = receipts.length > 0 ? receipts.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]! : null;

  return c.json(await jobDictFull(job, receipt, c.env.DB, c.env.HUB));
});

// --- GET /api/jobs/{id}/assessment ----------------------------------------

app.get("/api/jobs/:jobId/assessment", requireUser, async (c) => {
  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (!isOwnerOrAdmin(job, c.get(SESSION_VAR).user)) return errorJson(c, 404, "jobs.not_found", "Job not found.");

  const needs = needsFromJob(job);
  const allWorkers = (await queries.getAllWorkers(c.env.DB)).filter((w) => !w.disabled);

  // Phase 2.1: same signed manifest dispatch/submission use, so the
  // assessment display's eligible_after_fetch column matches what would
  // actually happen at dispatch time -- built once, ONE manifest read.
  const seed = await resolvePlatformSeed(c.env.DB, c.env.PLATFORM_ED25519_SEED);
  const manifestEntries = await modelManifest.entries(c.env.DB, c.env.STORE, seed);
  const fetchableModels: FetchableModels = {};
  for (const e of manifestEntries) fetchableModels[e.name] = e.size_bytes;
  const peerOnlyModels = peerOnlyNames(manifestEntries);

  const results = allWorkers.map((worker) => {
    const v = verdict(worker, needs, job.requirements, allWorkers, fetchableModels, peerOnlyModels);
    return {
      worker_id: worker.id,
      name: worker.name,
      verdict: v.kind,
      reasons: v.reasons,
      warnings: v.warnings,
      missing_models: v.missingModels,
    };
  });

  return c.json({ workers: results });
});

// --- GET /api/agent/jobs/{id}/inputs/{filename} ---------------------------

app.get("/api/agent/jobs/:jobId/inputs/:filename", async (c) => {
  const outcome = await verifyAgent(c, new Uint8Array());
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);
  const worker = outcome.worker;

  const jobId = c.req.param("jobId");
  const filename = c.req.param("filename");

  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (job.workerId !== worker.id) {
    return errorJson(c, 403, "jobs.not_assigned", "Job is not assigned to this worker.");
  }
  if (!job.inputAssets.includes(filename)) {
    return errorJson(c, 404, "jobs.asset_not_found", "Asset not found for this job.");
  }

  let key: string;
  try {
    key = jobInputKey(jobId, filename);
  } catch {
    return errorJson(c, 404, "jobs.asset_not_found", "Asset not found for this job.");
  }

  const obj = await c.env.STORE.get(key);
  if (!obj) return errorJson(c, 404, "jobs.asset_not_found", "Asset not found for this job.");

  return new Response(obj.body, {
    headers: { "Content-Type": "application/octet-stream" },
  });
});

// --- POST /api/agent/jobs/{id}/artifacts (legacy multipart) ---------------

app.post("/api/agent/jobs/:jobId/artifacts", async (c) => {
  const raw = new Uint8Array(await c.req.arrayBuffer());
  const outcome = await verifyAgent(c, raw);
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);
  const worker = outcome.worker;

  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (!workerOwnsArtifactUpload(job, worker.id)) {
    return errorJson(c, 403, "jobs.not_assigned", "Job is not assigned to this worker.");
  }

  const contentType = c.req.header("content-type") ?? "";
  let formData: FormData;
  try {
    formData = await new Response(raw, { headers: { "content-type": contentType } }).formData();
  } catch {
    return errorJson(c, 400, "jobs.bad_asset_name", "Missing 'file' field.");
  }
  const file = formData.get("file");
  if (!(file instanceof File)) {
    return errorJson(c, 400, "jobs.bad_asset_name", "Missing 'file' field.");
  }

  let artifactName: string;
  try {
    artifactName = sanitizePathComponentOrThrow(file.name || "", "artifact filename");
  } catch {
    return errorJson(c, 400, "jobs.bad_asset_name", `Invalid artifact filename: ${JSON.stringify(file.name ?? "")}`);
  }

  const content = new Uint8Array(await file.arrayBuffer());
  const computedSha256 = bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", content)));

  const claimedSha256 = c.req.header("X-Artifact-SHA256");
  if (claimedSha256 && claimedSha256.trim().toLowerCase() !== computedSha256) {
    return errorJson(c, 400, "artifact.hash_mismatch", "Uploaded artifact does not match the declared X-Artifact-SHA256.");
  }

  await c.env.STORE.put(artifactKey(jobId, artifactName), content);
  await queries.mergeJobResultHash(c.env.DB, jobId, artifactName, computedSha256);

  return c.json({ stored: artifactName, sha256: computedSha256 });
});

// --- POST /api/agent/jobs/{id}/artifacts/presign (Task 8, cloud-only) -----

app.post("/api/agent/jobs/:jobId/artifacts/presign", async (c) => {
  const raw = new Uint8Array(await c.req.arrayBuffer());
  const outcome = await verifyAgent(c, raw);
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);
  const worker = outcome.worker;

  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (!workerOwnsArtifactUpload(job, worker.id)) {
    return errorJson(c, 403, "jobs.not_assigned", "Job is not assigned to this worker.");
  }

  let parsed: Record<string, unknown>;
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw);
    const value = JSON.parse(text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, "jobs.bad_asset_name", "Invalid JSON body.");
  }

  const filenameRaw = typeof parsed.filename === "string" ? parsed.filename : "";
  let filename: string;
  try {
    filename = sanitizePathComponentOrThrow(filenameRaw, "artifact filename");
  } catch {
    return errorJson(c, 400, "jobs.bad_asset_name", `Invalid artifact filename: ${JSON.stringify(filenameRaw)}`);
  }

  const sha256 = typeof parsed.sha256 === "string" ? parsed.sha256.trim().toLowerCase() : "";
  if (!SHA256_HEX_RE.test(sha256)) {
    return errorJson(c, 400, "jobs.bad_asset_name", "sha256 must be a 64-character hex string.");
  }
  // m4 (final review): a numeric `size` is required, not merely accepted --
  // without it, the raw-PUT handler's `FixedLengthStream` guard (jobs.ts's
  // PUT .../artifacts/raw/:token) never gets installed and an authenticated
  // agent's body streams into R2 unbounded. The real Python agent
  // (`agent/comfyfed_agent/runner.py:804`) always sends `size: len(content)`
  // in this body, so rejecting its absence here is a cloud-only tightening,
  // not a break: no agent-side change needed.
  const size = typeof parsed.size === "number" && Number.isFinite(parsed.size) && parsed.size >= 0 ? parsed.size : null;
  if (size === null) {
    return errorJson(c, 400, "jobs.bad_asset_name", bilingualMessage(PRESIGN_SIZE_REQUIRED));
  }

  // m3 (final review): mirror `verify_agent.ts`'s `pruneNonces` -- prune on
  // this same write path rather than a separate cron, so `upload_tokens`
  // doesn't grow unbounded for the life of the deployment.
  await queries.pruneUploadTokens(c.env.DB, Math.floor(Date.now() / 1000));

  const { R2_S3_ACCOUNT_ID, R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, R2_S3_BUCKET } = c.env;
  if (R2_S3_ACCOUNT_ID && R2_S3_ACCESS_KEY_ID && R2_S3_SECRET_ACCESS_KEY && R2_S3_BUCKET) {
    const key = artifactKey(jobId, filename);
    const url = await presignUrl({
      accessKeyId: R2_S3_ACCESS_KEY_ID,
      secretAccessKey: R2_S3_SECRET_ACCESS_KEY,
      region: "auto",
      service: "s3",
      path: `/${R2_S3_BUCKET}/${key}`,
      host: r2S3Host(R2_S3_ACCOUNT_ID),
      method: "PUT",
      expiresSeconds: S3_PRESIGN_TTL_SECONDS,
    });
    return c.json({
      mode: "s3",
      url,
      expires_at: new Date(Date.now() + S3_PRESIGN_TTL_SECONDS * 1000).toISOString(),
    });
  }

  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(24)));
  const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_TOKEN_TTL_SECONDS;
  await queries.insertUploadToken(c.env.DB, token, jobId, filename, sha256, size, expiresAt);

  return c.json({
    mode: "direct",
    url: `/api/agent/jobs/${jobId}/artifacts/raw/${token}`,
    expires_at: new Date(expiresAt * 1000).toISOString(),
  });
});

// --- PUT /api/agent/jobs/{id}/artifacts/raw/{token} (unsigned; token = auth)

app.put("/api/agent/jobs/:jobId/artifacts/raw/:token", async (c) => {
  const jobId = c.req.param("jobId");
  const token = c.req.param("token");

  const row = await queries.getUploadToken(c.env.DB, token);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!row || row.jobId !== jobId || row.expiresAt < nowSeconds) {
    return errorJson(c, 404, "jobs.token_invalid", "Upload token not found or expired.");
  }
  if (row.used) {
    return errorJson(c, 409, "jobs.replay", "Upload token already used.");
  }

  const contentLengthHeader = c.req.header("content-length");
  if (row.size !== null && contentLengthHeader) {
    const declaredLength = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declaredLength) && declaredLength > row.size) {
      return errorJson(c, 413, "jobs.artifact_too_large", "Upload exceeds the declared size.");
    }
  }

  const claimed = await queries.claimUploadToken(c.env.DB, token);
  if (!claimed) {
    return errorJson(c, 409, "jobs.replay", "Upload token already used.");
  }

  const body = c.req.raw.body;
  if (!body) {
    return errorJson(c, 400, "jobs.bad_asset_name", "Missing request body.");
  }

  const key = artifactKey(jobId, row.filename);

  // `crypto.DigestStream` (Workers-specific) hashes bytes as they're piped
  // through it -- no whole-body buffer needed to verify sha256. One tee
  // branch feeds it directly; the other feeds R2.
  const [toStore, toDigest] = body.tee();
  const digestStream = new crypto.DigestStream("SHA-256");
  const digestDone = toDigest.pipeTo(digestStream);

  // Enforce the declared size WHILE streaming, not only after the fact: the
  // Content-Length pre-check above is a fast-path best-effort (a chunked
  // request has no such header at all). `FixedLengthStream(row.size)` is
  // the real guard -- its writable side throws the MOMENT more bytes than
  // declared are written to it (or if the source closes having written
  // fewer), aborting the pipe mid-flight rather than letting a full
  // oversized body land in R2 before anyone notices. It also happens to be
  // exactly what `R2Bucket.put` needs here: a plain `TransformStream`'s
  // readable side loses the "known length" R2 requires (`put` throws
  // "Provided readable stream must have a known length" otherwise), while
  // `FixedLengthStream`'s readable side carries it through.
  let storeDone: Promise<unknown>;
  if (row.size !== null) {
    const { readable, writable } = new FixedLengthStream(row.size);
    // A manual reader/writer pump, not `toStore.pipeTo(writable)`: workerd
    // doesn't implement `pipeTo` directly between two identity-transform-
    // backed streams (a `tee()` branch piped straight into another
    // `TransformStream`/`FixedLengthStream`'s writable throws "Inter-
    // TransformStream ReadableStream.pipeTo() is not implemented") --
    // pumping chunk-by-chunk through explicit `getReader()`/`getWriter()`
    // calls sidesteps that internal optimization path entirely.
    const pumpDone = pumpStream(toStore, writable);
    storeDone = Promise.all([pumpDone, c.env.STORE.put(key, readable)]);
  } else {
    storeDone = c.env.STORE.put(key, toStore);
  }

  try {
    await Promise.all([digestDone, storeDone]);
  } catch {
    // The size guard aborted the pipeline mid-stream (or some other
    // stream-level failure) -- clean up whatever partial object R2 may
    // have written and report it as the size violation it almost
    // certainly is.
    await c.env.STORE.delete(key).catch(() => undefined);
    return errorJson(c, 413, "jobs.artifact_too_large", "Upload exceeds the declared size.");
  }

  const computedSha256 = bytesToHex(new Uint8Array(await digestStream.digest));

  if (computedSha256 !== row.sha256) {
    await c.env.STORE.delete(key).catch(() => undefined);
    return errorJson(c, 400, "artifact.hash_mismatch", "Uploaded artifact does not match the declared sha256.");
  }

  await queries.mergeJobResultHash(c.env.DB, jobId, row.filename, computedSha256);

  return c.json({ stored: row.filename, sha256: computedSha256 });
});

// --- POST /api/agent/jobs/{id}/artifacts/confirm (S3 mode only) ----------

app.post("/api/agent/jobs/:jobId/artifacts/confirm", async (c) => {
  const raw = new Uint8Array(await c.req.arrayBuffer());
  const outcome = await verifyAgent(c, raw);
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);
  const worker = outcome.worker;

  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (!workerOwnsArtifactUpload(job, worker.id)) {
    return errorJson(c, 403, "jobs.not_assigned", "Job is not assigned to this worker.");
  }

  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw));
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
    parsed = value as Record<string, unknown>;
  } catch {
    return errorJson(c, 400, "jobs.bad_asset_name", "Invalid JSON body.");
  }

  const filenameRaw = typeof parsed.filename === "string" ? parsed.filename : "";
  let filename: string;
  try {
    filename = sanitizePathComponentOrThrow(filenameRaw, "artifact filename");
  } catch {
    return errorJson(c, 400, "jobs.bad_asset_name", `Invalid artifact filename: ${JSON.stringify(filenameRaw)}`);
  }
  const sha256 = typeof parsed.sha256 === "string" ? parsed.sha256.trim().toLowerCase() : "";
  if (!SHA256_HEX_RE.test(sha256)) {
    return errorJson(c, 400, "jobs.bad_asset_name", "sha256 must be a 64-character hex string.");
  }

  // S3-mode uploads land in R2 via a presigned PUT the agent sent directly
  // to R2's S3 endpoint -- this Worker never saw the bytes, so it cannot
  // recompute the hash itself the way the "direct" and legacy paths do.
  // HEADing the object only proves *something* was written to the expected
  // key; the recorded hash is the agent's own claim, taken on trust here.
  // This is a deliberate, narrower trust boundary than the other two upload
  // paths (both of which verify bytes server-side) -- acceptable because an
  // agent that can forge this claim already holds a valid signing key for a
  // job it legitimately owns, i.e. no privilege it doesn't already have.
  const key = artifactKey(jobId, filename);
  const head = await c.env.STORE.head(key);
  if (!head) {
    return errorJson(c, 404, "jobs.artifact_not_found", "Artifact not found in storage.");
  }

  await queries.mergeJobResultHash(c.env.DB, jobId, filename, sha256);

  return c.json({ stored: filename, sha256 });
});

// --- GET /api/jobs/{id}/artifacts/{filename} (console download) ----------

app.get("/api/jobs/:jobId/artifacts/:filename", requireUser, async (c) => {
  const jobId = c.req.param("jobId");
  const filename = c.req.param("filename");

  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (!isOwnerOrAdmin(job, c.get(SESSION_VAR).user)) return errorJson(c, 404, "jobs.not_found", "Job not found.");

  let key: string;
  try {
    key = artifactKey(jobId, filename);
  } catch {
    return errorJson(c, 404, "jobs.artifact_not_found", "Artifact not found.");
  }

  const obj = await c.env.STORE.get(key);
  if (!obj) return errorJson(c, 404, "jobs.artifact_not_found", "Artifact not found.");

  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename.replace(/"/g, "")}"`,
    },
  });
});

// --- POST /api/jobs/{id}/cancel -------------------------------------------

app.post("/api/jobs/:jobId/cancel", requireCsrfUser, async (c) => {
  const jobId = c.req.param("jobId");
  const existing = await queries.getJobById(c.env.DB, jobId);
  if (!existing) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (!isOwnerOrAdmin(existing, c.get(SESSION_VAR).user)) return errorJson(c, 404, "jobs.not_found", "Job not found.");

  const stub = c.env.HUB.get(c.env.HUB.idFromName("hub"));
  let res: Response;
  try {
    res = await stub.fetch("http://hub.internal/internal/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: jobId, reason: "cancelled by admin" }),
    });
  } catch (err) {
    console.warn("jobs: Hub DO cancel call threw", err);
    return errorJson(c, 502, "jobs.hub_unavailable", bilingualMessage(HUB_UNAVAILABLE));
  }
  if (!res.ok) {
    return errorJson(c, 502, "jobs.hub_unavailable", bilingualMessage(HUB_UNAVAILABLE));
  }
  let result: { cancelled: boolean; worker_id: string | null };
  try {
    result = await res.json();
  } catch (err) {
    console.warn("jobs: Hub DO cancel response was not JSON", err);
    return errorJson(c, 502, "jobs.hub_unavailable", bilingualMessage(HUB_UNAVAILABLE));
  }

  if (!result.cancelled) {
    const job = await queries.getJobById(c.env.DB, jobId);
    const status = job?.status ?? "unknown";
    return c.json(
      { error: { code: "jobs.already_terminal", message: `Job is already ${status}.` }, status },
      409
    );
  }

  return c.json({ status: "cancelled" });
});

// --- POST /api/jobs/{id}/retry ---------------------------------------------

app.post("/api/jobs/:jobId/retry", requireCsrfUser, async (c) => {
  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  if (!isOwnerOrAdmin(job, c.get(SESSION_VAR).user)) return errorJson(c, 404, "jobs.not_found", "Job not found.");
  // Final-review I2: a split child is never retryable on its own -- requeueing
  // one slice behind its parent's back would resurrect a job the failure
  // cascade already settled, and the parent's derived status/progress would
  // never account for it. Retry the parent, which re-runs whole (§3.6 clears
  // split_count/split_plan). Mirrors `jobs.retry_job`'s guard; `retryFailedJob`
  // also carries `AND parent_id IS NULL` as the atomic backstop.
  if (job.parentId !== null) {
    return errorJson(
      c,
      409,
      "jobs.not_retryable",
      "子工作不能單獨重試，請改重試父工作。 / A split child cannot be retried on its own; retry its parent job."
    );
  }
  if (job.status !== "failed") {
    return errorJson(c, 409, "jobs.not_retryable", "Only failed jobs can be retried.");
  }

  const retried = await queries.retryFailedJob(c.env.DB, jobId);
  if (!retried) {
    return errorJson(c, 409, "jobs.not_retryable", "Only failed jobs can be retried.");
  }

  await wakeHub(c.env);

  return c.json({ ok: true, job_id: jobId });
});

export default app;
