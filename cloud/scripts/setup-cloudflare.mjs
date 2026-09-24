#!/usr/bin/env node
/**
 * One-command Cloudflare setup (spec `2026-09-24-single-stack-selfhost-and-
 * remote-update.md` §4): everything cloud/README.md used to walk through by
 * hand -- login, D1, R2, wrangler.jsonc's database_id, secrets, build,
 * deploy -- in one idempotent run.
 *
 *   npm run setup:cloudflare            # interactive
 *   npm run setup:cloudflare -- --yes   # keep existing secrets, no prompts
 *
 * Re-running is safe: an existing database/bucket is reused, existing
 * secrets are kept unless you say otherwise, and the deploy is just a
 * redeploy. Nothing here talks to Cloudflare except through `wrangler`, so
 * whatever account `wrangler login` picked is what gets used.
 */

import { readFile, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLOUD_DIR = path.join(HERE, "..");
const WRANGLER_CONFIG = path.join(CLOUD_DIR, "wrangler.jsonc");
const DEFAULT_DB_NAME = "comfyfed";
const DEFAULT_BUCKET = "comfyfed-store";
const SECRET_NAMES = ["SETUP_TOKEN", "PLATFORM_ED25519_SEED"];

function log(msg) {
  console.log(`[setup] ${msg}`);
}

// --- process helpers -----------------------------------------------------------

/** Runs wrangler, returning combined stdout+stderr. Never inherits stdin
 * unless asked (`wrangler login` needs the terminal). */
function wrangler(args, { input, inherit = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("npx", ["wrangler", ...args], {
      cwd: CLOUD_DIR,
      shell: process.platform === "win32",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: inherit ? "inherit" : ["pipe", "pipe", "pipe"],
    });
    let out = "";
    if (!inherit) {
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      if (input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    }
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, out }));
  });
}

