/**
 * `/api/users` -- admin-only user-management API (Phase 3.0 multi-user).
 * Ported from the former Python server (2026-09); this file is now the only
 * implementation.
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
import { USERNAME_RE, ROLES, USER_MESSAGES, MESSAGES, type Role } from "../core/auth";
import {
  MAX_UPLOAD_MAX_FILE_MB,
  MAX_UPLOAD_USER_QUOTA_GB,
  MIN_UPLOAD_MAX_FILE_MB,
  MIN_UPLOAD_USER_QUOTA_GB,
  usageBytes,
} from "../lib/limits";

/** Final review finding #6: reach the Hub DO to close any open panel
 * WebSocket for `uid` right after a session_epoch bump (reset-password,
 * disable) -- same fire-and-forget internal-HTTP-hop pattern
 * `routes/jobs.ts`'s `wakeHub`/cancel calls use, since this route runs as a
 * plain Worker fetch handler with no direct handle on the DO's live
 * sockets. Never throws: a Hub DO hiccup here must not fail the
 * reset-password/disable response itself. */
async function closePanelForUid(env: Env, uid: string): Promise<void> {
  try {
    const stub = env.HUB.get(env.HUB.idFromName("hub"));
    await stub.fetch("http://hub.internal/internal/close_panel_for_uid", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uid }),
    });
  } catch (err) {
    console.warn("users: failed to close panel socket for uid", uid, err);
  }
}

/** Looks up the `:userId` path param, or answers the 404 `not_found` error
 * shape -- mirrors the former Python `_get_user_or_404`. Returns the `Response`
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
 * `db/queries.ts`'s `sqliteTimestampToIsoformat` (the former Python
 * `user.created_at.isoformat()` uses the same naive-UTC `datetime`
 * rendering as every other timestamp column ported this way). */
function toIsoformat(s: string): string {
  const iso = s.replace(" ", "T");
  return iso.endsWith(".000000") ? iso.slice(0, -7) : iso;
}

function userListRow(user: User, jobCount: number, usedBytes?: number) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: user.disabled,
    created_at: user.createdAt ? toIsoformat(user.createdAt) : null,
    jobs: jobCount,
    // 2026-09-24 配額納入 job 位元組：這個人目前占用的空間（staging + userdata
    // + job 成品／輸入，lib/limits.ts `usageBytes`）。只有 `GET /api/users` 的
    // 列表帶，單列回應（建立／修改）不算 -- 那兩條路沒必要多兩次 R2 list。
    // Only present on the admin list; absent (not null) on single-row responses.
    ...(usedBytes !== undefined ? { used_bytes: usedBytes } : {}),
    // 2026-09-20 每人覆寫：null = 沿用全案預設（額度）／允許（NSFW）。
    max_file_mb: user.maxFileMb,
    quota_gb: user.quotaGb,
    nsfw_allowed: user.nsfwAllowed,
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
  // 2026-09-20 每人覆寫。「沒帶」與「帶 null」意思不同：沒帶 = 不動；null =
  // 清掉覆寫、回到全案預設 -- 同原 Python 版用 `model_fields_set` 分辨。
  max_file_mb?: unknown;
  quota_gb?: unknown;
  nsfw_allowed?: unknown;
}

const BAD_MAX_FILE_MB =
  `單檔上限必須是 ${MIN_UPLOAD_MAX_FILE_MB}–${MAX_UPLOAD_MAX_FILE_MB} 之間的整數 MB。` +
  ` / Max file size must be a whole number of MB between ${MIN_UPLOAD_MAX_FILE_MB} and ${MAX_UPLOAD_MAX_FILE_MB}.`;
const BAD_QUOTA_GB =
  `儲存配額必須介於 ${MIN_UPLOAD_USER_QUOTA_GB} 與 ${MAX_UPLOAD_USER_QUOTA_GB} GB 之間。` +
  ` / Storage quota must be between ${MIN_UPLOAD_USER_QUOTA_GB} and ${MAX_UPLOAD_USER_QUOTA_GB} GB.`;

const app = new Hono<{ Bindings: Env }>();

