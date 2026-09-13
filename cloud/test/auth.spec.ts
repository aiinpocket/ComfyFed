import { afterEach, describe, expect, it } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp } from "../src/db/queries";

// vitest-pool-workers isolates D1 storage per test FILE, not per `it()` (see
// dispatch.spec.ts's comment / task-1-report.md) -- every test in this file
// shares one D1 instance, so state (settings, login_attempts) must be reset
// after each test to keep tests independent.
afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM login_attempts").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function setup(password = ADMIN_PASSWORD) {
  return call("/api/setup", { json: { token: SETUP_TOKEN, password } });
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

  it("400s on a second setup attempt (already done)", async () => {
    await setup();
    const r = await setup();
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("setup.already_done");
  });
});

describe("POST /api/auth/login", () => {
  it("succeeds with the right password and sets a cookie + csrf", async () => {
    await setup();
    const r = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    expect(r.status).toBe(200);
    expect(r.body.csrf).toBeTruthy();
    expect(r.setCookie).toMatch(/^cf_session=/);
  });

  it("401s with the wrong password", async () => {
    await setup();
    const r = await call("/api/auth/login", { json: { password: "wrong" } });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("401s before setup has ever run", async () => {
    const r = await call("/api/auth/login", { json: { password: "anything" } });
    expect(r.status).toBe(401);
  });
});

describe("GET /api/auth/me", () => {
  it("reports unauthenticated with no session", async () => {
    const r = await call("/api/auth/me", { method: "GET" });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ authenticated: false, lang: "en", platform_url: "" });
  });

  it("reports authenticated with a valid session cookie", async () => {
    await setup();
    const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    const r = await call("/api/auth/me", { method: "GET", cookie: login.setCookie });
    expect(r.body.authenticated).toBe(true);
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
    const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "another-long-password" },
      cookie: login.setCookie,
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("auth.csrf");
  });

  it("rejects a state-changing request with a wrong X-CSRF header", async () => {
    await setup();
    const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "another-long-password" },
      cookie: login.setCookie,
      headers: { "X-CSRF": "wrong-token" },
    });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("auth.csrf");
  });

  it("accepts a state-changing request with the matching X-CSRF header", async () => {
    await setup();
    const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "another-long-password" },
      cookie: login.setCookie,
      headers: { "X-CSRF": login.body.csrf },
    });
    expect(r.status).toBe(200);
  });
});

describe("POST /api/auth/change-password", () => {
  it("rejects a too-short new password", async () => {
    await setup();
    const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "short" },
      cookie: login.setCookie,
      headers: { "X-CSRF": login.body.csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("auth.password_too_short");
  });

  it("401s when the old password is wrong", async () => {
    await setup();
    const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    const r = await call("/api/auth/change-password", {
      json: { old: "wrong-old-password", new: "another-long-password" },
      cookie: login.setCookie,
      headers: { "X-CSRF": login.body.csrf },
    });
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.required");
  });

  it("rotates the session secret: the old cookie stops working, the new password logs in", async () => {
    await setup();
    const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    const changed = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "brand-new-password" },
      cookie: login.setCookie,
      headers: { "X-CSRF": login.body.csrf },
    });
    expect(changed.status).toBe(200);

    // The session cookie issued before the rotation must now read as
    // unauthenticated -- change-password logs out every outstanding session,
    // including the one that made the request.
    const me = await call("/api/auth/me", { method: "GET", cookie: login.setCookie });
    expect(me.body.authenticated).toBe(false);

    // Old password no longer works; new password does.
    const oldLogin = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    expect(oldLogin.status).toBe(401);
    const newLogin = await call("/api/auth/login", { json: { password: "brand-new-password" } });
    expect(newLogin.status).toBe(200);
  });
});

describe("login backoff", () => {
  it("429s once 4 consecutive failures land inside the 10-minute window and the wait hasn't elapsed", async () => {
    await setup();
    for (let i = 0; i < 4; i++) {
      const r = await call("/api/auth/login", { json: { password: "wrong" } });
      expect(r.status).toBe(401);
    }
    const fifth = await call("/api/auth/login", { json: { password: "wrong" } });
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
        .prepare("INSERT INTO login_attempts (at, ok) VALUES (?, 0)")
        .bind(toSqliteTimestamp(new Date(old.getTime() - i * 10)))
        .run();
    }
    // This 5th attempt is allowed through (evaluated normally -- wrong
    // password still 401s, but NOT 429) because elapsed (~5s) >= required
    // wait (2s) for n=4.
    const r = await call("/api/auth/login", { json: { password: "wrong" } });
    expect(r.status).toBe(401);
  });

  it("stays gated when the required wait has not yet elapsed for a higher failure count", async () => {
    await setup();
    const now = new Date();
    // 5 consecutive failures, most recent just now -> n=5, required wait
    // 2^(5-3)=4s, elapsed ~0s < 4s -> still 429.
    for (let i = 0; i < 5; i++) {
      await db()
        .prepare("INSERT INTO login_attempts (at, ok) VALUES (?, 0)")
        .bind(toSqliteTimestamp(new Date(now.getTime() - i * 10)))
        .run();
    }
    const r = await call("/api/auth/login", { json: { password: "wrong" } });
    expect(r.status).toBe(429);
  });

  it("resets the streak after a success", async () => {
    await setup();
    // Seed 4 consecutive (backdated, so their gate has already elapsed)
    // failures, then a real successful login through the route.
    const old = new Date(Date.now() - 5000);
    for (let i = 0; i < 4; i++) {
      await db()
        .prepare("INSERT INTO login_attempts (at, ok) VALUES (?, 0)")
        .bind(toSqliteTimestamp(new Date(old.getTime() - i * 10)))
        .run();
    }
    const ok = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
    expect(ok.status).toBe(200);

    // Immediately failing again should NOT be gated: the success record
    // just written breaks the consecutive-failure streak back to 0.
    const r = await call("/api/auth/login", { json: { password: "wrong" } });
    expect(r.status).toBe(401);
  });
});
