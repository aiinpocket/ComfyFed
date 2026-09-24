/**
 * Typed D1 row access for the tables in `cloud/migrations/0001_initial.sql`
 * (ported from the former Python server's SQLAlchemy models in 2026-09; this
 * file is now the only implementation).
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
// to the fallback rather than throwing, matching the former Python server's
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
 * `datetime.isoformat()` renders the same value (the former Python `GET
 * /api/workers`: `w.last_seen.isoformat() if w.last_seen else None`) --
 * space separator becomes "T", and an all-zero fractional part is dropped
 * entirely (`datetime.isoformat()` omits microseconds when they are exactly
 * 0, which never happens in practice for a real heartbeat timestamp but is
 * matched here for completeness). */
export function sqliteTimestampToIsoformat(s: string): string {
  const iso = s.replace(" ", "T");
  return iso.endsWith(".000000") ? iso.slice(0, -7) : iso;
}

/** Parses a `toSqliteTimestamp`-shaped string (naive UTC) into epoch
 * milliseconds -- ports the `int(job.created_at.timestamp() * 1000)` half of
 * the former Python `_queue_entry` (`extra_data.create_time`). Small, local
 * parse rather than `new Date(sqliteTimestampToIsoformat(s))` because the
 * isoformat helper drops an all-zero fractional part, which `Date`'s parser
 * handles fine anyway -- this is just the more direct of the two. */
export function sqliteTimestampToEpochMs(s: string): number {
  const [datePart, timePart] = s.split(" ");
  const [hh, mm, rest] = (timePart ?? "00:00:00").split(":");
  const [ss, frac] = (rest ?? "00").split(".");
  const millis = (frac ?? "0").padEnd(6, "0").slice(0, 3);
  return new Date(`${datePart}T${hh}:${mm}:${ss}.${millis}Z`).getTime();
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

/** Upsert -- mirrors the former Python `_set_setting` (get-then-insert-or-update). */
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

/** Mirrors the former Python `_get_or_create_session_secret`: lazily generates and
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
 * (the former Python `register()`) and to hand out `platform_pubkey` in the
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
  /** Agent-side opt-in for manifest-based model auto-fetch (hello.auto_fetch
   * -- see `agentws._handle_hello` / `do/hub.ts`'s `handleHello`). Off by
   * default: workers keep sovereignty over unattended downloads. */
  autoFetch: boolean;
  /** Admin SOFT delete (`DELETE /api/workers/:id`). The row survives so the
   * billing ledger's receipts/jobs keep resolving, but the worker is gone
   * from every user-visible surface and can never reconnect -- see
   * `getAllWorkers`/`getWorkerById` (which filter it out) and
   * `db.Worker.deleted`'s Python docstring. */
  deleted: boolean;
  /** Phase 3.1 P2P: the agent's advertised peer-serving endpoint (e.g.
   * "http://192.168.1.5:8850"), set from `hello.peer_url` when the agent has
   * `peer_serve` enabled and a usable advertise host -- validated the same
   * way `agentws._parse_peer_url` does (http(s) scheme + host). Hello-only,
   * not refreshed on heartbeat; cleared on the stale/offline transition
   * (`markWorkerOffline`) -- see `db.Worker.peer_url`'s Python docstring. */
  peerUrl: string | null;
  /** Phase 3.4 §3.2：`hello.peer_lan_url`，同 NAT 的成員優先用的區網位址。 */
  peerLanUrl: string | null;
  /** Phase 3.4 §3.2：`peer_url` 的來源 —— natpmp/upnp/manual/lan/none。 */
  peerNat: string;
  /** Phase 3.4 §4.2：null = 未檢查、1 = `/peer/health` 回 204、0 = 不可連。 */
  peerReachable: number | null;
  peerCheckedAt: string | null;
  /** Phase 3.4 §2：`CF-Connecting-IP`，每次 hello 更新。 */
  remoteIp: string | null;
  /** Phase 3.3 §2.2: 相對全隊的速度係數，1.0 = 平均、2.0 = 兩倍快。 */
  speedIndex: number;
  /** Phase 3.3 §2.2: 最近一次被指派的 job 的 required_models；claim 時寫入。 */
  warmModels: string[];
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
  auto_fetch: number;
  deleted: number;
  peer_url: string | null;
  peer_lan_url: string | null;
  peer_nat: string;
  peer_reachable: number | null;
  peer_checked_at: string | null;
  remote_ip: string | null;
  speed_index: number;
  warm_models: string;
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
    autoFetch: row.auto_fetch !== 0,
    deleted: row.deleted !== 0,
    peerUrl: row.peer_url,
    peerLanUrl: row.peer_lan_url,
    peerNat: row.peer_nat,
    peerReachable: row.peer_reachable,
    peerCheckedAt: row.peer_checked_at,
    remoteIp: row.remote_ip,
    speedIndex: typeof row.speed_index === "number" ? row.speed_index : 1.0,
    warmModels: safeParse(row.warm_models, []),
  };
}

/** A LIVE worker by id -- soft-deleted rows read as `null`, exactly like an
 * unknown id (see `Worker.deleted`). Every caller is a live path (the Hub
 * DO's handshake and message handlers, `lib/verify_agent.ts`, the delete
 * route's own existence check), so this is the gate that makes a deleted
 * worker un-connectable and its already-issued certificate inert.
 * `getWorkersByIds` deliberately does NOT filter: it is the reports/payout
 * lookup, which must keep resolving a deleted worker's historical receipts. */
export async function getWorkerById(db: D1Database, id: string): Promise<Worker | null> {
  const row = await db
    .prepare("SELECT * FROM workers WHERE id = ? AND deleted = 0")
    .bind(id)
    .first<WorkerRow>();
  return row ? rowToWorker(row) : null;
}

/** A worker by id INCLUDING soft-deleted rows -- the ledger-side twin of
 * `getWorkerById`, for the same reason `getWorkersByIds` is unfiltered.
 * Its one caller is the Hub DO's `receipt_ack` handler: an ack already in
 * flight when the admin deleted the worker still has to be verified and
 * stored, or that receipt keeps `worker_sig = NULL` forever with no retry
 * path (the socket is closed moments later). Never use it on a live path --
 * authentication and dispatch must keep reading a deleted row as absent. */
