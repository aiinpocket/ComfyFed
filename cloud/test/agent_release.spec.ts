import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { getSetting, resolvePlatformSeed, setSetting } from "../src/db/queries";
import { buildReleasePayload } from "../src/lib/signing";
import { verifyHex, derivePublicKeyHexFromSeed } from "../src/lib/ed25519";
import {
  AGENT_LATEST_KEY,
  AGENT_MIN_SUPPORTED_KEY,
  AGENT_WHEEL_URL_KEY,
  parseBundledRelease,
  setBundledReleaseLoaderForTests,
  type BundledRelease,
} from "../src/core/agent_release";

// Spec 2026-09-24 §2.1: the Worker publishes the agent wheel its own build
// bundled under assets/agent/, when that is newer than what is stored. The
// manifest source is swapped per test through the module's test seam; the
// real ASSETS path is exercised once at the end against the fixture assets
// root (which has no /agent/release.json, so the SPA fallback answers).

const ADMIN_PASSWORD = "correct-horse-battery-staple";
const SHA = "a".repeat(64);

afterEach(async () => {
  setBundledReleaseLoaderForTests(null);
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
});

function bundled(version: string): BundledRelease {
  return { version, filename: `comfyfed-${version}-py3-none-any.whl`, sha256: SHA };
}

function useBundled(release: BundledRelease | null): void {
  setBundledReleaseLoaderForTests(async () => release);
}

async function adminSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

describe("parseBundledRelease", () => {
  it("accepts the build's manifest shape and rejects anything else", () => {
    expect(parseBundledRelease({ version: "0.1.18", filename: "comfyfed-0.1.18-py3-none-any.whl", sha256: SHA })).toEqual(
      bundled("0.1.18")
    );
    expect(parseBundledRelease(null)).toBeNull();
    expect(parseBundledRelease("<!doctype html>")).toBeNull();
    expect(parseBundledRelease({ version: "x", filename: "a.whl", sha256: SHA })).toBeNull();
    expect(parseBundledRelease({ version: "0.1.18", filename: "../evil.whl", sha256: SHA })).toBeNull();
    expect(parseBundledRelease({ version: "0.1.18", filename: "a.whl", sha256: "short" })).toBeNull();
  });
});

describe("ensureBundledAgentRelease via GET /api/agent/version", () => {
  it("publishes a bundled release newer than the stored one, signed by the platform key", async () => {
    useBundled(bundled("0.2.0"));
    const r = await call("/api/agent/version");
    expect(r.status).toBe(200);
    expect(r.body.latest).toBe("0.2.0");
    expect(r.body.min_supported).toBe("0.1.0");
    expect(r.body.sha256).toBe(SHA);
    // Relative in the DB, absolutised by the route (no platform_url set →
    // this request's origin).
    expect(await getSetting(db(), AGENT_WHEEL_URL_KEY)).toBe("/agent/comfyfed-0.2.0-py3-none-any.whl");
    expect(r.body.wheel_url).toBe("http://example.com/agent/comfyfed-0.2.0-py3-none-any.whl");

    const seed = await resolvePlatformSeed(db(), (env as any).PLATFORM_ED25519_SEED);
    const pubkey = await derivePublicKeyHexFromSeed(seed);
    const payload = new TextEncoder().encode(buildReleasePayload("0.2.0", SHA));
    expect(await verifyHex(pubkey, payload, r.body.platform_sig)).toBe(true);
  });

  it("never downgrades: a bundled version below the stored latest is ignored", async () => {
    await setSetting(db(), AGENT_LATEST_KEY, "0.5.0");
    useBundled(bundled("0.2.0"));
    const r = await call("/api/agent/version");
    expect(r.body.latest).toBe("0.5.0");
    expect(r.body.wheel_url).toBeNull();
  });

  it("keeps a stored min_supported instead of ratcheting it", async () => {
    await setSetting(db(), AGENT_MIN_SUPPORTED_KEY, "0.1.5");
    useBundled(bundled("0.2.0"));
    const r = await call("/api/agent/version");
    expect(r.body.latest).toBe("0.2.0");
    expect(r.body.min_supported).toBe("0.1.5");
  });

  it("is checked once per isolate, so a later manual publish of a higher version stays in force", async () => {
    useBundled(bundled("0.2.0"));
    expect((await call("/api/agent/version")).body.latest).toBe("0.2.0");

    const { cookie, csrf } = await adminSession();
    const publish = await call("/api/workers/agent-release?filename=comfyfed-0.3.0-py3-none-any.whl", {
      rawBody: new Uint8Array([1, 2, 3]),
      cookie,
      headers: { "X-CSRF": csrf },
    });
    expect(publish.status).toBe(200);
    expect((await call("/api/agent/version")).body.latest).toBe("0.3.0");
  });

  it("leaves the defaults alone when the build bundled no release", async () => {
    useBundled(null);
    const r = await call("/api/agent/version");
    expect(r.body).toEqual({ latest: "0.1.0", min_supported: "0.1.0", wheel_url: null, sha256: null, platform_sig: null });
  });

  it("treats the SPA fallback (no /agent/release.json in ASSETS) as no release", async () => {
    // Default loader against the fixture assets root: the path is missing,
    // so ASSETS answers with index.html and status 200 -- must not publish.
    const r = await call("/api/agent/version");
    expect(r.body.latest).toBe("0.1.0");
    expect(await getSetting(db(), AGENT_LATEST_KEY)).toBeNull();
  });
});

describe("ensureBundledAgentRelease via GET /api/workers", () => {
  it("publishes before the console reads the fleet, so the outdated badge is right on first load", async () => {
    useBundled(bundled("0.2.0"));
    const { cookie } = await adminSession();
    const r = await call("/api/workers", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(await getSetting(db(), AGENT_LATEST_KEY)).toBe("0.2.0");
  });
});
