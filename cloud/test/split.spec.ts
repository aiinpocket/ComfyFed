import { afterEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import * as split from "../src/core/split";
import * as queries from "../src/db/queries";
import { toSqliteTimestamp } from "../src/db/queries";

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

// --- §3.3-§3.6 DB 段 --------------------------------------------------------
// 沿用 dispatch.spec.ts 的 `db()` / `afterEach` 清表樣式：vitest-pool-workers
// 的儲存是 per-FILE 而不是 per-`it()`，所以每個 it 之後要自己清乾淨。

function db(): D1Database {
  return (env as any).DB as D1Database;
}

afterEach(async () => {
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM settings").run();
});

async function makeParent(id = "parent", batchSize = 4): Promise<string> {
  const wf = batchWorkflow(batchSize);
  await db()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, created_at, signature, required_nodes, required_models, split_plan, split_count)
       VALUES (?, ?, 'queued', ?, 'sig', ?, '[]', ?, 0)`
    )
    .bind(
      id,
      JSON.stringify(wf),
      toSqliteTimestamp(new Date()),
      JSON.stringify([...new Set(Object.values(wf).map((n: any) => n.class_type))].sort()),
      JSON.stringify({ source_node_id: "4", batch_size: batchSize })
    )
    .run();
  return id;
}

async function setRow(id: string, fields: Record<string, unknown>): Promise<void> {
  const keys = Object.keys(fields);
  await db()
    .prepare(`UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .bind(...keys.map((k) => fields[k]), id)
    .run();
}

async function readRow(id: string): Promise<any> {
  return (await db().prepare("SELECT * FROM jobs WHERE id = ?").bind(id).first<any>())!;
}

describe("createChildren (§3.3)", () => {
  it("inserts k children and marks the parent", async () => {
    const parentId = await makeParent("p1", 4);
    expect(await split.createChildren(db(), parentId, 2)).toBe(2);

    const children = await split.childrenOf(db(), parentId);
    expect(children.map((c) => c.splitIndex)).toEqual([0, 1]);
    expect(children.every((c) => c.splitCount === 0)).toBe(true);
    const parent = await readRow(parentId);
    expect(parent.split_count).toBe(2);
    expect(parent.status).toBe("queued");
    // created_at 承襲父 job，保住在佇列中的位置。
    expect(children.every((c) => c.createdAt === parent.created_at)).toBe(true);
    expect(children.every((c) => c.signature === "sig")).toBe(true);
    expect(children.every((c) => c.parentId === parentId)).toBe(true);

    const first = JSON.parse(children[0]!.workflowJson);
    const second = JSON.parse(children[1]!.workflowJson);
    expect(first["cfsplit"].inputs).toEqual({ samples: ["4", 0], batch_index: 0, length: 2 });
    expect(second["cfsplit"].inputs).toEqual({ samples: ["4", 0], batch_index: 2, length: 2 });
    expect(children.every((c) => c.requiredNodes.includes("LatentFromBatch"))).toBe(true);
  });

  it("is a no-op without a split plan", async () => {
    await db()
      .prepare("INSERT INTO jobs (id, workflow_json, status, created_at) VALUES ('plain', '{}', 'queued', ?)")
      .bind(toSqliteTimestamp(new Date()))
      .run();
    expect(await split.createChildren(db(), "plain", 2)).toBe(0);
  });

  it("refuses a parent that is already split, leaving the children alone", async () => {
    const parentId = await makeParent("p-twice");
    expect(await split.createChildren(db(), parentId, 2)).toBe(2);
    expect(await split.createChildren(db(), parentId, 2)).toBe(0);
    expect((await split.childrenOf(db(), parentId)).length).toBe(2);
  });

  it("refuses a parent that is no longer queued", async () => {
    const parentId = await makeParent("p-claimed");
    await setRow(parentId, { status: "assigned" });
    expect(await split.createChildren(db(), parentId, 2)).toBe(0);
    expect((await split.childrenOf(db(), parentId)).length).toBe(0);
  });

  it("inserts no children when the parent guard loses the race", async () => {
    // `createChildren` 的前置讀取擋不住「讀到之後、批次執行之前才被搶走」的
    // 那個窗口，所以守衛也寫進了批次裡的每一個 INSERT。這裡直接組出那個批次
    // 來驗證：父 job 不再是 queued -> 守衛 UPDATE 動 0 列 -> 每個 INSERT 的
    // 守衛條件也不成立 -> 一個子 job 都沒留下（否則父 job 仍可被派工，而它的
    // 子 job 也會被派工，同一批 latent 跑兩次）。
    const parentId = await makeParent("p-raced");
    await setRow(parentId, { status: "assigned" });
    const child: queries.NewChildJob = {
      id: "orphan-candidate",
      parentId,
      splitIndex: 0,
      workflowJson: "{}",
      createdAt: toSqliteTimestamp(new Date()),
      signature: "sig",
      requiredNodes: [],
      requiredModels: [],
      estVramGb: null,
      requirements: {},
      inputAssets: [],
      origin: "console",
      userId: null,
      label: null,
    };

    const results = await db().batch([
      queries.markJobSplitStatement(db(), parentId, 1),
      queries.childJobInsertStatement(db(), child, 1),
    ]);

    expect(results[0]!.meta.changes ?? 0).toBe(0);
    expect((await split.childrenOf(db(), parentId)).length).toBe(0);
  });
});

