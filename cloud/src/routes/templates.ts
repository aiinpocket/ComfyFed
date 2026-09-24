/**
 * `/comfy/templates/*` -- ComfyFed's own workflow-template library plus the
 * official ComfyUI template library, merged and served to the embedded
 * frontend's built-in template browser. Ported from the former Python server
 * (2026-09); this file is now the only implementation. The frontend
 * contract (`index.json` shape, `moduleName`
 * must be `"default"`, `fileURL('/templates/<name>...')` resolution, the
 * `hasDownloadMetadata` check that decides whether a browser-side Download
 * button renders) is ported byte-for-byte.
 *
 * ComfyFed has no local filesystem in a Worker, so the two "packaged"
 * sources the former Python server read off disk become:
 *
 * 1. `env.ASSETS.fetch("/comfyfed_templates/<name>")` -- Task 11 places the
 *    real packaged files (the ten `comfyfed-*` workflows/thumbnails plus
 *    `index.json`/`index_logo.json`/`assets/<name>`) under
 *    `cloud/assets/comfyfed_templates/`, served through the `ASSETS`
 *    binding (see `wrangler.jsonc`'s `assets.directory`).
 * 2. A same-shaped R2 fallback under the `comfyfed_templates/` prefix on the
 *    `STORE` bucket, tried when the ASSETS binding has nothing at that path
 *    (e.g. this task's own tests, or any deployment running before Task 11
 *    lands the real assets). This lets `comfyfed_templates/<name>` be
 *    seeded directly into R2 as an operator override or a test fixture with
 *    zero code changes -- `fetchPackagedRaw` below tries ASSETS first, R2
 *    second, and callers never see which one answered.
 *
 * The official ComfyUI library (fetched by `cloud/scripts/seed-official.mjs`,
 * this task's port of the former Python `official_templates` module) lives on R2 under the
 * `official_templates/` prefix -- the SAME prefix `core/model_guide.ts`'s
 * `harvest()` already reads (Task 9's documented "guess", confirmed and kept
 * here rather than renamed, per this task's ledger note).
 *
 * Merge rule (ComfyFed-first, exactly `_merged_index`/the two index branches
 * in the former Python server):
 * - `index.json` -- ComfyFed's packaged categories, followed by the
 *   official library's categories if `official_templates/index.json`
 *   exists and parses as a list. Ours alone if the official side has
 *   nothing.
 * - `index.<locale>.json` -- merged the same way, but ONLY if the official
 *   dir has that exact localized index (no ours-alone fallback here); the
 *   "ours" half is always the base `index.json`, never a localized packaged
 *   file (the former Python server never read one either). Missing official copy is
 *   a 404, matching the frontend's own index.json fallback logic.
 * - `index_logo.json` -- official side only; no packaged copy is ever
 *   served here, so this 404s until an official fetch has run.
 * - Any other `<name>.json` -- packaged first (raw passthrough, byte-
 *   identical, per `test_own_template_workflow_still_served_byte_identical`
 *   parity), then official with `stripDownloadMetadata` applied. A
 *   non-dict/unparseable official JSON is served as raw bytes (never
 *   404s), matching `_cached_stripped_workflow` returning `None` and
 *   `template_file` falling through to `FileResponse`.
 * - Non-JSON files (thumbnails/media) -- packaged first, then official,
 *   raw passthrough either way, content-type from `MEDIA_TYPES` (stated
 *   outright, like Python, rather than guessed from a host content-type).
 *
 * Index-merge caching: a per-isolate cache keyed on the R2 *etag* of the
 * relevant `official_templates/<index file>` object (an R2 `head`, not a
 * full `get`) -- a changed/absent official index naturally invalidates the
 * cache; the packaged side is treated as static (no cache key contribution)
 * since `env.ASSETS.fetch`/the R2 fallback are cheap, small, static-asset
 * reads with nothing to invalidate against in a Worker's lifetime.
 *
 * Staging seed parity (the former Python `seed_staging`): on the first
 * `/comfy/templates/*` request an isolate serves, the packaged *input*
 * assets the templates reference (`amyntas_ref.png`,
 * `comfyfed_sample_clip.mp4` -- the former Python server's
 * `templates_data/assets/`, now `cloud/packaged/templates/assets/`) are
 * copied into R2 `staging/<name>` if not already present, so a
 * template's LoadImage/LoadVideo node resolves on the very first run.
 * "共用庫 / Shared library" (2026-09-20, parity with the former Python server): every
 * enabled `role = 'admin'` user's `workflows/templates/` folder is NOT
 * private -- it is published to everyone, un-prefixed. `<stem>.json` in an
 * admin's folder answers `/comfy/templates/<stem>.json` for every logged-in
 * user and resolves BEFORE packaged and official (an admin who saves
 * `comfyfed-wuxia-t2i` under the same name has replaced it for everyone).
 * In the index, ComfyFed's own (first) category is rewritten: same-named
 * entries keep their packaged card, new stems are appended sorted with
 * `{name: stem, title: stem}`. Admins therefore have no "我的範本" of their
 * own, and `my_<x>` never resolves for them. Several admins merge, uid
 * order, first owner of a name wins. Ordinary users are untouched: their
 * saves land in their own userdata and show only in their own "我的範本".
 *
 * "我的範本 / My templates" (parity with the former Python server's section of the
 * same name): the session
 * user's own userdata subfolder `workflows/templates/` is a third,
 * PRIVATE-to-that-user template source. Here that folder is the R2 prefix
 * `userdata/<uid>/workflows/templates/` (`lib/store.ts`'s `userdataPrefix`),
 * listed on every index request for the CURRENT session user and prepended
 * as the FIRST category when it has at least one `<name>.json`; each entry's
 * `name` is `my_<stem>`, and `GET /comfy/templates/my_<rest>` reads
 * `userdataKey(uid, "workflows/templates/" + rest)` -- so one user's request
 * can never reach another's file, admin included (same policy as userdata).
 * `<rest>` must round-trip through `sanitizePathComponent` unchanged (one
 * definition of "safe segment", so no traversal/subpath/device name).
 * PRECEDENCE, stated precisely: the user's own folder is tried FIRST and only
 * a MISS falls through to the packaged/official lookup, so a hypothetical
 * packaged/official template literally named `my_<x>` is reachable exactly
 * when this user has no `<x>.json` of their own -- if they do, THEIR file
 * wins, for them alone (a self-shadow, never a cross-user one), and the flat
 * index namespace can then carry two `my_<x>` entries. With `comfyfed-*` and
 * today's official library that cannot happen, and it would be cosmetic if it
 * ever did. The per-user category is deliberately computed OUTSIDE
 * `mergedIndexCache` -- that cache is keyed on R2 etags and shared by every
 * isolate's requests, so caching a uid-specific half in it would leak one
 * user's template list to the next requester.
 *
 * Memoized per isolate on a PER-ASSET basis (a module-level `Set`,
 * `seededAssets`) rather than one all-or-nothing flag: a name is only
 * memoized once its copy has actually succeeded (or was already present),
 * so a transient failure (a throwing R2 `put`, a not-yet-available packaged
 * source) retries just that asset on the next request instead of giving up
 * on the whole batch forever. Per-file idempotent otherwise too (an existing
 * `staging/<name>` object is left alone, exactly like Python's "admin may
 * have replaced it deliberately" rationale) -- `clearTemplatesCacheForTests`
 * resets both caches for test isolation.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { requireUser, SESSION_VAR } from "../lib/guard";
import { stagingKey, SHARED_STAGING_UID, sanitizePathComponent, userdataKey, userdataPrefix } from "../lib/store";
import { OFFICIAL_TEMPLATES_PREFIX } from "../core/model_guide";
import { listActiveAdminIds } from "../db/queries";

// Content types stated outright, exactly mirroring the former Python
// `_MEDIA_TYPES` comment: the frontend hard-checks `templates/index.json`'s
// content-type and silently shows an empty browser on anything else, so
// this cannot be left to a host's guess.
const MEDIA_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
};

/** Packaged (ComfyFed's own) template files -- ASSETS binding path prefix
 * AND the R2 fallback prefix (kept identical on purpose: same relative
 * layout, two possible sources). */
