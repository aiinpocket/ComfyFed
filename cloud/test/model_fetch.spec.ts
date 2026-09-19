import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import * as modelFetch from "../src/core/model_fetch";
import * as modelGuide from "../src/core/model_guide";
import * as modelManifest from "../src/core/model_manifest";
import { resolvePlatformSeed } from "../src/db/queries";
import { verifyHex, derivePublicKeyHexFromSeed } from "../src/lib/ed25519";
import golden from "./fixtures/golden.json";

// Ports tests/server/test_model_fetch.py case for case: the URL origin
// allowlist, the HEAD size probe, the unverified-source manifest entry
// signature, and then the whole §5.1 decision sequence through the real
// `POST`/`GET /comfy/api/comfyfed/model-fetch` routes.

afterEach(async () => {
  // `stubHead` below spies on the module namespace; restore it so the pure
  // `headSizeBytes` tests in this file (and every other file) see the real
  // implementation.
  vi.restoreAllMocks();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM model_hashes").run();
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  await db().prepare("DELETE FROM login_attempts").run();
  modelGuide.clearHarvestCacheForTests();
  modelManifest.clearMismatchLogForTests();
});

// ---------------------------------------------------------------------------
// Pure helpers

describe("isTrustedUrl", () => {
  const cases: [string, boolean][] = [
    ["https://huggingface.co/Comfy-Org/x/resolve/main/ae.safetensors", true],
    ["https://HUGGINGFACE.co/a/b", true],
    ["https://civitai.com/api/download/models/123", true],
    ["https://huggingface.co.evil.com/x", false],
    ["http://huggingface.co/x", false],
    ["https://storage.googleapis.com/x", false],
    ["not a url", false],
    ["", false],
  ];
  for (const [url, ok] of cases) {
    it(`${JSON.stringify(url)} -> ${ok}`, () => {
      expect(modelFetch.isTrustedUrl(url)).toBe(ok);
    });
  }

  it("rejects an explicit non-443 port but accepts a spelled-out :443", () => {
    // The allowlist vouches for an origin, not a host: a different port is a
    // different endpoint. `new URL` normalizes away the default port, so the
    // spelled-out one is genuinely the same origin.
    expect(modelFetch.isTrustedUrl("https://huggingface.co:8443/x")).toBe(false);
    expect(modelFetch.isTrustedUrl("https://huggingface.co:443/x")).toBe(true);
  });
});

describe("isSafeRedirectTarget", () => {
  const cases: [string, boolean][] = [
    // The CDN hosts real HF / Civitai downloads actually hand off to.
    ["https://cdn-lfs-us-1.hf.co/repos/x/ae.safetensors", true],
    ["https://cas-bridge.xethub.hf.co/xet-bridge-us/abc", true],
    ["https://civitai-delivery-worker-prod.abc.r2.cloudflarestorage.com/x", true],
    ["https://huggingface.co/a", true], // hop 0's origin is safe too
    ["https://evil.example/x", true], // off-allowlist but not internal
    ["http://cdn-lfs.hf.co/x", false], // plaintext
    ["https://cdn-lfs.hf.co:8443/x", false], // non-443 port
    ["https://user:pw@cdn-lfs.hf.co/x", false], // userinfo
    ["https://127.0.0.1/x", false], // IPv4 literal / loopback
    ["https://10.0.0.5/x", false], // IPv4 literal / LAN
    ["https://169.254.169.254/latest/meta-data/", false], // link-local metadata
    ["https://[::1]/x", false], // IPv6 literal, bracketed
    ["https://[fd00::1]/x", false], // IPv6 ULA
    ["https://localhost/x", false],
    ["https://foo.localhost/x", false],
    ["https://printer.local/x", false],
    ["https://foo.internal/x", false],
    ["https://FOO.INTERNAL./x", false], // case + absolute-FQDN dot
    ["https://box.home.arpa/x", false],
    ["not a url", false],
    ["", false],
  ];
  for (const [url, ok] of cases) {
    it(`${JSON.stringify(url)} -> ${ok}`, () => {
      expect(modelFetch.isSafeRedirectTarget(url)).toBe(ok);
    });
  }

  it("accepts a spelled-out :443 on a CDN host", () => {
    expect(modelFetch.isSafeRedirectTarget("https://cdn-lfs.hf.co:443/x")).toBe(true);
  });
});

