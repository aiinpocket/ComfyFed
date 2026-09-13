import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import * as modelManifest from "../src/core/model_manifest";
import * as modelGuide from "../src/core/model_guide";
import { resolvePlatformSeed } from "../src/db/queries";
import { verifyHex, derivePublicKeyHexFromSeed } from "../src/lib/ed25519";
import { signRequest } from "../src/lib/signing";
import golden from "./fixtures/golden.json";

// Ports the highest-value cases from tests/server/test_model_manifest.py --
// see that file for the full Python suite this mirrors. Fix round 1: a hash
// conflict is a persisted `model_hashes.conflict` column (migration
// 0005_model_hash_conflict.sql), not an in-memory set -- `entries()` takes
// no poisoned-name parameter at all; exclusion is a plain SQL predicate any
// caller gets automatically.

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

afterEach(async () => {
  await db().prepare("DELETE FROM model_hashes").run();
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  modelGuide.clearHarvestCacheForTests();
});

async function seed(): Promise<string> {
  return resolvePlatformSeed(db(), (env as any).PLATFORM_ED25519_SEED);
}

async function shaHex(label: string): Promise<string> {
  const bytes = new TextEncoder().encode(label);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const GB = 1024 ** 3;
function bytesFor(gb: number): number {
  return Math.round(gb * GB);
}

// --- recordHash: consensus + conflict --------------------------------------

describe("recordHash", () => {
  it("a first report inserts a row", async () => {
    const sha = await shaHex("a");
    const result = await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", bytesFor(0.23), sha);
    expect(result.conflict).toBe(false);

    const row = await db()
      .prepare("SELECT * FROM model_hashes WHERE name = ? AND size_bytes = ?")
      .bind("text_encoders/clip_l.safetensors", bytesFor(0.23))
      .first<{ sha256: string; first_worker_id: string; conflict: number }>();
    expect(row?.sha256).toBe(sha);
    expect(row?.first_worker_id).toBe("w1");
    expect(row?.conflict).toBe(0);
  });

  it("a matching repeat is a no-op (first_worker_id untouched)", async () => {
    const sha = await shaHex("a");
    await modelManifest.recordHash(db(), "w1", "clip_l.safetensors", bytesFor(0.23), sha);
    const result = await modelManifest.recordHash(db(), "w2", "clip_l.safetensors", bytesFor(0.23), sha);
    expect(result.conflict).toBe(false);

    const row = await db()
      .prepare("SELECT * FROM model_hashes WHERE name = ? AND size_bytes = ?")
      .bind("clip_l.safetensors", bytesFor(0.23))
      .first<{ sha256: string; first_worker_id: string; conflict: number }>();
    expect(row?.first_worker_id).toBe("w1");
    expect(row?.sha256).toBe(sha);
    expect(row?.conflict).toBe(0);
  });

  it("a conflict does not overwrite the first-seen hash but persists conflict=1 on the row", async () => {
    const shaA = await shaHex("a");
    const shaB = await shaHex("b");
    await modelManifest.recordHash(db(), "worker-first", "clip_l.safetensors", bytesFor(0.23), shaA);
    const result = await modelManifest.recordHash(db(), "worker-second", "clip_l.safetensors", bytesFor(0.23), shaB);

    expect(result.conflict).toBe(true);
    const row = await db()
      .prepare("SELECT * FROM model_hashes WHERE name = ? AND size_bytes = ?")
      .bind("clip_l.safetensors", bytesFor(0.23))
      .first<{ sha256: string; conflict: number }>();
    expect(row?.sha256).toBe(shaA); // first-seen hash kept
    expect(row?.conflict).toBe(1);
  });

  it("different exact sizes are independent keys -- no conflict", async () => {
    const shaA = await shaHex("a");
    const shaB = await shaHex("b");
    const r1 = await modelManifest.recordHash(db(), "w1", "clip_l.safetensors", bytesFor(0.23), shaA);
    const r2 = await modelManifest.recordHash(db(), "w2", "clip_l.safetensors", bytesFor(9.12), shaB);
    expect(r1.conflict).toBe(false);
    expect(r2.conflict).toBe(false);
  });
});

// --- entries(): the signed manifest -----------------------------------------

describe("entries", () => {
  it("excludes a model with no learned hash", async () => {
    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "clip_l.safetensors")).toBe(false);
  });

  it("excludes a learned hash with no matching source", async () => {
    await modelManifest.recordHash(db(), "w1", "loras/totally_unknown_model.safetensors", bytesFor(1.0), await shaHex("a"));
    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "totally_unknown_model.safetensors")).toBe(false);
  });

  it("includes a curated model with an agreed hash and a valid signature", async () => {
    const sha = await shaHex("clip");
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", bytesFor(0.23), sha);

    const entries = await modelManifest.entries(db(), store(), await seed());
    const matches = entries.filter((e) => e.name === "clip_l.safetensors");
    expect(matches).toHaveLength(1);
    const entry = matches[0]!;

    expect(entry.directory).toBe("text_encoders");
    expect(entry.url).toBe("https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors");
    expect(entry.backup_url).toBe("https://storage.googleapis.com/comfyfed-models/models/text_encoders/clip_l.safetensors");
    expect(entry.sha256).toBe(sha);
    expect(entry.size_bytes).toBe(bytesFor(0.23));

    const pubkeyHex = await derivePublicKeyHexFromSeed(await seed());
    const payload = `${entry.name}|${entry.directory}|${entry.sha256}|${entry.size_bytes}`;
    const ok = await verifyHex(pubkeyHex, new TextEncoder().encode(payload), entry.sig);
    expect(ok).toBe(true);
  });

  it("the signature does not verify against a tampered field", async () => {
    const sha = await shaHex("clip");
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", bytesFor(0.23), sha);
    const entries = await modelManifest.entries(db(), store(), await seed());
    const entry = entries.find((e) => e.name === "clip_l.safetensors")!;

    const pubkeyHex = await derivePublicKeyHexFromSeed(await seed());
    const tampered = `${entry.name}|${entry.directory}|${entry.sha256}|${entry.size_bytes + 1}`;
    const ok = await verifyHex(pubkeyHex, new TextEncoder().encode(tampered), entry.sig);
    expect(ok).toBe(false);
  });

  it("excludes a conflicted name even with an agreed first-seen row present", async () => {
    // The row itself is the FIRST-seen one (never deleted by a conflict) --
    // conflict=true is about "two workers disagree on this name", which the
    // first-seen row surviving does not resolve.
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", bytesFor(0.23), await shaHex("a"));
    const result = await modelManifest.recordHash(
      db(),
      "w2",
      "text_encoders/clip_l.safetensors",
      bytesFor(0.23),
      await shaHex("b")
    );
    expect(result.conflict).toBe(true);

    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "clip_l.safetensors")).toBe(false);
  });

  it("fix round 1: exclusion is a persisted column, so it holds immediately with no in-memory state at all", async () => {
    // Unlike the old in-memory poisoned-name design, there is no set for a
    // caller to forget to pass -- `entries()` takes no such parameter.
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", bytesFor(0.23), await shaHex("a"));
    await modelManifest.recordHash(db(), "w2", "text_encoders/clip_l.safetensors", bytesFor(0.23), await shaHex("b"));

    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "clip_l.safetensors")).toBe(false);
  });

  it("size_bytes comes from the learned row, not model_guide's curated size_gb", async () => {
    const sha = await shaHex("clip");
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", bytesFor(0.5), sha);
    const entries = await modelManifest.entries(db(), store(), await seed());
    const entry = entries.find((e) => e.name === "clip_l.safetensors")!;
    expect(entry.size_bytes).toBe(bytesFor(0.5));
    expect(entry.size_bytes).not.toBe(bytesFor(0.23));
  });
});

