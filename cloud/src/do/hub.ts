/**
 * Hub Durable Object -- agent WebSocket channel, panel WebSocket, event bus
 * + dispatch alarm. Ported from the former Python server (agent side, Task
 * 6; panel side incl. `create_ws_router`, Task 7) in 2026-09; this file is
 * now the only implementation. Every function below is named after (and
 * documents its delta from) the Python function it ports. A
 * singleton instance (`idFromName("hub")`) backs the whole deployment -- see
 * progress.md's pre-flight ruling ("ONE Durable Object for agent+panel
 * WS+alarm").
 *
 * Part 1 (Task 6) covers the agent side end-to-end: handshake, hello,
 * heartbeat, inventory, job push, job_done/job_failed with receipt
 * mint+push+ack, blip re-adoption, and the 5s dispatch alarm.
 *
 * Part 2 (Task 7, this pass) adds the panel WebSocket (`/comfy/api/ws` +
 * `/comfy/ws`, session-cookie-gated) and completes the panel event relay:
 * every former Python panel broadcast function (`job_progress`/`job_running`/
 * `job_done`/`job_failed`/`job_requeued`/`job_cancelled`/`job_status_
 * refresh`) is now wired as a direct in-DO method call from the exact
 * agent-handler call site the former Python server called it from -- agent and panel
 * sockets share this one DO, so there is no HTTP hop between them.
 * `/internal/event` (real now, was a 202 stub) is the SEPARATE seam for
 * panel pushes that originate OUTSIDE this DO (Task 8/9's HTTP routes);
 * `/internal/dynamic` (real, backs `queries.getDynamic`) is unrelated to
 * either and was already wired in Task 6. Both `/internal/*` routes are the
 * `/internal/*` surface Task 6 opened for this task and Tasks 8/9 to consume.
 *
 * WebSocket hibernation vs. in-memory state -- the load-bearing design
 * choice for this file:
 *
 *  - DURABLE (survives hibernation eviction + reactivation): worker identity
 *    (`workerId`), the agent's negotiated `protocol` version, and its last
 *    reported `state` (idle/busy/dispatched) -- all needed by the alarm
 *    handler and by any message handler that might run *after* a hibernated
 *    socket wakes back up. These live in `WebSocket.serializeAttachment`,
 *    which Workers caps at 2KB -- comfortably enough for this small,
 *    fixed-shape object.
 *  - EPHEMERAL (in-memory `Map<WebSocket, Ephemeral>`, lost on eviction):
 *    the three bounded dedup/rate-limit sets (`cancelled_jobs_sent`,
 *    `warned_job_ids`, `warned_msg_types` in the Python `_Connection`) plus
 *    the last heartbeat's `dynamic` payload. These are deliberately NOT
 *    persisted: `_BoundedSet`'s cap-512 LRU eviction in Python already
 *    accepts "an old entry can be forgotten and its warning/push re-earned"
 *    as harmless, and hibernation eviction (which reconstructs this DO
 *    instance, resetting the in-memory map) is functionally identical to a
 *    Python process reconnect from the dedup's point of view -- a fresh
 *    agent connection there also starts with brand-new empty
 *    `_BoundedSet`s. Piggybacking the full sets onto `serializeAttachment`
 *    would blow the 2KB cap for any connection with real traffic, for a
 *    "problem" (a rare duplicate `job_cancelled` push, or one extra WARNING
 *    log line) the Python source itself already tolerates.
 */

import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";
import * as queries from "../db/queries";
import * as dispatch from "../core/dispatch";
import * as assess from "../core/assess";
import type { FetchableModels } from "../core/assess";
import * as modelManifest from "../core/model_manifest";
import * as modelFetch from "../core/model_fetch";
import type { FetchEntry } from "../core/model_fetch";
import * as retry from "../core/retry";
import * as stats from "../core/stats";
import * as split from "../core/split";
import * as peerhealth from "../core/peerhealth";
import { toSqliteTimestamp, resolvePlatformSeed } from "../db/queries";
import type { Job } from "../db/queries";
import { buildReceiptPayload, signReceipt, verifyHex } from "../lib/signing";
import { bytesToHex } from "../lib/hex";
import { readSessionCookie } from "../lib/cookies";
import { getOrCreateSessionSecret } from "../db/queries";
import { sessionUserFromPayload } from "../lib/guard";
import { jobOutputs, FALLBACK_OUTPUT_KEY, type JobOutputsInput } from "../core/outputs";
// Single source of truth for the accepted `peer_upload_min_mbps` range, so
// the hello-time gate and the grant-time read-back can never drift apart.
import { MIN_PEER_UPLOAD_MBPS, MAX_PEER_UPLOAD_MBPS } from "../core/peer";

// ---------------------------------------------------------------------------
// Constants (parity with the former Python server's module-level constants)

const AUTH_TIMEOUT_MS = 10_000;
const TICK_INTERVAL_MS = 5_000;
/** 三個握手關閉碼語意不同 -- the handshake uses THREE distinct close codes,
 * parity with the former Python `_CLOSE_UNAUTHORIZED` / `_CLOSE_WORKER_DISABLED` /
 * `_CLOSE_AUTH_TIMEOUT`. The agent acts differently on each (see the agent's
 * `_is_auth_rejected` / `_is_disabled`):
 *
 * 4401 AUTH REJECTED -- PERMANENT: unknown worker id (a soft-deleted worker
 * is filtered out by `getWorkerById`, so it lands here) or a bad signature.
 * The agent gives up on that registration, and prunes it out of agent.json
 * after a SECOND consecutive 4401. */
const CLOSE_UNAUTHORIZED = 4401;
/** 4403 WORKER DISABLED -- REVERSIBLE: an admin disabled this (non-deleted)
 * worker. The agent keeps retrying slowly and NEVER prunes. Also carries the
 * live-socket kick of a soft-deleted worker through `/internal/kick_worker`
 * (see `handleInternalKickWorker`): that agent's next handshake gets the
 * definitive 4401 from the unknown-worker path anyway. */
const CLOSE_WORKER_DISABLED = 4403;
/** 4408 HANDSHAKE TIMEOUT -- TRANSIENT: the auth frame never arrived within
 * `AUTH_TIMEOUT_MS`, or it was malformed. Ordinary retry, never a prune. */
const CLOSE_AUTH_TIMEOUT = 4408;

const DISABLED_REASON = "worker 已停用 / worker disabled";
const AUTH_TIMEOUT_REASON = "握手逾時 / handshake timeout";

/** Minimum `hello.protocol` that guarantees exec_seconds and understands
 * `job_cancelled` pushes -- parity with the former Python `_CURRENT_PROTOCOL`. */
const CURRENT_PROTOCOL = 2;

/** Minimum `hello.protocol` that can receive `fetch_models` at all (predates
 * lazy hashing / lazy inventory sha256) -- parity with the former Python
 * `_MIN_AUTO_FETCH_PROTOCOL`. Duplicated here (rather than exported from
 * `core/assess.ts`, which keeps it private) purely for the defensive
 * re-check right before a push -- see `fetchModelsForPush`. */
const MIN_AUTO_FETCH_PROTOCOL = 3;

const DEPRECATION_MESSAGE =
  "agent 版本過舊：無法接收取消通知，計費將以整體耗時（wall-clock）為準。" +
  "請更新 comfyfed-agent。/ Agent is outdated: cannot receive cancellation " +
  "notices; billing falls back to wall-clock. Please update comfyfed-agent.";

/** Statuses a worker is allowed to transition out of by reporting on a job
 * -- mirrors the former Python OWNED_STATUSES (not exported from core/dispatch.ts,
 * which keeps it as a private module constant; duplicated here rather than
 * exported solely for this one caller). */
const OWNED_STATUSES: readonly string[] = ["assigned", "running"];

/** Cap for every per-connection dedup/rate-limit set -- the former Python
 * `_DEDUP_CAP`. */
const DEDUP_CAP = 512;

/** 2026-09-24 single-stack spec §2.2 -- remote agent update. The console's
 * `POST /api/workers/:id/update` reaches `/internal/update_worker` here; we
 * push `{"type":"update_agent"}` and wait this long for the agent's
 * `{"type":"update_ack","status":...,"detail":...}` before answering
 * `status: "sent"` (the command left, the agent just hasn't spoken yet). */
const UPDATE_ACK_TIMEOUT_MS = 15_000;
/** `update_ack.detail` is free text from the agent; cap what we relay. */
const UPDATE_ACK_DETAIL_MAX = 500;
const UPDATE_ACK_STATUSES = ["updating", "deferred", "up_to_date", "declined", "failed"] as const;
type UpdateAckStatus = (typeof UPDATE_ACK_STATUSES)[number];
interface UpdateAck {
  status: UpdateAckStatus;
  detail: string;
}
const MALFORMED_UPDATE_ACK: UpdateAck = { status: "failed", detail: "malformed ack" };
const OFFLINE_MESSAGE = "worker 不在線上 / worker is not connected";

/** Same key the object_info upload route (`routes/workers.ts`) writes to in
 * R2 -- duplicated rather than imported to avoid a route->DO layering
 * dependency; keep in sync if that route's key ever changes. */
const OBJECT_INFO_DIR = "object_info";

// ---------------------------------------------------------------------------
// Panel WebSocket -- parity with the former Python panel WS module + its
// `create_ws_router` (the `/comfy/api/ws` / `/comfy/ws` handshake).

/** Same cookie name `lib/guard.ts`'s `requireAdmin`/`requireCsrf` middleware
 * checks -- duplicated (rather than imported) because this DO verifies the
 * cookie itself, off the raw upgrade `Request`, with no Hono `Context` to
 * hand `readSession` its usual middleware entrypoint. */
const SESSION_COOKIE_NAME = "cf_session";

/** The node id federation job events report -- ComfyFed jobs are opaque
 * units dispatched to a single worker, not executed node-by-node like
 * upstream ComfyUI, so there is no real per-node id to report while a job is
 * running. Ports the former Python `_RUNNING_NODE_LABEL`. */
const RUNNING_NODE_LABEL = "comfyfed";

/** Sent once, right after the initial `status` message, on every panel
 * connection. All false is the truthful answer for every one of these on
 * ComfyFed -- ports the former Python `FEATURE_FLAGS` verbatim. */
const FEATURE_FLAGS = {
  assets: false,
  node_replacements: false,
  show_signin_button: false,
  "extension.manager.supports_v4": false,
  "extension.manager.supports_csrf_post": false,
} as const;

// ---------------------------------------------------------------------------
// Durable per-connection identity (WebSocket.serializeAttachment)

interface AgentAttachment {
  kind: "agent";
  phase: "handshake" | "ready";
  /** Only set during the handshake phase -- the nonce this connection
   * challenged the agent with. */
  nonce?: string;
  /** null only during the handshake phase. */
  workerId: string | null;
  protocol: number;
  state: "idle" | "busy" | "dispatched" | "paused";
  /** 連續幾次「idle 且沒有 job_id」的心跳 -- 達 `dispatch.ORPHAN_IDLE_BEATS`
   * 就把這台名下仍 assigned/running 的 job 收回排隊（推送掉在斷線的舊
   * socket 上、或 agent 跑到一半重啟）。任何其他形狀的心跳、或一次推送，都
   * 歸零。Durable（和 `state` 一起）：hibernation 醒來後計數不能歸零重數。 */
  idleNoJobBeats?: number;
  /** Phase 3.4 §2：upgrade 請求的 `CF-Connecting-IP`（Cloudflare 提供，
   * 權威，不可偽造）。存在 attachment 裡是因為 hello 是後續的一個訊息，
   * 那時已經沒有原始 `Request` 可以再讀一次 header 了。 */
  remoteIp?: string | null;
}

/** A connected panel (ComfyUI-frontend) client -- ports the former Python
 * `_PanelConnection` (minus its `loop` field, which has no equivalent in a
 * single-threaded DO). No handshake phase: authentication
 * happens once, off the raw upgrade request's cookies, before the socket is
 * ever accepted (see `handlePanelWsUpgrade`).
 *
 * `uid` (Phase 3.0 Task 4/10 parity): the session uid this socket
 * authenticated as, stored in `serializeAttachment` (not a separate
 * in-memory map) so it survives hibernation, matching the convention every
 * other durable per-connection field on `AgentAttachment` already follows.
 * `postPanelEvent` reads it back to scope job-specific frames to this
 * connection's own jobs -- see `panelVisibleTo`. Always set by
 * `handlePanelWsUpgrade` (the socket is never accepted without a resolved
 * session user), unlike Python's `_PanelConnection.uid`, which a same-loop
 * test helper could leave `None`; there is no such unauthenticated-register
 * path here. */
interface PanelAttachment {
  kind: "panel";
  sid: string;
  uid: string;
}

/** Every hibernatable socket this DO hosts carries one of these two shapes,
 * tagged by `kind` -- see the file docstring ("ONE Durable Object for
 * agent+panel WS+alarm") for why both connection kinds share a single
 * `ctx.getWebSockets()` set instead of two separate registries. */
type HubAttachment = AgentAttachment | PanelAttachment;

// ---------------------------------------------------------------------------
// Ephemeral per-connection state (in-memory, see file docstring)

class LRUSet {
  private readonly items = new Map<string, true>();
  constructor(private readonly cap: number) {}
  has(item: string): boolean {
    return this.items.has(item);
  }
  add(item: string): void {
    if (this.items.has(item)) return;
    this.items.set(item, true);
    if (this.items.size > this.cap) {
      const oldest = this.items.keys().next().value;
      if (oldest !== undefined) this.items.delete(oldest);
    }
  }
}

interface Ephemeral {
  cancelledJobsSent: LRUSet;
  warnedJobIds: LRUSet;
  warnedMsgTypes: LRUSet;
  /** Last heartbeat's `dynamic` payload -- backs `/internal/dynamic`
   * (`queries.getDynamic`'s seam). */
  dynamic: Record<string, unknown>;
}

/** 2026-09-19 job-retry §5: what `recordFailedAttempt` learned about one
 * applied failure -- ports the former Python `_FailedAttempt` dataclass. */
interface FailedAttempt {
  /** `{worker_id: failures}` AFTER this attempt was counted. */
  attempts: Record<string, number>;
  /** `{worker_id: last_error}` off the SAME job row -- the only source the
   * terminal summary is allowed to quote (see `finalErrorSummary`). */
  errors: Record<string, string>;
  /** `Σ attempts.values()`, compared against `retry.MAX_JOB_ATTEMPTS`. */
  total: number;
  taskKey: string | null;
  /** The row's `started_at` BEFORE the requeue path clears it. */
  startedAt: string | null;
}

/** Validates an inbound `update_ack` frame (spec §2.2): `status` must be one
 * of the five agreed strings and `detail` a string (truncated to
 * `UPDATE_ACK_DETAIL_MAX`); anything else reads as a `failed` ack so the
 * console never shows a made-up status. Pure -- returns a fresh object. */
function parseUpdateAck(msg: Record<string, unknown>): UpdateAck {
  const status = msg.status;
  if (typeof status !== "string" || !(UPDATE_ACK_STATUSES as readonly string[]).includes(status)) {
    return MALFORMED_UPDATE_ACK;
  }
  const detail = msg.detail === undefined ? "" : msg.detail;
  if (typeof detail !== "string") return MALFORMED_UPDATE_ACK;
  return { status: status as UpdateAckStatus, detail: detail.slice(0, UPDATE_ACK_DETAIL_MAX) };
}

/** TEST-ONLY override for `UPDATE_ACK_TIMEOUT_MS` (see
 * `handleInternalUpdateWorker`): a positive integer no larger than the real
 * deadline; anything else -- including the production route, which never
 * sends one -- means the full 15 s. */
function testOnlyTimeout(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return UPDATE_ACK_TIMEOUT_MS;
  return Math.min(value, UPDATE_ACK_TIMEOUT_MS);
}

function newEphemeral(): Ephemeral {
  return {
    cancelledJobsSent: new LRUSet(DEDUP_CAP),
    warnedJobIds: new LRUSet(DEDUP_CAP),
    warnedMsgTypes: new LRUSet(DEDUP_CAP),
    dynamic: {},
  };
}

// ---------------------------------------------------------------------------
// Small pure helpers

