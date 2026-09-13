import { afterEach, describe, expect, it } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../src/index";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { stripDownloadMetadata, clearTemplatesCacheForTests, OFFICIAL_PREFIX } from "../src/routes/templates";

// Ports the highest-value cases from tests/server/test_templates.py: the
// recursive strip (per-node, top-level, and subgraph shapes -- the exact
// fixture workflows from that file, copied verbatim below rather than as
// separate JSON files, mirroring how test_templates.py itself keeps them as
// inline literals, not fixture files on disk), index merge order/fallback,
// media passthrough, and staging-seed idempotency. Network-touching pieces
// of `scripts/seed-official.mjs` (PyPI fetch, wheel download) are exercised
// by `seed-official.spec.ts` instead, unit-testing only the hash-check /
// RECORD-verify / zip-flattening logic that doesn't need the network.

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function loginSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

async function putOfficialJson(filename: string, value: unknown): Promise<void> {
  await store().put(`${OFFICIAL_PREFIX}${filename}`, JSON.stringify(value));
}

async function putOfficialRaw(filename: string, value: ArrayBuffer | Uint8Array, contentType?: string): Promise<void> {
  await store().put(`${OFFICIAL_PREFIX}${filename}`, value, contentType ? { httpMetadata: { contentType } } : undefined);
}

async function putPackagedJson(filename: string, value: unknown): Promise<void> {
  await store().put(`comfyfed_templates/${filename}`, JSON.stringify(value));
}

async function putPackagedRaw(filename: string, value: ArrayBuffer | Uint8Array): Promise<void> {
  await store().put(`comfyfed_templates/${filename}`, value);
}

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  clearTemplatesCacheForTests();
  for (const prefix of ["staging/", "official_templates/", "comfyfed_templates/"]) {
    const listed = await store().list({ prefix });
    await Promise.all(listed.objects.map((o) => store().delete(o.key)));
  }
});

// --- Fixture workflows, copied verbatim from tests/server/test_templates.py -

const FLUX_WORKFLOW = {
  id: "flux_dev",
  revision: 0,
  last_node_id: 2,
  nodes: [
    {
      id: 1,
      type: "UNETLoader",
      pos: [0, 0],
      properties: {
        "Node name for S&R": "UNETLoader",
        models: [
          {
            name: "flux1-dev.safetensors",
            url: "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors",
            directory: "diffusion_models",
            hash: "h",
            hash_type: "SHA256",
          },
        ],
      },
      widgets_values: ["flux1-dev.safetensors", "default"],
    },
    {
      id: 2,
      type: "SaveImage",
      pos: [400, 0],
      properties: { "Node name for S&R": "SaveImage" },
      widgets_values: ["ComfyUI"],
    },
  ],
  links: [],
  version: 0.4,
};

const TOP_LEVEL_MODELS_WORKFLOW = {
  version: 0.4,
  nodes: [],
  links: [],
  models: [
    {
      name: "ae.safetensors",
      url: "https://x/y",
      directory: "vae",
      hash: "h",
      hash_type: "SHA256",
    },
  ],
};

const SUBGRAPH_WORKFLOW = {
  id: "z_image",
  revision: 0,
  nodes: [{ id: 1, type: "SaveImage", properties: { "Node name for S&R": "SaveImage" } }],
  links: [],
  definitions: {
    subgraphs: [
      {
        id: "sg-1",
        nodes: [
          {
            id: 62,
            type: "CLIPLoader",
            properties: {
              "Node name for S&R": "CLIPLoader",
              models: [
                {
                  name: "qwen_3_4b.safetensors",
                  url: "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors",
                  directory: "text_encoders",
                },
              ],
            },
            widgets_values: ["qwen_3_4b.safetensors", "lumina2", "default"],
          },
        ],
      },
    ],
  },
  version: 0.4,
};

