import { afterEach, describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm } from "cloudflare:test";
import { toSqliteTimestamp, getJobById, getReceiptsForJob } from "../src/db/queries";
import { signHex } from "../src/lib/ed25519";
import { connectAgent, expectNoMessage, hub, nextMessage, openAgentWs, waitForClose } from "./helpers/ws";
import golden from "./fixtures/golden.json";

// Ports the core assertions of tests/server/test_agent_ws.py against the
// real (miniflare) Hub Durable Object over a real hibernatable WebSocket --
// see do/hub.ts's docstring and task-6-report.md for the hibernation/
// in-memory design this exercises.

function db(): D1Database {
  return (env as any).DB as D1Database;
}

afterEach(async () => {
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM receipts").run();
  await db().prepare("DELETE FROM nonces").run();
});

let idCounter = 0;
function uniqueId(base: string): string {
  idCounter += 1;
  return `${base}-${idCounter}`;
}

const KEYPAIRS = golden.keypairs;

async function makeWorker(opts: { pubkeyHex: string; disabled?: boolean; id?: string }): Promise<string> {
  const id = opts.id ?? uniqueId("w");
  await db()
    .prepare("INSERT INTO workers (id, name, pubkey, created_at, disabled) VALUES (?, ?, ?, ?, ?)")
    .bind(id, id, opts.pubkeyHex, toSqliteTimestamp(new Date()), opts.disabled ? 1 : 0)
    .run();
  return id;
}