export async function getWorkerByIdIncludingDeleted(db: D1Database, id: string): Promise<Worker | null> {
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

/** Every LIVE worker -- soft-deleted rows are excluded, so the console
 * listing, dispatch eligibility and `/metrics`'s `comfyfed_worker_up` all
 * drop a deleted worker at once (see `Worker.deleted`). */
export async function getAllWorkers(db: D1Database): Promise<Worker[]> {
  const { results } = await db.prepare("SELECT * FROM workers WHERE deleted = 0").all<WorkerRow>();
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

/** Marks a worker offline -- ports `dispatch.requeue_stale`'s per-worker
 * write. Phase 3.1: also clears `peer_url` in the same UPDATE -- a seeder
 * endpoint only means anything while the worker is actually reachable, and
 * `hub.ts`'s `handleHello` (mirroring agentws._handle_hello) is the only
 * place it gets set again, on the agent's next hello. Mirrors
 * `dispatch.requeue_stale`'s `worker.status = "offline"; worker.peer_url =
 * None` pair (same session, same commit). */
export async function markWorkerOffline(db: D1Database, workerId: string): Promise<void> {
  // Phase 3.4：`peer_reachable` 跟 `peer_url` 一起清 —— 可連性是那個位址的
  // 性質，位址一清結論就不成立（parity: dispatch.requeue_stale）。
  await db
    .prepare("UPDATE workers SET status = 'offline', peer_url = NULL, peer_reachable = NULL WHERE id = ?")
    .bind(workerId)
    .run();
}

/** Inserts a freshly-registered worker row (Task 5's `POST
 * /api/agent/register`), relying on the migration's column DEFAULTs for
 * everything the former Python `db.Worker(name=..., pubkey=...)` also leaves at
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

/** Mirrors the former Python `upload_object_info` DB write: only the hash
 * column changes, the gzipped bytes themselves go to R2 (see
 * `routes/workers.ts`). */
export async function updateWorkerObjectInfoHash(db: D1Database, workerId: string, hash: string): Promise<void> {
  await db.prepare("UPDATE workers SET object_info_hash = ? WHERE id = ?").bind(hash, workerId).run();
}

/** Applies a `hello` message's fields -- mirrors `agentws._handle_hello`'s
 * writes (`hardware`, `backend`, `torch_version`, `node_classes`,
 * `protocol`), plus `status = "online"` and `last_seen`, both of which
 * `_handle_hello` also sets unconditionally on a valid hello. */
export async function updateWorkerHello(
  db: D1Database,
  workerId: string,
  fields: {
    hardware: Record<string, unknown>;
    backend: string;
    torchVersion: string;
    nodeClasses: unknown[];
    protocol: number;
    lastSeen: string;
    /** Missing/non-bool degrades to false at the caller (see `do/hub.ts`'s
     * `handleHello`) -- an old or malformed hello must never be read as
     * consent to download. */
    autoFetch: boolean;
    /** 2026-09-23: the availability the hello itself reported ("busy" only
     * with a job id, else "online"/"paused"); defaults to "online" for the
     * callers that predate it. */
    status?: "online" | "busy" | "paused";
  }
): Promise<void> {
  await db
    .prepare(
      `UPDATE workers
       SET hardware = ?, backend = ?, torch_version = ?, node_classes = ?, protocol = ?,
           auto_fetch = ?, status = ?, last_seen = ?
       WHERE id = ?`
    )
    .bind(
      JSON.stringify(fields.hardware),
      fields.backend,
      fields.torchVersion,
      JSON.stringify(fields.nodeClasses),
      fields.protocol,
      fields.autoFetch ? 1 : 0,
      fields.status ?? "online",
      fields.lastSeen,
      workerId
    )
    .run();
}

/** Phase 3.1 P2P: writes the hello-reported peer advertisement -- mirrors
 * `agentws._handle_hello`'s `worker.peer_url = peer_url` write, folded into
 * `updateWorkerHello` at the call site (`do/hub.ts`'s `handleHello`) rather
 * than added as a field on that function's `fields` object, since it needs
 * its own null-clearing semantics (fully replaced from each hello, never
 * merged) that the other hello fields don't need to distinguish.
 *
 * hello 的 P2P 通告一次寫完（Phase 3.4）：`peer_url`/`peer_lan_url`/
 * `peer_nat` 全量取代，`remote_ip` 只在這次連線解析得到時覆寫。
 * `clearReachability`（fix round 1）只有在通告的 `peer_url` 真的換了時才由
 * 呼叫端帶 true —— 位址沒換的重連不該把已經驗過的結論丟掉。
 * Ports the former Python `_handle_hello` peer writes. */
export async function updateWorkerPeerAdvert(
  db: D1Database,
  workerId: string,
  fields: {
    peerUrl: string | null;
    peerLanUrl: string | null;
    peerNat: string;
    remoteIp: string | null;
    clearReachability: boolean;
  }
): Promise<void> {
  const columns = ["peer_url = ?", "peer_lan_url = ?", "peer_nat = ?"];
  const binds: unknown[] = [fields.peerUrl, fields.peerLanUrl, fields.peerNat];
  if (fields.remoteIp !== null) {
    columns.push("remote_ip = ?");
    binds.push(fields.remoteIp);
  }
  if (fields.clearReachability) {
    columns.push("peer_reachable = NULL", "peer_checked_at = NULL");
  }
  binds.push(workerId);
  await db
    .prepare(`UPDATE workers SET ${columns.join(", ")} WHERE id = ?`)
    .bind(...binds)
    .run();
}

/** Phase 3.4 §4.2：可連性檢查的結果。Ports the former Python `_record` 的寫入
 * 那一半。`reachable`/`checkedAt` 同時為 null = 回到「未檢查」（worker 不再
 * 通告 `peer_url`）。 */
export async function updateWorkerPeerReachable(
  db: D1Database,
  workerId: string,
  reachable: number | null,
  checkedAt: string | null
): Promise<void> {
  await db
    .prepare("UPDATE workers SET peer_reachable = ?, peer_checked_at = ? WHERE id = ?")
    .bind(reachable, checkedAt, workerId)
    .run();
}

/** 目前存著的可連性結論（1/0/NULL），或 worker 不存在時 null -- Ports
 * the former Python `_record` 回傳 previous 的那一半，給「只有結論變了才推
 * peer_status」的比較用。 */
export async function getWorkerPeerReachable(db: D1Database, workerId: string): Promise<number | null> {
  const row = await db
    .prepare("SELECT peer_reachable FROM workers WHERE id = ?")
    .bind(workerId)
    .first<{ peer_reachable: number | null }>();
  return row?.peer_reachable ?? null;
}

/** Applies a `heartbeat` message's worker-row writes -- mirrors
 * `agentws._handle_heartbeat`'s `worker.last_seen`/`worker.status`/
 * `worker.dynamic` writes. `status` is precomputed by the caller (idle ->
 * "online", busy -> "busy", anything else -> the worker's own current
 * status, left untouched -- matching Python's `if/elif` with no `else`). */
export async function updateWorkerHeartbeat(
  db: D1Database,
  workerId: string,
  fields: { status: string; dynamic: Record<string, unknown>; lastSeen: string }
): Promise<void> {
  await db
    .prepare("UPDATE workers SET status = ?, dynamic = ?, last_seen = ? WHERE id = ?")
    .bind(fields.status, JSON.stringify(fields.dynamic), fields.lastSeen, workerId)
    .run();
}

/** Mirrors `agentws._handle_inventory`'s `worker.model_inventory` write. */
export async function updateWorkerModelInventory(db: D1Database, workerId: string, models: unknown[]): Promise<void> {
  await db.prepare("UPDATE workers SET model_inventory = ? WHERE id = ?").bind(JSON.stringify(models), workerId).run();
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

/** Soft-deletes a worker, returning true only if a LIVE row was flagged --
 * `deleted = 0` in the WHERE makes a second delete a no-op, which the route
 * turns into the same 404 an unknown id gets. `disabled` is set in the same
 * statement as belt and braces: every pre-existing gate already refuses a
 * disabled worker, so nothing can serve a deleted one even on a path that
 * predates this column. Mirrors the former Python `delete_worker`. */
export async function setWorkerDeleted(db: D1Database, workerId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE workers SET deleted = 1, disabled = 1 WHERE id = ? AND deleted = 0")
    .bind(workerId)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

/** Typed seam for the Hub DO's live per-worker state, wired for real as of
 * Task 6: asks the singleton Hub Durable Object (`idFromName("hub")`) for
 * whatever it has cached in memory for `workerId`'s live connection (its
 * most recent heartbeat `dynamic` payload) via `GET /internal/dynamic`.
 * Returns `null` when the worker isn't currently connected (including right
 * after a hibernation eviction, before its ephemeral state is rebuilt) or on
 * any DO-call failure -- callers (`GET /api/workers`) already fall back to
 * the persisted `workers.dynamic` column in that case, exactly like
 * the former Python server did (there was no live layer in the Python source
 * either -- `dynamic` there is itself just a JSON column written by
 * whatever last touched the worker over its agent WebSocket); this only
 * shaves the read-after-write lag a busy heartbeat cadence would otherwise
 * have against D1. */
export async function getDynamic(
  hub: DurableObjectNamespace,
  workerId: string
): Promise<Record<string, unknown> | null> {
  try {
    const stub = hub.get(hub.idFromName("hub"));
    const res = await stub.fetch(`http://hub.internal/internal/dynamic?worker_id=${encodeURIComponent(workerId)}`);
    if (!res.ok) return null;
    const data = await res.json<{ dynamic: Record<string, unknown> | null }>();
    return data.dynamic ?? null;
  } catch {
    return null;
  }
}

export interface FetchProgress {
  stage: string;
  fetch_pct: number | null;
  fetch_model: string | null;
}

/** Typed seam for the Hub DO's transient model-auto-fetch progress map --
 * mirrors `getDynamic`'s shape (a GET to the singleton Hub DO's
 * `/internal/*` surface). Ports `agentws.get_fetch_progress`'s read side;
 * see `do/hub.ts`'s `fetchProgress` field for why this is in-memory,
 * per-DO-instance state rather than a D1/Job column. Returns null outside
 * the fetch phase or on any DO-call failure. */
export async function getFetchProgress(
  hub: DurableObjectNamespace,
  jobId: string
): Promise<FetchProgress | null> {
  try {
    const stub = hub.get(hub.idFromName("hub"));
    const res = await stub.fetch(
      `http://hub.internal/internal/fetch_progress?job_id=${encodeURIComponent(jobId)}`
    );
    if (!res.ok) return null;
    const data = await res.json<{ progress: FetchProgress | null }>();
    return data.progress ?? null;
  } catch {
    return null;
  }
}

/** 2026-09-21 分頁：一頁 job 的 fetch 進度一次問完（`GET /api/jobs?page=`
 * 每一列各打一次 `getFetchProgress` 時，一頁 25 筆就是 25 次 DO 往返，這是
 * 任務列表一多就卡住的主因之一）。回 `{job_id -> progress}`；沒在 fetch 階段
 * 的 id 不會出現。空輸入不打 DO；DO 呼叫失敗一律當成「沒有進度」。 */
export async function getFetchProgressBatch(
  hub: DurableObjectNamespace,
  jobIds: string[]
): Promise<Map<string, FetchProgress>> {
  const out = new Map<string, FetchProgress>();
  if (jobIds.length === 0) return out;
  try {
    const stub = hub.get(hub.idFromName("hub"));
    const res = await stub.fetch("http://hub.internal/internal/fetch_progress_batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_ids: jobIds }),
    });
    if (!res.ok) return out;
    const data = await res.json<{ progress?: Record<string, FetchProgress> }>();
    for (const [id, p] of Object.entries(data.progress ?? {})) out.set(id, p);
  } catch {
    // fall through: no progress
  }
  return out;
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
  /** Phase 3.0: the submitting session's uid (`SessionUser.uid`), stamped by
   * both `POST /api/jobs` (console) and `POST /comfy/api/prompt` (panel) --
   * mirrors `db.Job.user_id`. `null` for a pre-Phase-3.0 job that predates
   * the column (migration 0006 backfills it to the migrated admin user where
   * possible, but a brand-new install with no such setting leaves it null),
   * or for a row a test inserts directly without setting it. */
  userId: string | null;
  /** 2026-09-20 檔案頁 §2: the job's human-readable name -- what the console's
   * Files page uses as the top-level folder. `null` = no name (a row older
   * than migration 0014, a workflow with no `Save*` node to derive one from,
   * or a `kind=model_fetch` job, which never gets one); the console falls
   * back to the job id's first 8 characters. Mirrors `db.Job.label`. */
  label: string | null;
  /** Phase 3.3 §2.1: `assess.signature` 的工作指紋，送件時寫入；`null` 是
   * 舊資料列（`stats.backfillIfNeeded` 重放收據時會補寫回去）。 */
  signature: string | null;
  /** Phase 3.3 §2.2: claim 當下的選擇依據（predicted_seconds / basis /
   * load_seconds / fetch_seconds / candidates），供 console 顯示。 */
  dispatchInfo: Record<string, unknown>;
  /** Phase 3.3 §3.4: 被拆的父 job id（子 job 才有）。 */
  parentId: string | null;
  splitIndex: number | null;
  /** 父 job 的子數；0 = 不是父 job，一律當普通 job 處理。 */
  splitCount: number;
  /** `{"source_node_id": string, "batch_size": number}` 的 JSON 原文，
   * `null` = 不可拆。刻意保留字串而不是解析後的物件：只有 split.ts 需要
   * 它，rowToJob 不該替每一列付這個解析成本。 */
  splitPlan: string | null;
  /** 2026-09-19 model_fetch (spec §4): `"prompt"`（既有一切）或
   * `"model_fetch"`（面板下載鈕建的純下載單，`workflowJson === "{}"`）--
   * mirrors `db.Job.kind`. Migration 0011 declares the DEFAULT, so a row
   * inserted before it (or by any INSERT that omits the column) reads back
   * as `"prompt"`. */
  kind: string;
  /** 2026-09-19 model_fetch: 建單當下簽好的 manifest 項目 JSON 原文，只有
   * `kind === "model_fetch"` 的單非 null。刻意保留字串而不是解析後的物件：
   * 只有 `core/model_fetch.ts` 與 dispatch tick 的合併需要它，`rowToJob`
   * 不該替每一列付這個解析成本（同 `splitPlan` 的理由）。 */
  fetchEntry: string | null;
  /** 2026-09-19 job-retry §4：`{worker_id: failures}` 的 JSON 原文，每次那台
   * worker 對這張 job 回報 `job_failed`（而且 transition 真的套用了）就 +1。
   * 同一台達 `retry.MAX_FAILURES_PER_WORKER_PER_JOB` 就對這張 job 出局；全部
   * 加總達 `retry.MAX_JOB_ATTEMPTS` 就終局失敗。`cancelled`（管理員取消）與
   * `requeueStale`（worker 斷線）不計入 -- 那兩者都不是「這台跑不動這個工作」
   * 的證據。刻意保留字串（同 `splitPlan`/`fetchEntry`）：只有 retry 路徑要它，
   * 解析走 `retry.attemptsDict` 的防禦式版本。Mirrors `db.Job.attempts`. */
  attempts: string;
  /** 2026-09-19 job-retry §4：這張 job 被非終局失敗送回 `queued` 的次數。
   * `attempts` 的總和是「失敗幾次」，這個是「重排隊幾次」，終局那一次不算，
   * 所以兩者差 1。Mirrors `db.Job.retry_count`. */
  retryCount: number;
  /** 2026-09-24 配額納入 job 位元組（migration 0017）：這張 job 在
   * `artifacts/<job_id>/` 下的成品總位元組。`null` = 還不知道（0017 之前的
   * 列，等 `GET /api/me/artifacts` 列到它時 lazy backfill），0 = 確定是空的。
   * 成品上傳／確認時加、刪除時減；`userJobBytes` 把它加進配額。
   * Mirrors `db.Job.artifact_bytes`. */
  artifactBytes: number | null;
  /** 2026-09-24 配額納入 job 位元組：`job_inputs/<job_id>/` 下的輸入資產總位
   * 元組，建單落地資產後一次寫定（輸入從不個別增刪）。`null` 同上。
   * Mirrors `db.Job.input_bytes`. */
  inputBytes: number | null;
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
  user_id: string | null;
  label: string | null;
  signature: string | null;
  dispatch_info: string;
  parent_id: string | null;
  split_index: number | null;
  split_count: number;
  split_plan: string | null;
  kind: string;
  fetch_entry: string | null;
  attempts: string;
  retry_count: number;
  artifact_bytes: number | null;
  input_bytes: number | null;
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
    userId: row.user_id,
    // Migration 0014 adds the column without a DEFAULT, so an unmigrated
    // snapshot (or a hand-written INSERT that omits it) reads back
    // undefined -- normalise to null, the one representation of "no name".
    label: row.label ?? null,
    signature: row.signature,
    dispatchInfo: safeParse(row.dispatch_info, {}),
    parentId: row.parent_id,
    splitIndex: row.split_index,
    splitCount: row.split_count ?? 0,
    splitPlan: row.split_plan,
    // Migration 0011 declares `kind TEXT NOT NULL DEFAULT 'prompt'`, but a
    // test that inserts through a hand-written INSERT on an older schema
    // snapshot could still read back undefined -- degrade to "prompt", the
    // same thing Python's `job.kind or "prompt"` does at every read site.
    kind: row.kind || "prompt",
    fetchEntry: row.fetch_entry ?? null,
    // Migration 0012 declares both DEFAULTs; degrade the same defensive way
    // `kind` does for a row read back off an older schema snapshot (and
    // because `retry.attemptsDict` treats anything unparseable as "{}"
    // anyway, an empty object here is exactly the "never failed" reading).
    attempts: row.attempts || "{}",
    retryCount: row.retry_count ?? 0,
    // Migration 0017 adds both without a DEFAULT and without backfill; an
    // older snapshot reads back undefined -- normalise to null, the one
    // representation of "not yet known".
    artifactBytes: row.artifact_bytes ?? null,
    inputBytes: row.input_bytes ?? null,
  };
}

export async function getJobById(db: D1Database, id: string): Promise<Job | null> {
  const row = await db.prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<JobRow>();
  return row ? rowToJob(row) : null;
}

export interface NewJob {
  id: string;
  workflowJson: string;
  requirements: Record<string, unknown>;
  requiredNodes: string[];
  requiredModels: string[];
  estVramGb: number | null;
  inputAssets: string[];
  origin: string;
  createdAt: string;
  /** Phase 3.0: the submitting session's uid -- omitted (or `null`) for an
   * agent/system-originated insert with no session behind it (none exist
   * today; kept optional so a future non-session caller doesn't need a fake
   * value). */
  userId?: string | null;
  /** 2026-09-20 檔案頁 §2: 這張單的名稱，呼叫端已經 `normalizeLabel` 過
   * （或是 `deriveLabel` 推出來的）。省略／null = 沒有名稱。 */
  label?: string | null;
  /** Phase 3.3 §2.1: 送件時算好的工作指紋。 */
  signature?: string | null;
  /** Phase 3.3 §3.2: 送件時判定出的拆分計畫 JSON（`split.planForJob`），
   * 不可拆時 null/省略。 */
  splitPlan?: string | null;
  /** 2026-09-19 model_fetch (spec §4): `"model_fetch"` 只有
   * `core/model_fetch.ts` 的建單路徑會傳；省略 = `"prompt"`，與這個欄位
   * 存在之前的每個呼叫端一模一樣。 */
  kind?: string | null;
  /** 2026-09-19 model_fetch: 建單當下簽好的 manifest 項目 JSON。 */
  fetchEntry?: string | null;
}

/** Inserts a freshly-assessed queued job row -- mirrors `jobs.create_job`'s
 * `db.Job(...)` insert. Relies on the migration's column DEFAULTs for
 * everything Python's ORM also leaves at its model default (status='queued',
 * progress=0, result_files/result_hashes='{}'/'[]', panel_hidden=0). */
export async function insertJob(db: D1Database, job: NewJob): Promise<void> {
  await db
    .prepare(
      `INSERT INTO jobs (id, workflow_json, requirements, required_nodes, required_models, est_vram_gb,
                          input_assets, origin, created_at, user_id, label, signature, split_plan, kind, fetch_entry)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      job.id,
      job.workflowJson,
      JSON.stringify(job.requirements),
      JSON.stringify(job.requiredNodes),
      JSON.stringify(job.requiredModels),
      job.estVramGb,
      JSON.stringify(job.inputAssets),
      job.origin,
      job.createdAt,
      job.userId ?? null,
      job.label ?? null,
      job.signature ?? null,
      job.splitPlan ?? null,
      job.kind ?? "prompt",
      job.fetchEntry ?? null
    )
    .run();
}

// --- 2026-09-19 model_fetch (spec §5.1/§7) --------------------------------

/** Every queued `kind=model_fetch` job -- the dispatch tick's merge source
 * for the self-contained signed entry each one carries (ports the
 * `status == "queued", kind == "model_fetch"` query inside the former Python
 * `dispatch_tick`). */
export async function getQueuedModelFetchJobs(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'queued' AND kind = 'model_fetch' ORDER BY created_at ASC, id ASC"
    )
    .all<JobRow>();
  return results.map(rowToJob);
}

/** The oldest still-live `model_fetch` job whose `required_models` is exactly
 * `[name]` -- §5.1 row 3's reuse lookup, ports the former Python
 * `_active_fetch_job_id`. "Still live" is this stack's own status vocabulary
 * (`queued`/`assigned`/`running`; the spec writes the middle one as
 * `dispatched`). The `required_models` comparison is done in JS, not SQL, for
 * the same reason Python does it in Python: the column is a JSON text blob
 * and `'["a"]' = ?` would depend on the writer's exact separator spelling.
 *
 * `ORDER BY created_at ASC, id ASC` rather than Python's `created_at` alone:
 * D1 timestamps are second-resolution, so two jobs created in the same second
 * need a tiebreak for this lookup to be deterministic -- the same tiebreak
 * every other ordered jobs query in this file already uses. */
export async function findActiveModelFetchJob(db: D1Database, name: string): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT * FROM jobs WHERE kind = 'model_fetch' AND status IN ('queued', 'assigned', 'running')
       ORDER BY created_at ASC, id ASC`
    )
    .all<JobRow>();
  for (const row of results) {
    const required = safeParse<unknown>(row.required_models, []);
    if (Array.isArray(required) && required.length === 1 && required[0] === name) return row.id;
  }
  return null;
}

// --- Phase 3.3 §3.3-§3.4: 子 job ------------------------------------------

/** `parentId` 的子 job，依 `split_index` 排序 -- ports `split.children_of`. */
export async function getChildJobs(db: D1Database, parentId: string): Promise<Job[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE parent_id = ? ORDER BY split_index ASC")
    .bind(parentId)
    .all<JobRow>();
  return results.map(rowToJob);
}

export interface NewChildJob {
  id: string;
  parentId: string;
  splitIndex: number;
  workflowJson: string;
  createdAt: string;
  signature: string | null;
  requiredNodes: string[];
  requiredModels: string[];
  estVramGb: number | null;
  requirements: Record<string, unknown>;
  inputAssets: unknown[];
  origin: string;
  userId: string | null;
  /** 2026-09-20 檔案頁 §3.1：父 job 沒有 `result_files`，成品全在子 job 底下，
   * 所以檔案頁列的是子 job —— 名稱得跟著複製過來，否則同一次送件的產出會散成
   * k 個「未命名」資料夾。 */
  label: string | null;
}

/** The conditional UPDATE that marks a parent as split, as a STATEMENT
 * rather than an executed write, so `split.createChildren` can put it and
 * every child insert into one `db.batch([...])` -- D1 has no multi-statement
 * transaction seam other than `batch`, and spec §5 requires that a failure
 * part-way through leaves the parent untouched rather than half-split.
 *
 * The `WHERE status = 'queued' AND split_count = 0` guard is the same atomic
 * shape as `claimJob`'s: a parent someone else already split or claimed
 * changes 0 rows, and the batch's child inserts (guarded to match, see
 * `childJobInsertStatement`) then insert nothing either. */
export function markJobSplitStatement(db: D1Database, jobId: string, splitCount: number): D1PreparedStatement {
  return db
    .prepare("UPDATE jobs SET split_count = ? WHERE id = ? AND status = 'queued' AND split_count = 0")
    .bind(splitCount, jobId);
}

/** One child insert, as a STATEMENT for the same `db.batch` as
 * `markJobSplitStatement` (see there for why).
 *
 * Every column is inherited from the parent; only the workflow, `parent_id`
 * and `split_index` differ. `created_at` is deliberately the PARENT's, so a
 * child keeps the family's place in the `created_at ASC` dispatch queue
 * instead of jumping to the back of it.
 *
 * `INSERT ... SELECT ... WHERE` rather than `VALUES` so the insert carries
 * the same guard the parent UPDATE did: it only fires when the parent now
 * reads `status='queued' AND split_count = expectedSplitCount` (i.e. the
 * UPDATE earlier in this batch is the one that set it) AND this split_index
 * is not already taken. Without that pair, a parent claimed between the
 * caller's read and this batch would gain orphan children while staying
 * dispatchable itself -- the one way this feature could run a batch twice. */
export function childJobInsertStatement(
  db: D1Database,
  child: NewChildJob,
  expectedSplitCount: number
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, created_at, signature, required_nodes, required_models,
                          est_vram_gb, requirements, input_assets, origin, user_id, label, parent_id, split_index)
       SELECT ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM jobs WHERE id = ? AND status = 'queued' AND split_count = ?)
         AND NOT EXISTS (SELECT 1 FROM jobs WHERE parent_id = ? AND split_index = ?)`
    )
    .bind(
      child.id,
      child.workflowJson,
      child.createdAt,
      child.signature,
      JSON.stringify(child.requiredNodes),
      JSON.stringify(child.requiredModels),
      child.estVramGb,
      JSON.stringify(child.requirements),
      JSON.stringify(child.inputAssets),
      child.origin,
      child.userId,
      child.label,
      child.parentId,
      child.splitIndex,
      child.parentId,
      expectedSplitCount,
      child.parentId,
      child.splitIndex
    );
}

/** Phase 3.3 §3.4: 把 `refreshParent` 推導出來的欄位一次寫回父 job。 */
export async function updateParentDerived(
  db: D1Database,
  jobId: string,
  patch: {
    status: string;
    progress: number;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
    workerId: string | null;
  }
): Promise<void> {
  await db
    .prepare(
      "UPDATE jobs SET status = ?, progress = ?, started_at = ?, finished_at = ?, error = ?, worker_id = ? WHERE id = ?"
    )
    .bind(patch.status, patch.progress, patch.startedAt, patch.finishedAt, patch.error, patch.workerId, jobId)
    .run();
}

/** All jobs, oldest first, optionally filtered to a set of statuses and/or
 * (Phase 3.0) a single owning user -- mirrors `jobs.list_jobs`'s
 * `?status=a,b,c` query-param filter plus its non-admin `user_id == uid`
 * scope. `opts.userId` omitted means unscoped (every job, any owner) --
 * callers needing "this user's jobs" always pass it explicitly rather than
 * relying on a default. */
export async function listJobs(
  db: D1Database,
  statuses?: string[],
  opts: { userId?: string; includeChildren?: boolean } = {}
): Promise<Job[]> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  // Phase 3.3 §3.7: parents and ordinary jobs only unless the caller opts in
  // -- a child is an implementation detail of the split, and listing it
  // alongside its parent would show one submission k+1 times.
  if (!opts.includeChildren) clauses.push("parent_id IS NULL");
  if (statuses && statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    binds.push(...statuses);
  }
  if (opts.userId !== undefined) {
    clauses.push("user_id = ?");
    binds.push(opts.userId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const { results } = await db
    .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at ASC`)
    .bind(...binds)
    .all<JobRow>();
  return results.map(rowToJob);
}