const FLUX_CATEGORY = {
  moduleName: "default",
  title: "Flux",
  type: "image",
  templates: [{ name: "flux_dev", title: "Flux Dev", description: "", mediaType: "image", mediaSubtype: "webp" }],
};

const COMFYFED_CATEGORY = {
  moduleName: "default",
  title: "ComfyFed",
  isEssential: true,
  category: "ComfyFed",
  type: "image",
  templates: [{ name: "comfyfed-wuxia-t2i", title: "Wuxia", description: "", mediaType: "image", mediaSubtype: "webp" }],
};

// ---------------------------------------------------------------------------

describe("recursive strip parity (stripDownloadMetadata)", () => {
  it("strips per-node properties.models, keeping name+directory", () => {
    const stripped = stripDownloadMetadata(FLUX_WORKFLOW) as any;
    const models = stripped.nodes[0].properties.models;
    expect(models).toEqual([{ name: "flux1-dev.safetensors", directory: "diffusion_models" }]);
    // Nothing else about the node/graph was disturbed.
    expect(stripped.nodes[0].properties["Node name for S&R"]).toBe("UNETLoader");
    expect(stripped.nodes[0].widgets_values).toEqual(["flux1-dev.safetensors", "default"]);
    expect(stripped.nodes[1]).toEqual(FLUX_WORKFLOW.nodes[1]);
    expect(stripped.id).toBe("flux_dev");
    expect(JSON.stringify(stripped)).not.toContain("huggingface.co");
  });

  it("strips a top-level models list as a superset", () => {
    const stripped = stripDownloadMetadata(TOP_LEVEL_MODELS_WORKFLOW) as any;
    expect(stripped.models).toEqual([{ name: "ae.safetensors", directory: "vae" }]);
  });

  it("strips definitions.subgraphs[].nodes[].properties.models", () => {
    const stripped = stripDownloadMetadata(SUBGRAPH_WORKFLOW) as any;
    const loader = stripped.definitions.subgraphs[0].nodes[0];
    expect(loader.properties.models).toEqual([{ name: "qwen_3_4b.safetensors", directory: "text_encoders" }]);
    expect(loader.widgets_values).toEqual(["qwen_3_4b.safetensors", "lumina2", "default"]);
    expect(JSON.stringify(stripped)).not.toContain("huggingface.co");
  });

  it("passes plain-string model names through unchanged (index entries)", () => {
    const value = { models: ["flux1-dev.safetensors", "ae.safetensors"] };
    expect(stripDownloadMetadata(value)).toEqual(value);
  });

  it("leaves an empty models list alone", () => {
    expect(stripDownloadMetadata({ models: [] })).toEqual({ models: [] });
  });
});

// ---------------------------------------------------------------------------

describe("auth gating -- requireAdmin covers every /comfy/templates/* shape (review round 1, m2)", () => {
  // Task 11 added a global `/comfy/*` session gate (src/lib/gate.ts,
  // mirroring app.py's `_comfy_session_gate`) that now runs BEFORE these
  // routes: `/comfy/templates/*` is not under `/comfy/api/*`, so an
  // unauthenticated request is redirected (302) by the gate itself, the
  // same as any other non-API `/comfy` path -- exact parity with Python,
  // where this route sits behind the same middleware. This route's own
  // `requireAdmin` (below) is still real and still exercised once
  // authenticated; it's just no longer the FIRST thing an unauthenticated
  // request hits.
  it("redirects (gate) a media path with no session", async () => {
    // Seeded (unauthenticated) so a 200 would be possible if some gate were
    // missing -- proves the 302 is a real gate, not just a 404.
    await putPackagedRaw("comfyfed-wuxia-t2i-1.webp", new Uint8Array([1, 2, 3]));
    const r = await call("/comfy/templates/comfyfed-wuxia-t2i-1.webp");
    expect(r.status).toBe(302);
  });

  it("redirects (gate) a workflow json path with no session", async () => {
    await putOfficialJson("flux_dev.json", FLUX_WORKFLOW);
    const r = await call("/comfy/templates/flux_dev.json");
    expect(r.status).toBe(302);
  });
});

