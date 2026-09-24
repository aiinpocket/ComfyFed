/**
 * Pure, disk/network-free helpers for `seed-official.mjs` -- deliberately
 * split out of that file so `cloud/test/seed-official.spec.ts` can unit-test
 * the hash-check / RECORD-verify / zip-flattening logic (per task-10-brief's
 * "seed script's unzip/verify logic unit-testable parts (hash check) --
 * network parts excluded") WITHOUT importing `node:fs`, `node:child_process`,
 * `node:os`, or `node:url` -- none of which this repo's cloud test suite can
 * safely import, since `cloud/vitest.config.ts` runs every test file inside
 * `@cloudflare/vitest-pool-workers`' workerd sandbox, not plain Node. Only
 * `node:crypto` (createHash/createHmac) and `node:zlib` (inflateRawSync) are
 * imported here -- both are real Workers-runtime built-ins under this
 * project's `nodejs_compat` flag, unlike a real filesystem or child
 * processes, so importing this module from a test file is safe.
 *
 * `seed-official.mjs` (the CLI entrypoint actually run by the operator, via
 * plain `node`, never imported by a test) layers the disk/network I/O --
 * PyPI fetches, temp-file streaming download, R2 upload -- on top of these
 * pure functions.
 */

import { createHash, createHmac } from "node:crypto";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// PyPI response parsing -- ports the former Python `_parse_sub_packages`
// / `_wheel_url_and_sha256`.

const REQUIRES_RE = /^([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9.]+)/;

/** `name==version` pins out of the meta package's `requires_dist`, dropping
 * any `-core` package -- ComfyFed has its own `/comfy` template serving, so
 * the upstream server-side loader package is never fetched. */
export function parseSubPackages(requiresDist) {
  const packages = {};
  for (const entry of requiresDist ?? []) {
    const match = REQUIRES_RE.exec(String(entry).trim());
    if (!match) continue;
    const [, name, version] = match;
    if (name.endsWith("-core")) continue;
    packages[name] = version;
  }
  return packages;
}

/** The `bdist_wheel` download URL + its PyPI-published sha256 digest out of
 * one package's PyPI JSON API response. */
export function wheelUrlAndSha256(packageJson) {
  for (const entry of packageJson.urls ?? []) {
    if (entry.packagetype === "bdist_wheel") {
      const digest = entry.digests?.sha256;
      if (entry.url && digest) return { url: entry.url, sha256: digest };
    }
  }
  throw new Error("No wheel with a sha256 digest found in the PyPI response.");
}

// ---------------------------------------------------------------------------
// Whole-buffer sha256 -- verifies a downloaded wheel against the digest
// PyPI's JSON API reports for it (there is no single pinned constant here,
// unlike build.mjs's pinned frontend bundle: the set of sub-packages and
// their versions is itself discovered from PyPI at fetch time).

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

// ---------------------------------------------------------------------------
// Minimal ZIP (PKZIP) reader -- a wheel is a standard zip file. Node has no
// built-in zip-container parser, so the central directory is walked by hand;
// `node:zlib`'s `inflateRawSync` handles the one compression method wheels
// actually use (deflate) plus the trivial "stored" (uncompressed) case.
// Deliberately does NOT handle Zip64 (files >4GB / >65535 entries) -- the
// 512MB per-wheel cap in `seed-official.mjs` makes that unreachable here.

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_HEADER_SIGNATURE = 0x04034b50;

function findEndOfCentralDirectory(buf) {
  // The EOCD record is fixed-size (22 bytes) plus an optional comment of up
  // to 65535 bytes at the very end of the archive; scan backward for its
  // signature rather than assuming no comment.
  const minOffset = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) return i;
  }
  throw new Error("Not a valid zip file (End Of Central Directory record not found).");
}

/** Every central-directory entry's `{name, compressionMethod,
 * compressedSize, localHeaderOffset}` -- enough to later fetch and
 * decompress each member's data with `readZipEntryData`. */
