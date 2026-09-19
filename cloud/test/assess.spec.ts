import { describe, expect, it } from "vitest";
import { modelNodes, verdict, partitionFleetFetchable, fleetWideGaps, type JobNeeds } from "../src/core/assess";
import * as modelGuide from "../src/core/model_guide";
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
    deleted: false,
    peerUrl: null,
    peerLanUrl: null,
    peerNat: "lan",
    peerReachable: null,
    peerCheckedAt: null,
    remoteIp: null,
    speedIndex: 1.0,
    warmModels: [],
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

  it("is ineligible when total missing exceeds the worker's hardware.max_fetch_gb budget", () => {
    // Phase 3.2 F1 fix: a worker whose hello reported max_fetch_gb=5 must not
    // be counted eligible_after_fetch for a 31 GiB curated set even though
    // disk margin easily clears -- it would refuse the download itself
    // (the agent's own max_fetch_gb check) once dispatched.
    const worker = fetchReadyWorker("w1", {
      hardware: { max_fetch_gb: 5 },
      dynamic: { free_disk_gb: 1000.0 },
    });
    const v = verdict(worker, needs(["big.safetensors"]), {}, [worker], { "big.safetensors": 31 * GB });
    expect(v.kind).toBe("ineligible");
  });

  it("is eligible_after_fetch when the worker's max_fetch_gb budget covers it", () => {
    const worker = fetchReadyWorker("w1", {
      hardware: { max_fetch_gb: 100 },
      dynamic: { free_disk_gb: 1000.0 },
    });
    const v = verdict(worker, needs(["big.safetensors"]), {}, [worker], { "big.safetensors": 31 * GB });
    expect(v.kind).toBe("eligible_after_fetch");
  });

  it("defaults a missing hardware.max_fetch_gb to 20, same as the agent's own default", () => {
    const worker = fetchReadyWorker("w1", { hardware: {}, dynamic: { free_disk_gb: 1000.0 } });
    const v = verdict(worker, needs(["big.safetensors"]), {}, [worker], { "big.safetensors": 31 * GB });
    expect(v.kind).toBe("ineligible");
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

  it("Phase 3.2: eligible_after_fetch for a zero-holder curated model", () => {
    // An empty-inventory worker with autoFetch opted in becomes
    // eligible_after_fetch for a curated model that NOT A SINGLE fleet
    // worker holds, as long as the manifest entry it was handed (built from
    // model_guide.SOURCES' operator-vouched sha256/sizeBytes -- see
    // model_manifest.ts's guideHashEntry) is present in fetchableModels.
    // This is the same eligibleAfterFetch gate as always; Phase 3.2 only
    // changes that fetchableModels can now contain a curated model's entry
    // even when zero workers have ever reported it -- confirmed here using
    // the REAL curated sizeBytes from model_guide.SOURCES rather than an
    // arbitrary test fixture size.
    const source = modelGuide.SOURCES["RealESRGAN_x4plus.pth"]!;
    expect(source.sha256).toBeDefined();
    expect(source.sizeBytes).toBeDefined();

    const worker = fetchReadyWorker("w1", {
      nodeClasses: ["UpscaleModelLoader"],
      modelInventory: [], // zero holders anywhere, including this worker
      dynamic: { free_disk_gb: 100.0 },
    });
    const jobNeeds = needs(["RealESRGAN_x4plus.pth"], ["UpscaleModelLoader"]);
    const fetchable = { "RealESRGAN_x4plus.pth": source.sizeBytes! };

    const v = verdict(worker, jobNeeds, {}, [worker], fetchable);
    expect(v.kind).toBe("eligible_after_fetch");
    expect(v.missingModels).toEqual(["RealESRGAN_x4plus.pth"]);
  });
});

// ---------------------------------------------------------------------------
// 2026-09-19 model_fetch: unverified-source entries require protocol>=5.
// Ports tests/server/test_assess.py's three `unverified_models` cases.

