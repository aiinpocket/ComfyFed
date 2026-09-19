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
  sqliteTimestampToIsoformat,
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
import {
  errorJson,
  requireCsrfSession,
  requireSession,
  resolveBearerSession,
  SESSION_COOKIE_NAME,
  SESSION_VAR,
  readSession,
  sessionUserFromPayload,
} from "../lib/guard";
import * as apiTokens from "../core/api_tokens";
import { getUserById } from "../db/queries";

const LANG_KEY = "lang";
const PLATFORM_URL_KEY = "platform_url";

/** Final review finding #6: reach the Hub DO to close any open panel
 * WebSocket for `uid` right after `change-password` bumps its
 * session_epoch -- mirrors `routes/users.ts`'s own copy of this helper
 * (kept as a small per-file copy rather than a cross-route import, matching
 * that file's/comfyapi.ts's stated convention for `wakeHub`-shaped
 * helpers). Never throws: a Hub DO hiccup here must not fail the
 * change-password response itself. */
async function closePanelForUid(env: Env, uid: string): Promise<void> {
  try {
    const stub = env.HUB.get(env.HUB.idFromName("hub"));
    await stub.fetch("http://hub.internal/internal/close_panel_for_uid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid }),
    });
  } catch (err) {
    console.warn("auth: failed to close panel socket for uid", uid, err);
  }
}

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

  // Final review finding #9: the server's `LoginBody` Pydantic model makes
  // BOTH `username` and `password` required, so a missing/non-string EITHER
  // field yields FastAPI's `{"error": {"code": "validation_error", ...}}`
  // 422 envelope (see auth.py's app-wide validation-error handler) -- cloud
  // used to coerce a missing field to `""` and fall through to a 401
  // `auth.required`, which was at least symmetric between the two fields
  // but disagreed with the server's status code entirely. Aligning both
  // fields to the server's 422/validation_error shape here, rather than
  // aligning the server down to 401, since the plan's Global Constraints
  // demand identical error shapes and 422-for-missing-required-field is the
  // server's existing, load-bearing convention (see e.g. `test_auth.py`'s
  // `test_validation_error_uses_the_standard_error_envelope`).
  if (typeof body.username !== "string" || typeof body.password !== "string") {
    return errorJson(c, 422, "validation_error", "Invalid request body.");
  }

  const username = body.username.trim().toLowerCase();
  const password = body.password;

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

// Cookie-only (spec §4.3): there is no cookie for a bearer caller to drop,
// so an API token gets the same 401 here as an anonymous request.
app.post("/api/auth/logout", requireCsrfSession, async (c) => {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  return c.json({ ok: true });
});

// Final-review M3：`/api/auth/me` 的回應是每個使用者各自不同的（username /
// role / csrf），絕不能落入任何共用快取 -- 跟 routes/templates.ts 的
// `INDEX_CACHE_CONTROL` 同一個理由：Worker 回應預設不被 edge 快取，但一條
// 「Cache Everything」規則（或任何中繼）就能把一個人的身分發給另一個人。
const ME_CACHE_CONTROL = "private, no-store";

// Copied verbatim from auth.py's token routes (bilingual there, so bilingual
// here -- these are the only strings in this file the Python side writes in
// both languages).
const TOKEN_MESSAGES = {
  badName:
    `Token name must be at most ${apiTokens.API_TOKEN_NAME_MAX} characters.`
    + ` / 名稱最多 ${apiTokens.API_TOKEN_NAME_MAX} 字。`,
  tooMany:
    `At most ${apiTokens.API_TOKEN_MAX_ACTIVE_PER_USER} active tokens;`
    + ` revoke one first. / 最多 ${apiTokens.API_TOKEN_MAX_ACTIVE_PER_USER}`
    + ` 枚有效 token，請先撤銷一枚。`,
  notFound: "No such token.",
} as const;