const COMFYFED_PREFIX = "comfyfed_templates/";

/** Official ComfyUI template library, seeded by `scripts/seed-official.mjs`
 * into R2. Re-exported from `core/model_guide.ts` (Task 9's `harvest()`
 * already reads this prefix) so both files read the exact same constant --
 * see this module's docstring. */
export const OFFICIAL_PREFIX = OFFICIAL_TEMPLATES_PREFIX;

/** Library bookkeeping under the official prefix, never a template. */
const NON_TEMPLATE_NAMES = new Set(["manifest.json"]);

/** The packaged input assets `seed_staging` copies into R2 `staging/` --
 * ports the former Python `asset_names()` (there, a directory listing of
 * the former Python server's `templates_data/assets/` -- that directory no
 * longer exists, the assets are in `cloud/packaged/templates/assets/`; here,
 * a fixed list since a Worker cannot list
 * the ASSETS binding's contents). Keep in sync with whatever Task 11 places
 * under `assets/comfyfed_templates/assets/`. */
const SEED_ASSET_NAMES = ["amyntas_ref.png", "comfyfed_sample_clip.mp4", "nsfw_i2v_ref.jpg"];

function extOf(filename: string): string {
  const i = filename.lastIndexOf(".");
  return i === -1 ? "" : filename.slice(i).toLowerCase();
}

