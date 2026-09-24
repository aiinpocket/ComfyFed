/**
 * `/api/agent/peer-grant` + `/api/agent/peer-served` -- Phase 3.1 P2P grant
 * issuance and bandwidth booking. Ported from the former Python server's
 * `create_router` (2026-09); this file is now the only implementation.
 * Byte-parity requirements (grant signature format, response shape, error
 * codes) are pinned in the plan's Global Constraints.
 *
 * The grant book (`_grants` in Python) lives in D1 here (`p2p_grants` table,
 * migration 0007) rather than in-memory -- see `core/peer.ts`'s module
 * docstring for why. Atomic booking is a single `UPDATE ... WHERE booked = 0`
 * (`queries.claimP2pGrantBooked`), the D1-correct equivalent of the former Python
 * `_grant_lock`-guarded check-then-set: two concurrent `peer-served` calls
 * for the same grant_id can never both succeed.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import * as queries from "../db/queries";
import { toSqliteTimestamp, resolvePlatformSeed } from "../db/queries";
import * as peer from "../core/peer";
import { buildP2pUploadReceiptPayload } from "../lib/signing";
import { signHex } from "../lib/ed25519";
import { verifyAgentRequest, type VerifyAgentResult } from "../lib/verify_agent";
import { errorJson } from "../lib/guard";

function requestInfo(c: { req: { url: string } }): { path: string; query: string } {
  const url = new URL(c.req.url);
  return { path: url.pathname, query: url.search ? url.search.slice(1) : "" };
}

/** Duplicated from `routes/workers.ts`'s private `verifyAgent` (that
 * module's copy is not exported) -- both wrap `verifyAgentRequest` with this
 * route file's own `Env`-typed Hono context shape. */
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

interface PeerGrantBody {
  name?: unknown;
  size_bytes?: unknown;
}

app.post("/api/agent/peer-grant", async (c) => {
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
  const outcome = await verifyAgent(c, bodyBytes);
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);
  const worker = outcome.worker;

  let parsed: PeerGrantBody;
  try {
    parsed = bodyBytes.length > 0 ? JSON.parse(new TextDecoder().decode(bodyBytes)) : {};
  } catch {
    parsed = {};
  }
  const name = typeof parsed.name === "string" ? parsed.name : "";
  const sizeBytes = typeof parsed.size_bytes === "number" && Number.isInteger(parsed.size_bytes) ? parsed.size_bytes : NaN;

  const db = c.env.DB;
  const now = Date.now() / 1000;
  await queries.pruneExpiredP2pGrants(db, now);

  const hashRow = Number.isFinite(sizeBytes) ? await queries.getModelHash(db, name, sizeBytes) : null;
  if (hashRow === null || hashRow.conflict) {
    return errorJson(c, 404, "peer.no_model", "No consensus hash for this model.");
  }

  // Spec: the platform verifies the requester actually lacks the file before
  // handing out a grant for it (拉方確缺此檔) -- checked against the
  // requester's OWN reported inventory, same predicate `onlineSeeders` uses
  // for a candidate seeder.
  if (peer.workerHasConsensusFile(worker, name, sizeBytes, hashRow.sha256)) {
    return errorJson(c, 400, "peer.already_has_model", "You already have this model.");
  }

  const seeders = await peer.onlineSeeders(db, name, sizeBytes, {
    excludeWorkerId: worker.id,
    pullerRemoteIp: worker.remoteIp,
  });
  if (seeders.length === 0) {
    return errorJson(c, 404, "peer.no_seeder", "No online seeder for this model.");
  }

  const seeder = await peer.pickSeeder(db, seeders, now);

  const grantId = crypto.randomUUID().replace(/-/g, "");
  // TTL is sized for THIS seeder's own reported upload cap (parity:
  // the former Python server did the same with
  // `_seeder_rate_bytes_per_sec`).
  const expiresAt =
    Math.floor(now) + peer.grantTtlSeconds(sizeBytes, peer.seederRateBytesPerSec(seeder));
  const grant: peer.Grant = {
    grant_id: grantId,
    name,
    size_bytes: sizeBytes,
    sha256: hashRow.sha256,
    seeder_id: seeder.id,
    puller_id: worker.id,
    expires_at: expiresAt,
  };

  const seed = await resolvePlatformSeed(db, c.env.PLATFORM_ED25519_SEED);
  let sig: string;
  try {
    sig = await peer.signGrant(seed, grant);
  } catch (err) {
    // A field (in practice only `name`, an agent-reported path) contains
    // the payload delimiter -- refuse with the module's typed 400 rather
    // than let this escape as an unhandled 500.
    return errorJson(c, 400, "peer.invalid_field", err instanceof Error ? err.message : String(err));
  }

  await queries.insertP2pGrant(db, {
    grantId,
    name,
    sizeBytes,
    sha256: hashRow.sha256,
    seederId: seeder.id,
    pullerId: worker.id,
    expiresAt,
    createdAt: Math.floor(now),
  });

  const urls = peer.seederUrls(seeder, worker.remoteIp);
  return c.json({
    grant: { ...grant, sig },
    // 舊 agent 只看 `peer_url`，就是清單的第一個 —— 行為不變（spec §5）。
    peer_url: urls[0],
    seeder_urls: urls,
    chunk_sha256s: hashRow.chunkSha256s,
  });
});

