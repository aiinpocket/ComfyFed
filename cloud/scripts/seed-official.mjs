#!/usr/bin/env node
/**
 * Run locally by an operator (`node cloud/scripts/seed-official.mjs
 * [version]`, or `npm run seed-official` from `cloud/`) to fetch the
 * official ComfyUI workflow-template library from PyPI and upload it into
 * this deployment's R2 bucket under the `official_templates/` prefix --
 * `routes/templates.ts` and `core/model_guide.ts`'s `harvest()` both read
 * from that exact prefix (kept in sync deliberately, see those files).
 *
 * Ports `server/comfyfed_server/official_templates.py`'s `fetch()` (read
 * that module's docstring in full for the PyPI split-package rationale:
 * the `comfyui-workflow-templates` meta package's `requires_dist` pins the
 * `-json` index/workflow package and one-or-more `-media-*` packages,
 * skipping `-core` -- ComfyFed serves `/comfy/templates/...` itself and has
 * no use for upstream's server-side loader). The pure zip/hash/RECORD logic
 * lives in `seed-official-lib.mjs` (imported below) so
 * `cloud/test/seed-official.spec.ts` can unit-test it without touching the
 * network or a real filesystem -- see that file's docstring for why the
 * split exists (this project's single `vitest.config.ts` runs every test
 * inside `@cloudflare/vitest-pool-workers`' workerd sandbox, which has no
 * `node:fs`/`node:child_process`).
 *
 * Divergence from `official_templates.py`, deliberate:
 *
 * - Python writes the extracted+verified library straight to local disk
 *   (`<data_dir>/comfy_templates_official/`), atomically swapped into place.
 *   A Worker has no local disk of its own, so this script's target is R2
 *   instead: every extracted file (plus a `manifest.json` matching Python's
 *   shape) is uploaded flat under `official_templates/<basename>`. There is
 *   no atomic "swap the whole prefix at once" on R2, so a fetch that fails
 *   partway through can leave a mix of old and new objects -- acceptable
 *   for an operator-run, re-runnable maintenance script (re-run it and it
 *   converges), unlike Python's user-facing admin-panel trigger.
 * - Per-file `RECORD` sha256 verification (see seed-official-lib.mjs) is
 *   ADDED here, beyond what official_templates.py does (whole-wheel sha256
 *   against PyPI's digest only) -- extra assurance since this script is the
 *   one actually distributing each individual file's bytes onward via R2.
 * - Upload transport: `wrangler r2 object put` once per file is far too
 *   slow for the ~1376 files the real official library ships (one CLI
 *   invocation + auth round-trip each). Two modes, chosen by which
 *   credentials are present in the environment:
 *     1. **S3-API mode (preferred)** -- when ALL FOUR `R2_S3_ACCOUNT_ID`,
 *        `R2_S3_ACCESS_KEY_ID`, `R2_S3_SECRET_ACCESS_KEY`, `R2_S3_BUCKET`
 *        are set (the same credentials `env.ts`/`lib/sigv4.ts` document for
 *        the Worker's own presigned-upload path -- see `wrangler secret put
 *        R2_S3_*`), every file is PUT directly to R2's S3-compatible
 *        endpoint over plain `fetch` with a hand-signed SigV4 Authorization
 *        header (`signS3Put` in seed-official-lib.mjs -- header-based auth,
 *        NOT `lib/sigv4.ts`'s presigned-URL query auth: this script holds
 *        real credentials and the full file body already in memory, so
 *        there is no reason to presign). Uploads run with bounded
 *        concurrency (`S3_CONCURRENCY` below) -- fast enough for 1376 small
 *        files.
 *     2. **wrangler CLI fallback** -- when the S3 credentials are absent,
 *        falls back to `npx wrangler r2 object put <bucket>/<key> --file=...
 *        --remote` per file, still with bounded concurrency
 *        (`WRANGLER_CONCURRENCY`, deliberately lower: each invocation is a
 *        whole new CLI process). Documented here, loudly, as the SLOW path:
 *        an operator doing a real official-library sync should set the four
 *        `R2_S3_*` env vars for this script's run (they need not be the
 *        same values as the deployed Worker's secrets, though reusing them
 *        is the common case) rather than rely on this fallback for ~1376
 *        files.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

import {
  parseSubPackages,
  wheelUrlAndSha256,
  extractTemplateFiles,
  signS3Put,
  sigv4UriEncode,
  mapWithConcurrency,
} from "./seed-official-lib.mjs";

const META_PACKAGE = "comfyui-workflow-templates";
const R2_PREFIX = "official_templates/";
const MANIFEST_NAME = "manifest.json";

// Same cap as official_templates.py's `_MAX_WHEEL_BYTES` -- generous
// headroom over any real sub-package wheel (a few MB to a few tens of MB
// today) while still being a real stop against a runaway/compromised
// response, not a formality.
const MAX_WHEEL_BYTES = 512 * 1024 * 1024;

const S3_CONCURRENCY = 16;
const WRANGLER_CONCURRENCY = 4;

const MEDIA_CONTENT_TYPES = {
  ".json": "application/json",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
};

function contentTypeFor(filename) {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  return MEDIA_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.json();
}

/** Streams `url` to a temp file, hashing as it goes, aborting (and deleting
 * the partial file) the moment `maxBytes` is exceeded -- ports
 * official_templates.py's `_download` streaming-to-disk + mid-stream cap
 * behavior (never buffers the whole wheel in memory before the cap check). */
