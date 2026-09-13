/**
 * Hub Durable Object -- agent WebSocket channel + dispatch alarm.
 * Parity source: `server/comfyfed_server/agentws.py`, read in full; every
 * function below is named after (and documents its delta from) the Python
 * function it ports. A singleton instance (`idFromName("hub")`) backs the
 * whole deployment -- see progress.md's pre-flight ruling ("ONE Durable
 * Object for agent+panel WS+alarm").
 *
 * Part 1 (this task) covers the agent side end-to-end: handshake, hello,
 * heartbeat, inventory, job push, job_done/job_failed with receipt
 * mint+push+ack, blip re-adoption, and the 5s dispatch alarm. It also opens
 * the `/internal/*` surface Task 7 (panel WS) and Tasks 8/9 (HTTP routes)
 * consume: `/internal/cancel` (real), `/internal/event` (202 stub -- Task 7
 * completes it), `/internal/dynamic` (real, backs `queries.getDynamic`).
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
import { toSqliteTimestamp, resolvePlatformSeed } from "../db/queries";
import { buildReceiptPayload, signReceipt, verifyHex } from "../lib/signing";
import { bytesToHex } from "../lib/hex";

// ---------------------------------------------------------------------------
// Constants (parity: agentws.py module-level constants)

const AUTH_TIMEOUT_MS = 10_000;
const TICK_INTERVAL_MS = 5_000;
const CLOSE_UNAUTHORIZED = 4401;

/** Minimum `hello.protocol` that guarantees exec_seconds and understands
 * `job_cancelled` pushes -- see agentws.py's `_CURRENT_PROTOCOL`. */
const CURRENT_PROTOCOL = 2;

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
// Durable per-connection identity (WebSocket.serializeAttachment)

interface Attachment {
  phase: "handshake" | "ready";
  /** Only set during the handshake phase -- the nonce this connection
   * challenged the agent with. */
  nonce?: string;
  /** null only during the handshake phase. */
  workerId: string | null;
  protocol: number;
  state: "idle" | "busy" | "dispatched";
}

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

/** Validate `hello.protocol`, defaulting to 1 -- ports agentws.py's
 * `_parse_protocol`. */
