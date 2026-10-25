import { describe, expect, it } from "vitest";
import { validatePromptInputs } from "../src/core/validate_prompt";

// The submission-time range guard (see validate_prompt.ts's docstring). The
// fixture mirrors the real TextGenerate def that the 2026-10-25 scramble
// slipped past: a COMFY_DYNAMICCOMBO_V3 whose "on" option declares the
// sampling ranges.

const TEXT_GENERATE_DEF = {
  input: {
    required: {
      clip: ["CLIP", {}],
      prompt: ["STRING", { default: "", multiline: true }],
      max_length: ["INT", { default: 512, min: 1, max: 32768 }],
      sampling_mode: [
        "COMFY_DYNAMICCOMBO_V3",
        {
          display_name: "Sampling Mode",
          options: [
            {
              key: "on",
              inputs: {
                required: {
                  temperature: ["FLOAT", { default: 0.7, min: 0.01, max: 2.0 }],
                  top_k: ["INT", { default: 64, min: 0, max: 1000 }],
                  top_p: ["FLOAT", { default: 0.95, min: 0.0, max: 1.0 }],
                  min_p: ["FLOAT", { default: 0.05, min: 0.0, max: 1.0 }],
                  repetition_penalty: ["FLOAT", { default: 1.05, min: 0.0, max: 5.0 }],
                  seed: ["INT", { default: 0, min: 0, max: 18446744073709551615 }],
                },
                optional: {
                  presence_penalty: ["FLOAT", { default: 0.0, min: 0.0, max: 5.0 }],
                },
              },
            },
            { key: "off", inputs: { required: {} } },
          ],
        },
      ],
    },
    optional: {
      thinking: ["BOOLEAN", { default: false }],
    },
  },
};

// SaveVideo-style doubly-nested dynamic combo: format -> codec -> encoding.
const SAVE_VIDEO_DEF = {
  input: {
    required: {
      format: [
        "COMFY_DYNAMICCOMBO_V3",
        {
          options: [
            {
              key: "mp4",
              inputs: {
                required: {
                  codec: [
                    "COMFY_DYNAMICCOMBO_V3",
                    {
                      options: [
                        {
                          key: "h264",
                          inputs: { required: { crf: ["INT", { default: 23, min: 0, max: 51 }] } },
                        },
                      ],
                    },
                  ],
                },
              },
            },
          ],
        },
      ],
    },
  },
};

const OBJECT_INFO = { TextGenerate: TEXT_GENERATE_DEF, SaveVideo: SAVE_VIDEO_DEF };

function textGenerateNode(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    "206": {
      class_type: "TextGenerate",
      inputs: {
        clip: ["205", 0],
        prompt: ["204", 0],
        max_length: 400,
        sampling_mode: "on",
        "sampling_mode.temperature": 0.7,
        "sampling_mode.top_k": 64,
        "sampling_mode.top_p": 0.95,
        "sampling_mode.min_p": 0.05,
        "sampling_mode.repetition_penalty": 1.05,
        "sampling_mode.seed": 12345,
        "sampling_mode.presence_penalty": 0,
        ...overrides,
      },
    },
  };
}

describe("validatePromptInputs", () => {
  it("passes a correct prompt", () => {
    expect(validatePromptInputs(textGenerateNode({}), OBJECT_INFO)).toEqual([]);
  });

  it("catches the 2026-10-25 scramble (repetition_penalty got top_k's 64)", () => {
    const violations = validatePromptInputs(
      textGenerateNode({
        "sampling_mode.temperature": 0.05,
        "sampling_mode.top_k": 1.05,
        "sampling_mode.top_p": 0,
        "sampling_mode.min_p": 0.7,
        "sampling_mode.repetition_penalty": 64,
      }),
      OBJECT_INFO
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({
      nodeId: "206",
      classType: "TextGenerate",
      inputName: "sampling_mode.repetition_penalty",
      received: 64,
      max: 5,
    });
  });

  it("checks a plain (non-combo) INT range too", () => {
    const violations = validatePromptInputs(textGenerateNode({ max_length: 0 }), OBJECT_INFO);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.inputName).toBe("max_length");
    expect(violations[0]!.min).toBe(1);
  });

  it("resolves a doubly-nested dynamic combo", () => {
    const prompt = {
      "15": {
        class_type: "SaveVideo",
        inputs: {
          format: "mp4",
          "format.codec": "h264",
          "format.codec.crf": 99,
        },
      },
    };
    const violations = validatePromptInputs(prompt, OBJECT_INFO);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.inputName).toBe("format.codec.crf");
  });

  it("passes sub-inputs when the combo is switched to an option without them", () => {
    // sampling_mode "off": the stale sub-keys may still ride along in the
    // prompt; they are unresolvable under "off" and must not be refused.
    const violations = validatePromptInputs(
      textGenerateNode({ sampling_mode: "off", "sampling_mode.repetition_penalty": 64 }),
      OBJECT_INFO
    );
    expect(violations).toEqual([]);
  });

  it("never refuses what it cannot resolve", () => {
    const prompt = {
      "1": { class_type: "UnknownCustomNode", inputs: { whatever: 1e9 } },
      "2": { class_type: "TextGenerate", inputs: { not_in_spec: 1e9, clip: ["0", 0] } },
      "3": { class_type: "TextGenerate", inputs: { max_length: ["0", 0] } }, // link, not number
      "4": { class_type: "TextGenerate", inputs: { max_length: "9" } }, // string, not number
    };
    expect(validatePromptInputs(prompt, OBJECT_INFO)).toEqual([]);
  });

  it("survives malformed object_info and malformed nodes", () => {
    const prompt = {
      "1": { class_type: "Broken", inputs: { x: 5 } },
      "2": "not-a-node",
      "3": { inputs: { x: 5 } },
    } as Record<string, unknown>;
    const badInfo = { Broken: { input: { required: { x: "not-a-tuple" } } } };
    expect(validatePromptInputs(prompt, badInfo)).toEqual([]);
  });
});