describe("refreshParent (§3.4)", () => {
  it.each([
    [["queued", "queued"], "queued"],
    [["assigned", "queued"], "assigned"],
    [["running", "queued"], "running"],
    [["running", "assigned"], "running"],
    [["done", "done"], "done"],
    [["done", "running"], "running"],
  ])("derives %s -> %s", async (statuses, expected) => {
    const parentId = await makeParent(`p-${expected}-${(statuses as string[]).join("")}`);
    await split.createChildren(db(), parentId, statuses.length);
    const children = await split.childrenOf(db(), parentId);
    for (let i = 0; i < statuses.length; i++) await setRow(children[i]!.id, { status: statuses[i] });

    const { status } = await split.refreshParent(db(), parentId, new Date());
    expect(status).toBe(expected);
    expect((await readRow(parentId)).status).toBe(expected);
  });

  it("never gives the parent a worker of its own", async () => {
    const parentId = await makeParent("p-assigned-worker");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    // 父 job 已經是 assigned 了，唯一該變的就是那個殘留的 worker_id --
    // 如果 `changed` 的比較漏掉 workerId，這次 NULL 寫入會整個被跳過。
    await setRow(parentId, { status: "assigned", worker_id: "stale-w" });
    await setRow(children[0]!.id, { status: "assigned", worker_id: "w1" });

    await split.refreshParent(db(), parentId, new Date());

    const parent = await readRow(parentId);
    expect(parent.status).toBe("assigned");
    // `workerId` 必須在 changed 比較裡，否則這次 NULL 寫入會被跳過。
    expect(parent.worker_id).toBeNull();
  });

  it("takes the earliest start and the average progress while running", async () => {
    const parentId = await makeParent("p-running");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[0]!.id, { status: "running", started_at: "2026-09-15 12:00:00.000000", progress: 0.4 });
    await setRow(children[1]!.id, { status: "running", started_at: "2026-09-15 12:00:30.000000", progress: 0.8 });

    await split.refreshParent(db(), parentId, new Date());

    const parent = await readRow(parentId);
    expect(parent.status).toBe("running");
    expect(parent.started_at).toBe("2026-09-15 12:00:00.000000");
    expect(parent.progress).toBeCloseTo(0.6, 10);
  });

  it("takes the latest finish when every child is done", async () => {
    const parentId = await makeParent("p-done");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[0]!.id, { status: "done", finished_at: "2026-09-15 12:00:00.000000" });
    await setRow(children[1]!.id, { status: "done", finished_at: "2026-09-15 12:00:05.000000" });

    await split.refreshParent(db(), parentId, new Date());

    const parent = await readRow(parentId);
    expect(parent.status).toBe("done");
    expect(parent.finished_at).toBe("2026-09-15 12:00:05.000000");
    expect(parent.progress).toBe(1);
    // 父 job 自己的 result_files 保持空的；輸出由 parentOutputs 組出來。
    expect(JSON.parse(parent.result_files)).toEqual([]);
  });

  it("cancels the surviving siblings when one child fails", async () => {
    const parentId = await makeParent("p-failed");
    await split.createChildren(db(), parentId, 3);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[1]!.id, { status: "failed", error: "CUDA OOM" });

    await split.refreshParent(db(), parentId, new Date());

    const parent = await readRow(parentId);
    expect(parent.status).toBe("failed");
    expect(parent.error).toBe("子任務 2/3：CUDA OOM");
    for (const idx of [0, 2]) {
      expect((await readRow(children[idx]!.id)).status).toBe("cancelled");
    }
  });

  it("releases the cascade-cancelled siblings' ownership and hands back their owners", async () => {
    const parentId = await makeParent("p-cascade");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[0]!.id, { status: "failed", error: "boom" });
    const startedAt = toSqliteTimestamp(new Date(Date.now() - 30_000));
    await setRow(children[1]!.id, { status: "running", worker_id: "w9", started_at: startedAt });

    const owners: split.CascadeCancelled[] = [];
    await split.refreshParent(db(), parentId, new Date(), owners);

    // 第三個元素 = 取消當下的 `started_at`（只有真的在 running 的才有），Hub
    // 拿它決定要不要 mint 一張 cancelled 收據以及收據的 wall-clock 起點。
    expect(owners).toEqual([[children[1]!.id, "w9", startedAt]]);
    const sibling = await readRow(children[1]!.id);
    expect(sibling.status).toBe("cancelled");
    expect(sibling.worker_id).toBeNull();
    expect(sibling.last_worker_id).toBe("w9");
    expect(sibling.error).toBe("sibling failed");
    expect(sibling.finished_at).not.toBeNull();
  });

  it("cancels the others when one child is cancelled", async () => {
    const parentId = await makeParent("p-cancelled");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[0]!.id, { status: "cancelled", error: "cancelled by admin" });

    await split.refreshParent(db(), parentId, new Date());

    const parent = await readRow(parentId);
    expect(parent.status).toBe("cancelled");
    expect(parent.error).toBe("cancelled by admin");
    expect((await readRow(children[1]!.id)).status).toBe("cancelled");
  });

  it("ignores a job whose split_count is zero (retried parent)", async () => {
    const parentId = await makeParent("p-retried");
    await split.createChildren(db(), parentId, 2);
    await setRow(parentId, { split_count: 0, status: "queued" });
    expect(await split.refreshParent(db(), parentId, new Date())).toEqual({ changed: false, status: null });
  });
});

