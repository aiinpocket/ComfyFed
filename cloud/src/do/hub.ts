/**
 * Hub Durable Object -- agent WebSocket channel, panel WebSocket, event bus
 * + dispatch alarm. Parity sources: `server/comfyfed_server/agentws.py`
 * (agent side, Task 6) and `panelws.py` + comfyapi.py's `create_ws_router`
 * (panel side, Task 7), both read in full; every function below is named
 * after (and documents its delta from) the Python function it ports. A
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
 * every panelws.py broadcast function (`job_progress`/`job_running`/
 * `job_done`/`job_failed`/`job_requeued`/`job_cancelled`/`job_status_
 * refresh`) is now wired as a direct in-DO method call from the exact
 * agent-handler call site agentws.py calls it from -- agent and panel
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
import * as stats from "../core/stats";
import { toSqliteTimestamp, resolvePlatformSeed } from "../db/queries";
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
// Constants (parity: agentws.py module-level constants)

const AUTH_TIMEOUT_MS = 10_000;
const TICK_INTERVAL_MS = 5_000;
/** 三個握手關閉碼語意不同 -- the handshake uses THREE distinct close codes,
 * parity with agentws.py's `_CLOSE_UNAUTHORIZED` / `_CLOSE_WORKER_DISABLED` /
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
 * `job_cancelled` pushes -- see agentws.py's `_CURRENT_PROTOCOL`. */
const CURRENT_PROTOCOL = 2;

/** Minimum `hello.protocol` that can receive `fetch_models` at all (predates
 * lazy hashing / lazy inventory sha256) -- see assess.py's
 * `_MIN_AUTO_FETCH_PROTOCOL`. Duplicated here (rather than exported from
 * `core/assess.ts`, which keeps it private) purely for the defensive
 * re-check right before a push -- see `fetchModelsForPush`. */
const MIN_AUTO_FETCH_PROTOCOL = 3;

const DEPRECATION_MESSAGE =
  "agent 版本過舊：無法接收取消通知，計費將以整體耗時（wall-clock）為準。" +
  "請更新 comfyfed-agent。/ Agent is outdated: cannot receive cancellation " +
  "notices; billing falls back to wall-clock. Please update comfyfed-agent.";

/** Statuses a worker is allowed to transition out of by reporting on a job
 * -- mirrors dispatch.py's OWNED_STATUSES (not exported from core/dispatch.ts,
 * which keeps it as a private module constant; duplicated here rather than
 * exported solely for this one caller). */
const OWNED_STATUSES: readonly string[] = ["assigned", "running"];

/** Cap for every per-connection dedup/rate-limit set -- agentws.py's
 * `_DEDUP_CAP`. */
const DEDUP_CAP = 512;

/** Same key the object_info upload route (`routes/workers.ts`) writes to in
 * R2 -- duplicated rather than imported to avoid a route->DO layering
 * dependency; keep in sync if that route's key ever changes. */
const OBJECT_INFO_DIR = "object_info";

// ---------------------------------------------------------------------------
// Panel WebSocket -- parity source: panelws.py + comfyapi.py's
// `create_ws_router` (the `/comfy/api/ws` / `/comfy/ws` handshake).

/** Same cookie name `lib/guard.ts`'s `requireAdmin`/`requireCsrf` middleware
 * checks -- duplicated (rather than imported) because this DO verifies the
 * cookie itself, off the raw upgrade `Request`, with no Hono `Context` to
 * hand `readSession` its usual middleware entrypoint. */
const SESSION_COOKIE_NAME = "cf_session";

/** The node id federation job events report -- ComfyFed jobs are opaque
 * units dispatched to a single worker, not executed node-by-node like
 * upstream ComfyUI, so there is no real per-node id to report while a job is
 * running. Ports panelws.py's `_RUNNING_NODE_LABEL`. */
const RUNNING_NODE_LABEL = "comfyfed";

/** Sent once, right after the initial `status` message, on every panel
 * connection. All false is the truthful answer for every one of these on
 * ComfyFed -- ports panelws.py's `FEATURE_FLAGS` verbatim (see that
 * module's docstring for why each one is false). */
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
}

/** A connected panel (ComfyUI-frontend) client -- ports panelws.py's
 * `_PanelConnection` (minus its `loop` field, which has no equivalent in a
 * single-threaded DO; see panelws.py's `post_event` docstring for what that
 * field was for on the Python side). No handshake phase: authentication
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

/** Validate `hello.protocol`, defaulting to 1 -- ports agentws.py's
 * `_parse_protocol`. */
