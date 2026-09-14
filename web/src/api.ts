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

type Method = 'GET' | 'POST' | 'PATCH';

async function request<T>(
  method: Method,
  path: string,
  body?: BodyInit | null,
  headers: Record<string, string> = {},
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
}

export type JobStatus = 'queued' | 'assigned' | 'running' | 'done' | 'failed' | 'cancelled';

/** Who submitted the job: the console's own `/api/jobs`, or the ComfyUI-compatible panel surface. */
export type JobOrigin = 'panel' | 'console';

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
  receipt: JobReceipt | null;
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
}

export interface SettingsState {
  platform_url: string;
  lang: string;
  object_info_mode: ObjectInfoMode | string;
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
};

/** Download URL for a finished job's result file. */
export function artifactUrl(jobId: string, filename: string): string {
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(filename)}`;
}
