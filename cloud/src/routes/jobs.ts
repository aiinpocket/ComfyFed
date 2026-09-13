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
import { extract, estimateVram, needsFromJob, verdict } from "../core/assess";
import { sanitizePathComponentOrThrow, artifactKey, jobInputKey } from "../lib/store";
import { verifyAgentRequest, type VerifyAgentResult } from "../lib/verify_agent";
import { requireAdmin, requireCsrf, errorJson } from "../lib/guard";
import { bytesToBase64Url } from "../lib/base64";
import { bytesToHex } from "../lib/hex";
import { presignUrl, r2S3Host } from "../lib/sigv4";
import { bilingualMessage } from "../core/auth";

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

function jobDict(job: Job): Record<string, unknown> {
  return {
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
  };
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

function jobDictFull(job: Job, receipt: Receipt | null): Record<string, unknown> {
  return {
    ...jobDict(job),
    workflow_json: parseJsonObject(job.workflowJson),
    requirements: job.requirements,
    required_nodes: job.requiredNodes,
    required_models: job.requiredModels,
    started_at: job.startedAt ? sqliteTimestampToIsoformat(job.startedAt) : null,
    finished_at: job.finishedAt ? sqliteTimestampToIsoformat(job.finishedAt) : null,
    result_hashes: job.resultHashes,
    receipt: receipt ? receiptDict(receipt) : null,
  };
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

const app = new Hono<{ Bindings: Env }>();

// --- POST /api/jobs -----------------------------------------------------

app.post("/api/jobs", requireCsrf, async (c) => {
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
  for (const file of assetFiles) {
    try {
      uploadedNames.push(sanitizePathComponentOrThrow(file.name || "", "asset filename"));
    } catch {
      return errorJson(c, 400, "jobs.bad_asset_name", `Invalid asset filename: ${JSON.stringify(file.name ?? "")}`);
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
  });

  for (const [file, filename] of assetFiles.map((f, i) => [f, uploadedNames[i]!] as const)) {
    await c.env.STORE.put(jobInputKey(jobId, filename), await file.arrayBuffer());
  }

  await wakeHub(c.env);

  return c.json({ job_id: jobId });
});

// --- GET /api/jobs -------------------------------------------------------

app.get("/api/jobs", requireAdmin, async (c) => {
  const statusParam = c.req.query("status");
  const statuses = statusParam
    ? statusParam
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : undefined;
  const jobs = await queries.listJobs(c.env.DB, statuses);
  return c.json(jobs.map(jobDict));
});

// --- GET /api/jobs/{id} ---------------------------------------------------

app.get("/api/jobs/:jobId", requireAdmin, async (c) => {
  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");

  const receipts = await queries.getReceiptsForJob(c.env.DB, jobId);
  // Newest first -- a retried job can accumulate more than one receipt
  // across attempts; the detail view shows the latest.
  const receipt = receipts.length > 0 ? receipts.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]! : null;

  return c.json(jobDictFull(job, receipt));
});

// --- GET /api/jobs/{id}/assessment ----------------------------------------

app.get("/api/jobs/:jobId/assessment", requireAdmin, async (c) => {
  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");

  const needs = needsFromJob(job);
  const allWorkers = (await queries.getAllWorkers(c.env.DB)).filter((w) => !w.disabled);

  const results = allWorkers.map((worker) => {
    const v = verdict(worker, needs, job.requirements, allWorkers);
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

app.get("/api/jobs/:jobId/artifacts/:filename", requireAdmin, async (c) => {
  const jobId = c.req.param("jobId");
  const filename = c.req.param("filename");

  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");

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

app.post("/api/jobs/:jobId/cancel", requireCsrf, async (c) => {
  const jobId = c.req.param("jobId");
  const existing = await queries.getJobById(c.env.DB, jobId);
  if (!existing) return errorJson(c, 404, "jobs.not_found", "Job not found.");

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

app.post("/api/jobs/:jobId/retry", requireCsrf, async (c) => {
  const jobId = c.req.param("jobId");
  const job = await queries.getJobById(c.env.DB, jobId);
  if (!job) return errorJson(c, 404, "jobs.not_found", "Job not found.");
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