function randomNonceHex(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Extracts one cookie's value from a raw `Cookie` request header --
 * duplicated from `lib/guard.ts`'s private `extractCookie` rather than
 * imported, since that module's public surface (`readSession`) takes a Hono
 * `Context`, which this DO's `fetch(request: Request)` doesn't have. */
function extractCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** Validate `hello.protocol`, defaulting to 1 -- ports the former Python
 * `_parse_protocol`. */
function parseProtocol(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return 1;
  return value;
}

/** Validate hello's optional `max_fetch_gb` (Phase 3.2 F1 fix): a positive
 * finite number, else `null` (missing, wrong type, or non-positive) -- the
 * caller then omits it from what gets stored, and `assess.ts`'s
 * `workerMaxFetchGb` degrades that to the same default the agent itself
 * uses. Ports the former Python `_parse_max_fetch_gb`. */
function parseMaxFetchGb(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Validate hello's optional `peer_upload_min_mbps` (the seeder's slowest
 * configured P2P upload cap, see the agent's `_peer_upload_min_mbps`): a
 * positive finite number, else `null` (missing, null because both caps are
 * unlimited, wrong type, or non-positive). `null` means the caller omits it
 * and `peer.grantTtlSeconds` keeps its default rate assumption -- today's
 * behavior, unchanged. Ports the former Python `_parse_peer_upload_min_mbps`.
 *
 * M2 final-review fix: the value must also lie within
 * [`MIN_PEER_UPLOAD_MBPS`, `MAX_PEER_UPLOAD_MBPS`]. A worker is an
 * authenticated but low-privilege actor and this number is the TTL divisor:
 * `1e-300` would otherwise mint an `expires_at` far past 2^63, which D1 then
 * fails to bind for every later puller of that seeder. */
function parsePeerUploadMinMbps(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  if (value < MIN_PEER_UPLOAD_MBPS || value > MAX_PEER_UPLOAD_MBPS) return null;
  return value;
}

/** Ports the former Python `_is_valid_exec_seconds`. */
function isValidExecSeconds(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Parse a `toSqliteTimestamp`-shaped string back into a `Date`, truncating
 * to millisecond precision (JS has no microsecond clock) -- used only for
 * wall-clock GPU-time arithmetic, never round-tripped back to storage. */
function parseSqliteTimestamp(s: string): Date {
  const [datePart, timePart] = s.split(" ");
  const [hh, mm, rest] = (timePart ?? "00:00:00").split(":");
  const [ss, frac] = (rest ?? "00").split(".");
  const millis = (frac ?? "0").padEnd(6, "0").slice(0, 3);
  return new Date(`${datePart}T${hh}:${mm}:${ss}.${millis}Z`);
}

function secondsBetween(a: string, b: string): number {
  return (parseSqliteTimestamp(b).getTime() - parseSqliteTimestamp(a).getTime()) / 1000;
}

/** 把通告位址收斂成 `scheme://host[:port]`（Phase 3.4 fix round 1）。路徑、
 * query、fragment、userinfo 全部丟掉 —— `peerhealth.healthUrl` 直接在後面接
 * `/peer/health`，而 `seeder_urls` 是直接發給拉方的連線目標。無法解析回
 * null。Ports the former Python `_normalize_advert_url`. */
function normalizeAdvertUrl(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
  // `URL.host` 已經是 host[:port]（預設埠會被省略），而且 IPv6 的中括號和
  // 主機小寫都由 URL 正規化處理掉了。
  return `${parsed.protocol}//${parsed.host}`;
}

/** Validate hello's optional `peer_url` (Phase 3.1 P2P seeder advertisement):
 * must be a string that parses as an http:// or https:// URL with a host.
 * Anything else (missing, wrong type, wrong scheme, no host, a bare path) is
 * ignored -- logged, not stored -- so a malformed or hostile value can never
 * end up handed out as a seeder endpoint. 存下來的是 `normalizeAdvertUrl` 的
 * 正規形。Ports the former Python `_parse_peer_url`. */
function parsePeerUrl(value: unknown, workerId: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    console.warn(`hub: worker ${workerId} hello.peer_url not a string, ignoring`);
    return null;
  }
  const normalized = normalizeAdvertUrl(value);
  if (normalized === null) {
    console.warn(`hub: worker ${workerId} hello.peer_url ${JSON.stringify(value)} is not a valid http(s) URL, ignoring`);
    return null;
  }
  return normalized;
}

/** Ports the former Python `_PEER_NAT_VALUES` / `_parse_peer_nat`. */
const PEER_NAT_VALUES = new Set(["natpmp", "upnp", "manual", "lan", "none"]);

/** Ports the former Python `_parse_peer_lan_url` —— 規則與 `parsePeerUrl` 相同，
 * 存下來的一樣是 `scheme://host[:port]` 正規形。 */
function parsePeerLanUrl(value: unknown, workerId: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    console.warn(`hub: worker ${workerId} hello.peer_lan_url not a string, ignoring`);
    return null;
  }
  const normalized = normalizeAdvertUrl(value);
  if (normalized === null) {
    console.warn(`hub: worker ${workerId} hello.peer_lan_url ${JSON.stringify(value)} is not a valid http(s) URL, ignoring`);
    return null;
  }
  return normalized;
}

/** Ports the former Python `_parse_peer_nat`：非白名單值或缺席一律 "lan"。 */
function parsePeerNat(value: unknown): string {
  return typeof value === "string" && PEER_NAT_VALUES.has(value) ? value : "lan";
}

/** Ports the former Python `_MAX_PLAUSIBLE_MODEL_GB` / `_normalize_models`. */
const MAX_PLAUSIBLE_MODEL_GB = 10_000;

function normalizeModels(models: unknown): unknown[] {
  if (!Array.isArray(models)) return [];
  const out: unknown[] = [];
  for (const entry of models) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const size = e.size;
    if (typeof size === "number" && Number.isFinite(size) && size > MAX_PLAUSIBLE_MODEL_GB) {
      out.push({ ...e, size: Math.round((size / 1024 ** 3) * 1000) / 1000 });
    } else {
      out.push(e);
    }
  }
  return out;
}

/** `(origin, userId)` of the job a panel-scoped event is about -- ports
 * the former Python bare `tuple[str, Optional[str]]` `owner` shape (kept as a
 * named interface here rather than a tuple for readability at call sites). */
interface PanelOwner {
  origin: string;
  userId: string | null;
}

/** Whether a job-scoped frame for `owner` should reach a panel connection
 * whose session uid is `connUid` -- ports the former Python `_visible_to`. The
 * panel is a per-user workspace (Phase 3.0 Task 4), so a job-specific frame
 * (`progress`/`executing`/`executed`/`execution_error`) must only ever reach
 * the socket for the job's OWN panel origin and user, including an admin
 * socket. */
function panelVisibleTo(connUid: string, owner: PanelOwner): boolean {
  return owner.origin === "panel" && owner.userId === connUid;
}

// ---------------------------------------------------------------------------

export class Hub extends DurableObject<Env> {
  /** Handshake auth-timeout timers, keyed by the (not-yet-authenticated)
   * socket -- cleared as soon as the socket sends its `auth` message, closes,
   * or errors. Not attachment/storage state: purely a local guard against a
   * connection that opens and never speaks. */
  private readonly handshakeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>();

  /** See file docstring: ephemeral per-connection dedup/rate-limit state,
   * deliberately not persisted across hibernation eviction. */
  private readonly ephemeral = new Map<WebSocket, Ephemeral>();

  /** job_id -> transient model-auto-fetch progress, for exactly as long as a
   * job is in the pre-run download phase -- ports the former Python
   * `_fetch_progress`. Deliberately NOT DO storage/a D1 column: this is
   * live, second-by-second state that a fresh heartbeat repopulates within
   * one tick, so losing it on eviction is harmless (same "nothing here is
   * worth surviving a restart" reasoning as `ephemeral`). A model-hash
   * CONFLICT, by contrast, is persisted on the `model_hashes` row itself
   * (migration 0005_model_hash_conflict.sql) rather than tracked here --
   * see `core/model_manifest.ts`'s docstring. Read by `routes/jobs.ts`'s
   * `jobDict` via `/internal/fetch_progress` (mirrors `queries.getDynamic`'s
   * seam). */
  private readonly fetchProgress = new Map<
    string,
    { stage: string; fetchPct: number | null; fetchModel: string | null }
  >();

  /** Phase 3.3 §2.6: 這個 DO instance 是否已經嘗試過統計回填。旗標本身存在
   * D1（`stats.BACKFILL_SETTING_KEY`），這只是省掉每個 tick 一次讀取。 */
  private statsBackfillDone = false;

  /** Spec §2.2: worker id -> the `/internal/update_worker` request currently
   * waiting on that worker's `update_ack`. In-memory on purpose (same "not
   * worth surviving eviction" reasoning as `ephemeral`): the waiting HTTP
   * request itself dies with the instance, so there is nothing to resume.
   * At most one waiter per worker -- a second concurrent request for the
   * same worker replaces the first, which then resolves as `sent`. */
  private readonly pendingUpdates = new Map<string, { resolve: (ack: UpdateAck | null) => void }>();