describe("unverified entry signature", () => {
  it("has the exact payload shape both stacks and the agent sign", () => {
    expect(modelFetch.unverifiedPayload("ae.safetensors", "vae", "https://huggingface.co/x", 335)).toBe(
      "ae.safetensors|vae|https://huggingface.co/x|335|unverified"
    );
  });

  it("verifies with the platform key and is flagged unverified", async () => {
    const seedHex = golden.keypairs[0]!.seed_hex;
    const pubkey = await derivePublicKeyHexFromSeed(seedHex);
    const entry = await modelFetch.signUnverifiedEntry(seedHex, {
      name: "ae.safetensors",
      directory: "vae",
      url: "https://huggingface.co/x",
      sizeBytes: 335,
    });
    expect(entry.unverified).toBe(true);
    expect(entry.sha256).toBeNull();
    expect(entry.backup_url).toBeNull();
    expect(
      await verifyHex(
        pubkey,
        new TextEncoder().encode(
          modelFetch.unverifiedPayload("ae.safetensors", "vae", "https://huggingface.co/x", 335)
        ),
        entry.sig
      )
    ).toBe(true);

    expect(modelFetch.isUnverifiedEntry(entry)).toBe(true);
    expect(modelFetch.isUnverifiedEntry({ name: "x", sha256: "ab".repeat(32), size_bytes: 1 })).toBe(false);
  });
});

/** A fake `fetch` for `headSizeBytes`: records the request it was handed and
 * answers with a header-only response. The Python twin injects an
 * `httpx.MockTransport` client factory for the same reason. */
function fakeFetch(
  respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  seen: { url?: string; init?: RequestInit } = {}
): typeof fetch {
  return (async (url: any, init: any) => {
    seen.url = String(url);
    seen.init = init;
    return respond(String(url), init);
  }) as unknown as typeof fetch;
}

function headerResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

