import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { toSqliteTimestamp, getJobById, getReceiptsForJob, getWorkerById } from "../src/db/queries";
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

// Every `connectAgent` handshake arms a REAL 5s dispatch alarm
// (`scheduleAlarmIfNeeded`), and miniflare fires due alarms for real. Once
// the file's cumulative runtime crosses 5s -- which only happens under
// full-suite load, never in a solo run -- an alarm armed by an EARLIER
// test fires inside a later test's `expectNoMessage` window and dispatches
// that test's own queued job to its idle worker (live-caught flake in
// "pushes job_cancelled once for a not-owned job, then dedups"). Delete
// the pending alarm around every test so ticks only ever run when a test
// explicitly calls `runDurableObjectAlarm`.
async function deletePendingAlarm(): Promise<void> {
  await runInDurableObject(hub(), (_instance, state) => state.storage.deleteAlarm());
}

beforeEach(deletePendingAlarm);

afterEach(async () => {
  await deletePendingAlarm();
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

async function makeWorker(opts: {
  pubkeyHex: string;
  disabled?: boolean;
  deleted?: boolean;
  id?: string;
}): Promise<string> {
  const id = opts.id ?? uniqueId("w");
  await db()
    .prepare(
      "INSERT INTO workers (id, name, pubkey, created_at, disabled, deleted) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(
      id,
      id,
      opts.pubkeyHex,
      toSqliteTimestamp(new Date()),
      opts.disabled ? 1 : 0,
      opts.deleted ? 1 : 0
    )
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

  it("rejects a merely DISABLED worker with 4403, not 4401", async () => {
    // Disabling is reversible, so the agent is told 4403: it keeps retrying
    // and never prunes the registration. Parity: test_agent_ws.py's
    // test_handshake_of_a_disabled_worker_closes_4403.
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex, disabled: true });
    const ws = await openAgentWs();
    const challenge = await nextMessage(ws);
    const closed = waitForClose(ws);
    const sig = await signHex(kp.seed_hex, new TextEncoder().encode(challenge.nonce));
    ws.send(JSON.stringify({ type: "auth", worker_id: workerId, sig }));
    const result = await closed;
    expect(result.code).toBe(4403);
  });

  it("rejects a soft-deleted worker with 4401", async () => {
    // `getWorkerById` filters `deleted`, so a deleted worker's handshake is
    // indistinguishable from an unknown id -- its certificate is inert for
    // good. Ports test_agent_ws.py's deleted-handshake test.
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex, deleted: true });
    const ws = await openAgentWs();
    const challenge = await nextMessage(ws);
    const closed = waitForClose(ws);
    const sig = await signHex(kp.seed_hex, new TextEncoder().encode(challenge.nonce));
    ws.send(JSON.stringify({ type: "auth", worker_id: workerId, sig }));
    const result = await closed;
    expect(result.code).toBe(4401);
  });

  it("rejects a soft-deleted worker that is ALSO disabled with 4401", async () => {
    // The real shape of a soft delete (`DELETE /api/workers/:id` sets both
    // flags). `deleted` must win: 4401 (permanent, prunable), never the
    // reversible 4403 -- the whole dead-registration prune keys off this.
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({
      pubkeyHex: kp.pubkey_hex,
      deleted: true,
      disabled: true,
    });
    const ws = await openAgentWs();
    const challenge = await nextMessage(ws);
    const closed = waitForClose(ws);
    const sig = await signHex(kp.seed_hex, new TextEncoder().encode(challenge.nonce));
    ws.send(JSON.stringify({ type: "auth", worker_id: workerId, sig }));
    const result = await closed;
    expect(result.code).toBe(4401);
  });

  it("rejects a malformed auth frame with 4408, not 4401", async () => {
    // Not an auth DECISION: transient/protocol noise. 4401 here would feed
    // the agent's give-up counter for a registration that is perfectly fine.
    const ws = await openAgentWs();
    const challenge = await nextMessage(ws);
    expect(challenge.type).toBe("challenge");
    const closed = waitForClose(ws);
    ws.send("not json at all");
    const result = await closed;
    expect(result.code).toBe(4408);
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

  // Phase 3.2 F1 fix -- ports agentws.py's _parse_max_fetch_gb test coverage.
  it("stores a reported max_fetch_gb inside the hardware JSON blob", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    const none = expectNoMessage(ws, 300);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 4,
        auto_fetch: true,
        hardware: { vram_gb: 24 },
        max_fetch_gb: 5,
      })
    );
    await none;

    const row = await db().prepare("SELECT hardware FROM workers WHERE id = ?").bind(workerId).first<{ hardware: string }>();
    const hardware = JSON.parse(row!.hardware);
    expect(hardware.max_fetch_gb).toBe(5);
    expect(hardware.vram_gb).toBe(24);
    ws.close();
  });

  it("omits max_fetch_gb from the hardware blob when hello doesn't report a valid value", async () => {
    for (const bad of [undefined, -5, "30", 0]) {
      const kp = KEYPAIRS[0]!;
      const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
      const ws = await connectAgent(workerId, kp.seed_hex);
      const none = expectNoMessage(ws, 200);
      const msg: Record<string, unknown> = { type: "hello", protocol: 4, auto_fetch: true, hardware: {} };
      if (bad !== undefined) msg.max_fetch_gb = bad;
      ws.send(JSON.stringify(msg));
      await none;

      const row = await db().prepare("SELECT hardware FROM workers WHERE id = ?").bind(workerId).first<{ hardware: string }>();
      expect(JSON.parse(row!.hardware)).not.toHaveProperty("max_fetch_gb");
      ws.close();
    }
  });

  // Seeder upload cap -- ports agentws.py's _parse_peer_upload_min_mbps coverage.
  it("stores a reported peer_upload_min_mbps inside the hardware JSON blob", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    const none = expectNoMessage(ws, 300);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 4,
        hardware: { vram_gb: 24 },
        peer_upload_min_mbps: 5,
      })
    );
    await none;

    const row = await db().prepare("SELECT hardware FROM workers WHERE id = ?").bind(workerId).first<{ hardware: string }>();
    const hardware = JSON.parse(row!.hardware);
    expect(hardware.peer_upload_min_mbps).toBe(5);
    expect(hardware.vram_gb).toBe(24);
    ws.close();
  });

  it("omits peer_upload_min_mbps when hello reports null (both caps unlimited) or garbage", async () => {
    // M2: out-of-range values (a denormal, an absurd rate, NaN/Infinity) are
    // treated exactly like absent -- they never reach the hardware blob and
    // so can never become a TTL divisor. Parity: agentws.py's
    // `_parse_peer_upload_min_mbps` range check.
    for (const bad of [undefined, null, -5, "20", 0, true, 1e-300, 0.09, 1e300, 100001, Number.NaN]) {
      const kp = KEYPAIRS[0]!;
      const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
      const ws = await connectAgent(workerId, kp.seed_hex);
      const none = expectNoMessage(ws, 200);
      const msg: Record<string, unknown> = { type: "hello", protocol: 4, hardware: {} };
      if (bad !== undefined) msg.peer_upload_min_mbps = bad;
      ws.send(JSON.stringify(msg));
      await none;

      const row = await db().prepare("SELECT hardware FROM workers WHERE id = ?").bind(workerId).first<{ hardware: string }>();
      expect(JSON.parse(row!.hardware)).not.toHaveProperty("peer_upload_min_mbps");
      ws.close();
    }
  });

  // Phase 3.1 P2P seeder advertisement -- ports agentws.py's _parse_peer_url
  // test coverage.
  it("stores a valid http(s) peer_url", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    const none = expectNoMessage(ws, 300);
    ws.send(JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://192.168.1.5:8850" }));
    await none;

    const row = await db().prepare("SELECT peer_url, protocol FROM workers WHERE id = ?").bind(workerId).first<{ peer_url: string | null; protocol: number }>();
    expect(row!.peer_url).toBe("http://192.168.1.5:8850");
    expect(row!.protocol).toBe(4);
    ws.close();
  });

  it("ignores a malformed peer_url (no host, wrong scheme, non-string) and stores null", async () => {
    for (const badPeerUrl of ["not-a-url", "ftp://host/path", 12345]) {
      const kp = KEYPAIRS[0]!;
      const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
      const ws = await connectAgent(workerId, kp.seed_hex);
      const none = expectNoMessage(ws, 200);
      ws.send(JSON.stringify({ type: "hello", protocol: 4, peer_url: badPeerUrl }));
      await none;

      const row = await db().prepare("SELECT peer_url FROM workers WHERE id = ?").bind(workerId).first<{ peer_url: string | null }>();
      expect(row!.peer_url).toBeNull();
      ws.close();
    }
  });

  it("a reconnecting hello without peer_url clears a previously-advertised one", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    await db().prepare("UPDATE workers SET peer_url = 'http://stale:1' WHERE id = ?").bind(workerId).run();

    const ws = await connectAgent(workerId, kp.seed_hex);
    const none = expectNoMessage(ws, 200);
    ws.send(JSON.stringify({ type: "hello", protocol: 4 })); // no peer_url this time
    await none;

    const row = await db().prepare("SELECT peer_url FROM workers WHERE id = ?").bind(workerId).first<{ peer_url: string | null }>();
    expect(row!.peer_url).toBeNull();
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
// heartbeat: paused state

describe("heartbeat paused", () => {
  it("sets worker status to paused", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);

    ws.send(JSON.stringify({ type: "heartbeat", state: "paused" }));
    await new Promise((r) => setTimeout(r, 50)); // let the heartbeat land.

    const worker = await getWorkerById(db(), workerId);
    expect(worker!.status).toBe("paused");
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

  it("accepts an in-flight receipt_ack from a worker deleted mid-flight (review L7)", async () => {
    // `handleReceiptAck` resolves the worker with the UNFILTERED lookup: the
    // delete route's fire-and-forget kick normally closes the socket first,
    // but if it loses the race (or fails) the ack must still land -- otherwise
    // that receipt keeps `worker_sig = NULL` forever with no retry path. Every
    // other live handler (hello/heartbeat/inventory) may keep dropping.
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(Date.now() - 10_000) });
    const receiptMsg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: ["a.png"], exec_seconds: 5 }));
    const receipt = await receiptMsg;

    // The admin deletes the worker while the ack is in flight.
    await db().prepare("UPDATE workers SET deleted = 1, disabled = 1 WHERE id = ?").bind(workerId).run();
    expect(await getWorkerById(db(), workerId)).toBeNull();

    const workerSig = await signHex(kp.seed_hex, new TextEncoder().encode(receipt.payload));
    ws.send(JSON.stringify({ type: "receipt_ack", receipt_id: receipt.receipt_id, worker_sig: workerSig }));
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

  it("does not assign to a paused worker, but does after a subsequent idle heartbeat", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "heartbeat", state: "paused" }));
    await new Promise((r) => setTimeout(r, 50)); // let the heartbeat land before the alarm ticks.

    const jobId = await makeJob({ status: "queued" });
    await runDurableObjectAlarm(hub());

    let job = await getJobById(db(), jobId);
    expect(job!.status).toBe("queued");

    const pushedPromise = nextMessage(ws);
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle" }));
    await new Promise((r) => setTimeout(r, 50)); // let the idle heartbeat land before the alarm ticks.
    const ran = await runDurableObjectAlarm(hub());
    expect(ran).toBe(true);

    const pushed = await pushedPromise;
    expect(pushed.type).toBe("job");
    expect(pushed.job_id).toBe(jobId);

    job = await getJobById(db(), jobId);
    expect(job!.status).toBe("assigned");
    expect(job!.workerId).toBe(workerId);
    ws.close();
  });
});

