/**
 * `core/label.ts` 的純函式 —— 與原 Python 測試套件的
 * `test_normalize_label_*` / `test_derive_label_*` / `test_artifact_kind_*`
 * 同一組案例逐條對照（2026-09-20 檔案頁 §2）。
 *
 * 這一檔刻意不碰 Worker、D1 或 R2：`deriveLabel` 是兩個 stack 之間唯一必須
 * 逐字一致的邏輯，同一張 workflow 在自架與雲端送出必須得到同一個資料夾名稱，
 * 所以它值得一組能直接對著 Python 案例讀的測試。
 */

import { describe, expect, it } from "vitest";
import { LABEL_MAX_CHARS, artifactKind, deriveLabel, normalizeLabel } from "../src/core/label";

const SIMPLE_WORKFLOW: Record<string, unknown> = {
  "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd15.safetensors" } },
};

/** SIMPLE_WORKFLOW 加上一個 Save 節點（`deriveLabel` 的來源）—— 對應 Python
 * 測試裡的 `_save_workflow`。`prefix === undefined` = 完全不放這個 input。 */
function saveWorkflow(prefix: unknown, classType = "SaveImage", nodeId = "9"): Record<string, unknown> {
  const inputs: Record<string, unknown> = { images: ["1", 0] };
  if (prefix !== undefined) inputs["filename_prefix"] = prefix;
  return { ...SIMPLE_WORKFLOW, [nodeId]: { class_type: classType, inputs } };
}

describe("normalizeLabel", () => {
  it("trims, truncates, and nulls anything empty or non-string", () => {
    expect(normalizeLabel("  chroma  ")).toBe("chroma");
    expect(normalizeLabel("")).toBeNull();
    expect(normalizeLabel("   ")).toBeNull();
    expect(normalizeLabel(null)).toBeNull();
    expect(normalizeLabel(undefined)).toBeNull();
    expect(normalizeLabel(123)).toBeNull();
    expect(normalizeLabel(["a"])).toBeNull();
    expect(normalizeLabel("x".repeat(100))).toBe("x".repeat(LABEL_MAX_CHARS));
  });
});

describe("deriveLabel", () => {
  it("takes the last segment of filename_prefix", () => {
    expect(deriveLabel(saveWorkflow("sub/dir/name "))).toBe("name");
    expect(deriveLabel(saveWorkflow("win\\dir\\shot"))).toBe("shot");
    expect(deriveLabel(saveWorkflow("plain/"))).toBe("plain");
    expect(deriveLabel(saveWorkflow("bare"))).toBe("bare");
  });

  it("is null without a usable Save node", () => {
    expect(deriveLabel(SIMPLE_WORKFLOW)).toBeNull();
    expect(deriveLabel({})).toBeNull();
    expect(deriveLabel("not a dict")).toBeNull();
    expect(deriveLabel(null)).toBeNull();
    expect(deriveLabel([{ class_type: "SaveImage", inputs: { filename_prefix: "x" } }])).toBeNull();
    // 非 Save 開頭的節點不算，即使它有 filename_prefix。
    expect(deriveLabel(saveWorkflow("nope", "PreviewImage"))).toBeNull();
    // `filename_prefix` 全是分隔符 -> 末段是空字串 -> 不算。
    expect(deriveLabel(saveWorkflow("///"))).toBeNull();
    expect(deriveLabel(saveWorkflow("   "))).toBeNull();
  });

  it("skips non-string and missing prefixes but keeps looking", () => {
    expect(deriveLabel(saveWorkflow(undefined))).toBeNull();
    const workflow = saveWorkflow(["9", 0]);
    expect(deriveLabel(workflow)).toBeNull();
    // 非 string prefix 的 Save 節點被跳過，後面那個仍然算數。
    workflow["10"] = { class_type: "SaveImage", inputs: { filename_prefix: "later" } };
    expect(deriveLabel(workflow)).toBe("later");
  });

  it("walks nodes in node-id string order", () => {
    const workflow: Record<string, unknown> = {
      "2": { class_type: "SaveImage", inputs: { filename_prefix: "second" } },
      "10": { class_type: "SaveAnimatedWEBP", inputs: { filename_prefix: "ten" } },
      "1": { class_type: "SaveImage", inputs: { filename_prefix: "first" } },
    };
    // 字串排序："1" < "10" < "2"，而不是插入序，也不是數值序。
    expect(deriveLabel(workflow)).toBe("first");
    delete workflow["1"];
    expect(deriveLabel(workflow)).toBe("ten");
  });

  it("cuts at 64 chars", () => {
    expect(deriveLabel(saveWorkflow("y".repeat(200)))).toBe("y".repeat(64));
  });
});

describe("artifactKind", () => {
  it("maps extensions case-insensitively and falls back to other", () => {
    expect(artifactKind("a.PNG")).toBe("image");
    expect(artifactKind("a.jpeg")).toBe("image");
    expect(artifactKind("a.webp")).toBe("image");
    expect(artifactKind("a.gif")).toBe("image");
    expect(artifactKind("a.webm")).toBe("video");
    expect(artifactKind("a.mp4")).toBe("video");
    expect(artifactKind("a.mov")).toBe("video");
    expect(artifactKind("a.txt")).toBe("other");
    expect(artifactKind("noext")).toBe("other");
    expect(artifactKind("trailing.")).toBe("other");
    expect(artifactKind(123)).toBe("other");
    // `Object.prototype` 上的名字不是副檔名（cloud-only 的防線，Python 的
    // dict `.get` 本來就沒有這個問題）。
    expect(artifactKind("a.constructor")).toBe("other");
    expect(artifactKind("a.toString")).toBe("other");
  });
});
