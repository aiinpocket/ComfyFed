/**
 * Pure, disk-free helpers for `build-wheel.mjs` (spec
 * `2026-09-24-single-stack-selfhost-and-remote-update.md` §2.1): build a
 * PEP 427 `py3-none-any` wheel for the agent out of an in-memory file map,
 * so the platform can ship the agent release inside its own assets on every
 * deploy instead of an operator hand-uploading one.
 *
 * Kept free of `node:fs` / `node:child_process` for the same reason
 * `build-lib.mjs` is: `test/build-wheel.spec.ts` runs inside the workerd
 * sandbox. Only `node:crypto` (sha256) and `node:zlib` (raw deflate) are
 * used, both available under `nodejs_compat`.
 *
 * Wheel layout produced (member order is fixed so the archive is
 * reproducible byte-for-byte for the same inputs):
 *
 *   <package>/...            every source file, in sorted path order
 *   <dist>-<v>.dist-info/METADATA
 *   <dist>-<v>.dist-info/WHEEL
 *   <dist>-<v>.dist-info/entry_points.txt
 *   <dist>-<v>.dist-info/top_level.txt
 *   <dist>-<v>.dist-info/RECORD      (always last, per PEP 427)
 *
 * RECORD rows are `path,sha256=<urlsafe-b64-no-pad>,<size>` and the RECORD
 * row itself is `path,,` -- exactly what pip writes and verifies.
 */

import { createHash } from "node:crypto";
import { deflateRawSync } from "node:zlib";

// --- zip writer -----------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Fixed timestamp (1980-01-01 00:00, the DOS epoch) so two builds of the same
// sources are byte-identical: the wheel's sha256 is what the platform signs
// and what every agent verifies, and a timestamp-only difference would
// otherwise make every build a "new" release.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // month 1, day 1, year 1980
const FLAG_UTF8 = 0x0800;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const VERSION_NEEDED = 20;

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n, 0);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n >>> 0, 0);
  return b;
}

/**
 * Builds a zip archive from `[name, bytes]` entries in the given order.
 * Deflate is used whenever it actually shrinks a member; tiny or
 * incompressible members are stored.
 *
 * @param {Array<[string, Buffer]>} entries
 * @returns {Buffer}
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORED;
    const body = useDeflate ? deflated : data;
    const crc = crc32(data);

    const local = Buffer.concat([
      u32(0x04034b50),
      u16(VERSION_NEEDED),
      u16(FLAG_UTF8),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(body.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      nameBytes,
      body,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(VERSION_NEEDED),
      u16(VERSION_NEEDED),
      u16(FLAG_UTF8),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(body.length),
      u32(data.length),
      u16(nameBytes.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0o100644 << 16),
      u32(offset),
      nameBytes,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

// --- wheel metadata --------------------------------------------------------

function sha256UrlSafeB64(data) {
  return createHash("sha256").update(data).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PEP 503 / PEP 427 normalised distribution name for filenames. */
export function normalizeDistName(name) {
  return name.replace(/[-_.]+/g, "_").toLowerCase();
}

/**
 * @param {object} meta
 * @param {string} meta.name        distribution name (e.g. "comfyfed")
 * @param {string} meta.version
 * @param {string} meta.requiresPython
 * @param {string[]} meta.requiresDist  plain PEP 508 requirement strings
 * @param {Record<string, string[]>} [meta.extras]  extra name -> requirements
 * @param {string} [meta.summary]
 * @param {string} [meta.license]
 */
export function renderMetadata(meta) {
  const lines = ["Metadata-Version: 2.1", `Name: ${meta.name}`, `Version: ${meta.version}`];
  if (meta.summary) lines.push(`Summary: ${meta.summary}`);
  if (meta.license) lines.push(`License: ${meta.license}`);
  lines.push(`Requires-Python: ${meta.requiresPython}`);
  for (const req of meta.requiresDist) lines.push(`Requires-Dist: ${req}`);
  for (const [extra, reqs] of Object.entries(meta.extras ?? {})) {
    lines.push(`Provides-Extra: ${extra}`);
    for (const req of reqs) lines.push(`Requires-Dist: ${req}; extra == "${extra}"`);
  }
  return lines.join("\n") + "\n";
}

export function renderEntryPoints(consoleScripts) {
  const lines = ["[console_scripts]"];
  for (const [name, target] of Object.entries(consoleScripts)) lines.push(`${name} = ${target}`);
  return lines.join("\n") + "\n";
}

