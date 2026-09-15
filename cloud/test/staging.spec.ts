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
  // `userdata/` too: the quota tests below write into both namespaces.
  for (const prefix of ["staging/", "userdata/"]) {
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
    expect(bobList.body.files).toEqual([]);
    expect(bobList.body.total_bytes).toBe(0);
    expect(bobList.body.userdata_bytes).toBe(0);
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

// --- upload limits + per-user storage quota ---------------------------------
//
// `upload_max_file_mb` (default 50) and `upload_user_quota_gb` (default 5) are
// admin settings; `/comfy/api/upload/image` had NO ceiling at all before,
// which made staging the way around the `/userdata` cap. Parity twin:
// tests/server/test_staging.py's upload-limit block.

async function setLimits(
  admin: { cookie: string | null; csrf: string },
  values: Record<string, number>
): Promise<void> {
  const r = await call("/api/settings", { json: values, cookie: admin.cookie, headers: { "X-CSRF": admin.csrf } });
  expect(r.status).toBe(200);
}

function filler(bytes: number): string {
  return "z".repeat(bytes);
}

describe("upload limits and the per-user quota", () => {
  it("caps a staging upload at the configured file size", async () => {
    const admin = await loginSession();
    await setLimits(admin, { upload_max_file_mb: 1 });

    const big = await uploadImage(admin.cookie, "big.png", filler(1024 * 1024 + 1));
    expect(big.status).toBe(413);
    const body = (await big.json()) as any;
    expect(body.error.code).toBe("upload.too_large");
    // zh first, then English -- both halves in one message.
    expect(body.error.message).toContain("1 MB 單檔上限");
    expect(body.error.message).toContain("1 MB per-file upload limit");

    // Refused before any write.
    const listed = await call("/api/staging", { method: "GET", cookie: admin.cookie });
    expect(listed.body.files).toEqual([]);

    expect((await uploadImage(admin.cookie, "ok.png", filler(1024 * 1024))).status).toBe(200);
  });

  it("refuses a staging upload that would exceed the quota", async () => {
    const admin = await loginSession();
    // 0.1 GB = 102.4 MB; two 40 MB files fit, a third does not.
    await setLimits(admin, { upload_user_quota_gb: 0.1, upload_max_file_mb: 50 });
    const chunk = filler(40 * 1024 * 1024);

    expect((await uploadImage(admin.cookie, "a.png", chunk)).status).toBe(200);
    expect((await uploadImage(admin.cookie, "b.png", chunk)).status).toBe(200);

    const over = await uploadImage(admin.cookie, "c.png", chunk);
    expect(over.status).toBe(413);
    const body = (await over.json()) as any;
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.message).toContain("儲存空間不足（已用 80 MB / 配額 102.4 MB）");
    expect(body.error.message).toContain("Storage quota exceeded (used 80 MB of 102.4 MB)");

    const listed = await call("/api/staging", { method: "GET", cookie: admin.cookie });
    expect(listed.body.files.map((f: any) => f.name).sort()).toEqual(["a.png", "b.png"]);
  });

  it("does not double-count the bytes an overwrite frees", async () => {
    const admin = await loginSession();
    await setLimits(admin, { upload_user_quota_gb: 0.1 });
    const chunk = filler(50 * 1024 * 1024);
    expect((await uploadImage(admin.cookie, "a.png", chunk)).status).toBe(200);
    expect((await uploadImage(admin.cookie, "b.png", chunk)).status).toBe(200);
    // Full to the byte, but replacing one of them is still allowed.
    expect((await uploadImage(admin.cookie, "a.png", chunk)).status).toBe(200);
  });

  it("counts userdata as well as staging toward the quota", async () => {
    const admin = await loginSession();
    await setLimits(admin, { upload_user_quota_gb: 0.1, upload_max_file_mb: 50 });
    const saved = await call("/comfy/api/userdata/w%2Fbig.json", {
      method: "POST",
      cookie: admin.cookie,
      rawBody: new Uint8Array(50 * 1024 * 1024).fill(117),
    });
    expect(saved.status).toBe(200);
    expect((await uploadImage(admin.cookie, "a.png", filler(50 * 1024 * 1024))).status).toBe(200);

    // 100 MB of the 102.4 MB quota is used, half of it in userdata -- a 3 MB
    // staging upload only overflows if BOTH namespaces are counted.
    const over = await uploadImage(admin.cookie, "b.png", filler(3 * 1024 * 1024));
    expect(over.status).toBe(413);
    const body = (await over.json()) as any;
    expect(body.error.code).toBe("quota_exceeded");
    expect(body.error.message).toContain("已用 100 MB");
  });

  it("does not count job artifacts toward the quota", async () => {
    // Artifacts are RESULTS, not files the user chose to keep -- a full
    // `artifacts/` prefix must never block an upload (see lib/limits.ts).
    const admin = await loginSession();
    await setLimits(admin, { upload_user_quota_gb: 0.1 });
    await store().put("artifacts/job-1/out.png", new Uint8Array(80 * 1024 * 1024).fill(1));
    try {
      expect((await uploadImage(admin.cookie, "ref.png", filler(50 * 1024 * 1024))).status).toBe(200);
    } finally {
      await store().delete("artifacts/job-1/out.png");
    }
  });

  it("reports usage and quota on the listing", async () => {
    const admin = await loginSession();
    await setLimits(admin, { upload_user_quota_gb: 2 });
    expect((await uploadImage(admin.cookie, "ref.png", "12345")).status).toBe(200);
    const saved = await call("/comfy/api/userdata/w%2Fa.json", {
      method: "POST",
      cookie: admin.cookie,
      rawBody: new TextEncoder().encode("abc"),
    });
    expect(saved.status).toBe(200);

    const listed = await call("/api/staging", { method: "GET", cookie: admin.cookie });
    expect(listed.body.total_bytes).toBe(5);
    expect(listed.body.userdata_bytes).toBe(3);
    expect(listed.body.quota_bytes).toBe(2 * 1024 * 1024 * 1024);
    // Additive only: the pre-existing shape is untouched.
    expect(listed.body.files.map((f: any) => f.name)).toEqual(["ref.png"]);
  });
});

describe("prefixBytes pagination", () => {
  it("sums every page, not just the first (R2 lists at most 1000 keys)", async () => {
    // Unit-tested against a stub bucket rather than by writing 1000+ real
    // objects: what matters is that a truncated page's cursor is followed,
    // and an undercount here would be a quota that silently stops applying
    // to exactly the accounts with the most files.
    const { prefixBytes } = await import("../src/lib/limits");
    const pages = [
      { objects: Array.from({ length: 1000 }, () => ({ size: 10 })), truncated: true, cursor: "c1" },
      { objects: Array.from({ length: 1000 }, () => ({ size: 10 })), truncated: true, cursor: "c2" },
      { objects: Array.from({ length: 5 }, () => ({ size: 3 })), truncated: false },
    ];
    const seen: (string | undefined)[] = [];
    const stub = {
      list: async (options: { prefix: string; cursor?: string }) => {
        seen.push(options.cursor);
        return pages[seen.length - 1] as any;
      },
    } as unknown as R2Bucket;

    expect(await prefixBytes(stub, "staging/u/")).toBe(1000 * 10 + 1000 * 10 + 5 * 3);
    expect(seen).toEqual([undefined, "c1", "c2"]);
  });
});
