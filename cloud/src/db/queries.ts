/**
 * Typed D1 row access for the tables in `cloud/migrations/0001_initial.sql`
 * (parity source: `server/comfyfed_server/db.py`'s SQLAlchemy models).
 *
 * Every table has JSON-string columns (Python stores them via
 * `json.dumps`/`json.loads` at the ORM boundary since SQLite has no native
 * JSON type). This module is where that boundary lives on the cloud side
 * too: raw `SELECT *` rows are converted to hydrated `Worker`/`Job`/etc.
 * objects with those columns parsed, and writes take structured values and
 * serialize them back to JSON text. Nothing outside this file should touch
 * a raw D1 row shape.
 *
 * Timestamps: every DATETIME-ish column is stored as the exact string
 * format SQLAlchemy's SQLite dialect produces for a naive UTC `datetime`:
 * `YYYY-MM-DD HH:MM:SS.ffffff` (space separator, no "T", no timezone
 * suffix, always 6 fractional digits). `toSqliteTimestamp` reproduces that
 * shape from a JS `Date` (millisecond precision zero-padded to 6 digits --
 * JS has no microsecond clock, but nothing here ever needs to round-trip
 * sub-millisecond precision). Because the format is fixed-width and
 * zero-padded, plain string comparison (`<`, `>=`) sorts identically to
 * chronological order, so callers needing a cutoff comparison (see
 * `core/dispatch.ts`'s stale-worker query) can do it entirely in SQL
 * without parsing timestamps back into JS `Date` objects.
 */

import { hexToBytes } from "../lib/hex";

// ---------------------------------------------------------------------------
// JSON helpers -- every parse mirrors Python's `try: json.loads(x or default)
// except (TypeError, ValueError): fallback` pattern: malformed JSON degrades
// to the fallback rather than throwing, matching assess.py/dispatch.py's
// "never crash the dispatch tick on a corrupt column" stance.

function safeParse<T>(raw: string | null | undefined, fallback: T): T {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function toSqliteTimestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const y = date.getUTCFullYear();
  const mo = pad(date.getUTCMonth() + 1);
  const d = pad(date.getUTCDate());
  const h = pad(date.getUTCHours());
  const mi = pad(date.getUTCMinutes());
  const s = pad(date.getUTCSeconds());
  const micros = pad(date.getUTCMilliseconds(), 3) + "000";
  return `${y}-${mo}-${d} ${h}:${mi}:${s}.${micros}`;
}

/** Inverse-ish of `toSqliteTimestamp`, formatted the way Python's naive
 * `datetime.isoformat()` renders the same value (`workers.py`'s `GET
 * /api/workers`: `w.last_seen.isoformat() if w.last_seen else None`) --
 * space separator becomes "T", and an all-zero fractional part is dropped
 * entirely (`datetime.isoformat()` omits microseconds when they are exactly
 * 0, which never happens in practice for a real heartbeat timestamp but is
 * matched here for completeness). */
export function sqliteTimestampToIsoformat(s: string): string {
  const iso = s.replace(" ", "T");
  return iso.endsWith(".000000") ? iso.slice(0, -7) : iso;
}

// ---------------------------------------------------------------------------
// Settings

export interface Setting {
  key: string;
  value: string;
}

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row ? row.value : null;
}

/** Upsert -- mirrors auth.py's `_set_setting` (get-then-insert-or-update). */
export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, value)
    .run();
}

const SESSION_SECRET_KEY = "session_secret";

/** Mirrors auth.py's `_get_or_create_session_secret`: lazily generates and
 * persists a 32-byte hex secret on first need (login, or any session read
 * before a login has ever happened) instead of requiring it at setup time --
 * though this cloud's `/api/setup` also seeds it eagerly, so in practice this
 * lazy path only fires for pre-Task-4-shaped rows or defensive callers. */