function parseProtocol(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return 1;
  return value;
}

/** Validate hello's optional `max_fetch_gb` (Phase 3.2 F1 fix): a positive
 * finite number, else `null` (missing, wrong type, or non-positive) -- the
 * caller then omits it from what gets stored, and `assess.ts`'s
 * `workerMaxFetchGb` degrades that to the same default the agent itself
 * uses. Ports agentws.py's `_parse_max_fetch_gb`. */
function parseMaxFetchGb(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

/** Validate hello's optional `peer_upload_min_mbps` (the seeder's slowest
 * configured P2P upload cap, see the agent's `_peer_upload_min_mbps`): a
 * positive finite number, else `null` (missing, null because both caps are
 * unlimited, wrong type, or non-positive). `null` means the caller omits it
 * and `peer.grantTtlSeconds` keeps its default rate assumption -- today's
 * behavior, unchanged. Ports agentws.py's `_parse_peer_upload_min_mbps`.
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

/** Ports agentws.py's `_is_valid_exec_seconds`. */
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

/** Validate hello's optional `peer_url` (Phase 3.1 P2P seeder advertisement):
 * must be a string that parses as an http:// or https:// URL with a host.
 * Anything else (missing, wrong type, wrong scheme, no host, a bare path) is
 * ignored -- logged, not stored -- so a malformed or hostile value can never
 * end up handed out as a seeder endpoint. Ports agentws.py's `_parse_peer_url`. */
function parsePeerUrl(value: unknown, workerId: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    console.warn(`hub: worker ${workerId} hello.peer_url not a string, ignoring`);
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    console.warn(`hub: worker ${workerId} hello.peer_url ${JSON.stringify(value)} is not a valid http(s) URL, ignoring`);
    return null;
  }
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) {
    console.warn(`hub: worker ${workerId} hello.peer_url ${JSON.stringify(value)} is not a valid http(s) URL, ignoring`);
    return null;
  }
  return value;
}

/** Ports agentws.py's `_MAX_PLAUSIBLE_MODEL_GB` / `_normalize_models`. */
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
 * panelws.py's bare `tuple[str, Optional[str]]` `owner` shape (kept as a
 * named interface here rather than a tuple for readability at call sites). */
interface PanelOwner {
  origin: string;
  userId: string | null;
}

