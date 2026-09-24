import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";

// vitest-pool-workers isolates D1 storage per test FILE (see task-1-report.md
// / dispatch.spec.ts) -- every test in this file shares one D1 instance.
afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM login_attempts").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

interface Session {
  cookie: string | null;
  csrf: string;
}

async function adminSession(): Promise<Session> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function createUser(
  session: Session,
  body: { username: string; role: string; password?: string }
): Promise<{ status: number; body: any }> {
  return call("/api/users", { json: body, cookie: session.cookie, headers: { "X-CSRF": session.csrf } });
}

describe("GET /api/users", () => {
  it("401s without a session", async () => {
    const r = await call("/api/users", { method: "GET" });
    expect(r.status).toBe(401);
  });

  it("403s for a non-admin session", async () => {
    const admin = await adminSession();
    await createUser(admin, { username: "bob", role: "user", password: "a-long-password1" });
    const bobLogin = await call("/api/auth/login", { json: { username: "bob", password: "a-long-password1" } });
    const r = await call("/api/users", { method: "GET", cookie: bobLogin.setCookie });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("auth.forbidden");
  });

  it("lists every user, oldest-created first, each with its job count", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "bob", role: "user", password: "a-long-password1" });
    expect(created.status).toBe(200);

    const r = await call("/api/users", { method: "GET", cookie: admin.cookie });
    expect(r.status).toBe(200);
    expect(r.body.users).toHaveLength(2);
    expect(r.body.users[0]).toMatchObject({ username: "admin", role: "admin", disabled: false, jobs: 0 });
    expect(r.body.users[1]).toMatchObject({ username: "bob", role: "user", disabled: false, jobs: 0 });
    expect(r.body.users[1].id).toBe(created.body.id);
    expect(typeof r.body.users[0].created_at).toBe("string");
  });

  it("reports a user's job count from jobs.user_id", async () => {
    const admin = await adminSession();
    const adminId = (await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>())!.id;
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, user_id, created_at) VALUES ('job-1', '{}', ?, '2026-01-01 00:00:00.000000')`
      )
      .bind(adminId)
      .run();

    const r = await call("/api/users", { method: "GET", cookie: admin.cookie });
    expect(r.body.users[0]).toMatchObject({ username: "admin", jobs: 1 });
  });

  it("reports each user's used_bytes: staging + userdata + job counters (2026-09-24)", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "bob", role: "user", password: "a-long-password1" });
    const adminId = (await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>())!.id;
    const store = (env as any).STORE as R2Bucket;
    await store.put(`staging/${adminId}/ref.png`, new Uint8Array(100));
    await store.put(`userdata/${adminId}/workflows/a.json`, new Uint8Array(20));
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, user_id, created_at, artifact_bytes, input_bytes)
         VALUES ('job-1', '{}', ?, '2026-01-01 00:00:00.000000', 300, 4),
                ('job-2', '{}', ?, '2026-01-02 00:00:00.000000', NULL, NULL)`
      )
      .bind(adminId, created.body.id)
      .run();
    try {
      const r = await call("/api/users", { method: "GET", cookie: admin.cookie });
      expect(r.status).toBe(200);
      expect(r.body.users[0]).toMatchObject({ username: "admin", jobs: 1, used_bytes: 424 });
      // NULL counters (not yet backfilled) count as 0, never as unknown.
      expect(r.body.users[1]).toMatchObject({ username: "bob", jobs: 1, used_bytes: 0 });
    } finally {
      await store.delete(`staging/${adminId}/ref.png`);
      await store.delete(`userdata/${adminId}/workflows/a.json`);
    }
  });
});