// --- routes: auth ------------------------------------------------------------

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function adminSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

interface RegisteredWorker {
  workerId: string;
  seedHex: string;
}

async function registerWorker(name = "w1"): Promise<RegisteredWorker> {
  const { cookie, csrf } = await adminSession();
  const tokenRes = await call("/api/workers/tokens", { json: { name }, cookie, headers: { "X-CSRF": csrf } });
  const kp = golden.keypairs[0]!;
  const r = await call("/api/agent/register", { json: { token: tokenRes.body.bundle.register_token, pubkey: kp.pubkey_hex } });
  return { workerId: r.body.worker_id, seedHex: kp.seed_hex };
}

async function signedGet(worker: RegisteredWorker, path: string) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = await signRequest(worker.seedHex, "GET", path, "", ts, nonce, new Uint8Array());
  return call(path, {
    method: "GET",
    headers: { "X-Worker-Id": worker.workerId, "X-Ts": ts, "X-Nonce": nonce, "X-Sig": sig },
  });
}

describe("GET /api/agent/manifest", () => {
  it("requires a valid agent signature", async () => {
    const r = await call("/api/agent/manifest");
    expect(r.status).toBe(401);
  });

  it("returns entries for a verified agent", async () => {
    const worker = await registerWorker();
    await modelManifest.recordHash(db(), "other-worker", "text_encoders/clip_l.safetensors", bytesFor(0.23), await shaHex("clip"));

    const r = await signedGet(worker, "/api/agent/manifest");
    expect(r.status).toBe(200);
    expect(r.body.entries.some((e: any) => e.name === "clip_l.safetensors")).toBe(true);
  });
});

describe("GET /api/models/manifest", () => {
  it("requires an admin session", async () => {
    const r = await call("/api/models/manifest");
    expect(r.status).toBe(401);
  });

  it("returns entries for an admin", async () => {
    const { cookie, csrf } = await adminSession();
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", bytesFor(0.23), await shaHex("clip"));

    const r = await call("/api/models/manifest", { cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(200);
    expect(r.body.entries.some((e: any) => e.name === "clip_l.safetensors")).toBe(true);
  });
});
