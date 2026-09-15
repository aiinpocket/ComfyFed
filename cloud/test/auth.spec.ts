import { afterEach, describe, expect, it } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp } from "../src/db/queries";
import { getOrCreateSessionSecret } from "../src/db/queries";
import { signSessionCookie } from "../src/lib/cookies";
import authApp from "../src/routes/auth";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

// vitest-pool-workers isolates D1 storage per test FILE, not per `it()` (see
// dispatch.spec.ts's comment / task-1-report.md) -- every test in this file
// shares one D1 instance, so state (settings, users, login_attempts) must be
// reset after each test to keep tests independent.
afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM users").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function setup(password = ADMIN_PASSWORD) {
  return call("/api/setup", { json: { token: SETUP_TOKEN, password } });
}

async function login(username = "admin", password = ADMIN_PASSWORD) {
  return call("/api/auth/login", { json: { username, password } });
}

describe("GET /api/setup/status", () => {
  it("reports needed:true before setup", async () => {
    const r = await call("/api/setup/status", { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ needed: true });
  });

  it("reports needed:false after setup", async () => {
    await setup();
    const r = await call("/api/setup/status", { method: "GET" });
    expect(r.body).toEqual({ needed: false });
  });
});

describe("POST /api/setup", () => {
  it("rejects a wrong token", async () => {
    const r = await call("/api/setup", { json: { token: "nope", password: ADMIN_PASSWORD } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("setup.bad_token");
  });

  it("rejects a missing token", async () => {
    const r = await call("/api/setup", { json: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("setup.bad_token");
  });

  it("rejects a too-short password", async () => {
    const r = await call("/api/setup", { json: { token: SETUP_TOKEN, password: "short" } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("setup.password_too_short");
  });

  it("succeeds with the right token and a valid password", async () => {
    const r = await setup();
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it("creates the 'admin' user row (Phase 3.0: no more admin_password_hash setting)", async () => {
    await setup();
    const row = await db().prepare("SELECT username, role, disabled, session_epoch FROM users").first<any>();
    expect(row).toEqual({ username: "admin", role: "admin", disabled: 0, session_epoch: 0 });
    const settingRow = await db().prepare("SELECT 1 FROM settings WHERE key = 'admin_password_hash'").first();
    expect(settingRow).toBeNull();
  });

  it("400s on a second setup attempt (already done)", async () => {
    await setup();
    const r = await setup();
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("setup.already_done");
  });

  it("refuses setup outright when SETUP_TOKEN is not configured on the environment", async () => {
    // Review N1: wrangler.jsonc ships no SETUP_TOKEN default -- a freshly
    // deployed Worker with no operator-chosen token must refuse /api/setup
    // unconditionally, not fall back to some shipped value. Exercises the
    // auth sub-app directly against an env clone with SETUP_TOKEN stripped,
    // since the shared test-pool env always carries the real test token.
    const envWithoutToken = { ...(env as any), SETUP_TOKEN: undefined };
    const request = new Request("http://example.com/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: SETUP_TOKEN, password: ADMIN_PASSWORD }),
    });
    const ctx = createExecutionContext();
    const response = await authApp.fetch(request, envWithoutToken, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(400);
    const body = await response.json<{ error: { code: string } }>();
    expect(body.error.code).toBe("setup.bad_token");

    const status = await call("/api/setup/status", { method: "GET" });
    expect(status.body).toEqual({ needed: true });
  });
});

describe("POST /api/auth/login", () => {
  it("succeeds with the right username/password and sets a cookie + csrf", async () => {
    await setup();
    const r = await login();
    expect(r.status).toBe(200);
    expect(r.body.csrf).toBeTruthy();
    expect(r.setCookie).toMatch(/^cf_session=/);
  });

  it("401s with the wrong password", async () => {
    await setup();
    const r = await login("admin", "wrong");
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("401s for an unknown username with the same error as a wrong password (no account enumeration)", async () => {
    await setup();
    const unknown = await login("nobody", ADMIN_PASSWORD);
    const wrongPassword = await login("admin", "wrong");
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe("auth.required");
    expect(unknown.body.error.code).toBe(wrongPassword.body.error.code);
  });

  it("422s with the server's validation_error shape when username is missing (final review finding #9)", async () => {
    await setup();
    const r = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation_error");
  });

  it("422s with the server's validation_error shape when password is missing (symmetric with username)", async () => {
    await setup();
    const r = await call("/api/auth/login", { json: { username: "admin" } });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation_error");
  });

  it("422s when the body has neither field at all", async () => {
    await setup();
    const r = await call("/api/auth/login", { json: {} });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("validation_error");
  });

  it("normalizes username casing/whitespace (login is case-insensitive, matching creation)", async () => {
    await setup();
    const r = await call("/api/auth/login", { json: { username: "  ADMIN  ", password: ADMIN_PASSWORD } });
    expect(r.status).toBe(200);
  });

  it("401s before setup has ever run", async () => {
    const r = await login("admin", "anything");
    expect(r.status).toBe(401);
  });

  it("rejects a disabled user with the same error as a wrong password", async () => {
    await setup();
    await db().prepare("UPDATE users SET disabled = 1 WHERE username = 'admin'").run();
    const r = await login();
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });
});

describe("GET /api/auth/me", () => {
  it("reports unauthenticated with no session", async () => {
    const r = await call("/api/auth/me", { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ authenticated: false, lang: "en", platform_url: "" });
  });

  it("reports authenticated with username + role for a valid session cookie", async () => {
    await setup();
    const loginRes = await login();
    const r = await call("/api/auth/me", { method: "GET", cookie: loginRes.setCookie });
    expect(r.body).toEqual({
      authenticated: true,
      username: "admin",
      role: "admin",
      lang: "en",
      platform_url: "",
      csrf: loginRes.body.csrf,
    });
  });

  it("includes the csrf token matching the login response, and omits it when anonymous", async () => {
    await setup();
    const loginRes = await login();
    const r = await call("/api/auth/me", { method: "GET", cookie: loginRes.setCookie });
    expect(r.body.csrf).toBe(loginRes.body.csrf);

    const anon = await call("/api/auth/me", { method: "GET" });
    expect(anon.body).not.toHaveProperty("csrf");
  });

  it("does not write a session_secret settings row for an anonymous request (no cookie)", async () => {
    // Regression for review m1: readSession() used to look up (and lazily
    // create) the session secret before checking whether a cookie was even
    // present, so every anonymous request -- including this one -- wrote a
    // settings row. auth.py's read_session_payload checks `if not
    // session_cookie: return None` first; readSession() must do the same.
    const before = await db().prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>();
    await call("/api/auth/me", { method: "GET" });
    const after = await db().prepare("SELECT COUNT(*) AS n FROM settings").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    const secretRow = await db().prepare("SELECT value FROM settings WHERE key = 'session_secret'").first();
    expect(secretRow).toBeNull();
  });

  it("treats a pre-Phase-3.0 cookie (no uid) as unauthenticated rather than mapping it onto any account", async () => {
    // auth.py's `_session_user_from_payload` docstring: a payload with no
    // `uid` -- the old `{authenticated, csrf}` shape -- is deliberately
    // rejected, not compatibility-mapped onto whatever account happens to
    // exist. Everyone re-authenticates once after this upgrade.
    await setup();
    const secret = await getOrCreateSessionSecret(db());
    const oldShapeToken = await signSessionCookie(secret, { authenticated: true, csrf: "whatever" } as any);
    const r = await call("/api/auth/me", { method: "GET", cookie: `cf_session=${oldShapeToken}` });
    expect(r.body.authenticated).toBe(false);
  });
});

describe("POST /api/auth/logout", () => {
  it("clears the session cookie", async () => {
    const r = await call("/api/auth/logout", { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });
});

describe("CSRF", () => {
  it("rejects a state-changing request with no X-CSRF header", async () => {
    await setup();
    const loginRes = await login();
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "another-long-password" },
      cookie: loginRes.setCookie,
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("auth.csrf");
  });

  it("rejects a state-changing request with a wrong X-CSRF header", async () => {
    await setup();
    const loginRes = await login();
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "another-long-password" },
      cookie: loginRes.setCookie,
      headers: { "X-CSRF": "wrong-token" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("auth.csrf");
  });

  it("accepts a state-changing request with the matching X-CSRF header", async () => {
    await setup();
    const loginRes = await login();
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "another-long-password" },
      cookie: loginRes.setCookie,
      headers: { "X-CSRF": loginRes.body.csrf },
    });
    expect(r.status).toBe(200);
  });
});

describe("POST /api/auth/change-password", () => {
  it("rejects a too-short new password", async () => {
    await setup();
    const loginRes = await login();
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "short" },
      cookie: loginRes.setCookie,
      headers: { "X-CSRF": loginRes.body.csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("auth.password_too_short");
  });

  it("401s when the old password is wrong", async () => {
    await setup();
    const loginRes = await login();
    const r = await call("/api/auth/change-password", {
      json: { old: "wrong-old-password", new: "another-long-password" },
      cookie: loginRes.setCookie,
      headers: { "X-CSRF": loginRes.body.csrf },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("bumps session_epoch (not the global secret): the old cookie stops working, the reissued cookie keeps the caller logged in, and the new password logs in", async () => {
    await setup();
    const loginRes = await login();
    const changed = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "brand-new-password" },
      cookie: loginRes.setCookie,
      headers: { "X-CSRF": loginRes.body.csrf },
    });
    expect(changed.status).toBe(200);
    expect(changed.body.csrf).toBeTruthy();
    expect(changed.setCookie).toMatch(/^cf_session=/);

    // The cookie issued by the ORIGINAL login is now stale (epoch bumped).
    const meWithOldCookie = await call("/api/auth/me", { method: "GET", cookie: loginRes.setCookie });
    expect(meWithOldCookie.body.authenticated).toBe(false);

    // The REISSUED cookie from the change-password response itself keeps
    // this same caller logged in -- Phase 3.0's "the person who changed
    // their own password never gets logged out" guarantee.
    const meWithReissuedCookie = await call("/api/auth/me", { method: "GET", cookie: changed.setCookie });
    expect(meWithReissuedCookie.body.authenticated).toBe(true);

    // Old password no longer works; new password does.
    const oldLogin = await login("admin", ADMIN_PASSWORD);
    expect(oldLogin.status).toBe(401);
    const newLogin = await login("admin", "brand-new-password");
    expect(newLogin.status).toBe(200);
  });
});

describe("session epoch invalidation", () => {
  it("a change-password from one session invalidates every OTHER outstanding session for the same user", async () => {
    await setup();
    const sessionA = await login();
    const sessionB = await login(); // a second, independent login for the same account

    const changed = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "another-brand-new-password" },
      cookie: sessionA.setCookie,
      headers: { "X-CSRF": sessionA.body.csrf },
    });
    expect(changed.status).toBe(200);

    const meB = await call("/api/auth/me", { method: "GET", cookie: sessionB.setCookie });
    expect(meB.body.authenticated).toBe(false);
  });

  it("the global session-signing secret is NOT rotated by change-password (only the per-user epoch is)", async () => {
    await setup();
    const secretBefore = await db().prepare("SELECT value FROM settings WHERE key = 'session_secret'").first<{ value: string }>();
    const loginRes = await login();
    await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "yet-another-password" },
      cookie: loginRes.setCookie,
      headers: { "X-CSRF": loginRes.body.csrf },
    });
    const secretAfter = await db().prepare("SELECT value FROM settings WHERE key = 'session_secret'").first<{ value: string }>();
    expect(secretAfter?.value).toBe(secretBefore?.value);
  });
});

describe("login backoff", () => {
  it("429s once 4 consecutive failures land inside the 10-minute window and the wait hasn't elapsed", async () => {
    await setup();
    for (let i = 0; i < 4; i++) {
      const r = await login("admin", "wrong");
      expect(r.status).toBe(401);
    }
    const fifth = await login("admin", "wrong");
    expect(fifth.status).toBe(429);
    expect(fifth.body.error.code).toBe("auth.too_many_attempts");
  });

  it("allows the attempt through once the required wait has elapsed, by clock", async () => {
    await setup();
    // Seed 4 consecutive failures whose most recent `at` is already old
    // enough that required_wait_seconds(4) == 2 has elapsed by the time this
    // request runs -- avoids a real sleep() in the test.
    const now = new Date();
    const old = new Date(now.getTime() - 5000); // 5s ago > the 2s wait for n=4
    for (let i = 0; i < 4; i++) {
      await db()
        .prepare("INSERT INTO login_attempts (at, ok, username) VALUES (?, 0, 'admin')")
        .bind(toSqliteTimestamp(new Date(old.getTime() - i * 10)))
        .run();
    }
    // This 5th attempt is allowed through (evaluated normally -- wrong
    // password still 401s, but NOT 429) because elapsed (~5s) >= required
    // wait (2s) for n=4.
    const r = await login("admin", "wrong");
    expect(r.status).toBe(401);
  });

  it("stays gated when the required wait has not yet elapsed for a higher failure count", async () => {
    await setup();
    const now = new Date();
    // 5 consecutive failures, most recent just now -> n=5, required wait
    // 2^(5-3)=4s, elapsed ~0s < 4s -> still 429.
    for (let i = 0; i < 5; i++) {
      await db()
        .prepare("INSERT INTO login_attempts (at, ok, username) VALUES (?, 0, 'admin')")
        .bind(toSqliteTimestamp(new Date(now.getTime() - i * 10)))
        .run();
    }
    const r = await login("admin", "wrong");
    expect(r.status).toBe(429);
  });

  it("resets the streak after a success", async () => {
    await setup();
    // Seed 4 consecutive (backdated, so their gate has already elapsed)
    // failures, then a real successful login through the route.
    const old = new Date(Date.now() - 5000);
    for (let i = 0; i < 4; i++) {
      await db()
        .prepare("INSERT INTO login_attempts (at, ok, username) VALUES (?, 0, 'admin')")
        .bind(toSqliteTimestamp(new Date(old.getTime() - i * 10)))
        .run();
    }
    const ok = await login();
    expect(ok.status).toBe(200);

    // Immediately failing again should NOT be gated: the success record
    // just written breaks the consecutive-failure streak back to 0.
    const r = await login("admin", "wrong");
    expect(r.status).toBe(401);
  });

  it("is per-username: failures against one account never lock out a different one", async () => {
    // Phase 3.0: auth.py's `_consecutive_failures` filters by username, so
    // an attacker hammering one account can't lock a different user out.
    await setup();
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      await db()
        .prepare("INSERT INTO login_attempts (at, ok, username) VALUES (?, 0, 'someone-else')")
        .bind(toSqliteTimestamp(new Date(now.getTime() - i * 10)))
        .run();
    }
    // 'someone-else' is gated...
    const gated = await login("someone-else", "wrong");
    expect(gated.status).toBe(429);
    // ...but 'admin' (an entirely different username, no failures recorded
    // against it) logs in normally, ungated.
    const ok = await login("admin", ADMIN_PASSWORD);
    expect(ok.status).toBe(200);
  });
});