export function parseCentralDirectory(buf) {
  const eocdOffset = findEndOfCentralDirectory(buf);
  const totalEntries = buf.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buf.readUInt32LE(eocdOffset + 16);

  const entries = [];
  let offset = centralDirOffset;
  for (let i = 0; i < totalEntries; i++) {
    if (buf.readUInt32LE(offset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`Bad central directory entry at offset ${offset} (entry ${i}/${totalEntries}).`);
    }
    const compressionMethod = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const uncompressedSize = buf.readUInt32LE(offset + 24);
    const fileNameLength = buf.readUInt16LE(offset + 28);
    const extraFieldLength = buf.readUInt16LE(offset + 30);
    const fileCommentLength = buf.readUInt16LE(offset + 32);
    const localHeaderOffset = buf.readUInt32LE(offset + 42);
    const nameStart = offset + 46;
    const name = buf.toString("utf8", nameStart, nameStart + fileNameLength);

    entries.push({ name, compressionMethod, compressedSize, uncompressedSize, localHeaderOffset });
    offset = nameStart + fileNameLength + extraFieldLength + fileCommentLength;
  }
  return entries;
}

/** One entry's decompressed bytes, read via its local file header (whose
 * filename/extra-field lengths can differ from the central directory's,
 * hence re-reading them here rather than trusting the central copy). */
export function readZipEntryData(buf, entry) {
  const lh = entry.localHeaderOffset;
  if (buf.readUInt32LE(lh) !== LOCAL_HEADER_SIGNATURE) {
    throw new Error(`Bad local file header for ${entry.name} at offset ${lh}.`);
  }
  const nameLength = buf.readUInt16LE(lh + 26);
  const extraLength = buf.readUInt16LE(lh + 28);
  const dataStart = lh + 30 + nameLength + extraLength;
  const compressed = buf.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.compressionMethod === 0) return Buffer.from(compressed);
  if (entry.compressionMethod === 8) return zlib.inflateRawSync(compressed);
  throw new Error(`Unsupported zip compression method ${entry.compressionMethod} for ${entry.name}.`);
}

// ---------------------------------------------------------------------------
// Zip-slip-safe flattening -- byte-for-byte port of the former Python
// `_member_basename`: a member is wanted iff its path has a "/templates/"
// segment; ONLY its final path component is kept (flattening away the
// sub-package name and the "templates/" prefix). A `basename()`-only guard
// is not enough on its own -- `".../templates/../evil.txt"` also contains
// the "/templates/" substring and basenames to the harmless-looking
// "evil.txt" after the traversal has already happened -- so every path
// segment is checked for "."/".." directly.

const TEMPLATES_SEGMENT = "/templates/";

export function memberBasename(name) {
  if (name.endsWith("/")) return null; // directory entry
  if (!("/" + name).includes(TEMPLATES_SEGMENT)) return null;

  const parts = name.split("/");
  const dirParts = parts.slice(0, -1);
  if (dirParts.some((part) => part === "" || part === "." || part === "..")) return null;

  const basename = parts[parts.length - 1];
  if (!basename || basename.includes("/") || basename.includes("\\") || basename.includes("..")) return null;
  return basename;
}

// ---------------------------------------------------------------------------
// Per-file RECORD verification -- a check the former Python version did NOT
// do (it only verified the whole wheel's sha256 against PyPI's digest); this
// script adds it as extra integrity assurance since it also handles the R2
// upload step, verifying each individually-uploaded file's sha256 against
// the wheel's own PEP 376 `RECORD` manifest (`<dist-info>/RECORD`, lines of
// `path,sha256=<url-safe-base64-no-padding>,size`) in addition to the
// whole-wheel digest. A RECORD line missing for a wanted member is logged
// (via the caller) and skipped, not treated as fatal -- wheel-building tools
// have historically varied in whether every payload file gets a RECORD
// entry, and the whole-wheel sha256 check already guarantees the archive as
// downloaded matches what PyPI published.

/** Parses a wheel's `RECORD` file into `Map<path, "sha256=...">`. Lines with
 * no digest field (RECORD's own self-entry, or a malformed line) are
 * skipped rather than stored with an empty digest. */