/** 2026-09-21 分頁版的 `listJobs`：同一組過濾條件，但只取第 `page` 頁
 * （1 起算）、每頁 `limit` 筆，**最新在前**（`created_at DESC, id ASC` —— id
 * 只是替同一秒建立的單定一個穩定序）。另回 `total` 給前端畫頁碼。兩個查詢
 * （COUNT 與 SELECT）走同一段 WHERE，靠 migration 0016 的
 * `(user_id, created_at)`／`(status, created_at)` 索引。 */
export async function listJobsPage(
  db: D1Database,
  statuses: string[] | undefined,
  opts: { userId?: string; includeChildren?: boolean; page: number; limit: number }
): Promise<{ jobs: Job[]; total: number }> {
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (!opts.includeChildren) clauses.push("parent_id IS NULL");
  if (statuses && statuses.length > 0) {
    clauses.push(`status IN (${statuses.map(() => "?").join(",")})`);
    binds.push(...statuses);
  }
  if (opts.userId !== undefined) {
    clauses.push("user_id = ?");
    binds.push(opts.userId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const offset = (opts.page - 1) * opts.limit;
  const [countRow, { results }] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`)
      .bind(...binds)
      .first<{ n: number }>(),
    db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`)
      .bind(...binds, opts.limit, offset)
      .all<JobRow>(),
  ]);
  return { jobs: results.map(rowToJob), total: countRow?.n ?? 0 };
}

