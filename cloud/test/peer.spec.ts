import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import * as modelManifest from "../src/core/model_manifest";
import * as peer from "../src/core/peer";
import * as modelGuide from "../src/core/model_guide";
import { resolvePlatformSeed } from "../src/db/queries";
import * as queries from "../src/db/queries";
import { derivePublicKeyHexFromSeed, verifyHex } from "../src/lib/ed25519";
import { signRequest } from "../src/lib/signing";
import golden from "./fixtures/golden.json";

// Ports the highest-value cases from tests/server/test_peer.py -- see that
// file for the full Python suite this mirrors (grant issuance seeder
// selection/signing, peer-served atomic booking, error codes). The grant
// book itself lives in D1 here (p2p_grants table) rather than an in-memory
// dict -- see core/peer.ts's module docstring.

afterEach(async () => {
  await db().prepare("DELETE FROM model_hashes").run();
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  await db().prepare("DELETE FROM receipts").run();
  await db().prepare("DELETE FROM p2p_grants").run();
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

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function adminSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

interface RegisteredWorker {
  workerId: string;
  seedHex: string;
}

async function registerWorker(name: string, keypairIndex: number): Promise<RegisteredWorker> {
  const { cookie, csrf } = await adminSession();
  const tokenRes = await call("/api/workers/tokens", { json: { name }, cookie, headers: { "X-CSRF": csrf } });
  const kp = golden.keypairs[keypairIndex]!;
  const r = await call("/api/agent/register", { json: { token: tokenRes.body.bundle.register_token, pubkey: kp.pubkey_hex } });
  return { workerId: r.body.worker_id, seedHex: kp.seed_hex };
}

/** Directly promotes a registered worker to "online, protocol>=4,
 * peer_url-advertising, with this inventory" without driving a real hello
 * over WebSocket -- this file tests the HTTP routes/core module in
 * isolation, not the Hub DO's hello handling (covered by hub.spec.ts's
 * hello tests + dispatch.spec.ts's requeueStale clearing test). */
async function makeSeeder(
  worker: RegisteredWorker,
  inventory: { name: string; size_bytes: number; sha256: string }[],
  opts: {
    protocol?: number;
    peerUrl?: string | null;
    status?: string;
    disabled?: boolean;
    peerLanUrl?: string | null;
    peerReachable?: number | null;
    remoteIp?: string | null;
  } = {}
): Promise<void> {
  // `peerReachable` defaults to 1 (Phase 3.4 §4.2): the seeder predicate now
  // requires a platform-verified endpoint, so "a normal, usable seeder"
  // means one whose reachability check passed. Tests about the check itself
  // pass null/0 explicitly. Parity: test_peer.py's `_make_online_seeder`.
  await db()
    .prepare(
      "UPDATE workers SET status = ?, disabled = ?, protocol = ?, peer_url = ?, peer_lan_url = ?, peer_reachable = ?, remote_ip = ?, model_inventory = ? WHERE id = ?"
    )
    .bind(
      opts.status ?? "online",
      opts.disabled ? 1 : 0,
      opts.protocol ?? 4,
      opts.peerUrl === undefined ? "http://192.168.1.5:8850" : opts.peerUrl,
      opts.peerLanUrl ?? null,
      opts.peerReachable === undefined ? 1 : opts.peerReachable,
      opts.remoteIp ?? null,
      JSON.stringify(inventory),
      worker.workerId
    )
    .run();
}

/** Gives a registered worker the puller shape the grant route reads:
 * online, protocol 4, and a `remote_ip` (Phase 3.4 §5's same-NAT test). */
async function setRemoteIp(worker: RegisteredWorker, remoteIp: string): Promise<void> {
  await db()
    .prepare("UPDATE workers SET status = 'online', protocol = 4, remote_ip = ? WHERE id = ?")
    .bind(remoteIp, worker.workerId)
    .run();
}

async function signedPost(worker: RegisteredWorker, path: string, jsonBody: unknown) {
  const bodyBytes = new TextEncoder().encode(JSON.stringify(jsonBody));
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = await signRequest(worker.seedHex, "POST", path, "", ts, nonce, bodyBytes);
  return call(path, {
    method: "POST",
    rawBody: bodyBytes,
    headers: { "X-Worker-Id": worker.workerId, "X-Ts": ts, "X-Nonce": nonce, "X-Sig": sig },
  });
}

// ---------------------------------------------------------------------------
// POST /api/agent/peer-grant

describe("POST /api/agent/peer-grant", () => {
  it("requires a valid agent signature", async () => {
    const r = await call("/api/agent/peer-grant", { json: { name: "x", size_bytes: 1 } });
    expect(r.status).toBe(401);
  });

  it("issues a grant with a valid signature, peer_url, and chunk_sha256s", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "some-worker", "loras/a.safetensors", sizeBytes, sha, ["c1", "c2"]);
    await makeSeeder(seeder, [{ name: "loras/a.safetensors", size_bytes: sizeBytes, sha256: sha }]);

    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    expect(r.status).toBe(200);
    expect(r.body.grant.name).toBe("loras/a.safetensors");
    expect(r.body.grant.size_bytes).toBe(sizeBytes);
    expect(r.body.grant.sha256).toBe(sha);
    expect(r.body.grant.seeder_id).toBe(seeder.workerId);
    expect(r.body.grant.puller_id).toBe(puller.workerId);
    expect(typeof r.body.grant.grant_id).toBe("string");
    expect(r.body.grant.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(r.body.peer_url).toBe("http://192.168.1.5:8850");
    expect(r.body.chunk_sha256s).toEqual(["c1", "c2"]);

    // Signature byte-parity: pipe-joined GRANT_FIELDS order.
    const pubkeyHex = await derivePublicKeyHexFromSeed(await seed());
    const g = r.body.grant;
    const payload = `${g.grant_id}|${g.name}|${g.size_bytes}|${g.sha256}|${g.seeder_id}|${g.puller_id}|${g.expires_at}`;
    expect(await verifyHex(pubkeyHex, new TextEncoder().encode(payload), g.sig)).toBe(true);
  });

  it("grantTtlSeconds scales the TTL with the file size (parity with peer.py)", () => {
    expect(peer.MIN_ASSUMED_RATE_BYTES_PER_SEC).toBe(20_000_000 / 8);
    // 6.5 GB at the agent's default 20 Mbps active cap is ~43 min of
    // transfer -- a flat 600 s grant expired ~4x before it finished.
    expect(peer.grantTtlSeconds(Math.round(6.5 * 1000 ** 3))).toBeGreaterThanOrEqual(3900);
    // A 10 MB model stays at the 600 s baseline.
    const small = peer.grantTtlSeconds(10 * 1000 ** 2);
    expect(small).toBeGreaterThanOrEqual(peer.GRANT_TTL_SECONDS);
    expect(small).toBeLessThanOrEqual(peer.GRANT_TTL_SECONDS + 10);
    expect(peer.grantTtlSeconds(0)).toBe(peer.GRANT_TTL_SECONDS);
    expect(peer.grantTtlSeconds(-1)).toBe(peer.GRANT_TTL_SECONDS);
    expect(peer.grantTtlSeconds(2 * 1024 ** 3)).toBeGreaterThan(peer.grantTtlSeconds(1024 ** 3));
  });

  it("expires_at is grantTtlSeconds(size) ahead of issuance", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "some-worker", "loras/a.safetensors", sizeBytes, sha);
    await makeSeeder(seeder, [{ name: "loras/a.safetensors", size_bytes: sizeBytes, sha256: sha }]);

    const before = Math.floor(Date.now() / 1000);
    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    const after = Math.floor(Date.now() / 1000);
    expect(r.status).toBe(200);

    // expires_at = floor(issuance time) + the size-scaled TTL -- pin the
    // delta against the request's own before/after bracket rather than a
    // fixed clock read, so this isn't flaky under scheduling jitter.
    const ttl = peer.grantTtlSeconds(sizeBytes);
    expect(ttl).toBeGreaterThan(peer.GRANT_TTL_SECONDS);
    expect(r.body.grant.expires_at).toBeGreaterThanOrEqual(before + ttl);
    expect(r.body.grant.expires_at).toBeLessThanOrEqual(after + ttl);
  });

  it("seederRateBytesPerSec falls back to the default assumption (parity with peer.py)", () => {
    for (const hardware of [
      {},
      { peer_upload_min_mbps: null },
      { peer_upload_min_mbps: "20" },
      { peer_upload_min_mbps: 0 },
      { peer_upload_min_mbps: -5 },
      { peer_upload_min_mbps: Number.NaN },
      { peer_upload_min_mbps: Number.POSITIVE_INFINITY },
    ]) {
      expect(peer.seederRateBytesPerSec({ hardware } as any)).toBe(peer.MIN_ASSUMED_RATE_BYTES_PER_SEC);
    }
    expect(peer.seederRateBytesPerSec({ hardware: { peer_upload_min_mbps: 5 } } as any)).toBe(
      (5 * 1_000_000) / 8
    );
  });

  it("seederRateBytesPerSec ignores an out-of-range reported cap (M2, parity with peer.py)", () => {
    // A worker is authenticated but low-privilege, and this value is the TTL
    // DIVISOR: 1e-300 would otherwise mint an expires_at far past 2^63,
    // which D1 then fails to bind for every later puller of that seeder.
    for (const value of [1e-300, 0.09, 1e300, 100001, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(peer.seederRateBytesPerSec({ hardware: { peer_upload_min_mbps: value } } as any)).toBe(
        peer.MIN_ASSUMED_RATE_BYTES_PER_SEC
      );
    }
    // ...and the boundary itself is still accepted.
    expect(
      peer.seederRateBytesPerSec({
        hardware: { peer_upload_min_mbps: peer.MIN_PEER_UPLOAD_MBPS },
      } as any)
    ).toBe((peer.MIN_PEER_UPLOAD_MBPS * 1_000_000) / 8);
  });

  it("grantTtlSeconds never exceeds the seven-day ceiling (M2, parity with peer.py)", () => {
    expect(peer.MAX_GRANT_TTL_SECONDS).toBe(604800);
    expect(peer.grantTtlSeconds(1e15, (peer.MIN_PEER_UPLOAD_MBPS * 1_000_000) / 8)).toBe(
      peer.MAX_GRANT_TTL_SECONDS
    );
    // A rate that slipped past every other guard can't blow past it either.
    expect(peer.grantTtlSeconds(1e9, 1e-300)).toBe(peer.MAX_GRANT_TTL_SECONDS);
  });

  it("grantTtlSeconds for a slow seeder is proportionally longer (parity with peer.py)", () => {
    // A 5 Mbps seeder moves a 6.5 GB model 4x slower than the 20 Mbps
    // default the flat assumption was built for.
    const size = Math.round(6.5 * 1000 ** 3);
    const defaultTtl = peer.grantTtlSeconds(size);
    const slowTtl = peer.grantTtlSeconds(size, (5 * 1_000_000) / 8);
    const scaledDefault = defaultTtl - peer.GRANT_TTL_SECONDS;
    const scaledSlow = slowTtl - peer.GRANT_TTL_SECONDS;
    expect(scaledSlow / scaledDefault).toBeGreaterThanOrEqual(3.9);
    expect(scaledSlow / scaledDefault).toBeLessThanOrEqual(4.1);

    // An absent/invalid rate is exactly the pre-existing default.
    expect(peer.grantTtlSeconds(size, undefined)).toBe(defaultTtl);
    expect(peer.grantTtlSeconds(size, 0)).toBe(defaultTtl);
    expect(peer.grantTtlSeconds(size, -1)).toBe(defaultTtl);
  });

  it("expires_at uses the seeder's own reported upload cap", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "some-worker", "loras/a.safetensors", sizeBytes, sha);
    await makeSeeder(seeder, [{ name: "loras/a.safetensors", size_bytes: sizeBytes, sha256: sha }]);
    await db()
      .prepare("UPDATE workers SET hardware = ? WHERE id = ?")
      .bind(JSON.stringify({ vram_gb: 24, peer_upload_min_mbps: 5 }), seeder.workerId)
      .run();

    const before = Math.floor(Date.now() / 1000);
    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    const after = Math.floor(Date.now() / 1000);
    expect(r.status).toBe(200);

    const ttl = peer.grantTtlSeconds(sizeBytes, (5 * 1_000_000) / 8);
    expect(ttl).toBeGreaterThan(peer.grantTtlSeconds(sizeBytes));
    expect(r.body.grant.expires_at).toBeGreaterThanOrEqual(before + ttl);
    expect(r.body.grant.expires_at).toBeLessThanOrEqual(after + ttl);
  });

  it("chunk_sha256s is null in the response when no chunk list was ever established", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    // No chunk list passed to recordHash -- model_hashes.chunk_sha256s stays NULL.
    await modelManifest.recordHash(db(), "some-worker", "loras/a.safetensors", sizeBytes, sha);
    await makeSeeder(seeder, [{ name: "loras/a.safetensors", size_bytes: sizeBytes, sha256: sha }]);

    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    expect(r.status).toBe(200);
    expect(r.body.chunk_sha256s).toBeNull();
  });

  it("404s peer.no_model when there's no consensus hash for the requested (name, size)", async () => {
    const puller = await registerWorker("puller", 0);
    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "unknown.safetensors", size_bytes: 123 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("peer.no_model");
  });

  it("400s peer.already_has_model when the requester's own inventory already has it", async () => {
    const puller = await registerWorker("puller", 0);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "some-worker", "loras/a.safetensors", sizeBytes, sha);
    // Give the requester itself a matching inventory entry.
    await db()
      .prepare("UPDATE workers SET model_inventory = ? WHERE id = ?")
      .bind(JSON.stringify([{ name: "loras/a.safetensors", size_bytes: sizeBytes, sha256: sha }]), puller.workerId)
      .run();

    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("peer.already_has_model");
  });

  it("404s peer.no_seeder when no online worker can serve it", async () => {
    const puller = await registerWorker("puller", 0);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "some-worker", "loras/a.safetensors", sizeBytes, sha);
    // No seeder promoted -- nobody advertises peer_url for this file.
    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("peer.no_seeder");
  });

  it("excludes the requester itself as a candidate seeder", async () => {
    const puller = await registerWorker("puller", 0);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "some-worker", "loras/a.safetensors", sizeBytes, sha);
    // Promote the REQUESTER itself to a would-be seeder shape (peer_url,
    // protocol 4) but WITHOUT giving it the file, so already_has_model
    // doesn't fire first -- online_seeders must still exclude it by id.
    await db()
      .prepare("UPDATE workers SET status = 'online', protocol = 4, peer_url = 'http://self:1' WHERE id = ?")
      .bind(puller.workerId)
      .run();

    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("peer.no_seeder");
  });

  it("issues a grant to a disabled-but-online seeder (seeding is decoupled from disabled)", async () => {
    const seeder = await registerWorker("seeder", 0);
    const puller = await registerWorker("puller", 0);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), seeder.workerId, "loras/a.safetensors", sizeBytes, sha);
    await makeSeeder(seeder, [{ name: "loras/a.safetensors", size_bytes: sizeBytes, sha256: sha }], {
      disabled: true,
    });

    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    expect(r.status).toBe(200);
    expect(r.body.grant.seeder_id).toBe(seeder.workerId);
  });

  it("400s peer.invalid_field when name contains the '|' payload delimiter", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sha = await shaHex("evil");
    const sizeBytes = bytesFor(1.0);
    const evilName = "evil|name.safetensors";
    // Seed the hash row directly (bypassing model_manifest's own `|` guard,
    // which only applies inside entries()/peerOnlyEntry -- record_hash/
    // recordHash itself never rejects a pipe in the name).
    await db()
      .prepare(
        "INSERT INTO model_hashes (name, size_bytes, sha256, first_worker_id, created_at) VALUES (?, ?, ?, 'w0', '2026-01-01 00:00:00.000000')"
      )
      .bind(evilName, sizeBytes, sha)
      .run();
    await makeSeeder(seeder, [{ name: evilName, size_bytes: sizeBytes, sha256: sha }]);

    const r = await signedPost(puller, "/api/agent/peer-grant", { name: evilName, size_bytes: sizeBytes });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("peer.invalid_field");
  });

  it("picks the seeder with fewest active grants, tie-broken by name", async () => {
    const puller = await registerWorker("puller", 0);
    const seederA = await registerWorker("aaa-seeder", 1);
    const seederB = await registerWorker("bbb-seeder", 2);
    const sha = await shaHex("model-a");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "some-worker", "loras/a.safetensors", sizeBytes, sha);
    await makeSeeder(seederA, [{ name: "loras/a.safetensors", size_bytes: sizeBytes, sha256: sha }], {
      peerUrl: "http://a:1",
    });
    await makeSeeder(seederB, [{ name: "loras/a.safetensors", size_bytes: sizeBytes, sha256: sha }], {
      peerUrl: "http://b:1",
    });

    // Both start with zero active grants -- name tie-break picks "aaa-seeder".
    const r = await signedPost(puller, "/api/agent/peer-grant", { name: "loras/a.safetensors", size_bytes: sizeBytes });
    expect(r.status).toBe(200);
    expect(r.body.grant.seeder_id).toBe(seederA.workerId);
  });
});

