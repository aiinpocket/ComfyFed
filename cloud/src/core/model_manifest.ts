/**
 * Server-learned model hashes + the platform-signed fetch manifest. Ported
 * from `server/comfyfed_server/model_manifest.py`, read in full -- see that
 * module's docstring for the full consensus/conflict/signing rationale this
 * mirrors.
 *
 * Two pieces:
 *
 * 1. `recordHash` learns a (name, size_bytes) -> sha256 consensus from
 *    `inventory` reports (`do/hub.ts`'s `handleInventory`, mirroring
 *    `agentws._handle_inventory` -> `model_manifest.record_hash`). Two
 *    workers reporting DIFFERENT hashes for the same (name, size_bytes) is a
 *    same-name-different-content collision -- never silently overwritten:
 *    the first-seen hash wins and the row is marked `conflict = true`
 *    (`queries.markModelHashConflict`), excluding it from the manifest.
 *
 * 2. `entries` builds the signed fetch manifest: joins `model_guide`'s
 *    name -> download-source lookup with the learned, non-conflicted hashes
 *    above (`queries.getAllModelHashes` already filters `conflict = 0` in
 *    SQL). Only a model with BOTH a known source URL and an agreed sha256
 *    becomes a manifest entry, each carrying a platform Ed25519 signature
 *    over its own `name|directory|sha256|size_bytes` (see `lib/signing.ts`'s
 *    `buildManifestEntryPayload`).
 *
 * Fix round 1 (Task 7 review, m1): the conflict flag is a persisted D1
 * column (migration 0005_model_hash_conflict.sql), not an in-memory,
 * per-DO-instance set -- the earlier design here couldn't be seen by a
 * plain HTTP route (`routes/workers.ts`'s manifest endpoints, `routes/
 * comfyapi.ts`/`routes/jobs.ts`'s submission gates) with no access to the
 * Hub DO's memory, and was forgotten on DO eviction. Persisting it makes
 * exclusion a plain SQL predicate every caller gets for free, with no
 * coordination and no staleness window.
 *
 * Phase 3.2 addendum, ported from `model_manifest.py`: `entries()` no
 * longer requires a learned consensus row at all for the 11 curated models
 * in `model_guide.SOURCES` that carry an operator-vouched `sha256`/
 * `sizeBytes` -- a "zero-holder" curated model (no worker in the fleet has
 * ever reported it, so no `model_hashes` row can exist) still gets a signed
 * manifest entry, built straight from those guide values (see
 * `guideHashEntry`). A learned consensus, once any worker reports one,
 * always wins over the guide value for that entry; a guide/consensus
 * mismatch is logged (deduped per (name, guide, consensus) triple via
 * `MISMATCH_LOGGED`, a module-level Set -- fine for a single worker isolate,
 * same as the Python process-level set) and the consensus hash is what
 * ships. A conflicted `model_hashes` row still excludes the name outright,
 * guide hash or not -- see `entries()`.
 */

import { matchesModelName } from "./assess";
import * as modelGuide from "./model_guide";
import * as peer from "./peer";
import * as queries from "../db/queries";
import { toSqliteTimestamp } from "../db/queries";
import { signHex } from "../lib/ed25519";
import { buildManifestEntryPayload } from "../lib/signing";

export interface ManifestEntry {
  name: string;
  directory: string;
  /** null only for a Phase 3.1 peer-only entry (no known download source at
   * all, an online seeder instead). */
  url: string | null;
  backup_url: string | null;
  sha256: string;
  size_bytes: number;
  sig: string;
  /** Phase 3.1: present (true) when this (name, size_bytes) also has an
   * online P2P seeder right now -- informative for a URL-sourced entry (the
   * agent fetcher always tries peer first regardless), load-bearing for a
   * peer-only entry (url is null, this is the ONLY source). Absent entirely
   * for a URL-sourced entry with no online seeder, matching peer.py's
   * `entries()` shape (`peer` key only set when true, never `false`). */
  peer?: true;
}

// Guide-vs-consensus mismatch warnings already emitted (dedup; see
// `entries()`) -- module-level Set, ported from Python's `_MISMATCH_LOGGED`.
// Fine to keep per-isolate: a repeat mismatch after an isolate recycle just
// logs once more, no correctness dependency on this surviving a cold start.
const MISMATCH_LOGGED = new Set<string>();

/** Test-only escape hatch (Phase 3.2 F6 fix), ports model_manifest.py's
 * `_clear_mismatch_log_for_tests`: reset the module-level guide-vs-consensus
 * mismatch dedup set so a test asserting a warning was logged isn't broken
 * by test ORDER -- only the first execution of a given (name, guide,
 * consensus) triple in this module instance actually logs otherwise. NOT
 * for production use. */
