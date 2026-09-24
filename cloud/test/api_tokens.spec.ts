/**
 * 2026-09-19 API token（spec §4）的 cloud 孿生測試 —— 逐案對應
 * 原 Python 測試套件：建立／列出／撤銷，以及 bearer 認證。
 *
 * Cloud twin of the Python suite, case for case. Where Python reaches into
 * its SQLAlchemy session to inspect/poke a row, this reaches into D1 with
 * the same intent (`db()` from helpers/http.ts).
 */

import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp } from "../src/db/queries";
import * as apiTokens from "../src/core/api_tokens";

// vitest-pool-workers isolates D1 storage per test FILE, not per `it()` --
// reset every table this file writes to (api_tokens included) after each test.
afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM api_tokens").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM users").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

interface Session {
  cookie: string | null;
  csrf: string;
}

async function login(username = "admin", password = ADMIN_PASSWORD): Promise<Session> {
  const r = await call("/api/auth/login", { json: { username, password } });
  expect(r.status).toBe(200);
  return { cookie: r.setCookie, csrf: r.body.csrf };
}

/** setup + login as the admin, the `client` fixture + `_login` of the
 * Python suite rolled into one. */
async function adminSession(): Promise<Session> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  return login();
}

async function createToken(session: Session, name: string | undefined = "ai") {
  return call("/api/auth/tokens", {
    method: "POST",
    json: name === undefined ? {} : { name },
    cookie: session.cookie,
    headers: { "X-CSRF": session.csrf },
  });
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function tokenRow(id: string): Promise<any> {
  return db().prepare("SELECT * FROM api_tokens WHERE id = ?").bind(id).first<any>();
}

const SIMPLE_WORKFLOW = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };

/** `POST /api/jobs` is multipart-only, which `helpers/http.ts`'s `call`
 * can't send -- same local `raw` shape jobs.spec.ts uses. */
