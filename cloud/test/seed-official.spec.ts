import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import {
  parseSubPackages,
  wheelUrlAndSha256,
  sha256Hex,
  parseCentralDirectory,
  readZipEntryData,
  memberBasename,
  parseRecord,
  recordDigestOf,
  extractTemplateFiles,
  signS3Put,
  sigv4UriEncode,
  mapWithConcurrency,
} from "../scripts/seed-official-lib.mjs";

// Unit-tests the parts of `scripts/seed-official.mjs` that don't touch the
// network or a real filesystem -- per task-10-brief's "seed script's
// unzip/verify logic unit-testable parts (hash check) -- network parts
// excluded". `seed-official-lib.mjs` only imports `node:crypto`/`node:zlib`
// (both real Workers-runtime built-ins under this project's `nodejs_compat`
// flag), so importing it here is safe even though this whole suite runs
// inside `@cloudflare/vitest-pool-workers`' workerd sandbox, unlike
// `seed-official.mjs` itself (which imports `node:fs`/`node:child_process`
// and is only ever run directly via plain `node`, never imported by a test).

// --- Minimal hand-rolled ZIP writer, for building test fixture wheels ------

interface ZipInput {
  name: string;
  data: Buffer;
  /** "stored" (method 0) or "deflate" (method 8). */
  method?: "stored" | "deflate";
}