async function downloadToTemp(url, maxBytes) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} -> HTTP ${res.status}`);

  const dir = await mkdtemp(path.join(tmpdir(), "seed-official-dl-"));
  const filePath = path.join(dir, "wheel.whl");
  const fileStream = createWriteStream(filePath);
  const hasher = createHash("sha256");
  let total = 0;

  try {
    for await (const chunk of res.body) {
      total += chunk.length;
      if (total > maxBytes) {
        throw new Error(`Download exceeds ${Math.floor(maxBytes / (1024 * 1024))} MB cap, aborted: ${url}`);
      }
      hasher.update(chunk);
      await new Promise((resolve, reject) => fileStream.write(chunk, (err) => (err ? reject(err) : resolve())));
    }
  } catch (err) {
    fileStream.destroy();
    await rm(dir, { recursive: true, force: true });
    throw err;
  }

  await new Promise((resolve, reject) => fileStream.end((err) => (err ? reject(err) : resolve())));
  return { filePath, dir, sha256: hasher.digest("hex") };
}

function getS3CredsFromEnv() {
  const { R2_S3_ACCOUNT_ID, R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, R2_S3_BUCKET } = process.env;
  if (R2_S3_ACCOUNT_ID && R2_S3_ACCESS_KEY_ID && R2_S3_SECRET_ACCESS_KEY && R2_S3_BUCKET) {
    return {
      accountId: R2_S3_ACCOUNT_ID,
      accessKeyId: R2_S3_ACCESS_KEY_ID,
      secretAccessKey: R2_S3_SECRET_ACCESS_KEY,
      bucket: R2_S3_BUCKET,
    };
  }
  return null;
}

async function s3PutObject(creds, key, body) {
  const host = `${creds.accountId}.r2.cloudflarestorage.com`;
  const uri = "/" + [creds.bucket, ...key.split("/").map(sigv4UriEncode)].join("/");
  const { authorization, amzDate, payloadHash } = signS3Put({
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    host,
    uri,
    body,
  });

  const res = await fetch(`https://${host}${uri}`, {
    method: "PUT",
    headers: {
      host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      authorization,
      "content-type": contentTypeFor(key),
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`R2 S3 PUT ${key} -> HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  }
}

function wranglerPut(bucket, key, filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["wrangler", "r2", "object", "put", `${bucket}/${key}`, `--file=${filePath}`, "--remote"],
      { stdio: "inherit", shell: process.platform === "win32" }
    );
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler r2 object put ${key} exited ${code}`))));
  });
}

/** Best-effort read of `r2_buckets[0].bucket_name` out of `wrangler.jsonc`,
 * for the CLI-fallback upload path -- avoids hardcoding the bucket name in
 * two places. Falls back to the literal `wrangler.jsonc` currently ships
 * (`comfyfed-store`) if the file can't be read/parsed (JSONC comments are
 * stripped with a simple line-comment regex, good enough for this file's
 * shape -- not a general JSONC parser). */
async function readBucketNameFromWrangler() {
  try {
    const wranglerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc");
    const raw = await readFile(wranglerPath, "utf8");
    const stripped = raw.replace(/^\s*\/\/.*$/gm, "");
    const parsed = JSON.parse(stripped);
    return parsed?.r2_buckets?.[0]?.bucket_name ?? null;
  } catch {
    return null;
  }
}

