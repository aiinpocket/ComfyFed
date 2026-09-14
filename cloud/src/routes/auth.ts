/**
 * `/api/setup/*` and `/api/auth/*` -- parity source: server/comfyfed_server/
 * auth.py.
 *
 * Exact routes mirrored from auth.py: POST /api/auth/login, POST
 * /api/auth/logout, GET /api/auth/me, POST /api/auth/change-password. The
 * `/api/setup/*` routes have no Python equivalent -- the Python deployment
 * is provisioned once via `bootstrap.ensure_installed` on first server start
 * (a CLI-driven, filesystem-backed flow); a stateless Workers deployment has
 * no "first start" hook to run that during, so first-run setup is instead an
 * HTTP contract gated by a `SETUP_TOKEN` the operator sets out-of-band.
 *
 * Phase 3.0 multi-user: `/api/setup` now creates the first `users` row
 * (`username='admin'`, `role='admin'`) instead of writing a bare
 * `admin_password_hash` setting; login takes `{username, password}` with
 * per-username backoff and a dummy-hash timing guard for an unknown/disabled
 * username; the session cookie payload is `{uid, role, epoch, csrf}`; and
 * change-password bumps the user's `session_epoch` (invalidating every OTHER
 * outstanding session for that account) rather than rotating the global
 * signing secret (which used to log out the whole deployment).
 */

import { Hono } from "hono";
import { setCookie, deleteCookie } from "hono/cookie";
import type { Env } from "../env";
import {
  getSetting,
  setSetting,
  getOrCreateSessionSecret,
  rotateSessionSecret,
  insertLoginAttempt,
  getRecentLoginAttemptsForUsername,
  pruneLoginAttempts,
  toSqliteTimestamp,
  hasAnyUser,
  getUserByUsername,
  insertUser,
  updateUserPasswordAndBumpEpoch,
} from "../db/queries";
import { hashPassword, verifyPassword } from "../lib/passwords";
import { bytesToHex } from "../lib/hex";
import { signSessionCookie, generateCsrfToken, COOKIE_MAX_AGE_SECONDS } from "../lib/cookies";
import {
  BACKOFF_WINDOW_MS,
  consecutiveFailures,
  requiredWaitSeconds,
  MESSAGES,
  SETUP_MESSAGES,
  bilingualMessage,
} from "../core/auth";
import { errorJson, requireCsrfUser, SESSION_COOKIE_NAME, readSession, sessionUserFromPayload } from "../lib/guard";

const LANG_KEY = "lang";
const PLATFORM_URL_KEY = "platform_url";

// Rows older than this are pruned on every login write -- purely a storage
// hygiene measure (see queries.ts's pruneLoginAttempts docstring), set well
// beyond the 10-minute backoff window so it can never affect the backoff
// calculation itself.
const LOGIN_ATTEMPT_RETENTION_MS = 24 * 3600 * 1000;

// Verified against every login attempt for a username that doesn't exist (or
// is disabled), so that "no such user" takes the same amount of time as
// "wrong password" -- otherwise response latency would let an attacker
// enumerate valid usernames. Mirrors auth.py's module-level `_DUMMY_HASH`
// (computed once at import time there); here it's computed lazily on first
// use and memoized, since top-level `await` would run PBKDF2 on every
// isolate's cold start whether or not a login ever happens.
const DUMMY_PASSWORD_FOR_TIMING = "comfyfed-dummy-password-for-timing";
let dummyHashPromise: Promise<string> | null = null;
function dummyHash(): Promise<string> {
  if (!dummyHashPromise) dummyHashPromise = hashPassword(DUMMY_PASSWORD_FOR_TIMING);
  return dummyHashPromise;
}

function randomUserId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  // Constant-time-ish comparison for the setup token: same length check up
  // front (lengths of an operator-configured token aren't secret), then
  // XOR-accumulate over the shared length, same technique as
  // lib/passwords.ts's constantTimeEqual.
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i]! ^ bufB[i]!;
  }
  return diff === 0;
}

function setSessionCookie(c: any, value: string): void {
  setCookie(c, SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    path: "/",
    maxAge: COOKIE_MAX_AGE_SECONDS,
  });
}

/** Signs + sets the session cookie for `user`, returning the fresh CSRF
 * token -- mirrors auth.py's `issue_session_cookie`. Payload is `{uid, role,
 * epoch, csrf}`: `epoch` pins this cookie to the user's `session_epoch` at
 * issue time, so a later change-password/disable/reset (which bumps it)
 * invalidates this cookie without touching any other session. */
async function issueSessionCookie(
  c: any,
  db: D1Database,
  user: { id: string; role: string; sessionEpoch: number }
): Promise<string> {
  const csrf = generateCsrfToken();
  const secret = await getOrCreateSessionSecret(db);
  const token = await signSessionCookie(secret, { uid: user.id, role: user.role, epoch: user.sessionEpoch, csrf });
  setSessionCookie(c, token);
  return csrf;
}

const app = new Hono<{ Bindings: Env }>();

// --- /api/setup ------------------------------------------------------------

app.get("/api/setup/status", async (c) => {
  const needed = !(await hasAnyUser(c.env.DB));
  return c.json({ needed });
});