const WHEEL_FILE = "Wheel-Version: 1.0\nGenerator: comfyfed-build-wheel\nRoot-Is-Purelib: true\nTag: py3-none-any\n";

/**
 * Assemble a wheel.
 *
 * @param {object} spec
 * @param {string} spec.name           distribution name
 * @param {string} spec.version
 * @param {Map<string, Buffer>} spec.files  archive path -> bytes for every
 *   package file (e.g. "comfyfed_agent/main.py")
 * @param {string[]} spec.topLevel     top-level import packages
 * @param {Record<string, string>} spec.consoleScripts
 * @param {string} spec.requiresPython
 * @param {string[]} spec.requiresDist
 * @param {Record<string, string[]>} [spec.extras]
 * @param {string} [spec.summary]
 * @param {string} [spec.license]
 * @returns {{ filename: string, bytes: Buffer, distInfo: string }}
 */
export function buildWheel(spec) {
  const distName = normalizeDistName(spec.name);
  const distInfo = `${distName}-${spec.version}.dist-info`;
  const filename = `${distName}-${spec.version}-py3-none-any.whl`;

  const packageEntries = [...spec.files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const metaEntries = [
    [`${distInfo}/METADATA`, Buffer.from(renderMetadata(spec), "utf8")],
    [`${distInfo}/WHEEL`, Buffer.from(WHEEL_FILE, "utf8")],
    [`${distInfo}/entry_points.txt`, Buffer.from(renderEntryPoints(spec.consoleScripts), "utf8")],
    [`${distInfo}/top_level.txt`, Buffer.from(spec.topLevel.join("\n") + "\n", "utf8")],
  ];
  const hashed = [...packageEntries, ...metaEntries];
  const recordLines = hashed.map(([path, data]) => `${path},sha256=${sha256UrlSafeB64(data)},${data.length}`);
  recordLines.push(`${distInfo}/RECORD,,`);
  const record = Buffer.from(recordLines.join("\n") + "\n", "utf8");

  const bytes = buildZip([...hashed, [`${distInfo}/RECORD`, record]]);
  return { filename, bytes, distInfo };
}

// --- pyproject parsing -----------------------------------------------------

/**
 * Extracts a `key = [ "a", "b" ]` string array from a TOML section. This is
 * deliberately a narrow parser (no TOML dependency): it only understands the
 * shapes `pyproject.toml` actually uses -- a `[section]` header, then a key
 * whose value is a bracketed list of double-quoted strings, possibly spanning
 * lines, with `#` comments between them.
 *
 * @param {string} toml
 * @param {string} section  e.g. "tool.comfyfed"
 * @param {string} key      e.g. "agent-dependencies"
 * @returns {string[] | null}  null when the section or key is absent
 */
export function tomlStringArray(toml, section, key) {
  const body = tomlSection(toml, section);
  if (body === null) return null;
  const keyRe = new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*\\[`, "m");
  const start = body.search(keyRe);
  if (start < 0) return null;
  const open = body.indexOf("[", start);
  const close = body.indexOf("]", open);
  if (close < 0) throw new Error(`pyproject: unterminated list for ${section}.${key}`);
  const inner = body.slice(open + 1, close).replace(/#[^\n]*/g, "");
  return [...inner.matchAll(/"([^"]*)"/g)].map((m) => m[1]);
}

/**
 * `key = "value"` inside a section.
 * @returns {string | null}
 */
export function tomlString(toml, section, key) {
  const body = tomlSection(toml, section);
  if (body === null) return null;
  const m = new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*"([^"]*)"`, "m").exec(body);
  return m ? m[1] : null;
}

/**
 * `[section]` ... up to the next header. Dotted section names are matched
 * literally (`[tool.comfyfed]`).
 */
function tomlSection(toml, section) {
  const headerRe = new RegExp(`^\\[${escapeRe(section)}\\]\\s*$`, "m");
  const m = headerRe.exec(toml);
  if (!m) return null;
  const rest = toml.slice(m.index + m[0].length);
  const next = rest.search(/^\[[^\]]+\]\s*$/m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** `__version__ = "x.y.z"` from a package `__init__.py`. */
export function pythonDunderVersion(source) {
  const m = /^__version__\s*=\s*["']([^"']+)["']/m.exec(source);
  return m ? m[1] : null;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
}