async function uploadDirectory(dir, prefix) {
  const names = (await readdir(dir)).sort();
  const s3Creds = getS3CredsFromEnv();

  if (s3Creds) {
    console.log(`Uploading ${names.length} files via the R2 S3 API (concurrency ${S3_CONCURRENCY}) ...`);
    await mapWithConcurrency(names, S3_CONCURRENCY, async (name) => {
      const body = await readFile(path.join(dir, name));
      await s3PutObject(s3Creds, `${prefix}${name}`, body);
    });
    return;
  }

  console.warn(
    "seed-official: R2_S3_ACCOUNT_ID/R2_S3_ACCESS_KEY_ID/R2_S3_SECRET_ACCESS_KEY/R2_S3_BUCKET are not all set -- " +
      "falling back to `wrangler r2 object put`, one CLI invocation per file. This is SLOW for a full official-" +
      "library sync (~1376 files); set the four R2_S3_* env vars to use the fast S3-API path instead."
  );
  const bucket = process.env.R2_BUCKET_NAME || (await readBucketNameFromWrangler()) || "comfyfed-store";
  console.log(`Uploading ${names.length} files via wrangler CLI to bucket "${bucket}" (concurrency ${WRANGLER_CONCURRENCY}) ...`);
  await mapWithConcurrency(names, WRANGLER_CONCURRENCY, (name) => wranglerPut(bucket, `${prefix}${name}`, path.join(dir, name)));
}

async function main() {
  const version = process.argv[2] || process.env.SEED_OFFICIAL_VERSION || null;
  const metaUrl = version
    ? `https://pypi.org/pypi/${META_PACKAGE}/${version}/json`
    : `https://pypi.org/pypi/${META_PACKAGE}/json`;

  console.log(`Fetching ${metaUrl} ...`);
  const meta = await getJson(metaUrl);
  const info = meta.info ?? {};
  const metaVersion = version || info.version;
  if (!metaVersion) throw new Error(`${META_PACKAGE}: PyPI response has no resolvable version.`);

  const packages = parseSubPackages(info.requires_dist ?? []);
  if (Object.keys(packages).length === 0) {
    throw new Error(`${META_PACKAGE} ${metaVersion} lists no template sub-packages to fetch.`);
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "seed-official-extract-"));
  let totalFiles = 0;

  try {
    for (const [name, pkgVersion] of Object.entries(packages)) {
      console.log(`Fetching ${name}==${pkgVersion} ...`);
      const packageJson = await getJson(`https://pypi.org/pypi/${name}/${pkgVersion}/json`);
      const { url, sha256: expectedSha256 } = wheelUrlAndSha256(packageJson);

      const { filePath, dir: dlDir, sha256: actualSha256 } = await downloadToTemp(url, MAX_WHEEL_BYTES);
      try {
        if (actualSha256 !== expectedSha256) {
          throw new Error(`sha256 mismatch for ${name}==${pkgVersion}: expected ${expectedSha256}, got ${actualSha256}`);
        }

        const wheelBuffer = await readFile(filePath);
        const files = extractTemplateFiles(wheelBuffer, (msg) => console.warn(`seed-official: ${name}==${pkgVersion}: ${msg}`));
        for (const [basename, data] of files) {
          await writeFile(path.join(workDir, basename), data);
        }
        totalFiles += files.size;
        console.log(`  extracted ${files.size} files from ${name}==${pkgVersion}`);
      } finally {
        await rm(dlDir, { recursive: true, force: true });
      }
    }

    if (totalFiles === 0) {
      throw new Error("No template files found in any fetched sub-package wheel.");
    }

    const manifest = {
      meta_version: metaVersion,
      packages,
      files: totalFiles,
      fetched_at: new Date().toISOString(),
    };
    await writeFile(path.join(workDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2), "utf8");

    await uploadDirectory(workDir, R2_PREFIX);
    console.log(`Done: ${totalFiles} template files + manifest.json uploaded under "${R2_PREFIX}".`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// Only run when invoked directly (`node seed-official.mjs`), never on
// import -- irrelevant in practice (nothing imports this file; tests import
// `seed-official-lib.mjs` instead) but kept as a safe, standard guard.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