// ---------------------------------------------------------------------------
// POST /api/agent/peer-served

async function issueGrant(
  puller: RegisteredWorker,
  seeder: RegisteredWorker,
  name: string,
  sizeBytes: number,
  sha: string
): Promise<{ grantId: string; sig: string }> {
  await modelManifest.recordHash(db(), "some-worker", name, sizeBytes, sha);
  await makeSeeder(seeder, [{ name, size_bytes: sizeBytes, sha256: sha }]);
  const r = await signedPost(puller, "/api/agent/peer-grant", { name, size_bytes: sizeBytes });
  expect(r.status).toBe(200);
  return { grantId: r.body.grant.grant_id, sig: r.body.grant.sig };
}

describe("POST /api/agent/peer-served", () => {
  it("requires a valid agent signature", async () => {
    const r = await call("/api/agent/peer-served", { json: { grant_id: "x", bytes_served: 1 } });
    expect(r.status).toBe(401);
  });

  it("books the grant and inserts a p2p_upload receipt (billable=false, gpu_seconds=0, job_id NULL)", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sizeBytes = bytesFor(1.0);
    const { grantId } = await issueGrant(puller, seeder, "loras/a.safetensors", sizeBytes, await shaHex("model-a"));

    const r = await signedPost(seeder, "/api/agent/peer-served", { grant_id: grantId, bytes_served: sizeBytes });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(typeof r.body.receipt_id).toBe("string");

    const receipt = await db()
      .prepare("SELECT * FROM receipts WHERE id = ?")
      .bind(r.body.receipt_id)
      .first<{ job_id: string | null; worker_id: string; gpu_seconds: number; kind: string; billable: number; basis: string; bytes: number }>();
    expect(receipt?.job_id).toBeNull();
    expect(receipt?.worker_id).toBe(seeder.workerId);
    expect(receipt?.gpu_seconds).toBe(0);
    expect(receipt?.kind).toBe("p2p_upload");
    expect(receipt?.billable).toBe(0);
    expect(receipt?.basis).toBe("wall");
    expect(receipt?.bytes).toBe(sizeBytes);

    const grantRow = await db().prepare("SELECT booked FROM p2p_grants WHERE grant_id = ?").bind(grantId).first<{ booked: number }>();
    expect(grantRow?.booked).toBe(1);
  });

  it("404s peer.no_grant for an unknown grant_id", async () => {
    const seeder = await registerWorker("seeder", 1);
    const r = await signedPost(seeder, "/api/agent/peer-served", { grant_id: "nonexistent", bytes_served: 100 });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("peer.no_grant");
  });

  it("M4: books a grant reported after its TTL expired but within the retention window", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sizeBytes = bytesFor(1.0);
    const { grantId } = await issueGrant(puller, seeder, "loras/a.safetensors", sizeBytes, await shaHex("model-a"));

    await db()
      .prepare("UPDATE p2p_grants SET expires_at = ? WHERE grant_id = ?")
      .bind(Math.floor(Date.now() / 1000) - 1, grantId)
      .run();

    const r = await signedPost(seeder, "/api/agent/peer-served", { grant_id: grantId, bytes_served: sizeBytes });
    expect(r.status).toBe(200);
  });

  it("M4: 404s peer.no_grant once the retention window has fully passed", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sizeBytes = bytesFor(1.0);
    const { grantId } = await issueGrant(puller, seeder, "loras/a.safetensors", sizeBytes, await shaHex("model-a"));

    await db()
      .prepare("UPDATE p2p_grants SET expires_at = ? WHERE grant_id = ?")
      .bind(Math.floor(Date.now() / 1000) - queries.GRANT_RETENTION_SECONDS - 1, grantId)
      .run();

    const r = await signedPost(seeder, "/api/agent/peer-served", { grant_id: grantId, bytes_served: sizeBytes });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("peer.no_grant");
  });

  it("403s peer.not_seeder when a non-seeder (e.g. the puller) reports served bytes", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sizeBytes = bytesFor(1.0);
    const { grantId } = await issueGrant(puller, seeder, "loras/a.safetensors", sizeBytes, await shaHex("model-a"));

    const r = await signedPost(puller, "/api/agent/peer-served", { grant_id: grantId, bytes_served: sizeBytes });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("peer.not_seeder");
  });

  it("400s peer.bad_bytes for zero, negative, and over-the-1.05x-slack bytes_served", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sizeBytes = bytesFor(1.0);

    for (const bad of [0, -1, Math.ceil(sizeBytes * 1.06)]) {
      const { grantId } = await issueGrant(puller, seeder, "loras/a.safetensors", sizeBytes, await shaHex("model-a"));
      const r = await signedPost(seeder, "/api/agent/peer-served", { grant_id: grantId, bytes_served: bad });
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("peer.bad_bytes");
    }
  });

  it("409s peer.already_booked on a second call for the same grant (dedupe)", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sizeBytes = bytesFor(1.0);
    const { grantId } = await issueGrant(puller, seeder, "loras/a.safetensors", sizeBytes, await shaHex("model-a"));

    const first = await signedPost(seeder, "/api/agent/peer-served", { grant_id: grantId, bytes_served: sizeBytes });
    expect(first.status).toBe(200);
    const second = await signedPost(seeder, "/api/agent/peer-served", { grant_id: grantId, bytes_served: sizeBytes });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("peer.already_booked");

    // Exactly one receipt was minted.
    const count = await db().prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'p2p_upload'").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it("concurrent calls for the same grant: exactly one claim wins (atomic booking)", async () => {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sizeBytes = bytesFor(1.0);
    const { grantId } = await issueGrant(puller, seeder, "loras/a.safetensors", sizeBytes, await shaHex("model-a"));

    const [a, b] = await Promise.all([
      signedPost(seeder, "/api/agent/peer-served", { grant_id: grantId, bytes_served: sizeBytes, nonce_key: "a" } as any),
      signedPost(seeder, "/api/agent/peer-served", { grant_id: grantId, bytes_served: sizeBytes, nonce_key: "b" } as any),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const count = await db().prepare("SELECT COUNT(*) AS n FROM receipts WHERE kind = 'p2p_upload'").first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.4 §4.2/§5: seeder eligibility and seeder_urls
// Ports tests/server/test_peer.py's matching block.

describe("Phase 3.4: seeder eligibility and seeder_urls", () => {
  const NAME = "loras/nat.safetensors";

  async function seedOneModel(opts: {
    peerUrl?: string | null;
    peerLanUrl?: string | null;
    peerReachable?: number | null;
    remoteIp?: string | null;
  }): Promise<{ sizeBytes: number; seederId: string; puller: RegisteredWorker }> {
    const puller = await registerWorker("puller", 0);
    const seeder = await registerWorker("seeder", 1);
    const sha = await shaHex("model-nat");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "some-worker", NAME, sizeBytes, sha, null);
    await makeSeeder(seeder, [{ name: NAME, size_bytes: sizeBytes, sha256: sha }], opts);
    return { sizeBytes, seederId: seeder.workerId, puller };
  }

  it("requires peer_reachable = 1", async () => {
    const { sizeBytes, seederId } = await seedOneModel({
      peerUrl: "http://203.0.113.7:8850",
      peerReachable: null,
    });

    expect(await peer.onlineSeeders(db(), NAME, sizeBytes, {})).toEqual([]);

    await db().prepare("UPDATE workers SET peer_reachable = 1 WHERE id = ?").bind(seederId).run();
    const seeders = await peer.onlineSeeders(db(), NAME, sizeBytes, {});
    expect(seeders.map((w) => w.id)).toEqual([seederId]);
  });

  it("accepts an unreachable seeder that shares the puller's remote_ip and has a LAN url", async () => {
    const { sizeBytes, seederId } = await seedOneModel({
      peerUrl: "http://192.168.1.5:8850",
      peerLanUrl: "http://192.168.1.5:8850",
      peerReachable: 0,
      remoteIp: "203.0.113.7",
    });

    expect(await peer.onlineSeeders(db(), NAME, sizeBytes, {})).toEqual([]);
    const seeders = await peer.onlineSeeders(db(), NAME, sizeBytes, { pullerRemoteIp: "203.0.113.7" });
    expect(seeders.map((w) => w.id)).toEqual([seederId]);

    // Same public IP but nothing to connect to on the LAN -> still ineligible.
    await db().prepare("UPDATE workers SET peer_lan_url = NULL WHERE id = ?").bind(seederId).run();
    expect(await peer.onlineSeeders(db(), NAME, sizeBytes, { pullerRemoteIp: "203.0.113.7" })).toEqual([]);
  });

  it("grant returns [lan, public] for a same-NAT puller and [public] otherwise", async () => {
    const { sizeBytes, puller } = await seedOneModel({
      peerUrl: "http://203.0.113.7:8850",
      peerLanUrl: "http://192.168.1.5:8850",
      peerReachable: 1,
      remoteIp: "203.0.113.7",
    });
    await setRemoteIp(puller, "203.0.113.7");

    const same = await signedPost(puller, "/api/agent/peer-grant", { name: NAME, size_bytes: sizeBytes });
    expect(same.status).toBe(200);
    expect(same.body.seeder_urls).toEqual(["http://192.168.1.5:8850", "http://203.0.113.7:8850"]);
    // Old agents only read `peer_url` -- it is the first element, unchanged.
    expect(same.body.peer_url).toBe(same.body.seeder_urls[0]);

    await setRemoteIp(puller, "198.51.100.9");
    const other = await signedPost(puller, "/api/agent/peer-grant", { name: NAME, size_bytes: sizeBytes });
    expect(other.status).toBe(200);
    expect(other.body.seeder_urls).toEqual(["http://203.0.113.7:8850"]);
  });
});
