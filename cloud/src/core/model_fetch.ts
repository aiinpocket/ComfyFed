/**
 * Panel "Download" button -> `kind=model_fetch` job (spec 2026-09-19 §5-§6).
 *
 * Cloud twin of `server/comfyfed_server/model_fetch.py`, read in full -- see
 * that module's docstring for the trust model this mirrors: a worker
 * downloads only platform-signed entries, and a model the platform has no
 * learned/curated hash for is dispatched as an *unverified-source* entry --
 * the url itself is in the signed payload, the url's origin must be in
 * `TRUSTED_ORIGINS`, and the worker reports the real sha256 on completion so
 * the platform learns it (`do/hub.ts`'s `learnFetchedModels`).
 *
 * The HTTP routes live in `routes/comfyapi.ts` and the dispatch/job_done
 * wiring in `do/hub.ts`, exactly as the Python split has them in
 * `comfyapi.py`/`agentws.py`.
 */

import * as assess from "./assess";
import * as modelManifest from "./model_manifest";
import type { ManifestEntry } from "./model_manifest";
import * as queries from "../db/queries";
import { toSqliteTimestamp, resolvePlatformSeed } from "../db/queries";
import { signHex } from "../lib/ed25519";
import type { Env } from "../env";

export const TRUSTED_ORIGINS: ReadonlySet<string> = new Set([
  "https://huggingface.co",
  "https://civitai.com",
]);

const HEAD_TIMEOUT_MS = 10_000;
/** Redirect hops `headSizeBytes` will follow by hand before giving up
 * (final-review I4). Mirrors model_fetch.py's `_HEAD_MAX_REDIRECTS`. */
const HEAD_MAX_REDIRECTS = 5;

/** An unverified-source manifest entry (spec §6): no content hash exists yet,
 * so `sha256`/`backup_url` are explicit nulls and the `unverified` flag is
 * what both the agent's shape validator and the dispatch protocol gate key
 * off. Structurally NOT a `ManifestEntry` (whose `sha256` is a string), which
 * is why `FetchEntry` below is the union every consumer of a job's
 * `fetch_entry` must accept. */
export interface UnverifiedManifestEntry {
  name: string;
  directory: string;
  url: string;
  backup_url: null;
  sha256: null;
  size_bytes: number;
  unverified: true;
  sig: string;
}

/** What a `model_fetch` job's `fetch_entry` column can hold, and what the
 * dispatch tick's `manifestByName` map therefore has to be able to carry: a
 * verified manifest entry (curated hash / learned consensus / peer-only) or
 * an unverified-source one. */
export type FetchEntry = ManifestEntry | UnverifiedManifestEntry;

/** Whether `url`'s PARSED origin (scheme + host, lowercased) is in
 * `TRUSTED_ORIGINS` -- ports model_fetch.py's `is_trusted_url`.
 *
 * Deliberately not a string-prefix test: `https://huggingface.co.evil.com/x`
 * starts with `https://huggingface.co` but is a wholly different origin, and
 * the signed unverified entry's only trust root is "the platform approved
 * THIS url" (§6), so the host must be matched exactly. A non-443 explicit
 * port is rejected for the same reason -- it is a different endpoint than the
 * origin the allowlist vouches for. (`new URL` already strips an explicit
 * `:443` from an https url, so `port === ""` covers both "no port" and "the
 * default port spelled out", matching Python's `parts.port in (None, 443)`.) */
export function isTrustedUrl(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) return false;
  if (parsed.port !== "") return false;
  return TRUSTED_ORIGINS.has(`https://${parsed.hostname.toLowerCase()}`);
}

/** 轉址第二跳之後只看這組「內網禁區」尾碼，不看白名單。Suffixes of names that
 * never belong to a public CDN; a redirect hop landing on one is refused.
 * Mirrors model_fetch.py's `_INTERNAL_HOST_SUFFIXES`. */
