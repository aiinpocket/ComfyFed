import { describe, expect, it } from "vitest";
import { modelNodes, verdict, partitionFleetFetchable, fleetWideGaps, type JobNeeds } from "../src/core/assess";
import type { Worker } from "../src/db/queries";

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

// ---------------------------------------------------------------------------
// verdict()'s eligible_after_fetch gates -- ports the highest-value cases
// from tests/server/test_assess.py's fetch-manifest section (`_worker` /
// `_fetch_ready_worker` fixtures).

function makeWorker(id: string, overrides: Partial<Worker> = {}): Worker {
  return {
    id,
    name: id,
    pubkey: "pk",
    status: "online",
    lastSeen: null,
    disabled: false,
    createdAt: "2024-01-01 00:00:00.000000",
    hardware: {},
    dynamic: {},
    backend: "",
    torchVersion: "",
    nodeClasses: [],
    modelInventory: [],
    objectInfoHash: "",
    protocol: 1,
    autoFetch: false,
    peerUrl: null,
    ...overrides,
  };
}

/** A worker opted into manifest-based auto-fetch: protocol 3 + autoFetch --
 * ports `_fetch_ready_worker`. */
function fetchReadyWorker(id: string, overrides: Partial<Worker> = {}): Worker {
  return makeWorker(id, { protocol: 3, autoFetch: true, ...overrides });
}

function needs(models: string[], nodes: string[] = []): JobNeeds {
  return { nodes: new Set(nodes), models: new Set(models), estVramGb: null, assets: new Set() };
}

const GB = 1024 ** 3;