function npm(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, { cwd: CLOUD_DIR, shell: process.platform === "win32", stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm ${args.join(" ")} exited ${code}`))));
  });
}

// --- steps ---------------------------------------------------------------------

async function ensureLoggedIn() {
  const { out } = await wrangler(["whoami"]);
  if (/not authenticated|not logged in/i.test(out)) {
    log("not logged in to Cloudflare -- opening the browser for `wrangler login` ...");
    const { code } = await wrangler(["login"], { inherit: true });
    if (code !== 0) throw new Error("wrangler login failed");
  } else {
    const account = /Account Name.*?│\s*([^│]+?)\s*│/s.exec(out)?.[1] ?? "(account)";
    log(`logged in as ${account.trim()}`);
  }
}

/** `d1 create`, or look the id up when the database already exists. */
export function parseDatabaseId(text) {
  return /database_id\W+([0-9a-f-]{36})/i.exec(text)?.[1] ?? null;
}

async function ensureDatabase(name) {
  const created = await wrangler(["d1", "create", name]);
  const fromCreate = parseDatabaseId(created.out);
  if (created.code === 0 && fromCreate) {
    log(`created D1 database ${name} (${fromCreate})`);
    return fromCreate;
  }
  const list = await wrangler(["d1", "list", "--json"]);
  if (list.code !== 0) throw new Error(`wrangler d1 list failed:\n${list.out}`);
  const jsonStart = list.out.indexOf("[");
  const rows = JSON.parse(list.out.slice(jsonStart));
  const row = rows.find((r) => r.name === name);
  if (!row) throw new Error(`D1 database ${name} could not be created or found:\n${created.out}`);
  log(`reusing D1 database ${name} (${row.uuid})`);
  return row.uuid;
}

/** Replace the `database_id` line in wrangler.jsonc, keeping every comment. */
export function patchDatabaseId(jsonc, id) {
  const re = /("database_id"\s*:\s*")[^"]*(")/;
  if (!re.test(jsonc)) throw new Error("wrangler.jsonc has no database_id field");
  return jsonc.replace(re, `$1${id}$2`);
}

async function writeDatabaseId(id) {
  const before = await readFile(WRANGLER_CONFIG, "utf8");
  const after = patchDatabaseId(before, id);
  if (after !== before) {
    await writeFile(WRANGLER_CONFIG, after);
    log(`wrote database_id into wrangler.jsonc -- commit this file if you use Workers Builds`);
  }
}

async function ensureBucket(name) {
  const { code, out } = await wrangler(["r2", "bucket", "create", name]);
  if (code === 0) log(`created R2 bucket ${name}`);
  else if (/already exists/i.test(out)) log(`reusing R2 bucket ${name}`);
  else throw new Error(`wrangler r2 bucket create failed:\n${out}`);
}

async function existingSecrets() {
  const { code, out } = await wrangler(["secret", "list"]);
  if (code !== 0) return new Set();
  const jsonStart = out.indexOf("[");
  if (jsonStart < 0) return new Set();
  try {
    return new Set(JSON.parse(out.slice(jsonStart)).map((s) => s.name));
  } catch {
    return new Set();
  }
}

async function putSecret(name, value) {
  const { code, out } = await wrangler(["secret", "put", name], { input: value });
  if (code !== 0) throw new Error(`wrangler secret put ${name} failed:\n${out}`);
}

async function ensureSecrets({ yes, ask }) {
  const have = await existingSecrets();
  const generated = {};
  for (const name of SECRET_NAMES) {
    if (have.has(name)) {
      const replace = yes ? false : await ask(`${name} is already set. Replace it with a new random value? [y/N] `);
      if (!replace) {
        log(`keeping existing ${name}`);
        continue;
      }
    }
    const value = randomBytes(32).toString("hex");
    await putSecret(name, value);
    generated[name] = value;
    log(`set ${name}`);
  }
  return generated;
}

export function parseDeployedUrl(text) {
  return /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(text)?.[0] ?? null;
}

async function buildAndDeploy({ skipBuild }) {
  if (!skipBuild) await npm(["run", "build"]);
  const { code, out } = await wrangler(["d1", "migrations", "apply", DEFAULT_DB_NAME, "--remote"]);
  process.stdout.write(out);
  if (code !== 0) throw new Error("d1 migrations apply failed");
  const deploy = await wrangler(["deploy"]);
  process.stdout.write(deploy.out);
  if (deploy.code !== 0) throw new Error("wrangler deploy failed");
  return parseDeployedUrl(deploy.out);
}

function summary({ url, generated }) {
  const lines = ["", `  部署完成 / Deployed: ${url ?? "(see the wrangler output above for the URL)"}`, ""];
  if (generated.SETUP_TOKEN) {
    lines.push(
      "  第一次設定 / First-time setup: 開啟上面的網址，輸入這個 setup token 並建立管理員密碼 /",
      "  open the URL above, enter this setup token and choose the admin password:",
      "",
      `      ${generated.SETUP_TOKEN}`,
      "",
      "  這個 token 只會顯示這一次。/ Shown once only."
    );
  } else {
    lines.push("  SETUP_TOKEN 沿用既有值 / kept the existing SETUP_TOKEN (use it on the setup screen if this is a fresh database).");
  }
  lines.push(
    "",
    "  接 GitHub 自動部署 / To deploy on every push: commit cloud/wrangler.jsonc, then in the Cloudflare",
    "  dashboard → Workers & Pages → your Worker → Settings → Builds, connect the repo with",
    "  root `cloud/`, build `npm run ci-build`, deploy `npm run deploy`.",
    ""
  );
  return lines.join("\n");
}

// --- main ----------------------------------------------------------------------

export async function main(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      yes: { type: "boolean", default: false },
      "db-name": { type: "string", default: DEFAULT_DB_NAME },
      bucket: { type: "string", default: DEFAULT_BUCKET },
      "skip-build": { type: "boolean", default: false },
    },
    strict: true,
  });
  const rl = values.yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q) => (rl ? /^y(es)?$/i.test((await rl.question(q)).trim()) : false);
  try {
    await ensureLoggedIn();
    const dbId = await ensureDatabase(values["db-name"]);
    await writeDatabaseId(dbId);
    await ensureBucket(values.bucket);
    const generated = await ensureSecrets({ yes: values.yes, ask });
    const url = await buildAndDeploy({ skipBuild: values["skip-build"] });
    console.log(summary({ url, generated }));
  } finally {
    rl?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
