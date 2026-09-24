/**
 * Typed fetch wrapper for the ComfyFed REST API.
 *
 * The server authenticates with an httpOnly signed session cookie and requires
 * an `X-CSRF` header (value handed back by POST /api/auth/login) on every
 * state-changing request. The token is kept in memory and mirrored into
 * sessionStorage so a page reload inside a live session keeps working.
 */

const CSRF_STORAGE_KEY = 'cf_csrf';

let csrfToken: string | null = null;

function readStoredCsrf(): string | null {
  try {
    return sessionStorage.getItem(CSRF_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getCsrf(): string | null {
  if (csrfToken === null) csrfToken = readStoredCsrf();
  return csrfToken;
}

export function setCsrf(token: string | null): void {
  csrfToken = token;
  try {
    if (token === null) sessionStorage.removeItem(CSRF_STORAGE_KEY);
    else sessionStorage.setItem(CSRF_STORAGE_KEY, token);
  } catch {
    /* private-mode browsers: in-memory token still works for this tab */
  }
}

/** Error envelope the server returns: {"error": {"code", "message"}}. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message || code);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
  }
}

/** Set by the app so a 401 anywhere can bounce the user back to /login. */
let unauthorizedHandler: (() => void) | null = null;

export function onUnauthorized(handler: (() => void) | null): void {
  unauthorizedHandler = handler;
}

async function parseError(response: Response): Promise<ApiError> {
  let code = 'http_error';
  let message = response.statusText;
  try {
    const body = await response.json();
    if (body?.error?.code) {
      code = String(body.error.code);
      message = String(body.error.message ?? code);
    }
  } catch {
    /* non-JSON error body (proxy/gateway); keep the status text */
  }
  return new ApiError(code, message, response.status);
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

async function request<T>(
  method: Method,
  path: string,
  body?: BodyInit | null,
  headers: Record<string, string> = {},
  _isCsrfRetry = false,
): Promise<T> {
  const finalHeaders: Record<string, string> = { ...headers };
  const csrf = getCsrf();
  if (method !== 'GET' && csrf) finalHeaders['X-CSRF'] = csrf;

  const response = await fetch(path, {
    method,
    credentials: 'include',
    headers: finalHeaders,
    body: body ?? null,
  });

  if (response.status === 401) {
    setCsrf(null);
    // /api/auth/login itself must surface its own 401 (wrong password) rather
    // than trigger a redirect loop.
    if (!path.endsWith('/api/auth/login')) unauthorizedHandler?.();
    throw await parseError(response);
  }
  if (response.status === 403 && !_isCsrfRetry) {
    const err = await parseError(response);
    if (err.code === 'auth.csrf') {
      // A new tab (or a session that outlived this tab) has a valid cookie
      // but never learned its CSRF token -- refetch it from /auth/me and
      // retry the original request once before giving up.
      let freshCsrf: string | undefined;
      try {
        const me = await getJson<MeResponse>('/api/auth/me');
        if (me.authenticated && me.csrf) freshCsrf = me.csrf;
      } catch {
        /* fall through to the original error */
      }
      if (freshCsrf) {
        setCsrf(freshCsrf);
        return request<T>(method, path, body, headers, true);
      }
    }
    throw err;
  }
  if (!response.ok) throw await parseError(response);

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

function getJson<T>(path: string): Promise<T> {
  return request<T>('GET', path);
}

function postJson<T>(path: string, payload: unknown): Promise<T> {
  return request<T>('POST', path, JSON.stringify(payload ?? {}), {
    'Content-Type': 'application/json',
  });
}

function postForm<T>(path: string, form: FormData): Promise<T> {
  // No Content-Type header: the browser must set the multipart boundary.
  return request<T>('POST', path, form);
}

function patchJson<T>(path: string, payload: unknown): Promise<T> {
  return request<T>('PATCH', path, JSON.stringify(payload ?? {}), {
    'Content-Type': 'application/json',
  });
}

/** No body at all -- the server's DELETE routes take everything from the
 * path, and `request` still attaches the X-CSRF header (non-GET). */
function deleteJson<T>(path: string): Promise<T> {
  return request<T>('DELETE', path);
}

/* ------------------------------------------------------------------ types */

export interface SetupStatus {
  needed: boolean;
}

/** Phase 3.0 multi-user roles: `admin` sees everything, `user` is scoped to
 * their own jobs and a reduced nav/settings surface. */
export type Role = 'admin' | 'user';

export interface MeResponse {
  authenticated: boolean;
  username?: string;
  role?: Role | string;
  lang: string;
  platform_url?: string;
  csrf?: string;
}

/**
 * One row of `GET /api/auth/tokens` (API token design §4.2): a bearer token
 * the caller minted for an AI/MCP client. The plaintext is never in this
 * shape -- only `POST /api/auth/tokens` ever returns it, exactly once.
 * `active` is the server's own verdict (not revoked AND not expired); the
 * console splits "revoked" from "expired" by looking at `revoked_at`.
 */
export interface ApiToken {
  id: string;
  name: string;
  prefix: string;
  created_at: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
  active: boolean;
}

/** `POST /api/auth/tokens` echoes the plaintext `token` exactly once. */
export interface CreatedApiToken {
  id: string;
  name: string;
  token: string;
  prefix: string;
  created_at: string | null;
  expires_at: string | null;
}

export interface WorkerHardware {
  gpu_name?: string | null;
  vram_gb?: number | null;
  cpu?: string | null;
  cpu_cores?: number | null;
  ram_gb?: number | null;
  agent_version?: string | null;
  /** "Windows" | "Darwin" | "Linux", reported since agent protocol 2. */
  platform?: string | null;
}

export interface WorkerDynamic {
  free_vram_gb?: number | null;
  free_ram_gb?: number | null;
  free_disk_gb?: number | null;
}

export type WorkerStatus = 'online' | 'busy' | 'offline' | 'paused';

export interface AgentVersion {
  latest: string;
  min_supported: string;
  wheel_url: string | null;
  sha256: string | null;
  platform_sig: string | null;
}

export interface Worker {
  id: string;
  name: string;
  status: WorkerStatus | string;
  last_seen: string | null;
  disabled: boolean;
  hardware: WorkerHardware;
  dynamic: WorkerDynamic;
  backend: string;
  torch_version: string;
  model_count: number;
  /** Phase 3.1 P2P: set when this worker's agent opted into serving chunks
   * to other workers (`hello.peer_url`); null otherwise. */
  peer_url: string | null;
  /** Phase 3.4：區網位址（同一個 NAT 的成員優先用它）。 */
  peer_lan_url: string | null;
  /** Phase 3.4：`peer_url` 的來源 —— natpmp/upnp/manual/lan/none。 */
  peer_nat: string;
  /** Phase 3.4：平台驗證結果。null = 尚未檢查。
   * 兩套後端都把它序列化成整數 1/0（SQLite / D1 沒有原生 boolean），
   * 所以型別要同時容納 number 與 boolean —— 判讀一律走 `peerReachable()`。 */
  peer_reachable: number | boolean | null;
  /**
   * Job-retry design (2026-09-19) §8: tasks this worker has repeatedly
   * failed and is currently excluded from (`task_key` = job.signature, or
   * `model_fetch:<name>` for a model-fetch job). `active` is false once the
   * row has aged past the server's TTL -- it stays in the list (informational)
   * but no longer affects dispatch.
   */
  unsuitable: UnsuitableTask[];
}

/** One row of `Worker.unsuitable` (design §7/§8). */
export interface UnsuitableTask {
  task_key: string;
  failures: number;
  last_error: string | null;
  last_job_id: string | null;
  updated_at: string | null;
  active: boolean;
}

/** `peer_reachable` 的三態判讀。後端（Python SQLite / Cloud D1）都把它存成
 * 整數 1/0，JSON 出來就是 number；只比對 `=== true/false` 會讓徽章永遠停在
 * 「尚未檢查」。null／undefined = 尚未檢查。 */
export function peerReachable(value: number | boolean | null | undefined): boolean | null {
  if (value === 1 || value === true) return true;
  if (value === 0 || value === false) return false;
  return null;
}

export type JobStatus = 'queued' | 'assigned' | 'running' | 'done' | 'failed' | 'cancelled';

/** Who submitted the job: the console's own `/api/jobs`, or the ComfyUI-compatible panel surface. */
export type JobOrigin = 'panel' | 'console';

/** `jobs.dispatch_info`: the scheduler's own note of why it claimed a job onto
 * a given worker (Phase 3.3 §2.2). An empty object means the job has not
 * been claimed yet (or predates the upgrade). */
export interface DispatchInfo {
  predicted_seconds?: number;
  /** Where the prediction came from -- picks which explanatory sentence the
   * detail page shows. */
  basis?: 'signature' | 'speed_index' | 'fleet_default' | 'none' | string;
  load_seconds?: number;
  fetch_seconds?: number;
  candidates?: number;
  /** 2026-09-23 cross-backend §3.4: while a job is queued the scheduler may
   * be HOLDING it for a busy worker that is expected to finish it sooner
   * than any idle one could. Cleared when the hold ends; replaced by the
   * claim-time fields above once dispatched. */
  held_for?: string;
  held_for_name?: string;
  wait_seconds?: number;
  run_now_seconds?: number | null;
}

/** One child job's summary row, as listed in a split parent's `GET
 * /api/jobs/{id}` under `children`. */
export interface JobChild {
  id: string;
  split_index: number;
  status: JobStatus | string;
  worker_id: string | null;
  progress: number;
  gpu_seconds: number | null;
  error: string | null;
}

export interface Job {
  id: string;
  /**
   * 2026-09-20 檔案頁 §2: the job's human name -- what the Files page uses as
   * the first folder level. Supplied by the caller (`POST /api/jobs`'s
   * optional `label` form field, a recipe id, an MCP argument) or derived
   * from the workflow's first `Save*` node; `null` when neither applied, in
   * which case the UI falls back to the short job id.
   */
  label: string | null;
  status: JobStatus | string;
  origin: JobOrigin | string;
  progress: number;
  worker_id: string | null;
  created_at: string | null;
  error: string | null;
  result_files: string[];
  input_assets: string[];
  est_vram_gb: number | null;
  /**
   * Job-retry design (2026-09-19) §4/§8: failures per worker for this job
   * (`{worker_id: failure_count}`); each worker gets excluded from this job
   * once its count reaches the server's per-job threshold.
   */
  attempts: Record<string, number>;
  /**
   * Server commit 7e0840d: that worker's LAST error on THIS job (`{worker_id:
   * message}`, each value already truncated to 200 chars server-side).
   * Optional -- a payload from before this field existed simply omits it, so
   * callers should treat a missing value as `{}` rather than crash.
   */
  attempt_errors?: Record<string, string>;
  /**
   * How many times this job has been requeued after a non-final failure.
   * While `status === 'queued'` and `retry_count > 0`, `error` holds the
   * most recent attempt's failure (design §5 -- the field's meaning shifts
   * from "the failure" to "the last failure" once requeued).
   */
  retry_count: number;
  /**
   * Phase 3.3 batch splitting: how many children this job was split into (0
   * = an ordinary job, not split). The list only shows parents/ordinary jobs
   * by default, so a non-zero count here means there are children underneath.
   */
  split_count: number;
  /**
   * Phase 3.3 dispatch rationale: the scheduler's reasoning at claim time.
   * An empty object means this job has not been claimed yet (or is old data
   * from before the upgrade).
   */
  dispatch_info: DispatchInfo;
  /**
   * Who submitted the job (Phase 3.0 multi-user). Admins get every job's
   * `username`; a plain user's own `GET /api/jobs` always echoes their own
   * username (never null) since they only ever see their own jobs. Null
   * shows up only for an admin viewing a pre-Phase-3.0 job with no owner.
   */
  username?: string | null;
  /**
   * Present only while a worker is fetching a missing model for this job
   * (Phase 2.1 model auto-fetch). Absent the rest of the time, in which case
   * rendering falls back to the plain progress bar.
   */
  stage?: 'fetching_models' | string;
  fetch_pct?: number;
  fetch_model?: string;
  /**
   * Phase: panel Download button -> model_fetch job. `prompt` is every
   * ordinary job; `model_fetch` is a worker-side model download with no
   * workflow to run (see `fetch_entry`).
   */
  kind: 'prompt' | 'model_fetch';
  /**
   * Present (non-null) only on a `kind: "model_fetch"` job: the signed
   * manifest entry the job was created with. `null`/absent on a `prompt`
   * job.
   */
  fetch_entry?: FetchEntry | null;
}

/** A `model_fetch` job's manifest entry (design doc §6): either a hit against
 * an already-signed/curated manifest entry, or an `unverified` entry whose
 * hash is learned once the worker's download lands. */
export interface FetchEntry {
  name: string;
  directory: string;
  url: string;
  backup_url?: string | null;
  sha256?: string | null;
  size_bytes: number;
  /** True only for a not-yet-verified entry (hash unknown until landing). */
  unverified?: true;
  sig?: string | null;
  peer?: string | null;
}

/** Dual-signed job receipt summary, embedded in `GET /api/jobs/{id}` once one exists. */
export interface JobReceipt {
  gpu_seconds: number;
  kind: 'completed' | 'failed' | 'cancelled' | string;
  billable: boolean;
  basis: 'exec' | 'wall' | string;
  acked: boolean;
}

export interface JobDetail extends Job {
  workflow_json: Record<string, unknown>;
  requirements: Record<string, unknown>;
  required_nodes: string[];
  required_models: string[];
  started_at: string | null;
  finished_at: string | null;
  /** Always null for a split parent (each child mints its own receipt instead). */
  receipt: JobReceipt | null;
  /** This job's children; always `[]` for an ordinary (non-split) job. */
  children: JobChild[];
  /** A parent = the sum of its children's billable receipts; an ordinary job
   * = its own receipt's `gpu_seconds` (0 with no receipt yet). */
  gpu_seconds_total: number;
  /**
   * `(child job id, filename)` pairs for a split parent's merged outputs, so
   * the console can link each one at `/api/jobs/<job_id>/artifacts/<filename>`
   * -- a parent's own `result_files` is always empty. Only present on a
   * parent (`split_count > 0`); absent on an ordinary job.
   */
  outputs?: { job_id: string; filename: string }[];
}

export type VerdictKind = 'eligible' | 'eligible_after_fetch' | 'ineligible';

export interface WorkerVerdict {
  worker_id: string;
  name: string;
  verdict: VerdictKind | string;
  reasons: string[];
  /**
   * Non-blocking notes on an eligible verdict (e.g. `vram_offload:...`): the
   * worker WILL run the job, so these are rendered as a dim note, never as a
   * refusal. Optional so an older server that omits the field still parses.
   */
  warnings?: string[];
  missing_models: string[];
}

export interface Assessment {
  workers: WorkerVerdict[];
}

export interface TokenBundle {
  platform_url: string;
  platform_pubkey: string;
  register_token: string;
}

/** Row shape for `GET /api/users` (see `cloud/src/routes/users.ts`). */
export interface AppUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  created_at: string | null;
  jobs: number;
  /** 2026-09-20 per-user overrides. `null` = platform default (limits) /
   * allowed (NSFW). Optional so an older server that omits them still parses. */
  max_file_mb?: number | null;
  quota_gb?: number | null;
  nsfw_allowed?: boolean | null;
  /** 2026-09-24: bytes this user currently keeps (uploads + saved panel
   * files + job inputs/outputs). Optional/null on an older server. */
  used_bytes?: number | null;
}

/** `PATCH /api/users/{id}` body. For the three override fields, omitting
 * the key leaves it untouched and `null` clears the override. */
export interface UserPatch {
  role?: Role;
  disabled?: boolean;
  max_file_mb?: number | null;
  quota_gb?: number | null;
  nsfw_allowed?: boolean | null;
}

/** `POST /api/users` echoes the plaintext password exactly once. */
export interface CreatedUser {
  id: string;
  username: string;
  role: Role;
  password: string;
}

export interface Contribution {
  worker_id: string;
  name: string;
  jobs: number;
  gpu_seconds: number;
  /** Phase 3.1 P2P: total bytes this worker served across its
   * `p2p_upload` receipts in the report's date range (0 when none). */
  p2p_upload_bytes: number;
}

/** Row shape shared by `GET /api/reports/usage` (one per user) and
 * `GET /api/reports/my-usage` (the caller's own row). `username` is `null`
 * for the single aggregate row of pre-Phase-3.0 receipts whose job has no
 * `user_id` -- rendered as "(historical)" rather than dropped. */
export interface UsageRow {
  user_id: string | null;
  username: string | null;
  jobs: number;
  gpu_seconds: number;
  unbilled_gpu_seconds: number;
}

/** One worker's share of a payout pool, from `GET /api/reports/payout`. */
export interface PayoutWorker {
  worker_id: string;
  name: string;
  gpu_seconds: number;
  ratio: number;
  amount: number;
}

export interface PayoutResult {
  total_gpu_seconds: number;
  pool: number;
  workers: PayoutWorker[];
}

/** Compute backends a job can be pinned to via the advanced override. */
export type Backend = 'cuda' | 'rocm' | 'mps' | 'cpu';

export interface RequirementsOverride {
  min_vram_gb?: number;
  min_free_disk_gb?: number;
  gpu_name_contains?: string;
  backend?: Backend;
}

export type ObjectInfoMode = 'union' | 'intersection';

export interface SettingsUpdate {
  platform_url?: string;
  lang?: string;
  object_info_mode?: ObjectInfoMode;
  /** Admin-only: per-file upload ceiling in MB (integer, 1-1024). */
  upload_max_file_mb?: number;
  /** Admin-only: per-user storage quota in GB (decimals allowed, 0.1-1024). */
  upload_user_quota_gb?: number;
  /** Admin-only: Phase 3.3 batch splitting toggle -- off means every new job
   * runs whole on a single worker regardless of its batch_size. */
  split_batches?: boolean;
  /** Admin-only: Phase 3.4 -- trust `X-Forwarded-For` when deciding a
   * worker's source IP. Self-hosted only (the cloud stack reads Cloudflare's
   * authoritative `CF-Connecting-IP` and has no such setting). */
  trust_proxy?: boolean;
  /** Admin-only: Claude API key for the NSFW review of restricted users.
   * Empty string removes the stored key. Never echoed back. */
  nsfw_check_api_key?: string;
}

export interface SettingsState {
  platform_url: string;
  lang: string;
  object_info_mode: ObjectInfoMode | string;
  upload_max_file_mb: number;
  upload_user_quota_gb: number;
  split_batches: boolean;
  /** Absent on the cloud stack -- the console hides the switch when it is. */
  trust_proxy?: boolean;
  /** Whether an NSFW-review API key is stored (the key itself is never sent). */
  nsfw_check_api_key_set?: boolean;
}

/** One file the caller uploaded into their own panel staging area
 * (`GET /api/staging`). `modified` is unix seconds. */
export interface StagingFile {
  name: string;
  size: number;
  modified: number;
  /** 2026-09-21 管理視角：only on `GET /api/staging?scope=all` (admin) --
   * whose upload this is. Absent on the personal listing. */
  user_id?: string;
  username?: string | null;
}

/** One finished job's output file, as `GET /api/me/artifacts` lists it
 * (2026-09-20 檔案頁 §3.1). `label` is the owning job's name (null when it
 * has none), `created_at` the job's creation time, and `kind` the storage
 * layer's verdict on how to preview it. Only files the store actually holds
 * are listed, so `size` is always a real byte count. */
export interface ArtifactFile {
  job_id: string;
  label: string | null;
  created_at: string;
  filename: string;
  size: number;
  kind: 'image' | 'video' | 'other' | string;
  /** 2026-09-21 管理視角：only on `?scope=all` (admin) -- whose job produced
   * this file. Absent on the personal listing. */
  user_id?: string | null;
  username?: string | null;
}

/** Which files a listing covers: the caller's own (default) or, for an
 * admin, every user's. */
export type FilesScope = 'mine' | 'all';

/** 2026-09-21 分頁：預設每頁筆數（任務頁一頁 25 張單；檔案頁一頁 25 張單的
 * 成品）。伺服器上限 100。 */
export const PAGE_SIZE = 25;

/** `GET /api/jobs?page=` 的信封：`jobs` 是這一頁（最新在前），`total` 是所有
 * 頁合計，讓頁碼算得出來。 */
export interface JobPage {
  jobs: Job[];
  total: number;
  page: number;
  limit: number;
}

/** `GET /api/me/artifacts?page=` 的信封：以 job 為分頁單位，`total_jobs` 是
 * 有成品的單總數（不是檔案數）。 */
export interface ArtifactPage {
  files: ArtifactFile[];
  total_jobs: number;
  page: number;
  limit: number;
}

export interface StagingListing {
  files: StagingFile[];
  /** Bytes in the caller's staging namespace (the `files` above). */
  total_bytes: number;
  /** The configured per-user storage quota, in bytes. */
  quota_bytes: number;
  /** The second namespace the quota counts: the caller's saved panel files
   * (workflows, presets). */
  userdata_bytes: number;
  /** 2026-09-24: the third -- inputs and outputs of the caller's jobs. Optional
   * so an older server that omits it still parses (treated as 0). */
  jobs_bytes?: number;
}

/* -------------------------------------------------------------- endpoints */

export const api = {
  /**
   * GET /api/setup/status. Cloud-only (see routes/auth.ts's `/api/setup/*`
   * docstring) -- the Python server has no such route at all, so callers
   * must treat any error here (network failure, 404) as "setup not
   * needed" rather than surfacing it.
   */
  setupStatus(): Promise<SetupStatus> {
    return getJson<SetupStatus>('/api/setup/status');
  },

  /** POST /api/setup. Does not log the caller in -- flow into the normal
   * login form afterwards (see the route's docstring: a stateless Workers
   * deployment has no session to hand back here). */
  setup(token: string, password: string): Promise<{ ok: boolean }> {
    return postJson('/api/setup', { token, password });
  },

  async login(username: string, password: string): Promise<void> {
    const result = await request<{ csrf: string }>(
      'POST',
      '/api/auth/login',
      JSON.stringify({ username, password }),
      { 'Content-Type': 'application/json' },
    );
    setCsrf(result.csrf);
  },

  async logout(): Promise<void> {
    try {
      await postJson('/api/auth/logout', {});
    } finally {
      setCsrf(null);
    }
  },

  me(): Promise<MeResponse> {
    return getJson<MeResponse>('/api/auth/me');
  },

  /** Final review finding #4: the server re-issues a fresh cookie AND a
   * fresh CSRF token here (the epoch bump would otherwise invalidate the
   * caller's own session too) -- the client must adopt it immediately via
   * `setCsrf`, or every subsequent state-changing request silently fails
   * `403 auth.csrf` until the next full login. */
  async changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean; csrf: string }> {
    const result = await postJson<{ ok: boolean; csrf: string }>('/api/auth/change-password', {
      old: oldPassword,
      new: newPassword,
    });
    setCsrf(result.csrf);
    return result;
  },

  /**
   * API tokens (design §4.2). All three routes are **cookie-session only** --
   * a bearer token can never manage tokens -- so they ride the console's
   * ordinary session + CSRF path like every other call here.
   */
  listTokens(): Promise<ApiToken[]> {
    return getJson<ApiToken[]>('/api/auth/tokens');
  },

  /** 201 with the plaintext `token`, which is shown to the user once and
   * never retrievable again. 409 `auth.too_many_tokens` past the per-user
   * cap; 400 `auth.bad_token_name` for a name over 64 characters. */
  createToken(name: string): Promise<CreatedApiToken> {
    return postJson<CreatedApiToken>('/api/auth/tokens', { name });
  },

  /** Idempotent: an already-revoked token still answers `{revoked: true}`. */
  revokeToken(tokenId: string): Promise<{ revoked: boolean }> {
    return deleteJson(`/api/auth/tokens/${encodeURIComponent(tokenId)}`);
  },

  agentVersion(): Promise<AgentVersion> {
    return getJson<AgentVersion>('/api/agent/version');
  },

  listWorkers(): Promise<Worker[]> {
    return getJson<Worker[]>('/api/workers');
  },

  async issueWorkerToken(name: string): Promise<TokenBundle> {
    const result = await postJson<{ bundle: TokenBundle }>('/api/workers/tokens', { name });
    return result.bundle;
  },

  disableWorker(workerId: string): Promise<{ ok: boolean }> {
    return postJson(`/api/workers/${encodeURIComponent(workerId)}/disable`, {});
  },

  /** Spec 2026-09-24 §2.2: ask a connected worker's agent to update itself
   * now. Resolves with the agent's ack (`updating | deferred | up_to_date |
   * declined | failed`) or `sent` when the agent did not answer within the
   * hub's deadline. Rejects with `workers.agent_too_old` (409) for an agent
   * that predates the command, `workers.offline` (409) when no socket is
   * live, `workers.not_found` (404) otherwise. */
  updateWorker(workerId: string): Promise<{ status: string; detail?: string }> {
    return postJson(`/api/workers/${encodeURIComponent(workerId)}/update`, {});
  },

  /** Admin soft delete: the worker disappears from this list and can never
   * reconnect, but its billing records stay resolvable. 404 for an unknown
   * or already-deleted worker. */
  deleteWorker(workerId: string): Promise<{ ok: boolean }> {
    return deleteJson(`/api/workers/${encodeURIComponent(workerId)}`);
  },

  /**
   * Admin: clear a worker's unsuitable-task record(s) (design §7). With
   * `taskKey`, `DELETE /api/workers/{id}/unsuitable/{task_key}` drops just
   * that row; without one, `DELETE /api/workers/{id}/unsuitable` clears
   * every row for the worker. Either way the server answers `{cleared: n}`.
   */
  clearUnsuitable(workerId: string, taskKey?: string): Promise<{ cleared: number }> {
    const base = `/api/workers/${encodeURIComponent(workerId)}/unsuitable`;
    return deleteJson(taskKey ? `${base}/${encodeURIComponent(taskKey)}` : base);
  },

  /** 2026-09-21 分頁：`GET /api/jobs?page=&limit=`，最新在前、附 total。
   * 任務頁用這個；Dashboard 只看進行中的單，仍走 `listJobs`（不分頁）。 */
  listJobsPage(page: number, limit = PAGE_SIZE, statuses?: string[]): Promise<JobPage> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (statuses && statuses.length > 0) params.set('status', statuses.join(','));
    return getJson<JobPage>(`/api/jobs?${params.toString()}`);
  },

  listJobs(statuses?: string[]): Promise<Job[]> {
    const query = statuses?.length ? `?status=${encodeURIComponent(statuses.join(','))}` : '';
    return getJson<Job[]>(`/api/jobs${query}`);
  },

  getJob(jobId: string): Promise<JobDetail> {
    return getJson<JobDetail>(`/api/jobs/${encodeURIComponent(jobId)}`);
  },

  getAssessment(jobId: string): Promise<Assessment> {
    return getJson<Assessment>(`/api/jobs/${encodeURIComponent(jobId)}/assessment`);
  },

  submitJob(
    workflowJson: string,
    requirements: RequirementsOverride | null,
    assets: File[],
    label?: string | null,
  ): Promise<{ job_id: string }> {
    const form = new FormData();
    form.append('workflow_json', workflowJson);
    if (requirements && Object.keys(requirements).length > 0) {
      form.append('requirements', JSON.stringify(requirements));
    }
    // 檔案頁 §2: omitted entirely when absent, so the server falls back to
    // deriving the name from the workflow instead of storing "".
    if (label != null && label.trim() !== '') form.append('label', label.trim());
    for (const file of assets) form.append('assets', file, file.name);
    return postForm<{ job_id: string }>('/api/jobs', form);
  },

  /** Requeue a failed job. Rejects with `jobs.not_retryable` (409) otherwise. */
  retryJob(jobId: string): Promise<{ ok: boolean; job_id: string }> {
    return postJson(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {});
  },

  /** Cancel a queued/assigned/running job. Rejects with `jobs.already_terminal` (409) otherwise. */
  cancelJob(jobId: string): Promise<{ status: string }> {
    return postJson(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {});
  },

  getSettings(): Promise<SettingsState> {
    return getJson<SettingsState>('/api/settings');
  },

  updateSettings(update: SettingsUpdate): Promise<SettingsState> {
    return postJson('/api/settings', update);
  },

  contributions(from?: string, to?: string): Promise<Contribution[]> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    return getJson<Contribution[]>(`/api/reports/contributions${query ? `?${query}` : ''}`);
  },

  /** GET /api/reports/usage (admin-only). Per-user aggregate, one row per
   * user plus (when present) one `username: null` row for legacy receipts. */
  reportUsage(from?: string, to?: string): Promise<UsageRow[]> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    return getJson<UsageRow[]>(`/api/reports/usage${query ? `?${query}` : ''}`);
  },

  /** GET /api/reports/my-usage (any signed-in user): the caller's own row. */
  reportMyUsage(from?: string, to?: string): Promise<UsageRow> {
    const params = new URLSearchParams();
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const query = params.toString();
    return getJson<UsageRow>(`/api/reports/my-usage${query ? `?${query}` : ''}`);
  },

  /** GET /api/reports/payout (admin-only). `pool` is the raw currency-
   * agnostic amount to split across workers by billable GPU-second share. */
  reportPayout(pool: number, from?: string, to?: string): Promise<PayoutResult> {
    const params = new URLSearchParams();
    params.set('pool', String(pool));
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    return getJson<PayoutResult>(`/api/reports/payout?${params.toString()}`);
  },

  async listUsers(): Promise<AppUser[]> {
    const result = await getJson<{ users: AppUser[] }>('/api/users');
    return result.users;
  },

  createUser(username: string, role: Role, password?: string): Promise<CreatedUser> {
    return postJson<CreatedUser>('/api/users', password ? { username, role, password } : { username, role });
  },

  resetUserPassword(userId: string): Promise<{ password: string }> {
    return postJson(`/api/users/${encodeURIComponent(userId)}/reset-password`, {});
  },

  patchUser(userId: string, update: UserPatch): Promise<AppUser> {
    return patchJson<AppUser>(`/api/users/${encodeURIComponent(userId)}`, update);
  },

  /** GET /api/staging (any signed-in user): the caller's OWN uploaded
   * reference files. `scope: 'all'` (admin only, 403 otherwise) lists every
   * user's uploads instead, each tagged with `user_id`/`username`. */
  listStaging(scope: FilesScope = 'mine'): Promise<StagingListing> {
    return getJson<StagingListing>(scope === 'all' ? '/api/staging?scope=all' : '/api/staging');
  },

  /** DELETE /api/staging/{filename}: removes one of the caller's own staged
   * uploads, or -- with `userId`, admin only -- another user's. 404 for an
   * unknown name. Jobs already submitted keep their own copy of the asset. */
  deleteStagingFile(name: string, userId?: string): Promise<{ ok: boolean }> {
    const suffix = userId ? `?user=${encodeURIComponent(userId)}` : '';
    return deleteJson(`/api/staging/${encodeURIComponent(name)}${suffix}`);
  },

  /** GET /api/me/artifacts (檔案頁 §3.1): every output file of the CALLER's
   * own finished jobs, newest job first. `scope: 'all'` (admin only, 403
   * otherwise) lists every user's instead, each tagged with
   * `user_id`/`username`. */
  listMyArtifacts(page = 1, limit = PAGE_SIZE, scope: FilesScope = 'mine'): Promise<ArtifactPage> {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (scope === 'all') params.set('scope', 'all');
    return getJson<ArtifactPage>(`/api/me/artifacts?${params.toString()}`);
  },

  /** DELETE /api/jobs/{id}/artifacts/{filename} (檔案頁 §3.2): drop one
   * output file. The job row, its `result_hashes` and its receipt all stay
   * put -- only the bytes and the `result_files` entry go. Rejects with
   * `jobs.not_found`, `jobs.artifact_not_found` or `jobs.not_finished`. */
  deleteArtifact(jobId: string, filename: string): Promise<{ ok: boolean; result_files: string[] }> {
    return deleteJson(
      `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`,
    );
  },

  /** DELETE /api/jobs/{id}/artifacts: the same thing for every file the job
   * produced, in one call. */
  deleteJobArtifacts(jobId: string): Promise<{ ok: boolean; result_files: string[] }> {
    return deleteJson(`/api/jobs/${encodeURIComponent(jobId)}/artifacts`);
  },
};

/** Download URL for a finished job's result file. */
export function artifactUrl(jobId: string, filename: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`;
}
