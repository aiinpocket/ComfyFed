/**
 * `/api/staging` -- the console's per-user management of uploaded reference
 * files (list + delete), the cloud twin of tests/server/test_staging.py.
 * Same harness idioms as comfyapi.spec.ts (`call` / `loginSession` /
 * `userSession`, R2 cleanup in `afterEach`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM login_attempts").run();
  for (const prefix of ["staging/"]) {
    const listed = await store().list({ prefix });
    await Promise.all(listed.objects.map((o) => store().delete(o.key)));
  }
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function loginSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function userSession(
  admin: { cookie: string | null; csrf: string },
  username: string
): Promise<{ cookie: string | null; csrf: string }> {
  const password = "a-long-enough-password1";
  await call("/api/users", {
    json: { username, role: "user", password },
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
  const login = await call("/api/auth/login", { json: { username, password } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function uploadImage(cookie: string | null, filename: string, content: string): Promise<Response> {
  const form = new FormData();
  form.set("image", new File([new TextEncoder().encode(content)], filename, { type: "image/png" }));
  const worker = (await import("../src/index")).default;
  const { createExecutionContext, waitOnExecutionContext } = await import("cloudflare:test");
  const ctx = createExecutionContext();
  const res = await worker.fetch(
    new Request("http://example.com/comfy/api/upload/image", { method: "POST", headers: { Cookie: cookie ?? "" }, body: form }),
    env as any,
    ctx
  );
  await waitOnExecutionContext(ctx);
  return res;
}

// --- console staging management ---------------------------------------------


describe("/api/staging", () => {
  it("lists and deletes the caller's own uploads", async () => {
    const admin = await loginSession();
    expect((await uploadImage(admin.cookie, "ref.png", "12345")).status).toBe(200);
    expect((await uploadImage(admin.cookie, "mask.png", "678")).status).toBe(200);

    const listed = await call("/api/staging", { method: "GET", cookie: admin.cookie });
    expect(listed.status).toBe(200);
    expect(listed.body.files.map((f: any) => f.name)).toEqual(["mask.png", "ref.png"]);
    expect(listed.body.files.map((f: any) => f.size)).toEqual([3, 5]);
    expect(listed.body.total_bytes).toBe(8);
    expect(typeof listed.body.files[0].modified).toBe("number");

    const deleted = await call("/api/staging/ref.png", { method: "DELETE", cookie: admin.cookie, headers: { "X-CSRF": admin.csrf } });
    expect(deleted.status).toBe(200);

    const after = await call("/api/staging", { method: "GET", cookie: admin.cookie });
    expect(after.body.files.map((f: any) => f.name)).toEqual(["mask.png"]);
    expect(after.body.total_bytes).toBe(3);
    expect(await store().head("staging/" + (await adminUid()) + "/ref.png")).toBeNull();

    const gone = await call("/api/staging/ref.png", { method: "DELETE", cookie: admin.cookie, headers: { "X-CSRF": admin.csrf } });
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe("staging.not_found");
  });

  it("requires CSRF on delete and a session on both", async () => {
    const admin = await loginSession();
    await uploadImage(admin.cookie, "ref.png", "AAA");

    const noCsrf = await call("/api/staging/ref.png", { method: "DELETE", cookie: admin.cookie });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("auth.csrf");
    expect((await call("/api/staging", { method: "GET", cookie: admin.cookie })).body.files).toHaveLength(1);

    expect((await call("/api/staging", { method: "GET" })).status).toBe(401);
    expect((await call("/api/staging/ref.png", { method: "DELETE" })).status).toBe(401);
  });

  it("never exposes or deletes another user's uploads, admin included", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");
    await uploadImage(alice.cookie, "alice.png", "AAA");

    const bobList = await call("/api/staging", { method: "GET", cookie: bob.cookie });
    expect(bobList.body).toEqual({ files: [], total_bytes: 0 });
    expect(
      (await call("/api/staging/alice.png", { method: "DELETE", cookie: bob.cookie, headers: { "X-CSRF": bob.csrf } })).status
    ).toBe(404);

    const adminList = await call("/api/staging", { method: "GET", cookie: admin.cookie });
    expect(adminList.body.files).toEqual([]);
    expect(
      (await call("/api/staging/alice.png", { method: "DELETE", cookie: admin.cookie, headers: { "X-CSRF": admin.csrf } })).status
    ).toBe(404);

    const aliceList = await call("/api/staging", { method: "GET", cookie: alice.cookie });
    expect(aliceList.body.files.map((f: any) => f.name)).toEqual(["alice.png"]);
  });

  it("rejects a separator-bearing filename", async () => {
    const admin = await loginSession();
    const bad = await call("/api/staging/..%5C..%5Csecret", {
      method: "DELETE",
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("staging.bad_name");
  });
});

async function adminUid(): Promise<string> {
  const row = await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>();
  return row!.id;
}
