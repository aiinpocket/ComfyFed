/**
 * Canonical-string builders matching the four signature-byte-parity formats
 * confirmed against the Python source (see task-1-report.md's
 * "Canonical-string finding" and scripts/golden_vectors.py):
 *
 *  1. receipt payload     (agentws.py `_sign_and_store_receipt`):
 *       f"{job_id}|{worker_id}|{gpu_seconds:.1f}"
 *  2. registration cert   (workers.py `register()`):
 *       f"{worker_id}|{pubkey_hex}"
 *  3. release signature   (main.py `_publish_agent`):
 *       f"{version}|{sha256_hex}"
 *  4. signed-request canonical message (workers.py `_canonical_message`):
 *       f"{METHOD}\n{path}[?{query}]\n{ts}\n{nonce}\n" + body
 *       -- the body is embedded RAW (not hashed) -- byte-for-byte.
 */

import { python1f } from "./format";
import { signHex, verifyHex } from "./ed25519";

const encoder = new TextEncoder();

export function buildReceiptPayload(jobId: string, workerId: string, gpuSeconds: number): string {
  return `${jobId}|${workerId}|${python1f(gpuSeconds)}`;
}

export function buildRegistrationPayload(workerId: string, pubkeyHex: string): string {
  return `${workerId}|${pubkeyHex}`;
}

export function buildReleasePayload(version: string, sha256Hex: string): string {
  return `${version}|${sha256Hex}`;
}

/**
 * Build the canonical signed-request message as raw bytes.
 * `target = query ? `${path}?${query}` : path` -- an empty query string is
 * treated the same as "no query" (matches Python's `if query:` truthiness
 * check on `request.url.query`, which is `""` for a query-less request).
 */
export function buildCanonicalRequestMessage(
  method: string,
  path: string,
  query: string,
  ts: string,
  nonce: string,
  body: Uint8Array
): Uint8Array {
  const target = query ? `${path}?${query}` : path;
  const header = encoder.encode(`${method.toUpperCase()}\n${target}\n${ts}\n${nonce}\n`);
  const out = new Uint8Array(header.length + body.length);
  out.set(header, 0);
  out.set(body, header.length);
  return out;
}

export async function signReceipt(
  seedHex: string,
  jobId: string,
  workerId: string,
  gpuSeconds: number
): Promise<{ payload: string; signatureHex: string }> {
  const payload = buildReceiptPayload(jobId, workerId, gpuSeconds);
  const signatureHex = await signHex(seedHex, encoder.encode(payload));
  return { payload, signatureHex };
}

export async function signRegistration(
  seedHex: string,
  workerId: string,
  pubkeyHex: string
): Promise<{ payload: string; signatureHex: string }> {
  const payload = buildRegistrationPayload(workerId, pubkeyHex);
  const signatureHex = await signHex(seedHex, encoder.encode(payload));
  return { payload, signatureHex };
}

export async function signRelease(
  seedHex: string,
  version: string,
  sha256Hex: string
): Promise<{ payload: string; signatureHex: string }> {
  const payload = buildReleasePayload(version, sha256Hex);
  const signatureHex = await signHex(seedHex, encoder.encode(payload));
  return { payload, signatureHex };
}

export async function signRequest(
  seedHex: string,
  method: string,
  path: string,
  query: string,
  ts: string,
  nonce: string,
  body: Uint8Array
): Promise<string> {
  const message = buildCanonicalRequestMessage(method, path, query, ts, nonce, body);
  return signHex(seedHex, message);
}

/** Verify a signed request's canonical message against a worker's hex
 * public key. Returns `false` on any verification failure or malformed
 * input (never throws). */
export async function verifySignedRequest(
  pubkeyHex: string,
  method: string,
  path: string,
  query: string,
  ts: string,
  nonce: string,
  body: Uint8Array,
  signatureHex: string
): Promise<boolean> {
  const message = buildCanonicalRequestMessage(method, path, query, ts, nonce, body);
  return verifyHex(pubkeyHex, message, signatureHex);
}

export { signHex, verifyHex } from "./ed25519";
