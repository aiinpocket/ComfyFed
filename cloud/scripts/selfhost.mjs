#!/usr/bin/env node
/**
 * Self-hosted ComfyFed: run the SAME Worker that is deployed to Cloudflare
 * on one machine, with no Cloudflare account (spec `2026-09-24-single-
 * stack-selfhost-and-remote-update.md` §3).
 *
 *   npm run selfhost -- --data-dir ./data --port 8388 [--url https://fed.example.com]
 *
 * Miniflare (Cloudflare's own workerd wrapper -- what `wrangler dev` and the
 * vitest pool run) executes `dist-selfhost/index.js` with D1, R2 and the
 * Hub Durable Object persisted under `<data-dir>/state/`. There is exactly
 * one server implementation in this repo; this file only decides where it
 * runs.
 *
 * First run:
 *   - `<data-dir>/selfhost.json` (mode 0600) gets a random SETUP_TOKEN and
 *     PLATFORM_ED25519_SEED. The token is printed until the first admin
 *     account exists; the seed is the platform's signing identity -- back
 *     the file up with the data directory.
 *   - `migrations/*.sql` (pre-split into `dist-selfhost/migrations.json`)
 *     are applied and recorded in `d1_migrations`, the same table wrangler
 *     uses, so re-running is a no-op and later releases apply only what is
 *     new.
 *
 * Honest note: Cloudflare positions Miniflare as a development tool, not a
 * production product. For a friends-circle platform on one box it is the
 * cheapest way to have zero duplicated server code; it is not a substitute
 * for the Cloudflare edge at scale.
 */

import { Log, LogLevel, Miniflare, convertV4MiniflareOptions } from "miniflare";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.join(HERE, "..");
const DIST_DIR = path.join(CLOUD_DIR, "dist-selfhost");
const SECRETS_FILENAME = "selfhost.json";
const DEFAULT_PORT = 8388;
const DEFAULT_HOST = "0.0.0.0";
const PLATFORM_URL_KEY = "platform_url";

function log(msg) {
  console.log(`[selfhost] ${msg}`);
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// --- CLI ---------------------------------------------------------------------

export function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      "data-dir": { type: "string", default: "./data" },
      port: { type: "string", default: String(DEFAULT_PORT) },
      host: { type: "string", default: DEFAULT_HOST },
      url: { type: "string" },
      check: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`--port must be 1-65535, got ${values.port}`);
  }
  if (values.url !== undefined && !/^https?:\/\/[A-Za-z0-9.[\]:_-]+(\/[A-Za-z0-9._~/-]*)?$/.test(values.url)) {
    throw new Error(`--url must be an http(s) origin like https://fed.example.com, got ${values.url}`);
  }
  return {
    dataDir: path.resolve(values["data-dir"]),
    port,
    host: values.host,
    url: values.url?.replace(/\/+$/, ""),
    check: values.check,
    help: values.help,
  };
}

const USAGE = `ComfyFed self-host

  node scripts/selfhost.mjs [--data-dir ./data] [--port 8388] [--host 0.0.0.0]
                            [--url https://fed.example.com] [--check]

  --data-dir  where the database, uploads and secrets live (default ./data)
  --url       the public URL workers and browsers use; stored as platform_url
              the first time it is given (optional -- the request origin is
              used when unset)
  --check     start, hit /api/ping, and exit (smoke test)
`;

// --- build artefacts -----------------------------------------------------------

async function ensureBuilt() {
  const bundle = path.join(DIST_DIR, "index.js");
  const options = path.join(DIST_DIR, "worker-options.json");
  const migrations = path.join(DIST_DIR, "migrations.json");
  if ((await exists(bundle)) && (await exists(options)) && (await exists(migrations))) return;
  log("dist-selfhost/ missing -- building it (this needs the dev dependencies) ...");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(HERE, "build-selfhost.mjs")], { stdio: "inherit", cwd: CLOUD_DIR });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`build-selfhost.mjs exited ${code}`))));
  });
}

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

// --- secrets -------------------------------------------------------------------

