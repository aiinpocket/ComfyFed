/**
 * Phase 3.1 P2P addendum: server-side seeder tracking + grant signing.
 * Ported from `server/comfyfed_server/peer.py`, read in full -- see that
 * module's docstring for the full rationale. This module covers the pure
 * "who can seed this file, and how is a grant signed" logic; the grant
 * book itself (issuance/booking state) lives in D1 (`db/queries.ts`'s
 * `p2p_grants` helpers) rather than an in-memory dict -- a Worker isolate's
 * memory is not reliable/shared across requests the way a long-lived Python
 * process's `_grants` dict is, so this is the Workers-correct equivalent of
 * peer.py's `_grants`/`_grant_lock`, not a stylistic choice. `routes/peer.ts`
 * wires this module's pieces into the two HTTP endpoints.
 */

import * as queries from "../db/queries";
import type { Worker } from "../db/queries";
import { signHex } from "../lib/ed25519";
import { buildGrantPayload, GRANT_FIELDS, type GrantFields } from "../lib/signing";

/** Global Constraints: TTL 600s, single file/puller/seeder per grant. */
export const GRANT_TTL_SECONDS = 600;

/** Global Constraints: agent protocol becomes 4 for P2P; older agents never
 * advertise peer_url and are never picked as a seeder. */
export const MIN_PEER_PROTOCOL = 4;

/** `peer-served`'s `bytes_served` upper bound: `size_bytes * 1.05` -- matches
 * peer.py's `_BYTES_SERVED_SLACK`. */
export const BYTES_SERVED_SLACK = 1.05;

const encoder = new TextEncoder();

export type Grant = GrantFields;

/** The first grant field (in `GRANT_FIELDS` order) whose string form
 * contains the `|` payload delimiter, or null if none do -- ports peer.py's
 * `sign_grant`'s `|`-in-field guard. A crafted field containing `|` could
 * otherwise shift what substring the signature is later parsed as covering. */
function grantFieldWithPipe(grant: Grant): (typeof GRANT_FIELDS)[number] | null {
  for (const field of GRANT_FIELDS) {
    if (String(grant[field]).includes("|")) return field;
  }
  return null;
}

/** Sign `grant`'s fields (pipe-joined, `GRANT_FIELDS` order) with the
 * platform Ed25519 key -- ports peer.py's `sign_grant`. Throws an `Error`
 * (message mirrors the Python `ValueError`'s text) if any field's string
 * form contains `|`; the caller (`routes/peer.ts`) turns that into the
 * module's typed 400 rather than letting it escape as a 500. */
export async function signGrant(seedHex: string, grant: Grant): Promise<string> {
  const badField = grantFieldWithPipe(grant);
  if (badField !== null) {
    throw new Error(
      `grant field ${JSON.stringify(badField)} contains the '|' payload delimiter: ${JSON.stringify(String(grant[badField]))}`
    );
  }
  return signHex(seedHex, encoder.encode(buildGrantPayload(grant)));
}

/** Whether `worker`'s reported inventory contains an entry for exactly
 * (name, size_bytes) at the learned consensus `sha256` -- ports peer.py's
 * `_worker_has_consensus_file`. Exact-name comparison (not `assess.
 * matchesModelName`'s loader-relative leniency): `model_hashes.name` is the
 * SAME inventory-relative path a worker's own `model_inventory` entries use
 * (both come from the identical `hardware.scan_models` report), so there is
 * no root mismatch to reconcile here. */
export function workerHasConsensusFile(worker: Worker, name: string, sizeBytes: number, sha256: string): boolean {
  for (const entry of worker.modelInventory) {
    if (typeof entry !== "object" || entry === null) continue;
    if (entry.name !== name) continue;
    const entrySize = entry.size_bytes;
    if (typeof entrySize !== "number" || !Number.isInteger(entrySize) || entrySize !== sizeBytes) continue;
    if (entry.sha256 === sha256) return true;
  }
  return false;
}

/** Online, protocol>=4, peer_url-advertising workers whose inventory has
 * (name, size_bytes) at the learned consensus hash -- ports peer.py's
 * `online_seeders`, the single seeder predicate shared by grant issuance
 * (`routes/peer.ts`) and `core/model_manifest.ts`'s peer-only entries /
 * `peer` flag, per the plan's Global Constraints ruling against implementing
 * it twice. A conflicted `model_hashes` row (two workers disagreed on the
 * whole-file hash) never has a seeder -- the platform doesn't know which
 * reported hash, if either, is genuine. "Online" mirrors `assess`'s online-
 * enabled definition (`status != "offline"`, not disabled) -- a disabled
 * worker's peer-serving is independent of dispatch eligibility per spec
 * (worker sovereignty), but a genuinely offline one can't serve a byte. */
export async function onlineSeeders(
  db: D1Database,
  name: string,
  sizeBytes: number,
  opts: { excludeWorkerId?: string } = {}
): Promise<Worker[]> {
  const hashRow = await queries.getModelHash(db, name, sizeBytes);
  if (hashRow === null || hashRow.conflict) return [];

  const candidates = await queries.getOnlinePeerCapableWorkers(db, MIN_PEER_PROTOCOL, opts.excludeWorkerId);
  return candidates.filter((w) => workerHasConsensusFile(w, name, sizeBytes, hashRow.sha256));
}

/** Picks the best seeder among `seeders`: fewest currently-active
 * (unexpired, unbooked) grants, then name -- ports peer.py's `min(seeders,
 * key=lambda w: (_active_grant_count(w.id, now), w.name))`. */
export async function pickSeeder(db: D1Database, seeders: Worker[], nowSeconds: number): Promise<Worker> {
  const counted = await Promise.all(
    seeders.map(async (w) => ({ worker: w, count: await queries.countActiveP2pGrantsForSeeder(db, w.id, nowSeconds) }))
  );
  counted.sort((a, b) => (a.count !== b.count ? a.count - b.count : a.worker.name < b.worker.name ? -1 : a.worker.name > b.worker.name ? 1 : 0));
  return counted[0]!.worker;
}
