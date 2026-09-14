import { afterEach, describe, expect, it } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { isGateExempt } from "../src/lib/gate";

// Ports the highest-value parity assertions from app.py's
// `_comfy_session_gate` (see that middleware's docstring): unauthenticated
// requests under `/comfy/*` (except `/comfy/api/*` and the panel WebSocket
// upgrade path) redirect to `/`; `/comfy/api/*` and the WS path are exempt
// and reach their own auth instead; an authenticated request falls through
// past the gate to the ASSETS passthrough (`serveComfyAsset` in
// gate.ts/index.ts) rather than being redirected.

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function loginCookie(): Promise<string> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  expect(login.setCookie).toBeTruthy();
  return login.setCookie as string;
}

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
});

describe("isGateExempt (pure predicate)", () => {
  it("exempts /comfy/api and everything under it", () => {
    expect(isGateExempt("/comfy/api")).toBe(true);
    expect(isGateExempt("/comfy/api/queue")).toBe(true);
    expect(isGateExempt("/comfy/api/ws")).toBe(true);
  });

  it("exempts the panel WebSocket upgrade path", () => {
    expect(isGateExempt("/comfy/ws")).toBe(true);
  });

  it("does not exempt the panel page or its static assets", () => {
    expect(isGateExempt("/comfy")).toBe(false);
    expect(isGateExempt("/comfy/")).toBe(false);
    expect(isGateExempt("/comfy/index.html")).toBe(false);
    expect(isGateExempt("/comfy/assets/index-abc123.js")).toBe(false);
    expect(isGateExempt("/comfy/templates/index.json")).toBe(false);
  });

  it("does not falsely exempt a path that merely starts with the same prefix", () => {
    // "/comfy/apiary" starts with "/comfy/api" as a raw string prefix but is
    // NOT under the "/comfy/api/" tree -- must not be treated as exempt.
    expect(isGateExempt("/comfy/apiary")).toBe(false);
  });
});

describe("comfySessionGate (full app, HTTP round-trip)", () => {
  it("redirects an unauthenticated /comfy/<anything> to / with 302", async () => {
    const res = await call("/comfy/some/asset.js");
    expect(res.status).toBe(302);
  });

  it("redirect Location points at /", async () => {
    // call() only reports status/body/set-cookie; re-issue a raw request
    // here to inspect the Location header directly.
    const worker = (await import("../src/index")).default;
    const { env, createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const request = new Request("http://example.com/comfy/x");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("/");
  });

  it("does NOT redirect an unauthenticated /comfy/api/* request -- it gets its own 401 JSON", async () => {
    const res = await call("/comfy/api/queue");
    expect(res.status).toBe(401);
    expect(res.body?.error?.code).toBe("auth.required");
  });

  it("an authenticated /comfy/api/* request is unaffected by the gate", async () => {
    const cookie = await loginCookie();
    const res = await call("/comfy/api/queue", { cookie });
    expect(res.status).toBe(200);
  });

  it("an authenticated /comfy/<anything> request passes the gate (no redirect) and reaches the ASSETS passthrough", async () => {
    const cookie = await loginCookie();
    const res = await call("/comfy/some/asset.js", { cookie });
    // No `assets/` directory exists in this test environment (Task 11's
    // build output is never committed -- see build.mjs's docstring), so the
    // ASSETS binding has nothing to serve; the assertion that matters is
    // that the gate let the request through instead of redirecting it.
    expect(res.status).not.toBe(302);
  });

  it("redirects /comfy (no trailing slash) to /comfy/ when authenticated, and to / when not", async () => {
    const unauth = await call("/comfy");
    expect(unauth.status).toBe(302);
    // The gate runs before the /comfy -> /comfy/ handler, so an
    // unauthenticated hit here goes straight to the login redirect.

    const cookie = await loginCookie();
    const worker = (await import("../src/index")).default;
    const { env, createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
    const request = new Request("http://example.com/comfy", { headers: { Cookie: cookie } });
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(307);
    expect(response.headers.get("Location")).toBe("/comfy/");
  });
});
