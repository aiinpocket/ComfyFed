import { afterEach, describe, expect, it } from "vitest";
import { call, db, SETUP_TOKEN } from "./helpers/http";

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM login_attempts").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function loginSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

describe("GET /api/settings", () => {
  it("401s without a session", async () => {
    const r = await call("/api/settings", { method: "GET" });
    expect(r.status).toBe(401);
  });

  it("reports every default key before any write", async () => {
    const { cookie } = await loginSession();
    const r = await call("/api/settings", { method: "GET", cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ platform_url: "", lang: "en", object_info_mode: "union" });
  });
});

describe("POST /api/settings", () => {
  it("401s without a session", async () => {
    const r = await call("/api/settings", { json: { lang: "en" } });
    expect(r.status).toBe(401);
  });

  it("403s without the X-CSRF header", async () => {
    const { cookie } = await loginSession();
    const r = await call("/api/settings", { json: { lang: "en" }, cookie });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("auth.csrf");
  });

  it("writes platform_url and lang together", async () => {
    const { cookie, csrf } = await loginSession();
    const r = await call("/api/settings", {
      json: { platform_url: "https://fed.example", lang: "zh-TW" },
      cookie,
      headers: { "X-CSRF": csrf },
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      platform_url: "https://fed.example",
      lang: "zh-TW",
      object_info_mode: "union",
    });

    const me = await call("/api/auth/me", { method: "GET", cookie });
    expect(me.body.platform_url).toBe("https://fed.example");
    expect(me.body.lang).toBe("zh-TW");
  });

  it("accepts a partial body, leaving other keys untouched", async () => {
    const { cookie, csrf } = await loginSession();
    await call("/api/settings", {
      json: { platform_url: "https://a.example" },
      cookie,
      headers: { "X-CSRF": csrf },
    });
    const r = await call("/api/settings", { json: { lang: "en" }, cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(200);
    expect(r.body.platform_url).toBe("https://a.example");
  });

  it("rejects a platform_url without http(s)://", async () => {
    const { cookie, csrf } = await loginSession();
    const r = await call("/api/settings", {
      json: { platform_url: "fed.example" },
      cookie,
      headers: { "X-CSRF": csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("settings.bad_platform_url");
  });

  it("rejects an unknown lang", async () => {
    const { cookie, csrf } = await loginSession();
    const r = await call("/api/settings", { json: { lang: "fr" }, cookie, headers: { "X-CSRF": csrf } });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("settings.bad_lang");
  });

  it("writes object_info_mode", async () => {
    const { cookie, csrf } = await loginSession();
    const r = await call("/api/settings", {
      json: { object_info_mode: "intersection" },
      cookie,
      headers: { "X-CSRF": csrf },
    });
    expect(r.status).toBe(200);
    expect(r.body.object_info_mode).toBe("intersection");

    const again = await call("/api/settings", { method: "GET", cookie });
    expect(again.body.object_info_mode).toBe("intersection");
  });

  it("rejects an unknown object_info_mode with the zh-TW parity message", async () => {
    const { cookie, csrf } = await loginSession();
    const r = await call("/api/settings", {
      json: { object_info_mode: "bogus" },
      cookie,
      headers: { "X-CSRF": csrf },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("settings.bad_object_info_mode");
    expect(r.body.error.message).toContain("必須是 union 或 intersection 其中之一");
  });
});