interface PeerServedBody {
  grant_id?: unknown;
  bytes_served?: unknown;
}

app.post("/api/agent/peer-served", async (c) => {
  const bodyBytes = new Uint8Array(await c.req.arrayBuffer());
  const outcome = await verifyAgent(c, bodyBytes);
  if (!outcome.ok) return errorJson(c, outcome.status, outcome.code, outcome.message);
  const worker = outcome.worker;

  let parsed: PeerServedBody;
  try {
    parsed = bodyBytes.length > 0 ? JSON.parse(new TextDecoder().decode(bodyBytes)) : {};
  } catch {
    parsed = {};
  }
  const grantId = typeof parsed.grant_id === "string" ? parsed.grant_id : "";
  const bytesServed = typeof parsed.bytes_served === "number" && Number.isInteger(parsed.bytes_served) ? parsed.bytes_served : NaN;

  const db = c.env.DB;
  const now = Date.now() / 1000;
  await queries.pruneExpiredP2pGrants(db, now);

  const grant = await queries.getP2pGrant(db, grantId);
  if (grant === null) {
    return errorJson(c, 404, "peer.no_grant", "Grant not found or expired.");
  }
  if (grant.seederId !== worker.id) {
    return errorJson(c, 403, "peer.not_seeder", "Only the grant's seeder may report bandwidth served.");
  }
  if (!Number.isFinite(bytesServed) || bytesServed <= 0 || bytesServed > grant.sizeBytes * peer.BYTES_SERVED_SLACK) {
    return errorJson(c, 400, "peer.bad_bytes", "bytes_served is out of bounds for this grant.");
  }

  // Atomic claim: `claimP2pGrantBooked`'s `UPDATE ... WHERE booked = 0` is
  // the D1-correct equivalent of the former Python lock-guarded check-then-set --
  // whether the grant was already booked at the fetch above, or a
  // concurrent call claims it first, only one caller ever observes success.
  const claimed = await queries.claimP2pGrantBooked(db, grantId);
  if (!claimed) {
    return errorJson(c, 409, "peer.already_booked", "This grant has already been booked.");
  }

  try {
    const payload = buildP2pUploadReceiptPayload(grantId, worker.id, bytesServed);
    const seed = await resolvePlatformSeed(db, c.env.PLATFORM_ED25519_SEED);
    const platformSig = await signHex(seed, new TextEncoder().encode(payload));

    const receiptId = crypto.randomUUID();
    await queries.insertReceipt(db, {
      id: receiptId,
      jobId: null,
      workerId: worker.id,
      gpuSeconds: 0,
      platformSig,
      createdAt: toSqliteTimestamp(new Date()),
      kind: "p2p_upload",
      billable: false,
      basis: "wall",
      bytes: bytesServed,
    });

    return c.json({ ok: true, receipt_id: receiptId });
  } catch (err) {
    // DB insert failed after the claim above already marked the grant
    // booked -- un-mark it so a legitimate client retry can still succeed
    // instead of permanently wedging on a grant nothing ever actually booked.
    await queries.unmarkP2pGrantBooked(db, grantId);
    throw err;
  }
});

export default app;
