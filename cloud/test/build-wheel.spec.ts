import { describe, expect, it } from "vitest";
import {
  buildWheel,
  buildZip,
  crc32,
  normalizeDistName,
  pythonDunderVersion,
  renderMetadata,
  tomlString,
  tomlStringArray,
} from "../scripts/wheel-lib.mjs";
import { parseCentralDirectory, parseRecord, readZipEntryData, recordDigestOf } from "../scripts/seed-official-lib.mjs";

// Unit-tests the in-memory wheel builder behind build.mjs's step (e) (spec
// 2026-09-24 §2.1). Same sandbox constraints as build-lib.spec.ts: no
// filesystem, only node:crypto / node:zlib built-ins.

function sampleFiles(): Map<string, Buffer> {
  return new Map([
    ["pkg/sub/mod.py", Buffer.from("x = 1\n", "utf8")],
    ["pkg/__init__.py", Buffer.from('__version__ = "1.2.3"\n', "utf8")],
    // Big enough that deflate actually shrinks it (a tiny member is stored).
    ["pkg/big.py", Buffer.from("# " + "comfyfed ".repeat(400) + "\n", "utf8")],
  ]);
}

function sampleSpec() {
  return {
    name: "comfyfed",
    version: "1.2.3",
    files: sampleFiles(),
    topLevel: ["pkg"],
    consoleScripts: { comfyfed: "pkg.main:cli", "comfyfed-agent": "pkg.main:cli" },
    requiresPython: ">=3.12",
    requiresDist: ["httpx>=0.27", "pynacl>=1.5"],
    extras: { mcp: ["mcp>=2.0,<3"] },
    summary: "test",
    license: "AGPL-3.0-only",
  };
}

function members(bytes: Uint8Array): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const entry of parseCentralDirectory(bytes)) {
    out.set(entry.name, readZipEntryData(bytes, entry));
  }
  return out;
}

// The workerd-sandbox `Buffer` type is narrower than Node's (no
// `toString(encoding)`, `equals`, `readUInt32LE`), so decode/compare/read
// through the platform APIs instead.
const text = (buf: Uint8Array): string => new TextDecoder().decode(buf);
const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const u32le = (buf: Uint8Array, offset: number): number =>
  new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getUint32(offset, true);

