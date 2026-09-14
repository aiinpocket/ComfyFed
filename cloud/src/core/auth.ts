/**
 * Pure login-backoff logic, ported from server/comfyfed_server/auth.py
 * (`_consecutive_failures` / `_required_wait_seconds`). Kept dependency-free
 * (no D1, no Date.now()) so timing edge cases can be unit-tested by feeding
 * in explicit "now" and attempt-row fixtures instead of racing a real clock.
 *
 * Backoff window: 10 minutes. "Consecutive" = failed attempts since the last
 * success, capped to whatever falls inside the 10-minute window (a success
 * more than 10 minutes ago doesn't reset anything additional -- the window
 * filter already drops it). Required wait once n >= 4: 2^(n-3) seconds.
 */

export const BACKOFF_WINDOW_MS = 10 * 60 * 1000;
export const BACKOFF_START_N = 4;

export interface LoginAttemptRow {
  /** `toSqliteTimestamp`-shaped UTC string. */
  at: string;
  ok: boolean;
}

/** Parses the `YYYY-MM-DD HH:MM:SS.ffffff` shape `toSqliteTimestamp` writes
 * back into epoch milliseconds (UTC). */
export function parseSqliteTimestamp(s: string): number {
  const [datePart, timePart] = s.split(" ");
  const [y, mo, d] = datePart!.split("-").map(Number);
  const [hh, mm, rest] = timePart!.split(":");
  const [ss, frac] = rest!.split(".");
  const ms = frac ? Math.floor(Number(frac.padEnd(6, "0").slice(0, 6)) / 1000) : 0;
  return Date.UTC(y!, mo! - 1, d!, Number(hh), Number(mm), Number(ss), ms);
}

/**
 * Counts consecutive failures (rows ordered newest-first, stopping at the
 * first success or the window cutoff) and returns the timestamp (epoch ms)
 * of the most recent failure, mirroring auth.py's `_consecutive_failures`.
 *
 * `rows` must already be filtered to `at >= cutoff` and ordered `at DESC`
 * (the caller -- a D1 query -- does both, same as the Python query).
 */
export function consecutiveFailures(rows: LoginAttemptRow[]): {
  count: number;
  latestFailureAtMs: number | null;
} {
  let count = 0;
  let latestFailureAtMs: number | null = null;
  for (const row of rows) {
    if (row.ok) break;
    count += 1;
    if (latestFailureAtMs === null) {
      latestFailureAtMs = parseSqliteTimestamp(row.at);
    }
  }
  return { count, latestFailureAtMs };
}

export function requiredWaitSeconds(n: number): number {
  if (n < BACKOFF_START_N) return 0;
  return 2 ** (n - 3);
}

// -- Error messages, copied verbatim from auth.py (English there, not
// zh-TW -- only the settings.bad_object_info_mode message is zh-TW in the
// Python source; everything else in auth.py is plain English) -------------

export const MESSAGES = {
  authRequired: "Login required.",
  invalidPassword: "Invalid password.",
  tooManyAttempts: "Too many attempts, please wait.",
  csrfInvalid: "CSRF token missing or invalid.",
  // Mirrors auth.py's `require_admin`: "403 for a logged-in non-admin."
  adminRequired: "Admin role required.",
  passwordTooShort: "New password must be at least 8 characters.",
  oldPasswordIncorrect: "Old password is incorrect.",
  badPlatformUrl: "Platform URL must start with http:// or https://.",
  badLang: "Language must be one of: zh-TW, en.",
  badObjectInfoMode: "object_info_mode 必須是 union 或 intersection 其中之一。",
} as const;

// -- Users API messages (Phase 3.0), copied verbatim from users.py ---------

export const USER_MESSAGES = {
  invalidUsername: "Username must be 3-32 chars: a-z, 0-9, _.-",
  invalidRole: (roles: readonly string[]) => `Role must be one of ${pyTuple(roles)}`,
  usernameTaken: "That username is already in use.",
  lastAdmin: "Cannot disable or demote the only active admin.",
  notFound: "User not found.",
} as const;

/** Renders a JS array the way Python's `f"{roles_tuple}"` renders a tuple
 * (`('admin', 'user')`), since users.py's `_validate_role` error message
 * interpolates `_ROLES` -- a Python tuple -- directly with `f"...{_ROLES}"`. */
function pyTuple(items: readonly string[]): string {
  return `(${items.map((i) => `'${i}'`).join(", ")})`;
}

export const USERNAME_RE = /^[a-z0-9_.-]{3,32}$/;
export const ROLES = ["admin", "user"] as const;
export type Role = (typeof ROLES)[number];

// -- Setup (cloud-only, no Python parity source) ---------------------------

export const SETUP_MESSAGES = {
  alreadyDone: {
    en: "Setup has already been completed.",
    zhTW: "系統已完成初始設定。",
  },
  badToken: {
    en: "Invalid setup token.",
    zhTW: "初始設定金鑰不正確。",
  },
  passwordTooShort: {
    en: "Admin password must be at least 8 characters.",
    zhTW: "管理員密碼長度至少需要 8 個字元。",
  },
} as const;

export function bilingualMessage(m: { en: string; zhTW: string }): string {
  return `${m.zhTW} / ${m.en}`;
}
