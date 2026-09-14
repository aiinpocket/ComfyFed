import { afterEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp, resolvePlatformSeed, getSetting } from "../src/db/queries";
import { signRequest, verifyHex } from "../src/lib/signing";
import { verifyAgentRequest } from "../src/lib/verify_agent";
import { derivePublicKeyHexFromSeed } from "../src/lib/ed25519";
import { hexToBytes, bytesToHex } from "../src/lib/hex";
import workersApp from "../src/routes/workers";
import golden from "./fixtures/golden.json";

// vitest-pool-workers isolates D1 storage per test FILE (see task-1-report.md
// / dispatch.spec.ts) -- every test in this file shares one D1 instance.
afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  await db().prepare("DELETE FROM login_attempts").run();
});

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function adminSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function issueToken(name = "gpu-box"): Promise<{ token: string; platformPubkey: string }> {
  const { cookie, csrf } = await adminSession();
  const r = await call("/api/workers/tokens", { json: { name }, cookie, headers: { "X-CSRF": csrf } });
  expect(r.status).toBe(200);
  return { token: r.body.bundle.register_token, platformPubkey: r.body.bundle.platform_pubkey };
}

interface RegisteredWorker {
  workerId: string;
  seedHex: string;
  pubkeyHex: string;
  platformPubkey: string;
}

async function registerWorker(name = "gpu-box"): Promise<RegisteredWorker> {
  const { token, platformPubkey } = await issueToken(name);
  const kp = golden.keypairs[0]!;
  const r = await call("/api/agent/register", { json: { token, pubkey: kp.pubkey_hex } });
  expect(r.status).toBe(200);
  return { workerId: r.body.worker_id, seedHex: kp.seed_hex, pubkeyHex: kp.pubkey_hex, platformPubkey };
}

async function signedPost(
  worker: RegisteredWorker,
  path: string,
  opts: {
    query?: string;
    body?: Uint8Array;
    ts?: string;
    nonce?: string;
    headers?: Record<string, string>;
    corruptSig?: boolean;
  } = {}
) {
  const query = opts.query ?? "";
  const body = opts.body ?? new Uint8Array();
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? crypto.randomUUID().replace(/-/g, "");
  let sig = await signRequest(worker.seedHex, "POST", path, query, ts, nonce, body);
  if (opts.corruptSig) {
    sig = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
  }
  const fullPath = query ? `${path}?${query}` : path;
  return call(fullPath, {
    method: "POST",
    rawBody: body,
    headers: {
      "X-Worker-Id": worker.workerId,
      "X-Ts": ts,
      "X-Nonce": nonce,
      "X-Sig": sig,
      ...(opts.headers ?? {}),
    },
  });
}

// ---------------------------------------------------------------------------
// POST /api/workers/tokens