describe("headSizeBytes", () => {
  it("issues a manual-redirect HEAD and reads Content-Length", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const size = await modelFetch.headSizeBytes(
      "https://huggingface.co/a",
      fakeFetch(() => headerResponse(200, { "content-length": "12345" }), seen)
    );
    expect(size).toBe(12345);
    expect(seen.init?.method).toBe("HEAD");
    // Final-review I4: redirects are followed BY HAND so every hop can be
    // allowlist-checked before it is requested. `redirect: "follow"` would
    // hand the runtime a chain this code never sees.
    expect(seen.init?.redirect).toBe("manual");
  });

  it("follows an allowlisted -> allowlisted redirect", async () => {
    const asked: string[] = [];
    const size = await modelFetch.headSizeBytes(
      "https://huggingface.co/a",
      fakeFetch((url) => {
        asked.push(url);
        return url.endsWith("/a")
          ? headerResponse(302, { location: "https://civitai.com/b" })
          : headerResponse(200, { "content-length": "12345" });
      })
    );
    expect(size).toBe(12345);
    expect(asked).toEqual(["https://huggingface.co/a", "https://civitai.com/b"]);
  });

  it("resolves a relative Location against the hop that issued it", async () => {
    const asked: string[] = [];
    const size = await modelFetch.headSizeBytes(
      "https://huggingface.co/a",
      fakeFetch((url) => {
        asked.push(url);
        return url.endsWith("/a")
          ? headerResponse(302, { location: "/b" })
          : headerResponse(200, { "content-length": "777" });
      })
    );
    expect(size).toBe(777);
    expect(asked).toEqual(["https://huggingface.co/a", "https://huggingface.co/b"]);
  });

  // Final-fix N1: the real download paths. HF `…/resolve/…` 302s to a CDN
  // host, Civitai 302s to its R2 delivery host -- neither is on the origin
  // allowlist, and refusing them meant the feature's main path could never
  // create a job.
  const cdnHandOffs: [string, string][] = [
    [
      "https://huggingface.co/org/repo/resolve/main/ae.safetensors",
      "https://cdn-lfs-us-1.hf.co/repos/x/ae.safetensors?download=true",
    ],
    [
      "https://civitai.com/api/download/models/123",
      "https://civitai-delivery-worker-prod.abc.r2.cloudflarestorage.com/model/x.safetensors",
    ],
  ];
  for (const [first, location] of cdnHandOffs) {
    it(`follows the CDN hand-off ${first} -> ${location}`, async () => {
      const asked: string[] = [];
      const size = await modelFetch.headSizeBytes(
        first,
        fakeFetch((url) => {
          asked.push(url);
          return url === first
            ? headerResponse(302, { location })
            : headerResponse(200, { "content-length": "4242" });
        })
      );
      expect(size).toBe(4242);
      expect(asked).toEqual([first, location]);
    });
  }

  it("refuses a CDN host as hop 0", async () => {
    // The looser rule is for LATER hops only: a CDN host the user supplies
    // directly is still off the origin allowlist, because hop 0 is the url
    // that gets signed into the unverified entry.
    const asked: string[] = [];
    await expect(
      modelFetch.headSizeBytes(
        "https://cdn-lfs.hf.co/x",
        fakeFetch((url) => {
          asked.push(url);
          throw new Error(`hop 0 was actually requested: ${url}`);
        })
      )
    ).rejects.toMatchObject({ code: "untrusted_url" });
    expect(asked).toEqual([]);
  });

  const unsafeHops = [
    "http://cdn-lfs.hf.co/x", // plaintext hop
    "http://127.0.0.1:6379/", // SSRF / internal port oracle
    "https://127.0.0.1/x", // loopback, default port
    "https://[::1]/x", // IPv6 loopback
    "https://192.168.1.10:8080/x", // LAN address
    "https://169.254.169.254/x", // link-local metadata service
    "https://foo.internal/x", // internal name
    "https://box.home.arpa/x",
    "https://printer.local/x",
    "https://evil.example:8443/x", // off-443 endpoint
    "https://huggingface.co:8443/x", // right host, different endpoint
  ];
  for (const location of unsafeHops) {
    it(`refuses a redirect to ${location}`, async () => {
      // Final-review I4 / final-fix N1: hop 0 clears the strict allowlist and
      // every LATER hop must clear `isSafeRedirectTarget`, so a redirect can
      // no longer carry the probe at loopback/LAN/internal names. The unsafe
      // hop is never requested at all.
      const asked: string[] = [];
      await expect(
        modelFetch.headSizeBytes(
          "https://huggingface.co/a",
          fakeFetch((url) => {
            asked.push(url);
            if (url.endsWith("/a")) return headerResponse(302, { location });
            throw new Error(`off-allowlist hop was actually requested: ${url}`);
          })
        )
        // Reuses the pre-HEAD allowlist code so the panel gets the existing
        // `model_fetch.untrusted_url` 400 and its existing message.
      ).rejects.toMatchObject({ code: "untrusted_url" });
      expect(asked).toEqual(["https://huggingface.co/a"]);
    });
  }

  it("refuses more than five redirect hops", async () => {
    let n = 0;
    await expect(
      modelFetch.headSizeBytes(
        "https://huggingface.co/0",
        fakeFetch(() => headerResponse(302, { location: `https://huggingface.co/${++n}` }))
      )
    ).rejects.toMatchObject({ code: "size_unknown" });
    // 1 initial request + 5 followed hops, then it gives up.
    expect(n).toBe(6);
  });

  it("treats a redirect without a Location as size_unknown", async () => {
    await expect(
      modelFetch.headSizeBytes("https://huggingface.co/a", fakeFetch(() => headerResponse(302)))
    ).rejects.toMatchObject({ code: "size_unknown" });
  });

  for (const status of [401, 403]) {
    it(`treats HTTP ${status} as gated`, async () => {
      await expect(
        modelFetch.headSizeBytes("https://huggingface.co/a", fakeFetch(() => headerResponse(status)))
      ).rejects.toMatchObject({ code: "gated" });
    });
  }

  const unknownCases: [string, () => Response][] = [
    ["a non-2xx status", () => headerResponse(404)],
    ["no Content-Length at all", () => headerResponse(200)],
    ["a zero Content-Length", () => headerResponse(200, { "content-length": "0" })],
    ["a non-numeric Content-Length", () => headerResponse(200, { "content-length": "abc" })],
  ];
  for (const [label, respond] of unknownCases) {
    it(`treats ${label} as size_unknown`, async () => {
      await expect(
        modelFetch.headSizeBytes("https://huggingface.co/a", fakeFetch(respond))
      ).rejects.toMatchObject({ code: "size_unknown" });
    });
  }

  it("treats a network error as size_unknown", async () => {
    await expect(
      modelFetch.headSizeBytes(
        "https://huggingface.co/a",
        fakeFetch(() => {
          throw new Error("boom");
        })
      )
    ).rejects.toMatchObject({ code: "size_unknown" });
  });
});