// Who am I, and (spec §4.3) by which credential.
//
// Anonymous callers still get the public `{authenticated: false, lang,
// platform_url}` shape -- the console reads this before login. A bearer
// caller is the exception: a present-but-invalid `Authorization` header is a
// 401, not an anonymous 200, because this is the route the MCP client calls
// to check its token is still good (spec §6.3 `platform_status`), and "your
// token died" must not look like "the platform is fine".
app.get("/api/auth/me", async (c) => {
  c.header("Cache-Control", ME_CACHE_CONTROL);

  const authorization = c.req.header("Authorization");
  let tokenSession = null;
  if (authorization !== undefined) {
    tokenSession = await resolveBearerSession(c, authorization);
    if (tokenSession === null) {
      return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
    }
  }

  const payload = tokenSession !== null ? null : await readSession(c);
  const lang = (await getSetting(c.env.DB, LANG_KEY)) || "en";
  const platformUrl = (await getSetting(c.env.DB, PLATFORM_URL_KEY)) || "";
  const user = tokenSession !== null ? tokenSession.user : await sessionUserFromPayload(c.env.DB, payload);

  if (user === null) {
    return c.json({ authenticated: false, lang, platform_url: platformUrl });
  }

  return c.json({
    authenticated: true,
    username: user.username,
    role: user.role,
    lang,
    platform_url: platformUrl,
    // 同一組 key 的 superset：cookie 呼叫回 csrf 與 `token_expires_at: null`，
    // bearer 呼叫回 `csrf: null` 與到期時間 -- 兩棧同形狀（spec §4.3）。
    csrf: payload?.csrf ?? null,
    auth: user.auth,
    token_expires_at: user.tokenExpiresAt,
  });
});

// Any logged-in user may change their own password (CSRF-protected) -- not
// gated by requireAdmin/requireCsrf (admin-only), since a non-admin `user`
// role must be able to self-service this too. Bumps `session_epoch` so
// every OTHER session for this account stops validating, then immediately
// re-issues a fresh cookie at the new epoch so the caller's own session
// stays logged in.
// Cookie-only (`requireCsrfSession`, spec §4.3): an API token must not be
// able to rotate the password of the account it belongs to -- especially
// since doing so would bump `session_epoch` and kill every OTHER token.
app.post("/api/auth/change-password", requireCsrfSession, async (c) => {
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
  await closePanelForUid(c.env, user.id);

  const csrf = await issueSessionCookie(c, c.env.DB, { id: user.id, role: user.role, sessionEpoch: user.sessionEpoch + 1 });

  return c.json({ ok: true, csrf });
});

// 2026-09-19 spec §4.2：三條 token 管理端點，全部只收 cookie（bearer 一律
// 401 —— token 不能再生 token）。改狀態的那兩條另外要 CSRF
// （`requireCsrfSession`）；只讀的清單走 `requireSession`，GET 本來就
// 不是 CSRF 防的對象，console 的 fetch 包裝也不會在 GET 上帶 `X-CSRF`。

/** Mint an API token for the caller. The plaintext appears in THIS response
 * and nowhere else, ever -- the server keeps only its sha256. The body (and
 * `name` within it) is optional (spec §4.2), so a caller that just wants a
 * token need not invent a label for it. */
app.post("/api/auth/tokens", requireCsrfSession, async (c) => {
  const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as any);
  const name = typeof body?.name === "string" ? body.name : "";

  const session = c.get(SESSION_VAR);
  const user = await getUserById(c.env.DB, session.user.uid);
  if (user === null) {
    return errorJson(c, 401, "auth.required", MESSAGES.authRequired);
  }

  const now = new Date();
  let created;
  try {
    created = await apiTokens.createToken(c.env.DB, user, name, now);
  } catch (err) {
    if (err instanceof apiTokens.BadName) {
      return errorJson(c, 400, "auth.bad_token_name", TOKEN_MESSAGES.badName);
    }
    if (err instanceof apiTokens.TooManyTokens) {
      return errorJson(c, 409, "auth.too_many_tokens", TOKEN_MESSAGES.tooMany);
    }
    throw err;
  }

  const { row, plaintext } = created;
  return c.json(
    {
      id: row.id,
      name: row.name,
      token: plaintext,
      prefix: row.prefix,
      created_at: sqliteTimestampToIsoformat(row.createdAt),
      expires_at: sqliteTimestampToIsoformat(row.expiresAt),
    },
    201
  );
});

/** The caller's own tokens, newest first. Never includes any plaintext. */
app.get("/api/auth/tokens", requireSession, async (c) => {
  const session = c.get(SESSION_VAR);
  return c.json(await apiTokens.listTokens(c.env.DB, session.user.uid, new Date()));
});

/** Revoke one of the caller's tokens. Idempotent; someone else's token (or
 * one that never existed) is a 404 -- the two are deliberately
 * indistinguishable, so this cannot be used to probe for token ids. */
app.delete("/api/auth/tokens/:tokenId", requireCsrfSession, async (c) => {
  const session = c.get(SESSION_VAR);
  const revoked = await apiTokens.revokeToken(c.env.DB, session.user.uid, c.req.param("tokenId"), new Date());
  if (!revoked) {
    return errorJson(c, 404, "auth.token_not_found", TOKEN_MESSAGES.notFound);
  }
  return c.json({ revoked: true });
});

export default app;
