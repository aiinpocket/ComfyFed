/**
 * `/api/workers/*` and `/api/agent/*` -- ported from the former Python server
 * (2026-09); this file is now the only implementation.
 *
 * Routes ported: `POST /api/workers/tokens` (issue a register token, admin),
 * `POST /api/agent/register` (claim a token, mint a worker + Ed25519
 * certificate), `POST /api/agent/ping` and `POST /api/agent/object_info`
 * (signed agent requests -- see `lib/verify_agent.ts`), `GET /api/workers`
 * (console listing, admin), `GET /api/agent/version`, `POST
 * /api/workers/{id}/disable` (admin), `DELETE /api/workers/{id}` (admin soft
 * delete -- mirrors the former Python `delete_worker`).
 *
 * NOT ported -- the former Python server had no such endpoints either, not a
 * parity gap:
 *  - Any `enable` worker route. There is no re-enable (nor a HARD delete)
 *    endpoint anywhere in the former Python server (checked across its agentws/
 *    comfyapi/dispatch/jobs/receipts modules too -- none defined one). Nothing to
 *    port.
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
 * `workers.dynamic` column here, exactly like the former Python server did (that
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
  getWorkerById,
  insertWorker,
  updateWorkerObjectInfoHash,
  setWorkerDisabled,
  setWorkerDeleted,
  getDynamic,
  insertRegisterToken,
  getRegisterToken,
  claimRegisterToken,
  setSetting,
  toSqliteTimestamp,
  sqliteTimestampToIsoformat,
} from "../db/queries";
import { derivePublicKeyHexFromSeed } from "../lib/ed25519";
import { signRegistration, signRelease } from "../lib/signing";
import { boundedGunzip, ObjectInfoTooLarge, InvalidGzip } from "../lib/gzip";
import { sha256Hex } from "../lib/hex";
import { bytesToBase64Url } from "../lib/base64";
import { verifyAgentRequest, type VerifyAgentResult } from "../lib/verify_agent";
import { requireAdmin, requireCsrf, requireUser, errorJson, SESSION_VAR } from "../lib/guard";
import * as modelManifest from "../core/model_manifest";
import * as retry from "../core/retry";
import { ensureBundledAgentRelease } from "../core/agent_release";

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
  // be refused without ever reading it. Same reasoning as the former
  // Python `limit_object_info_upload`, ported.
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
  // same as the former Python route body re-check.
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
  // worker's object -- same invariant the former Python server called out for its path.
  await c.env.STORE.put(`${OBJECT_INFO_DIR}/${worker.id}.json.gz`, body);
  await updateWorkerObjectInfoHash(c.env.DB, worker.id, actualHash);

  return c.json({ ok: true });
});

// --- GET /api/workers ---------------------------------------------------------

app.get("/api/workers", requireUser, async (c) => {
  // The console compares each row's agent_version against
  // `/api/agent/version`; make sure a freshly deployed bundled release is
  // published before it does (core/agent_release.ts, once per isolate).
  await ensureBundledAgentRelease(c.env);
  const workers = await getAllWorkers(c.env.DB);
  const now = new Date();
  // final review I1：`unsuitable[].last_error` / `last_job_id` 是跨 job、跨使用
  // 者累積的自由文字與別人 job 的 id，只給 admin（見
  // `retry.unsuitableRowsForWorker` 的 docstring）。Parity with the former Python server.
  const isAdmin = c.get(SESSION_VAR).user.role === "admin";
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
      // Phase 3.1 P2P: set from the agent's `hello.peer_url` when peer_serve
      // is enabled and advertise_host is configured (see do/hub.ts's
      // handleHello / parsePeerUrl). Readable by any logged-in user now (see
      // requireUser above): workers are SHARED infrastructure, so a peer
      // address is fleet metadata, not per-user private data. Mutations
      // (token issue, disable, delete) stay admin-only on their own routes.
      peer_url: w.peerUrl,
      // Phase 3.4 §6: the console's P2P column renders the NAT mode, the LAN
      // address and a reachability badge from these three (parity:
      // the former Python `GET /api/workers`). Same "fleet metadata, not private
      // data" reasoning as `peer_url` above.
      peer_lan_url: w.peerLanUrl,
      peer_nat: w.peerNat,
      peer_reachable: w.peerReachable,
      // 2026-09-19 job-retry §8：這台 worker 在哪些「類」任務上翻過車。
      // `active` = 達門檻且未過 TTL（也就是真的在擋派工）；未達門檻或已過期
      // 的列照樣帶出來，Workers 頁畫成灰字 -- 管理員要看得到歷史才決定要不要
      // 手動清除。和 `peer_url` 同一個理由對任何登入使用者可讀：worker 是共用
      // 基礎設施，這是艦隊 metadata，不是誰的私人資料。清除才是 admin-only
      // （見下面兩條 DELETE）。Ports the former Python `GET /api/workers`.
      // `last_error` 與 `last_job_id` 兩欄是例外，只有 admin 拿得到值（I1）。
      unsuitable: await retry.unsuitableRowsForWorker(c.env.DB, w.id, now, isAdmin),
    }))
  );
  return c.json(rows);
});

// --- GET /api/agent/version ----------------------------------------------------

app.get("/api/agent/version", async (c) => {
  // A build ships its own agent wheel under assets/agent/; publish it (sign
  // + write the agent_* settings) the first time anyone asks this isolate.
  await ensureBundledAgentRelease(c.env);
  const setting = async (key: string, fallback: string | null) => (await getSetting(c.env.DB, key)) ?? fallback;
  // The publish route stores a RELATIVE wheel path ("/api/agent/releases/
  // <file>"). The agent's self-updater hands `wheel_url` straight to its
  // HTTP client, and a bare path is not a fetchable URL -- so every
  // in-place update ever attempted against this stack failed with
  // "Failed to download wheel" and the agent kept running its old build
  // (live-caught). Serve an ABSOLUTE URL: prefix the configured
  // platform_url, else this request's own origin. Older agents (whose
  // updater cannot join a relative path itself) are exactly the ones that
  // must be able to update, so this is the platform's job, not theirs.
  const storedWheelUrl = await setting(AGENT_WHEEL_URL_KEY, null);
  let wheelUrl: string | null = storedWheelUrl;
  if (wheelUrl && !/^https?:\/\//i.test(wheelUrl)) {
    const platformUrl = ((await setting("platform_url", null)) ?? new URL(c.req.url).origin).replace(/\/+$/, "");
    wheelUrl = platformUrl + (wheelUrl.startsWith("/") ? "" : "/") + wheelUrl;
  }
  return c.json({
    latest: await setting(AGENT_LATEST_KEY, AGENT_VERSION_DEFAULT),
    min_supported: await setting(AGENT_MIN_SUPPORTED_KEY, AGENT_VERSION_DEFAULT),
    wheel_url: wheelUrl,
    sha256: await setting(AGENT_WHEEL_SHA256_KEY, null),
    platform_sig: await setting(AGENT_WHEEL_SIG_KEY, null),
  });
});

// --- agent wheel releases (cloud parity of the former Python publish-agent) ---------
//
// `GET /api/agent/releases/{filename}` serves a published wheel from R2
// (`releases/<basename>`), unauthenticated like the Python route -- a fresh
// installer downloads the wheel before it has any credentials, and the
// integrity story is the sha256 + platform signature `/api/agent/version`
// advertises, not the transport. `POST /api/workers/agent-release`
// (admin+CSRF) is the cloud stand-in for the `comfyfed-server publish-agent`
// CLI: raw wheel bytes in the body, `?filename=` (basename, must end .whl),
// optional `?latest=`/`?min_supported=` overriding the version parsed from
// the filename (`comfyfed-<version>-py3-none-any.whl`). Stores the wheel,
// signs `{version}|{sha256}` with the platform key (signRelease, byte-parity
// with the former Python `publish_agent`), and writes the five `agent_*` settings that
// `GET /api/agent/version` serves.

const RELEASES_PREFIX = "releases/";

function wheelVersionFromFilename(filename: string): string | null {
  const m = /^[A-Za-z0-9_.]+-([0-9][A-Za-z0-9_.!+]*)-/.exec(filename);
  return m?.[1] ?? null;
}

// Same character class the filename parser above accepts for a version
// component -- used to sanity-check an explicit `?latest=`/`?min_supported=`
// override, which (unlike the filename) isn't otherwise constrained.
const VERSION_RE = /^[0-9][A-Za-z0-9_.!+]*$/;

/** Best-effort dotted-version compare (PEP 440-ish, not a full parser):
 * numeric segments compare numerically, non-numeric segments compare as
 * strings. Good enough to reject a `min_supported` above `latest` for the
 * versions this project actually publishes (e.g. "0.2.0"). */