/** Whether a job-scoped frame for `owner` should reach a panel connection
 * whose session uid is `connUid` -- ports panelws.py's `_visible_to`. The
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
   * job is in the pre-run download phase -- ports agentws.py's
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
    };
    server.serializeAttachment(attachment);

    try {
      server.send(JSON.stringify({ type: "challenge", nonce }));
    } catch {
      // Nothing to clean up yet -- the close/error handler (if any) will
      // still fire and evict the (never-added) ephemeral entry.
    }

    // Mirrors agentws.py's `asyncio.wait_for(..., timeout=_AUTH_TIMEOUT_SECONDS)`:
    // a socket that never completes the handshake is closed unauthorized.
    const timer = setTimeout(() => {
      this.handshakeTimers.delete(server);
      const current = server.deserializeAttachment() as AgentAttachment | null;
      if (current && current.phase === "handshake") {
        // TRANSIENT (parity: agentws.py's `_close_auth_timeout`): a slow or
        // loaded agent must not be told 4401, which the agent counts towards
        // giving up on (and pruning) the registration.
        this.closeAuthTimeout(server);
      }
    }, AUTH_TIMEOUT_MS);
    this.handshakeTimers.set(server, timer);

    return new Response(null, { status: 101, webSocket: client });
  }

  /** Ports comfyapi.py's `create_ws_router`'s `panel_ws` handler.
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

  private async handleInternalCancel(request: Request): Promise<Response> {
    const body = await request
      .json<{ job_id?: unknown; reason?: unknown }>()
      .catch(() => ({}) as { job_id?: unknown; reason?: unknown });
    const jobId = typeof body.job_id === "string" ? body.job_id : "";
    const reason = typeof body.reason === "string" && body.reason ? body.reason : "cancelled";
    if (!jobId) {
      return Response.json({ error: "missing job_id" }, { status: 400 });
    }

    // Ports agentws.py's `cancel_and_notify`: snapshot BEFORE cancelling --
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

    const owner = await dispatch.cancelJob(db, jobId, reason, now);
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

    // Ports agentws.py's `cancel_and_notify`: the panel gets told regardless
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
   * panelws.py's agentws.py callers need is wired as a direct in-DO method
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
      // gets the definitive 4401 (parity: agentws.py's `_close_deleted`).
      ws.close(CLOSE_WORKER_DISABLED, "worker deleted");
    } catch (err) {
      // Best-effort, exactly like the supersede-close in the handshake: the
      // row is already flagged deleted, so a socket that is already closing
      // needs nothing undone.
      console.warn(`hub: failed to close agent socket for deleted worker ${workerId}`, err);
    }
    return Response.json({ kicked: true });
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

  // -- Hibernatable WebSocket handlers --------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const hubAttachment = ws.deserializeAttachment() as HubAttachment | null;
    if (!hubAttachment) return;

    if (hubAttachment.kind === "panel") {
      // Panel clients only ever listen; any inbound message -- including
      // the `feature_flags` frame the frontend announces its own
      // capabilities with on open -- is simply discarded, mirroring
      // comfyapi.py's `panel_ws` loop (`await websocket.receive_text()`,
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
      // Malformed JSON from an authenticated agent -- agentws.py's outer
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

  /** Ports agentws.py's `_handshake` (the auth-message half; the challenge
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
      // Malformed auth frame -> TRANSIENT (4408), parity with agentws.py.
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

    // ORDER MATTERS (parity: agentws.py's `_handshake`). `getWorkerById`
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

    const ready: AgentAttachment = { kind: "agent", phase: "ready", workerId: worker.id, protocol: 1, state: "idle" };
    ws.serializeAttachment(ready);
    this.ephemeral.set(ws, newEphemeral());

    try {
      ws.send(JSON.stringify({ type: "ready" }));
    } catch {
      // Send failure right after accept is vanishingly unlikely and, per
      // agentws.py, not itself fatal to the connection.
    }

    await this.scheduleAlarmIfNeeded();
  }

  private closeUnauthorized(ws: WebSocket): void {
    this.clearHandshakeTimer(ws);
    this.ephemeral.delete(ws);
    try {
      // No reason string -- parity with agentws.py's `_close_unauthorized`,
      // which calls `websocket.close(code=_CLOSE_UNAUTHORIZED)` with no
      // reason argument at all.
      ws.close(CLOSE_UNAUTHORIZED);
    } catch {
      // agentws.py's `_close_unauthorized` swallows close failures too.
    }
  }

  /** 4403: an admin disabled this worker -- reversible, so the agent keeps
   * retrying and never prunes. Parity with agentws.py's `_close_disabled`. */
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
   * transient. Parity with agentws.py's `_close_auth_timeout`. */
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

  // -- hello -------------------------------------------------------------

  /** Ports agentws.py's `_handle_hello`. */
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

    await queries.updateWorkerHello(this.env.DB, workerId, {
      hardware,
      backend,
      torchVersion,
      nodeClasses,
      protocol,
      autoFetch,
      lastSeen: toSqliteTimestamp(new Date()),
    });
    await queries.updateWorkerPeerUrl(this.env.DB, workerId, peerUrl);

    ws.serializeAttachment({ ...attachment, protocol } satisfies AgentAttachment);

    if (protocol < CURRENT_PROTOCOL) {
      try {
        ws.send(JSON.stringify({ type: "deprecation", message: DEPRECATION_MESSAGE }));
      } catch (err) {
        console.error(`hub: failed to send deprecation notice to worker ${workerId}`, err);
      }
    }
  }

  // -- heartbeat -------------------------------------------------------------

  /** Ports agentws.py's `_handle_heartbeat`. */
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

    let currentAttachment = attachment;
    if (state) {
      currentAttachment = { ...attachment, state };
      ws.serializeAttachment(currentAttachment);
    }

    const jobId = typeof msg.job_id === "string" ? msg.job_id : null;
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
        }

        // Phase 2.1: an agent downloading a missing model before it can run
        // the job it was pushed reports stage="fetching_models" alongside
        // its usual progress -- ports agentws.py's `_handle_heartbeat`
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
    // unconditionally (matching agentws.py) so the WARNING/DEBUG split for a
    // foreign job_id still fires/rate-limits on every heartbeat.
    //
    // M1 fix (mirrors agentws.py's `_handle_heartbeat`): while
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
        await this.panelJobRunning(jobId);
      });
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

  /** Ports agentws.py's `_handle_inventory` / `_normalize_models`. */
  private async handleInventory(attachment: AgentAttachment, msg: Record<string, unknown>): Promise<void> {
    const workerId = attachment.workerId!;
    const worker = await queries.getWorkerById(this.env.DB, workerId);
    if (!worker) return;
    const models = normalizeModels(msg.models);
    await queries.updateWorkerModelInventory(this.env.DB, workerId, models);
    await this.recordModelHashes(workerId, models);
  }

  /** Learn a sha256 for every inventory entry that carries one -- ports
   * agentws.py's `_record_model_hashes`. `size_bytes` is preferred when the
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

  /** Ports agentws.py's `_handle_job_done` (incl. blip re-adoption via
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
      this.fetchProgress.delete(jobId!);
      // Separate lookup rather than reusing the row `updateJobDone` already
      // touched -- mirrors agentws.py's `_notify_panel_job_done`: `jobOutputs`
      // needs `resultFiles`/`workflowJson` off the freshly-committed row.
      const freshJob = await queries.getJobById(db, jobId!);
      if (freshJob) await this.panelJobDone(freshJob);

      const execSeconds = isValidExecSeconds(msg.exec_seconds) ? msg.exec_seconds : null;
      // Phase 3.3 §2.3：只有真的完成、且 exec_seconds 有效才進統計。放在收據
      // 之前，因為 recordCompletion 自己吞例外 -- 統計壞掉絕不能少發一張收據。
      await stats.recordCompletion(db, workerId, freshJob?.signature ?? null, execSeconds, now);
      await this.createAndPushReceipt(ws, attachment, jobId!, execSeconds, now);
    }
  }

  /** Ports agentws.py's `job_failed` branch of `_handle_message` +
   * `_create_and_push_failure_receipt`. */
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

    const applied = await this.applyOwnedTransition(db, jobId, workerId, OWNED_STATUSES, ephemeral, async () => {
      await queries.updateJobFailed(db, jobId!, error, toSqliteTimestamp(now));
    });

    if (applied) {
      this.fetchProgress.delete(jobId!);
      await this.panelJobFailed(jobId!, error);
      const execSeconds = isValidExecSeconds(msg.exec_seconds) ? msg.exec_seconds : null;
      await this.createAndPushFailureReceipt(ws, attachment, jobId!, execSeconds, now);
    } else if (jobId && (await this.jobNotOwnedBy(jobId, workerId))) {
      await this.sendJobCancelled(ws, attachment, ephemeral, jobId);
    }
  }

  private async jobNotOwnedBy(jobId: string, workerId: string): Promise<boolean> {
    const job = await queries.getJobById(this.env.DB, jobId);
    return job === null || job.workerId !== workerId;
  }

  // -- Owned-job gate + logging (dispatch.ts's pure OwnedJobRefusal, wired
  //    to the WARNING-once/DEBUG-after rate limiting agentws.py's
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
    // "not_owner_stale_terminal" / "wrong_status_transient" are agentws.py's
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

  private logUnknownMessageType(ephemeral: Ephemeral, msgType: unknown): void {
    const key = typeof msgType === "string" ? msgType : JSON.stringify(msgType);
    const warn = !ephemeral.warnedMsgTypes.has(key);
    ephemeral.warnedMsgTypes.add(key);
    const line = `hub: unknown message type ${JSON.stringify(msgType)}`;
    if (warn) console.warn(line);
    else console.debug(line);
  }

  // -- job_cancelled push (dedup) ---------------------------------------------

  /** Ports agentws.py's `_send_job_cancelled`. */
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

  /** Ports agentws.py's `_create_and_push_receipt`. */
  private async createAndPushReceipt(
    ws: WebSocket,
    attachment: AgentAttachment,
    jobId: string,
    execSeconds: number | null,
    now: Date
  ): Promise<void> {
    const job = await queries.getJobById(this.env.DB, jobId);
    if (!job) return;

    let wallSeconds = 0;
    if (job.startedAt && job.finishedAt) wallSeconds = secondsBetween(job.startedAt, job.finishedAt);

    let gpuSeconds: number;
    let basis: "exec" | "wall";
    if (execSeconds !== null) {
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

    const { receiptId, payload, platformSig } = await this.mintReceipt(
      jobId,
      attachment.workerId!,
      gpuSeconds,
      "completed",
      true,
      basis,
      now
    );
    this.pushReceiptFrame(attachment.workerId!, receiptId, payload, platformSig, "completed", true, basis, ws);
  }

  /** Ports agentws.py's `_create_and_push_failure_receipt`. */
  private async createAndPushFailureReceipt(
    ws: WebSocket,
    attachment: AgentAttachment,
    jobId: string,
    execSeconds: number | null,
    now: Date
  ): Promise<void> {
    const job = await queries.getJobById(this.env.DB, jobId);
    if (!job) return;

    let gpuSeconds: number;
    let basis: "exec" | "wall";
    if (execSeconds !== null && job.startedAt) {
      gpuSeconds = execSeconds;
      if (job.finishedAt) {
        gpuSeconds = Math.min(gpuSeconds, secondsBetween(job.startedAt, job.finishedAt));
      }
      basis = "exec";
    } else {
      let wallSeconds = 0;
      if (job.startedAt) {
        const end = job.finishedAt ?? toSqliteTimestamp(now);
        wallSeconds = secondsBetween(job.startedAt, end);
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

  /** Ports agentws.py's `_mint_cancelled_receipt` (the gpu_seconds math
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

  /** Ports agentws.py's `_push_receipt_frame` (minus the cross-event-loop
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

  /** Ports agentws.py's `_handle_receipt_ack`. */
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

  /** One iteration of the dispatch loop -- ports agentws.py's
   * `dispatch_tick`. */
  private async tick(): Promise<void> {
    const db = this.env.DB;
    const now = new Date();

    // Phase 3.3 §2.6：第一次 tick 時把 worker_job_stats 從最近 500 筆完成
    // 收據補起來（`stats_backfilled` 旗標，跨 DO 重啟只會做一次）。
    // `statsBackfillDone` 是 per-instance 的短路，避免每個 tick 都去讀旗標。
    if (!this.statsBackfillDone) {
      this.statsBackfillDone = true;
      try {
        await stats.backfillIfNeeded(db);
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
    // agentws.py's `dispatch_tick`'s post-`requeue_stale` panel relay.
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

    const idleWorkerIds: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as HubAttachment | null;
      if (att && att.kind === "agent" && att.phase === "ready" && att.state === "idle" && att.workerId) {
        idleWorkerIds.push(att.workerId);
      }
    }

    // Compiled ONCE per sweep, not per candidate/job -- ports agentws.py's
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
    let manifestByName = new Map<string, modelManifest.ManifestEntry>();
    let peerOnlyModels: ReadonlySet<string> = new Set();
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

    let assignments: dispatch.Assignment[] = [];
    try {
      assignments = await dispatch.assignJobs(db, idleWorkerIds, fetchableModels, peerOnlyModels, now);
    } catch (err) {
      console.error("hub: assignJobs failed", err);
    }

    for (const { workerId, job } of assignments) {
      const ws = this.findWsForWorker(workerId);
      if (!ws) continue;
      try {
        const frame: Record<string, unknown> = {
          type: "job",
          job_id: job.id,
          workflow_json: job.workflowJson,
          input_assets: job.inputAssets,
        };
        if (Object.keys(fetchableModels).length > 0) {
          const worker = await queries.getWorkerById(db, workerId);
          if (worker) {
            const fetchModels = await this.fetchModelsForPush(job, worker, fetchableModels, manifestByName, peerOnlyModels);
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
   * `worker`, or `[]` when nothing needs fetching -- ports agentws.py's
   * `_fetch_models_for_push`. Recomputes `assess.verdict` for this exact
   * (job, worker) pair rather than threading the winning candidate's
   * missing-model list through `assignJobs`'s return value -- see that
   * Python docstring for why. */
  private async fetchModelsForPush(
    job: queries.Job,
    worker: queries.Worker,
    fetchableModels: FetchableModels,
    manifestByName: Map<string, modelManifest.ManifestEntry>,
    peerOnlyModels?: ReadonlySet<string> | null
  ): Promise<modelManifest.ManifestEntry[]> {
    if (Object.keys(fetchableModels).length === 0) return [];

    const allWorkers = await queries.getAllWorkers(this.env.DB);
    const needs = assess.needsFromJob(job);
    const v = assess.verdict(worker, needs, job.requirements, allWorkers, fetchableModels, peerOnlyModels);
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

    return v.missingModels.map((name) => manifestByName.get(name)).filter((e): e is modelManifest.ManifestEntry => !!e);
  }

  async alarm(): Promise<void> {
    await this.tick();

    // Agent connections only -- ports agentws.py's dispatch loop re-arm
    // condition (`agentws._connections`, a registry that never held panel
    // sockets; panelws.py keeps its own, entirely separate `_connections`
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
  // Ports panelws.py's broadcast functions. Every caller here is a
  // direct in-DO method call from the agent-socket handlers above (see
  // this file's docstring: agent + panel WS share one DO, no HTTP hop
  // needed) -- `handleInternalEvent`'s `/internal/event` is the SEPARATE
  // seam for callers outside the DO (Task 8/9's HTTP routes).

  /** `(origin, userId)` for `jobId`, or `null` if it doesn't (or no longer)
   * exist -- ports panelws.py's `_job_owner`. Callers below only ever have a
   * bare `jobId`, not a live row (the one exception, `panelJobDone`, already
   * has the freshly-committed row in hand and skips this lookup entirely). */
  private async jobOwner(jobId: string): Promise<PanelOwner | null> {
    const job = await queries.getJobById(this.env.DB, jobId);
    return job ? { origin: job.origin, userId: job.userId } : null;
  }

  /** Broadcasts a `{type, data}` envelope to connected panel clients. Ports
   * panelws.py's `post_event` (minus the cross-event-loop dance, which has
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

  /** Ports panelws.py's `queue_status`. */
  private async queueStatus(): Promise<{ exec_info: { queue_remaining: number } }> {
    const remaining = await queries.countQueueRemaining(this.env.DB);
    return { exec_info: { queue_remaining: remaining } };
  }

  /** Ports panelws.py's `job_progress`. `fetchFields` (Phase 2.1) carries
   * the model auto-fetch phase's extra fields -- included in `data` only
   * when given/non-null, so the wire shape for a plain execution-progress
   * update stays byte-identical to before this parameter existed. The stock
   * ComfyUI frontend ignores unknown fields on a `progress` event. */
  private async panelJobProgress(
    jobId: string,
    progress: number,
    fetchFields?: { stage: string; fetchPct: number | null; fetchModel: string | null }
  ): Promise<void> {
    const data: Record<string, unknown> = { value: Math.trunc(progress * 100), max: 100, prompt_id: jobId };
    if (fetchFields) {
      data.stage = fetchFields.stage;
      if (fetchFields.fetchPct !== null) data.fetch_pct = fetchFields.fetchPct;
      if (fetchFields.fetchModel !== null) data.fetch_model = fetchFields.fetchModel;
    }
    await this.postJobScopedPanelEvent(jobId, { type: "progress", data });
  }

  /** Ports panelws.py's `job_running`. */
  private async panelJobRunning(jobId: string): Promise<void> {
    await this.postJobScopedPanelEvent(jobId, {
      type: "executing",
      data: { node: RUNNING_NODE_LABEL, prompt_id: jobId, display_node: RUNNING_NODE_LABEL },
    });
  }

  /** Ports panelws.py's `job_status_refresh`. */
  private async panelJobStatusRefresh(): Promise<void> {
    await this.postPanelEvent({ type: "status", data: { status: await this.queueStatus() } });
  }

  /** Ports panelws.py's `job_requeued`. */
  private async panelJobRequeued(jobId: string): Promise<void> {
    await this.postJobScopedPanelEvent(jobId, { type: "executing", data: { node: null, prompt_id: jobId } });
  }

  /** Ports panelws.py's `job_cancelled`. */
  private async panelJobCancelled(jobId: string): Promise<void> {
    await this.postJobScopedPanelEvent(jobId, { type: "executing", data: { node: null, prompt_id: jobId } });
    await this.panelJobStatusRefresh();
  }

  /** Ports panelws.py's `job_done`: one `executed` event PER output node
   * (the Phase 1.8b fix -- see `job_outputs`'s docstring on why upstream's
   * `executed` frame carries exactly one node's UI dict, never the whole
   * map), then the completion `executing` signal, then a refreshed
   * `status`. `job_outputs(job) or {FALLBACK_OUTPUT_KEY: {}}` in Python
   * becomes an explicit empty-check here since `jobOutputs` is async.
   *
   * `job` already carries `origin`/`userId` (the caller's freshly-committed
   * `Job` row) -- unlike the jobId-only panel* methods above, no extra
   * `jobOwner` lookup is needed to scope this event's delivery. */
  private async panelJobDone(job: JobOutputsInput & PanelOwner): Promise<void> {
    let outputs = await jobOutputs(job, this.env.STORE);
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

  /** Ports panelws.py's `job_failed`. */
  private async panelJobFailed(jobId: string, error: string): Promise<void> {
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