/** Ports `template_file`'s filename guard: no subpaths, no drive letters
 * (Windows `os.path.join` would otherwise resolve `C:x.json` as
 * drive-relative and escape both roots -- R2 keys and the ASSETS binding
 * don't have that Windows-specific footgun, but rejecting `:` costs
 * nothing and keeps the two implementations' accepted-filename sets
 * identical). */
function isSafeFilename(filename: string): boolean {
  return (
    !!filename &&
    filename !== "." &&
    filename !== ".." &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    !filename.includes(":")
  );
}

const DOWNLOAD_KEYS = new Set(["url", "hash", "hash_type"]);

/** Drop `url`/`hash`/`hash_type` from every model entry the frontend could
 * turn into a Download button, keeping `name` + `directory`. Byte-for-byte
 * port of the former Python `_strip_download_metadata`: fully recursive
 * (reaches `nodes[].properties.models`, a top-level `models` list, AND
 * `definitions.subgraphs[].nodes[].properties.models` via the same generic
 * walk, not per-location enumeration), touches only dict entries that carry
 * a `name` key, and passes non-dict entries (plain-string model names)
 * through unchanged. Exported for `templates.spec.ts`'s parity fixtures. */
export function stripDownloadMetadata(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDownloadMetadata);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (key === "models" && Array.isArray(val)) {
      result[key] = val.map((entry) => {
        if (typeof entry === "object" && entry !== null && !Array.isArray(entry) && "name" in entry) {
          const out: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(entry as Record<string, unknown>)) {
            if (!DOWNLOAD_KEYS.has(k)) out[k] = v;
          }
          return out;
        }
        return entry;
      });
    } else {
      result[key] = stripDownloadMetadata(val);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Packaged-file loading: ASSETS binding first, R2 `comfyfed_templates/`
// fallback second. Returns raw bytes -- content-type is always decided by
// `MEDIA_TYPES`/the caller, never trusted from either source, matching
// Python's explicit-mapping stance.

async function fetchPackagedRaw(env: Env, filename: string): Promise<ArrayBuffer | null> {
  try {
    const req = new Request(`https://assets.internal/${COMFYFED_PREFIX}${filename}`);
    const res = await env.ASSETS.fetch(req);
    if (res.ok) {
      return await res.arrayBuffer();
    }
  } catch (err) {
    // ASSETS binding unavailable (e.g. no assets built yet) -- fall through
    // to the R2 fallback rather than failing the request.
    console.warn("templates: ASSETS.fetch failed for", filename, err);
  }

  const obj = await env.STORE.get(`${COMFYFED_PREFIX}${filename}`);
  return obj ? await obj.arrayBuffer() : null;
}

async function loadPackagedJson(env: Env, filename: string): Promise<unknown> {
  const raw = await fetchPackagedRaw(env, filename);
  if (raw === null) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8").decode(raw));
  } catch {
    return null;
  }
}

