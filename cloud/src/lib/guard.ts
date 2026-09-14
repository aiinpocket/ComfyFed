/**
 * Hono middleware/helpers for session auth + CSRF, mirroring
 * server/comfyfed_server/auth.py's `require_user` / `require_admin` /
 * `require_csrf` / `require_csrf_user` / `resolve_session_user` dependencies.
 * Cookie/hash FORMATS are cloud-local (see lib/cookies.ts, lib/passwords.ts
 * docstrings); the auth SEMANTICS -- session cookie name, uid/epoch/disabled
 * validation against the current `users` row, 401 on missing/invalid
 * session, 403 on non-admin or missing/mismatched X-CSRF header, error
 * envelope shape -- are ported exactly.
 *
 * Phase 3.0: a validated session no longer just means "the admin is logged
 * in" -- it resolves to a `SessionUser {uid, username, role}` looked up
 * fresh against D1 on every request (role is read from the DB row, NEVER
 * trusted from the cookie payload, so a role change takes effect on the
 * user's very next request rather than waiting for their cookie to expire).
 */

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { readSessionCookie, type SessionPayload } from "./cookies";
import { getOrCreateSessionSecret, getUserById } from "../db/queries";
import { MESSAGES } from "../core/auth";

export const SESSION_COOKIE_NAME = "cf_session";

/** Standard error envelope: `{ error: { code, message } }`, matching
 * app.py's `_http_exception_handler` shape that server/tests assert against
 * (`r.json()["error"]["code"]`). */
export function errorJson(c: Context, status: number, code: string, message: string): Response {
  return c.json({ error: { code, message } }, status as any);
}

/** Reads and verifies the session cookie off the request, or `null` if
 * absent/invalid/expired. Public (like auth.py's `read_session_payload`)
 * because a few call sites outside this module -- `lib/gate.ts`'s `/comfy`
 * static gate and `routes/metrics.ts`'s conditionally-public `/metrics` --
 * need to check auth without the full 401-throwing middleware shape. This
 * ONLY verifies the cookie's signature/expiry; it does NOT check that the
 * `uid` inside still refers to an existing, enabled user at the right
 * `session_epoch` -- use `resolveSessionUser` (or the `requireUser`/
 * `requireAdmin` middleware) for that, exactly like auth.py's docstring
 * split between `read_session_payload` and `resolve_session_user`. */
export async function readSession(c: Context<{ Bindings: Env }>): Promise<SessionPayload | null> {
  const cookieHeader = c.req.header("Cookie");
  const cookieValue = extractCookie(cookieHeader, SESSION_COOKIE_NAME);
  // Parity with auth.py's `read_session_payload`: `if not session_cookie:
  // return None` happens BEFORE it ever touches the DB for the signing
  // secret. Getting this order backwards means every anonymous request
  // (no cookie at all) would provision a `session_secret` settings row --
  // an unwanted write on a read path, and a footgun for a future D1
  // replica/read-only binding. Only look up (and lazily create) the secret
  // once we actually have a cookie value to verify.
  if (!cookieValue) return null;
  const secret = await getOrCreateSessionSecret(c.env.DB);
  return readSessionCookie(secret, cookieValue);
}

function extractCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/** The authenticated principal behind a validated session cookie -- mirrors
 * auth.py's `SessionUser` dataclass. */
export interface SessionUser {
  uid: string;
  username: string;
  role: string;
}

/** Validates a decoded cookie payload against the current `users` row.
 * Mirrors auth.py's `_session_user_from_payload`: rejects (returns `null`) a
 * payload with no `uid` (this includes every pre-Phase-3.0 cookie, which
 * only ever carried `{authenticated, csrf}` -- those are deliberately NOT
 * mapped onto any account; everyone re-authenticates once after this
 * upgrade), a `uid` with no matching row, a disabled user, or an `epoch`
 * that no longer matches the user's current `session_epoch` (password
 * changed/reset/disabled since this cookie was issued). Exported (rather
 * than kept private) so `do/hub.ts`'s panel WebSocket upgrade -- which
 * verifies the cookie itself, off a raw `Request` with no Hono `Context` --
 * can reuse this exact validation instead of re-implementing it. */
export async function sessionUserFromPayload(
  db: D1Database,
  payload: SessionPayload | null
): Promise<SessionUser | null> {
  if (!payload) return null;
  const uid = payload.uid;
  if (!uid) return null;
  const user = await getUserById(db, uid);
  if (!user || user.disabled) return null;
  if (payload.epoch !== user.sessionEpoch) return null;
  return { uid: user.id, username: user.username, role: user.role };
}