describe("GET /comfy/templates/index.json", () => {
  it("redirects (gate) with no session", async () => {
    // See the "auth gating" describe block above: Task 11's global gate
    // intercepts this unauthenticated request before requireAdmin does.
    const r = await call("/comfy/templates/index.json");
    expect(r.status).toBe(302);
  });

  it("serves ComfyFed's packaged categories alone when no official index exists", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);

    const r = await call("/comfy/templates/index.json", { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([COMFYFED_CATEGORY]);
  });

  it("merges official categories AFTER ComfyFed's own", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    await putOfficialJson("index.json", [FLUX_CATEGORY]);

    const r = await call("/comfy/templates/index.json", { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([COMFYFED_CATEGORY, FLUX_CATEGORY]);
  });

  it("404s when neither side has an index", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/templates/index.json", { cookie });
    expect(r.status).toBe(404);
  });

  it("re-reads the official index when its R2 etag changes (cache invalidation)", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    await putOfficialJson("index.json", [FLUX_CATEGORY]);

    const first = await call("/comfy/templates/index.json", { cookie });
    expect(first.body).toEqual([COMFYFED_CATEGORY, FLUX_CATEGORY]);

    const updatedCategory = { ...FLUX_CATEGORY, title: "Flux v2" };
    await putOfficialJson("index.json", [updatedCategory]);

    const second = await call("/comfy/templates/index.json", { cookie });
    expect(second.body).toEqual([COMFYFED_CATEGORY, updatedCategory]);
  });

  it("serves the same cached merge when the official index is unchanged", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    await putOfficialJson("index.json", [FLUX_CATEGORY]);

    const first = await call("/comfy/templates/index.json", { cookie });
    const second = await call("/comfy/templates/index.json", { cookie });
    expect(first.body).toEqual(second.body);
    expect(second.body).toEqual([COMFYFED_CATEGORY, FLUX_CATEGORY]);
  });

  it("re-reads a comfyfed_templates R2 override when ITS etag changes, even with the official side untouched (review round 1, m1)", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    await putOfficialJson("index.json", [FLUX_CATEGORY]);

    const first = await call("/comfy/templates/index.json", { cookie });
    expect(first.body).toEqual([COMFYFED_CATEGORY, FLUX_CATEGORY]);

    // An operator overrides ComfyFed's OWN packaged index via the R2
    // fallback -- only the packaged side's etag changes, official is
    // untouched. Serving the stale cached merge here would silently hide
    // the override.
    const overrideCategory = { ...COMFYFED_CATEGORY, title: "ComfyFed v2" };
    await putPackagedJson("index.json", [overrideCategory]);

    const second = await call("/comfy/templates/index.json", { cookie });
    expect(second.body).toEqual([overrideCategory, FLUX_CATEGORY]);
  });
});

describe("GET /comfy/templates/index.<locale>.json", () => {
  it("404s when the official localized index is absent, even if ours exists", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    const r = await call("/comfy/templates/index.zh.json", { cookie });
    expect(r.status).toBe(404);
  });

  it("merges the base packaged index with the official localized index", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    await putOfficialJson("index.zh.json", [FLUX_CATEGORY]);

    const r = await call("/comfy/templates/index.zh.json", { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual([COMFYFED_CATEGORY, FLUX_CATEGORY]);
  });
});

describe("GET /comfy/templates/index_logo.json", () => {
  it("404s with no official copy, even if a packaged one is requested", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/templates/index_logo.json", { cookie });
    expect(r.status).toBe(404);
  });

  it("serves the official logo when present", async () => {
    const { cookie } = await loginSession();
    await putOfficialJson("index_logo.json", { src: "logo.png" });
    const r = await call("/comfy/templates/index_logo.json", { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ src: "logo.png" });
  });
});