export function parseRecord(text) {
  const map = new Map();
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;
    const firstComma = line.indexOf(",");
    if (firstComma === -1) continue;
    const filePath = line.slice(0, firstComma);
    const rest = line.slice(firstComma + 1);
    const secondComma = rest.indexOf(",");
    const digest = secondComma === -1 ? rest : rest.slice(0, secondComma);
    if (digest) map.set(filePath, digest);
  }
  return map;
}

/** `sha256=<url-safe-base64-no-padding>` of `data`, matching PEP 376's
 * RECORD digest format exactly (`base64.urlsafe_b64encode(...).rstrip('=')`
 * on the Python side). */
export function recordDigestOf(data) {
  const base64 = createHash("sha256").update(data).digest("base64");
  const urlSafe = base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `sha256=${urlSafe}`;
}

// ---------------------------------------------------------------------------
// Full per-wheel extraction: parses the central directory, verifies every
// wanted member against RECORD (when present), and returns
// `{ basename -> bytes }` for the caller to write to disk (kept in-memory
// here -- no `fs` import in this file, see the module docstring).

/**
 * @param {Buffer} wheelBuffer
 * @param {function(string): void} [warn]
 * @returns {Map<string, Buffer>} flattened basename -> verified file bytes
 */
export function extractTemplateFiles(wheelBuffer, warn = () => {}) {
  const entries = parseCentralDirectory(wheelBuffer);
  const recordEntry = entries.find((e) => e.name.endsWith(".dist-info/RECORD"));
  const record = recordEntry ? parseRecord(readZipEntryData(wheelBuffer, recordEntry).toString("utf8")) : null;

  const files = new Map();
  for (const entry of entries) {
    const basename = memberBasename(entry.name);
    if (basename === null) continue;

    const data = readZipEntryData(wheelBuffer, entry);

    if (record) {
      const expected = record.get(entry.name);
      if (expected === undefined) {
        warn(`no RECORD entry for ${entry.name}, skipping per-file hash verification`);
      } else {
        const actual = recordDigestOf(data);
        if (actual !== expected) {
          throw new Error(`RECORD sha256 mismatch for ${entry.name}: expected ${expected}, got ${actual}`);
        }
      }
    }

    files.set(basename, data);
  }
  return files;
}

// ---------------------------------------------------------------------------
// SigV4 header-auth signing for the R2 S3-API upload path (see
// `seed-official.mjs`'s docstring for why this is a small independent
// implementation rather than importing `cloud/src/lib/sigv4.ts`, which signs
// QUERY-STRING/presigned auth, not the header-based auth a script holding
// real credentials directly should use).

function hmac(key, data) {
  return createHmac("sha256", key).update(data).digest();
}

/** SigV4 percent-encoding: RFC 3986 unreserved chars kept literal, `!'()*`
 * escaped too (plain `encodeURIComponent` under-encodes those). */
export function sigv4UriEncode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** Builds the `Authorization` header + `x-amz-date`/`x-amz-content-sha256`
 * values for a single-shot signed `PUT` against R2's S3-compatible API.
 * Always signs the real payload hash (not `UNSIGNED-PAYLOAD`) -- unlike
 * `lib/sigv4.ts`'s presigned URLs (signed before the body is known, for an
 * agent that streams bytes later), this script already holds the full body
 * in memory when it signs. */
export function signS3Put({ accessKeyId, secretAccessKey, region = "auto", host, uri, body, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const service = "s3";
  const payloadHash = sha256Hex(body);

  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = ["PUT", uri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = hmac(kSigning, stringToSign).toString("hex");

  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    payloadHash,
  };
}

// ---------------------------------------------------------------------------
// Small concurrency pool -- uploading ~1376 files one `wrangler r2 object
// put` at a time is far too slow (see seed-official.mjs's docstring); this
// bounds parallelism for both the S3-API path and the wrangler-CLI fallback.

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving
 * result order. */
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
