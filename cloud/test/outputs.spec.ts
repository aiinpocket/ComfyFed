import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { jobOutputs, FALLBACK_OUTPUT_KEY, clearTextArtifactCacheForTests } from "../src/core/outputs";

// Ports the `job_outputs` slice of the original Python suite -- shared
// module (see outputs.ts's docstring) that both do/hub.ts's panel `job_done`
// relay and Task 9's `/api/jobs` history surface consume, so it's tested
// directly here rather than only indirectly through hub.spec.ts's WS tests.

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

function job(overrides: { id?: string; workflowJson?: string; resultFiles?: unknown[] }) {
  return {
    id: overrides.id ?? "job-1",
    workflowJson: overrides.workflowJson ?? "{}",
    resultFiles: overrides.resultFiles ?? [],
  };
}

describe("jobOutputs", () => {
  it("is empty for a job with no result files", async () => {
    const out = await jobOutputs(job({ resultFiles: [] }), store());
    expect(out).toEqual({});
  });

  it("keys media files under the first media output node id, sorted lexically (string sort, matching Python's sorted())", async () => {
    const workflow = { "10": { class_type: "SaveImage" }, "2": { class_type: "SaveImage" } };
    const out = await jobOutputs(
      job({ id: "j1", workflowJson: JSON.stringify(workflow), resultFiles: ["a.png", "b.png"] }),
      store()
    );
    // "10" sorts before "2" lexically -- same as Python's `sorted(["10", "2"])`.
    expect(out).toEqual({
      "10": {
        images: [
          { filename: "a.png", subfolder: "j1", type: "output" },
          { filename: "b.png", subfolder: "j1", type: "output" },
        ],
      },
    });
  });

  it("falls back to FALLBACK_OUTPUT_KEY for media with no recognised output node", async () => {
    const out = await jobOutputs(job({ id: "j2", resultFiles: ["a.png"] }), store());
    expect(out).toEqual({
      [FALLBACK_OUTPUT_KEY]: { images: [{ filename: "a.png", subfolder: "j2", type: "output" }] },
    });
  });

  it("never keys media under a SaveText node id even if it's the only output node", async () => {
    const workflow = { "3": { class_type: "SaveText" } };
    const out = await jobOutputs(
      job({ id: "j3", workflowJson: JSON.stringify(workflow), resultFiles: ["a.png"] }),
      store()
    );
    // Media has no MEDIA_OUTPUT_NODE_CLASSES id here (SaveText doesn't
    // count), so it falls back -- and SaveText's own text/files entry is
    // separate (no text files in this fixture, so no SaveText entry at all).
    expect(out).toEqual({
      [FALLBACK_OUTPUT_KEY]: { images: [{ filename: "a.png", subfolder: "j3", type: "output" }] },
    });
  });

  it("reads a .txt artifact from R2, keyed under the SaveText node id, with files+text", async () => {
    clearTextArtifactCacheForTests();
    const workflow = { "7": { class_type: "SaveText" } };
    await store().put("artifacts/j4/note.txt", "hello world");
    const out = await jobOutputs(
      job({ id: "j4", workflowJson: JSON.stringify(workflow), resultFiles: ["note.txt"] }),
      store()
    );
    expect(out).toEqual({
      "7": {
        files: [{ filename: "note.txt", subfolder: "j4", type: "output" }],
        text: ["hello world"],
      },
    });
  });

  it("duplicates SaveText's text onto every PreviewAny node id", async () => {
    clearTextArtifactCacheForTests();
    const workflow = {
      "7": { class_type: "SaveText" },
      "8": { class_type: "PreviewAny" },
      "9": { class_type: "PreviewAny" },
    };
    await store().put("artifacts/j5/note.txt", "hi");
    const out = await jobOutputs(
      job({ id: "j5", workflowJson: JSON.stringify(workflow), resultFiles: ["note.txt"] }),
      store()
    );
    expect(out["8"]).toEqual({ text: ["hi"] });
    expect(out["9"]).toEqual({ text: ["hi"] });
  });

  it("degrades to a files-only entry (no text field) when the R2 object is missing", async () => {
    clearTextArtifactCacheForTests();
    const workflow = { "7": { class_type: "SaveText" } };
    // Deliberately no store().put -- the object doesn't exist.
    const out = await jobOutputs(
      job({ id: "j6", workflowJson: JSON.stringify(workflow), resultFiles: ["missing.txt"] }),
      store()
    );
    expect(out).toEqual({
      "7": { files: [{ filename: "missing.txt", subfolder: "j6", type: "output" }] },
    });
    expect(out["7"]!.text).toBeUndefined();
  });

  it("merges media and text under FALLBACK_OUTPUT_KEY when a workflow has neither node type", async () => {
    clearTextArtifactCacheForTests();
    await store().put("artifacts/j7/note.txt", "hi");
    const out = await jobOutputs(job({ id: "j7", resultFiles: ["a.png", "note.txt"] }), store());
    expect(out[FALLBACK_OUTPUT_KEY]).toEqual({
      images: [{ filename: "a.png", subfolder: "j7", type: "output" }],
      files: [{ filename: "note.txt", subfolder: "j7", type: "output" }],
      text: ["hi"],
    });
  });

  it("caps a text artifact read at 100KB", async () => {
    clearTextArtifactCacheForTests();
    const big = "x".repeat(150_000);
    await store().put("artifacts/j8/note.txt", big);
    const workflow = { "7": { class_type: "SaveText" } };
    const out = await jobOutputs(
      job({ id: "j8", workflowJson: JSON.stringify(workflow), resultFiles: ["note.txt"] }),
      store()
    );
    expect((out["7"]!.text![0] as string).length).toBe(100_000);
  });

  it("gives only the first SaveText node (sorted) a payload when a workflow has two", async () => {
    clearTextArtifactCacheForTests();
    const workflow = { "9": { class_type: "SaveText" }, "3": { class_type: "SaveText" } };
    await store().put("artifacts/j9/note.txt", "hi");
    const out = await jobOutputs(
      job({ id: "j9", workflowJson: JSON.stringify(workflow), resultFiles: ["note.txt"] }),
      store()
    );
    expect(out["3"]).toBeDefined();
    expect(out["9"]).toBeUndefined();
  });

  it("evicts the oldest entry once the cache exceeds 128 distinct keys (LRU), forcing a re-read from R2 (review round 1, m2)", async () => {
    clearTextArtifactCacheForTests();
    const real = store();
    let reads = 0;
    // Read-counting wrapper around the real R2 binding -- `jobOutputs` only
    // ever calls `.get()` on the store it's given, so that's the only
    // method this needs to intercept.
    const countingStore = { get: (key: string) => (reads++, real.get(key)) } as unknown as R2Bucket;
    const workflow = { "7": { class_type: "SaveText" } };

    // Seed 129 distinct artifacts (cap is 128) -- filling the cache past its
    // cap evicts the very FIRST one inserted (`job-lru-0`), FIFO, matching
    // Python's `OrderedDict.popitem(last=False)`.
    for (let i = 0; i < 129; i++) {
      const jobId = `job-lru-${i}`;
      await real.put(`artifacts/${jobId}/note.txt`, `content-${i}`);
      await jobOutputs(
        job({ id: jobId, workflowJson: JSON.stringify(workflow), resultFiles: ["note.txt"] }),
        countingStore
      );
    }
    expect(reads).toBe(129);

    // The evicted entry (job-lru-0) must hit R2 again on re-read.
    await jobOutputs(
      job({ id: "job-lru-0", workflowJson: JSON.stringify(workflow), resultFiles: ["note.txt"] }),
      countingStore
    );
    expect(reads).toBe(130);

    // A still-cached entry (job-lru-128, the most recently inserted) must
    // NOT hit R2 again.
    await jobOutputs(
      job({ id: "job-lru-128", workflowJson: JSON.stringify(workflow), resultFiles: ["note.txt"] }),
      countingStore
    );
    expect(reads).toBe(130);
  });
});
