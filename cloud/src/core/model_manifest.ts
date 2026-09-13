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
 */

import { matchesModelName } from "./assess";
import * as modelGuide from "./model_guide";
import * as queries from "../db/queries";
import { toSqliteTimestamp } from "../db/queries";
import { signHex } from "../lib/ed25519";
import { buildManifestEntryPayload } from "../lib/signing";

export interface ManifestEntry {
  name: string;
  directory: string;
  url: string;
  backup_url: string | null;
  sha256: string;
  size_bytes: number;
  sig: string;
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
 * `agentws._record_model_hashes` documents. */
export async function recordHash(
  db: D1Database,
  workerId: string,
  name: string,
  sizeBytes: number,
  sha256: string
): Promise<RecordHashResult> {
  const inserted = await queries.insertModelHashIfAbsent(
    db,
    name,
    sizeBytes,
    sha256,
    workerId,
    toSqliteTimestamp(new Date())
  );
  if (inserted) return { conflict: false };

  const existing = await queries.getModelHash(db, name, sizeBytes);
  if (existing === null || existing.sha256 === sha256) return { conflict: false };

  console.warn(
    `model_manifest: sha256 conflict for ${name} (size_bytes=${sizeBytes}): ` +
      `worker ${workerId} reported ${sha256}, worker ${existing.firstWorkerId} previously reported ` +
      `${existing.sha256} -- keeping the first-seen hash and excluding this name from the fetch manifest`
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

/** Build the signed fetch-manifest entry list -- ports `model_manifest.
 * entries()`. `queries.getAllModelHashes` already excludes conflicted rows
 * in SQL, so there is no in-memory set for this function (or its caller) to
 * consult. */
export async function entries(db: D1Database, store: R2Bucket, seedHex: string): Promise<ManifestEntry[]> {
  const harvested = await modelGuide.harvest(store);
  const names = new Set([...Object.keys(modelGuide.SOURCES), ...Object.keys(harvested)]);

  const hashRows = await queries.getAllModelHashes(db);

  const result: ManifestEntry[] = [];
  for (const name of [...names].sort()) {
    const source = await modelGuide.lookup(name, store);
    if (source === null || !source.officialUrl) continue;

    const row = findHashRow(hashRows, name);
    if (row === null) continue;

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

    result.push({
      name: source.name,
      directory: source.directory,
      url: source.officialUrl,
      backup_url: source.backupUrl,
      sha256: row.sha256,
      size_bytes: row.sizeBytes,
      sig,
    });
  }

  return result;
}