async function submitJob(headers: Record<string, string>, cookie?: string | null) {
  const form = new FormData();
  form.set("workflow_json", JSON.stringify(SIMPLE_WORKFLOW));
  const allHeaders: Record<string, string> = { ...headers };
  if (cookie) allHeaders["Cookie"] = cookie;
  const request = new Request("http://example.com/api/jobs", {
    method: "POST",
    headers: allHeaders,
    body: form,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

// --- 建立 ---------------------------------------------------------------

describe("POST /api/auth/tokens", () => {
  it("returns the plaintext exactly once", async () => {
    const session = await adminSession();
    const r = await createToken(session, "my ai");
    expect(r.status).toBe(201);

    expect(r.body.name).toBe("my ai");
    expect(r.body.token.startsWith("cft_")).toBe(true);
    expect(r.body.token.length).toBe(47);
    expect(r.body.prefix).toBe(r.body.token.slice(0, 12));
    expect(r.body.created_at).toBeTruthy();
    expect(r.body.expires_at).toBeTruthy();
    expect(r.body.id).toBeTruthy();
  });

  it("expires in 30 days", async () => {
    const session = await adminSession();
    const created = (await createToken(session)).body;
    const row = await tokenRow(created.id);
    const days = (new Date(row.expires_at.replace(" ", "T") + "Z").getTime()
      - new Date(row.created_at.replace(" ", "T") + "Z").getTime()) / 86400000;
    expect(days).toBe(apiTokens.API_TOKEN_TTL_DAYS);
  });

  it("never shows the plaintext again in the listing", async () => {
    const session = await adminSession();
    const plaintext = (await createToken(session)).body.token;

    const listed = await call("/api/auth/tokens", { method: "GET", cookie: session.cookie });
    expect(listed.status).toBe(200);
    const rows = listed.body;
    expect(rows.length).toBe(1);
    expect(rows[0]).not.toHaveProperty("token");
    expect(JSON.stringify(rows)).not.toContain(plaintext);
    expect(rows[0].prefix).toBe(plaintext.slice(0, 12));
    expect(rows[0].active).toBe(true);
    expect(rows[0].last_used_at).toBeNull();
    expect(rows[0].revoked_at).toBeNull();
  });

  it("rejects a name over 64 chars", async () => {
    const session = await adminSession();
    const r = await createToken(session, "x".repeat(65));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("auth.bad_token_name");
    expect((await createToken(session, "x".repeat(64))).status).toBe(201);
  });

  it("rejects the eleventh active token until one is revoked", async () => {
    const session = await adminSession();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      ids.push((await createToken(session, `t${i}`)).body.id);
    }

    const over = await createToken(session, "t10");
    expect(over.status).toBe(409);
    expect(over.body.error.code).toBe("auth.too_many_tokens");

    const revoked = await call(`/api/auth/tokens/${ids[0]}`, {
      method: "DELETE",
      cookie: session.cookie,
      headers: { "X-CSRF": session.csrf },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toEqual({ revoked: true });

    expect((await createToken(session, "t10")).status).toBe(201);
  });

  it("accepts a request with no name (empty name)", async () => {
    const session = await adminSession();
    const r = await call("/api/auth/tokens", {
      method: "POST",
      cookie: session.cookie,
      headers: { "X-CSRF": session.csrf },
    });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe("");
  });
});

// --- 撤銷 ---------------------------------------------------------------

describe("token management routes", () => {
  it("requires the CSRF header on the state-changing routes", async () => {
    const session = await adminSession();
    const tokenId = (await createToken(session)).body.id;

    const created = await call("/api/auth/tokens", {
      method: "POST",
      json: { name: "x" },
      cookie: session.cookie,
    });
    expect(created.status).toBe(403);
    const deleted = await call(`/api/auth/tokens/${tokenId}`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(deleted.status).toBe(403);
  });

  it("lists cookie-only without CSRF, and 401s a bearer caller", async () => {
    const session = await adminSession();
    const token = (await createToken(session)).body.token;

    expect((await call("/api/auth/tokens", { method: "GET", cookie: session.cookie })).status).toBe(200);
    expect((await call("/api/auth/tokens", { method: "GET", headers: bearer(token) })).status).toBe(401);
    expect((await call("/api/auth/tokens", { method: "GET" })).status).toBe(401);
  });

  it("404s an unknown token id", async () => {
    const session = await adminSession();
    const r = await call("/api/auth/tokens/nope", {
      method: "DELETE",
      cookie: session.cookie,
      headers: { "X-CSRF": session.csrf },
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("auth.token_not_found");
  });

  it("revokes idempotently and flips `active`", async () => {
    const session = await adminSession();
    const tokenId = (await createToken(session)).body.id;
    const revoke = () =>
      call(`/api/auth/tokens/${tokenId}`, {
        method: "DELETE",
        cookie: session.cookie,
        headers: { "X-CSRF": session.csrf },
      });

    expect((await revoke()).status).toBe(200);
    const again = await revoke();
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ revoked: true });

    const row = (await call("/api/auth/tokens", { method: "GET", cookie: session.cookie })).body[0];
    expect(row.active).toBe(false);
    expect(row.revoked_at).not.toBeNull();
  });

  it("only lists (and only revokes) your own tokens", async () => {
    const admin = await adminSession();
    const created = await call("/api/users", {
      json: { username: "someone", role: "user", password: "s3cret-password" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(created.status).toBe(200);
    const mine = (await createToken(admin, "admin-token")).body.id;

    const other = await login("someone", "s3cret-password");
    const theirs = (await createToken(other, "their-token")).body.id;

    const rows = (await call("/api/auth/tokens", { method: "GET", cookie: other.cookie })).body;
    expect(rows.map((r: any) => r.id)).toEqual([theirs]);

    const stolen = await call(`/api/auth/tokens/${mine}`, {
      method: "DELETE",
      cookie: other.cookie,
      headers: { "X-CSRF": other.csrf },
    });
    expect(stolen.status).toBe(404);
  });
});

// --- bearer 認證 --------------------------------------------------------

describe("bearer authentication", () => {
  it("can read jobs", async () => {
    const session = await adminSession();
    const token = (await createToken(session)).body.token;

    const r = await call("/api/jobs", { method: "GET", headers: bearer(token) });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });

  it("submits a job without CSRF", async () => {
    const session = await adminSession();
    const token = (await createToken(session)).body.token;

    const r = await submitJob(bearer(token));
    expect(r.status).toBe(200);
    expect(r.body.job_id).toBeTruthy();
  });

  it("makes /api/auth/me report token auth", async () => {
    const session = await adminSession();
    const token = (await createToken(session)).body.token;

    const r = await call("/api/auth/me", { method: "GET", headers: bearer(token) });
    expect(r.status).toBe(200);
    expect(r.body.authenticated).toBe(true);
    expect(r.body.username).toBe("admin");
    expect(r.body.role).toBe("admin");
    expect(r.body.auth).toBe("token");
    expect(r.body.csrf).toBeNull();
    expect(r.body.token_expires_at).toBeTruthy();
  });

  it("makes an invalid bearer on /me a 401, not an anonymous 200", async () => {
    // 控制者裁示：`/me` 帶了 `Authorization` 但無效 -> 401。§6.3 的
    // `platform_status` 靠這條路徑分辨「token 死了」與「平台好好的」。
    const r = await call("/api/auth/me", { method: "GET", headers: { Authorization: "Bearer cft_bogus" } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");

    const anon = await call("/api/auth/me", { method: "GET" });
    expect(anon.status).toBe(200);
    expect(anon.body.authenticated).toBe(false);
  });

  it("401s a revoked token on /me", async () => {
    const session = await adminSession();
    const created = (await createToken(session)).body;
    await call(`/api/auth/tokens/${created.id}`, {
      method: "DELETE",
      cookie: session.cookie,
      headers: { "X-CSRF": session.csrf },
    });

    const r = await call("/api/auth/me", { method: "GET", headers: bearer(created.token) });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("makes a cookie /me report session auth", async () => {
    const session = await adminSession();
    const body = (await call("/api/auth/me", { method: "GET", cookie: session.cookie })).body;
    expect(body.auth).toBe("session");
    expect(body.csrf).toBeTruthy();
    expect(body.token_expires_at).toBeNull();
  });

  const MANAGEMENT_ROUTES: Array<[string, string, unknown]> = [
    ["/api/auth/tokens", "POST", { name: "x" }],
    ["/api/auth/tokens", "GET", undefined],
    ["/api/auth/tokens/anything", "DELETE", undefined],
    ["/api/auth/change-password", "POST", { old: "a", new: "bbbbbbbbbb" }],
    ["/api/auth/logout", "POST", undefined],
  ];

  it.each(MANAGEMENT_ROUTES)("401s a bearer caller on %s %s", async (path, method, json) => {
    const session = await adminSession();
    const token = (await createToken(session)).body.token;

    const r = await call(path, { method, json, headers: bearer(token) });
    expect(r.status).toBe(401);
    // 這個碼是控制者的裁示（spec 寫的 `auth.unauthorized` 作廢）—— 兩棧同碼。
    expect(r.body.error.code).toBe("auth.required");
  });

  it("rejects a revoked token", async () => {
    const session = await adminSession();
    const created = (await createToken(session)).body;
    await call(`/api/auth/tokens/${created.id}`, {
      method: "DELETE",
      cookie: session.cookie,
      headers: { "X-CSRF": session.csrf },
    });

    expect((await call("/api/jobs", { method: "GET", headers: bearer(created.token) })).status).toBe(401);
  });

  it("rejects an expired token", async () => {
    const session = await adminSession();
    const created = (await createToken(session)).body;
    await db()
      .prepare("UPDATE api_tokens SET expires_at = ? WHERE id = ?")
      .bind(toSqliteTimestamp(new Date(Date.now() - 1000)), created.id)
      .run();

    expect((await call("/api/jobs", { method: "GET", headers: bearer(created.token) })).status).toBe(401);
  });

  it("is invalidated by a password change", async () => {
    const session = await adminSession();
    const token = (await createToken(session)).body.token;

    const changed = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "newpassword123" },
      cookie: session.cookie,
      headers: { "X-CSRF": session.csrf },
    });
    expect(changed.status).toBe(200);

    expect((await call("/api/jobs", { method: "GET", headers: bearer(token) })).status).toBe(401);
  });

  it("is rejected once its user is disabled", async () => {
    const session = await adminSession();
    const token = (await createToken(session)).body.token;
    await db().prepare("UPDATE users SET disabled = 1 WHERE username = 'admin'").run();

    expect((await call("/api/jobs", { method: "GET", headers: bearer(token) })).status).toBe(401);
  });

  const BAD_HEADERS = ["Bearer x", "Basic abcdef", "", "cft_whatever", "Bearer ", "Bearer cft_" + "a".repeat(43)];

  it.each(BAD_HEADERS)("never falls back to the cookie for Authorization: %j", async (header) => {
    const session = await adminSession();
    // cookie 本身是有效的
    expect((await call("/api/jobs", { method: "GET", cookie: session.cookie })).status).toBe(200);

    const r = await call("/api/jobs", {
      method: "GET",
      cookie: session.cookie,
      headers: { Authorization: header },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });
});

// --- last_used_at 節流 --------------------------------------------------

describe("last_used_at", () => {
  it("is stamped then throttled for five minutes", async () => {
    const session = await adminSession();
    const created = (await createToken(session)).body;

    expect((await tokenRow(created.id)).last_used_at).toBeNull();

    expect((await call("/api/jobs", { method: "GET", headers: bearer(created.token) })).status).toBe(200);
    const first = (await tokenRow(created.id)).last_used_at;
    expect(first).not.toBeNull();

    expect((await call("/api/jobs", { method: "GET", headers: bearer(created.token) })).status).toBe(200);
    expect((await tokenRow(created.id)).last_used_at).toBe(first);

    // 把上次使用時間往回推超過節流視窗 -> 下一次命中才會再寫回
    const stale = toSqliteTimestamp(new Date(Date.now() - (apiTokens.API_TOKEN_TOUCH_SECONDS + 60) * 1000));
    await db().prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ?").bind(stale, created.id).run();

    expect((await call("/api/jobs", { method: "GET", headers: bearer(created.token) })).status).toBe(200);
    expect((await tokenRow(created.id)).last_used_at > stale).toBe(true);
  });

  it("surfaces in the listing", async () => {
    const session = await adminSession();
    const token = (await createToken(session)).body.token;
    expect((await call("/api/jobs", { method: "GET", headers: bearer(token) })).status).toBe(200);

    const row = (await call("/api/auth/tokens", { method: "GET", cookie: session.cookie })).body[0];
    expect(row.last_used_at).not.toBeNull();
  });
});

// --- 模組層 --------------------------------------------------------------

describe("resolveBearer", () => {
  it("returns the user or null", async () => {
    // `routes/auth.ts` 用的是回傳列的 `resolveBearerToken`；`resolveBearer`
    // 是 brief 宣告的介面，直接測它，免得這個包裝爛掉沒人發現。
    const session = await adminSession();
    const plaintext = (await createToken(session)).body.token;
    const now = new Date();

    const user = await apiTokens.resolveBearer(db(), `Bearer ${plaintext}`, now);
    expect(user?.username).toBe("admin");

    expect(await apiTokens.resolveBearer(db(), undefined, now)).toBeNull();
    expect(await apiTokens.resolveBearer(db(), "Basic x", now)).toBeNull();
    expect(await apiTokens.resolveBearer(db(), "Bearer cft_nope", now)).toBeNull();
  });
});

describe("POST /api/auth/logout", () => {
  it("401s with a stale session", async () => {
    // logout 現在要 cookie＋CSRF（spec §4.3 的例外清單）—— 釘住它是 401，
    // 而不是 500 或默默成功。
    const session = await adminSession();
    await db().prepare("UPDATE users SET session_epoch = session_epoch + 1 WHERE username = 'admin'").run();

    const r = await call("/api/auth/logout", {
      method: "POST",
      cookie: session.cookie,
      headers: { "X-CSRF": session.csrf },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });
});