function parseProtocol(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return 1;
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

  // -- fetch: HTTP entrypoints (WS upgrade + /internal/*) ------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/agent/ws") {
      return this.handleAgentWsUpgrade(request);
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
    const attachment: Attachment = { phase: "handshake", nonce, workerId: null, protocol: 1, state: "idle" };
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
      const current = server.deserializeAttachment() as Attachment | null;
      if (current && current.phase === "handshake") {
        this.closeUnauthorized(server);
      }
    }, AUTH_TIMEOUT_MS);
    this.handshakeTimers.set(server, timer);

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
        const att = ws.deserializeAttachment() as Attachment;
        await this.sendJobCancelled(ws, att, this.ephemeralFor(ws), jobId);
      }
    }

    // Panel notification (panelws.job_cancelled parity) is Task 7's job via
    // the panel WS relay this same DO will host -- `/internal/event` is the
    // stub that lands then.

    await this.scheduleAlarmIfNeeded();

    return Response.json({ cancelled: true, worker_id: owner });
  }

  private async handleInternalEvent(request: Request): Promise<Response> {
    // Panel event-bus stub: Task 7 completes this (real relay to connected
    // panel WS clients). Draining the body keeps a caller that already sends
    // one from erroring on an unconsumed stream.
    await request.arrayBuffer().catch(() => undefined);
    return new Response(null, { status: 202 });
  }

  private async handleInternalDynamic(url: URL): Promise<Response> {
    const workerId = url.searchParams.get("worker_id") ?? "";
    const ws = workerId ? this.findWsForWorker(workerId) : null;
    const dynamic = ws ? (this.ephemeral.get(ws)?.dynamic ?? null) : null;
    return Response.json({ dynamic });
  }

  // -- Hibernatable WebSocket handlers --------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;

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
    attachment: Attachment,
    raw: string | ArrayBuffer
  ): Promise<void> {
    this.clearHandshakeTimer(ws);

    let parsed: unknown;
    try {
      const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
      parsed = JSON.parse(text);
    } catch {
      this.closeUnauthorized(ws);
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      this.closeUnauthorized(ws);
      return;
    }
    const auth = parsed as Record<string, unknown>;
    if (auth.type !== "auth" || typeof auth.worker_id !== "string" || typeof auth.sig !== "string") {
      this.closeUnauthorized(ws);
      return;
    }

    const worker = await queries.getWorkerById(this.env.DB, auth.worker_id);
    if (!worker || worker.disabled) {
      this.closeUnauthorized(ws);
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
      const otherAttachment = other.deserializeAttachment() as Attachment | null;
      if (otherAttachment && otherAttachment.phase === "ready" && otherAttachment.workerId === worker.id) {
        this.ephemeral.delete(other);
        try {
          other.close(1000, "superseded by a newer connection");
        } catch {
          // Best-effort -- a socket already closing/closed is fine to skip.
        }
      }
    }

    const ready: Attachment = { phase: "ready", workerId: worker.id, protocol: 1, state: "idle" };
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

  private clearHandshakeTimer(ws: WebSocket): void {
    const t = this.handshakeTimers.get(ws);
    if (t !== undefined) {
      clearTimeout(t);
      this.handshakeTimers.delete(ws);
    }
  }

  // -- hello -------------------------------------------------------------

  /** Ports agentws.py's `_handle_hello`. */
  private async handleHello(ws: WebSocket, attachment: Attachment, msg: Record<string, unknown>): Promise<void> {
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

    await queries.updateWorkerHello(this.env.DB, workerId, {
      hardware,
      backend,
      torchVersion,
      nodeClasses,
      protocol,
      lastSeen: toSqliteTimestamp(new Date()),
    });

    ws.serializeAttachment({ ...attachment, protocol } satisfies Attachment);

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
    attachment: Attachment,
    ephemeral: Ephemeral,
    msg: Record<string, unknown>
  ): Promise<void> {
    const db = this.env.DB;
    const workerId = attachment.workerId!;
    const worker = await queries.getWorkerById(db, workerId);
    if (!worker) return;

    const state = msg.state === "idle" || msg.state === "busy" ? (msg.state as "idle" | "busy") : undefined;
    const dynamic =
      typeof msg.dynamic === "object" && msg.dynamic !== null && !Array.isArray(msg.dynamic)
        ? (msg.dynamic as Record<string, unknown>)
        : {};
    const now = new Date();
    const newStatus = state === "idle" ? "online" : state === "busy" ? "busy" : worker.status;

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
        if (typeof progress === "number" && Number.isFinite(progress)) {
          await queries.updateJobProgress(db, jobId, progress);
          // Panel progress relay (panelws.job_progress parity) -- Task 7.
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
    if (state === "busy" && jobId) {
      await this.applyOwnedTransition(db, jobId, workerId, ["assigned"], ephemeral, async () => {
        await queries.updateJobRunning(db, jobId, toSqliteTimestamp(now));
        // Panel running relay (panelws.job_running parity) -- Task 7.
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
  private async handleInventory(attachment: Attachment, msg: Record<string, unknown>): Promise<void> {
    const workerId = attachment.workerId!;
    const worker = await queries.getWorkerById(this.env.DB, workerId);
    if (!worker) return;
    await queries.updateWorkerModelInventory(this.env.DB, workerId, normalizeModels(msg.models));
  }

  // -- job_done / job_failed --------------------------------------------------

  /** Ports agentws.py's `_handle_job_done` (incl. blip re-adoption via
   * `dispatch.try_readopt`). */
  private async handleJobDone(
    ws: WebSocket,
    attachment: Attachment,
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
      // Panel job_done relay (panelws.job_done parity) -- Task 7.
      const execSeconds = isValidExecSeconds(msg.exec_seconds) ? msg.exec_seconds : null;
      await this.createAndPushReceipt(ws, attachment, jobId!, execSeconds, now);
    }
  }

  /** Ports agentws.py's `job_failed` branch of `_handle_message` +
   * `_create_and_push_failure_receipt`. */
  private async handleJobFailed(
    ws: WebSocket,
    attachment: Attachment,
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
      // Panel job_failed relay (panelws.job_failed parity) -- Task 7.
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
    attachment: Attachment,
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
    attachment: Attachment,
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
    attachment: Attachment,
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
  private async handleReceiptAck(attachment: Attachment, msg: Record<string, unknown>): Promise<void> {
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

    const worker = await queries.getWorkerById(db, workerId);
    if (!worker) return;

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

    try {
      // Requeued jobs' panel relay (panelws.job_requeued / job_status_refresh
      // parity) is Task 7's job; the requeue itself (DB-only) runs today.
      await dispatch.requeueStale(db, now);
    } catch (err) {
      console.error("hub: requeueStale failed", err);
    }

    const idleWorkerIds: string[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att && att.phase === "ready" && att.state === "idle" && att.workerId) {
        idleWorkerIds.push(att.workerId);
      }
    }

    let assignments: dispatch.Assignment[] = [];
    try {
      assignments = await dispatch.assignJobs(db, idleWorkerIds);
    } catch (err) {
      console.error("hub: assignJobs failed", err);
    }

    for (const { workerId, job } of assignments) {
      const ws = this.findWsForWorker(workerId);
      if (!ws) continue;
      try {
        ws.send(
          JSON.stringify({
            type: "job",
            job_id: job.id,
            workflow_json: job.workflowJson,
            input_assets: job.inputAssets,
          })
        );
        const att = ws.deserializeAttachment() as Attachment;
        // Presume busy until the next heartbeat says otherwise, so the next
        // tick doesn't double-push before the agent reports in.
        ws.serializeAttachment({ ...att, state: "dispatched" } satisfies Attachment);
      } catch (err) {
        console.error(`hub: failed to push job to worker ${workerId}`, err);
      }
    }
  }

  async alarm(): Promise<void> {
    await this.tick();

    const anyConnected = this.ctx.getWebSockets().length > 0;
    const active = anyConnected || (await queries.hasActiveJobs(this.env.DB));
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
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att && att.phase === "ready" && att.workerId === workerId) return ws;
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
}