/** `{id -> username}` for a set of user ids -- backs `GET /api/jobs`'s admin
 * view (mirrors the former Python `list_jobs` in-memory join: one query over the
 * distinct `user_id`s a job page references, rather than an N+1 lookup per
 * row). Empty input short-circuits without a query (an empty `IN ()` is
 * invalid SQL). */
export async function getUsernamesByIds(db: D1Database, ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT id, username FROM users WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<{ id: string; username: string }>();
  return new Map(results.map((r) => [r.id, r.username]));
}

/** Requeues a failed job for retry -- mirrors `jobs.retry_job`'s row reset
 * (status, worker_id, error, progress, started_at, finished_at). Returns
 * whether the row was still `failed` at the moment of the UPDATE (the same
 * atomic-guard shape as `claimJob`), so a caller can't retry a job that
 * raced into a different terminal state between its own read and this
 * write.
 *
 * Phase 3.3 §3.6: the retry also clears `split_count`/`split_plan`, so a
 * previously-split parent re-runs whole on one worker instead of spawning a
 * second generation of children -- and every parent-derived function then
 * treats it as a plain job (they all short-circuit on `split_count === 0`).
 * The old children are left exactly as they are: terminal rows, kept as
 * history.
 *
 * Final-review I2: `AND parent_id IS NULL` -- a split child is never
 * retryable on its own (the route rejects it with 409 `jobs.not_retryable`
 * first; this is the same belt-and-braces atomic guard as the status check).
 * Final-review M5: `dispatch_info` resets to `{}` -- last attempt's estimate
 * says nothing about this one, and leaving it would show the console a stale
 * prediction. Mirrors `jobs.retry_job`. */
export async function retryFailedJob(db: D1Database, jobId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE jobs
       SET status = 'queued', worker_id = NULL, error = NULL, progress = 0,
           started_at = NULL, finished_at = NULL,
           split_count = 0, split_plan = NULL, dispatch_info = '{}'
       WHERE id = ? AND status = 'failed' AND parent_id IS NULL`
    )
    .bind(jobId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** 派工專用的 queued 清單：排除 `split_count > 0` 的父 job -- 它的工作由子
 * job 執行，父 job 本身永遠不該被指派給 worker（Phase 3.3 §2.5 第 2 步）。
 *
 * Final-review C1：LIMIT `QUEUED_DISPATCH_SCAN_LIMIT`。一輪選取最多用到
 * 2×`MAX_JOBS_PER_TICK` = 128 件（head 一個 `limit` + 餓死補頁一個 `limit`），
 * 1024 是故意寬鬆的常數：餓死掃描還看得到 head 後面一大段舊 job，又不
 * 至於把幾萬件的佇列整張讀進 DO 的記憶體。排序一律 `created_at, id`，
 * 所以 LIMIT 切掉的永遠是最新的那一端。與原 Python 版的 `_QUEUED_SCAN_LIMIT` 同值。 */
export const QUEUED_DISPATCH_SCAN_LIMIT = 1024;

export async function getQueuedJobsForDispatch(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM jobs WHERE status = 'queued' AND split_count = 0 ORDER BY created_at ASC, id ASC LIMIT ?"
    )
    .bind(QUEUED_DISPATCH_SCAN_LIMIT)
    .all<JobRow>();
  return results.map(rowToJob);
}

/** Atomic claim: only flips `queued` -> `assigned` (and sets `worker_id`, plus
 * Phase 3.3's `dispatch_info` when given) if the job is still queued at the
 * moment the UPDATE runs. Returns whether the claim succeeded
 * (`meta.changes === 1`), mirroring `dispatch.assign_jobs`'s
 * `UPDATE ... WHERE status == "queued"` rowcount check -- a job someone else
 * claimed a moment ago is reported as a miss rather than double-assigned. */
export async function claimJob(
  db: D1Database,
  jobId: string,
  workerId: string,
  dispatchInfo?: string
): Promise<boolean> {
  const result =
    dispatchInfo === undefined
      ? await db
          .prepare("UPDATE jobs SET status = 'assigned', worker_id = ? WHERE id = ? AND status = 'queued'")
          .bind(workerId, jobId)
          .run()
      : await db
          .prepare(
            "UPDATE jobs SET status = 'assigned', worker_id = ?, dispatch_info = ? WHERE id = ? AND status = 'queued'"
          )
          .bind(workerId, dispatchInfo, jobId)
          .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Phase 3.3 §2.2: 記住這台 worker 最近一次被指派的 job 的 required_models，
 * 供下一輪的熱快取親和使用。claim 成功當下就寫，不等 job 完成。 */
export async function setWorkerWarmModels(db: D1Database, workerId: string, models: string[]): Promise<void> {
  await db.prepare("UPDATE workers SET warm_models = ? WHERE id = ?").bind(JSON.stringify(models), workerId).run();
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

/** 2026-09-23 cross-backend §3.1: the in-flight jobs of a set of busy
 * workers in one round trip -- ports the `worker_id IN (...) AND status IN
 * (...)` query in the former Python `_busy_worker_candidates`. */
export async function getJobsForWorkersInStatuses(
  db: D1Database,
  workerIds: string[],
  statuses: string[]
): Promise<Job[]> {
  if (workerIds.length === 0 || statuses.length === 0) return [];
  const workerPlaceholders = workerIds.map(() => "?").join(",");
  const statusPlaceholders = statuses.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM jobs WHERE worker_id IN (${workerPlaceholders}) AND status IN (${statusPlaceholders})`)
    .bind(...workerIds, ...statuses)
    .all<JobRow>();
  return results.map(rowToJob);
}

/** 2026-09-23 cross-backend §3.4: rewrite a still-queued job's
 * `dispatch_info` (the hold reason, or `{}` to clear a stale one). The
 * `status = 'queued'` guard mirrors the former Python `_record_holds` UPDATE: a
 * job claimed by a concurrent tick keeps the claim's own info. */
export async function updateQueuedJobDispatchInfo(db: D1Database, jobId: string, infoJson: string): Promise<void> {
  await db
    .prepare("UPDATE jobs SET dispatch_info = ? WHERE id = ? AND status = 'queued'")
    .bind(infoJson, jobId)
    .run();
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

/** 2026-09-20 檔案頁 §3.2：把刪過成品之後**剩下的**檔名寫回 `result_files`。
 *
 * 只動這一欄，刻意不碰 `result_hashes`、收據與 job 列本身：成品的位元組是
 * 使用者自己的儲存空間，想收回就收回，但帳本是聯邦拿來結算的依據 —— 使用者
 * 不該能靠刪掉輸出，把「某台 worker 確實替我跑過這件事」的證據一併抹掉。
 * Ports the `job.result_files = json.dumps(remaining)` write inside the former Python
 * two delete routes. */
export async function updateJobResultFiles(db: D1Database, jobId: string, files: string[]): Promise<void> {
  await db
    .prepare("UPDATE jobs SET result_files = ? WHERE id = ?")
    .bind(JSON.stringify(files), jobId)
    .run();
}

/** 2026-09-24 配額納入 job 位元組：把 `delta`（可為負）加到這張 job 的
 * `artifact_bytes` 上，NULL 當 0 起算，結果夾在 0 以上。
 *
 * 用 `MAX(0, ...)` 而不是信任呼叫端：一張 0017 之前的單（`artifact_bytes` 是
 * NULL，實際上 R2 有東西）被刪掉一個成品時，減出來會是負數，而負數的意思
 * 只會是「我們不知道」，不是「使用者倒欠空間」。No-op if the job no longer
 * exists. Cloud-only counter (the Python stack walks `artifacts/<job_id>/` on disk instead -- see `limits.job_bytes`). */
export async function addJobArtifactBytes(db: D1Database, jobId: string, delta: number): Promise<void> {
  await db
    .prepare("UPDATE jobs SET artifact_bytes = MAX(0, COALESCE(artifact_bytes, 0) + ?) WHERE id = ?")
    .bind(Math.trunc(delta), jobId)
    .run();
}

/** 2026-09-24：把 `artifact_bytes` 寫成一個已知的絕對值 —— 檔案頁的 lazy
 * backfill（R2 list 加總）與「整批刪除」（0）用。Cloud-only counter; Python computes the same figure from disk (`limits.job_bytes`). */
export async function setJobArtifactBytes(db: D1Database, jobId: string, bytes: number): Promise<void> {
  await db
    .prepare("UPDATE jobs SET artifact_bytes = ? WHERE id = ?")
    .bind(Math.max(0, Math.trunc(bytes)), jobId)
    .run();
}

/** 2026-09-24：建單落地資產後寫定 `input_bytes`。Cloud-only counter; Python computes it from `job_inputs/<job_id>/` on disk (`limits.job_bytes`). */
export async function setJobInputBytes(db: D1Database, jobId: string, bytes: number): Promise<void> {
  await db
    .prepare("UPDATE jobs SET input_bytes = ? WHERE id = ?")
    .bind(Math.max(0, Math.trunc(bytes)), jobId)
    .run();
}

/** 2026-09-24：`userId` 名下所有 job 的成品＋輸入位元組總和 —— 配額的第三
 * 塊（lib/limits.ts `usageBytes`）。NULL 的計數器算 0：還沒回填的舊單在被
 * 檔案頁看到之前就是不計入，寧可少算也不要為了它逐張去 list R2。
 * 一次 SUM，走 0016 的 `ix_jobs_user_created`。Ports `limits.job_bytes` (disk walk there, SUM here). */
export async function userJobBytes(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(artifact_bytes, 0)), 0) + COALESCE(SUM(COALESCE(input_bytes, 0)), 0) AS n
       FROM jobs WHERE user_id = ?`
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** 2026-09-20 檔案頁 §3.1：呼叫者自己、已完成、而且真的有成品的 prompt 單，
 * 新到舊。
 *
 * `kind = 'prompt' OR kind IS NULL`：migration 0011 宣告了 `DEFAULT 'prompt'`，
 * 但這張表沒有 NOT NULL 約束，任何在那之前寫進去（或明寫 NULL）的列讀回來
 * 都是 NULL，而 NULL 在這裡的意思就是 prompt。Python 那側的 `or_(kind ==
 * 'prompt', kind.is_(None))` 寫成一模一樣的條件，parity 才不會只差在這裡。
 *
 * `result_files != '[]'` 擋掉「跑完但什麼都沒產出」與被刪光的單；拆分的父 job
 * 本來就沒有 `result_files`，所以自然落選，成品由繼承了 `user_id` 與 `label`
 * 的子 job 列出。`id ASC` 只是替同一秒建立的兩張單定一個穩定序（D1 的
 * `created_at` 是秒精度字串）。 */
export async function listDoneJobsWithResultsForUser(db: D1Database, userId: string): Promise<Job[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM jobs
       WHERE status = 'done' AND user_id = ? AND (kind = 'prompt' OR kind IS NULL) AND result_files != '[]'
       ORDER BY created_at DESC, id ASC`
    )
    .bind(userId)
    .all<JobRow>();
  return results.map(rowToJob);
}

