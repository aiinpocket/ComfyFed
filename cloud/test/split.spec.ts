import { describe, expect, it } from "vitest";
import * as split from "../src/core/split";

function batchWorkflow(batchSize = 4, extra: Record<string, unknown> = {}): Record<string, any> {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "wuxia", clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: batchSize } },
    "5": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], steps: 20, seed: 424242 },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0] } },
    ...JSON.parse(JSON.stringify(extra)),
  };
}

describe("splitPlan (§3.2 veto conditions)", () => {
  it("accepts a clean batch workflow", () => {
    expect(split.splitPlan(batchWorkflow(4))).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("vetoes batch_size 1", () => expect(split.splitPlan(batchWorkflow(1))).toBeNull());

  it("vetoes a non-literal batch_size", () => {
    const wf = batchWorkflow();
    wf["4"].inputs.batch_size = ["9", 0];
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("vetoes two batch sources", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 2 } };
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("vetoes any other node carrying batch_size", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "KSampler", inputs: { batch_size: 1, latent_image: ["4", 0] } };
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("vetoes a node outside the whitelist", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "SomeCustomNode", inputs: {} };
    expect(split.splitPlan(wf)).toBeNull();
  });

  it.each(["ImageBatch", "LatentBatch", "RepeatLatentBatch", "RebatchLatents"])(
    "vetoes the explicitly named batch node %s",
    (classType) => {
      const wf = batchWorkflow();
      wf["8"] = { class_type: classType, inputs: {} };
      expect(split.splitPlan(wf)).toBeNull();
    }
  );

  it("vetoes a sampler whose latent does not come from the batch source", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "LoadImage", inputs: { image: "x.png" } };
    wf["9"] = { class_type: "VAEEncode", inputs: { pixels: ["8", 0], vae: ["1", 2] } };
    wf["5"].inputs.latent_image = ["9", 0];
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("allows a latent passthrough chain to the batch source", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "LatentUpscale", inputs: { samples: ["4", 0] } };
    wf["5"].inputs.latent_image = ["8", 0];
    expect(split.splitPlan(wf)).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("allows a refiner chain of two samplers", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "KSamplerAdvanced", inputs: { model: ["1", 0], latent_image: ["5", 0], steps: 10 } };
    wf["6"].inputs.samples = ["8", 0];
    expect(split.splitPlan(wf)).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("ignores KSamplerSelect, which has no latent input", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "KSamplerSelect", inputs: { sampler_name: "euler" } };
    expect(split.splitPlan(wf)).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("accepts an integral 4.0 batch_size (JS numbers have no float/int distinction)", () => {
    const wf = batchWorkflow();
    wf["4"].inputs.batch_size = 4.0;
    expect(split.splitPlan(wf)).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("vetoes a sampler wired to a non-zero slot of the batch source", () => {
    const wf = batchWorkflow();
    wf["5"].inputs.latent_image = ["4", 1];
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("vetoes a side branch that reaches an output node without the batch source as ancestor", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "LoadImage", inputs: { image: "x.png" } };
    wf["9"] = { class_type: "VAEEncode", inputs: { pixels: ["8", 0], vae: ["1", 2] } };
    wf["10"] = { class_type: "VAEDecode", inputs: { samples: ["9", 0], vae: ["1", 2] } };
    wf["11"] = { class_type: "SaveImage", inputs: { images: ["10", 0] } };
    expect(split.splitPlan(wf)).toBeNull();
  });

  it("still accepts the standard graph without a side branch", () => {
    expect(split.splitPlan(batchWorkflow())).toEqual({ sourceNodeId: "4", batchSize: 4 });
  });

  it("vetoes when requirements say no", () => {
    expect(split.splitPlan(batchWorkflow(), { split: false })).toBeNull();
    expect(split.splitPlan(batchWorkflow(), { split: true })).not.toBeNull();
    expect(split.splitPlan(batchWorkflow(), {})).not.toBeNull();
  });

  it("vetoes when the platform setting is off", () => {
    expect(split.splitPlan(batchWorkflow(), null, false)).toBeNull();
  });

  it("handles junk workflows without throwing", () => {
    expect(split.splitPlan({})).toBeNull();
    expect(split.splitPlan({ "1": "not an object" as any })).toBeNull();
    expect(split.splitPlan({ "1": { class_type: 7, inputs: {} } as any })).toBeNull();
  });
});

describe("childWorkflow (§3.3)", () => {
  it("inserts LatentFromBatch and rewires consumers", () => {
    const wf = batchWorkflow(4);
    const plan = split.splitPlan(wf)!;
    const child = split.childWorkflow(wf, plan, 2, 2)! as Record<string, any>;

    expect(child["cfsplit"]).toEqual({
      class_type: "LatentFromBatch",
      inputs: { samples: ["4", 0], batch_index: 2, length: 2 },
    });
    expect(child["5"].inputs.latent_image).toEqual(["cfsplit", 0]);
    expect(child["4"].inputs.batch_size).toBe(4);
    expect((wf as any)["5"].inputs.latent_image).toEqual(["4", 0]);
  });

  it("picks a free node id when cfsplit is taken", () => {
    const wf = batchWorkflow();
    wf["cfsplit"] = { class_type: "PreviewImage", inputs: { images: ["6", 0] } };
    const plan = split.splitPlan(wf)!;
    const child = split.childWorkflow(wf, plan, 0, 2)! as Record<string, any>;

    expect(child["cfsplit"].class_type).toBe("PreviewImage");
    expect(child["cfsplit_1"].class_type).toBe("LatentFromBatch");
    expect(child["5"].inputs.latent_image).toEqual(["cfsplit_1", 0]);
  });

  it("rewires every consumer of the source", () => {
    const wf = batchWorkflow();
    wf["8"] = { class_type: "LatentUpscale", inputs: { samples: ["4", 0] } };
    const plan = split.splitPlan(wf)!;
    const child = split.childWorkflow(wf, plan, 1, 1)! as Record<string, any>;

    expect(child["5"].inputs.latent_image).toEqual(["cfsplit", 0]);
    expect(child["8"].inputs.samples).toEqual(["cfsplit", 0]);
  });

  it("returns null when nothing references the source", () => {
    const wf = batchWorkflow();
    expect(split.childWorkflow(wf, { sourceNodeId: "no-such-node", batchSize: 4 }, 0, 2)).toBeNull();
  });
});

describe("partition (§3.3)", () => {
  it("splits evenly when it divides", () => {
    expect(split.partition(4, 2)).toEqual([[0, 2], [2, 2]]);
    expect(split.partition(8, 4)).toEqual([[0, 2], [2, 2], [4, 2], [6, 2]]);
  });

  it("gives the remainder to the first children", () => {
    expect(split.partition(5, 2)).toEqual([[0, 3], [3, 2]]);
    expect(split.partition(7, 3)).toEqual([[0, 3], [3, 2], [5, 2]]);
  });

  it("covers the whole batch exactly once", () => {
    for (let batchSize = 2; batchSize < 20; batchSize++) {
      for (let k = 2; k <= Math.min(batchSize, split.MAX_SPLIT); k++) {
        const ranges = split.partition(batchSize, k);
        expect(ranges).toHaveLength(k);
        expect(ranges[0]![0]).toBe(0);
        const covered: number[] = [];
        for (const [start, length] of ranges) {
          expect(length).toBeGreaterThanOrEqual(1);
          for (let i = start; i < start + length; i++) covered.push(i);
        }
        expect(covered).toEqual([...Array(batchSize).keys()]);
      }
    }
  });

  it("returns the whole batch for k = 1", () => expect(split.partition(4, 1)).toEqual([[0, 4]]));
  it("clamps k to the batch size", () => expect(split.partition(2, 5)).toEqual([[0, 1], [1, 1]]));
});