/** Full cookie-to-`SessionUser` resolution for hand-checked call sites --
 * mirrors auth.py's `resolve_session_user`, used by the same three
 * call sites here as there: the `/comfy` static gate, the conditionally
 * public `/metrics` route, and the panel WebSocket upgrade. */
export async function resolveSessionUser(c: Context<{ Bindings: Env }>): Promise<SessionUser | null> {
  const payload = await readSession(c);
  return sessionUserFromPayload(c.env.DB, payload);
}

/** Hono variable key the resolved session is stashed under after
 * `requireUser`/`requireAdmin`/`requireCsrf`/`requireCsrfUser` succeeds, so
 * downstream handlers don't have to re-resolve it. */
export const SESSION_VAR = "session" as const;

export interface AuthedSession {
  user: SessionUser;
  /** The cookie payload's CSRF token, carried alongside the resolved user so
   * `requireCsrf`/`requireCsrfUser` (and any handler that wants to re-issue
   * the same token) don't need a second cookie decode. */
  csrf: string;
}

declare module "hono" {
  interface ContextVariableMap {
    [SESSION_VAR]: AuthedSession;
  }
}

async function resolveAuthedSession(c: Context<{ Bindings: Env }>): Promise<AuthedSession | null> {
  const payload = await readSession(c);
  const user = await sessionUserFromPayload(c.env.DB, payload);
  if (!user || !payload) return null;
  return { user, csrf: payload.csrf };
}

/** Any logged-in, enabled, current-epoch user -- mirrors auth.py's
 * `require_user`. 401 `auth.required` if the cookie is absent/invalid/
 * missing uid, or if the referenced user is missing, disabled, or
 * stale-epoch. Use for read-only routes any logged-in user (not just an
 * admin) may call. */
export const requireUser: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const session = await resolveAuthedSession(c);
  if (!session) {
    return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
  }
  c.set(SESSION_VAR, session);
  await next();
};

/** `requireUser` plus `role === 'admin'` -- mirrors auth.py's
 * `require_admin`. 401 unauthenticated (via the same check as `requireUser`),
 * 403 `auth.forbidden` for a logged-in non-admin. Use for read-only
 * admin-only routes; state-changing routes should use `requireCsrf` instead
 * (it implies this check). */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const session = await resolveAuthedSession(c);
  if (!session) {
    return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
  }
  if (session.user.role !== "admin") {
    return errorJson(c, 403, "auth.forbidden", MESSAGES.adminRequired);
  }
  c.set(SESSION_VAR, session);
  await next();
};

function checkCsrf(c: Context, session: AuthedSession): Response | null {
  const xCsrf = c.req.header("X-CSRF");
  if (!xCsrf || xCsrf !== session.csrf) {
    return errorJson(c, 403, "auth.csrf", MESSAGES.csrfInvalid);
  }
  return null;
}

/** Admin gate + CSRF -- mirrors auth.py's `require_csrf`: 401 as
 * `requireAdmin` above, 403 `auth.forbidden` for a non-admin, plus 403
 * `auth.csrf` if the `X-CSRF` header is missing or doesn't match the
 * session's CSRF token. Use for any state-changing (POST/PUT/PATCH/DELETE)
 * admin route -- the users API's mutating routes included. */
export const requireCsrf: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const session = await resolveAuthedSession(c);
  if (!session) {
    return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
  }
  if (session.user.role !== "admin") {
    return errorJson(c, 403, "auth.forbidden", MESSAGES.adminRequired);
  }
  const csrfError = checkCsrf(c, session);
  if (csrfError) return csrfError;
  c.set(SESSION_VAR, session);
  await next();
};

/** Like `requireCsrf` but for any logged-in user, not just an admin --
 * mirrors auth.py's `require_csrf_user`. Phase 3.0's `change-password` is
 * CSRF-protected but self-service for any role, so it can't hang off
 * `requireCsrf` (admin-only). Owner-or-admin, state-changing routes (a
 * future task's per-user job submission/cancel) use this too. */
export const requireCsrfUser: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const session = await resolveAuthedSession(c);
  if (!session) {
    return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
  }
  const csrfError = checkCsrf(c, session);
  if (csrfError) return csrfError;
  c.set(SESSION_VAR, session);
  await next();
};