export async function getOrCreateSessionSecret(db: D1Database): Promise<string> {
  const existing = await getSetting(db, SESSION_SECRET_KEY);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await setSetting(db, SESSION_SECRET_KEY, secret);
  return secret;
}

export async function rotateSessionSecret(db: D1Database): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const secret = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await setSetting(db, SESSION_SECRET_KEY, secret);
  return secret;
}

const PLATFORM_SEED_KEY = "platform_seed";

/** Mirrors `security.load_platform_keys`: lazily generates and persists the
 * platform's Ed25519 signing seed on first use. Python stores it as a
 * hex-encoded 32-byte seed at `<data_dir>/keys/platform.key`; there is no
 * writable filesystem in a Worker, so the cloud port persists the same hex
 * seed as a `settings` row instead -- same lazy-generate-and-persist shape,
 * D1-backed rather than file-backed. Used to sign registration certificates
 * (`workers.py`'s `register()`) and to hand out `platform_pubkey` in the
 * register-token bundle (see `lib/ed25519.ts`'s `derivePublicKeyHexFromSeed`). */
export async function getOrCreatePlatformSeed(db: D1Database): Promise<string> {
  const existing = await getSetting(db, PLATFORM_SEED_KEY);
  if (existing) return existing;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const seed = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await setSetting(db, PLATFORM_SEED_KEY, seed);
  return seed;
}

/** Throws a clear, startup-style error if `seedHex` isn't exactly 32 bytes
 * of strict lowercase/uppercase hex (reuses `lib/hex.ts`'s `hexToBytes`,
 * which already rejects odd length and non-hex characters). Exported so
 * callers that want to fail fast on boot (rather than on first use) can
 * validate an operator-supplied secret eagerly. */
