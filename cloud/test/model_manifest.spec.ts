import { afterEach, describe, expect, it, vi } from "vitest";
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
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  modelGuide.clearHarvestCacheForTests();
  // Phase 3.2 F6 fix: MISMATCH_LOGGED is a module-level dedup Set, so a test
  // asserting a mismatch warning was logged (e.g. "a learned consensus wins
  // over the guide hash and the mismatch is logged" below) would otherwise
  // only pass the FIRST time this module hits a given (name, guide,
  // consensus) triple -- a real fragility under test re-ordering/repeats.
  modelManifest.clearMismatchLogForTests();
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

// Phase 3.1 P2P: inserts an online, protocol>=4, peer_url-advertising
// worker whose inventory reports (name, sizeBytes, sha256) -- the exact
// "online seeder" predicate `core/peer.ts`'s `onlineSeeders` checks.
async function seedOnlineSeeder(
  id: string,
  name: string,
  sizeBytes: number,
  sha256: string,
  opts: { protocol?: number; peerUrl?: string | null; disabled?: boolean; status?: string } = {}
): Promise<void> {
  await db()
    .prepare(
      `INSERT INTO workers (id, name, pubkey, created_at, status, disabled, protocol, peer_url, model_inventory)
       VALUES (?, ?, 'pk', '2026-01-01 00:00:00.000000', ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      id,
      opts.status ?? "online",
      opts.disabled ? 1 : 0,
      opts.protocol ?? 4,
      opts.peerUrl === undefined ? "http://192.168.1.5:8850" : opts.peerUrl,
      JSON.stringify([{ name, size_bytes: sizeBytes, sha256 }])
    )
    .run();
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

  it("Phase 3.2 F4: a conflict warning notes when the NEW report matches the curated guide value", async () => {
    const source = modelGuide.SOURCES["clip_l.safetensors"]!;
    const otherSha = await shaHex("some-other-build");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await modelManifest.recordHash(db(), "worker-first", "text_encoders/clip_l.safetensors", source.sizeBytes!, otherSha);
      await modelManifest.recordHash(
        db(),
        "worker-second",
        "text_encoders/clip_l.safetensors",
        source.sizeBytes!,
        source.sha256!
      );
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("sha256 conflict") &&
            call[0].includes("clip_l.safetensors") &&
            call[0].includes("worker-second's reported hash matches the curated guide value") &&
            call[0].includes("OTHER report looks stale")
        )
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("Phase 3.2 F4: a conflict warning notes when the EXISTING (first-seen) hash matches the curated guide value", async () => {
    const source = modelGuide.SOURCES["clip_l.safetensors"]!;
    const otherSha = await shaHex("some-other-build");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await modelManifest.recordHash(
        db(),
        "worker-first",
        "text_encoders/clip_l.safetensors",
        source.sizeBytes!,
        source.sha256!
      );
      await modelManifest.recordHash(db(), "worker-second", "text_encoders/clip_l.safetensors", source.sizeBytes!, otherSha);
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("sha256 conflict") &&
            call[0].includes("clip_l.safetensors") &&
            call[0].includes("existing hash matches the curated guide value") &&
            call[0].includes("worker-second's NEW report looks stale")
        )
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
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
  it("excludes a model with no learned hash and no guide hash (harvest()-sourced entries never carry one)", async () => {
    await store().put(
      "official_templates/hashless.json",
      JSON.stringify({
        nodes: [
          {
            id: 1,
            properties: {
              models: [{ name: "hashless_model.safetensors", url: "https://example.invalid/hashless_model.safetensors", directory: "checkpoints" }],
            },
          },
        ],
      })
    );

    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "hashless_model.safetensors")).toBe(false);
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

// --- entries(): Phase 3.2 zero-holder curated entries (guide-hash fallback) -

describe("entries: Phase 3.2 zero-holder curated entries", () => {
  it("synthesizes a zero-holder entry from the guide hash alone", async () => {
    const entries = await modelManifest.entries(db(), store(), await seed());
    const matches = entries.filter((e) => e.name === "clip_l.safetensors");
    expect(matches).toHaveLength(1);
    const entry = matches[0]!;

    const source = modelGuide.SOURCES["clip_l.safetensors"]!;
    expect(entry.directory).toBe("text_encoders");
    expect(entry.url).toBe(source.officialUrl);
    expect(entry.backup_url).toBe(source.backupUrl);
    expect(entry.sha256).toBe(source.sha256);
    expect(entry.size_bytes).toBe(source.sizeBytes);
    expect("peer" in entry).toBe(false);

    const pubkeyHex = await derivePublicKeyHexFromSeed(await seed());
    const payload = `${entry.name}|${entry.directory}|${entry.sha256}|${entry.size_bytes}`;
    expect(await verifyHex(pubkeyHex, new TextEncoder().encode(payload), entry.sig)).toBe(true);
  });

  it("all eleven curated models are zero-holder fetchable with no worker ever having reported anything", async () => {
    const entries = await modelManifest.entries(db(), store(), await seed());
    const names = new Set(entries.map((e) => e.name));
    for (const curatedName of Object.keys(modelGuide.SOURCES)) {
      expect(names.has(curatedName)).toBe(true);
    }
  });

  it("a learned consensus wins over the guide hash and the mismatch is logged", async () => {
    const source = modelGuide.SOURCES["clip_l.safetensors"]!;
    const consensusSha = await shaHex("actually-reported-bytes");
    expect(consensusSha).not.toBe(source.sha256);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", source.sizeBytes!, consensusSha);
      const entries = await modelManifest.entries(db(), store(), await seed());
      const entry = entries.find((e) => e.name === "clip_l.safetensors")!;

      expect(entry.sha256).toBe(consensusSha);
      expect(entry.sha256).not.toBe(source.sha256);
      expect(
        warnSpy.mock.calls.some(
          (call) =>
            typeof call[0] === "string" &&
            call[0].includes("clip_l.safetensors") &&
            call[0].includes(source.sha256!) &&
            call[0].includes(consensusSha)
        )
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a consensus matching the guide hash logs no mismatch", async () => {
    const source = modelGuide.SOURCES["clip_l.safetensors"]!;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", source.sizeBytes!, source.sha256!);
      const entries = await modelManifest.entries(db(), store(), await seed());
      const entry = entries.find((e) => e.name === "clip_l.safetensors")!;

      expect(entry.sha256).toBe(source.sha256);
      expect(
        warnSpy.mock.calls.some((call) => typeof call[0] === "string" && call[0].includes("differs from the learned consensus"))
      ).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a conflicted row still excludes the name despite the guide hash", async () => {
    const source = modelGuide.SOURCES["clip_l.safetensors"]!;
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", source.sizeBytes!, await shaHex("a"));
    await modelManifest.recordHash(db(), "w2", "text_encoders/clip_l.safetensors", source.sizeBytes!, await shaHex("b"));

    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "clip_l.safetensors")).toBe(false);
  });

  it("a zero-holder guide-hash entry and an unrelated peer-only entry coexist with no double-entry", async () => {
    // The guide-hash path (no model_hashes row at all for clip_l.safetensors)
    // never touches `usedRows`, and the peer-only sweep only considers rows
    // from `hashRows` -- confirms the two code paths don't collide or
    // duplicate an entry for either name.
    const sha = await shaHex("private");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "w1", "loras/my_style.safetensors", sizeBytes, sha);
    await seedOnlineSeeder("seeder1", "loras/my_style.safetensors", sizeBytes, sha);

    const entries = await modelManifest.entries(db(), store(), await seed());

    const clipMatches = entries.filter((e) => e.name === "clip_l.safetensors");
    expect(clipMatches).toHaveLength(1);
    expect(clipMatches[0]!.url).not.toBeNull();
    expect("peer" in clipMatches[0]!).toBe(false);

    const peerMatches = entries.filter((e) => e.name === "my_style.safetensors");
    expect(peerMatches).toHaveLength(1);
    expect(peerMatches[0]!.url).toBeNull();
    expect(peerMatches[0]!.peer).toBe(true);
  });
});

// --- recordHash: chunk_sha256s (Phase 3.1 P2P) ------------------------------

describe("recordHash: chunk_sha256s", () => {
  it("a first report's chunk list is stored alongside the whole-file hash", async () => {
    const sha = await shaHex("a");
    await modelManifest.recordHash(db(), "w1", "ckpt.safetensors", bytesFor(0.5), sha, ["c1", "c2"]);
    const row = await db()
      .prepare("SELECT chunk_sha256s FROM model_hashes WHERE name = ? AND size_bytes = ?")
      .bind("ckpt.safetensors", bytesFor(0.5))
      .first<{ chunk_sha256s: string | null }>();
    expect(JSON.parse(row!.chunk_sha256s!)).toEqual(["c1", "c2"]);
  });

  it("a matching-hash reporter's chunk list fills in a still-empty column", async () => {
    const sha = await shaHex("a");
    await modelManifest.recordHash(db(), "w1", "ckpt.safetensors", bytesFor(0.5), sha); // no chunks yet
    await modelManifest.recordHash(db(), "w2", "ckpt.safetensors", bytesFor(0.5), sha, ["c1", "c2"]);
    const row = await db()
      .prepare("SELECT chunk_sha256s FROM model_hashes WHERE name = ? AND size_bytes = ?")
      .bind("ckpt.safetensors", bytesFor(0.5))
      .first<{ chunk_sha256s: string | null }>();
    expect(JSON.parse(row!.chunk_sha256s!)).toEqual(["c1", "c2"]);
  });

  it("a chunk list is never overwritten once set, even by a later different one", async () => {
    const sha = await shaHex("a");
    await modelManifest.recordHash(db(), "w1", "ckpt.safetensors", bytesFor(0.5), sha, ["c1", "c2"]);
    await modelManifest.recordHash(db(), "w2", "ckpt.safetensors", bytesFor(0.5), sha, ["different"]);
    const row = await db()
      .prepare("SELECT chunk_sha256s FROM model_hashes WHERE name = ? AND size_bytes = ?")
      .bind("ckpt.safetensors", bytesFor(0.5))
      .first<{ chunk_sha256s: string | null }>();
    expect(JSON.parse(row!.chunk_sha256s!)).toEqual(["c1", "c2"]);
  });

  it("a conflicting whole-file hash never contributes its chunk list", async () => {
    await modelManifest.recordHash(db(), "w1", "ckpt.safetensors", bytesFor(0.5), await shaHex("a"));
    const result = await modelManifest.recordHash(
      db(),
      "w2",
      "ckpt.safetensors",
      bytesFor(0.5),
      await shaHex("b"),
      ["conflicting-chunks"]
    );
    expect(result.conflict).toBe(true);
    const row = await db()
      .prepare("SELECT chunk_sha256s FROM model_hashes WHERE name = ? AND size_bytes = ?")
      .bind("ckpt.safetensors", bytesFor(0.5))
      .first<{ chunk_sha256s: string | null }>();
    expect(row?.chunk_sha256s).toBeNull();
  });
});

// --- entries(): peer-only entries + peer flag (Phase 3.1 P2P) --------------

describe("entries: peer-only entries", () => {
  it("a hash row with no known source and an online seeder becomes a peer-only entry", async () => {
    const sha = await shaHex("private");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "w1", "loras/my_style.safetensors", sizeBytes, sha);
    await seedOnlineSeeder("seeder1", "loras/my_style.safetensors", sizeBytes, sha);

    const entries = await modelManifest.entries(db(), store(), await seed());
    const entry = entries.find((e) => e.name === "my_style.safetensors");
    expect(entry).toBeDefined();
    expect(entry!.directory).toBe("loras");
    expect(entry!.url).toBeNull();
    expect(entry!.backup_url).toBeNull();
    expect(entry!.peer).toBe(true);
    expect(entry!.sha256).toBe(sha);
    expect(entry!.size_bytes).toBe(sizeBytes);

    const pubkeyHex = await derivePublicKeyHexFromSeed(await seed());
    const payload = `${entry!.name}|${entry!.directory}|${entry!.sha256}|${entry!.size_bytes}`;
    expect(await verifyHex(pubkeyHex, new TextEncoder().encode(payload), entry!.sig)).toBe(true);
  });

  it("no online seeder -> no peer-only entry at all", async () => {
    const sha = await shaHex("private");
    await modelManifest.recordHash(db(), "w1", "loras/my_style.safetensors", bytesFor(1.0), sha);
    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "my_style.safetensors")).toBe(false);
  });

  it("an offline seeder does not count", async () => {
    const sha = await shaHex("private");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "w1", "loras/x.safetensors", sizeBytes, sha);
    await seedOnlineSeeder("seeder1", "loras/x.safetensors", sizeBytes, sha, { status: "offline" });
    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "x.safetensors")).toBe(false);
  });

  it("a protocol-3 seeder does not count (peer requires protocol>=4)", async () => {
    const sha = await shaHex("private");
    const sizeBytes = bytesFor(1.0);
    await modelManifest.recordHash(db(), "w1", "loras/x.safetensors", sizeBytes, sha);
    await seedOnlineSeeder("seeder1", "loras/x.safetensors", sizeBytes, sha, { protocol: 3 });
    const entries = await modelManifest.entries(db(), store(), await seed());
    expect(entries.some((e) => e.name === "x.safetensors")).toBe(false);
  });

  it("a curated URL-sourced model with an online seeder gets peer:true alongside its url", async () => {
    const sha = await shaHex("clip");
    const sizeBytes = bytesFor(0.23);
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", sizeBytes, sha);
    await seedOnlineSeeder("seeder1", "text_encoders/clip_l.safetensors", sizeBytes, sha);

    const entries = await modelManifest.entries(db(), store(), await seed());
    const entry = entries.find((e) => e.name === "clip_l.safetensors")!;
    expect(entry.url).not.toBeNull();
    expect(entry.peer).toBe(true);
  });

  it("no `peer` key at all when there's no online seeder (never `peer: false`)", async () => {
    const sha = await shaHex("clip");
    await modelManifest.recordHash(db(), "w1", "text_encoders/clip_l.safetensors", bytesFor(0.23), sha);
    const entries = await modelManifest.entries(db(), store(), await seed());
    const entry = entries.find((e) => e.name === "clip_l.safetensors")!;
    expect("peer" in entry).toBe(false);
  });
});

describe("peerOnlyNames", () => {
  it("includes only entries whose url is null", () => {
    const names = modelManifest.peerOnlyNames([
      { name: "a", directory: "", url: "https://x", backup_url: null, sha256: "s", size_bytes: 1, sig: "sig" },
      { name: "b", directory: "", url: null, backup_url: null, sha256: "s", size_bytes: 1, sig: "sig", peer: true },
    ]);
    expect([...names]).toEqual(["b"]);
  });
});

// --- routes: auth ------------------------------------------------------------

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
