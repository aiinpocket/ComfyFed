/**
 * `/api/workers/*` and `/api/agent/*` -- parity source:
 * `server/comfyfed_server/workers.py`, read in full.
 *
 * Routes ported: `POST /api/workers/tokens` (issue a register token, admin),
 * `POST /api/agent/register` (claim a token, mint a worker + Ed25519
 * certificate), `POST /api/agent/ping` and `POST /api/agent/object_info`
 * (signed agent requests -- see `lib/verify_agent.ts`), `GET /api/workers`
 * (console listing, admin), `GET /api/agent/version`, `POST
 * /api/workers/{id}/disable` (admin).
 *
 * NOT ported -- confirmed absent from workers.py, not a parity gap:
 *  - Any `enable`/`delete` worker route. The Python module has exactly one
 *    worker-mutation route below `disable`; there is no re-enable or
 *    permanent-delete endpoint anywhere in the server (checked across
 *    agentws.py/comfyapi.py/dispatch.py/jobs.py/receipts.py too -- none
 *    define one). Nothing to port.
 *  - Register-token *expiry*. `db.RegisterToken` has no `expires_at`/TTL
 *    column and `issue_token` sets none -- a token is valid until used, full
 *    stop. (The task brief mentions "expiry"; the actual source has none,
 *    same kind of brief/source mismatch Task 4 hit for the settings surface
 *    -- followed the source.)
 *  - `GET /api/agent/releases/{filename}` (agent wheel download from
 *    `data_dir/releases/`). Out of scope per this plan's pre-flight ruling:
 *    cloud v1 excludes operator-side release publishing/serving ("N1" in
 *    progress.md) -- `GET /api/agent/version` (ported below) still reports
 *    whatever `agent_wheel_url` settings row an operator points at an
 *    external location (e.g. a public R2 URL), it just isn't served through
 *    this Worker.
 *
 * `dynamic` (per-worker live state) is read straight off the persisted
 * `workers.dynamic` column here, exactly like `workers.py` does today (that
 * column is the only "dynamic" state that exists pre-Task-6) -- `getDynamic`
 * is a typed no-op seam Task 6 wires to the Hub DO for a currently-connected
 * worker's live state.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import {
  getSetting,
  resolvePlatformSeed,
  getAllWorkers,
  insertWorker,
  updateWorkerObjectInfoHash,
  setWorkerDisabled,
  getDynamic,
  insertRegisterToken,
  getRegisterToken,
  claimRegisterToken,
  toSqliteTimestamp,
  sqliteTimestampToIsoformat,
} from "../db/queries";
import { derivePublicKeyHexFromSeed } from "../lib/ed25519";
import { signRegistration } from "../lib/signing";
import { boundedGunzip, ObjectInfoTooLarge, InvalidGzip } from "../lib/gzip";
import { sha256Hex } from "../lib/hex";
import { bytesToBase64Url } from "../lib/base64";
import { verifyAgentRequest, type VerifyAgentResult } from "../lib/verify_agent";
import { requireAdmin, requireCsrf, errorJson } from "../lib/guard";

const PLATFORM_URL_KEY = "platform_url";

const OBJECT_INFO_DIR = "object_info";
const MAX_OBJECT_INFO_BYTES = 32 * 1024 * 1024;
const MAX_OBJECT_INFO_COMPRESSED_BYTES = 8 * 1024 * 1024;

const AGENT_VERSION_DEFAULT = "0.1.0";
const AGENT_LATEST_KEY = "agent_latest";
const AGENT_MIN_SUPPORTED_KEY = "agent_min_supported";
const AGENT_WHEEL_URL_KEY = "agent_wheel_url";
const AGENT_WHEEL_SHA256_KEY = "agent_wheel_sha256";
const AGENT_WHEEL_SIG_KEY = "agent_wheel_sig";

/** `secrets.token_urlsafe(24)`'s TS equivalent: 24 random bytes, base64url,
 * no padding (same alphabet/shape `lib/base64.ts`'s unpadded URL encoder
 * already produces). */
function generateRegisterToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return bytesToBase64Url(bytes);
}