const INTERNAL_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/** Whether a redirect hop AFTER hop 0 may be requested (final-fix N1) --
 * ports model_fetch.py's `is_safe_redirect_target`.
 *
 * 為什麼第二跳之後放寬：HuggingFace 的 `…/resolve/…` 一定會 302 到
 * `cdn-lfs*.hf.co` / `cas-bridge.xethub.hf.co`，Civitai 的下載連結會 302 到 R2
 * 派送網域。對每一跳都套嚴格白名單 = 真實下載網址一個都過不了，unverified 來源
 * （這顆按鈕存在的理由）永遠建不出 job。
 * Why later hops are looser: real HuggingFace `…/resolve/…` urls always hand
 * off to a `cdn-lfs*.hf.co` / `cas-bridge.xethub.hf.co` CDN host, and Civitai
 * downloads hand off to an R2 delivery host. Applying the strict origin
 * allowlist to every hop refuses every real download url, so the
 * unverified-source path could never create a job.
 *
 * 放寬的只是「網域」，SSRF 規則一步都沒讓：仍然只准 https、只准 443（或不寫
 * port）、不准帶 userinfo、不准 IP 字面值（v4/v6，含中括號）、不准 localhost 或
 * `.localhost/.local/.internal/.home.arpa` 結尾。信任沒有被稀釋：簽章裡釘的仍然
 * 是 hop 0 那個白名單網址，後面的跳躍只提供 `Content-Length`。
 * Only the *hostname* rule is relaxed; the SSRF rule is not. A later hop must
 * still be https, on port 443 (or no explicit port), carry no userinfo, and
 * have a hostname that is neither an IP literal (v4 or v6, bracketed or not)
 * nor `localhost` nor anything under `.localhost/.local/.internal/.home.arpa`
 * -- so loopback, LAN, link-local and internal names are still refused. Trust
 * is not diluted: the signed entry still pins hop 0's allowlisted url, and
 * later hops only supply a `Content-Length`. */