describe("GET /comfy/templates/{name}.json -- packaged vs. official resolution", () => {
  it("serves a packaged workflow byte-identically, un-stripped", async () => {
    const { cookie } = await loginSession();
    // ComfyFed's own templates never carry download metadata; verify the
    // packaged path never even runs the strip, using a workflow that WOULD
    // be mangled if it did.
    await putPackagedJson("comfyfed-wuxia-t2i.json", FLUX_WORKFLOW);

    const r = await call("/comfy/templates/comfyfed-wuxia-t2i.json", { cookie });
    expect(r.status).toBe(200);
    expect(r.body).toEqual(FLUX_WORKFLOW);
  });

  it("strips official per-node download metadata", async () => {
    const { cookie } = await loginSession();
    await putOfficialJson("flux_dev.json", FLUX_WORKFLOW);

    const r = await call("/comfy/templates/flux_dev.json", { cookie });
    expect(r.status).toBe(200);
    expect(r.body.nodes[0].properties.models).toEqual([{ name: "flux1-dev.safetensors", directory: "diffusion_models" }]);
    expect(JSON.stringify(r.body)).not.toContain("huggingface.co");
  });

  it("strips official top-level models", async () => {
    const { cookie } = await loginSession();
    await putOfficialJson("legacy_top_level.json", TOP_LEVEL_MODELS_WORKFLOW);
    const r = await call("/comfy/templates/legacy_top_level.json", { cookie });
    expect(r.body.models).toEqual([{ name: "ae.safetensors", directory: "vae" }]);
  });

  it("strips official subgraph-nested models", async () => {
    const { cookie } = await loginSession();
    await putOfficialJson("z_image.json", SUBGRAPH_WORKFLOW);
    const r = await call("/comfy/templates/z_image.json", { cookie });
    const loader = r.body.definitions.subgraphs[0].nodes[0];
    expect(loader.properties.models).toEqual([{ name: "qwen_3_4b.safetensors", directory: "text_encoders" }]);
  });

  it("prefers packaged over official when both exist", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("dupe.json", { source: "packaged" });
    await putOfficialJson("dupe.json", { source: "official" });
    const r = await call("/comfy/templates/dupe.json", { cookie });
    expect(r.body).toEqual({ source: "packaged" });
  });

  it("404s when neither source has the file", async () => {
    const { cookie } = await loginSession();
    const r = await call("/comfy/templates/nope.json", { cookie });
    expect(r.status).toBe(404);
  });

  it("never serves official bookkeeping (manifest.json) as a template", async () => {
    const { cookie } = await loginSession();
    await putOfficialJson("manifest.json", { meta_version: "1.0" });
    const r = await call("/comfy/templates/manifest.json", { cookie });
    expect(r.status).toBe(404);
  });

  it("rejects traversal-shaped filenames with 404, not a filesystem escape", async () => {
    const { cookie } = await loginSession();
    for (const bad of ["..", ".", "..%2Ffoo", "a/b.json", "a\\b.json", "C:x.json"]) {
      const r = await call(`/comfy/templates/${encodeURIComponent(bad)}`, { cookie });
      expect(r.status, bad).toBe(404);
    }
  });
});

describe("media passthrough", () => {
  it("serves a packaged .webp with the right content-type, raw bytes", async () => {
    const { cookie } = await loginSession();
    const bytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
    await putPackagedRaw("comfyfed-wuxia-t2i-1.webp", bytes);

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/comfy/templates/comfyfed-wuxia-t2i-1.webp", { headers: { Cookie: cookie ?? "" } }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("serves an official .mp4 with the right content-type, raw bytes", async () => {
    const { cookie } = await loginSession();
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    await putOfficialRaw("flux_dev-1.mp4", bytes);

    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/comfy/templates/flux_dev-1.mp4", { headers: { Cookie: cookie ?? "" } }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
  });

  it("falls back to application/octet-stream for an unmapped extension", async () => {
    const { cookie } = await loginSession();
    await putPackagedRaw("weird.bin", new Uint8Array([1, 2, 3]));
    const ctx = createExecutionContext();
    const res = await worker.fetch(
      new Request("http://example.com/comfy/templates/weird.bin", { headers: { Cookie: cookie ?? "" } }),
      env as any,
      ctx
    );
    await waitOnExecutionContext(ctx);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
  });
});