export function clearMismatchLogForTests(): void {
  MISMATCH_LOGGED.clear();
}

/** The curated guide sha256 for inventory-relative `name`, when it matches
 * one of the 11 `model_guide.SOURCES` entries that carries a vouched hash --
 * else null. Used only to annotate a `recordHash` conflict warning (Phase
 * 3.2 F4 fix) with a diagnostic clue; never to resolve/prefer a value -- a
 * `model_hashes` conflict stays purely reporter-vs-reporter, and the guide
 * never writes to this table. Ports model_manifest.py's `_guide_sha256_for`. */
function guideSha256For(name: string): string | null {
  for (const source of Object.values(modelGuide.SOURCES)) {
    if (source.sha256 && matchesModelName(name, source.name)) return source.sha256;
  }
  return null;
}

export interface RecordHashResult {
  /** True when this report conflicted with an already-learned hash for the
   * same (name, size_bytes) -- the row has already been marked
   * `conflict = true` in D1 by the time this returns; the caller does not
   * need to track anything else. */
  conflict: boolean;
}

/** Learn one inventory entry's sha256 for (name, size_bytes) -- ports
 * `model_manifest.record_hash`. `sizeBytes` must be the EXACT byte count
 * (see that Python docstring for why); the caller (`do/hub.ts`'s
 * `handleInventory`) is responsible for the same GB-rounding fallback
 * `agentws._record_model_hashes` documents.
 *
 * `chunkSha256s` (Phase 3.1 addendum): stored (as JSON text) the FIRST time
 * a reporter's whole-file hash matches/establishes consensus for (name,
 * size_bytes) and no chunk list is on the row yet -- never overwritten by a
 * later, different one (the whole-file hash is the sole trust root; final
 * whole-file verification always runs on every P2P download regardless of
 * chunk hashes). A report that disagrees on the whole-file hash never
 * contributes its chunk list either -- see the conflict branch below. */
export async function recordHash(
  db: D1Database,
  workerId: string,
  name: string,
  sizeBytes: number,
  sha256: string,
  chunkSha256s?: string[] | null
): Promise<RecordHashResult> {
  const chunkJson = chunkSha256s && chunkSha256s.length > 0 ? JSON.stringify(chunkSha256s) : null;

  const inserted = await queries.insertModelHashIfAbsent(
    db,
    name,
    sizeBytes,
    sha256,
    workerId,
    toSqliteTimestamp(new Date()),
    chunkJson
  );
  if (inserted) return { conflict: false };

  const existing = await queries.getModelHash(db, name, sizeBytes);
  if (existing === null) return { conflict: false };

  if (existing.sha256 === sha256) {
    if (chunkJson !== null && existing.chunkSha256s === null) {
      await queries.setModelHashChunksIfAbsent(db, name, sizeBytes, chunkJson);
    } else if (chunkJson !== null && JSON.stringify(existing.chunkSha256s) !== chunkJson) {
      console.warn(
        `model_manifest: chunk_sha256s mismatch for ${name} (size_bytes=${sizeBytes}) reported by worker ` +
          `${workerId} -- whole-file sha256 still agrees, so this is not a conflict; keeping the first-seen ` +
          `chunk list (final whole-file verification is the trust root regardless of any chunk list)`
      );
    }
    return { conflict: false };
  }

  // Phase 3.2 F4 fix: when either side of the conflict happens to equal the
  // curated guide's vouched hash for this name, say so -- that's exactly
  // the clue an operator needs to diagnose "this is a stale registry entry,
  // not two genuinely different worker builds" at a glance.
  const guideSha256 = guideSha256For(name);
  let guideClue = "";
  if (guideSha256 !== null) {
    if (guideSha256 === sha256) {
      guideClue = ` (NOTE: worker ${workerId}'s reported hash matches the curated guide value -- the OTHER report looks stale)`;
    } else if (guideSha256 === existing.sha256) {
      guideClue = ` (NOTE: the existing hash matches the curated guide value -- worker ${workerId}'s NEW report looks stale)`;
    }
  }

  console.warn(
    `model_manifest: sha256 conflict for ${name} (size_bytes=${sizeBytes}): ` +
      `worker ${workerId} reported ${sha256}, worker ${existing.firstWorkerId} previously reported ` +
      `${existing.sha256} -- keeping the first-seen hash and excluding this name from the fetch manifest${guideClue}`
  );
  await queries.markModelHashConflict(db, name, sizeBytes);
  return { conflict: true };
}