async function makeJob(opts: {
  status: string;
  workerId?: string | null;
  lastWorkerId?: string | null;
  startedAt?: Date | null;
}): Promise<string> {
  const id = uniqueId("job");
  await db()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, worker_id, last_worker_id, created_at, started_at, input_assets)
       VALUES (?, '{}', ?, ?, ?, ?, ?, '[]')`
    )
    .bind(
      id,
      opts.status,
      opts.workerId ?? null,
      opts.lastWorkerId ?? null,
      toSqliteTimestamp(new Date()),
      opts.startedAt ? toSqliteTimestamp(opts.startedAt) : null
    )
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// Handshake

describe("handshake", () => {
  it("accepts a valid signature and sends ready", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.close();
  });

  it("rejects a bad signature with 4401", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await openAgentWs();
    const challenge = await nextMessage(ws);
    expect(challenge.type).toBe("challenge");

    const closed = waitForClose(ws);
    // Sign the WRONG message (a different nonce) so the signature is
    // cryptographically valid but doesn't match the challenge.
    const badSig = await signHex(kp.seed_hex, new TextEncoder().encode("not-the-nonce"));
    ws.send(JSON.stringify({ type: "auth", worker_id: workerId, sig: badSig }));

    const result = await closed;
    expect(result.code).toBe(4401);
  });

  it("rejects an unknown worker id with 4401", async () => {
    const kp = KEYPAIRS[0]!;
    const ws = await openAgentWs();
    const challenge = await nextMessage(ws);
    const closed = waitForClose(ws);
    const sig = await signHex(kp.seed_hex, new TextEncoder().encode(challenge.nonce));
    ws.send(JSON.stringify({ type: "auth", worker_id: "no-such-worker", sig }));
    const result = await closed;
    expect(result.code).toBe(4401);
  });

  it("rejects a disabled worker with 4401", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex, disabled: true });
    const ws = await openAgentWs();
    const challenge = await nextMessage(ws);
    const closed = waitForClose(ws);
    const sig = await signHex(kp.seed_hex, new TextEncoder().encode(challenge.nonce));
    ws.send(JSON.stringify({ type: "auth", worker_id: workerId, sig }));
    const result = await closed;
    expect(result.code).toBe(4401);
  });

  it("supersedes an older connection from the same worker, and pushes target the new one", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });

    const first = await connectAgent(workerId, kp.seed_hex);
    // Listener must be attached before the second handshake completes --
    // that's what actually closes `first`.
    const firstClosed = waitForClose(first);

    const second = await connectAgent(workerId, kp.seed_hex);
    const closeResult = await firstClosed;
    expect(closeResult.code).toBe(1000);

    // A push (job assignment) must reach the surviving (second) connection,
    // never the superseded (first, now-closed) one.
    second.send(JSON.stringify({ type: "hello", protocol: 2 }));
    const jobId = await makeJob({ status: "queued" });
    const pushedPromise = nextMessage(second);
    const ran = await runDurableObjectAlarm(hub());
    expect(ran).toBe(true);
    const pushed = await pushedPromise;
    expect(pushed.type).toBe("job");
    expect(pushed.job_id).toBe(jobId);

    second.close();
  });
});

// ---------------------------------------------------------------------------
// hello

describe("hello", () => {
  it("protocol 1 (default) gets a bilingual deprecation frame", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);

    ws.send(JSON.stringify({ type: "hello", backend: "cpu" }));
    const deprecation = await nextMessage(ws);
    expect(deprecation.type).toBe("deprecation");
    expect(deprecation.message).toContain("agent 版本過舊");
    expect(deprecation.message).toContain("Agent is outdated");

    const row = await db().prepare("SELECT protocol FROM workers WHERE id = ?").bind(workerId).first<{ protocol: number }>();
    expect(row!.protocol).toBe(1);
    ws.close();
  });

  it("protocol 2 records hardware/backend and sends no deprecation", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);

    const none = expectNoMessage(ws, 300);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 2,
        backend: "cuda",
        torch_version: "2.4.0",
        hardware: { vram_gb: 24, gpu_name: "RTX4090" },
        node_classes: ["KSampler"],
      })
    );
    await none;

    const row = await db()
      .prepare("SELECT protocol, backend, torch_version, hardware, node_classes FROM workers WHERE id = ?")
      .bind(workerId)
      .first<{ protocol: number; backend: string; torch_version: string; hardware: string; node_classes: string }>();
    expect(row!.protocol).toBe(2);
    expect(row!.backend).toBe("cuda");
    expect(row!.torch_version).toBe("2.4.0");
    expect(JSON.parse(row!.hardware)).toEqual({ vram_gb: 24, gpu_name: "RTX4090" });
    expect(JSON.parse(row!.node_classes)).toEqual(["KSampler"]);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// heartbeat: zombie job reference -> job_cancelled dedup

describe("heartbeat job_cancelled dedup", () => {
  it("pushes job_cancelled once for a not-owned job, then dedups", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));
    // protocol 2 -> no deprecation frame to drain.

    // A job this worker does NOT own (queued, unowned).
    const jobId = await makeJob({ status: "queued" });

    const first = nextMessage(ws);
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle", job_id: jobId }));
    const cancelled = await first;
    expect(cancelled).toEqual({ type: "job_cancelled", job_id: jobId });

    const none = expectNoMessage(ws, 300);
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle", job_id: jobId }));
    await none;
    ws.close();
  });

  it("never sends job_cancelled to a protocol-1 connection", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    // No hello at all -> protocol stays at its default (1).

    const jobId = await makeJob({ status: "queued" });
    const none = expectNoMessage(ws, 300);
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle", job_id: jobId }));
    await none;
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// job_done -> receipt -> receipt_ack roundtrip

describe("job_done", () => {
  it("mints a completed receipt, pushes it, and accepts a valid receipt_ack", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const startedAt = new Date(Date.now() - 10_000);
    const jobId = await makeJob({ status: "running", workerId, startedAt });

    const receiptMsg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: ["a.png"], exec_seconds: 5 }));
    const receipt = await receiptMsg;
    expect(receipt.type).toBe("receipt");
    expect(receipt.kind).toBe("completed");
    expect(receipt.billable).toBe(true);
    expect(receipt.basis).toBe("exec");
    expect(receipt.payload).toBe(`${jobId}|${workerId}|5.0`);

    const job = await getJobById(db(), jobId);
    expect(job!.status).toBe("done");
    expect(job!.resultFiles).toEqual(["a.png"]);

    const receipts = await getReceiptsForJob(db(), jobId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.workerSig).toBeNull();

    // Counter-sign and ack.
    const workerSig = await signHex(kp.seed_hex, new TextEncoder().encode(receipt.payload));
    ws.send(JSON.stringify({ type: "receipt_ack", receipt_id: receipt.receipt_id, worker_sig: workerSig }));
    // receipt_ack has no reply frame -- poll the DB for the write instead of
    // racing a message that will never come.
    await new Promise((r) => setTimeout(r, 50));
    const acked = await getReceiptsForJob(db(), jobId);
    expect(acked[0]!.workerSig).toBe(workerSig);
    ws.close();
  });

  it("caps exec_seconds at the wall-clock span", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const startedAt = new Date(Date.now() - 2_000); // ~2s wall clock
    const jobId = await makeJob({ status: "running", workerId, startedAt });

    const receiptMsg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: [], exec_seconds: 999 }));
    const receipt = await receiptMsg;
    const gpuSeconds = Number(receipt.payload.split("|")[2]);
    expect(gpuSeconds).toBeLessThan(999);
    expect(gpuSeconds).toBeGreaterThanOrEqual(0);
    ws.close();
  });

  it("re-adopts a blipped job (queued, last_worker_id = self) and completes it", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));

    // Simulates what requeueStale leaves behind for a worker that blipped
    // mid-run: back to queued, worker_id cleared, last_worker_id retained.
    const startedAt = new Date(Date.now() - 3_000);
    const jobId = await makeJob({ status: "queued", workerId: null, lastWorkerId: workerId, startedAt });

    const receiptMsg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: ["r.png"], exec_seconds: 1 }));
    const receipt = await receiptMsg;
    expect(receipt.type).toBe("receipt");

    const job = await getJobById(db(), jobId);
    expect(job!.status).toBe("done");
    ws.close();
  });

  it("someone else's job -> job_cancelled, no receipt", async () => {
    const kp = KEYPAIRS[0]!;
    const kp2 = KEYPAIRS[1]!;
    const owner = await makeWorker({ pubkeyHex: kp2.pubkey_hex });
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const jobId = await makeJob({ status: "running", workerId: owner, startedAt: new Date() });

    const cancelledMsg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: [] }));
    const cancelled = await cancelledMsg;
    expect(cancelled).toEqual({ type: "job_cancelled", job_id: jobId });

    const receipts = await getReceiptsForJob(db(), jobId);
    expect(receipts).toHaveLength(0);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// job_failed -> non-billable receipt

describe("job_failed", () => {
  it("mints a non-billable failed receipt with wall basis when never started", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));

    // assigned, never started (started_at null).
    const jobId = await makeJob({ status: "assigned", workerId, startedAt: null });

    const receiptMsg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "job_failed", job_id: jobId, error: "boom" }));
    const receipt = await receiptMsg;
    expect(receipt.type).toBe("receipt");
    expect(receipt.kind).toBe("failed");
    expect(receipt.billable).toBe(false);
    expect(receipt.basis).toBe("wall");
    expect(receipt.payload).toBe(`${jobId}|${workerId}|0.0`);

    const job = await getJobById(db(), jobId);
    expect(job!.status).toBe("failed");
    expect(job!.error).toBe("boom");

    const receipts = await getReceiptsForJob(db(), jobId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.billable).toBe(false);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// Dispatch alarm

describe("dispatch alarm", () => {
  it("assigns a queued job to an idle connected worker", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex); // arms the alarm; state defaults to idle.

    const jobId = await makeJob({ status: "queued" });

    // Attach the listener BEFORE running the alarm: `runDurableObjectAlarm`
    // awaits the whole tick (including the `ws.send` push) to completion
    // before resolving, so a listener attached only after it returns would
    // already have missed the message.
    const pushedPromise = nextMessage(ws);
    const ran = await runDurableObjectAlarm(hub());
    expect(ran).toBe(true);

    const pushed = await pushedPromise;
    expect(pushed.type).toBe("job");
    expect(pushed.job_id).toBe(jobId);

    const job = await getJobById(db(), jobId);
    expect(job!.status).toBe("assigned");
    expect(job!.workerId).toBe(workerId);
    ws.close();
  });

  it("does not assign to a worker that reported busy", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "heartbeat", state: "busy" }));
    await new Promise((r) => setTimeout(r, 50)); // let the heartbeat land before the alarm ticks.

    const jobId = await makeJob({ status: "queued" });
    await runDurableObjectAlarm(hub());

    const job = await getJobById(db(), jobId);
    expect(job!.status).toBe("queued");
    ws.close();
  });
});
