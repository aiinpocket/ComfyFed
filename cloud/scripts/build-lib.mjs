/**
 * Pure, disk/network-free helpers for `build.mjs` -- split out for the same
 * reason `seed-official-lib.mjs` is (see that file's docstring): this
 * repo's single `vitest.config.ts` runs every test file inside
 * `@cloudflare/vitest-pool-workers`' workerd sandbox, which has no real
 * filesystem or child-process access, so anything a test imports must avoid
 * `node:fs`/`node:child_process`. Only the zip-parsing pieces (imported from
 * `seed-official-lib.mjs`, which is itself already constrained the same
 * way) and `node:crypto`'s `createHash` (a real Workers-runtime built-in
 * under `nodejs_compat`) are used here.
 *
 * These functions implement the wheel side of build.mjs's step (b): fetch
 * the pinned `comfyui-frontend-package` wheel (same version+sha256 as
 * `server/comfyfed_server/comfy_frontend.py`'s constants -- see build.mjs's
 * own `FRONTEND_VERSION`/`FRONTEND_SHA256`, which MUST be bumped together
 * with that file's, never independently), extract everything under its
 * `comfyui_frontend_package/static/` prefix, and drop `.map` files (the
 * frontend bundle ships source maps for its own JS/CSS; a Workers Sites
 * deployment has no debugging use for ~megabytes of source-map JSON, so
 * dropping them shrinks the asset upload for free -- `comfy_frontend.py`'s
 * `extract_static` does NOT do this, since disk space is not the same
 * constraint for a locally-run server process).
 */

import { createHash } from "node:crypto";
import { parseCentralDirectory, readZipEntryData } from "./seed-official-lib.mjs";

export function sha256Hex(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * A wheel member's path relative to `staticPrefix`, or `null` if the member
 * should be skipped: not under the prefix at all, a directory entry (zip
 * directory entries end in `/` and carry no bytes), or a `.map` source map.
 *
 * @param {string} name full zip member name (e.g.
 *   `"comfyui_frontend_package/static/assets/index-abc123.js.map"`)
 * @param {string} staticPrefix e.g. `"comfyui_frontend_package/static/"`
 * @returns {string | null}
 */
export function frontendMemberRelativePath(name, staticPrefix) {
  if (!name.startsWith(staticPrefix)) return null;
  if (name.endsWith("/")) return null;
  const relative = name.slice(staticPrefix.length);
  if (!relative) return null;
  if (relative.toLowerCase().endsWith(".map")) return null;
  return relative;
}

/**
 * Parses `wheelBuffer` (an already sha256-verified `comfyui-frontend-
 * package` wheel) and returns `Map<relativePath, Buffer>` for every static
 * file under `staticPrefix`, with `.map` files dropped. Throws if the
 * result has no `index.html` at its root -- same sanity check
 * `comfy_frontend.py`'s `extract_static` makes ("is this the right
 * package?").
 *
 * @param {Buffer} wheelBuffer
 * @param {string} staticPrefix
 * @returns {Map<string, Buffer>}
 */
export function extractFrontendStatic(wheelBuffer, staticPrefix) {
  const entries = parseCentralDirectory(wheelBuffer);
  const files = new Map();
  for (const entry of entries) {
    const relative = frontendMemberRelativePath(entry.name, staticPrefix);
    if (relative === null) continue;
    files.set(relative, readZipEntryData(wheelBuffer, entry));
  }
  if (!files.has("index.html")) {
    throw new Error(`Extracted frontend bundle has no index.html under "${staticPrefix}".`);
  }
  return files;
}

/** Total byte size of every value in a `Map<string, Buffer>` -- used for the
 * build script's summary log. */
export function totalBytes(fileMap) {
  let total = 0;
  for (const buf of fileMap.values()) total += buf.length;
  return total;
}