/** 2026-09-21 分頁版的 `listDoneJobsWithResultsForUser`：同一個 WHERE，只取
 * 第 `page` 頁（1 起算）的 `limit` 張單，另回符合條件的單數 `total`。以
 * **job** 為分頁單位而不是檔案，這樣同一張單的成品永遠落在同一頁。
 * `userId` 給 null（管理視角 `?scope=all`）就是全平台每個人的單。 */
export async function listDoneJobsWithResultsForUserPage(
  db: D1Database,
  userId: string | null,
  opts: { page: number; limit: number }
): Promise<{ jobs: Job[]; total: number }> {
  const where = `WHERE status = 'done' AND ${userId === null ? "user_id IS NOT NULL" : "user_id = ?"} AND (kind = 'prompt' OR kind IS NULL) AND result_files != '[]'`;
  const binds = userId === null ? [] : [userId];
  const offset = (opts.page - 1) * opts.limit;
  const [countRow, { results }] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`).bind(...binds).first<{ n: number }>(),
    db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC, id ASC LIMIT ? OFFSET ?`)
      .bind(...binds, opts.limit, offset)
      .all<JobRow>(),
  ]);
  return { jobs: results.map(rowToJob), total: countRow?.n ?? 0 };
}

/** 不分頁版的全平台清單（`?scope=all` 沒帶 `?page=`）。 */
export async function listDoneJobsWithResultsAll(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM jobs
       WHERE status = 'done' AND user_id IS NOT NULL AND (kind = 'prompt' OR kind IS NULL) AND result_files != '[]'
       ORDER BY created_at DESC, id ASC`
    )
    .all<JobRow>();
  return results.map(rowToJob);
}

/** 2026-09-19 job-retry：已經 requeue 過（`retry_count > 0`）、此刻仍在排隊的
 * 單 -- `do/hub.ts`'s `sweepHopelessRetries` 每個 tick 對它們重問一次「還有
 * 人可能跑嗎」。`split_count = 0` 與 `getQueuedJobsForDispatch` 對齊：已拆的
 * 父 job 不派工，也不歸掃描管。 */
export async function getRequeuedQueuedJobs(db: D1Database): Promise<Job[]> {
  const { results } = await db
    .prepare("SELECT * FROM jobs WHERE status = 'queued' AND retry_count > 0 AND split_count = 0 ORDER BY created_at ASC, id ASC")
    .all<JobRow>();
  return results.map(rowToJob);
}

/** 終局失敗一張**沒人擁有**的 `queued` job；回傳是否真的動了列。狀態謂詞
 * 就是閘門：派出去了（assigned/running）就交回 `markFailed` 的 owned 路徑。
 * Ports the former Python `fail_queued`（不含 split 連坐 -- 呼叫端接著做）。 */
export async function failQueuedJob(db: D1Database, jobId: string, error: string, finishedAt: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ? AND status = 'queued'")
    .bind(error, finishedAt, jobId)
    .run();
  return (result.meta.changes ?? 0) > 0;
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

/** 2026-09-19 job-retry §5: write back the `{worker_id: failures}` JSON
 * `retry.bumpAttempts` produced. Deliberately a bare column write with no
 * status predicate -- the ownership/status gate already ran in the caller
 * (`do/hub.ts`'s `recordFailedAttempt`, inside `applyOwnedTransition`), the
 * same place the former Python `_record_failed_attempt` runs `dispatch.owned_job`
 * before touching the column. */
export async function updateJobAttempts(db: D1Database, jobId: string, attemptsJson: string): Promise<void> {
  await db.prepare("UPDATE jobs SET attempts = ? WHERE id = ?").bind(attemptsJson, jobId).run();
}

/** 2026-09-19 job-retry §5: the requeue half of a non-terminal failure --
 * `dispatch.requeueForRetry`'s single DB write, mirroring the field set
 * `dispatch.requeue_for_retry` applies:
 *
 *     status=queued, worker_id=NULL, last_worker_id=W, progress=0,
 *     started_at=NULL, finished_at=NULL, error=E, retry_count += 1,
 *     dispatch_info='{}'
 *
 * `error` is deliberately kept: that column's meaning widens from "what this
 * job died of" to "what the LAST attempt died of", and the console renders it
 * as 「上次錯誤」on a queued job with `retry_count > 0`. `signature` survives
 * -- it fingerprints the work itself, not who ran it. */
export async function updateJobRequeuedForRetry(
  db: D1Database,
  jobId: string,
  workerId: string,
  error: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE jobs
       SET status = 'queued', last_worker_id = ?, worker_id = NULL, progress = 0,
           started_at = NULL, finished_at = NULL, error = ?,
           retry_count = retry_count + 1, dispatch_info = '{}'
       WHERE id = ?`
    )
    .bind(workerId, error, jobId)
    .run();
}

/** Merges one filename->sha256 entry into a job's `result_hashes` JSON
 * column -- shared by every artifact-upload route (legacy multipart, the
 * presigned "direct" raw PUT, and the S3-mode confirm) so all three record a
 * verified artifact's hash the exact same way the former Python `upload_job_artifact`
 * does. No-op if the job no longer exists (mirrors that route's own
 * `if job is not None` guard). */
export async function mergeJobResultHash(db: D1Database, jobId: string, filename: string, sha256: string): Promise<void> {
  const job = await getJobById(db, jobId);
  if (!job) return;
  const hashes = { ...job.resultHashes, [filename]: sha256 };
  await db.prepare("UPDATE jobs SET result_hashes = ? WHERE id = ?").bind(JSON.stringify(hashes), jobId).run();
}

/** Updates a running job's progress fraction -- mirrors the former Python
 * `_handle_heartbeat` writing `job.progress` straight onto the row when a
 * heartbeat carries one for a job this worker still owns. */
export async function updateJobProgress(db: D1Database, jobId: string, progress: number): Promise<void> {
  await db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").bind(progress, jobId).run();
}

/** Workers that are online (`status != 'offline'`) AND not disabled, ordered
 * oldest-registered first -- mirrors the former Python `_online_worker_hashes`
 * query (`GET /object_info`'s fleet). */
export async function getOnlineEnabledWorkers(db: D1Database): Promise<Worker[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM workers WHERE deleted = 0 AND disabled = 0 AND status != 'offline' ORDER BY created_at ASC, id ASC"
    )
    .all<WorkerRow>();
  return results.map(rowToWorker);
}

/** Phase 3.1 P2P: online (`status != 'offline'`) workers at or above
 * `minProtocol` that are advertising a `peer_url` -- the SQL half of
 * `core/peer.ts`'s `onlineSeeders` predicate (the remaining
 * inventory/consensus-hash check happens in JS since it must inspect each
 * worker's JSON `model_inventory`). `excludeWorkerId`, when given, omits
 * that worker (the requester itself, in grant issuance).
 *
 * Phase 3.4 §4.2 adds the reachability half: a seeder must have passed the
 * platform's own `/peer/health` probe (`peer_reachable = 1`), OR sit behind
 * the same public IP as the puller (`pullerRemoteIp`) with a LAN address to
 * offer. Callers with no particular puller in mind (`seederCandidateFiles`'s
 * "does this file have a seeder at all") omit `pullerRemoteIp` and get the
 * conservative half -- better to under-report one seeder than to dispatch a
 * job on the promise of a peer nobody can reach. Parity: the former Python
 * `online_seeders` / `model_manifest._seeder_candidate_files`.
 *
 * Deliberately does NOT filter `disabled`: seeding eligibility is decoupled
 * from a worker's disabled status (spec: 種子資格與 worker 停用狀態脫鉤 --
 * disabled means "does not take dispatched jobs", not "stops sharing models
 * it already holds"). Only a genuinely offline worker can't serve a byte. */
export async function getOnlinePeerCapableWorkers(
  db: D1Database,
  minProtocol: number,
  excludeWorkerId?: string,
  pullerRemoteIp?: string | null
): Promise<Worker[]> {
  // No `deleted = 0` clause, same accepted ~90s window as `peer.online_seeders`
  // (review L6): a just-deleted seeder stays eligible until the stale sweep
  // marks it offline, and the worst case is one wasted fetch round trip.
  let sql = "SELECT * FROM workers WHERE status != 'offline' AND protocol >= ? AND peer_url IS NOT NULL";
  const binds: unknown[] = [minProtocol];
  // Phase 3.4 §4.2：種子必須是平台驗證過連得到的，**或**跟拉方在同一個公網
  // IP 後面（⇒ 幾乎一定同一個 NAT）且有區網位址可用。
  if (pullerRemoteIp) {
    sql += " AND (peer_reachable = 1 OR (remote_ip = ? AND peer_lan_url IS NOT NULL))";
    binds.push(pullerRemoteIp);
  } else {
    sql += " AND peer_reachable = 1";
  }
  if (excludeWorkerId !== undefined) {
    sql += " AND id != ?";
    binds.push(excludeWorkerId);
  }
  const { results } = await db.prepare(sql).bind(...binds).all<WorkerRow>();
  return results.map(rowToWorker);
}

/** Jobs matching `statuses`, restricted to a given `origin` and (for
 * `panel`) excluding panel-hidden rows -- mirrors the former Python `GET
 * /comfy/api/queue` (origin-agnostic caller passes no `origin`) and `GET
 * /comfy/api/history` (`origin: "panel"`, `panelHiddenExcluded: true`)
 * queries. `opts.userId` (Phase 3.0) additionally scopes to one owning user
 * -- every panel-native route call site passes it (the panel is a per-user
 * workspace for every role, admin included), while `origin`-agnostic console-side callers omit it. */
export async function getJobsByStatusAndOrigin(
  db: D1Database,
  statuses: string[],
  opts: {
    origin?: string;
    excludePanelHidden?: boolean;
    orderBy?: "created_at" | "finished_at";
    userId?: string;
    /** Phase 3.3 §3.7: `true` restricts the result to parent/ordinary jobs.
     * Every panel-facing caller passes it -- the panel submitted ONE prompt
     * and must see one row, not k. */
    parentsOnly?: boolean;
  } = {}
): Promise<Job[]> {
  const placeholders = statuses.map(() => "?").join(",");
  const clauses = [`status IN (${placeholders})`];
  if (opts.parentsOnly) clauses.push("parent_id IS NULL");
  const binds: unknown[] = [...statuses];
  if (opts.origin !== undefined) {
    clauses.push("origin = ?");
    binds.push(opts.origin);
  }
  if (opts.excludePanelHidden) {
    clauses.push("panel_hidden = 0");
  }
  if (opts.userId !== undefined) {
    clauses.push("user_id = ?");
    binds.push(opts.userId);
  }
  const order =
    opts.orderBy === "finished_at" ? "ORDER BY finished_at ASC, created_at ASC" : "ORDER BY created_at ASC, id ASC";
  const { results } = await db
    .prepare(`SELECT * FROM jobs WHERE ${clauses.join(" AND ")} ${order}`)
    .bind(...binds)
    .all<JobRow>();
  return results.map(rowToJob);
}

/** All jobs, oldest-created first (ties broken by id) -- backs
 * the former Python `_numbers_by_job_id` (every job in the federation, not
 * scoped to any origin -- the queue `number` a panel sees must stay
 * consistent with console-submitted jobs interleaved in submission order). */
