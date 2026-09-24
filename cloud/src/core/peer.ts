/**
 * Phase 3.1 P2P addendum: server-side seeder tracking + grant signing.
 * Ported from the former Python server (2026-09); this file is now the only
 * implementation. This module covers the pure
 * "who can seed this file, and how is a grant signed" logic; the grant
 * book itself (issuance/booking state) lives in D1 (`db/queries.ts`'s
 * `p2p_grants` helpers) rather than an in-memory dict -- a Worker isolate's
 * memory is not reliable/shared across requests the way a long-lived Python
 * process's `_grants` dict is, so this is the Workers-correct equivalent of
 * the former Python `_grants`/`_grant_lock`, not a stylistic choice. `routes/peer.ts`
 * wires this module's pieces into the two HTTP endpoints.
 */

import * as queries from "../db/queries";
import type { Worker } from "../db/queries";
import { signHex } from "../lib/ed25519";
import { buildGrantPayload, GRANT_FIELDS, type GrantFields } from "../lib/signing";

/** Global Constraints: TTL 600s (the FLOOR -- see `grantTtlSeconds`), single
 * file/puller/seeder per grant. */
export const GRANT_TTL_SECONDS = 600;

/** The slowest transfer rate a grant's TTL is sized for -- ports the former Python
 * `MIN_ASSUMED_RATE_BYTES_PER_SEC`. It tracks the agent's DEFAULT ACTIVE
 * upload cap (`peer_upload_limit_mbps = 20` Mbps -> 20_000_000 / 8 bytes per
 * second, see `agent/comfyfed_agent/peerserve.py`). Keep the two in step. */
export const MIN_ASSUMED_RATE_BYTES_PER_SEC = 2_500_000;

/** M2 final-review fix: the accepted range for a seeder-reported
 * `peer_upload_min_mbps`, re-applied here when the value is read back out of
 * the stored `hardware` blob (a row written by an older build must not be
 * able to reintroduce the absurd-TTL case). Parity: the former Python
 * `MIN_PEER_UPLOAD_MBPS`/`MAX_PEER_UPLOAD_MBPS` and hub.ts's parse. */
export const MIN_PEER_UPLOAD_MBPS = 0.1;
export const MAX_PEER_UPLOAD_MBPS = 100_000;

/** M2 final-review fix: hard ceiling on a computed grant TTL -- 7 days. The
 * divisor is worker-reported, so this is what stops an absurd `expires_at`
 * (past 2^63, i.e. a D1 bind failure for every later puller) from ever being
 * signed into a grant. Parity: the former Python `MAX_GRANT_TTL_SECONDS`. */
export const MAX_GRANT_TTL_SECONDS = 604_800;

/** The rate a grant served by `worker` should be sized for -- ports the former Python
 * `_seeder_rate_bytes_per_sec`.
 *
 * The seeder reports its own slowest configured P2P upload cap in hello
 * (`peer_upload_min_mbps`, stashed into the `hardware` JSON blob by hub.ts's
 * hello handler). A user who capped their uplink BELOW the 20 Mbps default
 * would otherwise be under-TTL'd by default/actual -- a 5 Mbps seeder needs
 * 4x the TTL a 20 Mbps one does. Missing/non-numeric/non-positive (an old
 * agent, both caps unlimited, or a malformed value) degrades to
 * `MIN_ASSUMED_RATE_BYTES_PER_SEC`, i.e. exactly the previous behavior. */
export function seederRateBytesPerSec(worker: Worker): number {
  const value = worker.hardware?.["peer_upload_min_mbps"];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return MIN_ASSUMED_RATE_BYTES_PER_SEC;
  }
  if (value < MIN_PEER_UPLOAD_MBPS || value > MAX_PEER_UPLOAD_MBPS) {
    return MIN_ASSUMED_RATE_BYTES_PER_SEC;
  }
  return (value * 1_000_000) / 8;
}