export function assertValidPlatformSeedHex(seedHex: string): void {
  let bytes: Uint8Array;
  try {
    bytes = hexToBytes(seedHex);
  } catch (err) {
    throw new Error(
      `PLATFORM_ED25519_SEED is not valid hex: ${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (bytes.length !== 32) {
    throw new Error(`PLATFORM_ED25519_SEED must be exactly 32 bytes (64 hex chars), got ${bytes.length} bytes`);
  }
}

/**
 * Resolves the platform Ed25519 signing seed for register-token issuance
 * and registration certificates. `envSeedHex` (the `PLATFORM_ED25519_SEED`
 * secret, see env.ts) wins deterministically whenever it's set: validated
 * strictly (throws immediately on bad hex/length -- a clear, startup-style
 * failure rather than silently falling back or signing with garbage), and
 * in that case the D1 `settings.platform_seed` row is NEVER read or
 * written -- this is what makes rotating the secret rotate the platform's
 * identity in a predictable, operator-controlled way (no stale D1 row left
 * shadowing it, no lazy-generate race with a concurrent first request).
 * Only when the env is absent does this fall back to the lazy
 * D1-persisted seed (`getOrCreatePlatformSeed`), preserving the original
 * behavior for a deployment that hasn't set the secret yet.
 */
export async function resolvePlatformSeed(db: D1Database, envSeedHex: string | undefined): Promise<string> {
  if (envSeedHex) {
    assertValidPlatformSeedHex(envSeedHex);
    return envSeedHex;
  }
  return getOrCreatePlatformSeed(db);
}

// ---------------------------------------------------------------------------
// Workers

export interface ModelInventoryEntry {
  name?: string;
  size?: number;
  [key: string]: unknown;
}

export interface Worker {
  id: string;
  name: string;
  pubkey: string;
  status: string;
  lastSeen: string | null;
  disabled: boolean;
  createdAt: string;
  hardware: Record<string, unknown>;
  dynamic: Record<string, unknown>;
  backend: string;
  torchVersion: string;
  nodeClasses: string[];
  modelInventory: ModelInventoryEntry[];
  objectInfoHash: string;
  protocol: number;
}

interface WorkerRow {
  id: string;
  name: string;
  pubkey: string;
  status: string;
  last_seen: string | null;
  disabled: number;
  created_at: string;
  hardware: string;
  dynamic: string;
  backend: string;
  torch_version: string;
  node_classes: string;
  model_inventory: string;
  object_info_hash: string;
  protocol: number;
}

function rowToWorker(row: WorkerRow): Worker {
  return {
    id: row.id,
    name: row.name,
    pubkey: row.pubkey,
    status: row.status,
    lastSeen: row.last_seen,
    disabled: row.disabled !== 0,
    createdAt: row.created_at,
    hardware: safeParse(row.hardware, {}),
    dynamic: safeParse(row.dynamic, {}),
    backend: row.backend,
    torchVersion: row.torch_version,
    nodeClasses: safeParse(row.node_classes, []),
    modelInventory: safeParse(row.model_inventory, []),
    objectInfoHash: row.object_info_hash,
    protocol: row.protocol,
  };
}

export async function getWorkerById(db: D1Database, id: string): Promise<Worker | null> {
  const row = await db.prepare("SELECT * FROM workers WHERE id = ?").bind(id).first<WorkerRow>();
  return row ? rowToWorker(row) : null;
}

export async function getWorkersByIds(db: D1Database, ids: string[]): Promise<Worker[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM workers WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<WorkerRow>();
  return results.map(rowToWorker);
}

export async function getAllWorkers(db: D1Database): Promise<Worker[]> {
  const { results } = await db.prepare("SELECT * FROM workers").all<WorkerRow>();
  return results.map(rowToWorker);
}

/** Workers whose last heartbeat (or `created_at` if it never heartbeated)
 * is strictly before `cutoffTimestamp` (a `toSqliteTimestamp`-shaped
 * string). Mirrors `dispatch.requeue_stale`'s `reference >= cutoff` skip
 * test, inverted, done in SQL via `COALESCE(last_seen, created_at)`. */
export async function getStaleWorkers(db: D1Database, cutoffTimestamp: string): Promise<Worker[]> {
  const { results } = await db
    .prepare("SELECT * FROM workers WHERE COALESCE(last_seen, created_at) < ?")
    .bind(cutoffTimestamp)
    .all<WorkerRow>();
  return results.map(rowToWorker);
}

export async function markWorkerOffline(db: D1Database, workerId: string): Promise<void> {
  await db.prepare("UPDATE workers SET status = 'offline' WHERE id = ?").bind(workerId).run();
}

/** Inserts a freshly-registered worker row (Task 5's `POST
 * /api/agent/register`), relying on the migration's column DEFAULTs for
 * everything `workers.py`'s `db.Worker(name=..., pubkey=...)` also leaves at
 * its model default (status='offline', hardware/dynamic='{}', etc). */
export async function insertWorker(
  db: D1Database,
  id: string,
  name: string,
  pubkey: string,
  createdAt: string
): Promise<void> {
  await db
    .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES (?, ?, ?, ?)")
    .bind(id, name, pubkey, createdAt)
    .run();
}

/** Mirrors `workers.py`'s `upload_object_info` DB write: only the hash
 * column changes, the gzipped bytes themselves go to R2 (see
 * `routes/workers.ts`). */
export async function updateWorkerObjectInfoHash(db: D1Database, workerId: string, hash: string): Promise<void> {
  await db.prepare("UPDATE workers SET object_info_hash = ? WHERE id = ?").bind(hash, workerId).run();
}

/** Returns true if a row was updated -- mirrors `disable_worker`'s 404 when
 * the worker doesn't exist. */
export async function setWorkerDisabled(db: D1Database, workerId: string, disabled: boolean): Promise<boolean> {
  const result = await db
    .prepare("UPDATE workers SET disabled = ? WHERE id = ?")
    .bind(disabled ? 1 : 0, workerId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Typed seam for the Hub DO's live per-worker state (queue depth, current
 * job, connection status, etc.) -- Task 6 wires this up for real. Until
 * then `GET /api/workers` (see routes/workers.ts) falls back to the
 * persisted `workers.dynamic` column, exactly like `workers.py` does today
 * (there is no live layer in the Python source either -- `dynamic` is
 * itself just a JSON column written by whatever last touched the worker
 * over its agent WebSocket). Always returns null for now. */
export async function getDynamic(_workerId: string): Promise<Record<string, unknown> | null> {
  return null;
}

// ---------------------------------------------------------------------------
// Jobs

export interface Job {
  id: string;
  workflowJson: string;
  status: string;
  workerId: string | null;
  lastWorkerId: string | null;
  progress: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  resultFiles: unknown[];
  requirements: Record<string, unknown>;
  requiredNodes: string[];
  requiredModels: string[];
  estVramGb: number | null;
  inputAssets: unknown[];
  resultHashes: Record<string, unknown>;
  origin: string;
  panelHidden: boolean;
}

interface JobRow {
  id: string;
  workflow_json: string;
  status: string;
  worker_id: string | null;
  last_worker_id: string | null;
  progress: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
  result_files: string;
  requirements: string;
  required_nodes: string;
  required_models: string;
  est_vram_gb: number | null;
  input_assets: string;
  result_hashes: string;
  origin: string;
  panel_hidden: number;
}

function rowToJob(row: JobRow): Job {
  return {
    id: row.id,
    workflowJson: row.workflow_json,
    status: row.status,
    workerId: row.worker_id,
    lastWorkerId: row.last_worker_id,
    progress: row.progress,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    resultFiles: safeParse(row.result_files, []),
    requirements: safeParse(row.requirements, {}),
    requiredNodes: safeParse(row.required_nodes, []),
    requiredModels: safeParse(row.required_models, []),
    estVramGb: row.est_vram_gb,
    inputAssets: safeParse(row.input_assets, []),
    resultHashes: safeParse(row.result_hashes, {}),
    origin: row.origin,
    panelHidden: row.panel_hidden !== 0,
  };
}

export async function getJobById(db: D1Database, id: string): Promise<Job | null> {
  const row = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  return row ? rowToJob(row) : null;
}

export async function getQueuedJobsOrderedByCreatedAt(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at ASC, id ASC")
    .all<JobRow>();
  return results.map(rowToJob);
}

/** Atomic claim: only flips `queued` -> `assigned` (and sets `worker_id`)
 * if the job is still queued at the moment the UPDATE runs. Returns whether
 * the claim succeeded (`meta.changes === 1`), mirroring
 * `dispatch.assign_jobs`'s `UPDATE ... WHERE status == "queued"` rowcount
 * check -- a job someone else claimed a moment ago is reported as a miss
 * rather than double-assigned. */
export async function claimJob(db: D1Database, jobId: string, workerId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE jobs SET status = 'assigned', worker_id = ? WHERE id = ? AND status = 'queued'")
    .bind(workerId, jobId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Atomic re-adoption claim: only flips `queued` -> `assigned` for
 * `workerId` if the job is still queued AND `last_worker_id` still matches
 * `workerId` -- see `dispatch.try_readopt`. */
export async function readoptJob(db: D1Database, jobId: string, workerId: string): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE jobs SET status = 'assigned', worker_id = ? WHERE id = ? AND status = 'queued' AND last_worker_id = ?"
    )
    .bind(workerId, jobId, workerId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function getJobsForWorkerInStatuses(
  db: D1Database,
  workerId: string,
  statuses: string[]
): Promise<Job[]> {
  const placeholders = statuses.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM jobs WHERE worker_id = ? AND status IN (${placeholders})`)
    .bind(workerId, ...statuses)
    .all<JobRow>();
  return results.map(rowToJob);
}

/** Requeue every assigned/running job currently owned by `workerId`: back
 * to `queued`, `worker_id` cleared, `last_worker_id` recorded (so a later
 * blip-return can `readoptJob`), progress reset. Returns the requeued job
 * ids -- mirrors `dispatch.requeue_stale`'s per-job id list, which its
 * caller needs to tell live panel/agent connections a job silently moved. */
export async function requeueJobsForWorker(db: D1Database, workerId: string): Promise<string[]> {
  const { results } = await db
    .prepare(
      `UPDATE jobs
       SET status = 'queued', last_worker_id = ?, worker_id = NULL, progress = 0
       WHERE worker_id = ? AND status IN ('assigned', 'running')
       RETURNING id`
    )
    .bind(workerId, workerId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Cancel a job in place (`dispatch.cancel_job`'s DB write). Ownership is
 * released the same way `requeueJobsForWorker` releases it: `worker_id` set
 * NULL, `last_worker_id` set to whoever owned it (left untouched if nobody
 * did, via COALESCE, since a queued job's `last_worker_id` may already
 * carry a previous requeue's value that must survive). */
export async function updateJobCancelled(
  db: D1Database,
  jobId: string,
  reason: string,
  finishedAt: string,
  owningWorkerId: string | null
): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs
       SET status = 'cancelled', error = ?, finished_at = ?, worker_id = NULL,
           last_worker_id = COALESCE(?, last_worker_id)
       WHERE id = ?`
    )
    .bind(reason, finishedAt, owningWorkerId, jobId)
    .run();
}

export async function updateJobRunning(db: D1Database, jobId: string, startedAt: string): Promise<void> {
  await db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?").bind(startedAt, jobId).run();
}

export async function updateJobDone(
  db: D1Database,
  jobId: string,
  resultFiles: unknown[],
  finishedAt: string
): Promise<void> {
  await db
    .prepare("UPDATE jobs SET status = 'done', result_files = ?, finished_at = ? WHERE id = ?")
    .bind(JSON.stringify(resultFiles), finishedAt, jobId)
    .run();
}

export async function updateJobFailed(
  db: D1Database,
  jobId: string,
  error: string,
  finishedAt: string
): Promise<void> {
  await db
    .prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?")
    .bind(error, finishedAt, jobId)
    .run();
}

// ---------------------------------------------------------------------------
// Receipts

export interface Receipt {
  id: string;
  jobId: string;
  workerId: string;
  gpuSeconds: number;
  platformSig: string;
  workerSig: string | null;
  createdAt: string;
  kind: string;
  billable: boolean;
  basis: string;
}

interface ReceiptRow {
  id: string;
  job_id: string;
  worker_id: string;
  gpu_seconds: number;
  platform_sig: string;
  worker_sig: string | null;
  created_at: string;
  kind: string;
  billable: number;
  basis: string;
}

export function rowToReceipt(row: ReceiptRow): Receipt {
  return {
    id: row.id,
    jobId: row.job_id,
    workerId: row.worker_id,
    gpuSeconds: row.gpu_seconds,
    platformSig: row.platform_sig,
    workerSig: row.worker_sig,
    createdAt: row.created_at,
    kind: row.kind,
    billable: row.billable !== 0,
    basis: row.basis,
  };
}

export async function getReceiptsForJob(db: D1Database, jobId: string): Promise<Receipt[]> {
  const { results } = await db
    .prepare("SELECT * FROM receipts WHERE job_id = ?")
    .bind(jobId)
    .all<ReceiptRow>();
  return results.map(rowToReceipt);
}

// ---------------------------------------------------------------------------
// Register tokens / login attempts -- typed passthroughs for Task 4/5.

export interface RegisterToken {
  token: string;
  workerName: string;
  createdAt: string;
  used: boolean;
}

export interface LoginAttempt {
  id: number;
  at: string;
  ok: boolean;
}

export async function insertLoginAttempt(db: D1Database, at: string, ok: boolean): Promise<void> {
  await db.prepare("INSERT INTO login_attempts (at, ok) VALUES (?, ?)").bind(at, ok ? 1 : 0).run();
}

/** Rows at/after `cutoffTimestamp`, newest first -- exactly the shape
 * `core/auth.ts`'s `consecutiveFailures` expects (parity with auth.py's
 * `_consecutive_failures` query). */
export async function getRecentLoginAttempts(
  db: D1Database,
  cutoffTimestamp: string
): Promise<{ at: string; ok: boolean }[]> {
  const { results } = await db
    .prepare("SELECT at, ok FROM login_attempts WHERE at >= ? ORDER BY at DESC")
    .bind(cutoffTimestamp)
    .all<{ at: string; ok: number }>();
  return results.map((r) => ({ at: r.at, ok: r.ok !== 0 }));
}

/** Deletes attempt rows older than `beforeTimestamp`. Not a parity item --
 * auth.py's table grows unboundedly too -- but D1/Workers has no equivalent
 * of a long-lived server process to periodically vacuum it by hand, so the
 * login route prunes on every write. A generous retention window (see
 * caller) keeps this from ever affecting the 10-minute backoff logic. */
export async function pruneLoginAttempts(db: D1Database, beforeTimestamp: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE at < ?").bind(beforeTimestamp).run();
}

export async function insertRegisterToken(
  db: D1Database,
  token: string,
  workerName: string,
  createdAt: string
): Promise<void> {
  await db
    .prepare("INSERT INTO register_tokens (token, worker_name, created_at) VALUES (?, ?, ?)")
    .bind(token, workerName, createdAt)
    .run();
}

export async function getRegisterToken(db: D1Database, token: string): Promise<RegisterToken | null> {
  const row = await db
    .prepare("SELECT token, worker_name, created_at, used FROM register_tokens WHERE token = ?")
    .bind(token)
    .first<{ token: string; worker_name: string; created_at: string; used: number }>();
  if (!row) return null;
  return { token: row.token, workerName: row.worker_name, createdAt: row.created_at, used: row.used !== 0 };
}

/** Atomically claims an unused register token (`used` 0 -> 1). Returns
 * whether THIS call was the one that claimed it -- mirrors `register()`'s
 * `UPDATE ... WHERE used == False` rowcount check, which is what makes a
 * concurrent double-use of the same token resolve to exactly one winner. */
export async function claimRegisterToken(db: D1Database, token: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE register_tokens SET used = 1 WHERE token = ? AND used = 0")
    .bind(token)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

// ---------------------------------------------------------------------------
// Nonces (Task 5) -- D1-backed replay-protection store, see
// migrations/0002_nonces.sql and lib/verify_agent.ts.

/** Deletes expired nonce rows -- called opportunistically on every signed
 * request verification, mirroring `workers.py`'s `_prune_nonces`. */
export async function pruneNonces(db: D1Database, nowSeconds: number): Promise<void> {
  await db.prepare("DELETE FROM nonces WHERE expires_at <= ?").bind(nowSeconds).run();
}

/** Inserts a (worker_id, nonce) pair if not already present; returns false
 * (without writing) if it already exists -- the row surviving means it's
 * either still within its TTL or hasn't been pruned yet this call, either
 * way a replay. Doing this as a single conditional INSERT (rather than a
 * SELECT-then-INSERT) makes the replay check race-free under concurrent
 * requests carrying the same nonce. */
export async function tryInsertNonce(
  db: D1Database,
  workerId: string,
  nonce: string,
  expiresAt: number
): Promise<boolean> {
  const result = await db
    .prepare("INSERT INTO nonces (worker_id, nonce, expires_at) VALUES (?, ?, ?) ON CONFLICT(worker_id, nonce) DO NOTHING")
    .bind(workerId, nonce, expiresAt)
    .run();
  return (result.meta.changes ?? 0) === 1;
}