export async function getAllJobsOrderedByCreatedAt(db: D1Database): Promise<Job[]> {
  const { results } = await db.prepare("SELECT * FROM jobs ORDER BY created_at ASC, id ASC").all<JobRow>();
  return results.map(rowToJob);
}

/** Sets `panel_hidden = 1` on every terminal (`done`/`failed`), `origin =
 * 'panel'` job matching `ids` (or every such job when `ids` is undefined) --
 * mirrors the former Python `POST /comfy/api/history` hide mutation. `opts.userId`
 * (Phase 3.0) additionally scopes the mutation to one owning user, matching
 * that route's per-user panel scope -- every call site passes it. Returns
 * the number of rows touched (unused by the caller today, kept for parity
 * with every other bulk-write helper's return shape in this file). */
export async function hidePanelHistoryJobs(
  db: D1Database,
  ids?: string[],
  opts: { userId?: string } = {}
): Promise<number> {
  // Phase 3.3 §3.7: the same parents-only scope `GET /comfy/api/history`
  // lists. Hiding the parent is enough -- children never appear in that
  // listing, so a `delete` naming a child id must be as inert as one naming
  // a job that does not exist.
  const clauses = ["status IN ('done', 'failed')", "origin = 'panel'", "parent_id IS NULL"];
  const binds: unknown[] = [];
  if (opts.userId !== undefined) {
    clauses.push("user_id = ?");
    binds.push(opts.userId);
  }
  if (ids !== undefined) {
    if (ids.length === 0) return 0;
    clauses.push(`id IN (${ids.map(() => "?").join(",")})`);
    binds.push(...ids);
  }
  const result = await db
    .prepare(`UPDATE jobs SET panel_hidden = 1 WHERE ${clauses.join(" AND ")}`)
    .bind(...binds)
    .run();
  return result.meta.changes ?? 0;
}

/** Whether any job is currently queued, assigned, or running -- the Hub
 * DO's alarm re-arm condition (see do/hub.ts): the 5s dispatch tick keeps
 * ticking while there is either a live agent connection OR work that isn't
 * finished yet, so a stale/assigned job doesn't sit unrequeued forever even
 * with zero agents connected. */
export async function hasActiveJobs(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS one FROM jobs WHERE status IN ('queued', 'assigned', 'running') LIMIT 1")
    .first<{ one: number }>();
  return row !== null;
}

/** Ports the former Python `queue_status`'s count: queued + assigned + running,
 * i.e. upstream's `get_tasks_remaining()` (queued jobs PLUS ones already
 * picked up but not finished). Backs the panel WS's `status.exec_info.
 * queue_remaining` badge. */
export async function countQueueRemaining(db: D1Database): Promise<number> {
  const row = await db
    // Phase 3.3 §3.7: `parent_id IS NULL` so one submission counts once --
    // without it a prompt split into 4 makes the panel's queue badge read 4.
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued', 'assigned', 'running') AND parent_id IS NULL")
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Receipts

export interface Receipt {
  id: string;
  /** NULL only for kind === "p2p_upload" (Phase 3.1) -- every other kind
   * always carries a real job id. Global Constraints: only p2p_upload may
   * have a NULL job_id. */
  jobId: string | null;
  workerId: string;
  gpuSeconds: number;
  platformSig: string;
  workerSig: string | null;
  createdAt: string;
  kind: string;
  billable: boolean;
  basis: string;
  /** Phase 3.1: actual bytes served for a p2p_upload receipt; null for
   * every other kind. */
  bytes: number | null;
}

interface ReceiptRow {
  id: string;
  job_id: string | null;
  worker_id: string;
  gpu_seconds: number;
  platform_sig: string;
  worker_sig: string | null;
  created_at: string;
  kind: string;
  billable: number;
  basis: string;
  bytes: number | null;
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
    bytes: row.bytes,
  };
}

export async function getReceiptsForJob(db: D1Database, jobId: string): Promise<Receipt[]> {
  const { results } = await db
    .prepare("SELECT * FROM receipts WHERE job_id = ?")
    .bind(jobId)
    .all<ReceiptRow>();
  return results.map(rowToReceipt);
}

/** Receipts with `created_at` in `[start, end]` (either bound optional) --
 * mirrors the former Python `contributions` route query. `start`/`end` must
 * already be `toSqliteTimestamp`-shaped strings (naive-UTC), so the
 * comparison is a plain lexicographic one, same as `getStaleWorkers`. No
 * `ORDER BY`: SQLite/D1 return rows in rowid (insertion) order by default,
 * matching the Python side's unordered `query.all()`. */
export async function getReceiptsInRange(
  db: D1Database,
  start: string | null,
  end: string | null
): Promise<Receipt[]> {
  let sql = "SELECT * FROM receipts WHERE 1=1";
  const binds: string[] = [];
  if (start !== null) {
    sql += " AND created_at >= ?";
    binds.push(start);
  }
  if (end !== null) {
    sql += " AND created_at <= ?";
    binds.push(end);
  }
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<ReceiptRow>();
  return results.map(rowToReceipt);
}

export async function getReceiptById(db: D1Database, id: string): Promise<Receipt | null> {
  const row = await db.prepare("SELECT * FROM receipts WHERE id = ?").bind(id).first<ReceiptRow>();
  return row ? rowToReceipt(row) : null;
}

/** One receipt joined through `jobs.user_id` to `users.username` -- the raw
 * row shape `/api/reports/usage`, `/my-usage`, and `/payout`'s underlying
 * aggregation need. Mirrors the former Python `_usage_rows` outer-join query:
 * `userId`/`username` are `null` when the receipt's job is missing (orphan
 * receipt) or the job's `user_id` is `null` (pre-Phase-3.0 data), or when the
 * job's `user_id` doesn't match any current `users` row. */
export interface UsageJoinRow {
  userId: string | null;
  username: string | null;
  gpuSeconds: number;
  billable: boolean;
}

interface UsageJoinRowRaw {
  user_id: string | null;
  username: string | null;
  gpu_seconds: number;
  billable: number;
}

/** Receipts with `created_at` in `[start, end]` (either bound optional),
 * outer-joined through `jobs` to `users` -- mirrors the former Python
 * `_usage_rows` query exactly, including the LEFT JOINs (a receipt whose job
 * row is missing, or whose job has a `null`/dangling `user_id`, still comes
 * back with `userId: null` rather than being dropped). `onlyUserId`, when
 * given, filters on `jobs.user_id` (post-join) same as `_usage_rows`'s
 * `only_user_id` -- used by `/my-usage` to scope to the session user. No
 * `ORDER BY`: aggregation order doesn't matter, the route sorts the
 * aggregated result. */
export async function getUsageRowsInRange(
  db: D1Database,
  start: string | null,
  end: string | null,
  onlyUserId?: string
): Promise<UsageJoinRow[]> {
  // L4 final-review fix: exclude kind='p2p_upload' rows -- they're
  // worker-side bandwidth (job_id is always NULL for them), not consumer
  // usage, and would otherwise materialize a phantom {username: null,
  // gpuSeconds: 0} row in any range with P2P activity. `/contributions`
  // still aggregates them separately into p2pUploadBytes.
  let sql = `SELECT j.user_id AS user_id, u.username AS username, r.gpu_seconds AS gpu_seconds, r.billable AS billable
             FROM receipts r
             LEFT JOIN jobs j ON j.id = r.job_id
             LEFT JOIN users u ON u.id = j.user_id
             WHERE r.kind != 'p2p_upload'`;
  const binds: string[] = [];
  if (start !== null) {
    sql += " AND r.created_at >= ?";
    binds.push(start);
  }
  if (end !== null) {
    sql += " AND r.created_at <= ?";
    binds.push(end);
  }
  if (onlyUserId !== undefined) {
    sql += " AND j.user_id = ?";
    binds.push(onlyUserId);
  }
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<UsageJoinRowRaw>();
  return results.map((row) => ({
    userId: row.user_id,
    username: row.username,
    gpuSeconds: row.gpu_seconds,
    billable: row.billable !== 0,
  }));
}

export interface NewReceipt {
  id: string;
  /** NULL only for kind === "p2p_upload" (Phase 3.1). */
  jobId: string | null;
  workerId: string;
  gpuSeconds: number;
  platformSig: string;
  createdAt: string;
  kind: string;
  billable: boolean;
  basis: string;
  /** Phase 3.1: bytes served, only for kind === "p2p_upload"; omitted (or
   * null) for every other kind. */
  bytes?: number | null;
}

/** Inserts a freshly platform-signed receipt row -- mirrors
 * `agentws._sign_and_store_receipt`'s `db.Receipt(...)` insert. `worker_sig`
 * starts NULL; `updateReceiptWorkerSig` fills it in once the worker
 * counter-signs via `receipt_ack`. */
