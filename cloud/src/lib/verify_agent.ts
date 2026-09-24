/**
 * Ed25519-signed agent request verification, ported from the former Python
 * server's `verify_agent` (+ `_canonical_message`
 * / `_prune_nonces`). Consumes `lib/signing.ts`'s canonical-message builder
 * (fixed in Task 2) and D1 for both the worker lookup and the replay store
 * (Task 5's new `nonces` table -- see migrations/0002_nonces.sql -- replacing
 * Python's in-process `_seen_nonces` dict).
 *
 * Error shapes/ordering mirror the Python source exactly, including the
 * deliberate 401-for-everything-signature-related choice (missing headers,
 * unknown worker, bad ts, bad signature all collapse to the same
 * `agent.bad_signature` 401 so a caller can't use the response to probe
 * worker existence), signature verified strictly BEFORE the disabled check
 * (same anti-oracle reasoning), and the nonce check happening last.
 */

import type { Worker } from "../db/queries";
import { getWorkerById, pruneNonces, tryInsertNonce } from "../db/queries";
import { verifySignedRequest } from "./signing";

/** Matches the former Python `_NONCE_TTL_SECONDS` / `_MAX_TS_SKEW_SECONDS`. */
export const NONCE_TTL_SECONDS = 300;
export const MAX_TS_SKEW_SECONDS = 120;

export interface VerifyAgentHeaders {
  workerId: string | null;
  ts: string | null;
  nonce: string | null;
  sig: string | null;
}

export interface VerifyAgentRequestInfo {
  method: string;
  path: string;
  query: string;
  body: Uint8Array;
}

export type VerifyAgentResult =
  | { ok: true; worker: Worker }
  | { ok: false; status: number; code: string; message: string };

function fail(status: number, code: string, message: string): VerifyAgentResult {
  return { ok: false, status, code, message };
}

const BAD_SIGNATURE = () => fail(401, "agent.bad_signature", "Invalid signature.");

/**
 * Verify a signed agent request. `nowSeconds` defaults to the real clock but
 * is injectable so tests can replay a golden vector's fixed `ts` without
 * racing real time (mirrors `core/auth.ts`'s injectable-`now` pattern).
 */
export async function verifyAgentRequest(
  db: D1Database,
  headers: VerifyAgentHeaders,
  request: VerifyAgentRequestInfo,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<VerifyAgentResult> {
  const { workerId, ts, nonce, sig } = headers;
  if (!workerId || !ts || !nonce || !sig) {
    return fail(401, "agent.bad_signature", "Missing signature headers.");
  }

  const worker = await getWorkerById(db, workerId);
  if (worker === null) {
    return BAD_SIGNATURE();
  }

  // Strict integer parse: Python's `int(x_ts)` rejects "42.0"/"abc"/"" the
  // same way; a plain `Number.parseInt` would silently accept those as NaN
  // or a truncated prefix (`parseInt("42.9")` -> 42) and let a malformed
  // timestamp slip past the skew check below instead of failing closed.
  if (!/^[+-]?\d+$/.test(ts.trim())) {
    return BAD_SIGNATURE();
  }
  const tsSeconds = Number.parseInt(ts, 10);
  if (Math.abs(nowSeconds - tsSeconds) > MAX_TS_SKEW_SECONDS) {
    return BAD_SIGNATURE();
  }

  // Signature MUST be checked before the disabled-worker check: returning a
  // distinct 403 for a disabled worker before verifying the signature would
  // let an attacker use the 401-vs-403 split as an existence/status oracle
  // for a merely-guessed worker id (the former Python server's comment made this exact
  // point).
  const sigOk = await verifySignedRequest(
    worker.pubkey,
    request.method,
    request.path,
    request.query,
    ts,
    nonce,
    request.body,
    sig
  );
  if (!sigOk) {
    return BAD_SIGNATURE();
  }

  if (worker.disabled) {
    return fail(403, "agent.worker_disabled", "Worker is disabled.");
  }

  await pruneNonces(db, nowSeconds);
  const inserted = await tryInsertNonce(db, workerId, nonce, nowSeconds + NONCE_TTL_SECONDS);
  if (!inserted) {
    return fail(409, "agent.replay", "Nonce already used.");
  }

  return { ok: true, worker };
}