describe("parentOutputs / childStatusChanged (§3.4)", () => {
  it("orders parent outputs by split index then file order", async () => {
    const parentId = await makeParent("p-outputs");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[1]!.id, { status: "done", result_files: JSON.stringify(["c.png", "d.png"]) });
    await setRow(children[0]!.id, { status: "done", result_files: JSON.stringify(["a.png", "b.png"]) });

    const parent = (await queries.getJobById(db(), parentId))!;
    expect(await split.parentOutputs(db(), parent)).toEqual([
      [children[0]!.id, "a.png"],
      [children[0]!.id, "b.png"],
      [children[1]!.id, "c.png"],
      [children[1]!.id, "d.png"],
    ]);
  });

  it("returns no outputs for a plain job", async () => {
    await db()
      .prepare("INSERT INTO jobs (id, workflow_json, status, created_at) VALUES ('plain2', '{}', 'done', ?)")
      .bind(toSqliteTimestamp(new Date()))
      .run();
    const job = (await queries.getJobById(db(), "plain2"))!;
    expect(await split.parentOutputs(db(), job)).toEqual([]);
  });

  it("is a no-op for a job that has no parent", async () => {
    await db()
      .prepare("INSERT INTO jobs (id, workflow_json, status, created_at) VALUES ('plain3', '{}', 'queued', ?)")
      .bind(toSqliteTimestamp(new Date()))
      .run();
    expect(await split.childStatusChanged(db(), "plain3", new Date())).toBeNull();
  });

  it("propagates a child transition to the parent", async () => {
    const parentId = await makeParent("p-propagate");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[0]!.id, { status: "running" });

    expect(await split.childStatusChanged(db(), children[0]!.id, new Date())).toBe("running");
    expect((await readRow(parentId)).status).toBe("running");
  });
});