describe("staging seed (seed_staging parity)", () => {
  it("copies packaged input assets into R2 staging/ on first request, idempotently", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    await putPackagedRaw("assets/amyntas_ref.png", new Uint8Array([1, 2, 3]));
    await putPackagedRaw("assets/comfyfed_sample_clip.mp4", new Uint8Array([4, 5, 6]));

    const before = await store().head("staging/amyntas_ref.png");
    expect(before).toBeNull();

    await call("/comfy/templates/index.json", { cookie });

    const seeded1 = await store().get("staging/amyntas_ref.png");
    const seeded2 = await store().get("staging/comfyfed_sample_clip.mp4");
    expect(seeded1).not.toBeNull();
    expect(new Uint8Array(await seeded1!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(seeded2).not.toBeNull();

    // An operator-replaced staging file must not be clobbered by a second
    // template request (existing files are left alone -- ports Python's
    // "admin may have replaced it deliberately" rationale).
    await store().put("staging/amyntas_ref.png", new Uint8Array([9, 9, 9]));
    clearTemplatesCacheForTests(); // reset the memoization flag, simulating a fresh isolate
    await call("/comfy/templates/index.json", { cookie });
    const after = await store().get("staging/amyntas_ref.png");
    expect(new Uint8Array(await after!.arrayBuffer())).toEqual(new Uint8Array([9, 9, 9]));
  });

  it("is memoized per isolate -- a second request does not re-check R2 heads needlessly", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    await putPackagedRaw("assets/amyntas_ref.png", new Uint8Array([1]));
    await putPackagedRaw("assets/comfyfed_sample_clip.mp4", new Uint8Array([2]));

    await call("/comfy/templates/index.json", { cookie });
    await store().delete("staging/amyntas_ref.png"); // simulate deletion after the first seed
    await call("/comfy/templates/index.json", { cookie }); // memoized: should NOT re-seed

    const after = await store().head("staging/amyntas_ref.png");
    expect(after).toBeNull();
  });

  it("retries a staging asset on the next request after a transient R2 put failure (review round 1, M1)", async () => {
    const { cookie } = await loginSession();
    await putPackagedJson("index.json", [COMFYFED_CATEGORY]);
    await putPackagedRaw("assets/amyntas_ref.png", new Uint8Array([1, 2, 3]));
    await putPackagedRaw("assets/comfyfed_sample_clip.mp4", new Uint8Array([4, 5, 6]));

    const realPut = store().put.bind(store());
    let failNextAmyntas = true;
    (store() as any).put = (key: string, ...rest: unknown[]) => {
      if (failNextAmyntas && key === "staging/amyntas_ref.png") {
        failNextAmyntas = false;
        throw new Error("simulated transient R2 failure");
      }
      return (realPut as any)(key, ...rest);
    };

    try {
      // First request: the put for amyntas_ref.png throws. It must NOT be
      // memoized as seeded -- the other asset (comfyfed_sample_clip.mp4)
      // still succeeds independently.
      await call("/comfy/templates/index.json", { cookie });
      expect(await store().head("staging/amyntas_ref.png")).toBeNull();
      expect(await store().head("staging/comfyfed_sample_clip.mp4")).not.toBeNull();

      // Second request: the transient failure is over, so this retries and
      // succeeds this time -- proving the earlier all-or-nothing memoization
      // flag (which would have permanently skipped every asset after one
      // failure) is gone.
      await call("/comfy/templates/index.json", { cookie });
      const seeded = await store().get("staging/amyntas_ref.png");
      expect(seeded).not.toBeNull();
      expect(new Uint8Array(await seeded!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    } finally {
      (store() as any).put = realPut;
    }
  });
});