describe("crc32 / buildZip", () => {
  it("computes the standard CRC-32 check value", () => {
    expect(crc32(Buffer.from("123456789", "ascii")).toString(16)).toBe("cbf43926");
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it("writes members that round-trip through the existing zip reader, stored or deflated", () => {
    const small = Buffer.from("hi\n", "utf8");
    const large = Buffer.from("a".repeat(5000), "utf8");
    const zip = buildZip([
      ["a.txt", small],
      ["dir/b.txt", large],
    ]);
    const entries = parseCentralDirectory(zip);
    expect(entries.map((e: { name: string }) => e.name)).toEqual(["a.txt", "dir/b.txt"]);
    // small: stored (method 0); large: deflated (method 8) and smaller on disk.
    expect(entries[0]!.compressionMethod).toBe(0);
    expect(entries[1]!.compressionMethod).toBe(8);
    expect(entries[1]!.compressedSize).toBeLessThan(large.length);
    expect(bytesEqual(readZipEntryData(zip, entries[0]!), small)).toBe(true);
    expect(bytesEqual(readZipEntryData(zip, entries[1]!), large)).toBe(true);
    // The local header carries the CRC of the UNcompressed bytes.
    const crcField = u32le(zip, entries[1]!.localHeaderOffset + 14);
    expect(crcField).toBe(crc32(large));
  });
});

describe("buildWheel", () => {
  it("names the wheel and dist-info per PEP 427 and orders members deterministically with RECORD last", () => {
    const { filename, bytes, distInfo } = buildWheel(sampleSpec());
    expect(filename).toBe("comfyfed-1.2.3-py3-none-any.whl");
    expect(distInfo).toBe("comfyfed-1.2.3.dist-info");
    const names = parseCentralDirectory(bytes).map((e: { name: string }) => e.name);
    expect(names).toEqual([
      "pkg/__init__.py",
      "pkg/big.py",
      "pkg/sub/mod.py",
      "comfyfed-1.2.3.dist-info/METADATA",
      "comfyfed-1.2.3.dist-info/WHEEL",
      "comfyfed-1.2.3.dist-info/entry_points.txt",
      "comfyfed-1.2.3.dist-info/top_level.txt",
      "comfyfed-1.2.3.dist-info/RECORD",
    ]);
  });

  it("writes a RECORD whose digests and sizes match every member, and is byte-reproducible", () => {
    const first = buildWheel(sampleSpec());
    const second = buildWheel(sampleSpec());
    expect(bytesEqual(first.bytes, second.bytes)).toBe(true);

    const all = members(first.bytes);
    const recordText = text(all.get("comfyfed-1.2.3.dist-info/RECORD")!);
    const record = parseRecord(recordText);
    for (const [name, data] of all) {
      if (name.endsWith("/RECORD")) continue;
      expect(record.get(name), name).toBe(recordDigestOf(data));
      expect(recordText).toContain(`${name},${recordDigestOf(data)},${data.length}\n`);
    }
    expect(recordText.trimEnd().split("\n").at(-1)).toBe("comfyfed-1.2.3.dist-info/RECORD,,");
  });

  it("renders METADATA, WHEEL, entry_points.txt and top_level.txt the way pip expects", () => {
    const all = members(buildWheel(sampleSpec()).bytes);
    const metadata = text(all.get("comfyfed-1.2.3.dist-info/METADATA")!);
    expect(metadata).toBe(
      [
        "Metadata-Version: 2.1",
        "Name: comfyfed",
        "Version: 1.2.3",
        "Summary: test",
        "License: AGPL-3.0-only",
        "Requires-Python: >=3.12",
        "Requires-Dist: httpx>=0.27",
        "Requires-Dist: pynacl>=1.5",
        "Provides-Extra: mcp",
        'Requires-Dist: mcp>=2.0,<3; extra == "mcp"',
        "",
      ].join("\n")
    );
    expect(text(all.get("comfyfed-1.2.3.dist-info/WHEEL")!)).toContain("Tag: py3-none-any\n");
    expect(text(all.get("comfyfed-1.2.3.dist-info/WHEEL")!)).toContain("Root-Is-Purelib: true\n");
    expect(text(all.get("comfyfed-1.2.3.dist-info/entry_points.txt")!)).toBe(
      "[console_scripts]\ncomfyfed = pkg.main:cli\ncomfyfed-agent = pkg.main:cli\n"
    );
    expect(text(all.get("comfyfed-1.2.3.dist-info/top_level.txt")!)).toBe("pkg\n");
  });

  it("normalises the distribution name for the filename", () => {
    expect(normalizeDistName("Comfy-Fed.Agent")).toBe("comfy_fed_agent");
    expect(renderMetadata({ ...sampleSpec(), extras: undefined })).not.toContain("Provides-Extra");
  });
});

const PYPROJECT = `
[project]
name = "comfyfed"
version = "0.1.18"
requires-python = ">=3.12"
dependencies = [
  "fastapi>=0.115", "pynacl>=1.5",
]
[project.optional-dependencies]
dev = ["pytest>=8"]
mcp = ["mcp>=2.0,<3"]
[project.scripts]
comfyfed = "comfyfed_agent.main:cli"
[tool.comfyfed]
# comment line
agent-dependencies = [
  "httpx>=0.27",  # trailing comment
  "websockets>=13",
]
[tool.other]
agent-dependencies = ["wrong"]
`;

describe("pyproject helpers", () => {
  it("reads a quoted string and a string list out of the right section only", () => {
    expect(tomlString(PYPROJECT, "project", "version")).toBe("0.1.18");
    expect(tomlString(PYPROJECT, "project", "requires-python")).toBe(">=3.12");
    expect(tomlStringArray(PYPROJECT, "tool.comfyfed", "agent-dependencies")).toEqual(["httpx>=0.27", "websockets>=13"]);
    expect(tomlStringArray(PYPROJECT, "project.optional-dependencies", "mcp")).toEqual(["mcp>=2.0,<3"]);
    expect(tomlStringArray(PYPROJECT, "project", "dependencies")).toEqual(["fastapi>=0.115", "pynacl>=1.5"]);
  });

  it("returns null for a missing section or key", () => {
    expect(tomlStringArray(PYPROJECT, "tool.missing", "agent-dependencies")).toBeNull();
    expect(tomlStringArray(PYPROJECT, "project", "nope")).toBeNull();
    expect(tomlString(PYPROJECT, "project", "nope")).toBeNull();
  });

  it("extracts __version__ from a package __init__", () => {
    expect(pythonDunderVersion('"""doc"""\n\n__version__ = "0.1.18"\n')).toBe("0.1.18");
    expect(pythonDunderVersion("__version__ = '1.0'\n")).toBe("1.0");
    expect(pythonDunderVersion("x = 1\n")).toBeNull();
  });
});