/** First `model_hashes` row whose (inventory-relative) name matches
 * `sourceKey` (a bare model_guide name), per `matchesModelName` semantics --
 * ports `model_manifest._find_hash_row`. */
function findHashRow(rows: queries.ModelHashRow[], sourceKey: string): queries.ModelHashRow | null {
  for (const row of rows) {
    if (matchesModelName(row.name, sourceKey)) return row;
  }
  return null;
}

/** Split an inventory-relative model path (`"directory/name"`, the shape a
 * `model_hashes.name` stores) into `(directory, name)` -- ports
 * `model_manifest._split_inventory_name`, the same one-level convention the
 * agent-side peer name sanitizer caps names at. A path with no `/` at all
 * yields `("", inventoryName)`. */
function splitInventoryName(inventoryName: string): [directory: string, name: string] {
  const normalized = inventoryName.replace(/\\/g, "/").replace(/^\/+/, "");
  const slash = normalized.indexOf("/");
  if (slash === -1) return ["", normalized];
  return [normalized.slice(0, slash), normalized.slice(slash + 1)];
}

/** Phase 3.2 zero-holder entry: sign a manifest entry straight from
 * `source`'s operator-vouched `sha256`/`sizeBytes` when NO `model_hashes`
 * row exists for it yet (nobody in the fleet holds the file, so no learned
 * consensus is even possible) -- ports `model_manifest._guide_hash_entry`.
 * Caller (`entries()`) only reaches here after confirming no row --
 * conflicted or otherwise -- matches this name; a learned consensus, once
 * any worker reports one, always takes over from this path (see
 * `entries()`'s consensus-precedence branch).
 *
 * `peer` is deliberately never set on this entry: by construction there is
 * no `model_hashes` row, so there is nothing for `rowHasSeeder` to have
 * matched -- an entry from this path always means zero holders right now. */
async function guideHashEntry(seedHex: string, source: modelGuide.ModelSource): Promise<ManifestEntry | null> {
  if (source.sha256 === undefined || source.sizeBytes === undefined) return null;

  if (source.name.includes("|") || source.directory.includes("|")) {
    console.warn(
      `model_manifest: skipping guide-hash manifest candidate with a '|' in name or directory ` +
        `(payload delimiter): name=${JSON.stringify(source.name)} directory=${JSON.stringify(source.directory)}`
    );
    return null;
  }

  const payload = buildManifestEntryPayload(source.name, source.directory, source.sha256, source.sizeBytes);
  const sig = await signHex(seedHex, new TextEncoder().encode(payload));

  return {
    name: source.name,
    directory: source.directory,
    url: source.officialUrl,
    backup_url: source.backupUrl,
    sha256: source.sha256,
    size_bytes: source.sizeBytes,
    sig,
  };
}

/** Build a peer-only manifest entry for `row` (a non-conflicted
 * `model_hashes` row with no known download source), or null when it has no
 * online seeder right now -- ports `model_manifest._peer_only_entry`. `url`/
 * `backup_url` are null and `peer: true` marks the entry so a consumer
 * (`core/assess.ts`'s protocol>=4 gate, the agent fetcher) knows this model
 * has no URL fallback at all. */
async function peerOnlyEntry(
  seedHex: string,
  row: queries.ModelHashRow,
  seederFiles: ReadonlySet<string>
): Promise<ManifestEntry | null> {
  if (!peer.rowHasSeeder(row, seederFiles)) return null;

  const [directory, name] = splitInventoryName(row.name);

  // Same defensive `|` guard as the URL-sourced branch below -- an agent-
  // reported inventory name is untrusted input relative to this process.
  if (name.includes("|") || directory.includes("|")) {
    console.warn(
      `model_manifest: skipping peer-only manifest candidate with a '|' in name or directory ` +
        `(payload delimiter): name=${JSON.stringify(name)} directory=${JSON.stringify(directory)}`
    );
    return null;
  }

  const payload = buildManifestEntryPayload(name, directory, row.sha256, row.sizeBytes);
  const sig = await signHex(seedHex, new TextEncoder().encode(payload));

  return {
    name,
    directory,
    url: null,
    backup_url: null,
    sha256: row.sha256,
    size_bytes: row.sizeBytes,
    sig,
    peer: true,
  };
}

/** The subset of `entries()`'s output whose ONLY source is a peer (`url` is
 * null) -- names a candidate fetching worker must be protocol>=4 to pull,
 * per the task brief's eligibility gate. A model that has both a URL and an
 * online seeder (`peer: true` alongside a real `url`) is NOT in this set --
 * ports `model_manifest.peer_only_names`. */