// ---------------------------------------------------------------------------
// /internal/kick_worker -- the live half of the admin soft delete

describe("internal kick_worker", () => {
  it("closes a connected worker's socket with 4403", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);

    const closed = waitForClose(ws);
    // What `DELETE /api/workers/:id` does right after flagging the row: the
    // handshake gate alone only stops the NEXT connection, so an already
    // connected agent has to be dropped explicitly.
    await db().prepare("UPDATE workers SET deleted = 1, disabled = 1 WHERE id = ?").bind(workerId).run();
    const res = await hub().fetch("http://hub.internal/internal/kick_worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: workerId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kicked: true });

    const result = await closed;
    expect(result.code).toBe(4403);
  });

  it("reports kicked:false when the worker has no live connection", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const res = await hub().fetch("http://hub.internal/internal/kick_worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: workerId }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kicked: false });
  });

  it("400s without a worker_id", async () => {
    const res = await hub().fetch("http://hub.internal/internal/kick_worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("never dispatches a queued job to a deleted worker", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const jobId = await makeJob({ status: "queued" });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle" }));
    await new Promise((r) => setTimeout(r, 50));

    await db().prepare("UPDATE workers SET deleted = 1, disabled = 1 WHERE id = ?").bind(workerId).run();

    const quiet = expectNoMessage(ws);
    await runDurableObjectAlarm(hub());
    await quiet;

    const job = await getJobById(db(), jobId);
    expect(job!.status).toBe("queued");
    ws.close();
  });
});