async function loadOfficialJson(store: R2Bucket, filename: string): Promise<unknown> {
  const obj = await store.get(`${OFFICIAL_PREFIX}${filename}`);
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text());
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Index merge, cached per-isolate on a compound token built from R2 HEADs of
// BOTH sides that can change at runtime: the official index object AND the
// `comfyfed_templates/` R2 override (an operator may put an override there
// even once Task 11 ships real ASSETS-bound files -- see `fetchPackagedRaw`).
// The ASSETS-binding copy is NOT part of the token: it's build-time static
// for the life of an isolate, so there's nothing to invalidate against
// (review round 1, m1: an R2 override's etag must be part of the cache key,
// or a stale "ours" half could be served forever once cached -- chosen over
// the "invalidate whenever the packaged lookup misses" alternative because
// it's exactly as simple and additionally catches an override being EDITED,
// not just added/removed).

interface MergedCacheEntry {
  key: string;
  value: unknown[] | null;
}

const mergedIndexCache = new Map<string, MergedCacheEntry>();

/** `official:<etag-or-none>|packaged:<etag-or-none>` for `officialFilename`'s
 * official-side object and `packagedFilename`'s `comfyfed_templates/` R2
 * override (the two are the same file for the base `index.json` case, but
 * differ for a locale index -- see `localizedMergedIndex`, whose "ours" half
 * is always the base `index.json`). Returns the official HEAD alongside the
 * token so callers don't need a second `head` call to know whether the
 * official side exists at all. */
async function cacheToken(
  env: Env,
  officialFilename: string,
  packagedFilename: string
): Promise<{ token: string; officialHead: R2Object | null }> {
  const [officialHead, packagedHead] = await Promise.all([
    env.STORE.head(`${OFFICIAL_PREFIX}${officialFilename}`),
    env.STORE.head(`${COMFYFED_PREFIX}${packagedFilename}`),
  ]);
  const token = `official:${officialHead?.etag ?? "none"}|packaged:${packagedHead?.etag ?? "none"}`;
  return { token, officialHead: officialHead ?? null };
}

/** Test-only escape hatch: resets both the index-merge cache and the
 * staging-seed memoization, mirroring the other route files' `clear*ForTests`
 * exports (see `comfyapi.ts`'s `clearObjectInfoCacheForTests`). */
export function clearTemplatesCacheForTests(): void {
  mergedIndexCache.clear();
  seededAssets.clear();
}

/** `index.json`: ComfyFed's packaged categories, then the official
 * library's, if present and parseable -- ports `_merged_index`. */
async function mergedIndex(env: Env): Promise<unknown[] | null> {
  const { token, officialHead } = await cacheToken(env, "index.json", "index.json");

  const cached = mergedIndexCache.get("index.json");
  if (cached && cached.key === token) return cached.value;

  const ours = await loadPackagedJson(env, "index.json");
  const oursList = Array.isArray(ours) ? ours : [];
  const official = officialHead ? await loadOfficialJson(env.STORE, "index.json") : null;

  let value: unknown[] | null;
  if (Array.isArray(official)) {
    value = [...oursList, ...official];
  } else {
    value = Array.isArray(ours) ? ours : null;
  }

  mergedIndexCache.set("index.json", { key: token, value });
  return value;
}

/** `index.<locale>.json`: merged the same way, but the official side MUST
 * exist and parse as a list -- no ours-alone fallback -- ports the second
 * `template_file` index branch. The "ours" half is always the base
 * `index.json`, never a localized packaged file. */
async function localizedMergedIndex(env: Env, filename: string): Promise<unknown[] | null> {
  const { token, officialHead } = await cacheToken(env, filename, "index.json");

  const cacheMapKey = `locale:${filename}`;
  const cached = mergedIndexCache.get(cacheMapKey);
  if (cached && cached.key === token) return cached.value;

  let value: unknown[] | null = null;
  if (officialHead) {
    const official = await loadOfficialJson(env.STORE, filename);
    if (Array.isArray(official)) {
      const ours = await loadPackagedJson(env, "index.json");
      value = [...(Array.isArray(ours) ? ours : []), ...official];
    }
  }

  mergedIndexCache.set(cacheMapKey, { key: token, value });
  return value;
}