/** How long a grant for a `sizeBytes` file must live -- ports the former Python
 * `grant_ttl_seconds`, same formula, same constants.
 *
 * At the agent's default active upload cap a 6.5 GB model takes ~43 minutes,
 * ~4x the flat 600 s TTL: bytes served past expiry went unaccounted and any
 * resume after expiry was refused. So the TTL scales with the file: the
 * estimated transfer time at `rateBytesPerSec`, times 1.5 for slack, plus
 * the flat `GRANT_TTL_SECONDS` of headroom -- never below the 600 s floor.
 *
 * `rateBytesPerSec` is the CHOSEN SEEDER's own reported cap when it has one
 * (`seederRateBytesPerSec`); omitted/invalid it falls back to
 * `MIN_ASSUMED_RATE_BYTES_PER_SEC`, the 20 Mbps agent default. */
export function grantTtlSeconds(sizeBytes: number, rateBytesPerSec?: number): number {
  const size = Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.floor(sizeBytes) : 0;
  const rate =
    typeof rateBytesPerSec === "number" && Number.isFinite(rateBytesPerSec) && rateBytesPerSec > 0
      ? rateBytesPerSec
      : MIN_ASSUMED_RATE_BYTES_PER_SEC;
  const transfer = Math.ceil(size / rate);
  // ...and never longer than `MAX_GRANT_TTL_SECONDS` (M2) -- see that constant.
  return Math.floor(
    Math.min(MAX_GRANT_TTL_SECONDS, Math.max(GRANT_TTL_SECONDS, transfer * 1.5 + GRANT_TTL_SECONDS))
  );
}

/** Global Constraints: agent protocol becomes 4 for P2P; older agents never
 * advertise peer_url and are never picked as a seeder. */
export const MIN_PEER_PROTOCOL = 4;

/** `peer-served`'s `bytes_served` upper bound: `size_bytes * 1.05` -- matches
 * the former Python `_BYTES_SERVED_SLACK`. */
export const BYTES_SERVED_SLACK = 1.05;

const encoder = new TextEncoder();

export type Grant = GrantFields;

/** The first grant field (in `GRANT_FIELDS` order) whose string form
 * contains the `|` payload delimiter, or null if none do -- ports the former Python
 * `sign_grant`'s `|`-in-field guard. A crafted field containing `|` could
 * otherwise shift what substring the signature is later parsed as covering. */
function grantFieldWithPipe(grant: Grant): (typeof GRANT_FIELDS)[number] | null {
  for (const field of GRANT_FIELDS) {
    if (String(grant[field]).includes("|")) return field;
  }
  return null;
}

/** Sign `grant`'s fields (pipe-joined, `GRANT_FIELDS` order) with the
 * platform Ed25519 key -- ports the former Python `sign_grant`. Throws an `Error`
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
 * (name, size_bytes) at the learned consensus `sha256` -- ports the former Python
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
 * (name, size_bytes) at the learned consensus hash -- ports the former Python
 * `online_seeders` (including Phase 3.4 §4.2's reachability half: verified
 * reachable, or a LAN neighbour behind the puller's own public IP -- see
 * `queries.getOnlinePeerCapableWorkers`), the single seeder predicate shared
 * by grant issuance (`routes/peer.ts`) and `core/model_manifest.ts`'s
 * peer-only entries / `peer` flag, per the plan's Global Constraints ruling
 * against implementing it twice. A conflicted `model_hashes` row (two
 * workers disagreed on the whole-file hash) never has a seeder -- the platform doesn't know which
 * reported hash, if either, is genuine. "Online" mirrors `assess`'s online-
 * enabled definition (`status != "offline"`, not disabled) -- a disabled
 * worker's peer-serving is independent of dispatch eligibility per spec
 * (worker sovereignty), but a genuinely offline one can't serve a byte. */
export async function onlineSeeders(
  db: D1Database,
  name: string,
  sizeBytes: number,
  opts: { excludeWorkerId?: string; pullerRemoteIp?: string | null } = {}
): Promise<Worker[]> {
  const hashRow = await queries.getModelHash(db, name, sizeBytes);
  if (hashRow === null || hashRow.conflict) return [];

  const candidates = await queries.getOnlinePeerCapableWorkers(
    db,
    MIN_PEER_PROTOCOL,
    opts.excludeWorkerId,
    opts.pullerRemoteIp ?? null
  );
  return candidates.filter((w) => workerHasConsensusFile(w, name, sizeBytes, hashRow.sha256));
}

