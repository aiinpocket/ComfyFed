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
 *  5. fetch-manifest entry (model_manifest.py `entries()`):
 *       f"{name}|{directory}|{sha256}|{size_bytes}"
 *  6. P2P grant (peer.py `sign_grant`/`verify_grant`, Phase 3.1 Task 3/8):
 *       f"{grant_id}|{name}|{size_bytes}|{sha256}|{seeder_id}|{puller_id}|{expires_at}"
 *  7. P2P upload receipt (peer.py `peer_served`'s dedicated signing string,
 *     deliberately NOT the receipt payload above -- job_id is always NULL
 *     for a p2p_upload receipt, and stringifying that would sign the
 *     literal text "None"/"null"):
 *       f"p2p_upload|{grant_id}|{worker_id}|{bytes_served}"
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

/** `f"{name}|{directory}|{sha256}|{size_bytes}"` -- ports `model_manifest.
 * entries()`'s per-entry signed payload verbatim (`|` field delimiter; see
 * that function's docstring for why a `|` inside `name`/`directory` is
 * refused by the caller before this is ever built). */
export function buildManifestEntryPayload(
  name: string,
  directory: string,
  sha256: string,
  sizeBytes: number
): string {
  return `${name}|${directory}|${sha256}|${sizeBytes}`;
}

export async function signManifestEntry(
  seedHex: string,
  name: string,
  directory: string,
  sha256: string,
  sizeBytes: number
): Promise<string> {
  const payload = buildManifestEntryPayload(name, directory, sha256, sizeBytes);
  return signHex(seedHex, encoder.encode(payload));
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

/** Ordered exactly as peer.py's `_GRANT_FIELDS` / the Global Constraints
 * payload -- `grant_id|name|size_bytes|sha256|seeder_id|puller_id|expires_at`.
 * Exported so `core/peer.ts` can also use it for the `|`-delimiter guard
 * (each field's string form must not contain `|`) without duplicating the
 * field order. */
export const GRANT_FIELDS = [
  "grant_id",
  "name",
  "size_bytes",
  "sha256",
  "seeder_id",
  "puller_id",
  "expires_at",
] as const;

export interface GrantFields {
  grant_id: string;
  name: string;
  size_bytes: number;
  sha256: string;
  seeder_id: string;
  puller_id: string;
  expires_at: number;
}

/** `f"{grant_id}|{name}|{size_bytes}|{sha256}|{seeder_id}|{puller_id}|{expires_at}"`
 * -- ports peer.py's `_grant_payload` verbatim (field order = `GRANT_FIELDS`). */
export function buildGrantPayload(grant: GrantFields): string {
  return GRANT_FIELDS.map((field) => String(grant[field])).join("|");
}

/** `f"p2p_upload|{grant_id}|{worker_id}|{bytes_served}"` -- ports peer.py's
 * `peer_served` dedicated signing string (see this file's module docstring,
 * item 7, for why it is NOT `buildReceiptPayload`). */
export function buildP2pUploadReceiptPayload(grantId: string, workerId: string, bytesServed: number): string {
  return `p2p_upload|${grantId}|${workerId}|${bytesServed}`;
}

export { signHex, verifyHex } from "./ed25519";