// ---------------------------------------------------------------------------
// "我的範本 / My templates" -- ports the former Python section of the same name.

/** Userdata subfolder whose `<name>.json` files are a user's personal
 * templates. `workflows/` is where the panel's workflow browser already
 * saves, so "Save As `templates/<name>`" lands here with no new UI. */
export const MY_TEMPLATES_SUBDIR = "workflows/templates";

/** Namespacing prefix for a personal template's `name` (and therefore its
 * `/comfy/templates/...` URL), keeping the flat template namespace
 * collision-free against `comfyfed-*` and the official library. */
export const MY_TEMPLATES_PREFIX = "my_";

/** zh-TW first, English second; doubles as the sidebar `category` group
 * name so the category has a home, exactly like ComfyFed's own. */
export const MY_TEMPLATES_TITLE = "我的範本 / My templates";

/** Thumbnail extensions probed for `<stem>-1.<ext>`, in preference order --
 * all of them present in `MEDIA_TYPES`. */
const MY_THUMBNAIL_EXTENSIONS = [".webp", ".png", ".jpg", ".jpeg"];

/** True when `name` survives `sanitizePathComponent` unchanged. The accepted
 * charset for a personal template filename is *defined* as "whatever the
 * userdata sanitizer accepts" rather than restated as a regex: a name that
 * would not round-trip could never be fetched back through
 * `/comfy/templates/my_<name>`, so it must not be listed in the index
 * either. Ports `_round_trips`. */
function roundTrips(name: string): boolean {
  try {
    return sanitizePathComponent(name) === name;
  } catch {
    return false;
  }
}

/** `index.json` entries for `uid`'s personal templates, sorted by name --
 * ports `my_template_entries`. One entry per `<stem>.json` directly inside
 * the folder (no recursion: the frontend's template namespace is flat);
 * `mediaType`/`mediaSubtype` only when a sibling `<stem>-1.<ext>` actually
 * exists, since a stated `mediaSubtype` is what makes the frontend build
 * (and fail to load) a thumbnail URL. */
/** Flat filenames directly inside `uid`'s `workflows/templates/` (the
 * `os.listdir` + `isfile` half of Python's `my_template_entries` /
 * `shared_template_files`); empty on an unsanitizable uid or an R2 failure. */