describe("POST /api/users", () => {
  it("401s without a session", async () => {
    const r = await call("/api/users", { json: { username: "bob", role: "user" } });
    expect(r.status).toBe(401);
  });

  it("403s without the X-CSRF header", async () => {
    const admin = await adminSession();
    const r = await call("/api/users", { json: { username: "bob", role: "user" }, cookie: admin.cookie });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("auth.csrf");
  });

  it("rejects an invalid username", async () => {
    const admin = await adminSession();
    const r = await createUser(admin, { username: "ab", role: "user" }); // too short
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_username");
  });

  it("rejects an invalid role", async () => {
    const admin = await adminSession();
    const r = await createUser(admin, { username: "bob", role: "superuser" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_role");
  });

  it("rejects a username already in use (normalized, case-insensitive)", async () => {
    const admin = await adminSession();
    const r = await createUser(admin, { username: "ADMIN", role: "user" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("username_taken");
  });

  it("creates a user with an explicit password and echoes it back", async () => {
    const admin = await adminSession();
    const r = await createUser(admin, { username: "bob", role: "user", password: "a-long-password1" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: "bob", role: "user", password: "a-long-password1" });
    expect(r.body.id).toBeTruthy();

    // The new account can actually log in with it.
    const login = await call("/api/auth/login", { json: { username: "bob", password: "a-long-password1" } });
    expect(login.status).toBe(200);
  });

  it("rejects a too-short explicit password (final review finding #8)", async () => {
    const admin = await adminSession();
    const r = await createUser(admin, { username: "shortpw", role: "user", password: "a" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("auth.password_too_short");

    const login = await call("/api/auth/login", { json: { username: "shortpw", password: "a" } });
    expect(login.status).toBe(401);
  });

  it("generates a random one-time password when none is given, returned only in this response", async () => {
    const admin = await adminSession();
    const r = await createUser(admin, { username: "carol", role: "admin" });
    expect(r.status).toBe(200);
    expect(typeof r.body.password).toBe("string");
    expect(r.body.password.length).toBeGreaterThan(8);

    // Not persisted in plaintext anywhere retrievable via the list endpoint.
    const list = await call("/api/users", { method: "GET", cookie: admin.cookie });
    for (const u of list.body.users) {
      expect(u.password).toBeUndefined();
    }
  });

  it("normalizes the username (trim + lowercase) before storing", async () => {
    const admin = await adminSession();
    const r = await createUser(admin, { username: "  Dave  ", role: "user", password: "a-long-password1" });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe("dave");
  });
});

describe("POST /api/users/{id}/reset-password", () => {
  it("404s for an unknown user id", async () => {
    const admin = await adminSession();
    const r = await call("/api/users/nonexistent/reset-password", {
      method: "POST",
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("not_found");
  });

  it("generates a fresh one-time password and bumps the target's session_epoch (invalidating their sessions)", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "bob", role: "user", password: "a-long-password1" });
    const bobLogin = await call("/api/auth/login", { json: { username: "bob", password: "a-long-password1" } });
    expect(bobLogin.status).toBe(200);

    const r = await call(`/api/users/${created.body.id}/reset-password`, {
      method: "POST",
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(200);
    expect(typeof r.body.password).toBe("string");

    // Old password no longer works; new one does.
    const oldLogin = await call("/api/auth/login", { json: { username: "bob", password: "a-long-password1" } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await call("/api/auth/login", { json: { username: "bob", password: r.body.password } });
    expect(newLogin.status).toBe(200);

    // Bob's pre-reset session cookie is now stale.
    const meWithOldCookie = await call("/api/auth/me", { method: "GET", cookie: bobLogin.setCookie });
    expect(meWithOldCookie.body.authenticated).toBe(false);
  });
});

describe("PATCH /api/users/{id}", () => {
  it("404s for an unknown user id", async () => {
    const admin = await adminSession();
    const r = await call("/api/users/nonexistent", {
      method: "PATCH",
      json: { disabled: true },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(404);
  });

  it("rejects an invalid role", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "bob", role: "user", password: "a-long-password1" });
    const r = await call(`/api/users/${created.body.id}`, {
      method: "PATCH",
      json: { role: "superuser" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid_role");
  });

  it("disables a user, bumping their session_epoch, and returns the updated row", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "bob", role: "user", password: "a-long-password1" });
    const bobLogin = await call("/api/auth/login", { json: { username: "bob", password: "a-long-password1" } });

    const r = await call(`/api/users/${created.body.id}`, {
      method: "PATCH",
      json: { disabled: true },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ username: "bob", disabled: true });

    // Disabling a user can't log in anymore, and their existing session dies.
    const relogin = await call("/api/auth/login", { json: { username: "bob", password: "a-long-password1" } });
    expect(relogin.status).toBe(401);
    const me = await call("/api/auth/me", { method: "GET", cookie: bobLogin.setCookie });
    expect(me.body.authenticated).toBe(false);
  });

  it("changes a user's role", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "bob", role: "user", password: "a-long-password1" });
    const r = await call(`/api/users/${created.body.id}`, {
      method: "PATCH",
      json: { role: "admin" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(200);
    expect(r.body.role).toBe("admin");
  });

  it("400s disabling the only active admin (last_admin)", async () => {
    const admin = await adminSession();
    const adminId = (await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>())!.id;
    const r = await call(`/api/users/${adminId}`, {
      method: "PATCH",
      json: { disabled: true },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("last_admin");
  });

  it("400s demoting the only active admin (last_admin)", async () => {
    const admin = await adminSession();
    const adminId = (await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>())!.id;
    const r = await call(`/api/users/${adminId}`, {
      method: "PATCH",
      json: { role: "user" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("last_admin");
  });

  it("allows disabling an admin when another active admin still exists", async () => {
    const admin = await adminSession();
    const secondAdmin = await createUser(admin, { username: "carol", role: "admin", password: "a-long-password1" });
    const adminId = (await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>())!.id;

    const r = await call(`/api/users/${adminId}`, {
      method: "PATCH",
      json: { disabled: true },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(200);
    expect(r.body.disabled).toBe(true);
    expect(secondAdmin.status).toBe(200);
  });
});

// --- 2026-09-20 每人額度覆寫＋NSFW 權限 (coverage originally ported from the Python suite)

describe("per-user overrides on PATCH /api/users/:id", () => {
  async function patch(session: Session, id: string, body: unknown) {
    return call(`/api/users/${id}`, {
      method: "PATCH",
      json: body,
      cookie: session.cookie,
      headers: { "X-CSRF": session.csrf },
    });
  }

  it("sets and reports the three override fields; untouched users report null", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "alice", role: "user", password: "a-long-password1" });
    const r = await patch(admin, created.body.id, { max_file_mb: 200, quota_gb: 1.5, nsfw_allowed: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ max_file_mb: 200, quota_gb: 1.5, nsfw_allowed: false });

    const listed = await call("/api/users", { method: "GET", cookie: admin.cookie });
    const alice = listed.body.users.find((u: any) => u.id === created.body.id);
    expect(alice).toMatchObject({ max_file_mb: 200, quota_gb: 1.5, nsfw_allowed: false });
    const adminRow = listed.body.users.find((u: any) => u.username === "admin");
    expect(adminRow).toMatchObject({ max_file_mb: null, quota_gb: null, nsfw_allowed: null });
  });

  it("null clears an override; omitted fields are untouched", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "alice", role: "user", password: "a-long-password1" });
    await patch(admin, created.body.id, { max_file_mb: 200, quota_gb: 1.5, nsfw_allowed: false });
    const untouched = await patch(admin, created.body.id, { disabled: false });
    expect(untouched.body).toMatchObject({ max_file_mb: 200, quota_gb: 1.5, nsfw_allowed: false });
    const cleared = await patch(admin, created.body.id, { max_file_mb: null, quota_gb: null, nsfw_allowed: null });
    expect(cleared.body).toMatchObject({ max_file_mb: null, quota_gb: null, nsfw_allowed: null });
  });

  it.each([
    [{ max_file_mb: 0 }, "users.bad_max_file_mb"],
    [{ max_file_mb: 2000 }, "users.bad_max_file_mb"],
    [{ max_file_mb: 1.5 }, "users.bad_max_file_mb"],
    [{ quota_gb: 0 }, "users.bad_quota_gb"],
    [{ quota_gb: 5000 }, "users.bad_quota_gb"],
    [{ nsfw_allowed: "yes" }, "users.bad_nsfw_allowed"],
  ])("rejects %o with %s", async (body, code) => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "alice", role: "user", password: "a-long-password1" });
    const r = await patch(admin, created.body.id, body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe(code);
  });

  it("the override is what the upload routes and the staging listing use", async () => {
    const admin = await adminSession();
    const created = await createUser(admin, { username: "alice", role: "user", password: "a-long-password1" });
    await patch(admin, created.body.id, { max_file_mb: 1, quota_gb: 0.5 });
    const login = await call("/api/auth/login", { json: { username: "alice", password: "a-long-password1" } });
    const alice = { cookie: login.setCookie, csrf: login.body.csrf };

    const listing = await call("/api/staging", { method: "GET", cookie: alice.cookie });
    expect(listing.status).toBe(200);
    expect(listing.body.quota_bytes).toBe(Math.trunc(0.5 * 1024 * 1024 * 1024));

    // 1 MB + 10 bytes 的 workflow 存檔：alice 的 1 MB 覆寫擋掉，admin 的全案 50 MB 放行
    const big = new Uint8Array(1024 * 1024 + 10);
    const refused = await call("/comfy/api/userdata/workflows/big.json", {
      method: "POST",
      rawBody: big,
      cookie: alice.cookie,
      headers: { "X-CSRF": alice.csrf, "Content-Type": "application/octet-stream" },
    });
    expect(refused.status).toBe(413);
    const ok = await call("/comfy/api/userdata/workflows/big.json", {
      method: "POST",
      rawBody: big,
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf, "Content-Type": "application/octet-stream" },
    });
    expect(ok.status).toBe(200);
  });
});
