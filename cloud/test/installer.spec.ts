/**
 * `GET /install.ps1|.sh|.cmd` and `GET /api/platform` -- ports
 * `tests/server/test_installers.py`'s coverage onto `routes/installer.ts`.
 * See that file and `routes/installer.ts`'s own docstring for the binding
 * spec/security posture this mirrors: token/platform_url validated BEFORE
 * substitution, every injection payload rejected with a fixed 400 body,
 * `Cache-Control: no-store` on the three script responses, install.sh
 * served LF-only, install.ps1 served BOM-less with intact 中文.
 *
 * The three templates the ASSETS binding serves under `install-templates/`
 * are the REAL scripts, staged into `test/fixtures/assets/install-templates/`
 * by `test/global-setup.ts` from `server/comfyfed_server/installers/` --
 * not a second checked-in copy.
 */

import { afterEach, describe, expect, it } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function loginSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function setPlatformUrl(url: string): Promise<void> {
  await db()
    .prepare("INSERT INTO settings (key, value) VALUES ('platform_url', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(url)
    .run();
}

/** Like `call`, but lets the test control the request's own origin -- needed
 * for the Host-derived-fallback validation case, where `call`'s fixed
 * `http://example.com` origin would always be valid. Apostrophes are not
 * forbidden host code points per the WHATWG URL parser, so
 * `http://evil'host/...` parses with hostname `evil'host` -- same shape
 * Python's `TestClient(base_url="http://evil'host")` exercises. */
async function callWithOrigin(origin: string, path: string): Promise<{ status: number; body: any }> {
  const request = new Request(`${origin}${path}`, { method: "GET" });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

// ---------------------------------------------------------------------------
// GET /install.ps1 | /install.sh | /install.cmd
// ---------------------------------------------------------------------------

describe.each(["/install.ps1", "/install.sh", "/install.cmd"])("GET %s", (path) => {
  it("serves with text/plain content-type", async () => {
    await setPlatformUrl("https://console.example.com");
    const r = await call(path, { method: "GET" });
    expect(r.status).toBe(200);
  });

  it("is not cached", async () => {
    await setPlatformUrl("https://console.example.com");
    const request = new Request(`http://example.com${path}`);
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("falls back to the request's own origin when platform_url is unset", async () => {
    const r = await call(path, { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body).toContain("http://example.com");
    expect(r.body).not.toContain("{{PLATFORM_URL}}");
  });
});

describe.each(["/install.ps1", "/install.sh"])("GET %s substitution", (path) => {
  it("substitutes platform_url and token", async () => {
    await setPlatformUrl("https://console.example.com");
    const r = await call(`${path}?token=tok_abc123`, { method: "GET" });
    expect(r.body).not.toContain("{{PLATFORM_URL}}");
    expect(r.body).not.toContain("{{REGISTER_TOKEN}}");
    expect(r.body).toContain("https://console.example.com");
    expect(r.body).toContain("tok_abc123");
  });
});

it("install.ps1 defaults token to empty string, keeping quoting intact", async () => {
  await setPlatformUrl("https://console.example.com");
  const r = await call("/install.ps1", { method: "GET" });
  expect(r.body).not.toContain("{{REGISTER_TOKEN}}");
  expect(r.body).toContain("$RegisterToken = ''");
});

it("install.sh defaults token to empty string, keeping quoting intact", async () => {
  await setPlatformUrl("https://console.example.com");
  const r = await call("/install.sh", { method: "GET" });
  expect(r.body).not.toContain("{{REGISTER_TOKEN}}");
  expect(r.body).toContain("REGISTER_TOKEN=''");
});

it("install.cmd omits the query string when token is absent", async () => {
  await setPlatformUrl("https://console.example.com");
  const r = await call("/install.cmd", { method: "GET" });
  expect(r.body).not.toContain("{{TOKEN_QUERY}}");
  expect(r.body).toContain("install.ps1' | iex");
  expect(r.body).not.toContain("token=");
});

it("install.cmd percent-encodes and includes the token query when present", async () => {
  await setPlatformUrl("https://console.example.com");
  const r = await call("/install.cmd?token=tok_xyz", { method: "GET" });
  expect(r.body).not.toContain("{{TOKEN_QUERY}}");
  expect(r.body).toContain("install.ps1?token=tok_xyz' | iex");
});

it("install.sh is served with LF-only line endings (no CRLF)", async () => {
  await setPlatformUrl("https://console.example.com");
  const request = new Request("http://example.com/install.sh");
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  const raw = await response.text();
  expect(raw).not.toContain("\r\n");
});

it("install.ps1 is served without a BOM and with intact 中文", async () => {
  await setPlatformUrl("https://console.example.com");
  const r = await call("/install.ps1", { method: "GET" });
  expect(r.body.startsWith("﻿")).toBe(false);
  expect(r.body).not.toContain("﻿");
  expect(r.body).toContain("中文/EN bilingual");
});

// ---------------------------------------------------------------------------
// GET /api/platform
// ---------------------------------------------------------------------------

describe("GET /api/platform", () => {
  it("shape matches the tokens-route pubkey", async () => {
    await setPlatformUrl("https://console.example.com");
    const r = await call("/api/platform", { method: "GET" });
    expect(r.status).toBe(200);
    expect(new Set(Object.keys(r.body))).toEqual(new Set(["platform_url", "platform_pubkey"]));
    expect(r.body.platform_url).toBe("https://console.example.com");

    const { cookie, csrf } = await loginSession();
    const tokens = await call("/api/workers/tokens", { json: { name: "parity" }, cookie, headers: { "X-CSRF": csrf } });
    expect(tokens.body.bundle.platform_pubkey).toBe(r.body.platform_pubkey);
  });

  it("falls back to the request's own origin when platform_url is unset", async () => {
    const r = await call("/api/platform", { method: "GET" });
    expect(r.body.platform_url).toBe("http://example.com");
  });
});

// ---------------------------------------------------------------------------
// Token injection: every payload rejected with 400 BEFORE substitution,
// never echoed into a served script.
// ---------------------------------------------------------------------------

const TOKEN_INJECTION_PAYLOADS = ["'", '"', "`", "$(", "tok\nrm -rf /"];

describe.each(["/install.ps1", "/install.sh", "/install.cmd"])("%s token injection", (path) => {
  it.each(TOKEN_INJECTION_PAYLOADS)("rejects payload %j with a fixed 400 body", async (payload) => {
    await setPlatformUrl("https://console.example.com");
    const r = await call(`${path}?token=${encodeURIComponent(payload)}`, { method: "GET" });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_token");
    expect(r.body.message).toBe("The token parameter is invalid.");
  });

  it("rejects percent-encoded injection payloads", async () => {
    await setPlatformUrl("https://console.example.com");
    for (const encoded of ["%0A", "%27", "tok%0Arm+-rf", "tok%27;payload;%27"]) {
      const r = await call(`${path}?token=${encoded}`, { method: "GET" });
      expect(r.status, encoded).toBe(400);
      expect(r.body.error).toBe("invalid_token");
    }
  });

  it("still substitutes a valid token", async () => {
    await setPlatformUrl("https://console.example.com");
    const validToken = "AbC123_-xyz9";
    const r = await call(`${path}?token=${validToken}`, { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body).toContain(validToken);
  });
});

// ---------------------------------------------------------------------------
// platform_url validation: configured setting vs. Host-derived fallback.
// ---------------------------------------------------------------------------

describe.each(["/install.ps1", "/install.sh", "/install.cmd", "/api/platform"])("%s platform_url validation", (path) => {
  it("yields a typed 500 when the configured platform_url is invalid", async () => {
    await setPlatformUrl("https://evil.example.com/'; rm -rf ~ #");
    const r = await call(path, { method: "GET" });
    expect(r.status).toBe(500);
    expect(r.body.error).toBe("invalid_platform_url");
  });

  it("yields a sanitized 400 refusal when the Host-derived fallback is invalid, never echoing it", async () => {
    const r = await callWithOrigin("http://evil'host", path);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_request_origin");
    expect(JSON.stringify(r.body)).not.toContain("evil");
  });
});