export function peerOnlyNames(manifestEntries: ManifestEntry[]): ReadonlySet<string> {
  return new Set(manifestEntries.filter((e) => e.url === null).map((e) => e.name));
}

/** Build the signed fetch-manifest entry list -- ports `model_manifest.
 * entries()`. `queries.getAllModelHashes` already excludes conflicted rows
 * in SQL, so there is no in-memory set for this function (or its caller) to
 * consult.
 *
 * Two kinds of entries (Phase 3.1): URL-sourced (unchanged criteria),
 * additionally carrying `peer: true` when an online seeder also exists right
 * now; and peer-only (`peerOnlyEntry`, above) for a non-conflicted hash row
 * with NO known download source that DOES have an online seeder. */
export async function entries(db: D1Database, store: R2Bucket, seedHex: string): Promise<ManifestEntry[]> {
  const harvested = await modelGuide.harvest(store);
  const names = new Set([...Object.keys(modelGuide.SOURCES), ...Object.keys(harvested)]);

  const hashRows = await queries.getAllModelHashes(db);
  // Phase 3.2: a conflicted row must still block the guide-hash fallback
  // below -- "two reporters disagree" is not resolved by the operator's
  // curated hash, so a name with one stays excluded exactly like before this
  // phase.
  const conflictedRows = await queries.getConflictedModelHashes(db);

  // M3 final-review fix: one worker query + one inventory parse per worker
  // for this whole call, instead of once per hash row below.
  const seederFiles = await peer.seederCandidateFiles(db);

  const result: ManifestEntry[] = [];
  const usedRows = new Set<string>();
  for (const name of [...names].sort()) {
    const source = await modelGuide.lookup(name, store);
    if (source === null || !source.officialUrl) continue;

    const row = findHashRow(hashRows, name);
    if (row === null) {
      // Phase 3.2: no learned consensus for this (curated or harvested)
      // source. A conflicted row still excludes it outright -- consensus
      // precedence never lets a curated guide hash paper over a genuine
      // reporter disagreement.
      if (findHashRow(conflictedRows, name) !== null) continue;
      const guideEntry = await guideHashEntry(seedHex, source);
      if (guideEntry !== null) result.push(guideEntry);
      continue;
    }

    if (source.sha256 !== undefined && source.sha256 !== row.sha256) {
      const dedupKey = `${source.name} ${source.sha256} ${row.sha256}`;
      // Dedup per (name, pair): entries() can be read repeatedly (every
      // manifest fetch), and a standing mismatch would otherwise flood the
      // log.
      if (!MISMATCH_LOGGED.has(dedupKey)) {
        MISMATCH_LOGGED.add(dedupKey);
        console.warn(
          `model_manifest: guide sha256 for ${source.name} differs from the learned consensus ` +
            `(guide=${source.sha256} consensus=${row.sha256}) -- consensus wins, the manifest entry uses the ` +
            `learned hash`
        );
      }
    }

    // Defensive: `|` is the field delimiter in the signed payload below --
    // see model_manifest.py's docstring for why a harvested entry's
    // name/directory (untrusted, off a workflow JSON) must be refused rather
    // than let a crafted value shift what substring the signature covers.
    if (source.name.includes("|") || source.directory.includes("|")) {
      console.warn(
        `model_manifest: skipping manifest candidate with a '|' in name or directory ` +
          `(payload delimiter): name=${JSON.stringify(source.name)} directory=${JSON.stringify(source.directory)}`
      );
      continue;
    }

    const payload = buildManifestEntryPayload(source.name, source.directory, row.sha256, row.sizeBytes);
    const sig = await signHex(seedHex, new TextEncoder().encode(payload));

    const entry: ManifestEntry = {
      name: source.name,
      directory: source.directory,
      url: source.officialUrl,
      backup_url: source.backupUrl,
      sha256: row.sha256,
      size_bytes: row.sizeBytes,
      sig,
    };
    if (peer.rowHasSeeder(row, seederFiles)) {
      entry.peer = true;
    }
    result.push(entry);
    usedRows.add(`${row.name} ${row.sizeBytes}`);
  }

  // Phase 3.1: every remaining non-conflicted hash row (no known download
  // source at all) becomes a peer-only entry when it has an online seeder
  // right now.
  for (const row of hashRows) {
    if (usedRows.has(`${row.name} ${row.sizeBytes}`)) continue;
    const peerEntry = await peerOnlyEntry(seedHex, row, seederFiles);
    if (peerEntry !== null) result.push(peerEntry);
  }

  return result;
}
