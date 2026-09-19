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

/** Row shape for `GET /api/users` (see server/comfyfed_server/users.py's `_user_list_row`). */
export interface AppUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  created_at: string | null;
  jobs: number;
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
}

/** One file the caller uploaded into their own panel staging area
 * (`GET /api/staging`). `modified` is unix seconds. */
export interface StagingFile {
  name: string;
  size: number;
  modified: number;
}

export interface StagingListing {
  files: StagingFile[];
  /** Bytes in the caller's staging namespace (the `files` above). */
  total_bytes: number;
  /** The configured per-user storage quota, in bytes. */
  quota_bytes: number;
  /** The OTHER half of what the quota counts: the caller's saved panel files
   * (workflows, presets). Job artifacts/outputs count toward neither. */
  userdata_bytes: number;
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
  ): Promise<{ job_id: string }> {
    const form = new FormData();
    form.append('workflow_json', workflowJson);
    if (requirements && Object.keys(requirements).length > 0) {
      form.append('requirements', JSON.stringify(requirements));
    }
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

  patchUser(userId: string, update: { role?: Role; disabled?: boolean }): Promise<AppUser> {
    return patchJson<AppUser>(`/api/users/${encodeURIComponent(userId)}`, update);
  },

  /** GET /api/staging (any signed-in user): the caller's OWN uploaded
   * reference files. There is no cross-user or admin view -- staging is
   * personal, so this always answers with just the caller's own uploads. */
  listStaging(): Promise<StagingListing> {
    return getJson<StagingListing>('/api/staging');
  },

  /** DELETE /api/staging/{filename}: removes one of the caller's own staged
   * uploads. 404 for an unknown name (including another user's file, which
   * this route cannot address at all). Jobs already submitted keep their own
   * copy of the asset. */
  deleteStagingFile(name: string): Promise<{ ok: boolean }> {
    return deleteJson(`/api/staging/${encodeURIComponent(name)}`);
  },
};

/** Download URL for a finished job's result file. */
export function artifactUrl(jobId: string, filename: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`;
}