async function listTemplateFolder(env: Env, uid: string): Promise<Set<string>> {
  let prefix: string;
  try {
    prefix = userdataPrefix(uid, MY_TEMPLATES_SUBDIR);
  } catch {
    return new Set();
  }

  // R2 LIST is paginated; a user with many saved templates must still see
  // all of them (same drain shape as comfyapi.ts's userdata listing).
  //
  // `delimiter: "/"` keeps a deep tree under `workflows/templates/` from
  // being transferred and then discarded: R2 collapses everything below the
  // flat level into `delimitedPrefixes`, which we never read, so only the
  // level that can actually hold a template is paid for. The client-side
  // `rel.includes("/")` filter below stays as belt-and-braces -- it is also
  // the twin of Python's `os.path.isfile` check.
  //
  // The whole drain is wrapped: a transient R2 failure must degrade to "this
  // user has no personal templates" (dropping one category) rather than 500
  // the entire index -- exactly what Python's `except OSError: return []`
  // around `os.listdir` does.
  const names = new Set<string>();
  try {
    let cursor: string | undefined;
    do {
      const page = await env.STORE.list({ prefix, cursor, delimiter: "/" });
      for (const obj of page.objects) {
        const rel = obj.key.slice(prefix.length);
        // Flat only -- an object one level deeper is somebody's subfolder,
        // not a template (Python's `os.path.isfile` check does the same).
        if (rel && !rel.includes("/")) names.add(rel);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  } catch (err) {
    console.warn("templates: could not list personal templates", err);
    return new Set();
  }
  return names;
}

export async function myTemplateEntries(env: Env, uid: string): Promise<Record<string, unknown>[]> {
  const names = await listTemplateFolder(env, uid);

  const entries: Record<string, unknown>[] = [];
  for (const filename of [...names].sort()) {
    if (!filename.endsWith(".json") || !roundTrips(filename)) continue;
    const stem = filename.slice(0, -".json".length);
    if (!stem) continue;

    const entry: Record<string, unknown> = {
      name: MY_TEMPLATES_PREFIX + stem,
      title: stem,
      description: "",
    };
    for (const extension of MY_THUMBNAIL_EXTENSIONS) {
      const thumbnail = `${stem}-1${extension}`;
      if (names.has(thumbnail) && roundTrips(thumbnail)) {
        entry.mediaType = "image";
        entry.mediaSubtype = extension.slice(1);
        break;
      }
    }
    entries.push(entry);
  }
  return entries;
}

/** The one category to put FIRST in the index, or `null` when this user has
 * no personal templates (an empty group is worse than no group) -- ports
 * `my_templates_category`. */
async function myTemplatesCategory(env: Env, uid: string): Promise<Record<string, unknown> | null> {
  const templates = await myTemplateEntries(env, uid);
  if (templates.length === 0) return null;
  return {
    moduleName: "default",
    title: MY_TEMPLATES_TITLE,
    type: "image",
    isEssential: true,
    category: MY_TEMPLATES_TITLE,
    templates,
  };
}

/** `index.json` and `index.<locale>.json` stopped being the same bytes for
 * every user the moment "我的範本" was merged into them, so they must never be
 * held in a shared cache. Worker responses are not edge-cached by default,
 * but an operator adding a "Cache Everything" rule (or any intermediary)
 * would otherwise be able to hand one user's category to another. Ports
 * the former Python `_INDEX_CACHE_HEADERS`. */
const INDEX_CACHE_CONTROL = "private, no-store";

/** `categories` with the session user's own category prepended -- ports
 * `_with_my_templates`. Never cached: see this module's docstring. */
async function withMyTemplates(
  env: Env,
  user: { uid: string; role: string },
  categories: unknown[]
): Promise<unknown[]> {
  // An admin's folder IS the shared library (already folded into the
  // ComfyFed category by `withSharedTemplates`), never a private one too.
  if (user.role === "admin") return [...categories];
  const mine = await myTemplatesCategory(env, user.uid);
  return mine === null ? [...categories] : [mine, ...categories];
}

// ---------------------------------------------------------------------------
// "共用庫 / Shared library" -- ports the former Python section of the same name.

/** Title of the synthetic category used only when the packaged index has no
 * category to fold the admin files into (never the case in practice). */
export const SHARED_TEMPLATES_TITLE = "ComfyFed";

/** `filename -> R2 key` for every flat file in every enabled admin's
 * template folder; admins visited in sorted-uid order, first owner of a name
 * wins -- ports `shared_template_files`. Never cached: the admin can change
 * it with any save, and the index is `private, no-store` anyway. */
export async function sharedTemplateFiles(env: Env): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const uid of await listActiveAdminIds(env.DB)) {
    const names = await listTemplateFolder(env, uid);
    for (const name of [...names].sort()) {
      if (files.has(name) || !roundTrips(name)) continue;
      try {
        files.set(name, userdataKey(uid, `${MY_TEMPLATES_SUBDIR}/${name}`));
      } catch {
        // unsanitizable -- already excluded by roundTrips, belt and braces
      }
    }
  }
  return files;
}

/** The R2 object for `filename` in the shared library, or null -- ports
 * `shared_template_path`. */
async function sharedTemplateObject(env: Env, filename: string): Promise<R2ObjectBody | null> {
  if (!roundTrips(filename)) return null;
  for (const uid of await listActiveAdminIds(env.DB)) {
    let key: string;
    try {
      key = userdataKey(uid, `${MY_TEMPLATES_SUBDIR}/${filename}`);
    } catch {
      continue;
    }
    const obj = await env.STORE.get(key);
    if (obj) return obj;
  }
  return null;
}

