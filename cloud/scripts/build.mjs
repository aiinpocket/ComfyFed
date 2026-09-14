#!/usr/bin/env node
/**
 * Builds `cloud/assets/` -- the directory `wrangler.jsonc`'s `assets`
 * binding serves (`ASSETS`, with `not_found_handling:
 * "single-page-application"`, `run_worker_first` covering `/comfy(/*)` and
 * `/api/*`). Run via `npm run build` (or `npm run ci-build` for a clean-
 * checkout run) from `cloud/`. `assets/` itself is a build artifact --
 * gitignored at the repo root, never committed.
 *
 * Idempotent: safe to re-run; each step wipes and rewrites only the
 * subdirectory it owns (`assets/` root files from the console build,
 * `assets/comfy/`, `assets/comfyfed_templates/`) rather than assuming a
 * clean starting point.
 *
 * Three pieces, matching `routes/templates.ts`'s and index.ts/gate.ts's
 * expectations of what lives under `assets/`:
 *
 *   (a) **Console** (`../web`) -- `npm ci --prefix ../web` (only if
 *       `../web/node_modules` is missing -- a developer who already has it
 *       installed, or CI that restores it from cache, shouldn't pay for a
 *       fresh install on every build) then `npm run build --prefix ../web`,
 *       then `web/dist/*` is copied to `assets/` **root** -- the console is
 *       the site root (`/`), not a subpath, per progress.md's/task-11's
 *       ruling; `not_found_handling: "single-page-application"` falls back
 *       to `assets/index.html` for any unmatched path.
 *
 *   (b) **Embedded ComfyUI panel** (`assets/comfy/`) -- the SAME pinned
 *       `comfyui-frontend-package` version + sha256 as
 *       `server/comfyfed_server/comfy_frontend.py`'s `FRONTEND_VERSION` /
 *       `FRONTEND_SHA256` constants (kept in sync manually -- see this
 *       file's own constants below, and bump both files together). Skipped
 *       when `SKIP_COMFY_FETCH=1` env or `--skip-comfy` CLI flag is set, so
 *       CI (and a fast local edit-test loop) need not pay for the ~93MB
 *       download every run; `routes/comfyapi.ts`/index.ts's gate degrade
 *       gracefully to whatever `assets/comfy/` already has (nothing, on a
 *       skipped fresh checkout) exactly like Python's `is_populated` check.
 *       `.map` files are dropped (see `build-lib.mjs`'s docstring).
 *
 *   (c) **ComfyFed's own template library** (`assets/comfyfed_templates/`)
 *       -- a flat copy of `server/comfyfed_server/templates_data/`, which
 *       `routes/templates.ts`'s `fetchPackagedRaw` reads via
 *       `env.ASSETS.fetch("/comfyfed_templates/<name>")` (falling back to
 *       R2 if that 404s -- see Task 10's report). Pure file copy, no
 *       transformation: Python serves the exact same directory as static
 *       files at the same relative shape.
 *
 *   (d) **One-line installer scripts** (`assets/install-templates/`) -- a
 *       flat, BINARY-FAITHFUL copy of `server/comfyfed_server/installers/`
 *       (`install.ps1`, `install.sh`, `install.cmd`), which
 *       `routes/installer.ts` reads via
 *       `env.ASSETS.fetch("/install-templates/<name>")` (see that file's
 *       docstring). `fs.cp` copies raw bytes with no encoding pass, so
 *       `install.ps1`'s UTF-8 BOM and `install.sh`'s LF-only line endings
 *       survive the copy exactly as `installer_routes.py`'s single source of
 *       truth stores them -- `routes/installer.ts` (not this script) is
 *       what normalizes/strips at serve time, mirroring the Python module.
 */