function compareVersions(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const av = as[i] ?? "0";
    const bv = bs[i] ?? "0";
    const an = /^\d+$/.test(av) ? Number(av) : null;
    const bn = /^\d+$/.test(bv) ? Number(bv) : null;
    if (an !== null && bn !== null) {
      if (an !== bn) return an - bn;
    } else if (av !== bv) {
      return av < bv ? -1 : 1;
    }
  }
  return 0;
}

app.get("/api/agent/releases/:filename", async (c) => {
  const raw = c.req.param("filename");
  // Basename-only, mirroring the former Python os.path.basename guard; reject
  // separators and parent refs outright rather than normalizing them.
  if (!raw || raw.includes("/") || raw.includes("\\") || raw.includes("..")) {
    return errorJson(c, 404, "agent.release_not_found", "Release file not found.");
  }
  const obj = await c.env.STORE.get(RELEASES_PREFIX + raw);
  if (obj === null) {
    return errorJson(c, 404, "agent.release_not_found", "Release file not found.");
  }
  return new Response(obj.body, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(obj.size),
      "Content-Disposition": `attachment; filename="${raw}"`,
    },
  });
});

app.post("/api/workers/agent-release", requireCsrf, async (c) => {
  const filename = c.req.query("filename") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_.+-]*\.whl$/.test(filename)) {
    return errorJson(c, 400, "agent.bad_release_filename", "filename must be a .whl basename.");
  }
  const parsed = wheelVersionFromFilename(filename);
  const latestQuery = c.req.query("latest");
  const latest = latestQuery || parsed || null;
  if (!latest) {
    return errorJson(c, 400, "agent.bad_release_version", "Cannot parse a version from the filename; pass ?latest=.");
  }
  if (latestQuery && !VERSION_RE.test(latestQuery)) {
    return errorJson(c, 400, "agent.bad_release_version", "latest must be a sane version string.");
  }

  // OWNER POLICY: min_supported must NOT ratchet up automatically on every
  // publish -- someone who rarely boots their machine must never be locked
  // out just because releases happened. Default to whatever is currently
  // stored (i.e. leave it alone); an explicit `?min_supported=` still lets an
  // operator raise it deliberately for a genuine hard incompatibility. Only
  // when nothing has ever been published does it fall back to the default.
  const minSupportedQuery = c.req.query("min_supported");
  const storedMinSupported = await getSetting(c.env.DB, AGENT_MIN_SUPPORTED_KEY);
  const minSupported = minSupportedQuery || storedMinSupported || AGENT_VERSION_DEFAULT;
  if (minSupportedQuery && !VERSION_RE.test(minSupportedQuery)) {
    return errorJson(c, 400, "agent.bad_release_version", "min_supported must be a sane version string.");
  }
  if (compareVersions(minSupported, latest) > 0) {
    // A min_supported above latest would lock out every agent, including one
    // freshly updated to this very build.
    return errorJson(c, 400, "agent.min_supported_above_latest", "min_supported must not be greater than latest.");
  }

  const body = new Uint8Array(await c.req.arrayBuffer());
  if (body.byteLength === 0) {
    return errorJson(c, 400, "agent.empty_release", "Empty wheel body.");
  }
  const sha256 = await sha256Hex(body);
  await c.env.STORE.put(RELEASES_PREFIX + filename, body);

  const seed = await resolvePlatformSeed(c.env.DB, c.env.PLATFORM_ED25519_SEED);
  const { signatureHex: sig } = await signRelease(seed, latest, sha256);

  const wheelUrl = `/api/agent/releases/${filename}`;
  await setSetting(c.env.DB, AGENT_LATEST_KEY, latest);
  await setSetting(c.env.DB, AGENT_MIN_SUPPORTED_KEY, minSupported);
  await setSetting(c.env.DB, AGENT_WHEEL_URL_KEY, wheelUrl);
  await setSetting(c.env.DB, AGENT_WHEEL_SHA256_KEY, sha256);
  await setSetting(c.env.DB, AGENT_WHEEL_SIG_KEY, sig);

  return c.json({
    agent_latest: latest,
    agent_min_supported: minSupported,
    agent_wheel_url: wheelUrl,
    agent_wheel_sha256: sha256,
    agent_wheel_sig: sig,
  });
});

