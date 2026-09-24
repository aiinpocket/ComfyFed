#!/usr/bin/env node
/**
 * Produces everything `selfhost.mjs` needs to run the platform on one
 * machine WITHOUT Cloudflare (spec `2026-09-24-single-stack-selfhost-and-
 * remote-update.md` §3) -- the same Worker, same assets, same migrations,
 * executed by Miniflare (Cloudflare's own `workerd` wrapper) instead of the
 * Cloudflare edge:
 *
 *   dist-selfhost/index.js              the production bundle `wrangler
 *                                       deploy --dry-run` emits (esbuild,
 *                                       identical to what gets deployed)
 *   dist-selfhost/worker-options.json   the binding/compat/asset-routing
 *                                       config wrangler derives from
 *                                       wrangler.jsonc, so the runtime does
 *                                       not have to parse JSONC or depend
 *                                       on wrangler at all
 *   dist-selfhost/migrations.json       `migrations/*.sql` split into
 *                                       statements the same way `wrangler
 *                                       d1 migrations apply` does
 *
 * `assets/` (the console, installer templates, template library, agent
 * wheel) is built by `build.mjs` first when missing. Run via
 * `npm run build:selfhost`; `selfhost.mjs` calls this itself when the
 * bundle is absent.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.join(HERE, "..");
const ASSETS_DIR = path.join(CLOUD_DIR, "assets");
const MIGRATIONS_DIR = path.join(CLOUD_DIR, "migrations");
const DIST_DIR = path.join(CLOUD_DIR, "dist-selfhost");
const WRANGLER_CONFIG = path.join(CLOUD_DIR, "wrangler.jsonc");

function log(msg) {
  console.log(`[selfhost-build] ${msg}`);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32", cwd: CLOUD_DIR, ...opts });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))));
  });
}

async function ensureAssets() {
  if (await exists(path.join(ASSETS_DIR, "index.html"))) return;
  log("assets/ missing -- running build.mjs first ...");
  await run(process.execPath, [path.join(HERE, "build.mjs"), ...(process.env.SKIP_COMFY_FETCH ? ["--skip-comfy"] : [])]);
}

/** `wrangler deploy --dry-run --outdir dist-selfhost` -- the real
 * production bundle, no Cloudflare account needed. */
async function bundleWorker() {
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });
  await run("npx", ["wrangler", "deploy", "--dry-run", "--outdir", DIST_DIR], {
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  if (!(await exists(path.join(DIST_DIR, "index.js")))) {
    throw new Error("wrangler dry-run produced no dist-selfhost/index.js");
  }
}

/** The Miniflare-relevant subset of what wrangler derives from
 * wrangler.jsonc. Paths are made relative to cloud/ so the JSON is portable
 * (Docker copies the tree to a different absolute location). */
async function writeWorkerOptions() {
  const { unstable_getMiniflareWorkerOptions } = await import("wrangler");
  const { workerOptions } = unstable_getMiniflareWorkerOptions(WRANGLER_CONFIG);
  const assets = workerOptions.assets ?? {};
  const options = {
    compatibilityDate: workerOptions.compatibilityDate,
    compatibilityFlags: workerOptions.compatibilityFlags ?? [],
    d1Databases: Object.keys(workerOptions.d1Databases ?? {}),
    r2Buckets: Object.keys(workerOptions.r2Buckets ?? {}),
    durableObjects: workerOptions.durableObjects ?? {},
    assets: {
      binding: assets.binding ?? "ASSETS",
      directory: path.relative(CLOUD_DIR, assets.directory ?? ASSETS_DIR),
      run_worker_first: assets.run_worker_first ?? [],
      routerConfig: assets.routerConfig ?? {},
      assetConfig: assets.assetConfig ?? {},
    },
  };
  await writeFile(path.join(DIST_DIR, "worker-options.json"), JSON.stringify(options, null, 2) + "\n");
  return options;
}

/** Same split `wrangler d1 migrations apply` uses, so a statement that
 * works there works here. */
async function writeMigrations() {
  const { unstable_splitSqlQuery } = await import("wrangler");
  const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith(".sql")).sort();
  const migrations = [];
  for (const name of names) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, name), "utf8");
    migrations.push({ name, statements: unstable_splitSqlQuery(sql) });
  }
  await writeFile(path.join(DIST_DIR, "migrations.json"), JSON.stringify(migrations, null, 2) + "\n");
  return migrations;
}

export async function buildSelfhost() {
  await ensureAssets();
  await bundleWorker();
  const options = await writeWorkerOptions();
  const migrations = await writeMigrations();
  log(
    `done: dist-selfhost/index.js, worker-options.json (compat ${options.compatibilityDate}), migrations.json (${migrations.length} files)`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildSelfhost().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
