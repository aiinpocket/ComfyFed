/**
 * Hono middleware/helpers for the admin session + CSRF gate, mirroring
 * server/comfyfed_server/auth.py's `require_admin` / `require_csrf`
 * dependencies. Cookie/hash FORMATS are cloud-local (see lib/cookies.ts,
 * lib/passwords.ts docstrings); the auth SEMANTICS (session cookie name,
 * 401 on missing/invalid session, 403 on missing/mismatched X-CSRF header,
 * error envelope shape) are ported exactly.
 */

import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { readSessionCookie, type SessionPayload } from "./cookies";
import { getOrCreateSessionSecret } from "../db/queries";
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
 * because routes outside auth.ts/settings.ts (a future public `/metrics`,
 * static gates, etc.) may need to check auth without the full
 * `Depends(require_admin)`-style 401-throwing behavior. */
export async function readSession(c: Context<{ Bindings: Env }>): Promise<SessionPayload | null> {
  const cookieHeader = c.req.header("Cookie");
  const cookieValue = extractCookie(cookieHeader, SESSION_COOKIE_NAME);
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

/** Hono variable key the session payload is stashed under after
 * `requireAdmin` succeeds, so downstream handlers (and `requireCsrf`) don't
 * have to re-decode the cookie. */
export const SESSION_VAR = "session" as const;

declare module "hono" {
  interface ContextVariableMap {
    [SESSION_VAR]: SessionPayload;
  }
}

/** Read-only admin gate: 401 `auth.required` if there's no valid,
 * authenticated session. Use for GET routes; state-changing routes should
 * use `requireCsrf` instead (it implies this check). */
export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const payload = await readSession(c);
  if (!payload || !payload.authenticated) {
    return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
  }
  c.set(SESSION_VAR, payload);
  await next();
};

/** Admin gate + CSRF: 401 as above, plus 403 `auth.csrf` if the `X-CSRF`
 * header is missing or doesn't match the session payload's `csrf` value.
 * Use for any state-changing (POST/PUT/DELETE) admin route. */
export const requireCsrf: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const payload = await readSession(c);
  if (!payload || !payload.authenticated) {
    return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
  }
  const xCsrf = c.req.header("X-CSRF");
  if (!xCsrf || xCsrf !== payload.csrf) {
    return errorJson(c, 403, "auth.csrf", MESSAGES.csrfInvalid);
  }
  c.set(SESSION_VAR, payload);
  await next();
};