app.post("/api/setup", async (c) => {
  const body = await c.req.json<{ token?: unknown; password?: unknown }>().catch(() => ({}) as any);

  if (await hasAnyUser(c.env.DB)) {
    return errorJson(c, 400, "setup.already_done", bilingualMessage(SETUP_MESSAGES.alreadyDone));
  }

  const token = typeof body.token === "string" ? body.token : "";
  if (!c.env.SETUP_TOKEN || !timingSafeEqualStrings(token, c.env.SETUP_TOKEN)) {
    return errorJson(c, 400, "setup.bad_token", bilingualMessage(SETUP_MESSAGES.badToken));
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (password.length < 8) {
    return errorJson(c, 400, "setup.password_too_short", bilingualMessage(SETUP_MESSAGES.passwordTooShort));
  }

  const hash = await hashPassword(password);
  await insertUser(c.env.DB, {
    id: randomUserId(),
    username: "admin",
    passwordHash: hash,
    role: "admin",
    createdAt: toSqliteTimestamp(new Date()),
  });
  // Seed the session secret eagerly at setup rather than waiting for the
  // first login's lazy get-or-create -- there's no behavioral difference,
  // it just means the very first /api/auth/login after setup doesn't pay
  // the settings-write cost mid-request.
  await rotateSessionSecret(c.env.DB);

  return c.json({ ok: true });
});

// --- /api/auth/* -------------------------------------------------------

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ username?: unknown; password?: unknown }>().catch(() => ({}) as any);
  const username = (typeof body.username === "string" ? body.username : "").trim().toLowerCase();
  const password = typeof body.password === "string" ? body.password : "";

  const now = new Date();
  const cutoff = toSqliteTimestamp(new Date(now.getTime() - BACKOFF_WINDOW_MS));
  const rows = await getRecentLoginAttemptsForUsername(c.env.DB, cutoff, username);
  const { count, latestFailureAtMs } = consecutiveFailures(rows);
  const waitNeeded = requiredWaitSeconds(count);
  if (waitNeeded > 0 && latestFailureAtMs !== null) {
    const elapsedSeconds = (now.getTime() - latestFailureAtMs) / 1000;
    if (elapsedSeconds < waitNeeded) {
      return errorJson(c, 429, "auth.too_many_attempts", MESSAGES.tooManyAttempts);
    }
  }

  const user = await getUserByUsername(c.env.DB, username);
  let ok: boolean;
  if (user === null || user.disabled) {
    // Still run a verify against a dummy hash so an unknown or disabled
    // username takes the same time as a wrong password -- the error message
    // below is identical either way.
    await verifyPassword(password, await dummyHash());
    ok = false;
  } else {
    ok = await verifyPassword(password, user.passwordHash);
  }

  await insertLoginAttempt(c.env.DB, toSqliteTimestamp(now), ok, username);
  await pruneLoginAttempts(c.env.DB, toSqliteTimestamp(new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_MS)));

  if (!ok || user === null) {
    return errorJson(c, 401, "auth.required", MESSAGES.invalidPassword);
  }

  const csrf = await issueSessionCookie(c, c.env.DB, { id: user.id, role: user.role, sessionEpoch: user.sessionEpoch });

  return c.json({ csrf });
});

app.post("/api/auth/logout", async (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const payload = await readSession(c);
  const lang = (await getSetting(c.env.DB, LANG_KEY)) || "en";
  const platformUrl = (await getSetting(c.env.DB, PLATFORM_URL_KEY)) || "";
  const user = await sessionUserFromPayload(c.env.DB, payload);

  if (user === null) {
    return c.json({ authenticated: false, lang, platform_url: platformUrl });
  }

  return c.json({
    authenticated: true,
    username: user.username,
    role: user.role,
    lang,
    platform_url: platformUrl,
  });
});

// Any logged-in user may change their own password (CSRF-protected) -- not
// gated by requireAdmin/requireCsrf (admin-only), since a non-admin `user`
// role must be able to self-service this too. Bumps `session_epoch` so
// every OTHER session for this account stops validating, then immediately
// re-issues a fresh cookie at the new epoch so the caller's own session
// stays logged in.
app.post("/api/auth/change-password", requireCsrfUser, async (c) => {
  const body = await c.req.json<{ old?: unknown; new?: unknown }>().catch(() => ({}) as any);
  const oldPassword = typeof body.old === "string" ? body.old : "";
  const newPassword = typeof body.new === "string" ? body.new : "";

  if (newPassword.length < 8) {
    return errorJson(c, 400, "auth.password_too_short", MESSAGES.passwordTooShort);
  }

  const session = c.get("session");
  const user = await getUserByUsername(c.env.DB, session.user.username);
  if (user === null || !(await verifyPassword(oldPassword, user.passwordHash))) {
    return errorJson(c, 401, "auth.required", MESSAGES.oldPasswordIncorrect);
  }

  const newHash = await hashPassword(newPassword);
  await updateUserPasswordAndBumpEpoch(c.env.DB, user.id, newHash);

  const csrf = await issueSessionCookie(c, c.env.DB, { id: user.id, role: user.role, sessionEpoch: user.sessionEpoch + 1 });

  return c.json({ ok: true, csrf });
});

export default app;
