/** Agent-WebSocket test helpers for hub.spec.ts -- opens a real hibernatable
 * WebSocket against the Worker's `/api/agent/ws` route (which forwards to
 * the singleton Hub DO, see src/do/hub.ts) and drives the handshake the same
 * way `comfyfed-agent` does, using a golden keypair to sign the challenge
 * nonce. */
import worker from "../../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect } from "vitest";
import { signHex } from "../../src/lib/ed25519";

export async function openAgentWs(): Promise<WebSocket> {
  const request = new Request("http://example.com/api/agent/ws", { headers: { Upgrade: "websocket" } });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`expected 101 with a webSocket, got ${response.status}`);
  }
  const ws = response.webSocket;
  ws.accept();
  return ws;
}

export function nextMessage(ws: WebSocket, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error("timeout waiting for a WebSocket message"));
    }, timeoutMs);
    const onMessage = (evt: MessageEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
      const data = evt.data;
      try {
        resolve(typeof data === "string" ? JSON.parse(data) : data);
      } catch {
        resolve(data);
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

/** Collects exactly `count` messages via a SINGLE listener attached before
 * returning, resolving with them in arrival order. Use this (instead of
 * calling `nextMessage` once per expected message, sequentially awaiting
 * each) whenever a single trigger can produce more than one message in
 * quick succession -- e.g. a DO method that sends two panel events back to
 * back before its promise resolves. Awaiting one `nextMessage` call at a
 * time races: a message that arrives while no listener is attached (the gap
 * between resolving one `nextMessage` promise and calling the next) is lost
 * forever, since a `WebSocket` doesn't replay past events to a listener
 * attached later. Must be called (attaching the listener) BEFORE whatever
 * triggers the messages. */
export function collectMessages(ws: WebSocket, count: number, timeoutMs = 3000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const collected: any[] = [];
    const timer = setTimeout(() => {
      ws.removeEventListener("message", onMessage);
      reject(new Error(`timeout waiting for ${count} WebSocket messages (got ${collected.length})`));
    }, timeoutMs);
    const onMessage = (evt: MessageEvent) => {
      const data = evt.data;
      try {
        collected.push(typeof data === "string" ? JSON.parse(data) : data);
      } catch {
        collected.push(data);
      }
      if (collected.length >= count) {
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve(collected);
      }
    };
    ws.addEventListener("message", onMessage);
  });
}

/** Asserts no message arrives within `timeoutMs` -- used to prove a dedup or
 * a protocol-gated push did NOT happen, rather than merely hasn't happened
 * yet. Must be attached before whatever might (wrongly) trigger the push,
 * exactly like `nextMessage`. */
export function expectNoMessage(ws: WebSocket, timeoutMs = 250): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (evt: MessageEvent) => {
      cleanup();
      reject(new Error(`unexpected message: ${typeof evt.data === "string" ? evt.data : "<binary>"}`));
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      ws.removeEventListener("message", onMessage);
    }
    ws.addEventListener("message", onMessage);
  });
}

/** Polls `predicate` on a fixed interval until it returns a value other than
 * `undefined`, then resolves with that value -- replaces "sleep a fixed
 * amount and hope the DO/D1 write landed by then" synchronization with an
 * explicit condition on the observable state the caller actually depends on
 * (a job row's status, a receipt row, a worker row, etc.). `predicate`
 * itself decides readiness: return the value once the condition holds,
 * `undefined` to keep polling. Throws (naming `label`) if `timeoutMs`
 * elapses first. */
export async function waitFor<T>(
  predicate: () => Promise<T | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {}
): Promise<T> {
  const { timeoutMs = 5000, intervalMs = 25, label = "condition" } = opts;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result !== undefined) return result;
    if (Date.now() >= deadline) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("close", onClose);
      reject(new Error("timeout waiting for close"));
    }, timeoutMs);
    const onClose = (evt: CloseEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("close", onClose);
      resolve({ code: evt.code, reason: evt.reason });
    };
    ws.addEventListener("close", onClose);
  });
}

/** Opens a connection and completes the challenge/response handshake with a
 * valid signature, returning the connected socket right after `ready`. */
export async function connectAgent(workerId: string, seedHex: string): Promise<WebSocket> {
  const ws = await openAgentWs();
  const challenge = await nextMessage(ws);
  expect(challenge.type).toBe("challenge");
  const sig = await signHex(seedHex, new TextEncoder().encode(challenge.nonce));
  ws.send(JSON.stringify({ type: "auth", worker_id: workerId, sig }));
  const ready = await nextMessage(ws);
  expect(ready.type).toBe("ready");
  return ws;
}

export function hub(): DurableObjectStub {
  const ns = (env as any).HUB as DurableObjectNamespace;
  return ns.get(ns.idFromName("hub"));
}

/** Opens a panel WebSocket against `/comfy/api/ws`, forwarding `cookie` (a
 * `cf_session=...` pair, or `null` for an unauthenticated attempt) as the
 * `Cookie` header -- mirrors `openAgentWs` but for the panel side (Task 7).
 * Unlike the agent socket, an unauthenticated attempt never upgrades at all
 * (see `hub.ts`'s `handlePanelWsUpgrade` docstring), so this returns the raw
 * `Response` rather than throwing when the caller wants to assert on a
 * rejection. */
export async function openPanelWs(cookie: string | null, path = "/comfy/api/ws"): Promise<Response> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (cookie) headers["Cookie"] = cookie;
  const request = new Request(`http://example.com${path}`, { headers });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** Opens an authenticated panel WebSocket and accepts it, returning the
 * live socket. Throws if the upgrade didn't succeed (i.e. the cookie wasn't
 * valid) -- callers testing the rejection path should call `openPanelWs`
 * directly instead. */
export async function connectPanel(cookie: string, path = "/comfy/api/ws"): Promise<WebSocket> {
  const response = await openPanelWs(cookie, path);
  if (response.status !== 101 || !response.webSocket) {
    throw new Error(`expected 101 with a webSocket, got ${response.status}`);
  }
  const ws = response.webSocket;
  ws.accept();
  return ws;
}