function requestInfo(c: { req: { method: string; url: string } }): { path: string; query: string } {
  const url = new URL(c.req.url);
  return { path: url.pathname, query: url.search ? url.search.slice(1) : "" };
}

async function verifyAgent(
  c: { env: Env; req: { method: string; header: (name: string) => string | undefined; url: string } },
  body: Uint8Array
): Promise<VerifyAgentResult> {
  const { path, query } = requestInfo(c);
  return verifyAgentRequest(
    c.env.DB,
    {
      workerId: c.req.header("X-Worker-Id") ?? null,
      ts: c.req.header("X-Ts") ?? null,
      nonce: c.req.header("X-Nonce") ?? null,
      sig: c.req.header("X-Sig") ?? null,
    },
    { method: c.req.method, path, query, body }
  );
}

const app = new Hono<{ Bindings: Env }>();

// --- /api/workers/tokens ----------------------------------------------------

app.post("/api/workers/tokens", requireCsrf, async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as any);
  const name = typeof body.name === "string" ? body.name : "";

  const token = generateRegisterToken();
  await insertRegisterToken(c.env.DB, token, name, toSqliteTimestamp(new Date()));
  const platformUrl = (await getSetting(c.env.DB, PLATFORM_URL_KEY)) || "";
  const seed = await resolvePlatformSeed(c.env.DB, c.env.PLATFORM_ED25519_SEED);
  const platformPubkey = await derivePublicKeyHexFromSeed(seed);

  return c.json({
    bundle: {
      platform_url: platformUrl,
      platform_pubkey: platformPubkey,
      register_token: token,
    },
  });
});

// --- /api/agent/register -----------------------------------------------------

app.post("/api/agent/register", async (c) => {
  const body = await c.req.json<{ token?: unknown; name?: unknown; pubkey?: unknown }>().catch(() => ({}) as any);
  const token = typeof body.token === "string" ? body.token : "";
  const name = typeof body.name === "string" ? body.name : "";
  const pubkey = typeof body.pubkey === "string" ? body.pubkey : "";

  const tokenRow = await getRegisterToken(c.env.DB, token);
  if (tokenRow === null) {
    return errorJson(c, 401, "register.token_invalid", "Unknown register token.");
  }

  const workerName = name || tokenRow.workerName;

  const claimed = await claimRegisterToken(c.env.DB, token);
  if (!claimed) {
    return errorJson(c, 409, "register.token_used", "Register token already used.");
  }

  const workerId = crypto.randomUUID();
  await insertWorker(c.env.DB, workerId, workerName, pubkey, toSqliteTimestamp(new Date()));

  const seed = await resolvePlatformSeed(c.env.DB, c.env.PLATFORM_ED25519_SEED);
  const { signatureHex } = await signRegistration(seed, workerId, pubkey);

  return c.json({ worker_id: workerId, certificate: signatureHex });
});

// --- /api/agent/ping ----------------------------------------------------------

app.post("/api/agent/ping", async (c) => {
  const body = new Uint8Array(await c.req.arrayBuffer());
  const outcome = await verifyAgent(c, body);
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);
  return c.json({ ok: true });
});

// --- /api/agent/object_info ---------------------------------------------------

