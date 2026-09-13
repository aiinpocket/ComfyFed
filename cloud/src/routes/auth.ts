/**
 * `/api/setup/*` and `/api/auth/*` -- parity source: server/comfyfed_server/auth.py.
 *
 * Exact routes mirrored from auth.py: POST /api/auth/login, POST
 * /api/auth/logout, GET /api/auth/me, POST /api/auth/change-password. The
 * `/api/setup/*` routes have no Python equivalent -- the Python deployment
 * is provisioned once via `bootstrap.ensure_installed` on first server start
 * (a CLI-driven, filesystem-backed flow); a stateless Workers deployment has
 * no "first start" hook to run that during, so first-run setup is instead an
 * HTTP contract gated by a `SETUP_TOKEN` the operator sets out-of-band.
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
  getRecentLoginAttempts,
  pruneLoginAttempts,
  toSqliteTimestamp,
} from "../db/queries";
import { hashPassword, verifyPassword } from "../lib/passwords";
import { signSessionCookie, generateCsrfToken, COOKIE_MAX_AGE_SECONDS } from "../lib/cookies";
import {
  BACKOFF_WINDOW_MS,
  consecutiveFailures,
  requiredWaitSeconds,
  MESSAGES,
  SETUP_MESSAGES,
  bilingualMessage,
} from "../core/auth";
import { errorJson, requireCsrf, SESSION_COOKIE_NAME, readSession } from "../lib/guard";

const ADMIN_PASSWORD_HASH_KEY = "admin_password_hash";
const LANG_KEY = "lang";
const PLATFORM_URL_KEY = "platform_url";

// Rows older than this are pruned on every login write -- purely a storage
// hygiene measure (see queries.ts's pruneLoginAttempts docstring), set well
// beyond the 10-minute backoff window so it can never affect the backoff
// calculation itself.
const LOGIN_ATTEMPT_RETENTION_MS = 24 * 3600 * 1000;

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

const app = new Hono<{ Bindings: Env }>();

// --- /api/setup ------------------------------------------------------------

app.get("/api/setup/status", async (c) => {
  const hash = await getSetting(c.env.DB, ADMIN_PASSWORD_HASH_KEY);
  return c.json({ needed: !hash });
});

app.post("/api/setup", async (c) => {
  const body = await c.req.json<{ token?: unknown; password?: unknown }>().catch(() => ({}) as any);

  const existingHash = await getSetting(c.env.DB, ADMIN_PASSWORD_HASH_KEY);
  if (existingHash) {
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
  await setSetting(c.env.DB, ADMIN_PASSWORD_HASH_KEY, hash);
  // Seed the session secret eagerly at setup rather than waiting for the
  // first login's lazy get-or-create -- there's no behavioral difference,
  // it just means the very first /api/auth/login after setup doesn't pay
  // the settings-write cost mid-request.
  await rotateSessionSecret(c.env.DB);

  return c.json({ ok: true });
});

// --- /api/auth/* -------------------------------------------------------

app.post("/api/auth/login", async (c) => {
  const body = await c.req.json<{ password?: unknown }>().catch(() => ({}) as any);
  const password = typeof body.password === "string" ? body.password : "";

  const now = new Date();
  const cutoff = toSqliteTimestamp(new Date(now.getTime() - BACKOFF_WINDOW_MS));
  const rows = await getRecentLoginAttempts(c.env.DB, cutoff);
  const { count, latestFailureAtMs } = consecutiveFailures(rows);
  const waitNeeded = requiredWaitSeconds(count);
  if (waitNeeded > 0 && latestFailureAtMs !== null) {
    const elapsedSeconds = (now.getTime() - latestFailureAtMs) / 1000;
    if (elapsedSeconds < waitNeeded) {
      return errorJson(c, 429, "auth.too_many_attempts", MESSAGES.tooManyAttempts);
    }
  }

  const adminHash = await getSetting(c.env.DB, ADMIN_PASSWORD_HASH_KEY);
  const ok = Boolean(adminHash) && (await verifyPassword(password, adminHash!));

  await insertLoginAttempt(c.env.DB, toSqliteTimestamp(now), ok);
  await pruneLoginAttempts(c.env.DB, toSqliteTimestamp(new Date(now.getTime() - LOGIN_ATTEMPT_RETENTION_MS)));

  if (!ok) {
    return errorJson(c, 401, "auth.required", MESSAGES.invalidPassword);
  }

  const secret = await getOrCreateSessionSecret(c.env.DB);
  const csrf = generateCsrfToken();
  const token = await signSessionCookie(secret, { authenticated: true, csrf });
  setSessionCookie(c, token);

  return c.json({ csrf });
});

app.post("/api/auth/logout", async (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/auth/me", async (c) => {
  const payload = await readSession(c);
  const authenticated = Boolean(payload && payload.authenticated);
  const lang = (await getSetting(c.env.DB, LANG_KEY)) || "en";
  const platformUrl = (await getSetting(c.env.DB, PLATFORM_URL_KEY)) || "";
  return c.json({ authenticated, lang, platform_url: platformUrl });
});

app.post("/api/auth/change-password", requireCsrf, async (c) => {
  const body = await c.req.json<{ old?: unknown; new?: unknown }>().catch(() => ({}) as any);
  const oldPassword = typeof body.old === "string" ? body.old : "";
  const newPassword = typeof body.new === "string" ? body.new : "";

  if (newPassword.length < 8) {
    return errorJson(c, 400, "auth.password_too_short", MESSAGES.passwordTooShort);
  }

  const adminHash = await getSetting(c.env.DB, ADMIN_PASSWORD_HASH_KEY);
  if (!adminHash || !(await verifyPassword(oldPassword, adminHash))) {
    return errorJson(c, 401, "auth.required", MESSAGES.oldPasswordIncorrect);
  }

  const newHash = await hashPassword(newPassword);
  await setSetting(c.env.DB, ADMIN_PASSWORD_HASH_KEY, newHash);

  // Rotate the cookie-signing secret so every session issued under the old
  // password stops validating -- including this request's own session.
  await rotateSessionSecret(c.env.DB);

  return c.json({ ok: true });
});

export default app;