// ---------------------------------------------------------------------------
// POST/GET /comfy/api/comfyfed/model-fetch

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function loginSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

async function registerWorker(
  session: { cookie: string | null; csrf: string },
  opts: {
    name?: string;
    status?: string;
    protocol?: number;
    autoFetch?: boolean;
    freeDiskGb?: number;
    maxFetchGb?: number;
    models?: unknown[];
  } = {}
): Promise<string> {
  const name = opts.name ?? "w1";
  const tokenRes = await call("/api/workers/tokens", {
    json: { name },
    cookie: session.cookie,
    headers: { "X-CSRF": session.csrf },
  });
  const token = tokenRes.body.bundle.register_token;
  const reg = await call("/api/agent/register", { json: { token, name, pubkey: golden.keypairs[0]!.pubkey_hex } });
  const workerId = reg.body.worker_id;
  await db()
    .prepare(
      "UPDATE workers SET status = ?, protocol = ?, auto_fetch = ?, dynamic = ?, hardware = ?, model_inventory = ? WHERE id = ?"
    )
    .bind(
      opts.status ?? "online",
      opts.protocol ?? 5,
      opts.autoFetch === false ? 0 : 1,
      JSON.stringify({ free_disk_gb: opts.freeDiskGb ?? 100.0 }),
      JSON.stringify({ max_fetch_gb: opts.maxFetchGb ?? 100 }),
      JSON.stringify(opts.models ?? []),
      workerId
    )
    .run();
  return workerId;
}

// A name the platform has NO curated/learned hash for -- the whole point of
// the unverified-source path. (`ae.safetensors`, the spec's motivating
// example, is one of the curated models and therefore takes the VERIFIED
// manifest branch instead; that case has its own test below.)
const BODY = {
  name: "unknown_vae.safetensors",
  directory: "vae",
  url: "https://huggingface.co/Comfy-Org/x/resolve/main/unknown_vae.safetensors",
};

function post(session: { cookie: string | null } | null, body: unknown) {
  return call("/comfy/api/comfyfed/model-fetch", { json: body, cookie: session?.cookie ?? null });
}