describe("verdict eligible_after_fetch", () => {
  it("is eligible_after_fetch when the manifest can supply a missing model", () => {
    const worker = fetchReadyWorker("w1", {
      nodeClasses: ["CheckpointLoaderSimple"],
      hardware: { vram_gb: 24 },
      dynamic: { free_disk_gb: 100 },
    });
    const v = verdict(worker, needs(["ckpt.safetensors"], ["CheckpointLoaderSimple"]), {}, [worker], {
      "ckpt.safetensors": 4 * GB,
    });
    expect(v.kind).toBe("eligible_after_fetch");
    expect(v.missingModels).toEqual(["ckpt.safetensors"]);
    expect(v.reasons.some((r) => r.startsWith("missing_models:"))).toBe(true);
  });

  it("stays ineligible when fetchableModels is not supplied at all (Task-4 no-op default)", () => {
    const worker = fetchReadyWorker("w1", { hardware: { vram_gb: 24 }, dynamic: { free_disk_gb: 100 } });
    const v = verdict(worker, needs(["ckpt.safetensors"]), {}, [worker]);
    expect(v.kind).toBe("ineligible");
    expect(v.reasons.some((r) => r.startsWith("missing_models_unavailable:"))).toBe(true);
  });

  it("is ineligible when only some missing models are in the manifest", () => {
    const worker = fetchReadyWorker("w1", { dynamic: { free_disk_gb: 100 } });
    const v = verdict(worker, needs(["ckpt.safetensors", "lora.safetensors"]), {}, [worker], {
      "ckpt.safetensors": 1 * GB,
    });
    expect(v.kind).toBe("ineligible");
    expect(v.reasons.some((r) => r.startsWith("missing_models_unavailable:"))).toBe(true);
  });

  it("is ineligible when protocol is below 3", () => {
    const worker = makeWorker("w1", { protocol: 2, autoFetch: true, dynamic: { free_disk_gb: 100 } });
    const v = verdict(worker, needs(["ckpt.safetensors"]), {}, [worker], { "ckpt.safetensors": 1 * GB });
    expect(v.kind).toBe("ineligible");
  });

  it("is ineligible when the worker has not opted into auto_fetch", () => {
    const worker = makeWorker("w1", { protocol: 3, autoFetch: false, dynamic: { free_disk_gb: 100 } });
    const v = verdict(worker, needs(["ckpt.safetensors"]), {}, [worker], { "ckpt.safetensors": 1 * GB });
    expect(v.kind).toBe("ineligible");
  });

  it("is ineligible when the disk margin is insufficient (1.2x, strictly greater)", () => {
    const worker = fetchReadyWorker("w1", { dynamic: { free_disk_gb: 12.0 } });
    const v = verdict(worker, needs(["big.safetensors"]), {}, [worker], { "big.safetensors": 10 * GB });
    expect(v.kind).toBe("ineligible");
  });

  it("is eligible_after_fetch right when the disk margin just clears", () => {
    const worker = fetchReadyWorker("w1", { dynamic: { free_disk_gb: 12.1 } });
    const v = verdict(worker, needs(["big.safetensors"]), {}, [worker], { "big.safetensors": 10 * GB });
    expect(v.kind).toBe("eligible_after_fetch");
  });

  it("is ineligible (refuses, does not warn) when free_disk_gb is unknown", () => {
    const worker = fetchReadyWorker("w1", { dynamic: {} });
    const v = verdict(worker, needs(["ckpt.safetensors"]), {}, [worker], { "ckpt.safetensors": 1 * GB });
    expect(v.kind).toBe("ineligible");
    expect(v.warnings).toEqual([]);
  });

  it("sums disk headroom across every missing model, not a max", () => {
    const tightWorker = fetchReadyWorker("w1", { dynamic: { free_disk_gb: 15.0 } });
    const bothMissing = needs(["big.safetensors", "also_big.safetensors"]);
    const fetchable = { "big.safetensors": 11 * GB, "also_big.safetensors": 9 * GB };
    expect(verdict(tightWorker, bothMissing, {}, [tightWorker], fetchable).kind).toBe("ineligible");

    const roomyWorker = fetchReadyWorker("w2", { dynamic: { free_disk_gb: 25.0 } });
    expect(verdict(roomyWorker, bothMissing, {}, [roomyWorker], fetchable).kind).toBe("eligible_after_fetch");
  });

  it("a warning (e.g. vram_offload) survives an eligible_after_fetch verdict", () => {
    const worker = fetchReadyWorker("w1", {
      hardware: { vram_gb: 8, ram_gb: 32 },
      dynamic: { free_disk_gb: 100 },
    });
    const jobNeeds: JobNeeds = { ...needs(["ckpt.safetensors"]), estVramGb: 12 };
    const v = verdict(worker, jobNeeds, {}, [worker], { "ckpt.safetensors": 1 * GB });
    expect(v.kind).toBe("eligible_after_fetch");
    expect(v.warnings.some((w) => w.startsWith("vram_offload:"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// partitionFleetFetchable -- the submission-relaxation combined gate.

describe("partitionFleetFetchable", () => {
  it("returns everything unfetchable when nothing is manifest-covered", () => {
    const [fetchable, unfetchable] = partitionFleetFetchable(new Set(["a.safetensors"]), {}, []);
    expect(fetchable.size).toBe(0);
    expect(unfetchable).toEqual(new Set(["a.safetensors"]));
  });

  it("splits fetchable/unfetchable when one online worker can fetch the whole manifest-covered subset", () => {
    const worker = fetchReadyWorker("w1", { dynamic: { free_disk_gb: 100 } });
    const [fetchable, unfetchable] = partitionFleetFetchable(
      new Set(["known.safetensors", "unknown.safetensors"]),
      { "known.safetensors": 1 * GB },
      [worker]
    );
    expect(fetchable).toEqual(new Set(["known.safetensors"]));
    expect(unfetchable).toEqual(new Set(["unknown.safetensors"]));
  });

  it("treats it as a single COMBINED gate: nothing counts as fetchable when no worker clears the whole subset", () => {
    const worker = fetchReadyWorker("w1", { dynamic: { free_disk_gb: 1.0 } }); // not enough for either
    const missing = new Set(["a.safetensors", "b.safetensors"]);
    const [fetchable, unfetchable] = partitionFleetFetchable(
      missing,
      { "a.safetensors": 1 * GB, "b.safetensors": 1 * GB },
      [worker]
    );
    expect(fetchable.size).toBe(0);
    expect(unfetchable).toEqual(missing);
  });

  it("no online opted-in worker -> nothing fetchable", () => {
    const disabledFetchWorker = makeWorker("w1", { protocol: 1, autoFetch: false, dynamic: { free_disk_gb: 100 } });
    const [fetchable, unfetchable] = partitionFleetFetchable(
      new Set(["a.safetensors"]),
      { "a.safetensors": 1 * GB },
      [disabledFetchWorker]
    );
    expect(fetchable.size).toBe(0);
    expect(unfetchable).toEqual(new Set(["a.safetensors"]));
  });
});

// ---------------------------------------------------------------------------
// fleetWideGaps

// ---------------------------------------------------------------------------
// Phase 3.1 P2P: peerOnlyModels requires protocol>=4 (a protocol-3 worker
// can auto-fetch a URL-sourced model fine, but has no way to speak the
// peer-grant/chunk-pull protocol for a peer-only one). Ports the highest-
// value cases from tests/server/test_assess.py's peer-only section.

describe("verdict / partitionFleetFetchable: peerOnlyModels protocol>=4 gate", () => {
  it("a protocol-3 worker is ineligible for a peer-only missing model", () => {
    const worker = fetchReadyWorker("w1", { protocol: 3, dynamic: { free_disk_gb: 100 } }); // protocol 3, not 4
    const v = verdict(
      worker,
      needs(["peer_only.safetensors"]),
      {},
      [worker],
      { "peer_only.safetensors": 1 * GB },
      new Set(["peer_only.safetensors"])
    );
    expect(v.kind).toBe("ineligible");
    // L6 final-review fix: distinguishable from the generic "nowhere in the
    // federation" reason -- this worker's protocol is specifically the
    // blocker, not a genuinely unfetchable model.
    expect(v.reasons.some((r) => r.startsWith("missing_models_peer_protocol:"))).toBe(true);
    expect(v.reasons.some((r) => r.startsWith("missing_models_unavailable:"))).toBe(false);
  });

  it("a protocol-4 worker is eligible_after_fetch for the same peer-only model", () => {
    const worker = fetchReadyWorker("w1", { protocol: 4, dynamic: { free_disk_gb: 100 } });
    const v = verdict(
      worker,
      needs(["peer_only.safetensors"]),
      {},
      [worker],
      { "peer_only.safetensors": 1 * GB },
      new Set(["peer_only.safetensors"])
    );
    expect(v.kind).toBe("eligible_after_fetch");
  });

  it("a URL-sourced model outside peerOnlyModels stays protocol>=3 sufficient", () => {
    const worker = fetchReadyWorker("w1", { protocol: 3, dynamic: { free_disk_gb: 100 } });
    const v = verdict(
      worker,
      needs(["url_sourced.safetensors"]),
      {},
      [worker],
      { "url_sourced.safetensors": 1 * GB },
      new Set(["some_other_peer_only.safetensors"])
    );
    expect(v.kind).toBe("eligible_after_fetch");
  });

  it("undefined peerOnlyModels is identical to the pre-3.1 behavior (protocol>=3 sufficient)", () => {
    const worker = fetchReadyWorker("w1", { protocol: 3, dynamic: { free_disk_gb: 100 } });
    const v = verdict(worker, needs(["ckpt.safetensors"]), {}, [worker], { "ckpt.safetensors": 1 * GB });
    expect(v.kind).toBe("eligible_after_fetch");
  });

  it("partitionFleetFetchable: no protocol>=4 worker online -> the peer-only-covered subset is unfetchable", () => {
    const worker = fetchReadyWorker("w1", { protocol: 3, dynamic: { free_disk_gb: 100 } });
    const [fetchable, unfetchable] = partitionFleetFetchable(
      new Set(["peer_only.safetensors"]),
      { "peer_only.safetensors": 1 * GB },
      [worker],
      new Set(["peer_only.safetensors"])
    );
    expect(fetchable.size).toBe(0);
    expect(unfetchable).toEqual(new Set(["peer_only.safetensors"]));
  });

  it("partitionFleetFetchable: a protocol>=4 online worker makes the peer-only-covered subset fetchable", () => {
    const worker = fetchReadyWorker("w1", { protocol: 4, dynamic: { free_disk_gb: 100 } });
    const [fetchable, unfetchable] = partitionFleetFetchable(
      new Set(["peer_only.safetensors"]),
      { "peer_only.safetensors": 1 * GB },
      [worker],
      new Set(["peer_only.safetensors"])
    );
    expect(fetchable).toEqual(new Set(["peer_only.safetensors"]));
    expect(unfetchable.size).toBe(0);
  });
});

describe("fleetWideGaps", () => {
  it("returns empty sets with zero workers (queue-and-wait, not a dead end)", () => {
    const [missingModels, missingNodes] = fleetWideGaps(needs(["a.safetensors"], ["Foo"]), []);
    expect(missingModels.size).toBe(0);
    expect(missingNodes.size).toBe(0);
  });

  it("a model present on ANY worker (online or not) is not fleet-wide missing", () => {
    const hasIt = makeWorker("w1", { modelInventory: [{ name: "diffusion_models/a.safetensors", size: 1 }] });
    const doesNot = makeWorker("w2");
    const [missingModels] = fleetWideGaps(needs(["a.safetensors"]), [hasIt, doesNot]);
    expect(missingModels.size).toBe(0);
  });

  it("an empty node_classes worker is 'unknown', not 'supports nothing'", () => {
    const unknown = makeWorker("w1", { nodeClasses: [] });
    const [, missingNodes] = fleetWideGaps(needs([], ["SomeNode"]), [unknown]);
    expect(missingNodes.size).toBe(0);
  });
});
