/**
 * `/comfy/api/userdata` -- the panel's workflow save/load surface, the cloud
 * twin of tests/server/test_userdata.py. Same harness idioms as
 * comfyapi.spec.ts (`call` / `loginSession` / `userSession`, R2 cleanup in
 * `afterEach`).
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
  for (const prefix of ["userdata/"]) {
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

const WORKFLOW = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };

function store_(cookie: string | null, path: string, body: unknown = WORKFLOW, query = "") {
  return call(`/comfy/api/userdata/${path}${query}`, {
    method: "POST",
    cookie,
    rawBody: new TextEncoder().encode(JSON.stringify(body)),
  });
}

// --- userdata ---------------------------------------------------------------

describe("/comfy/api/userdata", () => {
  it("round-trips list/get/post/delete for the panel's workflow calls", async () => {
    const admin = await loginSession();

    // Fresh account, nothing saved: an empty array, 200 (not the catch-all 404).
    const empty = await call("/comfy/api/userdata?dir=workflows&recurse=true&split=false&full_info=true", {
      method: "GET",
      cookie: admin.cookie,
    });
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);

    const stored = await store_(admin.cookie, "workflows%2Fmy%20flow.json");
    expect(stored.status).toBe(200);
    expect(stored.body.path).toBe("workflows/my flow.json");
    expect(stored.body.size).toBeGreaterThan(0);
    expect(typeof stored.body.modified).toBe("number");

    // The exact call the pinned frontend's workflow browser makes -- `path`
    // is relative to the REQUESTED dir (the frontend re-prefixes the dir).
    const listed = await call("/comfy/api/userdata?dir=workflows&recurse=true&split=false&full_info=true", {
      method: "GET",
      cookie: admin.cookie,
    });
    expect(listed.status).toBe(200);
    expect(listed.body.map((e: any) => e.path)).toEqual(["my flow.json"]);
    expect(listed.body[0].size).toBe(stored.body.size);

    const fetched = await call("/comfy/api/userdata/workflows%2Fmy%20flow.json", { method: "GET", cookie: admin.cookie });
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(WORKFLOW);

    const deleted = await call("/comfy/api/userdata/workflows%2Fmy%20flow.json", { method: "DELETE", cookie: admin.cookie });
    expect(deleted.status).toBe(204);
    expect((await call("/comfy/api/userdata/workflows%2Fmy%20flow.json", { method: "GET", cookie: admin.cookie })).status).toBe(404);
    expect((await call("/comfy/api/userdata/workflows%2Fmy%20flow.json", { method: "DELETE", cookie: admin.cookie })).status).toBe(404);
  });

  it("honours recurse / split / dir on the listing", async () => {
    const admin = await loginSession();
    await store_(admin.cookie, "workflows%2Ftop.json");
    await store_(admin.cookie, "workflows%2Fsub%2Fdeep.json");

    const recursed = await call("/comfy/api/userdata?dir=workflows&recurse=true", { method: "GET", cookie: admin.cookie });
    expect(recursed.body).toEqual(["sub/deep.json", "top.json"]);

    const shallow = await call("/comfy/api/userdata?dir=workflows&recurse=false", { method: "GET", cookie: admin.cookie });
    expect(shallow.body).toEqual(["top.json"]);

    const split = await call("/comfy/api/userdata?dir=workflows&recurse=true&split=true", { method: "GET", cookie: admin.cookie });
    expect(split.body).toEqual([["sub/deep.json", "sub", "deep.json"], ["top.json", "top.json"]]);

    const root = await call("/comfy/api/userdata?recurse=true&full_info=true", { method: "GET", cookie: admin.cookie });
    expect(root.body.map((e: any) => e.path).sort()).toEqual(["workflows/sub/deep.json", "workflows/top.json"]);
  });

  it("defaults overwrite to true and 409s when it is false", async () => {
    const admin = await loginSession();
    expect((await store_(admin.cookie, "workflows%2Fa.json")).status).toBe(200);

    const conflict = await store_(admin.cookie, "workflows%2Fa.json", WORKFLOW, "?overwrite=false&full_info=false");
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe("userdata.exists");

    expect((await store_(admin.cookie, "workflows%2Fa.json", { v: 2 })).status).toBe(200);
    expect((await store_(admin.cookie, "workflows%2Fa.json", { v: 3 }, "?overwrite=true&full_info=true")).status).toBe(200);
    const fetched = await call("/comfy/api/userdata/workflows%2Fa.json", { method: "GET", cookie: admin.cookie });
    expect(fetched.body).toEqual({ v: 3 });
  });

  it("moves a file within the same user's space", async () => {
    const admin = await loginSession();
    await store_(admin.cookie, "workflows%2Fold.json");

    const moved = await call("/comfy/api/userdata/workflows%2Fold.json/move/workflows%2Fnew.json", {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(moved.status).toBe(200);
    expect(moved.body.path).toBe("workflows/new.json");
    expect((await call("/comfy/api/userdata/workflows%2Fold.json", { method: "GET", cookie: admin.cookie })).status).toBe(404);
    expect((await call("/comfy/api/userdata/workflows%2Fnew.json", { method: "GET", cookie: admin.cookie })).status).toBe(200);

    const missing = await call("/comfy/api/userdata/workflows%2Fnope.json/move/workflows%2Fx.json", {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(missing.status).toBe(404);

    await store_(admin.cookie, "workflows%2Fother.json");
    const clash = await call("/comfy/api/userdata/workflows%2Fother.json/move/workflows%2Fnew.json", {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("userdata.exists");

    const forced = await call("/comfy/api/userdata/workflows%2Fother.json/move/workflows%2Fnew.json?overwrite=true", {
      method: "POST",
      cookie: admin.cookie,
    });
    expect(forced.status).toBe(200);
  });

  it("rejects traversal in the path and the dir", async () => {
    const admin = await loginSession();
    for (const bad of ["..%2Fescape.json", "workflows%2F..%2F..%2Fsecret.json", "%2Fetc%2Fpasswd"]) {
      expect((await store_(admin.cookie, bad)).status).toBe(400);
      expect((await call(`/comfy/api/userdata/${bad}`, { method: "GET", cookie: admin.cookie })).status).toBe(400);
      expect((await call(`/comfy/api/userdata/${bad}`, { method: "DELETE", cookie: admin.cookie })).status).toBe(400);
    }
    const badDir = await call("/comfy/api/userdata?dir=..%2F..", { method: "GET", cookie: admin.cookie });
    expect(badDir.status).toBe(400);
  });

  it("rejects a userdata file over 5 MB", async () => {
    const admin = await loginSession();
    const big = await call("/comfy/api/userdata/workflows%2Fbig.json", {
      method: "POST",
      cookie: admin.cookie,
      rawBody: new Uint8Array(5 * 1024 * 1024 + 1).fill(120),
    });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe("userdata.too_large");
    expect(big.body.error.message).toContain("5 MB");

    const ok = await call("/comfy/api/userdata/workflows%2Fok.json", {
      method: "POST",
      cookie: admin.cookie,
      rawBody: new Uint8Array(5 * 1024 * 1024).fill(121),
    });
    expect(ok.status).toBe(200);
  });

  it("refuses an oversized declared Content-Length before reading the body", async () => {
    const admin = await loginSession();
    const huge = await call("/comfy/api/userdata/workflows%2Fhuge.json", {
      method: "POST",
      cookie: admin.cookie,
      rawBody: new TextEncoder().encode("x"),
      headers: { "content-length": String(2 * 1024 * 1024 * 1024) },
    });
    expect(huge.status).toBe(413);
    expect(huge.body.error.code).toBe("userdata.too_large");
    // Nothing was written.
    const after = await call("/comfy/api/userdata/workflows%2Fhuge.json", { method: "GET", cookie: admin.cookie });
    expect(after.status).toBe(404);
  });

  it("rejects control characters in a userdata path", async () => {
    const admin = await loginSession();
    expect((await store_(admin.cookie, "a%00b")).status).toBe(400);
    expect((await call("/comfy/api/userdata/a%00b", { method: "GET", cookie: admin.cookie })).status).toBe(400);
    expect((await call("/comfy/api/userdata/a%00b", { method: "DELETE", cookie: admin.cookie })).status).toBe(400);
  });

  it("refuses a cross-origin mutation and passes same-origin / no-origin ones", async () => {
    const admin = await loginSession();
    expect((await store_(admin.cookie, "workflows%2Forigin.json")).status).toBe(200);

    const evil = { origin: "https://evil.example" };
    const crossPost = await call("/comfy/api/userdata/workflows%2Fx.json", {
      method: "POST",
      cookie: admin.cookie,
      rawBody: new TextEncoder().encode("{}"),
      headers: evil,
    });
    expect(crossPost.status).toBe(403);
    expect(crossPost.body.error.code).toBe("userdata.bad_origin");

    const crossDelete = await call("/comfy/api/userdata/workflows%2Forigin.json", {
      method: "DELETE",
      cookie: admin.cookie,
      headers: evil,
    });
    expect(crossDelete.status).toBe(403);

    const crossMove = await call("/comfy/api/userdata/workflows%2Forigin.json/move/workflows%2Fmoved.json", {
      method: "POST",
      cookie: admin.cookie,
      headers: evil,
    });
    expect(crossMove.status).toBe(403);

    // Untouched.
    expect((await call("/comfy/api/userdata/workflows%2Forigin.json", { method: "GET", cookie: admin.cookie })).status).toBe(200);

    // Same-origin passes...
    const same = await call("/comfy/api/userdata/workflows%2Fsame.json", {
      method: "POST",
      cookie: admin.cookie,
      rawBody: new TextEncoder().encode("{}"),
      headers: { origin: "http://example.com" },
    });
    expect(same.status).toBe(200);

    // ... and so does no Origin at all (non-browser clients).
    const plain = await call("/comfy/api/userdata/workflows%2Forigin.json", { method: "DELETE", cookie: admin.cookie });
    expect(plain.status).toBe(204);
  });

  it("requires an authenticated session", async () => {
    await loginSession(); // a user exists, but this call carries no cookie
    for (const [method, path] of [
      ["GET", "/comfy/api/userdata"],
      ["GET", "/comfy/api/userdata/workflows%2Fa.json"],
      ["POST", "/comfy/api/userdata/workflows%2Fa.json"],
      ["DELETE", "/comfy/api/userdata/workflows%2Fa.json"],
    ] as [string, string][]) {
      const res = await call(path, { method });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error.code).toBe("auth.required");
    }
  });

  it("beats index.ts's /comfy/api/* JSON-404 catch-all", async () => {
    const admin = await loginSession();
    // The catch-all answers `{error:"not_found", message:...}` with a STRING
    // error; a real userdata route never does, whatever its status.
    const listed = await call("/comfy/api/userdata?dir=workflows&recurse=true&full_info=true", {
      method: "GET",
      cookie: admin.cookie,
    });
    expect(listed.status).toBe(200);
    expect(Array.isArray(listed.body)).toBe(true);

    const missing = await call("/comfy/api/userdata/workflows%2Fnope.json", { method: "GET", cookie: admin.cookie });
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("userdata.not_found");

    // ... while a genuinely unimplemented panel endpoint still hits it.
    const unimplemented = await call("/comfy/api/experiment/models", { method: "GET", cookie: admin.cookie });
    expect(unimplemented.status).toBe(404);
    expect(unimplemented.body.error).toBe("not_found");
  });

  it("isolates one user's userdata from another's", async () => {
    const admin = await loginSession();
    const alice = await userSession(admin, "alice");
    const bob = await userSession(admin, "bob");

    expect((await store_(alice.cookie, "workflows%2Fsecret.json", { owner: "alice" })).status).toBe(200);

    // Bob cannot read, list, move or delete Alice's file even knowing its name.
    expect((await call("/comfy/api/userdata/workflows%2Fsecret.json", { method: "GET", cookie: bob.cookie })).status).toBe(404);
    const bobList = await call("/comfy/api/userdata?dir=workflows&recurse=true&full_info=true", { method: "GET", cookie: bob.cookie });
    expect(bobList.body).toEqual([]);
    expect((await call("/comfy/api/userdata/workflows%2Fsecret.json", { method: "DELETE", cookie: bob.cookie })).status).toBe(404);
    expect(
      (await call("/comfy/api/userdata/workflows%2Fsecret.json/move/workflows%2Fstolen.json", { method: "POST", cookie: bob.cookie }))
        .status
    ).toBe(404);

    // Bob's same-named save touches only his own namespace.
    expect((await store_(bob.cookie, "workflows%2Fsecret.json", { owner: "bob" })).status).toBe(200);
    expect((await call("/comfy/api/userdata/workflows%2Fsecret.json", { method: "GET", cookie: bob.cookie })).body).toEqual({ owner: "bob" });
    expect((await call("/comfy/api/userdata/workflows%2Fsecret.json", { method: "GET", cookie: alice.cookie })).body).toEqual({
      owner: "alice",
    });

    // ... and an admin gets no override view either.
    expect((await call("/comfy/api/userdata/workflows%2Fsecret.json", { method: "GET", cookie: admin.cookie })).status).toBe(404);
  });
});
