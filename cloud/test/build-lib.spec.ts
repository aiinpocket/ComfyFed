import { describe, expect, it } from "vitest";
import zlib from "node:zlib";
import { frontendMemberRelativePath, extractFrontendStatic, sha256Hex, totalBytes } from "../scripts/build-lib.mjs";

// Unit-tests build.mjs's pure wheel-member-filtering / .map-dropping logic
// with a tiny fixture zip, per task-11's test requirement -- no network, no
// filesystem, same "safe to import from a workerd-sandboxed test" reasoning
// as seed-official-lib.mjs (see that file's and seed-official.spec.ts's
// docstrings): only node:crypto/node:zlib built-ins are touched.

// --- Minimal hand-rolled ZIP writer, copied from seed-official.spec.ts's
// `buildZip` (kept duplicated rather than imported -- that helper lives in a
// *.spec.ts file, not a shared test-support module) -----------------------

interface ZipInput {
  name: string;
  data: Buffer;
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
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localHeaderOffset = offset;
    localParts.push(localHeader, nameBuf, compressed);
    offset += localHeader.length + nameBuf.length + compressed.length;

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
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

const PREFIX = "comfyui_frontend_package/static/";

describe("frontendMemberRelativePath", () => {
  it("returns the relative path for a member under the static prefix", () => {
    expect(frontendMemberRelativePath(`${PREFIX}index.html`, PREFIX)).toBe("index.html");
    expect(frontendMemberRelativePath(`${PREFIX}assets/index-abc123.js`, PREFIX)).toBe("assets/index-abc123.js");
  });

  it("drops members outside the static prefix", () => {
    expect(frontendMemberRelativePath("comfyui_frontend_package-1.52.7.dist-info/RECORD", PREFIX)).toBeNull();
    expect(frontendMemberRelativePath("comfyui_frontend_package/__init__.py", PREFIX)).toBeNull();
  });

  it("drops directory entries", () => {
    expect(frontendMemberRelativePath(`${PREFIX}assets/`, PREFIX)).toBeNull();
    expect(frontendMemberRelativePath(PREFIX, PREFIX)).toBeNull();
  });

  it("drops .map files, case-insensitively", () => {
    expect(frontendMemberRelativePath(`${PREFIX}assets/index-abc123.js.map`, PREFIX)).toBeNull();
    expect(frontendMemberRelativePath(`${PREFIX}assets/index-abc123.JS.MAP`, PREFIX)).toBeNull();
  });

  it("does not drop a file that merely contains 'map' mid-name", () => {
    expect(frontendMemberRelativePath(`${PREFIX}assets/sitemap.js`, PREFIX)).toBe("assets/sitemap.js");
  });
});

describe("extractFrontendStatic", () => {
  it("extracts static files, drops .map files, keyed by relative path", () => {
    const zip = buildZip([
      { name: `${PREFIX}index.html`, data: Buffer.from("<html>hi</html>"), method: "stored" },
      { name: `${PREFIX}assets/app.js`, data: Buffer.from("console.log(1)"), method: "deflate" },
      { name: `${PREFIX}assets/app.js.map`, data: Buffer.from('{"version":3}'), method: "stored" },
      { name: `${PREFIX}assets/`, data: Buffer.alloc(0), method: "stored" },
      { name: "comfyui_frontend_package-1.52.7.dist-info/METADATA", data: Buffer.from("Metadata-Version: 2.1"), method: "stored" },
    ]);

    const files = extractFrontendStatic(zip, PREFIX);

    expect([...files.keys()].sort()).toEqual(["assets/app.js", "index.html"]);
    expect(Buffer.from(files.get("index.html")!).toString("utf8")).toBe("<html>hi</html>");
    expect(Buffer.from(files.get("assets/app.js")!).toString("utf8")).toBe("console.log(1)");
  });

  it("throws when the extracted bundle has no index.html", () => {
    const zip = buildZip([{ name: `${PREFIX}assets/app.js`, data: Buffer.from("x"), method: "stored" }]);
    expect(() => extractFrontendStatic(zip, PREFIX)).toThrow(/index\.html/);
  });
});

describe("sha256Hex / totalBytes", () => {
  it("sha256Hex matches a known vector", () => {
    expect(sha256Hex(Buffer.from(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("totalBytes sums every value's length", () => {
    const map = new Map<string, Buffer>([
      ["a", Buffer.from("abc")],
      ["b", Buffer.from("de")],
    ]);
    expect(totalBytes(map)).toBe(5);
  });
});