describe("planForJob / splitBatchesEnabled (§3.2)", () => {
  it("round-trips a splittable workflow into the stored JSON", async () => {
    expect(split.planForJob(batchWorkflow(4), {}, true)).toBe(
      JSON.stringify({ source_node_id: "4", batch_size: 4 })
    );
    expect(split.planForJob(batchWorkflow(4), { split: false }, true)).toBeNull();
    expect(split.planForJob(batchWorkflow(4), {}, false)).toBeNull();
  });

  it("defaults the platform setting to on and treats only \"0\" as off", async () => {
    expect(await split.splitBatchesEnabled(db())).toBe(true);
    await db()
      .prepare("INSERT INTO settings (key, value) VALUES (?, '0')")
      .bind(split.SPLIT_BATCHES_SETTING_KEY)
      .run();
    expect(await split.splitBatchesEnabled(db())).toBe(false);
  });
});

describe("fix round 1: terminal parents and heartbeat-driven progress", () => {
  it("never moves a parent that is already terminal", async () => {
    const parentId = await makeParent("p-terminal");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    for (const child of children) await setRow(child.id, { status: "cancelled", error: "cancelled by admin" });
    await split.refreshParent(db(), parentId, new Date());
    expect((await readRow(parentId)).status).toBe("cancelled");

    // 被取消的 worker 還是把 job_done 送了上來。
    for (const child of children) await setRow(child.id, { status: "done", result_files: JSON.stringify(["late.png"]) });

    expect(await split.refreshParent(db(), parentId, new Date())).toEqual({ changed: false, status: null });
    expect((await readRow(parentId)).status).toBe("cancelled");
  });

  it("cascades the cancellation reason, not a generic one", async () => {
    const parentId = await makeParent("p-reason");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[0]!.id, { status: "cancelled", error: "cancelled by admin" });

    await split.refreshParent(db(), parentId, new Date());

    expect((await readRow(children[1]!.id)).error).toBe("cancelled by admin");
  });

  it("refreshParentProgress is the mean over the children", async () => {
    const parentId = await makeParent("p-mean");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    await setRow(children[0]!.id, { status: "running", progress: 0.2 });
    await setRow(children[1]!.id, { status: "running", progress: 0.6 });

    expect(await split.refreshParentProgress(db(), children[0]!.id)).toBeCloseTo(0.4, 10);
    expect((await readRow(parentId)).progress).toBeCloseTo(0.4, 10);
  });

  it("refreshParentProgress is a no-op for a plain job and for a terminal parent", async () => {
    await db()
      .prepare("INSERT INTO jobs (id, workflow_json, status, created_at) VALUES ('plain-prog', '{}', 'running', ?)")
      .bind(toSqliteTimestamp(new Date()))
      .run();
    expect(await split.refreshParentProgress(db(), "plain-prog")).toBeNull();

    const parentId = await makeParent("p-done-prog");
    await split.createChildren(db(), parentId, 2);
    const children = await split.childrenOf(db(), parentId);
    for (const child of children) await setRow(child.id, { status: "done", progress: 1 });
    await split.refreshParent(db(), parentId, new Date());

    // 遲到的心跳不能把 done 父 job 的 progress 從 1.0 拉回去。
    await setRow(children[0]!.id, { progress: 0.2 });
    expect(await split.refreshParentProgress(db(), children[0]!.id)).toBeNull();
    expect((await readRow(parentId)).progress).toBe(1);
  });
});

// --- 2026-09-20 檔案頁 §3.1：子 job 複製父的名稱 ---

describe("createChildren label (檔案頁 §3.1)", () => {
  it("copies the parent's label onto every child", async () => {
    // 成品掛在子 job 上，所以子 job 得帶著父的名稱，否則一次送件的產出會在
    // 檔案頁散成 k 個「未命名」資料夾。
    const parentId = await makeParent("p-label", 4);
    await setRow(parentId, { label: "wuxia-opening" });

    expect(await split.createChildren(db(), parentId, 2)).toBe(2);
    const children = await split.childrenOf(db(), parentId);
    expect(children.map((c) => c.label)).toEqual(["wuxia-opening", "wuxia-opening"]);
  });

  it("keeps a null label null", async () => {
    const parentId = await makeParent("p-no-label", 4);
    expect(await split.createChildren(db(), parentId, 2)).toBe(2);
    const children = await split.childrenOf(db(), parentId);
    expect(children.map((c) => c.label)).toEqual([null, null]);
  });
});
