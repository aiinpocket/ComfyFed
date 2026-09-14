/**
 * `/api/users` -- admin-only user-management API (Phase 3.0 multi-user).
 * Parity source: server/comfyfed_server/users.py, read in full.
 *
 * `GET/POST /api/users`, `PATCH /api/users/{id}`, `POST
 * /api/users/{id}/reset-password`. No DELETE -- accounts are only ever
 * disabled, never removed (jobs.user_id and receipts reference them
 * indefinitely). See docs/superpowers/specs/2026-09-12-comfyfed-spec.md's
 * Phase 3.0 addendum, subsection 使用者管理 API.
 */

import { Hono, type Context } from "hono";
import type { Env } from "../env";
import {
  getUserById,
  getUserByUsername,
  insertUser,
  listUsersWithJobCounts,
  countJobsForUser,
  countActiveAdmins,
  updateUserPasswordAndBumpEpoch,
  updateUserRoleAndDisabled,
  bumpUserSessionEpoch,
  toSqliteTimestamp,
  type User,
} from "../db/queries";
import { hashPassword } from "../lib/passwords";
import { bytesToHex } from "../lib/hex";
import { requireAdmin, requireCsrf, errorJson } from "../lib/guard";
import { USERNAME_RE, ROLES, USER_MESSAGES, type Role } from "../core/auth";

/** Looks up the `:userId` path param, or answers the 404 `not_found` error
 * shape -- mirrors users.py's `_get_user_or_404`. Returns the `Response`
 * directly (rather than throwing) so callers can `if (result instanceof
 * Response) return result;` and keep full type narrowing on the success
 * path, without this module needing Hono's exception-handling machinery. */
async function getUserOr404(c: Context<{ Bindings: Env }>): Promise<User | Response> {
  const userId = c.req.param("userId") as string;
  const user = await getUserById(c.env.DB, userId);
  if (user === null) {
    return errorJson(c, 404, "not_found", USER_MESSAGES.notFound);
  }
  return user;
}

function randomUserId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Mirrors `secrets.token_urlsafe(12)`: 12 random bytes, base64url-encoded
 * with no padding -- Python's `token_urlsafe(nbytes)` is exactly
 * `base64.urlsafe_b64encode(token_bytes(nbytes)).rstrip(b"=")`. Byte count
 * (not string length) is the parity target, matching that call's argument. */
function randomPassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `toSqliteTimestamp`-shaped ("YYYY-MM-DD HH:MM:SS.ffffff") -> the same
 * shape Python's naive `datetime.isoformat()` renders -- mirrors
 * `db/queries.ts`'s `sqliteTimestampToIsoformat` (users.py's
 * `user.created_at.isoformat()` uses the same naive-UTC `datetime`
 * rendering as every other timestamp column ported this way). */
function toIsoformat(s: string): string {
  const iso = s.replace(" ", "T");
  return iso.endsWith(".000000") ? iso.slice(0, -7) : iso;
}

function userListRow(user: User, jobCount: number) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: user.disabled,
    created_at: user.createdAt ? toIsoformat(user.createdAt) : null,
    jobs: jobCount,
  };
}

interface CreateUserBody {
  username?: unknown;
  role?: unknown;
  password?: unknown;
}

interface PatchUserBody {
  role?: unknown;
  disabled?: unknown;
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/users", requireAdmin, async (c) => {
  const users = await listUsersWithJobCounts(c.env.DB);
  return c.json({ users: users.map((u) => userListRow(u, u.jobs)) });
});

app.post("/api/users", requireCsrf, async (c) => {
  const body = await c.req.json<CreateUserBody>().catch(() => ({}) as CreateUserBody);

  const username = (typeof body.username === "string" ? body.username : "").trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    return errorJson(c, 400, "invalid_username", USER_MESSAGES.invalidUsername);
  }
  if (typeof body.role !== "string" || !(ROLES as readonly string[]).includes(body.role)) {
    return errorJson(c, 400, "invalid_role", USER_MESSAGES.invalidRole(ROLES));
  }
  const role = body.role as Role;
  const password = typeof body.password === "string" && body.password ? body.password : randomPassword();

  const existing = await getUserByUsername(c.env.DB, username);
  if (existing !== null) {
    return errorJson(c, 400, "username_taken", USER_MESSAGES.usernameTaken);
  }

  const id = randomUserId();
  await insertUser(c.env.DB, {
    id,
    username,
    passwordHash: await hashPassword(password),
    role,
    createdAt: toSqliteTimestamp(new Date()),
  });

  return c.json({ id, username, role, password });
});

app.post("/api/users/:userId/reset-password", requireCsrf, async (c) => {
  const target = await getUserOr404(c);
  if (target instanceof Response) return target;

  const password = randomPassword();
  await updateUserPasswordAndBumpEpoch(c.env.DB, target.id, await hashPassword(password));

  return c.json({ password });
});

app.patch("/api/users/:userId", requireCsrf, async (c) => {
  const body = await c.req.json<PatchUserBody>().catch(() => ({}) as PatchUserBody);

  let role: Role | undefined;
  if (body.role !== undefined) {
    if (typeof body.role !== "string" || !(ROLES as readonly string[]).includes(body.role)) {
      return errorJson(c, 400, "invalid_role", USER_MESSAGES.invalidRole(ROLES));
    }
    role = body.role as Role;
  }
  const disabled = typeof body.disabled === "boolean" ? body.disabled : undefined;

  const target = await getUserOr404(c);
  if (target instanceof Response) return target;

  const demoting = role !== undefined && target.role === "admin" && role !== "admin";
  const disabling = disabled === true && !target.disabled;

  if ((demoting || disabling) && target.role === "admin" && !target.disabled) {
    if ((await countActiveAdmins(c.env.DB, target.id)) === 0) {
      return errorJson(c, 400, "last_admin", USER_MESSAGES.lastAdmin);
    }
  }

  await updateUserRoleAndDisabled(c.env.DB, target.id, { role, disabled });
  if (disabling) {
    await bumpUserSessionEpoch(c.env.DB, target.id);
  }

  const jobCount = await countJobsForUser(c.env.DB, target.id);
  const updatedRole = role ?? target.role;
  const updatedDisabled = disabled ?? target.disabled;
  return c.json(userListRow({ ...target, role: updatedRole, disabled: updatedDisabled }, jobCount));
});

export default app;