export async function insertReceipt(db: D1Database, r: NewReceipt): Promise<void> {
  await db
    .prepare(
      `INSERT INTO receipts (id, job_id, worker_id, gpu_seconds, platform_sig, created_at, kind, billable, basis, bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      r.id,
      r.jobId,
      r.workerId,
      r.gpuSeconds,
      r.platformSig,
      r.createdAt,
      r.kind,
      r.billable ? 1 : 0,
      r.basis,
      r.bytes ?? null
    )
    .run();
}

/** Stores a worker's counter-signature on a receipt -- mirrors
 * `agentws._handle_receipt_ack`'s `receipt.worker_sig = worker_sig` write. */
export async function updateReceiptWorkerSig(db: D1Database, id: string, workerSig: string): Promise<void> {
  await db.prepare("UPDATE receipts SET worker_sig = ? WHERE id = ?").bind(workerSig, id).run();
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

/** `username` is nullable at the type level only for pre-Phase-3.0 rows
 * already in the table (see 0006_users.sql's `ALTER TABLE ... ADD COLUMN`);
 * every row inserted by the current login route always carries the
 * normalized (lowercased) username that was attempted, matching the former Python
 * per-username `LoginAttempt` insert. */
export async function insertLoginAttempt(db: D1Database, at: string, ok: boolean, username: string): Promise<void> {
  await db
    .prepare("INSERT INTO login_attempts (at, ok, username) VALUES (?, ?, ?)")
    .bind(at, ok ? 1 : 0, username)
    .run();
}

/** Rows at/after `cutoffTimestamp` for one `username`, newest first --
 * exactly the shape `core/auth.ts`'s `consecutiveFailures` expects. Phase
 * 3.0: backoff is per-username (parity with the former Python `_consecutive_failures`,
 * which filters `LoginAttempt.username == username`), so failed logins
 * against one account never lock out a different one. */
export async function getRecentLoginAttemptsForUsername(
  db: D1Database,
  cutoffTimestamp: string,
  username: string
): Promise<{ at: string; ok: boolean }[]> {
  const { results } = await db
    .prepare("SELECT at, ok FROM login_attempts WHERE at >= ? AND username = ? ORDER BY at DESC")
    .bind(cutoffTimestamp, username)
    .all<{ at: string; ok: number }>();
  return results.map((r) => ({ at: r.at, ok: r.ok !== 0 }));
}

/** Deletes attempt rows older than `beforeTimestamp`. Not a parity item --
 * the former Python server's table grew unboundedly too -- but D1/Workers has no equivalent
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
 * request verification, mirroring the former Python `_prune_nonces`. */
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

// ---------------------------------------------------------------------------
// Upload tokens (Task 8) -- one-time tokens backing the presigned "direct"
// artifact upload protocol. See migrations/0003_upload_tokens.sql.

export interface UploadToken {
  token: string;
  jobId: string;
  filename: string;
  sha256: string;
  size: number | null;
  expiresAt: number;
  used: boolean;
}

export async function insertUploadToken(
  db: D1Database,
  token: string,
  jobId: string,
  filename: string,
  sha256: string,
  size: number | null,
  expiresAt: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO upload_tokens (token, job_id, filename, sha256, size, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(token, jobId, filename, sha256, size, expiresAt)
    .run();
}

export async function getUploadToken(db: D1Database, token: string): Promise<UploadToken | null> {
  const row = await db
    .prepare("SELECT * FROM upload_tokens WHERE token = ?")
    .bind(token)
    .first<{
      token: string;
      job_id: string;
      filename: string;
      sha256: string;
      size: number | null;
      expires_at: number;
      used: number;
    }>();
  if (!row) return null;
  return {
    token: row.token,
    jobId: row.job_id,
    filename: row.filename,
    sha256: row.sha256,
    size: row.size,
    expiresAt: row.expires_at,
    used: row.used !== 0,
  };
}

/** Atomically claims a token (`used` 0 -> 1). Returns whether THIS call was
 * the one that claimed it -- a replayed PUT against an already-used token
 * loses the race and must 409 rather than re-store bytes, exactly like
 * `claimRegisterToken`'s single-winner guarantee. */
export async function claimUploadToken(db: D1Database, token: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE upload_tokens SET used = 1 WHERE token = ? AND used = 0")
    .bind(token)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Mirrors `pruneNonces`: opportunistic cleanup on the same write path that
 * grows the table, rather than a separate cron/alarm. Deletes every row past
 * its TTL regardless of `used` -- an expired-but-unused token is just as
 * dead as an expired-and-used one, so a single `expires_at` predicate covers
 * both without needing a second column check (final-review.md m3). */
export async function pruneUploadTokens(db: D1Database, nowSeconds: number): Promise<void> {
  await db.prepare("DELETE FROM upload_tokens WHERE expires_at < ?").bind(nowSeconds).run();
}

// ---------------------------------------------------------------------------
// Model hashes (Phase 2.1 Task 7) -- the (name, size_bytes) -> sha256
// consensus table `core/model_manifest.ts`'s `recordHash`/`entries` read and
// write. See migrations/0004_model_hashes.sql + 0005_model_hash_conflict.sql;
// Ported from the former Python server's `ModelHash` model.

export interface ModelHashRow {
  name: string;
  sizeBytes: number;
  sha256: string;
  firstWorkerId: string;
  createdAt: string;
  /** Set when a later report for this (name, size_bytes) disagreed with the
   * first-seen sha256 above (see `recordHash`). Persisted (fix round 1,
   * migration 0005) rather than tracked in an in-memory, per-DO-instance
   * set -- `getAllModelHashes` (and therefore `model_manifest.entries()`)
   * excludes any row with this set, correct across a DO eviction or a
   * request handled by a plain route with no DO state at all. */
  conflict: boolean;
  /** Phase 3.1: the per-64-MiB-chunk sha256 list (JSON-parsed), or null when
   * no reporter has supplied one yet. Set once, never overwritten -- see
   * `core/model_manifest.ts`'s `recordHash` docstring. */
  chunkSha256s: string[] | null;
}

interface ModelHashDbRow {
  name: string;
  size_bytes: number;
  sha256: string;
  first_worker_id: string;
  created_at: string;
  conflict: number;
  chunk_sha256s: string | null;
}

function rowToModelHash(row: ModelHashDbRow): ModelHashRow {
  return {
    name: row.name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    firstWorkerId: row.first_worker_id,
    createdAt: row.created_at,
    conflict: row.conflict !== 0,
    chunkSha256s: safeParse<string[] | null>(row.chunk_sha256s, null),
  };
}

/** The learned hash row for one (name, size_bytes) key, or null if nobody
 * has reported it yet -- mirrors `model_manifest.record_hash`'s
 * `session.get(db.ModelHash, (name, size_bytes))` lookup. */
export async function getModelHash(db: D1Database, name: string, sizeBytes: number): Promise<ModelHashRow | null> {
  const row = await db
    .prepare("SELECT * FROM model_hashes WHERE name = ? AND size_bytes = ?")
    .bind(name, sizeBytes)
    .first<ModelHashDbRow>();
  return row ? rowToModelHash(row) : null;
}

/** INSERT OR IGNORE semantics for a first-seen (name, size_bytes) report --
 * returns whether THIS call actually inserted the row (false means a row for
 * that key already existed, i.e. a race lost to a concurrent first report --
 * the caller re-reads to compare hashes, exactly like `record_hash`'s
 * `session.get` + insert-or-compare dance). */
export async function insertModelHashIfAbsent(
  db: D1Database,
  name: string,
  sizeBytes: number,
  sha256: string,
  firstWorkerId: string,
  createdAt: string,
  chunkSha256sJson: string | null = null
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO model_hashes (name, size_bytes, sha256, first_worker_id, created_at, chunk_sha256s)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(name, size_bytes) DO NOTHING`
    )
    .bind(name, sizeBytes, sha256, firstWorkerId, createdAt, chunkSha256sJson)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Phase 3.1: sets `chunk_sha256s` for an existing (name, size_bytes) row
 * ONLY if it doesn't already have one -- mirrors `model_manifest.record_hash`'s
 * "stored the first time consensus is established and no chunk list is on
 * the row yet, never overwritten by a later, different one" rule. Returns
 * whether THIS call actually set it (false means the row already had a
 * chunk list, or the row doesn't exist -- the caller distinguishes those the
 * same way `record_hash` does: by having already resolved the row via
 * `getModelHash` before calling this). */
export async function setModelHashChunksIfAbsent(
  db: D1Database,
  name: string,
  sizeBytes: number,
  chunkSha256sJson: string
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE model_hashes SET chunk_sha256s = ? WHERE name = ? AND size_bytes = ? AND chunk_sha256s IS NULL"
    )
    .bind(chunkSha256sJson, name, sizeBytes)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Marks an existing (name, size_bytes) row as conflicted -- the row's
 * sha256/first_worker_id are left untouched (the first-seen hash is kept);
 * only `conflict` flips to true. Mirrors `model_manifest.record_hash`'s
 * `existing.conflict = True` write on the Python side. */
export async function markModelHashConflict(db: D1Database, name: string, sizeBytes: number): Promise<void> {
  await db
    .prepare("UPDATE model_hashes SET conflict = 1 WHERE name = ? AND size_bytes = ?")
    .bind(name, sizeBytes)
    .run();
}

/** Every NON-conflicted learned hash row -- mirrors `model_manifest.
 * entries()`'s `session.query(db.ModelHash).filter(conflict == False).all()`.
 * A plain SQL predicate, not an in-memory set: correct for any caller
 * (a Durable Object instance or a stateless route) with no coordination. */
export async function getAllModelHashes(db: D1Database): Promise<ModelHashRow[]> {
  const { results } = await db.prepare("SELECT * FROM model_hashes WHERE conflict = 0").all<ModelHashDbRow>();
  return results.map(rowToModelHash);
}

/** Every CONFLICTED learned hash row -- Phase 3.2 addendum, mirrors
 * `model_manifest.entries()`'s `session.query(db.ModelHash).filter(conflict
 * == True).all()`. A conflicted row must still exclude its name from the
 * guide-hash fallback (see `core/model_manifest.ts`'s `entries()`): a
 * reporter-vs-reporter disagreement is never papered over by the operator's
 * curated hash, even for a name that would otherwise be zero-holder
 * fetchable. */
export async function getConflictedModelHashes(db: D1Database): Promise<ModelHashRow[]> {
  const { results } = await db.prepare("SELECT * FROM model_hashes WHERE conflict = 1").all<ModelHashDbRow>();
  return results.map(rowToModelHash);
}

// ---------------------------------------------------------------------------
// P2P grants (Phase 3.1 addendum, Task 8) -- D1-backed equivalent of
// the former Python server's in-memory `_grants` dict + `_grant_lock`.
// A Worker isolate's in-memory state is not reliable/shared across requests
// (unlike a long-lived Python process), so the grant book lives in D1 here;
// atomic claim uses `UPDATE ... WHERE booked = 0` checked against
// `meta.changes`, the D1-correct equivalent of the former Python lock-guarded
// check-then-set (see `core/peer.ts`). See migrations/0007_p2p.sql.

export interface P2pGrantRow {
  grantId: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  seederId: string;
  pullerId: string;
  expiresAt: number;
  booked: boolean;
  createdAt: number;
}

interface P2pGrantDbRow {
  grant_id: string;
  name: string;
  size_bytes: number;
  sha256: string;
  seeder_id: string;
  puller_id: string;
  expires_at: number;
  booked: number;
  created_at: number;
}

function rowToP2pGrant(row: P2pGrantDbRow): P2pGrantRow {
  return {
    grantId: row.grant_id,
    name: row.name,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    seederId: row.seeder_id,
    pullerId: row.puller_id,
    expiresAt: row.expires_at,
    booked: row.booked !== 0,
    createdAt: row.created_at,
  };
}

export interface NewP2pGrant {
  grantId: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  seederId: string;
  pullerId: string;
  expiresAt: number;
  createdAt: number;
}

export async function insertP2pGrant(db: D1Database, g: NewP2pGrant): Promise<void> {
  await db
    .prepare(
      `INSERT INTO p2p_grants (grant_id, name, size_bytes, sha256, seeder_id, puller_id, expires_at, booked, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
    )
    .bind(g.grantId, g.name, g.sizeBytes, g.sha256, g.seederId, g.pullerId, g.expiresAt, g.createdAt)
    .run();
}

export async function getP2pGrant(db: D1Database, grantId: string): Promise<P2pGrantRow | null> {
  const row = await db.prepare("SELECT * FROM p2p_grants WHERE grant_id = ?").bind(grantId).first<P2pGrantDbRow>();
  return row ? rowToP2pGrant(row) : null;
}

/** Atomic claim -- mirrors the former Python `_grant_lock`-guarded check-not-booked-
 * then-mark-booked step. Returns whether THIS call was the one that claimed
 * it (`meta.changes === 1`); two concurrent calls for the same grant_id can
 * never both succeed, exactly like the Python lock. */
export async function claimP2pGrantBooked(db: D1Database, grantId: string): Promise<boolean> {
  const result = await db
    .prepare("UPDATE p2p_grants SET booked = 1 WHERE grant_id = ? AND booked = 0")
    .bind(grantId)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

/** Un-marks a grant as booked -- mirrors the former Python rollback when the DB
 * insert after a successful claim fails, so a legitimate retry can still
 * succeed instead of permanently wedging on a grant nothing ever actually
 * booked. */
export async function unmarkP2pGrantBooked(db: D1Database, grantId: string): Promise<void> {
  await db.prepare("UPDATE p2p_grants SET booked = 0 WHERE grant_id = ?").bind(grantId).run();
}

/** Unexpired, unbooked grants currently seeded by `seederId` -- the "fewest
 * active grants" tiebreak for picking among multiple seeders (the former Python
 * `_active_grant_count`). */
export async function countActiveP2pGrantsForSeeder(db: D1Database, seederId: string, nowSeconds: number): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM p2p_grants WHERE seeder_id = ? AND expires_at > ? AND booked = 0")
    .bind(seederId, nowSeconds)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** M4 final-review fix: retention window (seconds) past `expires_at` before
 * a grant row is actually pruned -- mirrors the former Python
 * `_GRANT_RETENTION_SECONDS`. A grant whose transfer is still active when
 * its TTL elapses (see `grantTtlSeconds`) must still be found by an
 * expiry-triggered
 * `peer-served` report; pruning at the exact TTL boundary guarantees that
 * report 404s and retries forever. `countActiveP2pGrantsForSeeder`'s
 * `expires_at > now` filter already keeps a retained-but-expired grant out
 * of seeder selection, so this window only affects when the row is deleted. */
export const GRANT_RETENTION_SECONDS = 3600;

/** L1 final-review fix: hard cap on `p2p_grants` row count -- once exceeded,
 * the oldest-created rows beyond the cap are deleted alongside the normal
 * retention-window prune below. */
export const MAX_P2P_GRANTS = 10000;

/** Deletes grant rows past their retention window, and (L1) any excess rows
 * beyond `MAX_P2P_GRANTS`, oldest-created first -- mirrors the former Python
 * `_prune_expired` + `_evict_oldest_beyond_cap`, called opportunistically on
 * issuance/booking. */
export async function pruneExpiredP2pGrants(db: D1Database, nowSeconds: number): Promise<void> {
  await db
    .prepare("DELETE FROM p2p_grants WHERE expires_at + ? <= ?")
    .bind(GRANT_RETENTION_SECONDS, nowSeconds)
    .run();
  await db
    .prepare(
      `DELETE FROM p2p_grants WHERE grant_id IN (
         SELECT grant_id FROM p2p_grants ORDER BY created_at ASC, grant_id ASC
         LIMIT MAX((SELECT COUNT(*) FROM p2p_grants) - ?, 0)
       )`
    )
    .bind(MAX_P2P_GRANTS)
    .run();
}

// ---------------------------------------------------------------------------
// Users (Phase 3.0 multi-user) -- ported from the former Python server's
// `db.User` reads/writes and its admin CRUD. See
// migrations/0006_users.sql for the table shape.

export interface User {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  disabled: boolean;
  sessionEpoch: number;
  createdAt: string;
  /** 2026-09-20 每人覆寫（migrations/0015）：null = 沿用全案預設（額度）／
   * 允許（NSFW）。Parsed and range-checked in lib/limits.ts / core/nsfw_gate.ts. */
  maxFileMb: number | null;
  quotaGb: number | null;
  nsfwAllowed: boolean | null;
}

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  disabled: number;
  session_epoch: number;
  created_at: string;
  max_file_mb: number | null;
  quota_gb: number | null;
  nsfw_allowed: number | null;
}

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    role: row.role,
    disabled: row.disabled !== 0,
    sessionEpoch: row.session_epoch,
    createdAt: row.created_at,
    maxFileMb: row.max_file_mb ?? null,
    quotaGb: row.quota_gb ?? null,
    nsfwAllowed: row.nsfw_allowed === null || row.nsfw_allowed === undefined ? null : row.nsfw_allowed !== 0,
  };
}

/** Whether the `users` table has ever had a row -- backs `/api/setup/status`
 * and `/api/setup`'s "already done" check now that credentials live here
 * instead of the `admin_password_hash` setting. */
export async function hasAnyUser(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS one FROM users LIMIT 1").first<{ one: number }>();
  return row !== null;
}

export async function getUserById(db: D1Database, id: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<UserRow>();
  return row ? rowToUser(row) : null;
}

/** `username` must already be normalized (trimmed + lowercased) by the
 * caller -- mirrors the former Python `login()`/`_normalize_username`,
 * which both do that normalization before ever touching the DB. */
export async function getUserByUsername(db: D1Database, username: string): Promise<User | null> {
  const row = await db.prepare("SELECT * FROM users WHERE username = ?").bind(username).first<UserRow>();
  return row ? rowToUser(row) : null;
}

export interface NewUser {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
  createdAt: string;
}

/** Inserts a freshly-created user row -- mirrors the former Python `create_user`'s
 * `db.User(...)` insert. Relies on the migration's column DEFAULTs for
 * `disabled` (0) and `session_epoch` (0), same as Python's model defaults. */
export async function insertUser(db: D1Database, user: NewUser): Promise<void> {
  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, disabled, session_epoch, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?)`
    )
    .bind(user.id, user.username, user.passwordHash, user.role, user.createdAt)
    .run();
}

export interface UserWithJobCount extends User {
  jobs: number;
}

/** Every user, oldest-created first, each with its job count -- mirrors
 * the former Python `list_users`: one grouped query over `jobs.user_id` (`GROUP BY
 * user_id`) joined in memory against the user rows, rather than an N+1 count
 * per user. */
export async function listUsersWithJobCounts(db: D1Database): Promise<UserWithJobCount[]> {
  const { results: userRows } = await db.prepare("SELECT * FROM users ORDER BY created_at ASC").all<UserRow>();
  const { results: countRows } = await db
    .prepare("SELECT user_id, COUNT(*) AS n FROM jobs WHERE user_id IS NOT NULL GROUP BY user_id")
    .all<{ user_id: string; n: number }>();
  const counts = new Map(countRows.map((r) => [r.user_id, r.n]));
  return userRows.map((row) => ({ ...rowToUser(row), jobs: counts.get(row.id) ?? 0 }));
}

/** Job count for a single user -- mirrors the count returned alongside a
 * single-row response (the former Python `create_user`/`patch_user`, which each
 * return `_user_list_row(target, job_count)`). A freshly-created user always
 * has 0; `patch_user`'s target may already own jobs. */
export async function countJobsForUser(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM jobs WHERE user_id = ?")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Sorted ids of every enabled `role = 'admin'` user -- mirrors
 * the former Python `admin_uids`: the owners whose `workflows/templates/`
 * folders make up the shared template library. */
export async function listActiveAdminIds(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM users WHERE role = 'admin' AND disabled = 0 ORDER BY id ASC")
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

/** Active (non-disabled) admins, optionally excluding one id -- mirrors
 * the former Python `_active_admin_count`, used by `patch_user`'s last-admin guard. */
export async function countActiveAdmins(db: D1Database, excludeId?: string): Promise<number> {
  let sql = "SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0";
  const binds: string[] = [];
  if (excludeId !== undefined) {
    sql += " AND id != ?";
    binds.push(excludeId);
  }
  const row = await db.prepare(sql).bind(...binds).first<{ n: number }>();
  return row?.n ?? 0;
}

/** Sets a new password hash and bumps `session_epoch` in one write --
 * mirrors change-password's/reset-password's paired writes in the former
 * Python server (every existing session for this account, including in the
 * change-password case the caller's own pre-update cookie, stops validating;
 * change-password's route re-issues a fresh cookie right after this call so
 * the caller stays logged in). */
export async function updateUserPasswordAndBumpEpoch(db: D1Database, id: string, passwordHash: string): Promise<void> {
  await db
    .prepare("UPDATE users SET password_hash = ?, session_epoch = session_epoch + 1 WHERE id = ?")
    .bind(passwordHash, id)
    .run();
}

export async function bumpUserSessionEpoch(db: D1Database, id: string): Promise<void> {
  await db.prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?").bind(id).run();
}

/** Applies a `PATCH /api/users/{id}` update -- mirrors the former Python
 * `patch_user` field-by-field `if ... is not None` writes. Epoch-bumping on
 * disable is the caller's job (patch_user route), not this helper's, since
 * it only applies when disabling flips false->true, a decision the route
 * already has to make for the last-admin guard anyway. */
export async function updateUserRoleAndDisabled(
  db: D1Database,
  id: string,
  fields: {
    role?: string;
    disabled?: boolean;
    /** 2026-09-20 每人覆寫：`undefined` = 不動，`null` = 清掉（回到全案預設）。 */
    maxFileMb?: number | null;
    quotaGb?: number | null;
    nsfwAllowed?: boolean | null;
  }
): Promise<void> {
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (fields.role !== undefined) {
    sets.push("role = ?");
    binds.push(fields.role);
  }
  if (fields.disabled !== undefined) {
    sets.push("disabled = ?");
    binds.push(fields.disabled ? 1 : 0);
  }
  if (fields.maxFileMb !== undefined) {
    sets.push("max_file_mb = ?");
    binds.push(fields.maxFileMb);
  }
  if (fields.quotaGb !== undefined) {
    sets.push("quota_gb = ?");
    binds.push(fields.quotaGb);
  }
  if (fields.nsfwAllowed !== undefined) {
    sets.push("nsfw_allowed = ?");
    binds.push(fields.nsfwAllowed === null ? null : fields.nsfwAllowed ? 1 : 0);
  }
  if (sets.length === 0) return;
  binds.push(id);
  await db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds).run();
}

// ---------------------------------------------------------------------------
// API tokens (2026-09-19 spec §4) -- ported from the former Python server's
// `db.ApiToken` reads/writes. See migrations/
// 0013_api_tokens.sql for the table shape. Row SQL lives here (this file's
// stated convention: "nothing outside this file should touch a raw D1 row
// shape"); the token LOGIC -- hashing, the active/expiry rules, the touch
// throttle -- lives in core/api_tokens.ts, the same split the former Python
// server had between its auth and api_tokens modules.

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  tokenHash: string;
  prefix: string;
  epoch: number;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface ApiTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  prefix: string;
  epoch: number;
  created_at: string;
  expires_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

function rowToApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenHash: row.token_hash,
    prefix: row.prefix,
    epoch: row.epoch,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  };
}