/** Point the route's HEAD probe at `impl` for this test.
 *
 * The route calls `modelFetch.headSizeBytes` through the module namespace on
 * every request precisely so this works -- the same `vi.spyOn` seam this
 * suite already uses for `peerhealth.probePeerHealth`, and the twin of the
 * Python suite's `monkeypatch.setattr(model_fetch, "head_size_bytes", ...)`.
 * Nothing mutable is exported from the production module. */
function stubHead(impl: (url: string) => Promise<number>): void {
  vi.spyOn(modelFetch, "headSizeBytes").mockImplementation(impl as typeof modelFetch.headSizeBytes);
}

function headRaising(code: string): (url: string) => Promise<number> {
  return async () => {
    throw new modelFetch.HeadError(code);
  };
}

async function jobRow(jobId: string): Promise<any> {
  return db().prepare("SELECT * FROM jobs WHERE id = ?").bind(jobId).first<any>();
}

describe("POST /comfy/api/comfyfed/model-fetch", () => {
  it("requires a logged-in session", async () => {
    const res = await post(null, BODY);
    expect([401, 403]).toContain(res.status);
  });

  it("refuses a malformed name/directory/url with bad_request", async () => {
    const session = await loginSession();
    const bad = [
      {},
      { ...BODY, name: "../x" },
      { ...BODY, name: "a/b" },
      { ...BODY, directory: "../vae" },
      { ...BODY, directory: "/abs" },
      { ...BODY, directory: "C:\\x" },
      { ...BODY, url: 5 },
    ];
    for (const body of bad) {
      const res = await post(session, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("model_fetch.bad_request");
    }
  });

  it("refuses `|` and control characters in a signed field", async () => {
    // `|` is the signature payload's own delimiter and control characters
    // would ride it onto the worker's filesystem -- neither may reach a
    // signed field, in `name` or in `directory`.
    const session = await loginSession();
    const bad = [
      { ...BODY, name: "a|b.safetensors" },
      { ...BODY, name: "a\nb.safetensors" },
      { ...BODY, name: "a\u0000b.safetensors" },
      { ...BODY, name: "a\u007fb.safetensors" },
      { ...BODY, directory: "va|e" },
      { ...BODY, directory: "vae\t" },
    ];
    for (const body of bad) {
      const res = await post(session, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error).toBe("model_fetch.bad_request");
    }
  });

  it("refuses a non-object body with the same 400 envelope", async () => {
    const session = await loginSession();
    for (const raw of [[], "x", 5, null]) {
      const res = await post(session, raw);
      expect(res.status, JSON.stringify(raw)).toBe(400);
      expect(res.body.error).toBe("model_fetch.bad_request");
      expect(res.body.message).toBeTruthy();
    }
  });

  it("refuses already_present even for an OFFLINE holder", async () => {
    // The model IS in the federation; the panel just has a stale
    // missing-models card.
    const session = await loginSession();
    await registerWorker(session, {
      status: "offline",
      models: [{ name: "vae/unknown_vae.safetensors", size: 0.3 }],
    });
    const res = await post(session, BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("model_fetch.already_present");
  });

  it("refuses an off-allowlist url", async () => {
    const session = await loginSession();
    await registerWorker(session);
    const res = await post(session, { ...BODY, url: "https://evil.example/x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("model_fetch.untrusted_url");
  });

  it("surfaces the HEAD probe's gated/size_unknown verdicts", async () => {
    const session = await loginSession();
    await registerWorker(session);

    stubHead(headRaising("gated"));
    expect((await post(session, BODY)).body.error).toBe("model_fetch.gated");

    stubHead(headRaising("size_unknown"));
    expect((await post(session, BODY)).body.error).toBe("model_fetch.size_unknown");
  });

  it("refuses no_worker when the only candidate is protocol 4", async () => {
    const session = await loginSession();
    await registerWorker(session, { protocol: 4 });
    stubHead(async () => 335_000_000);
    const res = await post(session, BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("model_fetch.no_worker");
  });

  it("creates a job, then reuses it, and serves its status", async () => {
    const session = await loginSession();
    await registerWorker(session, { protocol: 5, maxFetchGb: 30 });
    stubHead(async () => 335_000_000);

    const first = await post(session, BODY);
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.reused).toBe(false);
    const jobId = first.body.job_id;

    const second = await post(session, BODY);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ job_id: jobId, reused: true });

    const row = await jobRow(jobId);
    expect(row.kind).toBe("model_fetch");
    expect(row.workflow_json).toBe("{}");
    expect(JSON.parse(row.required_models)).toEqual(["unknown_vae.safetensors"]);
    expect(JSON.parse(row.required_nodes)).toEqual([]);
    expect(JSON.parse(row.input_assets)).toEqual([]);
    expect(row.est_vram_gb).toBeNull();
    expect(row.signature).toBeNull();
    expect(row.split_plan).toBeNull();
    expect(row.origin).toBe("panel");
    expect(row.user_id).toBeTruthy();

    const entry = JSON.parse(row.fetch_entry);
    expect(entry.unverified).toBe(true);
    expect(entry.size_bytes).toBe(335_000_000);
    expect(entry.url).toBe(BODY.url);
    expect(entry.sha256).toBeNull();
    expect(entry.backup_url).toBeNull();

    const status = await call(`/comfy/api/comfyfed/model-fetch/${jobId}`, { cookie: session.cookie });
    expect(status.status).toBe(200);
    expect(status.body.status).toBe("queued");
    expect(status.body.name).toBe("unknown_vae.safetensors");
    expect(status.body.stage).toBeNull();
    expect(status.body.fetch_pct).toBeNull();
    expect(status.body.fetch_model).toBeNull();
    expect(status.body.worker_id).toBeNull();
    expect(status.body.error).toBeNull();
  });

  it("signs the stored entry with the platform key", async () => {
    const session = await loginSession();
    await registerWorker(session, { protocol: 5, maxFetchGb: 30 });
    stubHead(async () => 335_000_000);

    const jobId = (await post(session, BODY)).body.job_id;
    const entry = JSON.parse((await jobRow(jobId)).fetch_entry);

    const pubkey = await derivePublicKeyHexFromSeed(
      await resolvePlatformSeed(db(), (env as any).PLATFORM_ED25519_SEED)
    );
    expect(
      await verifyHex(
        pubkey,
        new TextEncoder().encode(
          modelFetch.unverifiedPayload("unknown_vae.safetensors", "vae", BODY.url, 335_000_000)
        ),
        entry.sig
      )
    ).toBe(true);
  });

  for (const status of ["assigned", "running"]) {
    it(`reuses an in-flight (${status}) job`, async () => {
      // The reuse row covers every live status, not just `queued` -- this
      // stack calls the claimed-but-not-started state `assigned`, where the
      // spec says `dispatched`.
      const session = await loginSession();
      await registerWorker(session, { protocol: 5, maxFetchGb: 30 });
      stubHead(async () => 335_000_000);
      const jobId = (await post(session, BODY)).body.job_id;
      await db().prepare("UPDATE jobs SET status = ? WHERE id = ?").bind(status, jobId).run();

      const res = await post(session, BODY);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ job_id: jobId, reused: true });
    });
  }

  it("uses the VERIFIED manifest entry when the name is already known", async () => {
    // `RealESRGAN_x4plus.pth` is curated with an operator-vouched sha256, so
    // `modelManifest.entries()` signs a zero-holder VERIFIED entry for it --
    // the url in the request is ignored entirely (no allowlist check, no
    // HEAD). Final-review I1: the entry being verified does NOT relax the
    // protocol floor -- a protocol 3/4 agent ignores the `kind` field and
    // would run the `{}` placeholder workflow -- so protocol 5 is needed here
    // too.
    const session = await loginSession();
    await registerWorker(session, { protocol: 5, maxFetchGb: 30 });
    const res = await post(session, {
      name: "RealESRGAN_x4plus.pth",
      directory: "upscale_models",
      url: "https://evil.example/ignored",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const entry = JSON.parse((await jobRow(res.body.job_id)).fetch_entry);
    expect(entry.unverified).not.toBe(true);
    expect(entry.sha256).toHaveLength(64);
    expect(entry.url).not.toBe("https://evil.example/ignored");
  });

  it("never probes HEAD for a curated name, whatever url is asked for", async () => {
    // `ae.safetensors` IS one of the curated models, so even a perfectly
    // allowlisted request url never reaches the signed entry -- and no HEAD
    // is issued at all (the injected probe would blow up if it were).
    const session = await loginSession();
    await registerWorker(session, { protocol: 5, maxFetchGb: 30 });
    stubHead(async () => {
      throw new Error("HEAD must not be probed for a manifest-covered name");
    });
    const res = await post(session, {
      name: "ae.safetensors",
      directory: "vae",
      url: "https://huggingface.co/someone-else/x/resolve/main/ae.safetensors",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);

    const entry = JSON.parse((await jobRow(res.body.job_id)).fetch_entry);
    expect(entry.unverified).not.toBe(true);
    expect(entry.url).toBe(
      "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/ae.safetensors"
    );
  });
});

describe("no_worker message (spec §5.1 row 7)", () => {
  it("names the protocol reason verbatim", async () => {
    // "your agent is too old" has to be tellable apart from "nobody has the
    // disk for it". Final-review I1: at protocol 4 the KIND gate refuses
    // before `verdict` is consulted, so the reason is `model_fetch_protocol:`
    // -- and unlike the entry-keyed one it is also true for a verified entry.
    const session = await loginSession();
    await registerWorker(session, { protocol: 4 });
    stubHead(async () => 335_000_000);

    const res = await post(session, BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("model_fetch.no_worker");
    expect(res.body.message).toContain("model_fetch_protocol:unknown_vae.safetensors");
    expect(res.body.message.startsWith("目前沒有可下載的 worker")).toBe(true);
  });

  it("reports a DIFFERENT reason for a protocol-5 worker with no budget", async () => {
    const session = await loginSession();
    await registerWorker(session, { protocol: 5, maxFetchGb: 0.001, freeDiskGb: 0.01 });
    stubHead(async () => 335_000_000);

    const res = await post(session, BODY);
    expect(res.status).toBe(400);
    expect(res.body.message).not.toContain("missing_models_unverified_protocol");
    expect(res.body.message).not.toContain("model_fetch_protocol:");
    expect(res.body.message).toContain("unknown_vae.safetensors");
  });

  it("stands alone (no dangling colon) when nothing is online", async () => {
    const session = await loginSession();
    await registerWorker(session, { protocol: 5, status: "offline" });
    stubHead(async () => 335_000_000);

    const res = await post(session, BODY);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("model_fetch.no_worker");
    expect(res.body.message.trimEnd().endsWith("：")).toBe(false);
  });
});

describe("GET /comfy/api/comfyfed/model-fetch/{job_id}", () => {
  it("404s for an unknown id and for an ordinary prompt job", async () => {
    const session = await loginSession();
    const prompt = await call("/comfy/api/prompt", {
      json: { prompt: { "1": { class_type: "KSampler", inputs: { seed: 1 } } }, client_id: "panel-test" },
      cookie: session.cookie,
    });
    expect(prompt.status, JSON.stringify(prompt.body)).toBe(200);

    const forPrompt = await call(`/comfy/api/comfyfed/model-fetch/${prompt.body.prompt_id}`, {
      cookie: session.cookie,
    });
    expect(forPrompt.status).toBe(404);
    expect(forPrompt.body.error).toBe("model_fetch.not_found");

    const unknown = await call("/comfy/api/comfyfed/model-fetch/nope", { cookie: session.cookie });
    expect(unknown.status).toBe(404);
  });
});