function sharedEntry(stem: string, files: Map<string, string>): Record<string, unknown> {
  const entry: Record<string, unknown> = { name: stem, title: stem, description: "" };
  for (const extension of MY_THUMBNAIL_EXTENSIONS) {
    if (files.has(`${stem}-1${extension}`)) {
      entry.mediaType = "image";
      entry.mediaSubtype = extension.slice(1);
      break;
    }
  }
  return entry;
}

/** `categories` with the admin-published files folded into the first
 * category that has a `templates` list (ComfyFed's own): same-named entries
 * keep their card, new stems are appended sorted. Copies, never mutates --
 * the merged index behind it is cached. Ports `_with_shared_templates`. */
async function withSharedTemplates(env: Env, categories: unknown[]): Promise<unknown[]> {
  const files = await sharedTemplateFiles(env);
  const stems = [...files.keys()]
    .filter((name) => name.endsWith(".json") && name.length > ".json".length)
    .map((name) => name.slice(0, -".json".length))
    .sort();
  if (stems.length === 0) return [...categories];

  const out = [...categories];
  const target = out.findIndex(
    (c) => typeof c === "object" && c !== null && Array.isArray((c as Record<string, unknown>).templates)
  );
  if (target === -1) {
    out.unshift({
      moduleName: "default",
      title: SHARED_TEMPLATES_TITLE,
      type: "image",
      isEssential: true,
      category: SHARED_TEMPLATES_TITLE,
      templates: stems.map((stem) => sharedEntry(stem, files)),
    });
    return out;
  }

  const category = { ...(out[target] as Record<string, unknown>) };
  const existing = (category.templates as unknown[]).map((t) =>
    typeof t === "object" && t !== null ? { ...(t as Record<string, unknown>) } : t
  );
  const known = new Set(
    existing.map((t) => (typeof t === "object" && t !== null ? (t as Record<string, unknown>).name : undefined))
  );
  for (const stem of stems) {
    if (!known.has(stem)) existing.push(sharedEntry(stem, files));
  }
  category.templates = existing;
  out[target] = category;
  return out;
}

// ---------------------------------------------------------------------------
// Staging seed -- ports `seed_staging`, sourced from the packaged assets
// (ASSETS binding first, R2 `comfyfed_templates/assets/<name>` fallback,
// same two-source lookup as everything else packaged in this file).

// Per-ASSET memoization (review round 1, M1): each name is only added here
// AFTER its copy into R2 `staging/` has actually succeeded (or was already
// present). A transient failure -- the R2 `put` throwing, or the packaged
// source not being available yet -- leaves that name OUT of the set, so the
// very next `/comfy/templates/*` request retries just that asset, instead of
// the earlier all-or-nothing `stagingSeeded` boolean permanently giving up
// on every asset in the batch after one failure.
const seededAssets = new Set<string>();

async function seedStagingOnce(env: Env): Promise<void> {
  for (const name of SEED_ASSET_NAMES) {
    if (seededAssets.has(name)) continue;

    try {
      // Seeded into the SHARED pseudo-uid namespace, not any one user's own
      // staging -- these are platform-shipped public samples that every
      // user's templates must resolve against (final review finding #1
      // namespaced staging by uid; the shared samples are the one
      // deliberate exception).
      const key = stagingKey(SHARED_STAGING_UID, name);
      const existing = await env.STORE.head(key);
      if (existing) {
        seededAssets.add(name); // an admin may have replaced it deliberately
        continue;
      }

      const body = await fetchPackagedRaw(env, `assets/${name}`);
      if (body === null) continue; // packaged source not available (yet) -- retry next request

      await env.STORE.put(key, body);
      seededAssets.add(name); // only mark done once the put actually succeeded
    } catch (err) {
      console.warn("templates: could not seed staging asset", name, err);
      // Deliberately NOT added to seededAssets -- retried on the next request.
    }
  }
}

// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Any logged-in user may load templates, matching the Python stack (whose
// template route carries no gate of its own and relies on the /comfy session
// gate, which admits any authenticated user). Was requireAdmin, which both
// blocked users from templates entirely and diverged from the Python twin.
app.use("/comfy/templates/*", requireUser);

app.get("/comfy/templates/:filename", async (c) => {
  const filename = c.req.param("filename");
  if (!isSafeFilename(filename) || NON_TEMPLATE_NAMES.has(filename)) {
    return c.body(null, 404);
  }

  await seedStagingOnce(c.env);

  // Needed to resolve "我的範本" against the RIGHT user's userdata prefix,
  // and to skip the private view for admins (whose folder is the shared one).
  const user = c.get(SESSION_VAR).user;
  const uid = user.uid;

  if (filename === "index_logo.json") {
    const logo = await loadOfficialJson(c.env.STORE, filename);
    if (logo === null) return c.body(null, 404);
    return c.json(logo as Record<string, unknown>);
  }

  if (filename === "index.json") {
    const merged = await mergedIndex(c.env);
    if (merged === null) return c.body(null, 404);
    c.header("Cache-Control", INDEX_CACHE_CONTROL);
    return c.json(await withMyTemplates(c.env, user, await withSharedTemplates(c.env, merged)));
  }

  if (filename.startsWith("index.") && filename.endsWith(".json")) {
    const merged = await localizedMergedIndex(c.env, filename);
    if (merged === null) return c.body(null, 404);
    c.header("Cache-Control", INDEX_CACHE_CONTROL);
    return c.json(await withMyTemplates(c.env, user, await withSharedTemplates(c.env, merged)));
  }

  const mediaType = MEDIA_TYPES[extOf(filename)] ?? "application/octet-stream";

  // "我的範本": `my_<rest>` resolves inside the SESSION USER's own
  // `workflows/templates/` FIRST, never anyone else's. Only on a miss does it
  // fall through to the packaged/official lookup below (see this module's
  // precedence note) -- so an unknown name is still a 404, and a
  // packaged/official `my_<x>` stays reachable unless this user happens to
  // own `<x>.json`, in which case theirs wins for them. Served raw, never
  // download-metadata stripped: it is the user's own graph, like ComfyFed's
  // packaged ones.
  // An admin has no private library (theirs is the shared one, served
  // un-prefixed below), so the `my_` spelling never resolves for them.
  if (filename.startsWith(MY_TEMPLATES_PREFIX) && user.role !== "admin") {
    const rest = filename.slice(MY_TEMPLATES_PREFIX.length);
    if (roundTrips(rest)) {
      let key: string | null = null;
      try {
        key = userdataKey(uid, `${MY_TEMPLATES_SUBDIR}/${rest}`);
      } catch {
        key = null;
      }
      const mine = key === null ? null : await c.env.STORE.get(key);
      if (mine) {
        return new Response(await mine.arrayBuffer(), { headers: { "content-type": mediaType } });
      }
    }
  }

  // 共用庫: an admin's file of this exact name beats packaged/official for
  // EVERY user -- that is how an admin "modifies" a platform template. Raw,
  // like packaged: it is a graph an admin chose to ship.
  const shared = await sharedTemplateObject(c.env, filename);
  if (shared) {
    return new Response(await shared.arrayBuffer(), { headers: { "content-type": mediaType } });
  }

  const packaged = await fetchPackagedRaw(c.env, filename);
  if (packaged !== null) {
    return new Response(packaged, { headers: { "content-type": mediaType } });
  }

  const officialObj = await c.env.STORE.get(`${OFFICIAL_PREFIX}${filename}`);
  if (!officialObj) return c.body(null, 404);

  if (extOf(filename) === ".json") {
    const text = await officialObj.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return c.json(stripDownloadMetadata(parsed) as Record<string, unknown>);
    }
    // Not a JSON object (unparseable/array/etc.) -- serve raw, same as
    // `_cached_stripped_workflow` returning None and `template_file`
    // falling through to `FileResponse`.
    return c.body(text, 200, { "content-type": mediaType });
  }

  return new Response(await officialObj.arrayBuffer(), { headers: { "content-type": mediaType } });
});

export default app;