export async function insertApiToken(db: D1Database, token: ApiToken): Promise<void> {
  await db
    .prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, epoch, created_at, expires_at, last_used_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`
    )
    .bind(
      token.id,
      token.userId,
      token.name,
      token.tokenHash,
      token.prefix,
      token.epoch,
      token.createdAt,
      token.expiresAt
    )
    .run();
}

export async function getApiTokenById(db: D1Database, id: string): Promise<ApiToken | null> {
  const row = await db.prepare("SELECT * FROM api_tokens WHERE id = ?").bind(id).first<ApiTokenRow>();
  return row ? rowToApiToken(row) : null;
}

/** The one query every bearer request runs -- an equality lookup on the
 * UNIQUE `token_hash` (mirrors the former Python `.one_or_none()`). */
export async function getApiTokenByHash(db: D1Database, tokenHash: string): Promise<ApiToken | null> {
  const row = await db
    .prepare("SELECT * FROM api_tokens WHERE token_hash = ?")
    .bind(tokenHash)
    .first<ApiTokenRow>();
  return row ? rowToApiToken(row) : null;
}

/** Every token of one user (revoked and expired ones included), newest
 * first -- mirrors the former Python `list_tokens` ordering. */
export async function listApiTokensForUser(db: D1Database, userId: string): Promise<ApiToken[]> {
  const { results } = await db
    .prepare("SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC")
    .bind(userId)
    .all<ApiTokenRow>();
  return results.map(rowToApiToken);
}

/** Count of this user's still-active tokens -- mirrors the former Python
 * `_active_query(...).count()`, backing the per-user cap. `now` is a
 * `toSqliteTimestamp` string; the format is fixed-width and zero-padded, so
 * a plain `>` string compare sorts chronologically (see this file's header). */
export async function countActiveApiTokens(db: D1Database, userId: string, now: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?")
    .bind(userId, now)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Stamps `revoked_at` on a token that isn't already revoked. The `AND
 * revoked_at IS NULL` enforces idempotency at the SQL layer too, so
 * `core/api_tokens.ts`'s `revokeToken` reads the row only for the OWNERSHIP
 * check (not-mine and never-existed both answer 404) -- never to decide
 * whether a repeat revoke should write. */
export async function revokeApiTokenRow(db: D1Database, id: string, now: string): Promise<void> {
  await db
    .prepare("UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(now, id)
    .run();
}

/** `last_used_at` write-back (throttled by the caller -- core/api_tokens.ts's
 * `touch`, which only calls this past `API_TOKEN_TOUCH_SECONDS`). */
export async function touchApiToken(db: D1Database, id: string, now: string): Promise<void> {
  await db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(now, id).run();
}
