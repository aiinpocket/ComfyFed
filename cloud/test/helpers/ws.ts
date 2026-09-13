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
