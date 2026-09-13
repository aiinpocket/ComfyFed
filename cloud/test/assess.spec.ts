import { describe, expect, it } from "vitest";
import { modelNodes } from "../src/core/assess";

// Ports the `model_nodes` cases from tests/server/test_assess.py -- `extract`/
// `estimateVram`/`verdict`/`findModel`/`matchesModelName` are already
// exercised indirectly via jobs.spec.ts/dispatch.spec.ts (Task 3/8); this
// file covers `modelNodes`, added in this task for `/comfy/api/prompt`'s
// per-node missing-model `node_errors`.

describe("modelNodes", () => {
  it("maps each model to its single referencing node", () => {
    const workflow = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" } },
      "2": { class_type: "LoraLoader", inputs: { lora_name: "my_style.safetensors" } },
    };
    const mapping = modelNodes(workflow);
    expect(mapping.get("sd_xl_base.safetensors")).toEqual([["1", "CheckpointLoaderSimple"]]);
    expect(mapping.get("my_style.safetensors")).toEqual([["2", "LoraLoader"]]);
  });

  it("lists every node referencing the same model", () => {
    const workflow = {
      "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "shared.safetensors" } },
      "2": { class_type: "UNETLoader", inputs: { unet_name: "shared.safetensors" } },
    };
    const mapping = modelNodes(workflow);
    expect(mapping.get("shared.safetensors")).toEqual([
      ["1", "CheckpointLoaderSimple"],
      ["2", "UNETLoader"],
    ]);
  });

  it("lists every model referenced by the same node", () => {
    const workflow = {
      "1": {
        class_type: "DualCLIPLoader",
        inputs: { clip_name1: "clip_l.safetensors", clip_name2: "t5xxl_fp16.safetensors" },
      },
    };
    const mapping = modelNodes(workflow);
    expect(mapping.get("clip_l.safetensors")).toEqual([["1", "DualCLIPLoader"]]);
    expect(mapping.get("t5xxl_fp16.safetensors")).toEqual([["1", "DualCLIPLoader"]]);
  });

  it("is empty for an empty workflow", () => {
    expect(modelNodes({})).toEqual(new Map());
  });
});