describe("POST /api/workers/tokens", () => {
  it("401s without a session", async () => {
    const r = await call("/api/workers/tokens", { json: { name: "x" } });
    expect(r.status).toBe(401);
  });

  it("403s without X-CSRF", async () => {
    const { cookie } = await adminSession();
    const r = await call("/api/workers/tokens", { json: { name: "x" }, cookie });
    expect(r.status).toBe(403);
  });

  it("issues a bundle with platform_url/platform_pubkey/register_token", async () => {
    const { cookie, csrf } = await adminSession();
    await call("/api/settings", {
      json: { platform_url: "https://fed.example" },
      cookie,
      headers: { "X-CSRF": csrf },
    });
    const r = await call("/api/workers/tokens", { json: { name: "gpu-1" }, cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(200);
    expect(r.body.bundle.platform_url).toBe("https://fed.example");
    expect(typeof r.body.bundle.register_token).toBe("string");
    expect(r.body.bundle.register_token.length).toBeGreaterThan(0);
    expect(r.body.bundle.platform_pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hands out a stable platform_pubkey across calls (same persisted seed)", async () => {
    const { cookie, csrf } = await adminSession();
    const r1 = await call("/api/workers/tokens", { json: { name: "a" }, cookie, headers: { "X-CSRF": csrf } });
    const r2 = await call("/api/workers/tokens", { json: { name: "b" }, cookie, headers: { "X-CSRF": csrf } });
    expect(r1.body.bundle.platform_pubkey).toBe(r2.body.bundle.platform_pubkey);
  });
});

// ---------------------------------------------------------------------------
// resolvePlatformSeed -- PLATFORM_ED25519_SEED env override vs. lazy D1 row

describe("resolvePlatformSeed", () => {
  const VALID_ENV_SEED = "11".repeat(32); // 64 hex chars = 32 bytes

  it("uses the env seed when set, and never touches the D1 row", async () => {
    const seed = await resolvePlatformSeed(db(), VALID_ENV_SEED);
    expect(seed).toBe(VALID_ENV_SEED);
    expect(await getSetting(db(), "platform_seed")).toBeNull();
  });

  it("falls back to the lazily-generated D1 row when the env is absent", async () => {
    const seed = await resolvePlatformSeed(db(), undefined);
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(await getSetting(db(), "platform_seed")).toBe(seed);

    // Second call reuses the same persisted row rather than regenerating.
    const again = await resolvePlatformSeed(db(), undefined);
    expect(again).toBe(seed);
  });

  it("falls back to the D1 row for an empty-string env value too", async () => {
    const seed = await resolvePlatformSeed(db(), "");
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it("throws a clear error for a non-hex env seed", async () => {
    await expect(resolvePlatformSeed(db(), "not-hex-at-all")).rejects.toThrow(/PLATFORM_ED25519_SEED/);
    expect(await getSetting(db(), "platform_seed")).toBeNull();
  });

  it("throws a clear error for a wrong-length (but validly-hex) env seed", async () => {
    await expect(resolvePlatformSeed(db(), "ab")).rejects.toThrow(/32 bytes/);
    expect(await getSetting(db(), "platform_seed")).toBeNull();
  });

  it("route wiring: POST /api/workers/tokens derives platform_pubkey from a bound PLATFORM_ED25519_SEED, D1 row untouched", async () => {
    const { cookie, csrf } = await adminSession();
    const envWithSeed = { ...(env as any), PLATFORM_ED25519_SEED: VALID_ENV_SEED };
    const request = new Request("http://example.com/api/workers/tokens", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
        "X-CSRF": csrf,
      },
      body: JSON.stringify({ name: "env-seeded" }),
    });
    const ctx = createExecutionContext();
    const response = await workersApp.fetch(request, envWithSeed, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    const body = await response.json<any>();
    const expectedPubkey = await derivePublicKeyHexFromSeed(VALID_ENV_SEED);
    expect(body.bundle.platform_pubkey).toBe(expectedPubkey);
    expect(await getSetting(db(), "platform_seed")).toBeNull();
  });

  it("route wiring: falls back to the D1-persisted seed when PLATFORM_ED25519_SEED isn't bound", async () => {
    const { cookie, csrf } = await adminSession();
    const r = await call("/api/workers/tokens", { json: { name: "d1-seeded" }, cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(200);
    const persisted = await getSetting(db(), "platform_seed");
    expect(persisted).toMatch(/^[0-9a-f]{64}$/);
    expect(r.body.bundle.platform_pubkey).toBe(await derivePublicKeyHexFromSeed(persisted!));
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/register

describe("POST /api/agent/register", () => {
  it("rejects an unknown token", async () => {
    const r = await call("/api/agent/register", { json: { token: "nope", pubkey: "ab".repeat(32) } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("register.token_invalid");
  });

  it("registers a worker and returns a certificate signed by the platform key", async () => {
    const { token, platformPubkey } = await issueToken("gpu-1");
    const kp = golden.keypairs[0]!;
    const r = await call("/api/agent/register", { json: { token, pubkey: kp.pubkey_hex } });
    expect(r.status).toBe(200);
    expect(typeof r.body.worker_id).toBe("string");

    const payload = `${r.body.worker_id}|${kp.pubkey_hex}`;
    const ok = await verifyHex(platformPubkey, new TextEncoder().encode(payload), r.body.certificate);
    expect(ok).toBe(true);

    const row = await db().prepare("SELECT * FROM workers WHERE id = ?").bind(r.body.worker_id).first<any>();
    expect(row.pubkey).toBe(kp.pubkey_hex);
    expect(row.name).toBe("gpu-1");
    expect(row.status).toBe("offline");
    expect(row.disabled).toBe(0);
  });

  it("prefers the body's name over the token's stored name", async () => {
    const { token } = await issueToken("token-name");
    const kp = golden.keypairs[0]!;
    const r = await call("/api/agent/register", { json: { token, name: "override", pubkey: kp.pubkey_hex } });
    const row = await db().prepare("SELECT name FROM workers WHERE id = ?").bind(r.body.worker_id).first<any>();
    expect(row.name).toBe("override");
  });

  it("rejects reusing an already-claimed token", async () => {
    const { token } = await issueToken();
    const kp = golden.keypairs[0]!;
    const first = await call("/api/agent/register", { json: { token, pubkey: kp.pubkey_hex } });
    expect(first.status).toBe(200);
    const second = await call("/api/agent/register", { json: { token, pubkey: golden.keypairs[1]!.pubkey_hex } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("register.token_used");
  });
});

// ---------------------------------------------------------------------------
// Signed-request verification (POST /api/agent/ping as the exercising route)

describe("signed agent requests (verify_agent)", () => {
  it("accepts a freshly-signed request", async () => {
    const worker = await registerWorker();
    const r = await signedPost(worker, "/api/agent/ping");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("rejects missing signature headers", async () => {
    const r = await call("/api/agent/ping", { method: "POST", rawBody: new Uint8Array() });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("agent.bad_signature");
  });

  it("rejects an unknown worker id", async () => {
    const worker = await registerWorker();
    const fake = { ...worker, workerId: "not-a-real-worker-id" };
    const r = await signedPost(fake, "/api/agent/ping");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("agent.bad_signature");
  });

  it("rejects a tampered signature", async () => {
    const worker = await registerWorker();
    const r = await signedPost(worker, "/api/agent/ping", { corruptSig: true });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("agent.bad_signature");
  });

  it("rejects a timestamp outside the +-120s skew window", async () => {
    const worker = await registerWorker();
    const staleTs = String(Math.floor(Date.now() / 1000) - 121);
    const r = await signedPost(worker, "/api/agent/ping", { ts: staleTs });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("agent.bad_signature");
  });

  it("accepts a timestamp just inside the skew window", async () => {
    const worker = await registerWorker();
    const okTs = String(Math.floor(Date.now() / 1000) - 100);
    const r = await signedPost(worker, "/api/agent/ping", { ts: okTs });
    expect(r.status).toBe(200);
  });

  it("rejects a replayed nonce", async () => {
    const worker = await registerWorker();
    const nonce = "fixed-nonce-for-replay-test";
    const first = await signedPost(worker, "/api/agent/ping", { nonce });
    expect(first.status).toBe(200);
    const second = await signedPost(worker, "/api/agent/ping", { nonce });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("agent.replay");
  });

  it("rejects requests from a disabled worker (after signature verifies)", async () => {
    const worker = await registerWorker();
    await db().prepare("UPDATE workers SET disabled = 1 WHERE id = ?").bind(worker.workerId).run();
    const r = await signedPost(worker, "/api/agent/ping");
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("agent.worker_disabled");
  });

  it("golden-vector signed request is accepted by verifyAgentRequest at its own ts", async () => {
    const kp = golden.keypairs[0]!;
    const s = kp.signed_request_sample_no_query;
    const workerId = "golden-worker-1";
    await db()
      .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES (?, 'golden', ?, ?)")
      .bind(workerId, kp.pubkey_hex, toSqliteTimestamp(new Date()))
      .run();

    const result = await verifyAgentRequest(
      db(),
      { workerId, ts: s.ts, nonce: s.nonce, sig: s.signature_hex },
      { method: s.method, path: s.path, query: s.query, body: hexToBytes(s.body_hex) },
      Number.parseInt(s.ts, 10)
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.worker.id).toBe(workerId);
  });

  it("golden-vector signed request is rejected outside its ts window", async () => {
    const kp = golden.keypairs[0]!;
    const s = kp.signed_request_sample;
    const workerId = "golden-worker-2";
    await db()
      .prepare("INSERT INTO workers (id, name, pubkey, created_at) VALUES (?, 'golden', ?, ?)")
      .bind(workerId, kp.pubkey_hex, toSqliteTimestamp(new Date()))
      .run();

    const result = await verifyAgentRequest(
      db(),
      { workerId, ts: s.ts, nonce: s.nonce, sig: s.signature_hex },
      { method: s.method, path: s.path, query: s.query, body: hexToBytes(s.body_hex) },
      Number.parseInt(s.ts, 10) + 1000
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("agent.bad_signature");
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/object_info

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function sha256HexOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

describe("POST /api/agent/object_info", () => {
  it("stores a valid gzip payload to R2 and records its hash", async () => {
    const worker = await registerWorker();
    const payload = new TextEncoder().encode(JSON.stringify({ CheckpointLoaderSimple: { input: {} } }));
    const gz = await gzip(payload);
    const hash = await sha256HexOf(payload);

    const r = await signedPost(worker, "/api/agent/object_info", { body: gz, headers: { "X-OI-Hash": hash } });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });

    const obj = await store().get(`object_info/${worker.workerId}.json.gz`);
    expect(obj).not.toBeNull();
    const stored = new Uint8Array(await obj!.arrayBuffer());
    expect(bytesToHex(stored)).toBe(bytesToHex(gz));

    const row = await db().prepare("SELECT object_info_hash FROM workers WHERE id = ?").bind(worker.workerId).first<any>();
    expect(row.object_info_hash).toBe(hash);
  });

  it("400s when X-OI-Hash is missing", async () => {
    const worker = await registerWorker();
    const gz = await gzip(new TextEncoder().encode("{}"));
    const r = await signedPost(worker, "/api/agent/object_info", { body: gz });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("agent.bad_object_info");
  });

  it("400s when X-OI-Hash does not match the payload", async () => {
    const worker = await registerWorker();
    const gz = await gzip(new TextEncoder().encode("{}"));
    const r = await signedPost(worker, "/api/agent/object_info", {
      body: gz,
      headers: { "X-OI-Hash": "0".repeat(64) },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("agent.bad_object_info");
  });

  it("400s on invalid gzip", async () => {
    const worker = await registerWorker();
    const notGzip = new TextEncoder().encode("this is not gzip");
    const r = await signedPost(worker, "/api/agent/object_info", {
      body: notGzip,
      headers: { "X-OI-Hash": await sha256HexOf(notGzip) },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("agent.bad_object_info");
  });

  it("400s when the decompressed payload is not valid JSON", async () => {
    const worker = await registerWorker();
    const gz = await gzip(new TextEncoder().encode("not json"));
    const hash = await sha256HexOf(new TextEncoder().encode("not json"));
    const r = await signedPost(worker, "/api/agent/object_info", { body: gz, headers: { "X-OI-Hash": hash } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("agent.bad_object_info");
  });

  it("413s when the compressed body exceeds the 8MB cap", async () => {
    const worker = await registerWorker();
    const big = new Uint8Array(8 * 1024 * 1024 + 1);
    const r = await signedPost(worker, "/api/agent/object_info", { body: big, headers: { "X-OI-Hash": "x" } });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("agent.object_info_too_large");
  });

  it("413s when the decompressed payload exceeds the 32MB cap", async () => {
    const worker = await registerWorker();
    // Highly compressible: 33MB of zeros compresses to a few KB, well under
    // the 8MB *compressed* cap, so this exercises the *decompressed* cap.
    const huge = new Uint8Array(33 * 1024 * 1024);
    const gz = await gzip(huge);
    const r = await signedPost(worker, "/api/agent/object_info", {
      body: gz,
      headers: { "X-OI-Hash": await sha256HexOf(huge) },
    });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe("agent.object_info_too_large");
  }, 30000);
});

// ---------------------------------------------------------------------------
// GET /api/workers

describe("GET /api/workers", () => {
  it("401s without a session", async () => {
    const r = await call("/api/workers", { method: "GET" });
    expect(r.status).toBe(401);
  });

  it("lists workers with the console shape (hardware/dynamic/model_count)", async () => {
    const worker = await registerWorker("gpu-1");
    await db()
      .prepare(
        `UPDATE workers SET status='idle', last_seen=?, hardware=?, dynamic=?, backend='pytorch', torch_version='2.4.0',
         model_inventory=? WHERE id = ?`
      )
      .bind(
        toSqliteTimestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 123))),
        JSON.stringify({ gpu: "RTX 4090", vram_gb: 24 }),
        JSON.stringify({ queue_depth: 2 }),
        JSON.stringify([{ name: "sd_xl.safetensors" }, { name: "vae.safetensors" }]),
        worker.workerId
      )
      .run();

    const { cookie } = await adminSession();
    const r = await call("/api/workers", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    const w = r.body[0];
    expect(w.id).toBe(worker.workerId);
    expect(w.name).toBe("gpu-1");
    expect(w.status).toBe("idle");
    expect(w.last_seen).toBe("2026-01-02T03:04:05.123000");
    expect(w.disabled).toBe(false);
    expect(w.hardware).toEqual({ gpu: "RTX 4090", vram_gb: 24 });
    expect(w.dynamic).toEqual({ queue_depth: 2 });
    expect(w.backend).toBe("pytorch");
    expect(w.torch_version).toBe("2.4.0");
    expect(w.model_count).toBe(2);
  });

  it("reports last_seen: null for a worker that never heartbeated", async () => {
    await registerWorker("fresh");
    const { cookie } = await adminSession();
    const r = await call("/api/workers", { method: "GET", cookie });
    expect(r.body[0].last_seen).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// GET /api/agent/version

describe("GET /api/agent/version", () => {
  it("reports defaults when no agent settings are configured", async () => {
    const r = await call("/api/agent/version", { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      latest: "0.1.0",
      min_supported: "0.1.0",
      wheel_url: null,
      sha256: null,
      platform_sig: null,
    });
  });
});

// ---------------------------------------------------------------------------
// POST /api/workers/{id}/disable

describe("POST /api/workers/:id/disable", () => {
  it("401s without a session", async () => {
    const worker = await registerWorker();
    const r = await call(`/api/workers/${worker.workerId}/disable`, { method: "POST" });
    expect(r.status).toBe(401);
  });

  it("403s without X-CSRF", async () => {
    const worker = await registerWorker();
    const { cookie } = await adminSession();
    const r = await call(`/api/workers/${worker.workerId}/disable`, { method: "POST", cookie });
    expect(r.status).toBe(403);
  });

  it("disables an existing worker", async () => {
    const worker = await registerWorker();
    const { cookie, csrf } = await adminSession();
    const r = await call(`/api/workers/${worker.workerId}/disable`, {
      method: "POST",
      cookie,
      headers: { "X-CSRF": csrf },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });

    const row = await db().prepare("SELECT disabled FROM workers WHERE id = ?").bind(worker.workerId).first<any>();
    expect(row.disabled).toBe(1);
  });

  it("404s for an unknown worker id", async () => {
    const { cookie, csrf } = await adminSession();
    const r = await call("/api/workers/does-not-exist/disable", {
      method: "POST",
      cookie,
      headers: { "X-CSRF": csrf },
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("workers.not_found");
  });
});
