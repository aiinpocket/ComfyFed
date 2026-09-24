import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as modelGuide from "../src/core/model_guide";

// Ports the highest-value cases from the original Python suite. R2-backed
// `harvest()` replaces Python's local-disk `official_templates.official_dir` scan (see
// model_guide.ts's docstring for the documented key-layout assumption).

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

beforeEach(async () => {
  modelGuide.clearHarvestCacheForTests();
  // R2 storage is shared across every test in this file (unlike D1, which
  // vitest-pool-workers isolates per test file) -- clear any
  // `official_templates/` object a previous test seeded so `harvest()`
  // starts from a clean slate each time.
  const listed = await store().list({ prefix: "official_templates/" });
  await Promise.all(listed.objects.map((o) => store().delete(o.key)));
});

async function seedTemplate(name: string, json: unknown): Promise<void> {
  await store().put(`official_templates/${name}.json`, JSON.stringify(json));
}

describe("SOURCES (curated registry)", () => {
  it("has exactly twelve entries, all resolvable via lookup()", async () => {
    const names = Object.keys(modelGuide.SOURCES);
    expect(names).toHaveLength(12);
    for (const name of names) {
      const found = await modelGuide.lookup(name, store());
      expect(found).not.toBeNull();
      expect(found!.officialUrl).toBe(modelGuide.SOURCES[name]!.officialUrl);
      expect(found!.directory).toBe(modelGuide.SOURCES[name]!.directory);
    }
  });

  it("flux1-dev.safetensors fields match the Python registry verbatim", () => {
    const source = modelGuide.SOURCES["flux1-dev.safetensors"]!;
    expect(source.directory).toBe("diffusion_models");
    expect(source.sizeGb).toBe(22.17);
    expect(source.officialPage).toBe("https://huggingface.co/black-forest-labs/FLUX.1-dev");
    expect(source.officialUrl).toBe(
      "https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors"
    );
    expect(source.backupUrl).toBe(
      "https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors"
    );
    expect(source.gated).toBe(true);
    // Phase 3.2: operator-vouched guide hash, copied verbatim from the plan's
    // curated hash table.
    expect(source.sha256).toBe("4610115bb0c89560703c892c59ac2742fa821e60ef5871b33493ba544683abd7");
    expect(source.sizeBytes).toBe(23802932552);
  });

  it("Phase 3.2: every one of the twelve curated entries carries a guide sha256/sizeBytes", () => {
    for (const [name, source] of Object.entries(modelGuide.SOURCES)) {
      expect(source.sha256, `${name} sha256`).toBeDefined();
      expect(source.sizeBytes, `${name} sizeBytes`).toBeDefined();
      expect(source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("qwen3vl_4b_bf16.safetensors fields (entry #10) match verbatim", () => {
    const source = modelGuide.SOURCES["qwen3vl_4b_bf16.safetensors"]!;
    expect(source.directory).toBe("text_encoders");
    expect(source.sizeGb).toBe(8.27);
    expect(source.officialUrl).toBe(
      "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/qwen3vl_4b_bf16.safetensors"
    );
    expect(source.gated).toBe(false);
  });

  it("qwen3-vl-4b-heretic.safetensors fields (entry #12) match verbatim", () => {
    const source = modelGuide.SOURCES["qwen3-vl-4b-heretic.safetensors"]!;
    expect(source.directory).toBe("text_encoders");
    expect(source.sizeGb).toBe(8.27);
    expect(source.officialPage).toBe("https://huggingface.co/DreamFast/Qwen3-VL-4b-Heretic-ComfyUI");
    expect(source.officialUrl).toBe(
      "https://huggingface.co/DreamFast/Qwen3-VL-4b-Heretic-ComfyUI/resolve/main/qwen3-vl-4b-heretic.safetensors"
    );
    // The one curated entry with no GCS mirror -- see the Python twin.
    expect(source.backupUrl).toBeNull();
    expect(source.gated).toBe(false);
    expect(source.sha256).toBe("3fba9f5a2059c719da105bcb510b9df0450bddde52d96968c607802c9d86f9ce");
    expect(source.sizeBytes).toBe(8875713408);
  });

  it("RealESRGAN_x4plus.pth fields (entry #11) match verbatim", () => {
    const source = modelGuide.SOURCES["RealESRGAN_x4plus.pth"]!;
    expect(source.directory).toBe("upscale_models");
    expect(source.sizeGb).toBe(0.06);
    expect(source.officialUrl).toBe(
      "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"
    );
    expect(source.gated).toBe(false);
  });

  it("resolves a category-relative name to the same curated entry as the bare name", async () => {
    expect(await modelGuide.lookup("clip_l.safetensors", store())).not.toBeNull();
    const found = await modelGuide.lookup("text_encoders/clip_l.safetensors", store());
    expect(found).not.toBeNull();
    expect(found!.directory).toBe("text_encoders");
  });

  it("returns null for an unknown model", async () => {
    expect(await modelGuide.lookup("totally_unknown_model.safetensors", store())).toBeNull();
  });
});

describe("harvest()", () => {
  it("reads per-node properties.models", async () => {
    await seedTemplate("some_template", {
      nodes: [
        { id: 1, type: "Note", properties: {} },
        {
          id: 2,
          type: "UNETLoader",
          properties: {
            models: [{ name: "harvested_model.safetensors", url: "https://example.com/harvested_model.safetensors", directory: "checkpoints" }],
          },
        },
      ],
    });
    const harvested = await modelGuide.harvest(store());
    expect(harvested["harvested_model.safetensors"]).toEqual({
      url: "https://example.com/harvested_model.safetensors",
      directory: "checkpoints",
    });
  });

  it("also reads a top-level models list", async () => {
    await seedTemplate("legacy_template", {
      nodes: [],
      models: [{ name: "legacy_model.safetensors", url: "https://example.com/legacy_model.safetensors", directory: "loras" }],
    });
    const harvested = await modelGuide.harvest(store());
    expect(harvested["legacy_model.safetensors"]).toEqual({
      url: "https://example.com/legacy_model.safetensors",
      directory: "loras",
    });
  });

  it("reads subgraph definitions (definitions.subgraphs[].nodes[].properties.models)", async () => {
    await seedTemplate("z_image", {
      id: "z_image",
      nodes: [],
      definitions: {
        subgraphs: [
          {
            id: "sg-1",
            nodes: [
              {
                id: 62,
                type: "CLIPLoader",
                properties: {
                  models: [{ name: "qwen_3_4b.safetensors", url: "https://example.com/qwen_3_4b.safetensors", directory: "text_encoders" }],
                },
              },
            ],
          },
        ],
      },
    });
    const harvested = await modelGuide.harvest(store());
    expect(harvested["qwen_3_4b.safetensors"]).toEqual({
      url: "https://example.com/qwen_3_4b.safetensors",
      directory: "text_encoders",
    });
  });

  it("gathers models from several nodes, ignoring non-list/absent properties.models", async () => {
    await seedTemplate("multi", {
      nodes: [
        { id: 1, properties: { models: [{ name: "a.safetensors", url: "https://e/a", directory: "vae" }] } },
        { id: 2, properties: { models: "not-a-list" } },
        { id: 3, properties: null },
        { id: 4, properties: { models: [{ name: "b.safetensors", url: "https://e/b", directory: "loras" }] } },
      ],
    });
    const harvested = await modelGuide.harvest(store());
    expect(Object.keys(harvested).sort()).toEqual(["a.safetensors", "b.safetensors"]);
  });

  it("ignores index*.json and manifest.json", async () => {
    await store().put("official_templates/index.json", JSON.stringify([{ title: "cat" }]));
    await store().put("official_templates/manifest.json", JSON.stringify({ meta_version: "1.0" }));
    expect(await modelGuide.harvest(store())).toEqual({});
  });

  it("is empty when nothing has been seeded", async () => {
    expect(await modelGuide.harvest(store())).toEqual({});
  });

  it("lookup falls back to a harvested entry with no size/backup/gated", async () => {
    await seedTemplate("another_template", {
      nodes: [{ id: 1, properties: { models: [{ name: "harvested_only.safetensors", url: "https://example.com/harvested_only.safetensors", directory: "loras" }] } }],
    });
    const found = await modelGuide.lookup("harvested_only.safetensors", store());
    expect(found).not.toBeNull();
    expect(found!.officialUrl).toBe("https://example.com/harvested_only.safetensors");
    expect(found!.directory).toBe("loras");
    expect(found!.sizeGb).toBeNull();
    expect(found!.backupUrl).toBeNull();
    expect(found!.gated).toBe(false);
  });

  it("curated takes priority over a colliding harvested entry", async () => {
    await seedTemplate("collides", {
      nodes: [{ id: 1, properties: { models: [{ name: "flux1-dev.safetensors", url: "https://not-the-real-one.example/flux1-dev.safetensors", directory: "somewhere_else" }] } }],
    });
    const found = await modelGuide.lookup("flux1-dev.safetensors", store());
    expect(found!.directory).toBe("diffusion_models");
    expect(found!.officialUrl).toBe(modelGuide.SOURCES["flux1-dev.safetensors"]!.officialUrl);
  });
});

describe("guidanceMessage / guidanceSummary / missingNodesNote", () => {
  it("renders the exact zh-TW message for curated (gated), harvested, and unknown models -- byte parity with test_model_guide.py", async () => {
    await seedTemplate("with_harvested", {
      nodes: [{ id: 1, properties: { models: [{ name: "harvested_model.safetensors", url: "https://example.com/harvested_model.safetensors", directory: "checkpoints" }] } }],
    });

    const message = await modelGuide.guidanceMessage(
      ["flux1-dev.safetensors", "harvested_model.safetensors", "totally_unknown_model.safetensors"],
      store()
    );

    const expected =
      "無法執行：聯邦裡所有已註冊的 worker 都缺少以下模型（含目前離線的）。" +
      "請在 worker 主機下載後放到指定資料夾，worker 會在 10 分鐘內自動掃描並回報，不需重啟。" +
      "\n\n" +
      "【flux1-dev.safetensors】(22.17 GB)\n" +
      "放置路徑：models/diffusion_models/\n" +
      "官方載點：https://huggingface.co/black-forest-labs/FLUX.1-dev/resolve/main/flux1-dev.safetensors" +
      "（需登入 HuggingFace 並同意 FLUX.1-dev 授權）\n" +
      "備份載點：https://storage.googleapis.com/comfyfed-models/models/diffusion_models/flux1-dev.safetensors" +
      "\n\n" +
      "【harvested_model.safetensors】\n" +
      "放置路徑：models/checkpoints/\n" +
      "官方載點：https://example.com/harvested_model.safetensors" +
      "\n\n" +
      "【totally_unknown_model.safetensors】\n" +
      "放置路徑：models/<資料夾依節點類型>/\n" +
      "官方載點：請向工作流提供者取得下載來源";

    expect(message).toBe(expected);
  });

  it("never mentions the old mirror domain", async () => {
    const message = await modelGuide.guidanceMessage(
      ["flux1-dev.safetensors", "clip_l.safetensors", "unknown.safetensors"],
      store()
    );
    // Literal split so a repo-wide decommissioned-domain guard test
    // doesn't trip on this assertion.
    expect(message).not.toContain(["models", "aiinpocket", "com"].join("."));
  });

  it("guidanceSummary is one short line, singular and plural", () => {
    const one = modelGuide.guidanceSummary(["flux1-dev.safetensors"]);
    expect(one).toBe("缺少模型：flux1-dev.safetensors，無法執行——詳見下方下載指引");

    const several = modelGuide.guidanceSummary(["ae.safetensors", "flux1-dev.safetensors", "clip_l.safetensors"]);
    expect(several).toBe("缺少模型：ae.safetensors 等 3 項，無法執行——詳見下方下載指引");

    expect(one).not.toContain("\n");
    expect(several).not.toContain("\n");
  });

  it("missingNodesNote names every missing node class", () => {
    const note = modelGuide.missingNodesNote(["FooLoader", "BarSampler"]);
    expect(note).toBe("另外，所有 worker 也都缺少節點：FooLoader、BarSampler——需在 worker 端安裝對應 custom node。");
  });
});