function buildZip(entries: ZipInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const method = entry.method === "deflate" ? 8 : 0;
    const compressed = method === 8 ? zlib.deflateRawSync(entry.data) : entry.data;
    const nameBuf = Buffer.from(entry.name, "utf8");

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    const localHeaderOffset = offset;
    localParts.push(localHeader, nameBuf, compressed);
    offset += localHeader.length + nameBuf.length + compressed.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(localHeaderOffset, 42);
    centralParts.push(centralHeader, nameBuf);
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

// ---------------------------------------------------------------------------

describe("parseSubPackages", () => {
  it("parses name==version pins, dropping any -core package", () => {
    const packages = parseSubPackages([
      "comfyui-workflow-templates-core==0.1.74",
      "comfyui-workflow-templates-json==0.1.74",
      "comfyui-workflow-templates-media-a==0.1.74",
      "comfyui-workflow-templates-media-b==0.1.74",
      "pytest ; extra == 'dev'", // not a pin, ignored
    ]);
    expect(packages).toEqual({
      "comfyui-workflow-templates-json": "0.1.74",
      "comfyui-workflow-templates-media-a": "0.1.74",
      "comfyui-workflow-templates-media-b": "0.1.74",
    });
  });

  it("returns an empty object for no requires_dist", () => {
    expect(parseSubPackages(undefined as any)).toEqual({});
    expect(parseSubPackages([])).toEqual({});
  });
});

describe("wheelUrlAndSha256", () => {
  it("finds the bdist_wheel entry's url + sha256 digest", () => {
    const packageJson = {
      urls: [
        { packagetype: "sdist", url: "https://x/sdist.tar.gz", digests: { sha256: "ignored" } },
        { packagetype: "bdist_wheel", url: "https://x/pkg.whl", digests: { sha256: "abc123" } },
      ],
    };
    expect(wheelUrlAndSha256(packageJson)).toEqual({ url: "https://x/pkg.whl", sha256: "abc123" });
  });

  it("throws when no wheel with a digest exists", () => {
    expect(() => wheelUrlAndSha256({ urls: [] })).toThrow();
    expect(() => wheelUrlAndSha256({ urls: [{ packagetype: "bdist_wheel", url: "https://x" }] })).toThrow();
  });
});

describe("sha256Hex", () => {
  it("matches a known digest", () => {
    // echo -n "hello" | sha256sum
    expect(sha256Hex(Buffer.from("hello"))).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});

describe("memberBasename (zip-slip guard, ports official_templates.py's _member_basename)", () => {
  it("keeps only the final path component of a wanted /templates/ member", () => {
    expect(memberBasename("comfyui_workflow_templates_json/templates/index.json")).toBe("index.json");
    expect(memberBasename("pkg/templates/sub/flux_dev-1.webp")).toBe("flux_dev-1.webp");
  });

  it("rejects members outside any templates/ segment", () => {
    expect(memberBasename("comfyui_workflow_templates_json/__init__.py")).toBeNull();
    expect(memberBasename("comfyui_workflow_templates_json-0.1.74.dist-info/RECORD")).toBeNull();
  });

  it("rejects directory entries", () => {
    expect(memberBasename("pkg/templates/")).toBeNull();
  });

  it("rejects zip-slip traversal even though it contains /templates/", () => {
    expect(memberBasename("pkg/templates/../../evil.txt")).toBeNull();
    expect(memberBasename("pkg/templates/./evil.txt")).toBeNull();
  });

  it("rejects a basename that still carries separators or traversal", () => {
    expect(memberBasename("pkg/templates/..")).toBeNull();
  });
});

describe("parseRecord + recordDigestOf (PEP 376 RECORD verification)", () => {
  it("parses path,sha256=...,size lines into a Map", () => {
    const record = parseRecord(
      [
        "comfyui_workflow_templates_json/templates/index.json,sha256=abc123,42",
        "comfyui_workflow_templates_json-0.1.74.dist-info/RECORD,,",
        "",
      ].join("\n")
    );
    expect(record.get("comfyui_workflow_templates_json/templates/index.json")).toBe("sha256=abc123");
    expect(record.has("comfyui_workflow_templates_json-0.1.74.dist-info/RECORD")).toBe(false);
  });

  it("computes a url-safe-base64-no-padding sha256 digest matching PEP 376's format", () => {
    const data = Buffer.from("hello world");
    const digest = recordDigestOf(data);
    expect(digest.startsWith("sha256=")).toBe(true);
    const encoded = digest.slice("sha256=".length);
    expect(encoded).not.toMatch(/[+\/=]/); // url-safe alphabet, no padding
    // Recompute independently via sha256Hex + manual base64url to cross-check.
    const hex = sha256Hex(data);
    const expectedB64 = Buffer.from(hex, "hex").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(digest).toBe(`sha256=${expectedB64}`);
  });
});

describe("ZIP parsing + extraction (parseCentralDirectory/readZipEntryData/extractTemplateFiles)", () => {
  it("round-trips a stored (uncompressed) entry", () => {
    const zip = buildZip([{ name: "pkg/templates/index.json", data: Buffer.from('{"a":1}'), method: "stored" }]);
    const entries = parseCentralDirectory(zip);
    expect(entries).toHaveLength(1);
    expect(readZipEntryData(zip, entries[0]!).toString("utf8")).toBe('{"a":1}');
  });

  it("round-trips a deflated entry", () => {
    const payload = "x".repeat(500) + JSON.stringify({ hello: "world" });
    const zip = buildZip([{ name: "pkg/templates/flux_dev.json", data: Buffer.from(payload), method: "deflate" }]);
    const entries = parseCentralDirectory(zip);
    expect(readZipEntryData(zip, entries[0]!).toString("utf8")).toBe(payload);
  });

  it("extracts only /templates/ members, flattened to their basename", () => {
    const zip = buildZip([
      { name: "pkg/templates/index.json", data: Buffer.from("A") },
      { name: "pkg/templates/sub/thumb.webp", data: Buffer.from("B") },
      { name: "pkg/__init__.py", data: Buffer.from("C") }, // not under templates/, excluded
      { name: "pkg-0.1.dist-info/RECORD", data: Buffer.from("D") }, // bookkeeping, excluded by memberBasename
    ]);
    const files = extractTemplateFiles(zip);
    expect([...files.keys()].sort()).toEqual(["index.json", "thumb.webp"]);
    expect(Buffer.from(files.get("index.json")!).toString("utf8")).toBe("A");
    expect(Buffer.from(files.get("thumb.webp")!).toString("utf8")).toBe("B");
  });

  it("verifies extracted files against a RECORD entry and passes when it matches", () => {
    const indexData = Buffer.from('{"ok":true}');
    const recordText = `pkg/templates/index.json,${recordDigestOf(indexData)},${indexData.length}\n`;
    const zip = buildZip([
      { name: "pkg/templates/index.json", data: indexData },
      { name: "pkg-0.1.dist-info/RECORD", data: Buffer.from(recordText) },
    ]);
    const files = extractTemplateFiles(zip);
    expect(Buffer.from(files.get("index.json")!).toString("utf8")).toBe('{"ok":true}');
  });

  it("throws on a RECORD sha256 mismatch (tampered/corrupted payload)", () => {
    const indexData = Buffer.from('{"ok":true}');
    const wrongDigest = recordDigestOf(Buffer.from("not the real content"));
    const recordText = `pkg/templates/index.json,${wrongDigest},999\n`;
    const zip = buildZip([
      { name: "pkg/templates/index.json", data: indexData },
      { name: "pkg-0.1.dist-info/RECORD", data: Buffer.from(recordText) },
    ]);
    expect(() => extractTemplateFiles(zip)).toThrow(/RECORD sha256 mismatch/);
  });

  it("warns (does not throw) when a wanted member has no RECORD entry", () => {
    const zip = buildZip([
      { name: "pkg/templates/index.json", data: Buffer.from("A") },
      { name: "pkg-0.1.dist-info/RECORD", data: Buffer.from("pkg/templates/other.json,sha256=x,1\n") },
    ]);
    const warnings: string[] = [];
    const files = extractTemplateFiles(zip, (msg) => warnings.push(msg));
    expect(Buffer.from(files.get("index.json")!).toString("utf8")).toBe("A");
    expect(warnings.some((w) => w.includes("index.json"))).toBe(true);
  });
});

describe("signS3Put (SigV4 header auth)", () => {
  it("produces a well-formed Authorization header and a matching payload hash", () => {
    const body = Buffer.from('{"a":1}');
    const now = new Date("2026-01-02T03:04:05.000Z");
    const { authorization, amzDate, payloadHash } = signS3Put({
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      host: "abc123.r2.cloudflarestorage.com",
      uri: "/my-bucket/official_templates/index.json",
      body,
      now,
    });

    expect(amzDate).toBe("20260102T030405Z");
    expect(payloadHash).toBe(sha256Hex(body));
    expect(authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260102\/auto\/s3\/aws4_request, /);
    expect(authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(authorization).toMatch(/Signature=[0-9a-f]{64}$/);
  });

  it("is deterministic for the same inputs", () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const params = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      host: "abc123.r2.cloudflarestorage.com",
      uri: "/my-bucket/official_templates/index.json",
      body: Buffer.from("same"),
      now,
    };
    expect(signS3Put(params).authorization).toBe(signS3Put(params).authorization);
  });

  it("changes signature when the body changes", () => {
    const base = {
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "secret",
      host: "abc123.r2.cloudflarestorage.com",
      uri: "/my-bucket/official_templates/index.json",
      now: new Date("2026-01-02T03:04:05.000Z"),
    };
    const a = signS3Put({ ...base, body: Buffer.from("one") });
    const b = signS3Put({ ...base, body: Buffer.from("two") });
    expect(a.authorization).not.toBe(b.authorization);
  });
});

describe("sigv4UriEncode", () => {
  it("escapes characters encodeURIComponent under-encodes", () => {
    expect(sigv4UriEncode("a!b'c(d)e*f")).toBe("a%21b%27c%28d%29e%2Af");
  });
});

describe("mapWithConcurrency", () => {
  it("preserves result order regardless of completion order", async () => {
    const delays = [30, 10, 20];
    const results = await mapWithConcurrency(delays, 3, (ms: number, i: number) => new Promise((r) => setTimeout(() => r(i), ms)));
    expect(results).toEqual([0, 1, 2]);
  });

  it("never runs more than `limit` at once", async () => {
    let active = 0;
    let maxActive = 0;
    await mapWithConcurrency(Array.from({ length: 10 }, (_, i) => i), 3, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("handles an empty input", async () => {
    expect(await mapWithConcurrency([], 5, () => Promise.resolve(1))).toEqual([]);
  });
});