export function isSafeRedirectTarget(url: unknown): boolean {
  if (typeof url !== "string" || !url) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  // `new URL` strips an explicit `:443` from an https url, so `port === ""`
  // covers both "no port" and "the default port spelled out" -- the same
  // equivalence `isTrustedUrl` relies on, matching Python's `in (None, 443)`.
  if (parsed.port !== "") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  // A trailing dot is a legal absolute-FQDN spelling of the same name, so
  // `foo.internal.` must not slip past the suffix test.
  const host = parsed.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return false;
  if (host === "localhost") return false;
  if (INTERNAL_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  // WHATWG `hostname` keeps the brackets on an IPv6 literal and normalizes an
  // IPv4 one to dotted-quad; a host of only digits and dots is never a real
  // DNS name either. Same rule as the Python twin's `ipaddress` test.
  if (host.startsWith("[") || host.includes(":")) return false;
  if (/^[0-9.]+$/.test(host)) return false;
  return true;
}

/** `code` is "gated" (401/403), "untrusted_url" (a redirect hop left the
 * allowlist -- deliberately the SAME code the pre-HEAD allowlist check
 * throws, since it is the same refusal and the panel's message table already
 * says exactly the right thing) or "size_unknown" (anything else) -- ports
 * model_fetch.py's `HeadError`. */
export class HeadError extends Error {
  readonly code: string;

  constructor(code: string, detail = "") {
    super(detail || code);
    this.name = "HeadError";
    this.code = code;
  }
}

/** Probes `url` with a HEAD (10 s timeout) whose redirects are followed BY
 * HAND so that every hop can be allowlist-checked before it is requested, and
 * returns the exact byte length it advertises via `Content-Length` -- ports
 * model_fetch.py's `head_size_bytes`.
 *
 * The signed entry pins `size_bytes` (§6) and an unverified entry has no
 * sha256 for the agent to check instead -- so a source that will not state
 * its length cannot be dispatched at all (`size_unknown`), and a source that
 * demands a login (401/403) is `gated` and reported as such rather than being
 * retried by a worker that has no credentials either.
 *
 * Redirects use `redirect: "manual"` (final-review I4). The caller checks the
 * allowlist before the first request, but `redirect: "follow"` would then let
 * an attacker-influenced huggingface/civitai url bounce the platform at an
 * arbitrary origin -- an SSRF / port oracle that any logged-in user could aim,
 * and one that the 400's own codes (`gated` for 401/403 vs `size_unknown` for
 * everything else) would answer. The Workers stack has no internal network to
 * reach, so this is parity with the self-hosted stack more than a live
 * exposure -- but it is the same code on both sides, which is the point. Every
 * hop is checked before it is requested and the chain is capped at
 * `HEAD_MAX_REDIRECTS`.
 *
 * Hop 0（使用者給的網址）走嚴格白名單 `isTrustedUrl`；之後每一跳走
 * `isSafeRedirectTarget`（HF/Civitai 一定會轉到 CDN 網域，見該函式的說明），兩者
 * 都用同一個 `untrusted_url` 代碼。
 * Hop 0 (the user-supplied url) is checked with the strict origin allowlist
 * `isTrustedUrl`; every later hop is checked with `isSafeRedirectTarget` (HF/
 * Civitai always hand off to a CDN host -- see that function), both refusing
 * with the same `untrusted_url` code.
 *
 * `fetchImpl` exists so tests can inject a fake (the Python twin injects an
 * `httpx.MockTransport` client factory for the same reason); production uses
 * the Workers runtime's global `fetch`. */
export async function headSizeBytes(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<number> {
  let resp: Response | undefined;
  let current = url;
  for (let hop = 0; hop <= HEAD_MAX_REDIRECTS; hop++) {
    const ok = hop === 0 ? isTrustedUrl(current) : isSafeRedirectTarget(current);
    if (!ok) {
      throw new HeadError("untrusted_url", `redirect to ${current}`);
    }
    try {
      resp = await fetchImpl(current, {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
      });
    } catch (err) {
      // Network error, DNS failure, TLS failure, or the 10 s abort -- all of
      // them are "this source would not tell us its length", same as Python's
      // single `httpx.HTTPError` catch (which covers its timeout too).
      throw new HeadError("size_unknown", String(err));
    }
    if (!(resp.status >= 300 && resp.status < 400)) break;
    const location = resp.headers.get("location");
    if (!location) {
      throw new HeadError("size_unknown", `HTTP ${resp.status} without Location`);
    }
    // Relative Locations are legal and common; resolve against the hop that
    // issued them so the allowlist sees the real absolute url next pass.
    try {
      current = new URL(location, current).toString();
    } catch {
      throw new HeadError("size_unknown", `unparseable Location ${location}`);
    }
    resp = undefined;
  }
  if (resp === undefined) {
    throw new HeadError("size_unknown", "too many redirects");
  }
  if (resp.status === 401 || resp.status === 403) {
    throw new HeadError("gated", `HTTP ${resp.status}`);
  }
  if (!(resp.status >= 200 && resp.status < 300)) {
    throw new HeadError("size_unknown", `HTTP ${resp.status}`);
  }
  const raw = resp.headers.get("content-length");
  // Python does `int(raw)` and treats a ValueError as 0. `Number("")` is 0
  // and `Number("1e3")` is 1000, neither of which `int()` accepts, so the
  // parse is an explicit integer-literal test rather than a bare `Number`.
  let size = 0;
  if (raw !== null) {
    const trimmed = raw.trim();
    if (/^[+-]?\d+$/.test(trimmed)) size = Number(trimmed);
  }
  if (!Number.isFinite(size) || size <= 0) {
    throw new HeadError("size_unknown", "no Content-Length");
  }
  return size;
}

/** The Ed25519 payload for an unverified-source entry (spec §6) -- ports
 * model_fetch.py's `unverified_payload`.
 *
 * Byte-exact and mirrored by the agent's `fetcher._verify_entry_signature`
 * and the Python stack -- the trailing `|unverified` literal is what keeps it
 * from ever colliding with the verified `name|directory|sha256|size` payload
 * (`lib/signing.ts`'s `buildManifestEntryPayload`), so neither shape can be
 * replayed as the other. */
export function unverifiedPayload(
  name: string,
  directory: string,
  url: string,
  sizeBytes: number
): string {
  return `${name}|${directory}|${url}|${sizeBytes}|unverified`;
}

/** Sign an unverified-source manifest entry with the platform key -- ports
 * model_fetch.py's `sign_unverified_entry`. Uses the same Ed25519 helper
 * `model_manifest.ts` signs its own entries with, so a fetch entry minted
 * here and one minted there are indistinguishable to the agent's verifier
 * apart from the payload shape.
 *
 * `sha256`/`backup_url` are explicitly null: there is no known content hash
 * yet (that is the whole point -- the worker reports the real one on
 * completion, §9) and no content-addressed fallback source exists without
 * one, so no GCS mirror and no peer pull for this entry (§3). */
export async function signUnverifiedEntry(
  seedHex: string,
  fields: { name: string; directory: string; url: string; sizeBytes: number }
): Promise<UnverifiedManifestEntry> {
  const payload = unverifiedPayload(fields.name, fields.directory, fields.url, fields.sizeBytes);
  const sig = await signHex(seedHex, new TextEncoder().encode(payload));
  return {
    name: fields.name,
    directory: fields.directory,
    url: fields.url,
    backup_url: null,
    sha256: null,
    size_bytes: fields.sizeBytes,
    unverified: true,
    sig,
  };
}

/** Whether `entry` is an unverified-source entry -- the one flag both the
 * agent's shape validator and the dispatch protocol gate key off. Ports
 * model_fetch.py's `is_unverified_entry`. */
export function isUnverifiedEntry(entry: unknown): boolean {
  return (
    typeof entry === "object" &&
    entry !== null &&
    !Array.isArray(entry) &&
    (entry as Record<string, unknown>).unverified === true
  );
}

// --- the POST/GET /comfy/api/comfyfed/model-fetch decision sequence (§5.1) --

/** §5.1's refusal messages, copied verbatim from model_fetch.py's `_MESSAGES`
 * -- the two stacks must answer the same request with the same bytes. */
const MESSAGES: Record<string, string> = {
  bad_request: "請求格式錯誤：需要 name、directory、url / bad request: name, directory, url required",
  already_present: "模型已在聯邦內，請重新整理面板 / model already present in the federation, reload the panel",
  untrusted_url:
    "來源網域不在白名單（僅允許 huggingface.co、civitai.com）/ url origin not allowlisted (huggingface.co, civitai.com only)",
  gated: "此模型為受限模型，需登入來源網站，無法由 worker 自動下載 / gated model: the source requires a login, workers cannot fetch it",
  size_unknown: "無法取得檔案大小，無法派工下載 / could not determine file size, cannot dispatch a fetch",
  no_worker:
    "目前沒有可下載的 worker（需在線、開啟 auto_fetch_models、agent ≥ 0.1.14、磁碟與 max_fetch_gb 足夠）/ no worker can fetch right now (online, auto_fetch_models on, agent >= 0.1.14, enough disk and max_fetch_gb)",
};

/** One of §5.1's refusal rows -- ports model_fetch.py's `FetchRequestError`.
 * `code` is the bare reason (`bad_request|already_present|untrusted_url|
 * gated|size_unknown|no_worker`); the route prefixes it with `model_fetch.`
 * for the wire.
 *
 * `detail` appends machine-readable specifics to the generic sentence -- used
 * by `no_worker`, which §5.1 row 7 requires to LIST why (the raw `assess`
 * reason strings, so the panel and the console say the same thing about the
 * same refusal). */
export class FetchRequestError extends Error {
  readonly code: string;

  constructor(code: string, detail = "") {
    super(detail ? `${MESSAGES[code]}：${detail}` : MESSAGES[code]!);
    this.name = "FetchRequestError";
    this.code = code;
  }
}

/** Characters that must never reach a signed field. `|` is the payload's own
 * delimiter (`name|directory|url|size_bytes|unverified`) -- allowing it makes
 * the concatenation non-injective across field boundaries, so two different
 * (name, directory) pairs could produce one payload and therefore share a
 * signature. Control characters (including NUL and newline) would ride the
 * same payload into the worker's filesystem. `model_manifest.ts` already
 * refuses `|` in its own entry builders for exactly this reason; this is the
 * same guard at the other place entries are minted. */
const FORBIDDEN_FIELD_CHARS = /[|\u0000-\u001f\u007f]/;

/** The server-side twin of the agent's `fetcher._is_safe_relative_path` --
 * ports model_fetch.py's `_safe_relative`. An empty directory is fine (the
 * model lands at the models root), anything absolute (leading slash/backslash
 * or a `C:` drive letter) or containing a `.`/`..`/empty path segment is not. */
function safeRelative(path: unknown): boolean {
  if (typeof path !== "string") return false;
  if (FORBIDDEN_FIELD_CHARS.test(path)) return false;
  if (path === "") return true;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

/** A bare model filename -- ports model_fetch.py's `_safe_name`: no path
 * separators at all (the `directory` field is the only place a path may
 * appear), no `.`/`..`, no payload delimiter or control characters, bounded. */
function safeName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length < 256 &&
    !/[\\/]/.test(name) &&
    !FORBIDDEN_FIELD_CHARS.test(name) &&
    name !== "." &&
    name !== ".."
  );
}

/** Whether ANY registered worker -- online, offline or disabled -- already
 * holds `name` (§5.1 row 2); ports model_fetch.py's `_fleet_has_model`.
 * Offline counts on purpose: the model IS in the federation, the panel's
 * missing-models card is just stale, and dispatching a second copy of it to
 * another worker would be pure waste. `getAllWorkers` is the cloud twin of
 * `jobs._live_workers` (both mean "every not-soft-deleted row"). */
async function fleetHasModel(db: D1Database, name: string): Promise<boolean> {
  const workers = await queries.getAllWorkers(db);
  return workers.some((worker) => assess.findModel(worker.modelInventory, name)[0]);
}

/** §5.1 row 7's "message 列出原因" -- ports model_fetch.py's
 * `_no_worker_detail`: the distinct `assess` reason strings from re-judging
 * this one model against every online, enabled worker.
 *
 * `partitionFleetFetchable` answers only yes/no, so the per-candidate reasons
 * are re-derived here with `assess.verdict` -- the SAME judge, so what the
 * panel is told can never contradict why dispatch actually refused.
 * Deliberately the raw reason strings (`missing_models_unverified_protocol:
 * <name>`, `missing_models_unavailable:<name>`, the override/vram ones)
 * rather than a prose translation: the console shows these verbatim already,
 * and a second wording would be a second thing to keep in sync.
 *
 * Empty when nothing is online at all -- there is no candidate to have a
 * reason about, and the generic sentence already says "needs an online
 * worker". */
function noWorkerDetail(
  name: string,
  fetchable: assess.FetchableModels,
  onlineEnabledWorkers: queries.Worker[],
  peerOnly: ReadonlySet<string>,
  unverified: ReadonlySet<string>
): string {
  const needs: assess.JobNeeds = {
    models: new Set([name]),
    nodes: new Set(),
    estVramGb: null,
    assets: new Set(),
  };
  const reasons: string[] = [];
  for (const worker of onlineEnabledWorkers) {
    // 2026-09-19 final-review I1: the kind gate is not something `verdict`
    // can see (it judges `JobNeeds`, which carries no kind), so a candidate
    // excluded purely for being too old to understand `kind=model_fetch`
    // gets its reason stated here -- otherwise the panel would be told "no
    // worker has the disk" about a fleet whose only problem is its agent
    // version.
    if (!assess.modelFetchProtocolOk(worker)) {
      const reason = `${assess.MODEL_FETCH_PROTOCOL_REASON}:${name}`;
      if (!reasons.includes(reason)) reasons.push(reason);
      continue;
    }
    let v: assess.Verdict;
    try {
      v = assess.verdict(worker, needs, {}, [], fetchable, peerOnly, unverified);
    } catch (err) {
      // A judge crash must not mask the 400.
      console.error("model_fetch: verdict failed while explaining no_worker", err);
      continue;
    }
    for (const reason of v.reasons) {
      if (!reasons.includes(reason)) reasons.push(reason);
    }
  }
  return reasons.join("；");
}

export interface FetchJobRequest {
  name: unknown;
  directory: unknown;
  url: unknown;
  userId: string | null;
}

export type HeadFn = (url: string) => Promise<number>;

export interface CreateFetchJobOptions {
  /** The HEAD size probe to use, the twin of `create_fetch_job`'s `head=`
   * keyword argument. Omitted (production's meaning) resolves to this
   * module's `headSizeBytes`.
   *
   * There is deliberately no module-level override behind this: an exported
   * mutable seam would let anything that can import this module redirect the
   * probe for the whole isolate -- i.e. switch off the `gated`/`size_unknown`
   * gate and let an arbitrary `size_bytes` be signed into an entry. The route
   * passes `modelFetch.headSizeBytes` through the module namespace on every
   * request instead, which is what makes it interceptable from a test
   * (`vi.spyOn(modelFetch, "headSizeBytes")`, the same pattern this suite
   * already uses for `peerhealth.probePeerHealth`) while leaving the shipped
   * Worker with no writable switch at all. */
  head?: HeadFn;
}

/** Run §5.1's decision sequence and, if it survives, create the job -- ports
 * model_fetch.py's `create_fetch_job`. Returns `{jobId, reused}`; throws
 * `FetchRequestError` for every refusal row. */
export async function createFetchJob(
  env: Env,
  req: FetchJobRequest,
  options: CreateFetchJobOptions = {}
): Promise<{ jobId: string; reused: boolean }> {
  const db = env.DB;
  const probe: HeadFn = options.head ?? headSizeBytes;

  const { name, directory, url } = req;
  if (!(safeName(name) && typeof directory === "string" && safeRelative(directory) && typeof url === "string")) {
    throw new FetchRequestError("bad_request");
  }

  if (await fleetHasModel(db, name)) {
    throw new FetchRequestError("already_present");
  }

  const existing = await queries.findActiveModelFetchJob(db, name);
  if (existing) return { jobId: existing, reused: true };

  // Row 4: a name the signed manifest already covers (curated guide hash,
  // learned consensus, or peer-only) is dispatched as that VERIFIED entry --
  // the caller-supplied url is ignored outright, so a panel that offers a
  // bogus url for a model the platform already knows cannot redirect the
  // fetch. Rows 5-6 (allowlist + HEAD) only exist for names it does not.
  const seed = await resolvePlatformSeed(db, env.PLATFORM_ED25519_SEED);
  const manifestEntries = await modelManifest.entries(db, env.STORE, seed);
  const byName = new Map(manifestEntries.map((e) => [e.name, e]));

  let entry: FetchEntry;
  let peerOnly: ReadonlySet<string> = new Set();
  let unverified: ReadonlySet<string> = new Set();
  const known = byName.get(name);
  if (known !== undefined) {
    entry = known;
    peerOnly = modelManifest.peerOnlyNames([known]);
  } else {
    if (!isTrustedUrl(url)) throw new FetchRequestError("untrusted_url");
    let sizeBytes: number;
    try {
      sizeBytes = await probe(url);
    } catch (err) {
      if (err instanceof HeadError) throw new FetchRequestError(err.code);
      throw err;
    }
    entry = await signUnverifiedEntry(seed, { name, directory, url, sizeBytes });
    unverified = new Set([name]);
  }

  // Row 7: exactly the same fleet-wide gate the prompt-submission path uses,
  // so "the panel offered me this button" and "someone can actually fetch it"
  // can never drift apart.
  const fetchable: assess.FetchableModels = { [name]: entry.size_bytes };
  const online = await queries.getOnlineEnabledWorkers(db);
  // 2026-09-19 final-review I1: EVERY model_fetch job needs a protocol>=5
  // agent, not just one carrying an unverified entry -- row 4 above hands out
  // a VERIFIED entry, which leaves `unverified` empty and would let the
  // fleet-wide gate fall back to the protocol>=3 auto-fetch floor. Older
  // candidates are dropped before the gate rather than inside it so the same
  // single predicate (`assess.modelFetchProtocolOk`) decides here and at
  // dispatch; `noWorkerDetail` still sees the FULL online list so it can say
  // "your agent is too old" about them.
  const capable = online.filter((w) => assess.modelFetchProtocolOk(w));
  const [, blocked] = assess.partitionFleetFetchable(
    new Set([name]),
    fetchable,
    capable,
    peerOnly,
    unverified
  );
  if (blocked.size > 0) {
    throw new FetchRequestError("no_worker", noWorkerDetail(name, fetchable, online, peerOnly, unverified));
  }

  const jobId = crypto.randomUUID();
  await queries.insertJob(db, {
    id: jobId,
    workflowJson: "{}",
    requirements: {},
    requiredNodes: [],
    requiredModels: [name],
    estVramGb: null,
    inputAssets: [],
    origin: "panel",
    createdAt: toSqliteTimestamp(new Date()),
    userId: req.userId,
    signature: null,
    splitPlan: null,
    kind: "model_fetch",
    fetchEntry: JSON.stringify(entry),
  });
  return { jobId, reused: false };
}

export interface FetchStatus {
  job_id: string;
  status: string;
  stage: string | null;
  fetch_pct: number | null;
  fetch_model: string | null;
  worker_id: string | null;
  error: string | null;
  name: string | null;
}

/** §5.2's payload, or null when `jobId` is unknown or is an ordinary prompt
 * job (the route turns that into a 404) -- ports model_fetch.py's
 * `fetch_status`.
 *
 * `stage`/`fetch_pct`/`fetch_model` come from the Hub DO's transient
 * in-memory fetch-progress map -- the same one the console's job payload
 * reads, via the same `/internal/fetch_progress` seam -- and are explicit
 * nulls here (not omitted) because the panel polls this shape every 2 s and
 * wants one stable set of keys. */
export async function fetchStatus(env: Env, jobId: string): Promise<FetchStatus | null> {
  const job = await queries.getJobById(env.DB, jobId);
  if (job === null || job.kind !== "model_fetch") return null;

  const progress = await queries.getFetchProgress(env.HUB, jobId);
  let entry: Record<string, unknown> = {};
  if (job.fetchEntry) {
    try {
      const parsed = JSON.parse(job.fetchEntry);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        entry = parsed as Record<string, unknown>;
      }
    } catch {
      entry = {};
    }
  }

  return {
    job_id: job.id,
    status: job.status,
    stage: progress?.stage ?? null,
    fetch_pct: progress?.fetch_pct ?? null,
    fetch_model: progress?.fetch_model ?? null,
    worker_id: job.workerId,
    error: job.error,
    name: typeof entry.name === "string" ? entry.name : null,
  };
}