  // -- fetch: HTTP entrypoints (WS upgrade + /internal/*) ------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/agent/ws") {
      return this.handleAgentWsUpgrade(request);
    }
    if (url.pathname === "/comfy/api/ws" || url.pathname === "/comfy/ws") {
      return this.handlePanelWsUpgrade(request);
    }
    if (url.pathname === "/internal/cancel" && request.method === "POST") {
      return this.handleInternalCancel(request);
    }
    if (url.pathname === "/internal/event" && request.method === "POST") {
      return this.handleInternalEvent(request);
    }
    if (url.pathname === "/internal/dynamic" && request.method === "GET") {
      return this.handleInternalDynamic(url);
    }
    if (url.pathname === "/internal/fetch_progress" && request.method === "GET") {
      return this.handleInternalFetchProgress(url);
    }
    if (url.pathname === "/internal/fetch_progress_batch" && request.method === "POST") {
      return this.handleInternalFetchProgressBatch(request);
    }
    if (url.pathname === "/internal/wake" && request.method === "POST") {
      await this.scheduleAlarmIfNeeded();
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/internal/close_panel_for_uid" && request.method === "POST") {
      return this.handleInternalClosePanelForUid(request);
    }
    if (url.pathname === "/internal/kick_worker" && request.method === "POST") {
      return this.handleInternalKickWorker(request);
    }
    if (url.pathname === "/internal/update_worker" && request.method === "POST") {
      return this.handleInternalUpdateWorker(request);
    }
    return new Response("not found", { status: 404 });
  }

  private handleAgentWsUpgrade(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    // Hibernatable from the start -- see file docstring for why the
    // handshake itself is driven through `webSocketMessage` (phase
    // "handshake") rather than a classic `accept()` + blocking receive loop:
    // a hibernatable socket and a classic-`accept()`ed socket are mutually
    // exclusive modes, and every message after the handshake needs to be
    // hibernation-safe anyway.
    this.ctx.acceptWebSocket(server);

    const nonce = randomNonceHex();
    const attachment: AgentAttachment = {
      kind: "agent",
      phase: "handshake",
      nonce,
      workerId: null,
      protocol: 1,
      state: "idle",
      // Phase 3.4 §2：`CF-Connecting-IP` 只有這個原始 upgrade 請求上有。
      remoteIp: request.headers.get("CF-Connecting-IP"),
    };
    server.serializeAttachment(attachment);

    try {
      server.send(JSON.stringify({ type: "challenge", nonce }));
    } catch {
      // Nothing to clean up yet -- the close/error handler (if any) will
      // still fire and evict the (never-added) ephemeral entry.
    }

    // Mirrors the former Python `asyncio.wait_for(..., timeout=_AUTH_TIMEOUT_SECONDS)`:
    // a socket that never completes the handshake is closed unauthorized.
    const timer = setTimeout(() => {
      this.handshakeTimers.delete(server);
      const current = server.deserializeAttachment() as AgentAttachment | null;
      if (current && current.phase === "handshake") {
        // TRANSIENT (parity with the former Python `_close_auth_timeout`): a slow or
        // loaded agent must not be told 4401, which the agent counts towards
        // giving up on (and pruning) the registration.
        this.closeAuthTimeout(server);
      }
    }, AUTH_TIMEOUT_MS);
    this.handshakeTimers.set(server, timer);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Ports the former Python `create_ws_router`'s `panel_ws` handler.
   *
   * Deliberate divergence from the Python source's "accept unconditionally,
   * then close 4401 if the session cookie doesn't check out": Python's own
   * docstring explains that dance is forced by FastAPI/Starlette internals
   * (an `HTTPException` raised mid-handshake doesn't reliably translate into
   * a client-visible close code across versions), which doesn't apply here
   * -- a Workers `fetch` handler can simply answer the upgrade request with
   * a plain 401 `Response` instead of a 101, so the cookie is checked
   * *before* ever creating a `WebSocketPair`. Same outcome (unauthenticated
   * clients never get a live panel socket), a plainer client-visible signal
   * (HTTP 401, not a WS open-then-immediately-4401-close). */
  private async handlePanelWsUpgrade(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const cookieValue = extractCookie(request.headers.get("Cookie"), SESSION_COOKIE_NAME);
    if (!cookieValue) {
      return new Response("unauthorized", { status: 401 });
    }
    const secret = await getOrCreateSessionSecret(this.env.DB);
    const payload = await readSessionCookie(secret, cookieValue);
    const user = await sessionUserFromPayload(this.env.DB, payload);
    if (!user) {
      return new Response("unauthorized", { status: 401 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);

    const sid = randomNonceHex();
    const attachment: PanelAttachment = { kind: "panel", sid, uid: user.uid };
    server.serializeAttachment(attachment);

    try {
      server.send(
        JSON.stringify({ type: "status", data: { status: await this.queueStatus(), sid } })
      );
      // Right after the initial status: the pinned frontend gates a handful
      // of UI affordances on these, and answering unprompted (rather than
      // waiting for a request) matches upstream's own connect behavior --
      // see `FEATURE_FLAGS`'s comment for why every one is false here.
      server.send(JSON.stringify({ type: "feature_flags", data: FEATURE_FLAGS }));
    } catch {
      // A send failure this early means the socket is already gone; nothing
      // else to clean up (no timers, no ephemeral map entry for panel
      // sockets).
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Push `job_cancelled` for every sibling a split cascade just cancelled.
   *
   * Phase 3.3 §3.6: `split.refreshParent` cancels the surviving siblings by
   * writing the same fields `dispatch.cancelJob` writes (ownership release
   * included) rather than calling it, because it is itself reached FROM
   * `cancelJob`/`markFailed` and would recurse. The one thing it cannot do
   * from there is talk to a WebSocket, so it hands back the owners and this
   * is where they get told. Each push is isolated: one dead socket must not
   * stop the rest, and a missed push self-heals on that worker's next
   * message anyway (see `dispatch.cancelJob`). */
  private async pushCascadeCancellations(cancelledOwners: split.CascadeCancelled[]): Promise<void> {
    const seen = new Set<string>();
    for (const [childId, owner] of cancelledOwners) {
      // 同一個 (child, owner) 可能從兩條路徑各被收集一次（呼叫端自己拿到的回傳
      // 值 + refreshParent 的串聯）。`sendJobCancelled` 本身就有每條連線每個 job
      // 的去重，這裡再擋一層是為了連 log 都不要重複。
      if (seen.has(JSON.stringify([childId, owner]))) continue;
      seen.add(JSON.stringify([childId, owner]));
      try {
        const ws = this.findWsForWorker(owner);
        if (!ws) continue;
        const att = ws.deserializeAttachment() as AgentAttachment;
        await this.sendJobCancelled(ws, att, this.ephemeralFor(ws), childId);
      } catch (err) {
        console.warn(`hub: failed to push job_cancelled for split sibling ${childId} owner ${owner}`, err);
      }
    }
  }

  /** Mint a cancelled receipt for every cascaded child that was RUNNING.
   *
   * Phase 3.3 §3.6: the single-job cancel path mints a non-billable
   * `kind="cancelled"` receipt when the job it cancelled was genuinely
   * running, because that worker really did burn GPU time before being told
   * to stop. A split parent has no `started_at` of its own -- the GPU time
   * lives entirely on its children -- so without this the whole family comes
   * out receipt-free and those seconds never reach `gpu_seconds_total` or the
   * contributions report's `unbilled_gpu_seconds`.
   *
   * Runs AFTER `pushCascadeCancellations`, so a worker is told to stop before
   * it is handed the receipt for having stopped; each mint is isolated (a
   * failure here must not cost the other worker its receipt) and uses the
   * same `mintCancelledReceipt` helper and the same wall-clock basis
   * (`started_at` -> now) the single-job path uses. Ports the former Python
   * `_mint_cascade_cancelled_receipts`. */
  private async mintCascadeCancelledReceipts(
    cancelledOwners: split.CascadeCancelled[],
    now: Date
  ): Promise<void> {
    const seen = new Set<string>();
    for (const [childId, owner, startedAt] of cancelledOwners) {
      if (!startedAt || seen.has(childId)) continue;
      seen.add(childId);
      try {
        const { receiptId, payload, platformSig } = await this.mintCancelledReceipt(
          owner,
          childId,
          startedAt,
          now
        );
        this.pushReceiptFrame(owner, receiptId, payload, platformSig, "cancelled", false, "wall");
      } catch (err) {
        console.warn(`hub: failed to mint cancelled receipt for split child ${childId} owner ${owner}`, err);
      }
    }
  }

  private async handleInternalCancel(request: Request): Promise<Response> {
    const body = await request
      .json<{ job_id?: unknown; reason?: unknown }>()
      .catch(() => ({}) as { job_id?: unknown; reason?: unknown });
    const jobId = typeof body.job_id === "string" ? body.job_id : "";
    const reason = typeof body.reason === "string" && body.reason ? body.reason : "cancelled";
    if (!jobId) {
      return Response.json({ error: "missing job_id" }, { status: 400 });
    }

    // Ports the former Python `cancel_and_notify`: snapshot BEFORE cancelling --
    // a cancelled receipt is only ever minted for a job that was genuinely
    // RUNNING (started_at set) at the moment of cancellation.
    const db = this.env.DB;
    const now = new Date();
    const before = await queries.getJobById(db, jobId);
    const cancellable = before !== null && !dispatch.isTerminal(before.status);
    const wasRunning = cancellable && before!.status === "running" && before!.startedAt !== null;
    if (!cancellable) {
      return Response.json({ cancelled: false, worker_id: null });
    }

    // Phase 3.3 §3.6: cancelling a CHILD cascades up (parent + siblings)
    // inside `cancelJob`; `cascadeCancelled` carries back the siblings whose
    // workers still need telling.
    const cascadeCancelled: split.CascadeCancelled[] = [];
    const owner = await dispatch.cancelJob(db, jobId, reason, now, cascadeCancelled);
    this.fetchProgress.delete(jobId);

    if (wasRunning && owner) {
      try {
        const { receiptId, payload, platformSig } = await this.mintCancelledReceipt(
          owner,
          jobId,
          before!.startedAt!,
          now
        );
        this.pushReceiptFrame(owner, receiptId, payload, platformSig, "cancelled", false, "wall");
      } catch (err) {
        console.warn(`hub: failed to mint cancelled receipt for job ${jobId} owner ${owner}`, err);
      }
    }

    if (owner) {
      const ws = this.findWsForWorker(owner);
      if (ws) {
        const att = ws.deserializeAttachment() as AgentAttachment;
        await this.sendJobCancelled(ws, att, this.ephemeralFor(ws), jobId);
      }
    }

    // Phase 3.3 §3.6：取消父 job -> 每個未終止的子 job 一併取消並推送（每個
    // 子 job 走完整的 cancelJob，所有權釋放與 not-owned 自癒都一樣）；取消
    // 子 job -> 上面的 cancelJob 已經透過 refreshParent 讓父與其他兄弟一起
    // 收攤，這裡只剩下把那些兄弟的 owner 通知掉。
    for (const child of await split.childrenOf(db, jobId)) {
      if (child.status === "queued" || child.status === "assigned" || child.status === "running") {
        // 共用同一個收集器，而且**不要**在這裡推。cancelling 第一個子 job 可能
        // 會透過 refreshParent 把其餘兄弟一起收掉；那些兄弟的 owner 只會出現在
        // 收集器裡，而後續的迴圈圈次看到的它們已經是 cancelled，`cancelJob` 回
        // null。早期版本只推 `childOwner`，所以一個被拆成 k 份的 job 被取消時，
        // 只有一台 worker 收得到 `job_cancelled`。
        // `child` 是取消**之前**讀到的那一列，所以 status/startedAt 還是取消
        // 當下的快照 —— 和 `split.refreshParent` 的串聯收的是同一種東西。
        const childStartedAt = child.status === "running" ? child.startedAt : null;
        const childOwner = await dispatch.cancelJob(db, child.id, reason, now, cascadeCancelled);
        if (childOwner) cascadeCancelled.push([child.id, childOwner, childStartedAt]);
      }
    }
    await this.pushCascadeCancellations(cascadeCancelled);
    await this.mintCascadeCancelledReceipts(cascadeCancelled, now);

    // Ports the former Python `cancel_and_notify`: the panel gets told regardless
    // of whether anyone owned the job yet -- unlike the agent push above
    // (which only makes sense if someone owned it), the panel's queue badge
    // needs refreshing either way.
    await this.panelJobCancelled(jobId);

    await this.scheduleAlarmIfNeeded();

    return Response.json({ cancelled: true, worker_id: owner });
  }

  /** Generic panel event-bus entrypoint for callers OUTSIDE this DO (Tasks
   * 8/9's HTTP routes) that need to push a panel event without a job
   * lifecycle transition of their own to hang it off -- everything
   * the former Python panel module's agent-side callers need is wired as a direct in-DO method
   * call instead (see this file's docstring: agent socket handling and the
   * panel WS both live in the same DO, so there is no HTTP hop between
   * them). Body shape: `{"type": string, "data"?: unknown}`, broadcast
   * verbatim -- this endpoint does not interpret or validate event
   * semantics, only relays the envelope Task 8/9 already built. */
  private async handleInternalEvent(request: Request): Promise<Response> {
    const body = await request
      .json<{ type?: unknown; data?: unknown }>()
      .catch(() => ({}) as { type?: unknown; data?: unknown });
    if (typeof body.type === "string") {
      await this.postPanelEvent({ type: body.type, data: body.data });
    }
    return new Response(null, { status: 202 });
  }

  /** Final review finding #6: closes every panel WebSocket attached with the
   * given uid. `users`/`auth` routes bump `session_epoch` on password
   * change/reset/disable but have no direct handle on this DO's live
   * sockets (they run as plain Worker fetch handlers, not DO methods), so
   * they reach the Hub the same way `routes/jobs.ts`'s `wakeHub`/cancel
   * calls do: an HTTP hop to this internal route. Body shape:
   * `{"uid": string}`. Mirrors `panelws.close_for_uid` on the server. */
  private async handleInternalClosePanelForUid(request: Request): Promise<Response> {
    const body = await request.json<{ uid?: unknown }>().catch(() => ({}) as { uid?: unknown });
    const uid = typeof body.uid === "string" ? body.uid : "";
    if (!uid) {
      return Response.json({ error: "missing uid" }, { status: 400 });
    }
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as HubAttachment | null;
      if (!att || att.kind !== "panel" || att.uid !== uid) continue;
      try {
        ws.close(4402, "session epoch bumped");
      } catch (err) {
        console.warn(`hub: failed to close panel socket ${att.sid} for uid ${uid}`, err);
      }
    }
    return new Response(null, { status: 202 });
  }

  /** Closes a soft-deleted worker's live agent socket, if it has one --
   * cloud parity of `agentws.kick_worker`, reached from `routes/workers.ts`'s
   * `DELETE /api/workers/:id` over the same internal-HTTP hop
   * `/internal/close_panel_for_uid` uses (a route runs as a plain Worker
   * fetch handler, with no handle on this DO's live sockets).
   *
   * The handshake gate (`getWorkerById` now filters `deleted`) only stops the
   * NEXT connection attempt; without this, an already-connected agent would
   * keep heartbeating against a worker the console no longer shows. Returns
   * `{kicked}` so the caller/tests can tell "closed a live connection" from
   * "nothing was connected", both of which are success. */
  private async handleInternalKickWorker(request: Request): Promise<Response> {
    const body = await request
      .json<{ worker_id?: unknown }>()
      .catch(() => ({}) as { worker_id?: unknown });
    const workerId = typeof body.worker_id === "string" ? body.worker_id : "";
    if (!workerId) {
      return Response.json({ error: "missing worker_id" }, { status: 400 });
    }
    const ws = this.findWsForWorker(workerId);
    if (!ws) {
      return Response.json({ kicked: false });
    }
    this.ephemeral.delete(ws);
    try {
      // 4403, not 4401: this only tells the agent to stop using THIS socket.
      // Its next handshake finds the row filtered out by `getWorkerById` and
      // gets the definitive 4401 (parity with the former Python `_close_deleted`).
      ws.close(CLOSE_WORKER_DISABLED, "worker deleted");
    } catch (err) {
      // Best-effort, exactly like the supersede-close in the handshake: the
      // row is already flagged deleted, so a socket that is already closing
      // needs nothing undone.
      console.warn(`hub: failed to close agent socket for deleted worker ${workerId}`, err);
    }
    return Response.json({ kicked: true });
  }

  /** Spec §2.2「立刻更新」: pushes `update_agent` to one worker's live socket
   * and relays its `update_ack`. Reached from `routes/workers.ts`'s
   * `POST /api/workers/:id/update` over the same internal-HTTP hop
   * `/internal/kick_worker` uses. Body: `{"worker_id": string}`.
   *
   * Replies:
   *  - 400 -- no `worker_id`.
   *  - 409 `workers.offline` -- no ready socket for that worker.
   *  - 200 `{status, detail}` -- `status` is the agent's ack (`updating |
   *    deferred | up_to_date | declined | failed`), or `sent` with an empty
   *    `detail` when nothing came back within `UPDATE_ACK_TIMEOUT_MS`.
   *
   * `timeout_ms` in the body is TEST-ONLY: it lets the timeout path be
   * exercised without waiting 15 s. The route never forwards it, so a
   * console request always gets the full deadline. */
  private async handleInternalUpdateWorker(request: Request): Promise<Response> {
    const body = await request
      .json<{ worker_id?: unknown; timeout_ms?: unknown }>()
      .catch(() => ({}) as { worker_id?: unknown; timeout_ms?: unknown });
    const workerId = typeof body.worker_id === "string" ? body.worker_id : "";
    if (!workerId) {
      return Response.json({ error: "missing worker_id" }, { status: 400 });
    }
    const ws = this.findWsForWorker(workerId);
    if (!ws) {
      return Response.json({ error: { code: "workers.offline", message: OFFLINE_MESSAGE } }, { status: 409 });
    }
    const timeoutMs = testOnlyTimeout(body.timeout_ms);
    const ackPromise = this.awaitUpdateAck(workerId, timeoutMs);
    try {
      ws.send(JSON.stringify({ type: "update_agent" }));
    } catch (err) {
      // A socket that closed between `findWsForWorker` and `send` is, from
      // the console's point of view, an offline worker.
      console.warn(`hub: failed to push update_agent to worker ${workerId}`, err);
      this.pendingUpdates.get(workerId)?.resolve(null);
      return Response.json({ error: { code: "workers.offline", message: OFFLINE_MESSAGE } }, { status: 409 });
    }
    const ack = await ackPromise;
    return Response.json(ack ?? { status: "sent", detail: "" });
  }

  /** Registers a waiter for `workerId`'s next `update_ack` and resolves it
   * with the ack, or `null` once `timeoutMs` elapses. Displaces (resolves as
   * timed out) any earlier waiter for the same worker so exactly one request
   * ever owns the next ack. */
  private awaitUpdateAck(workerId: string, timeoutMs: number): Promise<UpdateAck | null> {
    this.pendingUpdates.get(workerId)?.resolve(null);
    return new Promise<UpdateAck | null>((resolve) => {
      const timer = setTimeout(() => settle(null), timeoutMs);
      const settle = (ack: UpdateAck | null) => {
        clearTimeout(timer);
        if (this.pendingUpdates.get(workerId)?.resolve === settle) {
          this.pendingUpdates.delete(workerId);
        }
        resolve(ack);
      };
      this.pendingUpdates.set(workerId, { resolve: settle });
    });
  }

  private async handleInternalDynamic(url: URL): Promise<Response> {
    const workerId = url.searchParams.get("worker_id") ?? "";
    const ws = workerId ? this.findWsForWorker(workerId) : null;
    const dynamic = ws ? (this.ephemeral.get(ws)?.dynamic ?? null) : null;
    return Response.json({ dynamic });
  }

  /** Backs `queries.getFetchProgress` -- see `fetchProgress`'s field
   * docstring. */
  private async handleInternalFetchProgress(url: URL): Promise<Response> {
    const jobId = url.searchParams.get("job_id") ?? "";
    const entry = jobId ? (this.fetchProgress.get(jobId) ?? null) : null;
    const progress = entry
      ? { stage: entry.stage, fetch_pct: entry.fetchPct, fetch_model: entry.fetchModel }
      : null;
    return Response.json({ progress });
  }

  /** Backs `queries.getFetchProgressBatch` (2026-09-21 分頁): the same map
   * as `handleInternalFetchProgress`, answered for a whole page of job ids in
   * ONE DO round-trip instead of one per row. Ids with no entry are simply
   * absent from the reply; a malformed body reads as "no ids". */
  private async handleInternalFetchProgressBatch(request: Request): Promise<Response> {
    let ids: string[] = [];
    try {
      const body = (await request.json()) as { job_ids?: unknown };
      if (Array.isArray(body?.job_ids)) ids = body.job_ids.filter((v): v is string => typeof v === "string");
    } catch {
      ids = [];
    }
    const progress: Record<string, { stage: string; fetch_pct: number | null; fetch_model: string | null }> = {};
    for (const jobId of ids) {
      const entry = this.fetchProgress.get(jobId);
      if (entry) progress[jobId] = { stage: entry.stage, fetch_pct: entry.fetchPct, fetch_model: entry.fetchModel };
    }
    return Response.json({ progress });
  }

  // -- Hibernatable WebSocket handlers --------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const hubAttachment = ws.deserializeAttachment() as HubAttachment | null;
    if (!hubAttachment) return;

    if (hubAttachment.kind === "panel") {
      // Panel clients only ever listen; any inbound message -- including
      // the `feature_flags` frame the frontend announces its own
      // capabilities with on open -- is simply discarded, mirroring
      // the former Python `panel_ws` loop (`await websocket.receive_text()`,
      // result never inspected).
      return;
    }

    const attachment = hubAttachment;
    if (attachment.phase === "handshake") {
      await this.handleHandshakeMessage(ws, attachment, message);
      return;
    }

    let parsed: unknown;
    try {
      const text = typeof message === "string" ? message : new TextDecoder().decode(message);
      parsed = JSON.parse(text);
    } catch {
      // Malformed JSON from an authenticated agent -- the former Python server's outer
      // `except Exception` around `_handle_message` swallows this the same
      // way (logged there; logged here via the catch below instead, since
      // there's no msg_type to log yet).
      return;
    }

    const msg = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    const msgType = typeof msg.type === "string" ? msg.type : undefined;
    const ephemeral = this.ephemeralFor(ws);

    try {
      switch (msgType) {
        case "hello":
          await this.handleHello(ws, attachment, msg);
          break;
        case "heartbeat":
          await this.handleHeartbeat(ws, attachment, ephemeral, msg);
          break;
        case "inventory":
          await this.handleInventory(attachment, msg);
          break;
        case "job_done":
          await this.handleJobDone(ws, attachment, ephemeral, msg);
          break;
        case "job_failed":
          await this.handleJobFailed(ws, attachment, ephemeral, msg);
          break;
        case "receipt_ack":
          await this.handleReceiptAck(attachment, msg);
          break;
        case "update_ack":
          this.handleUpdateAck(attachment, msg);
          break;
        default:
          this.logUnknownMessageType(ephemeral, msg.type);
      }
    } catch (err) {
      console.error(`hub: error handling ${msgType ?? "?"} message from worker ${attachment.workerId}`, err);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.clearHandshakeTimer(ws);
    this.ephemeral.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.clearHandshakeTimer(ws);
    this.ephemeral.delete(ws);
  }

  // -- Handshake -------------------------------------------------------------

  /** Ports the former Python `_handshake` (the auth-message half; the challenge
   * itself was already sent in `handleAgentWsUpgrade`). */
  private async handleHandshakeMessage(
    ws: WebSocket,
    attachment: AgentAttachment,
    raw: string | ArrayBuffer
  ): Promise<void> {
    this.clearHandshakeTimer(ws);

    let parsed: unknown;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      parsed = JSON.parse(text);
    } catch {
      // Malformed auth frame -> TRANSIENT (4408), parity with the former Python server.
      this.closeAuthTimeout(ws);
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.closeAuthTimeout(ws);
      return;
    }
    const auth = parsed as Record<string, unknown>;
    if (auth.type !== "auth" || typeof auth.worker_id !== "string" || typeof auth.sig !== "string") {
      this.closeAuthTimeout(ws);
      return;
    }

    // ORDER MATTERS (parity with the former Python `_handshake`). `getWorkerById`
    // already filters `deleted = 0`, so a soft-deleted worker -- which has
    // BOTH deleted AND disabled set -- arrives here as `!worker` and is
    // classified 4401 (permanent, prunable). Only a disabled-and-NOT-deleted
    // worker can reach the 4403 branch, so this must not be reordered into
    // consulting `worker.disabled` first.
    const worker = await queries.getWorkerById(this.env.DB, auth.worker_id);
    if (!worker) {
      this.closeUnauthorized(ws);
      return;
    }
    if (worker.disabled) {
      this.closeDisabled(ws);
      return;
    }

    const ok = await verifyHex(worker.pubkey, new TextEncoder().encode(attachment.nonce ?? ""), auth.sig);
    if (!ok) {
      this.closeUnauthorized(ws);
      return;
    }

    // Supersede any existing connection already registered for this worker.
    // Python's `_connections[worker_id] = conn` dict-overwrite makes this
    // automatic there: a lookup by worker id always returns whichever
    // connection registered last, and the displaced one just lingers,
    // unreferenced, until it errors or the client drops it. This DO instead
    // finds a worker's live connection by enumerating `ctx.getWebSockets()`,
    // which has no such "last write wins" ordering guarantee -- left alone,
    // a still-open older connection for the same worker could race the new
    // one for push delivery (`findWsForWorker` could return either). Close
    // it explicitly so exactly one connection ever answers to this worker id.
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const otherAttachment = other.deserializeAttachment() as HubAttachment | null;
      if (
        otherAttachment &&
        otherAttachment.kind === "agent" &&
        otherAttachment.phase === "ready" &&
        otherAttachment.workerId === worker.id
      ) {
        this.ephemeral.delete(other);
        try {
          other.close(1000, "superseded by a newer connection");
        } catch {
          // Best-effort -- a socket already closing/closed is fine to skip.
        }
      }
    }

    const remoteIp = attachment.remoteIp ?? null;
    const ready: AgentAttachment = {
      kind: "agent",
      phase: "ready",
      workerId: worker.id,
      protocol: 1,
      state: "idle",
      remoteIp,
    };
    ws.serializeAttachment(ready);
    this.ephemeral.set(ws, newEphemeral());

    try {
      ws.send(JSON.stringify({ type: "ready", remote_ip: remoteIp }));
    } catch {
      // Send failure right after accept is vanishingly unlikely and, per
      // the former Python server, not itself fatal to the connection.
    }

    await this.scheduleAlarmIfNeeded();
  }

  private closeUnauthorized(ws: WebSocket): void {
    this.clearHandshakeTimer(ws);
    this.ephemeral.delete(ws);
    try {
      // No reason string -- parity with the former Python `_close_unauthorized`,
      // which calls `websocket.close(code=_CLOSE_UNAUTHORIZED)` with no
      // reason argument at all.
      ws.close(CLOSE_UNAUTHORIZED);
    } catch {
      // The former Python `_close_unauthorized` swallows close failures too.
    }
  }

  /** 4403: an admin disabled this worker -- reversible, so the agent keeps
   * retrying and never prunes. Parity with the former Python `_close_disabled`. */
  private closeDisabled(ws: WebSocket): void {
    this.clearHandshakeTimer(ws);
    this.ephemeral.delete(ws);
    try {
      ws.close(CLOSE_WORKER_DISABLED, DISABLED_REASON);
    } catch {
      // Best-effort, exactly like `closeUnauthorized`.
    }
  }

  /** 4408: the handshake timed out or the auth frame was malformed --
   * transient. Parity with the former Python `_close_auth_timeout`. */
  private closeAuthTimeout(ws: WebSocket): void {
    this.clearHandshakeTimer(ws);
    this.ephemeral.delete(ws);
    try {
      ws.close(CLOSE_AUTH_TIMEOUT, AUTH_TIMEOUT_REASON);
    } catch {
      // Best-effort, exactly like `closeUnauthorized`.
    }
  }

  private clearHandshakeTimer(ws: WebSocket): void {
    const t = this.handshakeTimers.get(ws);
    if (t !== undefined) {
      clearTimeout(t);
      this.handshakeTimers.delete(ws);
    }
  }

  /** Ports the former Python `push_peer_status`：把可連性結論推給 agent
   * （spec §4.3）。送不出去只是少一則通知，絕不影響主流程。 */
  private pushPeerStatus(ws: WebSocket, reachable: boolean, checkedUrl: string): void {
    try {
      ws.send(JSON.stringify({ type: "peer_status", reachable, checked_url: checkedUrl }));
    } catch {
      // socket 已關 / 正在關，忽略。
    }
  }

  /** 排一個背景可連性檢查（spec §4.2）。`waitUntil` 讓它在 hello／heartbeat
   * 的處理回傳之後繼續跑完；`refresh` 自己吞掉所有例外。Ports the former Python
   * `_schedule_peer_check`. */
  private schedulePeerCheck(
    ws: WebSocket,
    workerId: string,
    peerUrl: string,
    opts: { notifyOnChangeOnly: boolean }
  ): void {
    this.ctx.waitUntil(
      peerhealth.refresh(
        this.env.DB,
        workerId,
        peerUrl,
        (reachable, checkedUrl) => this.pushPeerStatus(ws, reachable, checkedUrl),
        { notifyOnChangeOnly: opts.notifyOnChangeOnly }
      )
    );
  }

  // -- hello -------------------------------------------------------------

  /** Ports the former Python `_handle_hello`. */
  private async handleHello(ws: WebSocket, attachment: AgentAttachment, msg: Record<string, unknown>): Promise<void> {
    const protocol = parseProtocol(msg.protocol);
    const workerId = attachment.workerId!;
    const worker = await queries.getWorkerById(this.env.DB, workerId);
    if (!worker) return;

    const hardware =
      typeof msg.hardware === "object" && msg.hardware !== null && !Array.isArray(msg.hardware)
        ? (msg.hardware as Record<string, unknown>)
        : {};
    const backend = typeof msg.backend === "string" ? msg.backend : "";
    const torchVersion = typeof msg.torch_version === "string" ? msg.torch_version : "";
    const nodeClasses = Array.isArray(msg.node_classes) ? (msg.node_classes as unknown[]) : [];
    // Agent-side opt-in for manifest-based model auto-fetch (Phase 2.1's
    // `hello.auto_fetch`; gate consumed by `assess.verdict`'s
    // eligible_after_fetch check). Missing/non-bool degrades to false -- an
    // old or malformed hello must never be read as consent to download.
    const autoFetch = msg.auto_fetch === true;
    // Phase 3.1 P2P seeder advertisement (protocol 4). Fully replaced from
    // this hello, same as every other field above -- an agent that
    // reconnects with peer_serve now off (or an old/malformed value) must
    // not keep a previous session's endpoint alive.
    const peerUrl = parsePeerUrl(msg.peer_url, workerId);
    // Phase 3.4 §3.2：與 peer_url 同批全量取代。
    const peerLanUrl = parsePeerLanUrl(msg.peer_lan_url, workerId);
    const peerNat = parsePeerNat(msg.peer_nat);
    // Phase 3.2 F1 fix: no new column/migration -- `max_fetch_gb` rides
    // inside the same `hardware` JSON blob this hello fully replaces every
    // time, read back by assess.ts's `workerMaxFetchGb`. Omitted entirely
    // when hello didn't report a valid value, so a stale value from a
    // PREVIOUS hello can never survive an agent reconnecting without it.
    const maxFetchGb = parseMaxFetchGb(msg.max_fetch_gb);
    if (maxFetchGb !== null) {
      hardware["max_fetch_gb"] = maxFetchGb;
    }
    // Same no-migration trick for the seeder's slowest P2P upload cap, read
    // back by `peer.seederRateBytesPerSec` when sizing a grant's TTL.
    // Omitted when hello didn't report a usable value, so a stale cap from a
    // PREVIOUS hello can't survive a reconnect.
    const peerUploadMinMbps = parsePeerUploadMinMbps(msg.peer_upload_min_mbps);
    if (peerUploadMinMbps !== null) {
      hardware["peer_upload_min_mbps"] = peerUploadMinMbps;
    }

    // 2026-09-23: a hello carries the worker's CURRENT availability (agent
    // >= 0.1.17). Before, every reconnect was recorded idle and the dispatch
    // tick could push a second job to a worker still rendering its first
    // one, up to a full heartbeat interval later. `busy` is only honoured
    // together with a job id; anything else is idle, as before. Ports
    // the former Python `_handle_hello`.
    const helloJobId = typeof msg.job_id === "string" && msg.job_id ? msg.job_id : null;
    const helloState: AgentAttachment["state"] =
      msg.state === "busy" && helloJobId ? "busy" : msg.state === "paused" ? "paused" : "idle";
    const helloStatus = helloState === "busy" ? "busy" : helloState === "paused" ? "paused" : "online";

    await queries.updateWorkerHello(this.env.DB, workerId, {
      hardware,
      backend,
      torchVersion,
      nodeClasses,
      protocol,
      autoFetch,
      lastSeen: toSqliteTimestamp(new Date()),
      status: helloStatus,
    });
    // Phase 3.4 fix round 1：通告位址「有沒有換」決定要不要重驗。一台 agent
    // 掉線重連送來的是同一個 `peer_url`，上一次的驗證結論仍然成立 —— 全部
    // 作廢再重驗，等於把重連次數變成探針次數。位址真的換了（或以前沒有）
    // 才作廢，其餘交給心跳的 10 分鐘節奏。Parity with the former Python `_handle_hello`.
    const peerUrlChanged = peerUrl !== worker.peerUrl;
    await queries.updateWorkerPeerAdvert(this.env.DB, workerId, {
      peerUrl,
      peerLanUrl,
      peerNat,
      remoteIp: attachment.remoteIp ?? null,
      clearReachability: peerUrlChanged,
    });

    attachment.state = helloState;
    ws.serializeAttachment({ ...attachment, protocol, state: helloState } satisfies AgentAttachment);

    if (protocol < CURRENT_PROTOCOL) {
      try {
        ws.send(JSON.stringify({ type: "deprecation", message: DEPRECATION_MESSAGE }));
      } catch (err) {
        console.error(`hub: failed to send deprecation notice to worker ${workerId}`, err);
      }
    }

    // Phase 3.4 §4.2：可連性檢查不擋 hello。只有在通告位址真的換了（或第一
    // 次出現）時才從 hello 觸發，其餘沿用既有結論、等心跳的 10 分鐘節奏
    // （fix round 1）。hello 觸發的這一次每次都推 peer_status（§4.3）。
    if (peerUrl && peerUrlChanged) {
      this.schedulePeerCheck(ws, workerId, peerUrl, { notifyOnChangeOnly: false });
    } else if (peerUrl && worker.peerReachable !== null) {
      // 位址沒變、庫裡已經有結論（fix round 2）：直接回放，不重探 —— 重啟
      // 後的 agent 才不用在「未知」停留到下一次心跳重測。Parity:
      // the former Python `_handle_hello`.
      this.pushPeerStatus(ws, worker.peerReachable === 1, peerhealth.healthUrl(peerUrl));
    }
  }

  // -- heartbeat -------------------------------------------------------------

  /** Ports the former Python `_handle_heartbeat`. */
  private async handleHeartbeat(
    ws: WebSocket,
    attachment: AgentAttachment,
    ephemeral: Ephemeral,
    msg: Record<string, unknown>
  ): Promise<void> {
    const db = this.env.DB;
    const workerId = attachment.workerId!;
    const worker = await queries.getWorkerById(db, workerId);
    if (!worker) return;

    const state =
      msg.state === "idle" || msg.state === "busy" || msg.state === "paused"
        ? (msg.state as "idle" | "busy" | "paused")
        : undefined;
    const dynamic =
      typeof msg.dynamic === "object" && msg.dynamic !== null && !Array.isArray(msg.dynamic)
        ? (msg.dynamic as Record<string, unknown>)
        : {};
    const now = new Date();
    const newStatus =
      state === "idle" ? "online" : state === "busy" ? "busy" : state === "paused" ? "paused" : worker.status;

    ephemeral.dynamic = dynamic;
    await queries.updateWorkerHeartbeat(db, workerId, { status: newStatus, dynamic, lastSeen: toSqliteTimestamp(now) });

    // Phase 3.4 §4.2：`peer_checked_at` 超過 10 分鐘就重測一次。跟 hello 的
    // 檢查走同一條路徑，差別只在推送條件：心跳的重測只有結論**變了**才推
    // （裁示），免得每 10 分鐘灌一則沒有新資訊的訊息。
    if (worker.peerUrl && peerhealth.needsRecheck(worker.peerCheckedAt, now)) {
      this.schedulePeerCheck(ws, workerId, worker.peerUrl, { notifyOnChangeOnly: true });
    }

    const jobId = typeof msg.job_id === "string" ? msg.job_id : null;
    // 「閒著、沒有 job」的心跳連續計數；前一個狀態是 `dispatched`（推送剛出
    // 去）的那一次也算第一次 -- 要再等一整個心跳週期才會收回。
    const idleNoJobBeats =
      state === "idle" && !jobId ? (attachment.state === "idle" ? (attachment.idleNoJobBeats ?? 0) + 1 : 1) : 0;
    let currentAttachment: AgentAttachment = { ...attachment, idleNoJobBeats };
    if (state) currentAttachment = { ...currentAttachment, state };
    ws.serializeAttachment(currentAttachment);

    let jobNotOwned = false;
    if (jobId) {
      const job = await queries.getJobById(db, jobId);
      if (job && job.workerId === workerId) {
        const progress = msg.progress;
        const progressReported = typeof progress === "number" && Number.isFinite(progress);
        let currentProgress = job.progress;
        if (progressReported) {
          currentProgress = progress as number;
          await queries.updateJobProgress(db, jobId, currentProgress);
          // Phase 3.3 §3.4：父 job 的進度是子 job 的平均，所以每次子 job 回報
          // 進度都要重算一次（不是子 job 的話是 no-op）。只動 progress，不碰
          // 狀態、也不發面板事件（那是 Task 7）。
          await split.refreshParentProgress(db, jobId);
        }

        // Phase 2.1: an agent downloading a missing model before it can run
        // the job it was pushed reports stage="fetching_models" alongside
        // its usual progress -- ports the former Python `_handle_heartbeat`
        // fetch-stage block. Stored transiently (see `fetchProgress`'s
        // docstring) and cleared the moment a heartbeat stops reporting it
        // (the download finished, or this is an older agent that never
        // sends it at all).
        if (msg.stage === "fetching_models") {
          const fetchPct = msg.fetch_pct;
          const fetchModel = msg.fetch_model;
          this.fetchProgress.set(jobId, {
            stage: "fetching_models",
            fetchPct: typeof fetchPct === "number" && Number.isFinite(fetchPct) ? fetchPct : null,
            fetchModel: typeof fetchModel === "string" ? fetchModel : null,
          });
        } else {
          this.fetchProgress.delete(jobId);
        }

        const fetchFields = this.fetchProgress.get(jobId);
        if (progressReported || fetchFields) {
          await this.panelJobProgress(jobId, currentProgress, fetchFields);
        }
      } else {
        jobNotOwned = true;
      }
    }

    // A heartbeat carrying a job_id this worker doesn't (or no longer) own --
    // told once per connection (dedup lives in `sendJobCancelled`).
    if (jobNotOwned && jobId) {
      await this.sendJobCancelled(ws, currentAttachment, ephemeral, jobId);
    }

    // The busy heartbeat carrying job_id is the only signal that execution
    // actually started -- "assigned" becomes "running" here. Called
    // unconditionally (matching the former Python server) so the WARNING/DEBUG split for a
    // foreign job_id still fires/rate-limits on every heartbeat.
    //
    // M1 fix (mirrors the former Python `_handle_heartbeat`): while
    // stage === "fetching_models" the job hasn't started running yet -- it's
    // downloading a prerequisite model, not billable execution. Skipping the
    // running transition here leaves startedAt unset, so a fetch failure's
    // failed receipt reports gpu_seconds 0.0 (no false protocol-violation
    // alarm) and a cancel mid-fetch mints no cancelled receipt at all
    // (download time is never billed, same as cancelling a still-queued
    // job). startedAt is set by the first busy heartbeat that is NOT in the
    // fetch stage, i.e. when the agent actually starts running against
    // ComfyUI.
    if (state === "busy" && jobId && msg.stage !== "fetching_models") {
      await this.applyOwnedTransition(db, jobId, workerId, ["assigned"], ephemeral, async () => {
        await queries.updateJobRunning(db, jobId, toSqliteTimestamp(now));
        // Phase 3.3 §3.4：子 job 動了就重算父 job（不是子 job 的話是 no-op）。
        // 這裡的三個轉移沒有走 `dispatch.markRunning/markDone/markFailed`
        // （它們是 ephemeral 記帳 + panel 推播的宿主），所以推導要自己掛。
        await split.childStatusChanged(db, jobId, now);
        await this.panelJobRunning(jobId);
      });
    }

    // 這台說自己閒著、也沒在跑任何 job，已經連續 `ORPHAN_IDLE_BEATS` 次 --
    // 它名下若還有 assigned/running 的 job，那推送一定沒送到（或 agent 跑到
    // 一半重啟了），收回排隊讓下一個 tick 重派；見 `dispatch.requeueOrphaned`。
    if (idleNoJobBeats >= dispatch.ORPHAN_IDLE_BEATS) {
      currentAttachment = { ...currentAttachment, idleNoJobBeats: 0 };
      ws.serializeAttachment(currentAttachment);
      const orphaned = await dispatch.requeueOrphaned(db, workerId, now);
      if (orphaned.length > 0) {
        console.warn(
          `hub: worker ${workerId} reports idle but still owned ${orphaned.length} job(s); requeued: ${orphaned.join(", ")}`
        );
        for (const orphanId of orphaned) {
          this.fetchProgress.delete(orphanId);
          await this.panelJobRequeued(orphanId);
        }
        await this.panelJobStatusRefresh();
      }
    }

    const reportedHash = typeof msg.object_info_hash === "string" ? msg.object_info_hash : "";
    if (reportedHash) {
      let hasFile = false;
      try {
        hasFile = (await this.env.STORE.head(`${OBJECT_INFO_DIR}/${workerId}.json.gz`)) !== null;
      } catch {
        hasFile = false;
      }
      if (reportedHash !== (worker.objectInfoHash || "") || !hasFile) {
        try {
          ws.send(JSON.stringify({ type: "want_object_info" }));
        } catch (err) {
          console.error(`hub: failed to send want_object_info to worker ${workerId}`, err);
        }
      }
    }
  }

  // -- inventory -------------------------------------------------------------

  /** Ports the former Python `_handle_inventory` / `_normalize_models`. */
  private async handleInventory(attachment: AgentAttachment, msg: Record<string, unknown>): Promise<void> {
    const workerId = attachment.workerId!;
    const worker = await queries.getWorkerById(this.env.DB, workerId);
    if (!worker) return;
    const models = normalizeModels(msg.models);
    await queries.updateWorkerModelInventory(this.env.DB, workerId, models);
    await this.recordModelHashes(workerId, models);
  }

  /** Learn a sha256 for every inventory entry that carries one -- ports
   * the former Python `_record_model_hashes`. `size_bytes` is preferred when the
   * entry carries it (an exact `os.stat().st_size`); entries from an agent
   * that hashes but predates the exact `size_bytes` field fall back to
   * reconstructing it from the rounded-to-3-decimal-places GB `size` --
   * lossy (~1 MB resolution), kept only so those agents' reports aren't
   * dropped outright. A conflict (`recordHash`'s `conflict: true`) is
   * already persisted on the `model_hashes` row by the time this returns --
   * nothing further to track here (fix round 1: replaced the old in-memory
   * `poisonedModelNames` DO field). */
  private async recordModelHashes(workerId: string, models: unknown[]): Promise<void> {
    for (const entry of models) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const e = entry as Record<string, unknown>;

      const sha256 = e.sha256;
      if (typeof sha256 !== "string" || !sha256) continue;
      const name = e.name;
      if (typeof name !== "string" || !name) continue;

      let exactSizeBytes: number;
      const sizeBytes = e.size_bytes;
      if (typeof sizeBytes === "number" && Number.isInteger(sizeBytes) && sizeBytes > 0) {
        exactSizeBytes = sizeBytes;
      } else {
        const size = e.size;
        if (typeof size !== "number" || !Number.isFinite(size)) continue;
        exactSizeBytes = Math.round(size * 1024 ** 3);
      }

      let chunkSha256s: string[] | null = null;
      const rawChunks = e.chunk_sha256s;
      // Bound to what the file size can hold (untrusted input; whole-file
      // hash stays the authority) -- mirrors agentws._record_model_hashes.
      const maxChunks = Math.max(1, Math.ceil(exactSizeBytes / (64 * 1024 * 1024)));
      if (
        Array.isArray(rawChunks) &&
        rawChunks.length > 0 &&
        rawChunks.length <= maxChunks &&
        rawChunks.every((c) => typeof c === "string" && c.length === 64)
      ) {
        chunkSha256s = rawChunks as string[];
      }

      await modelManifest.recordHash(this.env.DB, workerId, name, exactSizeBytes, sha256, chunkSha256s);
    }
  }

  // -- job_done / job_failed --------------------------------------------------

  /** Ports the former Python `_handle_job_done` (incl. blip re-adoption via
   * `dispatch.try_readopt`). */
  private async handleJobDone(
    ws: WebSocket,
    attachment: AgentAttachment,
    ephemeral: Ephemeral,
    msg: Record<string, unknown>
  ): Promise<void> {
    const db = this.env.DB;
    const workerId = attachment.workerId!;
    const jobId = typeof msg.job_id === "string" ? msg.job_id : null;
    const resultFiles = Array.isArray(msg.result_files) ? (msg.result_files as unknown[]) : [];
    const now = new Date();

    const applyDone = () =>
      this.applyOwnedTransition(db, jobId, workerId, OWNED_STATUSES, ephemeral, async () => {
        await queries.updateJobDone(db, jobId!, resultFiles, toSqliteTimestamp(now));
        // Phase 3.3 §3.4：最後一個子 job 完成時父 job 才會翻成 done。
        await split.childStatusChanged(db, jobId!, now);
      });

    let done = await applyDone();
    if (!done && jobId && (await this.jobNotOwnedBy(jobId, workerId))) {
      if (await dispatch.tryReadopt(db, jobId, workerId)) {
        done = await applyDone();
      } else {
        await this.sendJobCancelled(ws, attachment, ephemeral, jobId);
      }
    }

    if (done) {
      // 2026-09-19 model_fetch (spec §9): only a transition that ACTUALLY
      // applied teaches the platform anything -- placed first inside `if
      // (done)`, exactly like the receipt, so a worker cannot educate the
      // platform by sending someone else's job_id.
      const jobKind = await this.learnFetchedModels(workerId, jobId!, msg.fetched_models);
      // 2026-09-19 job-retry §7：跑成功就是最強的反證 -- 這台對這一類任務的
      // 不適任紀錄自動解除。同樣在 `if (done)` 之內，理由和上面一樣。
      await this.clearUnsuitableForJob(workerId, jobId!);
      this.fetchProgress.delete(jobId!);
      // Separate lookup rather than reusing the row `updateJobDone` already
      // touched -- mirrors the former Python `_notify_panel_job_done`: `jobOutputs`
      // needs `resultFiles`/`workflowJson` off the freshly-committed row.
      const freshJob = await queries.getJobById(db, jobId!);
      if (freshJob) await this.panelJobDone(freshJob);

      const execSeconds = isValidExecSeconds(msg.exec_seconds) ? msg.exec_seconds : null;
      // Phase 3.3 §2.3：只有真的完成、且 exec_seconds 有效才進統計。放在收據
      // 之前，因為 recordCompletion 自己吞例外 -- 統計壞掉絕不能少發一張收據。
      //
      // Final-review I1：`parentId` 不為空的子 job 一律跳過。子 job 繼承父 job
      // 的 signature，卻只跑 1/k 批，把它的 exec_seconds 餵進去會讓這個簽章的
      // EWMA 跑到實際全批時間的 1/k，speed_index 也跟著被拉偏。
      // TODO（後續）：幫子 job 算一個含切片長度的自己的簽章（per-child
      // signature including slice length），子 job 就能在自己的簽章下正常計統。
      // Python 端的對應點在 `agentws._record_job_stats`。
      //
      // 2026-09-19 model_fetch (spec §9)：model_fetch 單沒有 signature（也沒有
      // workflow 可執行），進統計只會汙染執行時間預測，所以跳過。
      if (jobKind !== "model_fetch" && !freshJob?.parentId) {
        await stats.recordCompletion(db, workerId, freshJob?.signature ?? null, execSeconds, now);
      }
      await this.createAndPushReceipt(ws, attachment, jobId!, execSeconds, now);
    }
  }

  /** Learn the sha256 a worker measured for the models it just fetched, and
   * return the job's `kind` so the caller can skip the stats path -- ports
   * the former Python `_learn_fetched_models`.
   *
   * Only a `kind=model_fetch` job teaches anything, and only for names in
   * that job's own `required_models`: an unverified-source entry has no hash
   * for the agent to verify against, so the digest it reports here is the
   * platform's FIRST evidence of what the file actually is. `recordHash`'s
   * existing first-seen-wins/conflict rules then apply exactly as they do to
   * an ordinary inventory report -- a second worker disagreeing poisons the
   * name rather than overwriting it.
   *
   * Anything malformed (wrong type, a name this job never asked for, a
   * non-positive size, a sha256 that isn't 64 lowercase hex) is dropped with
   * a warning rather than rejecting the whole message: the fetch itself
   * genuinely completed, and one bad list entry must not cost the worker its
   * receipt. */
  private async learnFetchedModels(workerId: string, jobId: string | null, fetched: unknown): Promise<string> {
    if (!jobId) return "prompt";
    const job = await queries.getJobById(this.env.DB, jobId);
    if (job === null) return "prompt";
    const kind = job.kind || "prompt";
    if (kind !== "model_fetch") return kind;
    const allowed = new Set(job.requiredModels);

    if (!Array.isArray(fetched)) return kind;

    for (const item of fetched) {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        console.warn(
          `hub: ignoring malformed fetched_models item from ${workerId} for job ${jobId}: ${JSON.stringify(item)}`
        );
        continue;
      }
      const entry = item as Record<string, unknown>;
      const name = entry.name;
      const sizeBytes = entry.size_bytes;
      const sha256 = entry.sha256;
      if (
        typeof name !== "string" ||
        !allowed.has(name) ||
        typeof sizeBytes !== "number" ||
        !Number.isInteger(sizeBytes) ||
        sizeBytes <= 0 ||
        typeof sha256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(sha256)
      ) {
        console.warn(
          `hub: ignoring malformed fetched_models item from ${workerId} for job ${jobId}: ${JSON.stringify(item)}`
        );
        continue;
      }
      try {
        await modelManifest.recordHash(this.env.DB, workerId, name, sizeBytes, sha256, null);
      } catch (err) {
        console.error(`hub: recordHash failed for ${name}`, err);
      }
    }

    return kind;
  }

  /**
   * Handle a `job_failed` message: retry on another worker, or give up.
   * Ports the former Python `_handle_job_failed` (+ the `_record_failed_attempt` /
   * `_final_error_summary` / `_any_possible_worker` helpers below).
   *
   * 2026-09-19 job-retry §5. `job_failed` used to be terminal, full stop --
   * one refusal from the only worker that happened to be online killed the
   * job even when a paused GPU box could have run it. Now every applied
   * failure is counted, and the count decides:
   *
   *  * total attempts >= `retry.MAX_JOB_ATTEMPTS`, or no worker in the whole
   *    fleet could ever run it (`anyPossibleWorker`) -> TERMINAL, through the
   *    same `updateJobFailed` + cascade path as before but with a summarized
   *    error, so the split cascade, the panel's `job_failed` and the failure
   *    receipt all behave exactly as they did;
   *  * otherwise -> `dispatch.requeueForRetry`, and the panel is told
   *    `job_requeued` (the same event a stale-worker requeue sends).
   *
   * BOTH paths mint the same non-billable failure receipt they always did:
   * the worker really did burn that time, and whether the platform decided to
   * retry afterwards is none of the receipt's business.
   */
  private async handleJobFailed(
    ws: WebSocket,
    attachment: AgentAttachment,
    ephemeral: Ephemeral,
    msg: Record<string, unknown>
  ): Promise<void> {
    const db = this.env.DB;
    const workerId = attachment.workerId!;
    const jobId = typeof msg.job_id === "string" ? msg.job_id : null;
    const error = typeof msg.error === "string" ? msg.error : "";
    const now = new Date();

    const attempt = await this.recordFailedAttempt(db, jobId, workerId, error, ephemeral, now);
    if (attempt === null) {
      if (jobId && (await this.jobNotOwnedBy(jobId, workerId))) {
        await this.sendJobCancelled(ws, attachment, ephemeral, jobId);
      }
      return;
    }

    const execSeconds = isValidExecSeconds(msg.exec_seconds) ? msg.exec_seconds : null;

    let isFinal = attempt.total >= retry.MAX_JOB_ATTEMPTS;
    if (!isFinal) {
      const job = await queries.getJobById(db, jobId!);
      isFinal = job === null || !(await this.anyPossibleWorker(job));
    }

    if (!isFinal && (await dispatch.requeueForRetry(db, jobId!, workerId, error, now))) {
      // 面板本來以為這張 job 正在跑，而這一次嘗試的 done/failed 事件再也不會
      // 來了 -- 和 `requeueStale` 一樣要清掉 executing 標記。
      this.fetchProgress.delete(jobId!);
      await this.panelJobRequeued(jobId!);
      await this.createAndPushFailureReceipt(ws, attachment, jobId!, execSeconds, now, attempt.startedAt);
      return;
    }

    // 終局。Phase 3.3 §3.6：這件 job 如果是子 job，它的失敗會連坐取消還在跑的
    // 兄弟；那些 worker 要立刻收到 `job_cancelled`，否則得等到下一次心跳落在
    // not-owned 路徑才停下來。連坐只發生在這裡，不發生在上面的 requeue。
    const summary = await this.finalErrorSummary(attempt, workerId, error);
    const cascadeCancelled: split.CascadeCancelled[] = [];
    const applied = await this.applyOwnedTransition(db, jobId, workerId, OWNED_STATUSES, ephemeral, async () => {
      await queries.updateJobFailed(db, jobId!, summary, toSqliteTimestamp(now));
      await split.childStatusChanged(db, jobId!, now, cascadeCancelled);
    });

    if (applied) {
      await this.pushCascadeCancellations(cascadeCancelled);
      // 一致性：被失敗連坐取消的兄弟和被 admin 取消的子 job 一樣真的燒過 GPU，
      // 所以取消當下在跑的那些照樣拿一張 cancelled 收據。
      await this.mintCascadeCancelledReceipts(cascadeCancelled, now);
      this.fetchProgress.delete(jobId!);
      await this.panelJobFailed(jobId!, summary);
      await this.createAndPushFailureReceipt(ws, attachment, jobId!, execSeconds, now);
    }
  }

  /**
   * 2026-09-19 job-retry §5：把這一次失敗記進 `jobs.attempts` 與
   * `worker_task_failures`，回傳決定「requeue 還是終局」所需的快照。Ports
   * the former Python `_record_failed_attempt`.
   *
   * `null` = 這個 worker 此刻並不擁有這張 job（或它已經終局）-- 和既有每一個
   * transition 完全同一道閘門（`dispatch.resolveOwnedJob` ＋ 同一份 warn-once
   * 記錄），所以一個 worker 不可能靠送別人的 job_id 去灌別人的失敗次數。
   *
   * D1 沒有讓我們把兩句 UPDATE 綁進一個交易的 seam（Python 端是同一個 session
   * 的一次 commit），所以順序是刻意的：先寫 `jobs.attempts`（判定終局與排除的
   * 唯一依據），再寫 `worker_task_failures`（只影響跨 job 的冷落）。中間掉電最
   * 壞是少記一筆不適任，不會讓這張 job 的次數永遠追不上上限。
   *
   * `startedAt` 一併帶回來，因為 `requeueForRetry` 會把它清掉，而失敗收據的
   * wall-clock 基準要算的是「這一次嘗試」跑了多久（見
   * `createAndPushFailureReceipt`）。
   */
  private async recordFailedAttempt(
    db: D1Database,
    jobId: string | null,
    workerId: string,
    error: string,
    ephemeral: Ephemeral,
    now: Date
  ): Promise<FailedAttempt | null> {
    if (!jobId) return null;
    const result = await dispatch.resolveOwnedJob(db, jobId, workerId, OWNED_STATUSES);
    if (!result.ok) {
      this.logOwnedJobRefusal(result.reason, jobId, ephemeral);
      return null;
    }
    const job = result.job;
    const key = retry.taskKey(job);
    const [newAttempts, , total] = retry.bumpAttempts(job.attempts, workerId, error);
    await queries.updateJobAttempts(db, jobId, newAttempts);
    await retry.recordFailure(db, workerId, key, error, jobId, now);
    return {
      attempts: retry.attemptsDict(newAttempts),
      errors: retry.attemptErrors(newAttempts),
      total,
      taskKey: key,
      startedAt: job.startedAt,
    };
  }

  /**
   * 終局失敗時寫進 `jobs.error` 的彙整訊息（`retry.summarizeFinalError`）。
   * Ports the former Python `_final_error_summary`.
   *
   * 每台 worker 的「最後錯誤」只來自**這張 job 自己的** `jobs.attempts`
   * （見 `retry` 的 `attemptEntries`）。最初版是從跨 job 累計的
   * `worker_task_failures[W, task_key]` 撈的，那會讓這張 job 的 `error` 引用
   * 到同簽章的**另一張** job（可能屬於另一個使用者）的錯誤字串 -- 既誤導診斷
   * （看起來像是這張 job 在那台上的錯誤），錯誤訊息又常含檔名與路徑，是一條
   * 很細的跨使用者字串外洩路徑。
   *
   * 正在回報的這一台用它手上這個 `error`（和已經寫進去的那一筆相同，只是不必
   * 再讀一次）。還沒有錯誤字串可引的（舊形狀的 attempts 欄）就只列名字。
   *
   * 顯示名取 `workers.name`；worker 列不見了（或這張 job 的 attempts 裡有已經
   * 被硬刪的 id）就退回 id 前 8 字 -- 一個認不出來的 id 也好過整段訊息發不
   * 出去。
   *
   * worker 的列舉順序是 `attempts` 的插入順序，和 Python 的 `list(dict)` 一樣
   * （worker id 都是 uuid，不是 JS 會重排的整數式 key）。
   */
  /**
   * 每個 tick：把「已經 requeue 過、但現在全艦隊沒人可能跑」的 job 終局。
   * Ports the former Python `_sweep_hopeless_retries`.
   *
   * `handleJobFailed` 的「還有人可能嗎」只在失敗當下問一次；之後最後那台
   * 可能的 worker 變 stale／被刪／被停用，這張 job 不會再收到任何事件來重
   * 問。只掃 `retry_count > 0` 的 queued 單（沒失敗過的 job 本來就會等
   * worker 上線，不歸這裡管），對每張用同一個 `anyPossibleWorker` 判定，
   * false 就 `failQueuedJob` + 同樣的彙整訊息（沒有「正在回報的那台」，
   * 所以 workerId 給空字串，每台的錯誤都取 attempts 裡存的）。沒有 worker、
   * 沒有這一次嘗試的收據可發。
   */
  private async sweepHopelessRetries(now: Date): Promise<void> {
    const db = this.env.DB;
    const candidates = await queries.getRequeuedQueuedJobs(db);
    if (candidates.length === 0) return;

    let failedAny = false;
    for (const job of candidates) {
      if (await this.anyPossibleWorker(job)) continue;
      const attempts = retry.attemptsDict(job.attempts);
      const attempt: FailedAttempt = {
        attempts,
        errors: retry.attemptErrors(job.attempts),
        total: Object.values(attempts).reduce((a, b) => a + b, 0),
        taskKey: retry.taskKey(job),
        startedAt: null,
      };
      const summary = await this.finalErrorSummary(attempt, "", "");
      if (!(await queries.failQueuedJob(db, job.id, summary, toSqliteTimestamp(now)))) continue;
      failedAny = true;
      console.warn(`hub: job ${job.id} has no possible worker left; failed: ${summary}`);
      // Phase 3.3 §3.4：子 job 終局失敗 -> 父 job 失敗 + 其他子 job 一起取消。
      const cascadeCancelled: split.CascadeCancelled[] = [];
      await split.childStatusChanged(db, job.id, now, cascadeCancelled);
      await this.pushCascadeCancellations(cascadeCancelled);
      await this.mintCascadeCancelledReceipts(cascadeCancelled, now);
      this.fetchProgress.delete(job.id);
      await this.panelJobFailed(job.id, summary);
    }
    if (failedAny) await this.panelJobStatusRefresh();
  }

  private async finalErrorSummary(attempt: FailedAttempt, workerId: string, error: string): Promise<string> {
    const db = this.env.DB;
    const workerIds = Object.keys(attempt.attempts);
    const names = new Map<string, string>();
    if (workerIds.length > 0) {
      // `getWorkersByIds` deliberately does NOT filter soft-deleted rows --
      // exactly what is wanted here: a worker an admin deleted mid-retry still
      // has a name worth printing. Mirrors the plain `db.Worker` query Python
      // uses.
      for (const w of await queries.getWorkersByIds(db, workerIds)) names.set(w.id, w.name || "");
    }

    const pairs = workerIds.map(
      (wid) =>
        [names.get(wid) || wid.slice(0, 8), wid === workerId ? error : (attempt.errors[wid] ?? "")] as [
          string,
          string,
        ]
    );
    return retry.summarizeFinalError(pairs, attempt.total);
  }

  /**
   * `[fetchableModels, peerOnlyModels, unverifiedModels]` for ONE job -- the
   * same inputs the dispatch tick compiles for the whole sweep, narrowed to
   * the single job `anyPossibleWorker` is asking about. Ports the former Python
   * `_fetch_inputs_for_job`.
   *
   * The signed manifest plus, for a `model_fetch` job, that job's OWN signed
   * entry (minted when the panel's download button was pressed, for a model
   * the real manifest may know nothing about -- see the tick's merge). The
   * real manifest always wins a name collision, exactly as it does there.
   */
  private async fetchInputsForJob(
    job: Job
  ): Promise<[FetchableModels, ReadonlySet<string>, ReadonlySet<string>]> {
    const db = this.env.DB;
    let fetchable: FetchableModels = {};
    let peerOnly: ReadonlySet<string> = new Set<string>();
    const unverified = new Set<string>();

    try {
      const seed = await resolvePlatformSeed(db, this.env.PLATFORM_ED25519_SEED);
      const entries = await modelManifest.entries(db, this.env.STORE, seed);
      for (const e of entries) fetchable[e.name] = e.size_bytes;
      peerOnly = modelManifest.peerOnlyNames(entries);
    } catch (err) {
      console.error("hub: failed to build the fetch manifest for a retry decision", err);
      fetchable = {};
      peerOnly = new Set<string>();
    }

    if ((job.kind || "prompt") === "model_fetch" && job.fetchEntry) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(job.fetchEntry);
      } catch {
        parsed = null;
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const entry = parsed as Record<string, unknown>;
        const name = entry.name;
        const sizeBytes = entry.size_bytes;
        if (
          typeof name === "string" &&
          name &&
          !(name in fetchable) &&
          typeof sizeBytes === "number" &&
          Number.isInteger(sizeBytes) &&
          sizeBytes > 0
        ) {
          fetchable[name] = sizeBytes;
          if (modelFetch.isUnverifiedEntry(entry)) unverified.add(name);
        }
      }
    }

    return [fetchable, peerOnly, unverified];
  }

  /**
   * 2026-09-19 job-retry §6：這艘艦隊裡還有任何一台**有可能**跑得動這張 job
   * 嗎？Ports the former Python `_any_possible_worker`.
   *
   * 「有可能」刻意比「現在可以」寬得多：掃的是每一台未刪除、未停用的 worker
   * -- 不論 online／offline／paused，也不論此刻在不在忙。線上那一刻的狀態不是
   * 重點，重點是「等下去到底有沒有希望」：這整個功能的起因就是唯一在線的那台
   * （無 GPU 的 Mac）一直失敗，而真正跑得動的 RTX 卡當時是暫停中。離線 worker
   * 的 `dynamic`（free_disk 之類）可能過期，就照它最後回報的值判 -- 寧可讓 job
   * 多等一輪，也不要因為一個過期的數字把它判死。
   *
   * `eligible_after_fetch` 同樣算數（spec §2 目標 1：「不因為別台沒有模型就放
   * 棄」），所以缺模型但有開 auto_fetch 的 worker 會讓 job 繼續等下去。
   *
   * 排除集合和派工那邊同一份定義：這張 job 自己的 `attempts` 達門檻的 worker，
   * 加上生效中的不適任紀錄。全部被排除、或全艦隊本來就沒人跑得動（缺節點、
   * VRAM 不夠、模型哪裡都抓不到）-> false -> 立刻終局失敗，不必等
   * `MAX_JOB_ATTEMPTS`。
   */
  private async anyPossibleWorker(job: Job): Promise<boolean> {
    const db = this.env.DB;
    const now = new Date();
    const needs = assess.needsFromJob(job);
    const key = retry.taskKey(job);

    // `getAllWorkers` = 未刪除（Python 的 `jobs._live_workers`）；再濾掉
    // `disabled`（admin 停用的那台在 spec §6 的定義裡不算「已註冊、未停用」的
    // 候選）。`status`／`last_seen` 一律不看。
    // `last_seen` 另外用來剔除太久沒心跳的（`retry.POSSIBLE_WORKER_STALE_DAYS`）：
    // 一筆再也不會回來的舊註冊不能讓 job 永遠 queued（線上 2026-09-19 就是這
    // 樣卡住）。
    const workers = (await queries.getAllWorkers(db)).filter((w) => !w.disabled && !retry.isStaleWorker(w, now));
    const exclusions = await retry.activeUnsuitable(db, now);
    retry.addJobAttemptExclusions(exclusions, job.id, job.attempts);

    const [fetchable, peerOnly, unverified] = await this.fetchInputsForJob(job);
    const isModelFetch = (job.kind || "prompt") === "model_fetch";

    for (const worker of workers) {
      // `dispatch.assignJobs` 的 kind 閘門：model_fetch 單只有 protocol>=5 的
      // agent 跑得動，舊 agent 會去跑 `{}` 佔位工作流然後失敗。
      if (isModelFetch && !assess.modelFetchProtocolOk(worker)) continue;
      const v = assess.verdict(worker, needs, job.requirements, [], fetchable, peerOnly, unverified, {
        jobId: job.id,
        taskKey: key,
        exclusions,
      });
      if (v.kind === "eligible" || v.kind === "eligible_after_fetch") return true;
    }
    return false;
  }

  /**
   * §7：這台 worker 成功跑完這一類任務 -> 自動解除它對這一類的不適任紀錄。
   * Ports the former Python `_clear_unsuitable_for_job`.
   *
   * 只在 `job_done` 且 transition 真的套用時呼叫（和收據、統計同一個閘門）。
   * 吞掉例外只記 log -- 解除失敗最壞就是那台多被冷落幾天，絕不能因此少發一張
   * 收據或讓整條 job_done 路徑炸掉。
   */
  private async clearUnsuitableForJob(workerId: string, jobId: string | null): Promise<void> {
    if (!jobId) return;
    try {
      const job = await queries.getJobById(this.env.DB, jobId);
      if (job === null) return;
      const key = retry.taskKey(job);
      if (!key) return;
      await retry.clearFailure(this.env.DB, workerId, key);
    } catch (err) {
      console.error(`hub: failed to clear the unsuitable record for worker ${workerId} job ${jobId}`, err);
    }
  }

  private async jobNotOwnedBy(jobId: string, workerId: string): Promise<boolean> {
    const job = await queries.getJobById(this.env.DB, jobId);
    return job === null || job.workerId !== workerId;
  }

  // -- Owned-job gate + logging (dispatch.ts's pure OwnedJobRefusal, wired
  //    to the WARNING-once/DEBUG-after rate limiting the former Python
  //    `_resolve_warn_level` implements) ----------------------------------

  private async applyOwnedTransition(
    db: D1Database,
    jobId: string | null,
    workerId: string,
    statuses: readonly string[],
    ephemeral: Ephemeral,
    action: () => Promise<void>
  ): Promise<boolean> {
    const result = await dispatch.resolveOwnedJob(db, jobId, workerId, statuses);
    if (!result.ok) {
      this.logOwnedJobRefusal(result.reason, jobId, ephemeral);
      return false;
    }
    await action();
    return true;
  }

  private logOwnedJobRefusal(
    reason: dispatch.OwnedJobRefusal,
    jobId: string | null | undefined,
    ephemeral: Ephemeral
  ): void {
    // "not_owner_stale_terminal" / "wrong_status_transient" are the former Python server's
    // always-DEBUG branches -- they never touch `warned_job_ids` either (see
    // `_resolve_warn_level`'s docstring on why that matters).
    const alwaysDebug = reason === "not_owner_stale_terminal" || reason === "wrong_status_transient";
    let warn: boolean;
    if (alwaysDebug) {
      warn = false;
    } else if (!jobId) {
      warn = true;
    } else if (ephemeral.warnedJobIds.has(jobId)) {
      warn = false;
    } else {
      ephemeral.warnedJobIds.add(jobId);
      warn = true;
    }
    const line = `hub: owned-job refusal (${reason}) for job ${jobId ?? "<none>"}`;
    if (warn) console.warn(line);
    else console.debug(line);
  }

  /** Spec §2.2: the agent's answer to `update_agent`. Logged at info level
   * whether or not a `/internal/update_worker` request is still waiting --
   * an ack that arrives after the 15 s deadline is still the only record of
   * what the agent decided. Never touches the unknown-message warning path
   * (see the `update_ack` case in `webSocketMessage`). */
  private handleUpdateAck(attachment: AgentAttachment, msg: Record<string, unknown>): void {
    const workerId = attachment.workerId!;
    const ack = parseUpdateAck(msg);
    console.info(`hub: update_ack from worker ${workerId}: ${ack.status}${ack.detail ? ` (${ack.detail})` : ""}`);
    this.pendingUpdates.get(workerId)?.resolve(ack);
  }

  private logUnknownMessageType(ephemeral: Ephemeral, msgType: unknown): void {
    const key = typeof msgType === "string" ? msgType : JSON.stringify(msgType);
    const warn = !ephemeral.warnedMsgTypes.has(key);
    ephemeral.warnedMsgTypes.add(key);
    const line = `hub: unknown message type ${JSON.stringify(msgType)}`;
    if (warn) console.warn(line);
    else console.debug(line);
  }

  // -- job_cancelled push (dedup) ---------------------------------------------

  /** Ports the former Python `_send_job_cancelled`. */
  private async sendJobCancelled(
    ws: WebSocket,
    attachment: AgentAttachment,
    ephemeral: Ephemeral,
    jobId: string
  ): Promise<void> {
    if (!jobId || ephemeral.cancelledJobsSent.has(jobId)) return;
    if (attachment.protocol < CURRENT_PROTOCOL) return;
    ephemeral.cancelledJobsSent.add(jobId);
    try {
      ws.send(JSON.stringify({ type: "job_cancelled", job_id: jobId }));
    } catch (err) {
      console.error(`hub: failed to send job_cancelled to worker ${attachment.workerId} for job ${jobId}`, err);
    }
  }

  // -- Receipts ----------------------------------------------------------

  private async mintReceipt(
    jobId: string,
    workerId: string,
    gpuSeconds: number,
    kind: string,
    billable: boolean,
    basis: string,
    now: Date
  ): Promise<{ receiptId: string; payload: string; platformSig: string }> {
    const seed = await resolvePlatformSeed(this.env.DB, this.env.PLATFORM_ED25519_SEED);
    const { payload, signatureHex } = await signReceipt(seed, jobId, workerId, gpuSeconds);
    const receiptId = crypto.randomUUID();
    await queries.insertReceipt(this.env.DB, {
      id: receiptId,
      jobId,
      workerId,
      gpuSeconds,
      platformSig: signatureHex,
      createdAt: toSqliteTimestamp(now),
      kind,
      billable,
      basis,
    });
    return { receiptId, payload, platformSig: signatureHex };
  }

  /** Ports the former Python `_create_and_push_receipt`.
   *
   * 2026-09-19 model_fetch (spec §4/§9): a `kind=model_fetch` job runs no
   * workflow at all -- the agent spends the whole job in `fetching_models`
   * and never sets `started_at` -- so it short-circuits every measurement
   * below to `gpuSeconds=0`, `kind="model_fetch"`, `basis="model_fetch"`,
   * `billable=false`. The protocol-violation error is deliberately NOT logged
   * for it: "no exec_seconds despite having started" is the contract for this
   * kind, not an agent breaking one. */
  private async createAndPushReceipt(
    ws: WebSocket,
    attachment: AgentAttachment,
    jobId: string,
    execSeconds: number | null,
    now: Date
  ): Promise<void> {
    const job = await queries.getJobById(this.env.DB, jobId);
    if (!job) return;

    const isModelFetch = (job.kind || "prompt") === "model_fetch";

    let wallSeconds = 0;
    if (job.startedAt && job.finishedAt) wallSeconds = secondsBetween(job.startedAt, job.finishedAt);

    let gpuSeconds: number;
    let basis: string;
    if (isModelFetch) {
      gpuSeconds = 0;
      basis = "model_fetch";
    } else if (execSeconds !== null) {
      gpuSeconds = Math.min(execSeconds, wallSeconds);
      basis = "exec";
    } else {
      gpuSeconds = wallSeconds;
      basis = "wall";
      if (attachment.protocol >= CURRENT_PROTOCOL && job.startedAt) {
        console.error(
          `hub: protocol violation: job ${jobId} from worker ${attachment.workerId} ` +
            `(protocol ${attachment.protocol}) has no valid exec_seconds despite having started; ` +
            `billing the wall-clock span instead`
        );
      } else {
        console.info(
          `hub: job ${jobId} has no valid exec_seconds from worker ${attachment.workerId}, ` +
            `billing the wall-clock span instead`
        );
      }
    }
    gpuSeconds = Math.max(0, gpuSeconds);

    const kind = isModelFetch ? "model_fetch" : "completed";
    const billable = !isModelFetch;

    const { receiptId, payload, platformSig } = await this.mintReceipt(
      jobId,
      attachment.workerId!,
      gpuSeconds,
      kind,
      billable,
      basis,
      now
    );
    this.pushReceiptFrame(attachment.workerId!, receiptId, payload, platformSig, kind, billable, basis, ws);
  }

  /** Ports the former Python `_create_and_push_failure_receipt`.
   *
   * 2026-09-19 job-retry: on the REQUEUE path the row has already been reset
   * (`started_at=NULL`, spec §5) by the time this runs, so the caller hands
   * over the `startedAt` value it captured before the reset. Every other
   * caller omits it and the row is read exactly as before. */
  private async createAndPushFailureReceipt(
    ws: WebSocket,
    attachment: AgentAttachment,
    jobId: string,
    execSeconds: number | null,
    now: Date,
    startedAt?: string | null
  ): Promise<void> {
    const job = await queries.getJobById(this.env.DB, jobId);
    if (!job) return;

    const runStartedAt = startedAt ?? job.startedAt;

    let gpuSeconds: number;
    let basis: "exec" | "wall";
    if (execSeconds !== null && runStartedAt) {
      gpuSeconds = execSeconds;
      // 2026-09-19 job-retry: the cap used to key off `finished_at`, which the
      // terminal path always stamps -- but the REQUEUE path never does (a
      // requeued job has no end, it goes back in the queue). Cap against "now"
      // in that case, or an agent could inflate `unbilled_gpu_seconds` without
      // bound simply by failing a job that is going to be retried anyway. The
      // terminal path is unchanged: `finished_at` is set by then and still
      // wins.
      const spanEnd = job.finishedAt ?? toSqliteTimestamp(now);
      gpuSeconds = Math.min(gpuSeconds, secondsBetween(runStartedAt, spanEnd));
      basis = "exec";
    } else {
      let wallSeconds = 0;
      if (runStartedAt) {
        const end = job.finishedAt ?? toSqliteTimestamp(now);
        wallSeconds = secondsBetween(runStartedAt, end);
        if (attachment.protocol >= CURRENT_PROTOCOL) {
          console.error(
            `hub: protocol violation: job ${jobId} from worker ${attachment.workerId} ` +
              `(protocol ${attachment.protocol}) has no valid exec_seconds despite having started; ` +
              `billing the wall-clock span instead`
          );
        }
      }
      gpuSeconds = wallSeconds;
      basis = "wall";
    }
    gpuSeconds = Math.max(0, gpuSeconds);

    const { receiptId, payload, platformSig } = await this.mintReceipt(
      jobId,
      attachment.workerId!,
      gpuSeconds,
      "failed",
      false,
      basis,
      now
    );
    this.pushReceiptFrame(attachment.workerId!, receiptId, payload, platformSig, "failed", false, basis, ws);
  }

  /** Ports the former Python `_mint_cancelled_receipt` (the gpu_seconds math
   * half; the caller -- `handleInternalCancel` -- supplies the pre-cancel
   * `started_at` snapshot, since `cancelJob` has already cleared ownership
   * by the time this runs). */
  private async mintCancelledReceipt(
    workerId: string,
    jobId: string,
    startedAt: string,
    now: Date
  ): Promise<{ receiptId: string; payload: string; platformSig: string }> {
    const end = toSqliteTimestamp(now);
    const gpuSeconds = Math.max(0, secondsBetween(startedAt, end));
    return this.mintReceipt(jobId, workerId, gpuSeconds, "cancelled", false, "wall", now);
  }

  /** Ports the former Python `_push_receipt_frame` (minus the cross-event-loop
   * dance, which has no equivalent in a single-threaded DO). */
  private pushReceiptFrame(
    workerId: string,
    receiptId: string,
    payload: string,
    platformSig: string,
    kind: string,
    billable: boolean,
    basis: string,
    ws?: WebSocket
  ): void {
    const target = ws ?? this.findWsForWorker(workerId);
    if (!target) {
      console.info(`hub: worker ${workerId} not connected, deferring receipt ${receiptId} push (kind=${kind})`);
      return;
    }
    try {
      target.send(
        JSON.stringify({
          type: "receipt",
          receipt_id: receiptId,
          payload,
          platform_sig: platformSig,
          kind,
          billable,
          basis,
        })
      );
    } catch (err) {
      console.error(`hub: failed to push receipt ${receiptId} to worker ${workerId}`, err);
    }
  }

  /** Ports the former Python `_handle_receipt_ack`. */
  private async handleReceiptAck(attachment: AgentAttachment, msg: Record<string, unknown>): Promise<void> {
    const receiptId = msg.receipt_id;
    const workerSig = msg.worker_sig;
    if (typeof receiptId !== "string" || typeof workerSig !== "string") return;

    const db = this.env.DB;
    const workerId = attachment.workerId!;
    const receipt = await queries.getReceiptById(db, receiptId);
    if (!receipt || receipt.workerId !== workerId) {
      console.warn(`hub: receipt_ack for unknown/foreign receipt ${receiptId} from worker ${workerId}`);
      return;
    }

    // Deliberately UNFILTERED (review L7): this is a ledger write, not a live
    // path. If the admin deleted this worker while its ack was in flight (the
    // delete route's fire-and-forget kick normally closes the socket first,
    // but it can lose the race or fail), dropping the ack would leave the
    // receipt's `worker_sig` NULL forever. The signature below is still
    // verified against the row's pubkey, so a deleted worker gains nothing
    // beyond acking a receipt it had already been issued.
    const worker = await queries.getWorkerByIdIncludingDeleted(db, workerId);
    if (!worker) return;

    // Phase 3.1: a p2p_upload receipt (job_id NULL) is never pushed over
    // this WebSocket -- it's minted synchronously by `routes/peer.ts`'s
    // `POST /api/agent/peer-served` and never acked here at all. Guard
    // defensively rather than pass null where `buildReceiptPayload` expects
    // a job id.
    if (receipt.jobId === null) {
      console.warn(`hub: receipt_ack for job-less receipt ${receiptId} (kind=${receipt.kind}) from worker ${workerId}`);
      return;
    }

    const payload = buildReceiptPayload(receipt.jobId, receipt.workerId, receipt.gpuSeconds);
    const ok = await verifyHex(worker.pubkey, new TextEncoder().encode(payload), workerSig);
    if (!ok) {
      console.warn(`hub: invalid receipt_ack signature for receipt ${receiptId} from worker ${workerId}`);
      return;
    }

    await queries.updateReceiptWorkerSig(db, receiptId, workerSig);
  }

  // -- Dispatch alarm ----------------------------------------------------

  /** One iteration of the dispatch loop -- ports the former Python
   * `dispatch_tick`. */
  private async tick(): Promise<void> {
    const db = this.env.DB;
    const now = new Date();

    // Phase 3.3 §2.6：第一次 tick 時把 worker_job_stats 從最近 500 筆完成
    // 收據補起來（`stats_backfilled` 旗標，跨 DO 重啟只會做一次）。
    // `statsBackfillDone` 是 per-instance 的短路，避免每個 tick 都去讀旗標。
    if (!this.statsBackfillDone) {
      try {
        await stats.backfillIfNeeded(db);
        // Final-review I3：只有成功才設短路旗標。失敗時 D1 裡的
        // `stats_backfilled` 也還沒設（backfillIfNeeded 只在寫入成功後才寫
        // 旗標），所以下一個 tick 會完整重試一次。
        this.statsBackfillDone = true;
      } catch (err) {
        console.error("hub: stats backfill failed", err);
      }
    }

    let requeued: string[] = [];
    try {
      requeued = await dispatch.requeueStale(db, now);
    } catch (err) {
      console.error("hub: requeueStale failed", err);
    }

    // A requeue is invisible from the panel's side otherwise: the frontend
    // still believes the job is executing, and the done/failed event that
    // would have cleared it is never coming for that attempt. Clear the
    // executing marker per job, then refresh the queue badge once -- ports
    // the former Python `dispatch_tick`'s post-`requeue_stale` panel relay.
    if (requeued.length > 0) {
      try {
        for (const jobId of requeued) {
          this.fetchProgress.delete(jobId);
          await this.panelJobRequeued(jobId);
        }
        await this.panelJobStatusRefresh();
      } catch (err) {
        console.error("hub: failed to relay requeued jobs to the panel", err);
      }
    }

    try {
      await this.sweepHopelessRetries(now);
    } catch (err) {
      console.error("hub: hopeless-retry sweep failed", err);
    }

    const idleWorkerIds: string[] = [];
    // 2026-09-23 cross-backend §3: the workers currently executing a job are
    // candidates to WAIT for (`scheduler.applyHolds`) -- ports the former Python
    // `busy_worker_ids` (connection state busy/dispatched).
    const busyWorkerIds: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as HubAttachment | null;
      if (!att || att.kind !== "agent" || att.phase !== "ready" || !att.workerId) continue;
      if (att.state === "idle") {
        idleWorkerIds.push(att.workerId);
      } else if (att.state === "busy" || att.state === "dispatched") {
        busyWorkerIds.push(att.workerId);
      }
    }

    // Compiled ONCE per sweep, not per candidate/job -- ports the former Python
    // `dispatch_tick`: `fetchableModels` (name -> size_bytes) feeds
    // `assess.verdict` inside `assignJobs`'s ranking AND the per-push
    // recompute below; `manifestByName` (name -> full signed entry) is what
    // actually gets embedded in a `fetch_models` push once a name is
    // confirmed missing. Skipped entirely unless there is BOTH an idle
    // worker to dispatch to AND a queued job for it to be dispatched against
    // this tick (the common case): `assignJobs` is a no-op without both, so
    // building the manifest (a source/harvest R2 scan plus a D1 read) would
    // be pure waste -- a cloud-only efficiency note, not a behavior change.
    let fetchableModels: FetchableModels = {};
    let manifestByName = new Map<string, FetchEntry>();
    let peerOnlyModels: ReadonlySet<string> = new Set();
    let unverifiedModels: ReadonlySet<string> = new Set();
    const hasQueuedWork = idleWorkerIds.length > 0 && (await queries.getQueuedJobsForDispatch(db)).length > 0;
    if (hasQueuedWork) {
      try {
        const seed = await resolvePlatformSeed(db, this.env.PLATFORM_ED25519_SEED);
        const manifestEntries = await modelManifest.entries(db, this.env.STORE, seed);
        for (const e of manifestEntries) {
          fetchableModels[e.name] = e.size_bytes;
          manifestByName.set(e.name, e);
        }
        peerOnlyModels = modelManifest.peerOnlyNames(manifestEntries);
      } catch (err) {
        console.error("hub: failed to build fetch manifest for dispatch tick", err);
        fetchableModels = {};
        manifestByName = new Map();
        peerOnlyModels = new Set();
      }
    }

    // 2026-09-19 model_fetch (spec §7): a panel-download job carries its OWN
    // signed entry, minted when the button was pressed for a model the real
    // manifest knows nothing about. Merge those in so `assess` can see the
    // name as fetchable at all. Deliberately OUTSIDE the manifest `try` above
    // -- the job entry is self-contained (it was signed at creation time and
    // is stored on the row), so it must still dispatch when the real manifest
    // build failed or simply came back empty.
    //
    // The real manifest ALWAYS wins on a name collision: a verified,
    // content-addressed entry (curated hash or learned consensus) is strictly
    // better than an unverified-source one, and by the time a model_fetch job
    // reaches dispatch the platform may well have learned the hash from some
    // other worker's inventory report.
    if (hasQueuedWork) {
      try {
        const unverified = new Set<string>();
        for (const j of await queries.getQueuedModelFetchJobs(db)) {
          if (!j.fetchEntry) continue;
          let parsed: unknown;
          try {
            parsed = JSON.parse(j.fetchEntry);
          } catch {
            console.warn(`hub: model_fetch job ${j.id} has an unparseable fetch_entry`);
            continue;
          }
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
          const entry = parsed as Record<string, unknown>;
          const name = entry.name;
          const sizeBytes = entry.size_bytes;
          if (
            typeof name !== "string" ||
            !name ||
            manifestByName.has(name) ||
            typeof sizeBytes !== "number" ||
            !Number.isInteger(sizeBytes) ||
            sizeBytes <= 0
          ) {
            // One unusable row must not cost every OTHER queued model_fetch
            // job its dispatch, so this skips rather than letting the whole
            // merge fall into the catch below.
            continue;
          }
          manifestByName.set(name, entry as unknown as FetchEntry);
          fetchableModels[name] = sizeBytes;
          if (modelFetch.isUnverifiedEntry(entry)) unverified.add(name);
        }
        unverifiedModels = unverified;
      } catch (err) {
        console.error("hub: failed to merge model_fetch job entries", err);
      }
    }

    // 2026-09-19 job-retry §6：排除集合一個 tick 建一次，整批傳進
    // `assignJobs`。兩種來源：生效中的 (worker, task_key) 不適任紀錄，加上每張
    // queued job 自己的 `attempts` 裡已達門檻的 (worker, job_id)。和上面的
    // manifest 一樣掛在 `hasQueuedWork` 之下 —— 沒活可派的時候多掃兩張表是純
    // 粹的浪費（alarm 每 5 秒跑一次）。Ports the same block in the former Python
    // `dispatch_tick`.
    let exclusions: assess.ExclusionSet = new Set<string>();
    if (hasQueuedWork) {
      try {
        const pairs = await retry.activeUnsuitable(db, now);
        for (const job of await queries.getQueuedJobsForDispatch(db)) {
          retry.addJobAttemptExclusions(pairs, job.id, job.attempts);
        }
        exclusions = pairs;
      } catch (err) {
        console.error("hub: failed to build the dispatch exclusion set", err);
      }
    }

    let assignments: dispatch.Assignment[] = [];
    try {
      assignments = await dispatch.assignJobs(
        db,
        idleWorkerIds,
        fetchableModels,
        peerOnlyModels,
        now,
        unverifiedModels,
        exclusions,
        busyWorkerIds
      );
    } catch (err) {
      console.error("hub: assignJobs failed", err);
    }

    for (const { workerId, job } of assignments) {
      const ws = this.findWsForWorker(workerId);
      if (!ws) continue;
      const pushWorker = await queries.getWorkerById(db, workerId);
      // 2026-09-19 model_fetch (final-review I1): last line of defence for the
      // protocol>=5 floor every model_fetch job carries. `assignJobs` already
      // refused this pair, so reaching here means that gate regressed --
      // better to drop the push than hand the job to a worker that would run
      // the `{}` placeholder workflow and fail it.
      // 注意這裡的 job 並不會「留在 queued」：`assignJobs` 已經把它 claim 成
      // `assigned` 並寫上 workerId，只是沒人收到 `job` frame。要等這個 worker
      // 超過 90 秒沒心跳、被 `dispatch.requeueStale` 掃回 `queued` 才救得回來
      // （worker 一直在線的話就會卡著）。
      // The job does NOT stay queued: `assignJobs` already claimed the row to
      // `assigned` with `worker_id` set, and skipping the push just means
      // nobody received the `job` frame. It is recovered only when that worker
      // goes stale (>90 s without a check-in) and `dispatch.requeueStale`
      // moves it back to `queued`. Ports the same block in the former Python
      // `dispatch_tick`.
      if (job.kind === "model_fetch" && (!pushWorker || !assess.modelFetchProtocolOk(pushWorker))) {
        console.error(
          `hub: refusing to push model_fetch job ${job.id} to worker ${workerId} ` +
            `(protocol=${pushWorker?.protocol})`
        );
        continue;
      }
      try {
        const frame: Record<string, unknown> = {
          type: "job",
          job_id: job.id,
          workflow_json: job.workflowJson,
          input_assets: job.inputAssets,
        };
        // Only a model_fetch job carries this key: a `prompt` push keeps its
        // exact existing shape, and an old agent ignores unknown fields
        // anyway (spec §7).
        if (job.kind === "model_fetch") frame.kind = "model_fetch";
        if (Object.keys(fetchableModels).length > 0) {
          if (pushWorker) {
            const fetchModels = await this.fetchModelsForPush(
              job,
              pushWorker,
              fetchableModels,
              manifestByName,
              peerOnlyModels,
              unverifiedModels
            );
            if (fetchModels.length > 0) frame.fetch_models = fetchModels;
          }
        }
        ws.send(JSON.stringify(frame));
        const att = ws.deserializeAttachment() as AgentAttachment;
        // Presume busy until the next heartbeat says otherwise, so the next
        // tick doesn't double-push before the agent reports in.
        ws.serializeAttachment({ ...att, state: "dispatched" } satisfies AgentAttachment);
      } catch (err) {
        console.error(`hub: failed to push job to worker ${workerId}`, err);
      }
    }
  }

  /** The `fetch_models` manifest entries to embed in this job's push to
   * `worker`, or `[]` when nothing needs fetching -- ports the former Python
   * `_fetch_models_for_push`. Recomputes `assess.verdict` for this exact
   * (job, worker) pair rather than threading the winning candidate's
   * missing-model list through `assignJobs`'s return value -- see that
   * Python docstring for why. */
  private async fetchModelsForPush(
    job: queries.Job,
    worker: queries.Worker,
    fetchableModels: FetchableModels,
    manifestByName: Map<string, FetchEntry>,
    peerOnlyModels?: ReadonlySet<string> | null,
    unverifiedModels?: ReadonlySet<string> | null
  ): Promise<FetchEntry[]> {
    if (Object.keys(fetchableModels).length === 0) return [];

    // 2026-09-19 model_fetch (final-review I1): a model_fetch job is only ever
    // pushed to a protocol>=5 agent -- `dispatch.assignJobs` refuses the pair
    // and `tick` refuses the push. Repeated here because this function is what
    // actually hands an agent the entries to download, and an older agent
    // given them would fetch the model and then run the `{}` placeholder
    // workflow.
    if (job.kind === "model_fetch" && !assess.modelFetchProtocolOk(worker)) {
      console.error(
        `hub: refusing fetch_models for model_fetch job ${job.id} to worker ${worker.id} ` +
          `(protocol=${worker.protocol}) -- the assignJobs kind gate should have excluded it`
      );
      return [];
    }

    const allWorkers = await queries.getAllWorkers(this.env.DB);
    const needs = assess.needsFromJob(job);
    const v = assess.verdict(
      worker,
      needs,
      job.requirements,
      allWorkers,
      fetchableModels,
      peerOnlyModels,
      unverifiedModels
    );
    if (v.kind !== "eligible_after_fetch") return [];

    // Defensive: `eligible_after_fetch` already requires protocol >= 3 (see
    // assess.ts's `workerFetchCapacityOk`) -- an agent that predates
    // fetch_models entirely must never receive this key. This should be
    // unreachable; if it ever fires, that gate has regressed, so it's
    // logged loudly rather than silently sent.
    if (typeof worker.protocol !== "number" || worker.protocol < MIN_AUTO_FETCH_PROTOCOL) {
      console.error(
        `hub: refusing to push fetch_models to worker ${worker.id} (protocol=${worker.protocol}) for job ` +
          `${job.id} -- eligible_after_fetch verdict should be unreachable below protocol ${MIN_AUTO_FETCH_PROTOCOL}`
      );
      return [];
    }

    return v.missingModels.map((name) => manifestByName.get(name)).filter((e): e is FetchEntry => !!e);
  }

  async alarm(): Promise<void> {
    await this.tick();

    // Agent connections only -- ports the former Python dispatch loop re-arm
    // condition (`agentws._connections`, a registry that never held panel
    // sockets; the former panel module kept its own, entirely separate `_connections`
    // dict). A panel client alone with zero agents connected has no work
    // this alarm could possibly dispatch, so it must not be what keeps the
    // 5s tick alive forever.
    const anyAgentConnected = [...this.ctx.getWebSockets()].some((ws) => {
      const att = ws.deserializeAttachment() as HubAttachment | null;
      return att?.kind === "agent";
    });
    const active = anyAgentConnected || (await queries.hasActiveJobs(this.env.DB));
    if (active) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
    }
    // Otherwise: no re-arm. The next WS connect (`handleHandshakeMessage`)
    // or `/internal/cancel` call re-arms it via `scheduleAlarmIfNeeded`, so
    // an idle deployment doesn't tick forever for nothing.
  }

  /** Arms the alarm if it isn't already armed -- called on a successful
   * handshake and after `/internal/cancel`, so new work/connections always
   * get picked up within one tick even from a fully idle DO. */
  private async scheduleAlarmIfNeeded(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + TICK_INTERVAL_MS);
    }
  }

  // -- Connection lookup -------------------------------------------------

  private findWsForWorker(workerId: string): WebSocket | null {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as HubAttachment | null;
      if (att && att.kind === "agent" && att.phase === "ready" && att.workerId === workerId) return ws;
    }
    return null;
  }

  private ephemeralFor(ws: WebSocket): Ephemeral {
    let e = this.ephemeral.get(ws);
    if (!e) {
      // Reconstructing here (rather than only at handshake success) is what
      // makes a post-hibernation-eviction reactivation behave exactly like
      // a Python reconnect: the very first message after eviction gets a
      // brand-new, empty `Ephemeral` -- see file docstring.
      e = newEphemeral();
      this.ephemeral.set(ws, e);
    }
    return e;
  }

  // -- Panel event bus -----------------------------------------------------
  // Ports the former Python broadcast functions. Every caller here is a
  // direct in-DO method call from the agent-socket handlers above (see
  // this file's docstring: agent + panel WS share one DO, no HTTP hop
  // needed) -- `handleInternalEvent`'s `/internal/event` is the SEPARATE
  // seam for callers outside the DO (Task 8/9's HTTP routes).

  /** `(origin, userId)` for `jobId`, or `null` if it doesn't (or no longer)
   * exist -- ports the former Python `_job_owner`. Callers below only ever have a
   * bare `jobId`, not a live row (the one exception, `panelJobDone`, already
   * has the freshly-committed row in hand and skips this lookup entirely). */
  private async jobOwner(jobId: string): Promise<PanelOwner | null> {
    const job = await queries.getJobById(this.env.DB, jobId);
    return job ? { origin: job.origin, userId: job.userId } : null;
  }

  /** Phase 3.3 §3.7 -- ports the former Python `resolve_panel_job_id`: the panel
   * only ever sees the parent. A child's id resolves to its parent's; an
   * ordinary or parent job returns itself; a job that no longer exists
   * returns null. Every job-scoped panel event below goes through this
   * first, so each of a child's transitions becomes an event about the
   * parent and the panel never learns the split happened. */
  private async resolvePanelJobId(jobId: string): Promise<string | null> {
    if (!jobId) return null;
    const job = await queries.getJobById(this.env.DB, jobId);
    if (!job) return null;
    return job.parentId ?? job.id;
  }

  /** The parent row for a CHILD's id, or null when `jobId` is not a child
   * (or nothing resolves) -- ports the former Python `_parent_state`, for the two
   * relays that need more than the parent's id (its status, its error). */
  private async parentOf(jobId: string): Promise<Job | null> {
    const job = await queries.getJobById(this.env.DB, jobId);
    if (!job || !job.parentId) return null;
    return await queries.getJobById(this.env.DB, job.parentId);
  }

  /** Broadcasts a `{type, data}` envelope to connected panel clients. Ports
   * the former Python `post_event` (minus the cross-event-loop dance, which has
   * no equivalent in a single-threaded DO -- every caller here already runs
   * on this DO's own turn). Never throws: a dead/erroring panel socket is
   * logged and skipped, exactly like Python's `except Exception` +
   * drop-from-`_connections`; the difference is there is no registry entry
   * to drop here -- `ctx.getWebSockets()` reflects socket lifecycle on its
   * own.
   *
   * `owner` (Phase 3.0 Task 4/10 parity): `(origin, userId)` for the job this
   * event is about, from `jobOwner`/a live row -- scopes delivery to ONLY the
   * socket whose `uid` matches (see `panelVisibleTo`), including an admin's
   * own panel socket (the spec's ruling: an admin's panel is as personal as
   * anyone else's; full fleet visibility lives in the console). Omitted
   * (`undefined`) means an unscoped broadcast -- used for the queue-badge
   * `status` refreshes, which carry no single job's identity to scope
   * against -- delivered to every connected panel socket, exactly as before
   * this parameter existed.
   *
   * Final review finding #5: a job-scoped frame whose `jobOwner` lookup
   * resolves to `null` (the job no longer exists) is DROPPED by
   * `postJobScopedPanelEvent` below, not passed through as an unscoped
   * broadcast -- see that method's docstring. `owner` here is therefore
   * always either a real resolved owner or `undefined` for a genuinely
   * unscoped call (the queue-badge `status` refreshes); this method itself
   * never needs to fail closed. */
  private async postPanelEvent(evt: { type: string; data?: unknown }, owner?: PanelOwner): Promise<void> {
    const payload = JSON.stringify(evt);
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as HubAttachment | null;
      if (!att || att.kind !== "panel") continue;
      if (owner !== undefined && !panelVisibleTo(att.uid, owner)) continue;
      try {
        ws.send(payload);
      } catch (err) {
        console.warn(`hub: failed to deliver panel event to sid ${att.sid}`, err);
      }
    }
  }

  /** Job-scoped variant of `postPanelEvent`: looks `jobId` up via `jobOwner`
   * and only sends `evt` when it resolves. Final review finding #5 -- the
   * old rule fell back to an unscoped broadcast when a job-scoped frame's
   * row could not be resolved ("swallowing a real event is worse than a
   * one-off leak"), reasoning that predates the panel being multi-tenant: an
   * `executed` frame carries the job's full output payload, including
   * `.txt` artifact TEXT CONTENT, so an unscoped fan-out on a resolution
   * miss would risk handing one user's job data to every other connected
   * panel socket. Now the frame is simply DROPPED (fail closed) and logged;
   * callers that also need an unscoped follow-up (e.g. `job_cancelled`'s
   * trailing `status` refresh) issue it as a separate `postPanelEvent` call,
   * unaffected by this method's own drop. */
  private async postJobScopedPanelEvent(jobId: string, evt: { type: string; data?: unknown }): Promise<void> {
    const owner = await this.jobOwner(jobId);
    if (owner === null) {
      console.warn(`hub: dropping unresolved job-scoped frame for job ${jobId}`);
      return;
    }
    await this.postPanelEvent(evt, owner);
  }

  /** Ports the former Python `queue_status`. */
  private async queueStatus(): Promise<{ exec_info: { queue_remaining: number } }> {
    const remaining = await queries.countQueueRemaining(this.env.DB);
    return { exec_info: { queue_remaining: remaining } };
  }

  /** Ports the former Python `job_progress`. `fetchFields` (Phase 2.1) carries
   * the model auto-fetch phase's extra fields -- included in `data` only
   * when given/non-null, so the wire shape for a plain execution-progress
   * update stays byte-identical to before this parameter existed. The stock
   * ComfyUI frontend ignores unknown fields on a `progress` event. */
  private async panelJobProgress(
    jobId: string,
    progress: number,
    fetchFields?: { stage: string; fetchPct: number | null; fetchModel: string | null }
  ): Promise<void> {
    // Phase 3.3 §3.7: a child's progress is reported as its PARENT's, and the
    // value becomes the mean over the siblings -- one child at 50% is not the
    // prompt at 50%. Read here rather than off the parent's stored `progress`
    // because `refreshParentProgress` runs AFTER this relay on the heartbeat
    // path, so the stored value is one beat stale.
    const panelJobId = await this.resolvePanelJobId(jobId);
    if (panelJobId === null) return;
    if (panelJobId !== jobId) {
      const mean = await split.meanChildProgress(this.env.DB, panelJobId);
      if (mean !== null) progress = mean;
      jobId = panelJobId;
    }

    const data: Record<string, unknown> = { value: Math.trunc(progress * 100), max: 100, prompt_id: jobId };
    if (fetchFields) {
      data.stage = fetchFields.stage;
      if (fetchFields.fetchPct !== null) data.fetch_pct = fetchFields.fetchPct;
      if (fetchFields.fetchModel !== null) data.fetch_model = fetchFields.fetchModel;
    }
    await this.postJobScopedPanelEvent(jobId, { type: "progress", data });
  }

  /** Ports the former Python `job_running`. */
  private async panelJobRunning(jobId: string): Promise<void> {
    // Phase 3.3 §3.7: a child starting is the PARENT executing, as far as the
    // panel is concerned -- repeated once per child, with an identical
    // payload the frontend is happy to see again.
    const panelJobId = await this.resolvePanelJobId(jobId);
    if (panelJobId === null) return;
    jobId = panelJobId;
    await this.postJobScopedPanelEvent(jobId, {
      type: "executing",
      data: { node: RUNNING_NODE_LABEL, prompt_id: jobId, display_node: RUNNING_NODE_LABEL },
    });
  }

  /** Ports the former Python `job_status_refresh`. */
  private async panelJobStatusRefresh(): Promise<void> {
    await this.postPanelEvent({ type: "status", data: { status: await this.queueStatus() } });
  }

  /** Ports the former Python `job_requeued`. */
  private async panelJobRequeued(jobId: string): Promise<void> {
    // Phase 3.3 §3.7: for a child this is relayed as the parent -- but ONLY
    // when the requeue actually pulled the parent back to queued/assigned.
    // One child of four going back in the queue while its siblings keep
    // running leaves the parent `running`, and clearing `executing` then
    // would blank a prompt that is still very much in flight.
    const parent = await this.parentOf(jobId);
    if (parent !== null) {
      if (parent.status !== "queued" && parent.status !== "assigned") return;
      jobId = parent.id;
    } else if ((await this.resolvePanelJobId(jobId)) === null) {
      return;
    }
    await this.postJobScopedPanelEvent(jobId, { type: "executing", data: { node: null, prompt_id: jobId } });
  }

  /** Ports the former Python `job_cancelled`. */
  private async panelJobCancelled(jobId: string): Promise<void> {
    // Phase 3.3 §3.7: a child's cancellation is relayed as the parent's --
    // cancelling any one child cancels the whole family (refreshParent), so
    // the prompt really is over.
    const panelJobId = await this.resolvePanelJobId(jobId);
    if (panelJobId === null) return;
    jobId = panelJobId;
    await this.postJobScopedPanelEvent(jobId, { type: "executing", data: { node: null, prompt_id: jobId } });
    await this.panelJobStatusRefresh();
  }

  /** Ports the former Python `job_done`: one `executed` event PER output node
   * (the Phase 1.8b fix -- see `job_outputs`'s docstring on why upstream's
   * `executed` frame carries exactly one node's UI dict, never the whole
   * map), then the completion `executing` signal, then a refreshed
   * `status`. `job_outputs(job) or {FALLBACK_OUTPUT_KEY: {}}` in Python
   * becomes an explicit empty-check here since `jobOutputs` is async.
   *
   * `job` already carries `origin`/`userId` (the caller's freshly-committed
   * `Job` row) -- unlike the jobId-only panel* methods above, no extra
   * `jobOwner` lookup is needed to scope this event's delivery. */
  private async panelJobDone(
    job: JobOutputsInput & PanelOwner & { parentId?: string | null; splitCount?: number; kind?: string | null }
  ): Promise<void> {
    // 2026-09-19 model_fetch (spec §9)：純下載單沒有任何輸出節點，所以一個
    // `executed` 都不該發。不擋的話 `jobOutputs` 會回空物件，下面的
    // `FALLBACK_OUTPUT_KEY` 退路會憑空生一則 `executed`，再補一則
    // `executing{node: null}` —— 而官方前端把後者當成「這張 prompt 跑完了」，
    // 會把同一個分頁裡真正在跑的 prompt 的執行中指示清掉。只送佇列徽章的
    // status 更新（面板靠輪詢 `GET model-fetch/{id}` 看下載進度，不靠這裡）。
    if ((job.kind || "prompt") === "model_fetch") {
      await this.panelJobStatusRefresh();
      return;
    }
    // Phase 3.3 §3.7: what the panel must see when a CHILD finishes is the
    // parent's `executed` -- and only once the whole family is done. Until
    // then nothing goes out but a queue refresh (the progress events are
    // already carrying the prompt along); when the last child lands, the
    // parent's merged outputs are sent in one piece.
    if (job.parentId) {
      const parent = await queries.getJobById(this.env.DB, job.parentId);
      if (!parent || parent.status !== "done") {
        await this.postPanelEvent({ type: "status", data: { status: await this.queueStatus() } });
        return;
      }
      job = parent;
    }

    const splitOutputs =
      (job.splitCount ?? 0) > 0 ? await split.parentOutputs(this.env.DB, job as Job) : undefined;
    let outputs = await jobOutputs({ ...job, splitOutputs }, this.env.STORE);
    if (Object.keys(outputs).length === 0) {
      outputs = { [FALLBACK_OUTPUT_KEY]: {} };
    }

    const owner: PanelOwner = { origin: job.origin, userId: job.userId };
    for (const [nodeId, payload] of Object.entries(outputs)) {
      await this.postPanelEvent(
        {
          type: "executed",
          data: { prompt_id: job.id, output: payload, node: nodeId, display_node: nodeId },
        },
        owner
      );
    }
    await this.postPanelEvent({ type: "executing", data: { node: null, prompt_id: job.id } }, owner);
    await this.panelJobStatusRefresh();
  }

  /** Ports the former Python `job_failed`. */
  private async panelJobFailed(jobId: string, error: string): Promise<void> {
    // Phase 3.3 §3.7: a child's failure is the whole prompt's failure (it
    // fails the parent and cancels the siblings -- refreshParent), so it is
    // relayed as the parent, carrying the PARENT's error message: that one
    // names which child of how many failed, which the raw child error does
    // not.
    const parent = await this.parentOf(jobId);
    if (parent !== null) {
      jobId = parent.id;
      error = parent.error ?? error;
    } else if ((await this.resolvePanelJobId(jobId)) === null) {
      return;
    }
    await this.postJobScopedPanelEvent(jobId, {
      type: "execution_error",
      data: {
        prompt_id: jobId,
        node_id: null,
        node_type: null,
        exception_message: error,
        exception_type: "",
        traceback: [],
        current_inputs: {},
        current_outputs: {},
        executed: [],
      },
    });
    await this.panelJobStatusRefresh();
  }
}