// --- /api/agent/manifest / /api/models/manifest (Phase 2.1 Task 7) -----------
//
// Both return `{entries: [...]}` from `model_manifest.entries()` -- the agent
// route (signed-agent auth) is also called internally by dispatch/auto-fetch
// code (`do/hub.ts`'s dispatch tick), not just over HTTP. A hash conflict is
// excluded via a plain SQL predicate (`queries.getAllModelHashes`'s
// `conflict = 0`), so this route (and every other caller) sees exactly the
// same exclusion the Hub DO sees, with no in-memory state to be missing.

app.get("/api/agent/manifest", async (c) => {
  const outcome = await verifyAgent(c, new Uint8Array());
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);

  const seed = await resolvePlatformSeed(c.env.DB, c.env.PLATFORM_ED25519_SEED);
  const entries = await modelManifest.entries(c.env.DB, c.env.STORE, seed);
  return c.json({ entries });
});

app.get("/api/models/manifest", requireAdmin, async (c) => {
  const seed = await resolvePlatformSeed(c.env.DB, c.env.PLATFORM_ED25519_SEED);
  const entries = await modelManifest.entries(c.env.DB, c.env.STORE, seed);
  return c.json({ entries });
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

// --- DELETE /api/workers/{id}/unsuitable[/{task_key}] ---------------------------
//
// 2026-09-19 job-retry §7：管理員的手動解除通道（自動解除是跑成功一次同類任
// 務，見 `do/hub.ts` 的 `clearUnsuitableForJob`）：換了顯卡、修好了驅動、或者
// 那兩次失敗根本是平台這邊的問題 -- 不該讓這台等滿七天的 TTL。
//
// 同一個 admin＋CSRF 閘門（`requireCsrf` 本身就掛在 admin 之下）跟 disable／
// delete 一樣。回 `{"cleared": n}`；已經是空的就是 `{"cleared": 0}`，不是 404
// -- 404 只保留給「沒有這台 worker」。Ports the former Python
// `clear_all_unsuitable` / `clear_one_unsuitable`.
//
// 兩條都註冊在下面的 `DELETE /api/workers/:workerId` 之前，讓比較長的路徑先
// 被看到。

/** 404 unless `workerId` names a LIVE worker -- soft-deleted reads as absent,
 * exactly like the Python route's `worker is None or worker.deleted`. */
async function isLiveWorker(db: D1Database, workerId: string): Promise<boolean> {
  return (await getWorkerById(db, workerId)) !== null;
}

app.delete("/api/workers/:workerId/unsuitable", requireCsrf, async (c) => {
  const workerId = c.req.param("workerId");
  if (!(await isLiveWorker(c.env.DB, workerId))) {
    return errorJson(c, 404, "workers.not_found", "Worker not found.");
  }
  const cleared = await retry.clearWorkerFailures(c.env.DB, workerId);
  return c.json({ cleared });
});

// `{.+}`：`task_key` 可能是 `model_fetch:<模型名>`，而模型名含目錄分隔
// （`loras/foo.safetensors`）-- 預設的路徑參數在第一個 `/` 就斷掉，那種 key
// 會永遠清不掉。Hono 的正規式參數是 FastAPI `{task_key:path}` 的等價物。
app.delete("/api/workers/:workerId/unsuitable/:taskKey{.+}", requireCsrf, async (c) => {
  const workerId = c.req.param("workerId");
  const taskKey = c.req.param("taskKey");
  if (!(await isLiveWorker(c.env.DB, workerId))) {
    return errorJson(c, 404, "workers.not_found", "Worker not found.");
  }
  const cleared = await retry.clearOneFailure(c.env.DB, workerId, taskKey);
  return c.json({ cleared });
});

// --- DELETE /api/workers/{id} ---------------------------------------------------
//
// Admin SOFT delete, parity with the former Python `delete_worker`. The row
// survives (receipts/jobs reference workers for the billing ledger, and
// `/api/reports/*` must keep resolving them by id); `deleted = 1` + `disabled
// = 1` is what makes the worker vanish from `GET /api/workers`, dispatch
// eligibility and `/metrics`, and makes the Hub DO refuse its next handshake.
// Same admin+CSRF gate as `disable` above (`requireCsrf` implies admin).

/** Fire-and-forget hop to the Hub DO to close a deleted worker's live agent
 * socket -- same pattern `routes/users.ts`'s `closePanelForUid` uses, for the
 * same reason (this route has no handle on the DO's sockets). Never throws: a
 * Hub hiccup must not fail a delete whose row change is already committed,
 * and the handshake gate alone still keeps the worker out for good. */
async function kickWorker(env: Env, workerId: string): Promise<void> {
  try {
    const stub = env.HUB.get(env.HUB.idFromName("hub"));
    await stub.fetch("http://hub.internal/internal/kick_worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: workerId }),
    });
  } catch (err) {
    console.warn("workers: failed to kick deleted worker", workerId, err);
  }
}

app.delete("/api/workers/:workerId", requireCsrf, async (c) => {
  const workerId = c.req.param("workerId");
  // Already-deleted is 404, identical to unknown: from the caller's point of
  // view the worker no longer exists (the `deleted = 0` predicate inside
  // `setWorkerDeleted` is what makes the second call a no-op).
  const deleted = await setWorkerDeleted(c.env.DB, workerId);
  if (!deleted) {
    return errorJson(c, 404, "workers.not_found", "Worker not found.");
  }
  await kickWorker(c.env, workerId);
  return c.json({ ok: true });
});

// --- POST /api/workers/{id}/update ----------------------------------------------
//
// 2026-09-24 single-stack spec §2.2：主控台的「立刻更新」。同一個 admin＋CSRF
// 閘門。先看該列 `hardware.agent_version`（agent 在 hello 回報的版本）：低於
// `REMOTE_UPDATE_MIN_AGENT` 的 agent 根本不認得 `update_agent` 這個 frame，送了
// 只會落進它的 unknown-message 路徑，所以直接 409 `workers.agent_too_old`，請
// 管理員在那台機器重啟一次 agent（啟動時的 `update.check` 會自己更新上來）。
// 版本夠新才轉呼叫 Hub DO 的 `/internal/update_worker`，DO 的 JSON 與狀態碼
// （409 `workers.offline`、200 `{status, detail}`）原樣回傳。

/** The first agent release that understands `update_agent` / `update_ack`. */
const REMOTE_UPDATE_MIN_AGENT = "0.1.18";

const AGENT_TOO_OLD_MESSAGE =
  "這台的 agent 太舊、不支援遠端更新：請在該機器重啟一次 agent，它會在啟動時自動更新 / " +
  "This worker's agent is too old to understand remote updates: restart the agent once on that machine and it will self-update at startup.";

/** `hardware.agent_version` as the agent reported it, or `null` when the
 * blob has none (a pre-0.1.17 agent, or a row that never said hello). */
function reportedAgentVersion(hardware: Record<string, unknown>): string | null {
  const version = hardware["agent_version"];
  return typeof version === "string" && version ? version : null;
}

function supportsRemoteUpdate(version: string | null): boolean {
  return version !== null && compareVersions(version, REMOTE_UPDATE_MIN_AGENT) >= 0;
}

/** The Hub DO hop (same stub pattern as `kickWorker`), relayed verbatim:
 * the DO already speaks the console's `{error: {code, message}}` /
 * `{status, detail}` shapes. Unlike `kickWorker`, a Hub failure IS the
 * result here -- there is no row change to protect, so it surfaces as 502. */
async function updateWorkerViaHub(env: Env, workerId: string): Promise<Response> {
  const stub = env.HUB.get(env.HUB.idFromName("hub"));
  return stub.fetch("http://hub.internal/internal/update_worker", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ worker_id: workerId }),
  });
}

app.post("/api/workers/:workerId/update", requireCsrf, async (c) => {
  const workerId = c.req.param("workerId");
  const worker = await getWorkerById(c.env.DB, workerId);
  if (!worker) {
    return errorJson(c, 404, "workers.not_found", "Worker not found.");
  }
  if (!supportsRemoteUpdate(reportedAgentVersion(worker.hardware))) {
    return errorJson(c, 409, "workers.agent_too_old", AGENT_TOO_OLD_MESSAGE);
  }
  try {
    const hubResponse = await updateWorkerViaHub(c.env, workerId);
    const body = await hubResponse.json<Record<string, unknown>>();
    return c.json(body, hubResponse.status as any);
  } catch (err) {
    console.error("workers: hub update_worker hop failed", workerId, err);
    return errorJson(c, 502, "workers.update_failed", "無法聯絡 Hub / Could not reach the hub.");
  }
});

export default app;