app.post("/api/agent/object_info", async (c) => {
  // Declared as the FIRST check (before reading the body at all), on
  // purpose: verifying the signature requires buffering the whole body, so
  // a Content-Length check is the only point an oversized upload can still
  // be refused without ever reading it. See workers.py's
  // `limit_object_info_upload` docstring -- same reasoning, ported.
  const rawLength = c.req.header("content-length");
  if (rawLength !== undefined) {
    const length = Number.parseInt(rawLength, 10);
    if (!Number.isFinite(length) || !/^\d+$/.test(rawLength.trim())) {
      return errorJson(c, 400, "agent.bad_object_info", "Invalid Content-Length.");
    }
    if (length > MAX_OBJECT_INFO_COMPRESSED_BYTES) {
      return errorJson(
        c,
        413,
        "agent.object_info_too_large",
        "Compressed object_info exceeds the upload size limit."
      );
    }
  }

  const body = new Uint8Array(await c.req.arrayBuffer());

  const outcome = await verifyAgent(c, body);
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);
  const worker = outcome.worker;

  const oiHash = c.req.header("X-OI-Hash");
  if (!oiHash) {
    return errorJson(c, 400, "agent.bad_object_info", "Missing X-OI-Hash header.");
  }

  // A chunked upload has no Content-Length for the check above to catch;
  // the actual size is re-checked here against the already-buffered body,
  // same as workers.py's route body re-check.
  if (body.length > MAX_OBJECT_INFO_COMPRESSED_BYTES) {
    return errorJson(c, 413, "agent.object_info_too_large", "Compressed object_info exceeds the upload size limit.");
  }

  let decompressed: Uint8Array;
  try {
    decompressed = await boundedGunzip(body, MAX_OBJECT_INFO_BYTES);
  } catch (err) {
    if (err instanceof ObjectInfoTooLarge) {
      return errorJson(
        c,
        413,
        "agent.object_info_too_large",
        "Decompressed object_info exceeds the size limit."
      );
    }
    if (err instanceof InvalidGzip) {
      return errorJson(c, 400, "agent.bad_object_info", "Invalid gzip payload.");
    }
    throw err;
  }

  try {
    // `fatal: true` matches Python's implicit strict-UTF-8 decode inside
    // `json.loads(bytes)` (a `UnicodeDecodeError` there is a `ValueError`
    // subclass, so it's caught by the same `except (TypeError, ValueError)`
    // that catches a plain JSON syntax error).
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decompressed);
    JSON.parse(text);
  } catch {
    return errorJson(c, 400, "agent.bad_object_info", "Payload is not valid JSON.");
  }

  const actualHash = await sha256Hex(decompressed);
  if (actualHash !== oiHash) {
    return errorJson(c, 400, "agent.bad_object_info", "X-OI-Hash does not match the payload.");
  }

  // `worker.id` comes from the signature-verified worker, never anything
  // client-supplied, so the stored key can't be steered to another
  // worker's object -- same invariant workers.py calls out for its path.
  await c.env.STORE.put(`${OBJECT_INFO_DIR}/${worker.id}.json.gz`, body);
  await updateWorkerObjectInfoHash(c.env.DB, worker.id, actualHash);

  return c.json({ ok: true });
});

// --- GET /api/workers ---------------------------------------------------------

app.get("/api/workers", requireAdmin, async (c) => {
  const workers = await getAllWorkers(c.env.DB);
  const rows = await Promise.all(
    workers.map(async (w) => ({
      id: w.id,
      name: w.name,
      status: w.status,
      last_seen: w.lastSeen ? sqliteTimestampToIsoformat(w.lastSeen) : null,
      disabled: w.disabled,
      hardware: w.hardware,
      dynamic: (await getDynamic(c.env.HUB, w.id)) ?? w.dynamic,
      backend: w.backend,
      torch_version: w.torchVersion,
      model_count: w.modelInventory.length,
    }))
  );
  return c.json(rows);
});

// --- GET /api/agent/version ----------------------------------------------------

app.get("/api/agent/version", async (c) => {
  const setting = async (key: string, fallback: string | null) => (await getSetting(c.env.DB, key)) ?? fallback;
  return c.json({
    latest: await setting(AGENT_LATEST_KEY, AGENT_VERSION_DEFAULT),
    min_supported: await setting(AGENT_MIN_SUPPORTED_KEY, AGENT_VERSION_DEFAULT),
    wheel_url: await setting(AGENT_WHEEL_URL_KEY, null),
    sha256: await setting(AGENT_WHEEL_SHA256_KEY, null),
    platform_sig: await setting(AGENT_WHEEL_SIG_KEY, null),
  });
});

// --- POST /api/workers/{id}/disable --------------------------------------------

app.post("/api/workers/:workerId/disable", requireCsrf, async (c) => {
  const workerId = c.req.param("workerId");
  const found = await setWorkerDisabled(c.env.DB, workerId, true);
  if (!found) {
    return errorJson(c, 404, "workers.not_found", "Worker not found.");
  }
  return c.json({ ok: true });
});

export default app;