/** 拉方該依序嘗試的位址（spec §5）：拉方與種子 `remoteIp` 相同且種子有區網
 * 位址 ⇒ `[peerLanUrl, peerUrl]`（同一個 NAT，區網直連最快，而且很多家用
 * 路由器不支援 hairpin，對外位址反而連不回來），否則 `[peerUrl]`（此時種子
 * 必為 `peerReachable = 1`）。Ports the former Python `_seeder_urls`. */
export function seederUrls(seeder: Worker, pullerRemoteIp: string | null): string[] {
  if (pullerRemoteIp && seeder.remoteIp === pullerRemoteIp && seeder.peerLanUrl) {
    // 保序去重：`peerNat === "lan"` 的種子兩欄是同一個值（沒開埠，通告的
    // 就是區網位址），不去重就會叫拉方在同一個位址上白試兩次。
    return dedupe([seeder.peerLanUrl, seeder.peerUrl!]);
  }
  return [seeder.peerUrl!];
}

/** 保序去重。Ports the former Python `_dedupe`. */
function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Every `(name, size_bytes, sha256)` triple currently offered by an online,
 * protocol>=4, peer_url-advertising worker, as a `Set` of `"name\u0000size\u0000sha256"`
 * keys -- ports `model_manifest._seeder_candidate_files` (final-review M3
 * fix). Built ONCE per `model_manifest.entries()` call so the per-hash-row
 * loop there can answer "does this row have an online seeder right now?"
 * with an O(1) Set lookup instead of calling `onlineSeeders` (its own D1
 * query plus a fresh JSON parse of every worker's `model_inventory`) once
 * per row. */
export async function seederCandidateFiles(db: D1Database): Promise<ReadonlySet<string>> {
  const workers = await queries.getOnlinePeerCapableWorkers(db, MIN_PEER_PROTOCOL);
  const files = new Set<string>();
  for (const worker of workers) {
    for (const entry of worker.modelInventory) {
      if (typeof entry !== "object" || entry === null) continue;
      const name = (entry as Record<string, unknown>).name;
      const sizeBytes = (entry as Record<string, unknown>).size_bytes;
      const sha256 = (entry as Record<string, unknown>).sha256;
      if (typeof name !== "string" || typeof sha256 !== "string") continue;
      if (typeof sizeBytes !== "number" || !Number.isInteger(sizeBytes)) continue;
      files.add(`${name}\u0000${sizeBytes}\u0000${sha256}`);
    }
  }
  return files;
}

/** Whether `(row.name, row.sizeBytes, row.sha256)` is in the batched
 * `seederCandidateFiles()` set -- the per-row replacement for calling
 * `onlineSeeders(db, row.name, row.sizeBytes)` (see M3). */
export function rowHasSeeder(row: { name: string; sizeBytes: number; sha256: string }, seederFiles: ReadonlySet<string>): boolean {
  return seederFiles.has(`${row.name}\u0000${row.sizeBytes}\u0000${row.sha256}`);
}

/** Picks the best seeder among `seeders`: fewest currently-active
 * (unexpired, unbooked) grants, then name -- ports the former Python `min(seeders,
 * key=lambda w: (_active_grant_count(w.id, now), w.name))`. */
export async function pickSeeder(db: D1Database, seeders: Worker[], nowSeconds: number): Promise<Worker> {
  const counted = await Promise.all(
    seeders.map(async (w) => ({ worker: w, count: await queries.countActiveP2pGrantsForSeeder(db, w.id, nowSeconds) }))
  );
  counted.sort((a, b) => (a.count !== b.count ? a.count - b.count : a.worker.name < b.worker.name ? -1 : a.worker.name > b.worker.name ? 1 : 0));
  return counted[0]!.worker;
}