describe("unverifiedModels (spec §7)", () => {
  it("gates verdict and partitionFleetFetchable at protocol 5", () => {
    // 未驗證來源項目（sha256=null，信任根是「平台核可了這個 url」）只有
    // protocol>=5 的 agent 看得懂：舊 agent 的 `_validate_entry_shape` 會因
    // sha256 為 null 直接拒收，所以派工端一開始就不能把它算進 eligible。
    const w4 = fetchReadyWorker("w4", {
      protocol: 4,
      dynamic: { free_disk_gb: 100 },
      hardware: { max_fetch_gb: 30 },
    });
    const w5 = fetchReadyWorker("w5", {
      protocol: 5,
      dynamic: { free_disk_gb: 100 },
      hardware: { max_fetch_gb: 30 },
    });
    const fetchable = { "ae.safetensors": 335_000_000 };
    const unv = new Set(["ae.safetensors"]);

    const v4 = verdict(w4, needs(["ae.safetensors"]), {}, [w4], fetchable, null, unv);
    expect(v4.kind).toBe("ineligible");
    expect(v4.reasons).toEqual(["missing_models_unverified_protocol:ae.safetensors"]);
    expect(verdict(w5, needs(["ae.safetensors"]), {}, [w5], fetchable, null, unv).kind).toBe(
      "eligible_after_fetch"
    );

    const [f4, u4] = partitionFleetFetchable(new Set(["ae.safetensors"]), fetchable, [w4], null, unv);
    expect(f4).toEqual(new Set());
    expect(u4).toEqual(new Set(["ae.safetensors"]));

    const [f5, u5] = partitionFleetFetchable(new Set(["ae.safetensors"]), fetchable, [w5], null, unv);
    expect(f5).toEqual(new Set(["ae.safetensors"]));
    expect(u5).toEqual(new Set());
  });

  it("only gates names actually in the set", () => {
    // 和 `peerOnlyModels` 同樣的分寸：集合非空但不含這個缺少的模型時，
    // protocol 3 的 worker 一切照舊。
    const w3 = fetchReadyWorker("w3", { dynamic: { free_disk_gb: 100 } });
    const v = verdict(
      w3,
      needs(["url_only.safetensors"]),
      {},
      [w3],
      { "url_only.safetensors": 1 * GB },
      null,
      new Set(["something_else.safetensors"])
    );
    expect(v.kind).toBe("eligible_after_fetch");
  });

  it("defaults to \"nothing is unverified\" when the argument is omitted", () => {
    // 不傳 `unverifiedModels`（所有既有呼叫端）＝行為與這個參數存在之前
    // 一模一樣。
    const w3 = fetchReadyWorker("w3", { dynamic: { free_disk_gb: 100 } });
    const fetchable = { "whatever.safetensors": 1 * GB };
    expect(verdict(w3, needs(["whatever.safetensors"]), {}, [w3], fetchable).kind).toBe(
      "eligible_after_fetch"
    );
    const [f, u] = partitionFleetFetchable(new Set(["whatever.safetensors"]), fetchable, [w3]);
    expect(f).toEqual(new Set(["whatever.safetensors"]));
    expect(u).toEqual(new Set());
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

  it("excludes a 31GB set for a low-budget worker; a high-budget worker restores queueing", () => {
    // Phase 3.2 F1 fix: the exact headline scenario -- a max_fetch_gb=5
    // worker is not fetch-capable for a 31 GB curated set (submission-time
    // 400 still lists it as unfetchable, actionable), but a
    // max_fetch_gb=100 worker restores queueing.
    const lowBudget = fetchReadyWorker("w1", { hardware: { max_fetch_gb: 5 }, dynamic: { free_disk_gb: 1000.0 } });
    const fetchableModels = { "a.safetensors": 31 * GB };
    const [fetchable1, unfetchable1] = partitionFleetFetchable(new Set(["a.safetensors"]), fetchableModels, [
      lowBudget,
    ]);
    expect(fetchable1.size).toBe(0);
    expect(unfetchable1).toEqual(new Set(["a.safetensors"]));

    const highBudget = fetchReadyWorker("w2", { hardware: { max_fetch_gb: 100 }, dynamic: { free_disk_gb: 1000.0 } });
    const [fetchable2, unfetchable2] = partitionFleetFetchable(new Set(["a.safetensors"]), fetchableModels, [
      highBudget,
    ]);
    expect(fetchable2).toEqual(new Set(["a.safetensors"]));
    expect(unfetchable2.size).toBe(0);
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

import { signature, extract } from "../src/core/assess";
import schedulerCases from "./fixtures/scheduler_cases.json";

async function sig(workflow: Record<string, unknown>): Promise<string> {
  return signature(workflow, extract(workflow));
}

describe("signature (Phase 3.3 §2.1)", () => {
  it("is 16 hex chars", async () => {
    const s = await sig({ "1": { class_type: "KSampler", inputs: { steps: 20 } } });
    expect(s).toMatch(/^[0-9a-f]{16}$/);
  });

  it("ignores prompt text and seed", async () => {
    const a = {
      "1": { class_type: "KSampler", inputs: { steps: 20, seed: 1 } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "a cat" } },
    };
    const b = {
      "1": { class_type: "KSampler", inputs: { steps: 20, seed: 999999 } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "a totally different prompt" } },
    };
    expect(await sig(a)).toBe(await sig(b));
  });

  it("changes with steps, resolution and model", async () => {
    const base = {
      "1": { class_type: "KSampler", inputs: { steps: 20 } },
      "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 1 } },
      "3": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "a.safetensors" } },
    };
    const clone = () => JSON.parse(JSON.stringify(base));
    const moreSteps = clone();
    moreSteps["1"].inputs.steps = 24;
    const bigger = clone();
    bigger["2"].inputs.width = 1024;
    const otherModel = clone();
    otherModel["3"].inputs.ckpt_name = "b.safetensors";

    const baseSig = await sig(base);
    expect(await sig(moreSteps)).not.toBe(baseSig);
    expect(await sig(bigger)).not.toBe(baseSig);
    expect(await sig(otherModel)).not.toBe(baseSig);
  });

  it("treats linked inputs as 0/1, same as a missing literal", async () => {
    const linked = {
      "1": { class_type: "KSampler", inputs: { steps: ["7", 0] } },
      "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: ["7", 1] } },
    };
    const literalZero = {
      "1": { class_type: "KSampler", inputs: {} },
      "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
    };
    expect(await sig(linked)).toBe(await sig(literalZero));
  });

  it("treats an integral float like the same int (final-review M1)", async () => {
    // JSON 沒有 int/float 之分，`4.0` 和 `4` 是同一個值。TS 用
    // `Number.isInteger` 本來就是這個行為；assess.py 的 `_literal_int` 以前只收
    // `int`，兩棧因此對一張存成 `20.0` 的圖算出不同簽章。這是那個 parity
    // 的 TS 側釘子（tests/server/test_assess.py 同名測試）。
    const asInt = {
      "1": { class_type: "KSampler", inputs: { steps: 20 } },
      "2": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512, batch_size: 4 } },
    };
    const asFloat = {
      "1": { class_type: "KSampler", inputs: { steps: 20.0 } },
      "2": { class_type: "EmptyLatentImage", inputs: { width: 512.0, height: 512.0, batch_size: 4.0 } },
    };
    expect(await sig(asFloat)).toBe(await sig(asInt));
  });

  it("still ignores a non-integral float (final-review M1)", async () => {
    const a = { "1": { class_type: "KSampler", inputs: { steps: 20.5 } } };
    const b = { "1": { class_type: "KSampler", inputs: { steps: 0 } } };
    expect(await sig(a)).toBe(await sig(b));
  });

  // 兩棧 parity：同一組 workflow 必須得到同一個簽章字串。
  it("matches the shared fixture's expected signatures byte for byte", async () => {
    for (const c of schedulerCases.signature_cases) {
      expect(await sig(c.workflow as Record<string, unknown>), c.name).toBe(c.expected);
    }
  });
});
