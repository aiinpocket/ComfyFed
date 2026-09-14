import { afterEach, describe, expect, it } from "vitest";
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