app.get("/api/users", requireAdmin, async (c) => {
  const users = await listUsersWithJobCounts(c.env.DB);
  // 2026-09-24 每列帶 `used_bytes`：trusted-circle 規模只有一小撮使用者，每人
  // 兩次 R2 prefix list ＋ 一次 SUM 可以接受；並行跑而不是逐人等。
  const usedBytes = await Promise.all(users.map((u) => usageBytes(c.env.DB, c.env.STORE, u.id)));
  return c.json({ users: users.map((u, i) => userListRow(u, u.jobs, usedBytes[i])) });
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

  // Final review finding #8: the same 8-char minimum self-service
  // change-password enforces (routes/auth.ts's `change-password`) -- an
  // admin could otherwise create an account with password `a`. A generated
  // password (`randomPassword()`) always complies, so this only ever
  // rejects an admin-supplied one.
  if (password.length < 8) {
    return errorJson(c, 400, "auth.password_too_short", MESSAGES.passwordTooShort);
  }

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
  await closePanelForUid(c.env, target.id);

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

  // 每人覆寫：`undefined` = 沒帶（不動），`null` = 清掉。
  let maxFileMb: number | null | undefined;
  if ("max_file_mb" in body && body.max_file_mb !== undefined) {
    if (body.max_file_mb === null) {
      maxFileMb = null;
    } else {
      const mb = typeof body.max_file_mb === "number" ? body.max_file_mb : NaN;
      if (!Number.isFinite(mb) || !Number.isInteger(mb) || mb < MIN_UPLOAD_MAX_FILE_MB || mb > MAX_UPLOAD_MAX_FILE_MB) {
        return errorJson(c, 400, "users.bad_max_file_mb", BAD_MAX_FILE_MB);
      }
      maxFileMb = mb;
    }
  }
  let quotaGb: number | null | undefined;
  if ("quota_gb" in body && body.quota_gb !== undefined) {
    if (body.quota_gb === null) {
      quotaGb = null;
    } else {
      const gb = typeof body.quota_gb === "number" ? body.quota_gb : NaN;
      if (!Number.isFinite(gb) || gb < MIN_UPLOAD_USER_QUOTA_GB || gb > MAX_UPLOAD_USER_QUOTA_GB) {
        return errorJson(c, 400, "users.bad_quota_gb", BAD_QUOTA_GB);
      }
      quotaGb = gb;
    }
  }
  let nsfwAllowed: boolean | null | undefined;
  if ("nsfw_allowed" in body && body.nsfw_allowed !== undefined) {
    if (body.nsfw_allowed === null) {
      nsfwAllowed = null;
    } else if (typeof body.nsfw_allowed === "boolean") {
      nsfwAllowed = body.nsfw_allowed;
    } else {
      return errorJson(
        c,
        400,
        "users.bad_nsfw_allowed",
        "nsfw_allowed 必須是 true、false 或 null。 / nsfw_allowed must be true, false or null."
      );
    }
  }

  const target = await getUserOr404(c);
  if (target instanceof Response) return target;

  const demoting = role !== undefined && target.role === "admin" && role !== "admin";
  const disabling = disabled === true && !target.disabled;

  if ((demoting || disabling) && target.role === "admin" && !target.disabled) {
    if ((await countActiveAdmins(c.env.DB, target.id)) === 0) {
      return errorJson(c, 400, "last_admin", USER_MESSAGES.lastAdmin);
    }
  }

  await updateUserRoleAndDisabled(c.env.DB, target.id, { role, disabled, maxFileMb, quotaGb, nsfwAllowed });
  if (disabling) {
    await bumpUserSessionEpoch(c.env.DB, target.id);
    await closePanelForUid(c.env, target.id);
  }

  const jobCount = await countJobsForUser(c.env.DB, target.id);
  const updatedRole = role ?? target.role;
  const updatedDisabled = disabled ?? target.disabled;
  return c.json(
    userListRow(
      {
        ...target,
        role: updatedRole,
        disabled: updatedDisabled,
        maxFileMb: maxFileMb === undefined ? target.maxFileMb : maxFileMb,
        quotaGb: quotaGb === undefined ? target.quotaGb : quotaGb,
        nsfwAllowed: nsfwAllowed === undefined ? target.nsfwAllowed : nsfwAllowed,
      },
      jobCount
    )
  );
});

export default app;