import { spawn } from "node:child_process";
import { mkdir, rm, stat, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { extractFrontendStatic, sha256Hex, totalBytes } from "./build-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.join(HERE, "..");
const WEB_DIR = path.join(CLOUD_DIR, "..", "web");
const TEMPLATES_DATA_DIR = path.join(CLOUD_DIR, "..", "server", "comfyfed_server", "templates_data");
const INSTALLERS_SRC_DIR = path.join(CLOUD_DIR, "..", "server", "comfyfed_server", "installers");
const ASSETS_DIR = path.join(CLOUD_DIR, "assets");
const COMFY_ASSETS_DIR = path.join(ASSETS_DIR, "comfy");
const TEMPLATES_ASSETS_DIR = path.join(ASSETS_DIR, "comfyfed_templates");
const INSTALL_TEMPLATES_ASSETS_DIR = path.join(ASSETS_DIR, "install-templates");

// Keep in sync with server/comfyfed_server/comfy_frontend.py's
// `FRONTEND_VERSION` / `FRONTEND_SHA256` -- SAME pinned wheel, same digest.
// Bump both files together when the panel version changes.
const FRONTEND_VERSION = "1.52.7";
const FRONTEND_SHA256 = "3aa5624fa5085f8461d31b7eb88a42ed69a0e783a35bec1c2a33b90fc7660950";
const PYPI_JSON_URL = "https://pypi.org/pypi/comfyui-frontend-package/json";
const STATIC_PREFIX = "comfyui_frontend_package/static/";
const MAX_WHEEL_BYTES = 512 * 1024 * 1024;

function log(msg) {
  console.log(`[build] ${msg}`);
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: "inherit",
      shell: process.platform === "win32",
      ...opts,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}`))
    );
  });
}

async function countFiles(dir) {
  let count = 0;
  let bytes = 0;
  async function walk(d) {
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        count++;
        bytes += (await stat(full)).size;
      }
    }
  }
  if (await exists(dir)) await walk(dir);
  return { count, bytes };
}

// --- (a) console --------------------------------------------------------

async function buildConsole() {
  log("Building console (../web) ...");
  const webNodeModules = path.join(WEB_DIR, "node_modules");
  if (!(await exists(webNodeModules))) {
    log("../web/node_modules missing -- running npm ci --prefix ../web ...");
    await run("npm", ["ci", "--prefix", WEB_DIR]);
  }
  await run("npm", ["run", "build", "--prefix", WEB_DIR]);

  const dist = path.join(WEB_DIR, "dist");
  if (!(await exists(path.join(dist, "index.html")))) {
    throw new Error(`../web build produced no dist/index.html at ${dist}`);
  }

  await mkdir(ASSETS_DIR, { recursive: true });
  await cp(dist, ASSETS_DIR, { recursive: true, force: true });

  const { count, bytes } = await countFiles(ASSETS_DIR);
  log(`console: copied web/dist -> assets/ (${count} files so far, ${humanBytes(bytes)})`);
}

// --- (b) embedded ComfyUI panel -----------------------------------------

async function wheelUrl(version) {
  const res = await fetch(PYPI_JSON_URL);
  if (!res.ok) throw new Error(`PyPI index fetch failed: HTTP ${res.status}`);
  const index = await res.json();
  const files = index.releases?.[version];
  if (!files || files.length === 0) {
    throw new Error(`comfyui-frontend-package has no release ${version} on PyPI.`);
  }
  for (const entry of files) {
    if (entry.packagetype === "bdist_wheel" && entry.filename?.endsWith(".whl")) {
      return entry.url;
    }
  }
  throw new Error(`comfyui-frontend-package ${version} publishes no wheel.`);
}

async function downloadWheel(url) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${url} -> HTTP ${res.status}`);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_WHEEL_BYTES) {
      throw new Error(`Download exceeds ${Math.floor(MAX_WHEEL_BYTES / (1024 * 1024))} MB cap, aborted: ${url}`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function buildComfyFrontend({ skip }) {
  if (skip) {
    log("SKIP_COMFY_FETCH set (or --skip-comfy passed) -- leaving assets/comfy/ untouched.");
    return;
  }

  log(`Fetching comfyui-frontend-package ${FRONTEND_VERSION} wheel from PyPI ...`);
  const url = await wheelUrl(FRONTEND_VERSION);
  const wheelBuffer = await downloadWheel(url);

  const digest = sha256Hex(wheelBuffer);
  if (digest !== FRONTEND_SHA256) {
    throw new Error(
      `sha256 mismatch for comfyui-frontend-package ${FRONTEND_VERSION}: expected ${FRONTEND_SHA256}, got ${digest}. ` +
        "Refusing to extract an unverified wheel -- if the pin is being deliberately bumped, update BOTH this " +
        "file's FRONTEND_VERSION/FRONTEND_SHA256 and comfy_frontend.py's, from an actually-downloaded wheel."
    );
  }
  log(`Wheel verified (sha256 ${digest}, ${humanBytes(wheelBuffer.length)}).`);

  const files = extractFrontendStatic(wheelBuffer, STATIC_PREFIX);
  const droppedMapNote = "(.map files dropped)";

  await rm(COMFY_ASSETS_DIR, { recursive: true, force: true });
  await mkdir(COMFY_ASSETS_DIR, { recursive: true });
  for (const [relative, data] of files) {
    const target = path.join(COMFY_ASSETS_DIR, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  log(
    `comfy frontend: extracted ${files.size} files ${droppedMapNote}, ${humanBytes(totalBytes(files))} -> assets/comfy/`
  );
}

// --- (c) ComfyFed's own template library --------------------------------

async function buildTemplates() {
  if (!(await exists(TEMPLATES_DATA_DIR))) {
    throw new Error(`Templates source directory not found: ${TEMPLATES_DATA_DIR}`);
  }
  await rm(TEMPLATES_ASSETS_DIR, { recursive: true, force: true });
  await mkdir(TEMPLATES_ASSETS_DIR, { recursive: true });
  await cp(TEMPLATES_DATA_DIR, TEMPLATES_ASSETS_DIR, { recursive: true, force: true });

  const { count, bytes } = await countFiles(TEMPLATES_ASSETS_DIR);
  log(`templates: copied templates_data -> assets/comfyfed_templates/ (${count} files, ${humanBytes(bytes)})`);
}

// --- (d) one-line installer scripts --------------------------------------

async function buildInstallTemplates() {
  if (!(await exists(INSTALLERS_SRC_DIR))) {
    throw new Error(`Installer scripts source directory not found: ${INSTALLERS_SRC_DIR}`);
  }
  await rm(INSTALL_TEMPLATES_ASSETS_DIR, { recursive: true, force: true });
  await mkdir(INSTALL_TEMPLATES_ASSETS_DIR, { recursive: true });
  // `cp` (no transform) -- binary-faithful, preserving install.ps1's UTF-8
  // BOM and install.sh's LF-only endings exactly as checked in.
  await cp(INSTALLERS_SRC_DIR, INSTALL_TEMPLATES_ASSETS_DIR, { recursive: true, force: true });

  const { count, bytes } = await countFiles(INSTALL_TEMPLATES_ASSETS_DIR);
  log(`install templates: copied installers -> assets/install-templates/ (${count} files, ${humanBytes(bytes)})`);
}

// -------------------------------------------------------------------------

async function main() {
  const skipComfy =
    process.env.SKIP_COMFY_FETCH === "1" ||
    process.env.SKIP_COMFY_FETCH === "true" ||
    process.argv.includes("--skip-comfy");

  await buildConsole();
  await buildComfyFrontend({ skip: skipComfy });
  await buildTemplates();
  await buildInstallTemplates();

  const { count, bytes } = await countFiles(ASSETS_DIR);
  log(`Done: assets/ has ${count} files totaling ${humanBytes(bytes)}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