/** `<data-dir>/selfhost.json`: created on first run, never rotated here. */
export async function loadOrCreateSecrets(dataDir) {
  const file = path.join(dataDir, SECRETS_FILENAME);
  if (await exists(file)) {
    const parsed = await readJson(file);
    if (typeof parsed.setup_token !== "string" || !/^[0-9a-f]{64}$/.test(parsed.platform_seed_hex ?? "")) {
      throw new Error(`${file} is malformed; restore it from backup or delete it to generate fresh secrets`);
    }
    return { secrets: parsed, created: false, file };
  }
  const secrets = {
    setup_token: randomBytes(32).toString("hex"),
    platform_seed_hex: randomBytes(32).toString("hex"),
    created_at: new Date().toISOString(),
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(secrets, null, 2) + "\n", { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
  return { secrets, created: true, file };
}

// --- migrations ----------------------------------------------------------------

const MIGRATIONS_TABLE_SQL =
  "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)";

/** Applies every migration not yet recorded, in name order. Returns the
 * names applied this run. */
export async function applyMigrations(db, migrations) {
  await db.prepare(MIGRATIONS_TABLE_SQL).run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all();
  const applied = new Set(results.map((r) => r.name));
  const done = [];
  for (const migration of [...migrations].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (applied.has(migration.name)) continue;
    const statements = migration.statements.map((s) => db.prepare(s));
    if (statements.length > 0) await db.batch(statements);
    await db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(migration.name).run();
    done.push(migration.name);
  }
  return done;
}

async function seedPlatformUrl(db, url) {
  if (!url) return;
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(PLATFORM_URL_KEY).first();
  if (row === null) {
    await db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").bind(PLATFORM_URL_KEY, url).run();
    log(`platform_url set to ${url}`);
  } else if (row.value !== url) {
    log(`platform_url is already ${row.value} (change it in the console's Settings page; --url only seeds a first value)`);
  }
}

async function setupNeeded(db) {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM users").first();
  return Number(row?.n ?? 0) === 0;
}

// --- miniflare -----------------------------------------------------------------

export function miniflareOptions({ host, port, dataDir, secrets, workerOptions, url }) {
  const assets = workerOptions.assets;
  return {
    host,
    port,
    log: new Log(LogLevel.INFO),
    // No `request.cf` lookup: Miniflare would otherwise fetch a real one
    // from Cloudflare and cache it under node_modules/.mf, which is neither
    // wanted offline nor writable in the container (non-root).
    cf: false,
    resourcePersistencePath: path.join(dataDir, "state"),
    modules: true,
    scriptPath: path.join(DIST_DIR, "index.js"),
    modulesRoot: DIST_DIR,
    compatibilityDate: workerOptions.compatibilityDate,
    compatibilityFlags: workerOptions.compatibilityFlags,
    bindings: {
      MODE: "selfhost",
      SETUP_TOKEN: secrets.setup_token,
      PLATFORM_ED25519_SEED: secrets.platform_seed_hex,
    },
    d1Databases: Object.fromEntries(workerOptions.d1Databases.map((name) => [name, name.toLowerCase()])),
    r2Buckets: Object.fromEntries(workerOptions.r2Buckets.map((name) => [name, name.toLowerCase()])),
    durableObjects: workerOptions.durableObjects,
    assets: {
      directory: path.resolve(CLOUD_DIR, assets.directory),
      binding: assets.binding,
      run_worker_first: assets.run_worker_first,
      routerConfig: assets.routerConfig,
      assetConfig: assets.assetConfig,
    },
    // Workers see `request.url` with the host they were reached on; when a
    // public URL is known, rewrite to it so cookies/origins match what the
    // browser sees behind a reverse proxy.
    ...(url ? { upstream: url } : {}),
  };
}

function banner({ host, port, url, setupToken, migrated }) {
  const local = `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  const lines = ["", `  ComfyFed self-host 已啟動 / is running: ${url ?? local}`];
  if (url) lines.push(`  （本機 / local: ${local}）`);
  if (migrated.length) lines.push(`  已套用 ${migrated.length} 個 migration / applied ${migrated.length} migration(s)`);
  if (setupToken) {
    lines.push(
      "",
      "  第一次設定 / First-time setup:",
      `    開啟上面的網址，輸入這個 setup token 並建立管理員密碼 /`,
      `    open the URL above, enter this setup token and choose the admin password:`,
      "",
      `      ${setupToken}`,
      "",
      "  （token 也存在 data 目錄的 selfhost.json；管理員建立後就不再需要。）",
      "  (also in selfhost.json under the data directory; not needed once the admin exists.)"
    );
  }
  lines.push("");
  return lines.join("\n");
}

// --- main ----------------------------------------------------------------------

export async function start(cli) {
  await ensureBuilt();
  const workerOptions = await readJson(path.join(DIST_DIR, "worker-options.json"));
  const migrations = await readJson(path.join(DIST_DIR, "migrations.json"));
  const { secrets, created, file } = await loadOrCreateSecrets(cli.dataDir);
  if (created) log(`generated secrets in ${file} -- back it up together with the data directory`);

  // `miniflareOptions` is written in the documented (v4-shaped) option
  // form; the pinned Miniflare 5 alpha takes a config-object form and
  // ships this converter (the vitest pool uses the same one).
  const mf = new Miniflare(convertV4MiniflareOptions(miniflareOptions({ ...cli, secrets, workerOptions })));
  await mf.ready;
  const db = await mf.getD1Database("DB");
  const migrated = await applyMigrations(db, migrations);
  await seedPlatformUrl(db, cli.url);
  const needsSetup = await setupNeeded(db);

  console.log(banner({ ...cli, setupToken: needsSetup ? secrets.setup_token : null, migrated }));
  return mf;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    console.log(USAGE);
    return;
  }
  const mf = await start(cli);
  if (cli.check) {
    const res = await mf.dispatchFetch("http://selfhost/api/ping");
    const body = await res.text();
    await mf.dispose();
    if (!res.ok) throw new Error(`/api/ping answered ${res.status}: ${body}`);
    log(`check ok: ${body.trim()}`);
    return;
  }
  const shutdown = async (signal) => {
    log(`${signal} -- shutting down`);
    await mf.dispose();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
