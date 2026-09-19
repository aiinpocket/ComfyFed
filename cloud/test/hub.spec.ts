import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { toSqliteTimestamp, getJobById, getReceiptsForJob, getWorkerById } from "../src/db/queries";
import { signHex } from "../src/lib/ed25519";
import { collectMessages, connectAgent, expectNoMessage, hub, nextMessage, openAgentWs, waitFor, waitForClose } from "./helpers/ws";
import * as peerhealth from "../src/core/peerhealth";
import * as split from "../src/core/split";
import * as modelFetch from "../src/core/model_fetch";
import * as modelGuide from "../src/core/model_guide";
import * as modelManifest from "../src/core/model_manifest";
import { resolvePlatformSeed } from "../src/db/queries";
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
  await db().prepare("DELETE FROM model_hashes").run();
  await db().prepare("DELETE FROM worker_job_stats").run();
  modelGuide.clearHarvestCacheForTests();
  modelManifest.clearMismatchLogForTests();
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
  signature?: string | null;
  parentId?: string | null;
  splitIndex?: number | null;
  kind?: string;
  fetchEntry?: string | null;
  requiredModels?: string[];
}): Promise<string> {
  const id = uniqueId("job");
  await db()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, worker_id, last_worker_id, created_at, started_at, input_assets,
                         signature, parent_id, split_index, kind, fetch_entry, required_models)
       VALUES (?, '{}', ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      opts.status,
      opts.workerId ?? null,
      opts.lastWorkerId ?? null,
      toSqliteTimestamp(new Date()),
      opts.startedAt ? toSqliteTimestamp(opts.startedAt) : null,
      opts.signature ?? null,
      opts.parentId ?? null,
      opts.splitIndex ?? null,
      opts.kind ?? "prompt",
      opts.fetchEntry ?? null,
      JSON.stringify(opts.requiredModels ?? [])
    )
    .run();
  return id;
}

// ---------------------------------------------------------------------------
// 2026-09-19 model_fetch (spec §7/§9) -- ports the model_fetch cases from
// tests/server/test_agent_ws.py.

/** Create a queued `kind=model_fetch` job the way `model_fetch.createFetchJob`
 * does, and return `[jobId, fetchEntry]`. Signed with the platform key so the
 * entry that comes back out of the push is byte-identical to the one stored
 * -- the agent verifies it. */
async function makeModelFetchJob(
  name: string,
  opts: { directory?: string; sizeBytes?: number; unverified?: boolean } = {}
): Promise<[string, Record<string, unknown>]> {
  const directory = opts.directory ?? "vae";
  const sizeBytes = opts.sizeBytes ?? 335_000_000;
  const url = `https://huggingface.co/x/resolve/main/${name}`;
  const seed = await resolvePlatformSeed(db(), (env as any).PLATFORM_ED25519_SEED);

  let entry: Record<string, unknown>;
  if (opts.unverified === false) {
    const sha256 = "ab".repeat(32);
    entry = {
      name,
      directory,
      url,
      backup_url: null,
      sha256,
      size_bytes: sizeBytes,
      sig: await signHex(seed, new TextEncoder().encode(`${name}|${directory}|${sha256}|${sizeBytes}`)),
    };
  } else {
    entry = (await modelFetch.signUnverifiedEntry(seed, {
      name,
      directory,
      url,
      sizeBytes,
    })) as unknown as Record<string, unknown>;
  }

  const jobId = await makeJob({
    status: "queued",
    kind: "model_fetch",
    fetchEntry: JSON.stringify(entry),
    requiredModels: [name],
  });
  return [jobId, entry];
}

/** A connected, idle, fetch-capable agent -- the cloud twin of
 * test_agent_ws.py's `_fetch_ready_worker` + `_hello_and_idle`. */
async function connectFetchReadyAgent(protocol: number): Promise<{ ws: WebSocket; workerId: string }> {
  const kp = KEYPAIRS[0]!;
  const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
  const ws = await connectAgent(workerId, kp.seed_hex);
  ws.send(
    JSON.stringify({
      type: "hello",
      hardware: { max_fetch_gb: 100 },
      backend: "cuda",
      torch_version: "",
      node_classes: [],
      protocol,
      auto_fetch: true,
    })
  );
  ws.send(
    JSON.stringify({
      type: "heartbeat",
      state: "idle",
      progress: 0.0,
      job_id: null,
      dynamic: { free_disk_gb: 100.0 },
    })
  );
  // Let the hello/heartbeat writes land before the alarm reads the row.
  await new Promise((r) => setTimeout(r, 50));
  return { ws, workerId };
}

describe("model_fetch dispatch (spec §7)", () => {
  it("pushes the job with kind=model_fetch and its own unverified entry", async () => {
    const { ws } = await connectFetchReadyAgent(5);
    const [jobId, entry] = await makeModelFetchJob("unknown_vae.safetensors");

    const pushedPromise = nextMessage(ws);
    expect(await runDurableObjectAlarm(hub())).toBe(true);

    const pushed = await pushedPromise;
    expect(pushed.type).toBe("job");
    expect(pushed.job_id).toBe(jobId);
    expect(pushed.kind).toBe("model_fetch");
    expect(pushed.workflow_json).toBe("{}");
    expect(pushed.input_assets).toEqual([]);
    expect(pushed.fetch_models).toEqual([entry]);
    ws.close();
  });

  it("leaves a prompt job's push shape untouched (no kind key)", async () => {
    // 純加法：普通 prompt 單的推送形狀一個位元都不能變。
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    const jobId = await makeJob({ status: "queued" });

    const pushedPromise = nextMessage(ws);
    await runDurableObjectAlarm(hub());

    const pushed = await pushedPromise;
    expect(pushed.job_id).toBe(jobId);
    expect("kind" in pushed).toBe(false);
    ws.close();
  });

  it("does not dispatch an unverified entry to a protocol-4 agent", async () => {
    // 未驗證來源項目要 protocol>=5；舊 agent 連被派工都不該發生，單子留在 queued。
    const { ws } = await connectFetchReadyAgent(4);
    const [jobId] = await makeModelFetchJob("unknown_vae.safetensors");

    await runDurableObjectAlarm(hub());
    await expectNoMessage(ws, 100);

    expect((await getJobById(db(), jobId))!.status).toBe("queued");
    ws.close();
  });

  for (const [protocol, pushed] of [[3, false], [4, false], [5, true]] as [number, boolean][]) {
    it(`${pushed ? "dispatches" : "refuses"} a VERIFIED-entry model_fetch job at protocol ${protocol}`, async () => {
      // Final-review I1: a model_fetch job whose entry is VERIFIED leaves the
      // tick's `unverifiedModels` empty, so the entry-keyed gate cannot fire
      // and the floor would fall back to the protocol>=3 auto-fetch one. A
      // protocol 3/4 agent does not know the `kind` field: it would set
      // `started_at` (spec §8 says never) and run the `{}` placeholder
      // workflow. The job kind is therefore its own gate.
      const { ws } = await connectFetchReadyAgent(protocol);
      const [jobId] = await makeModelFetchJob("unknown_vae.safetensors", { unverified: false });

      if (pushed) {
        const pushedPromise = nextMessage(ws);
        await runDurableObjectAlarm(hub());
        const frame = await pushedPromise;
        expect(frame.job_id).toBe(jobId);
        expect(frame.kind).toBe("model_fetch");
      } else {
        await runDurableObjectAlarm(hub());
        await expectNoMessage(ws, 100);
      }
      expect((await getJobById(db(), jobId))!.status).toBe(pushed ? "assigned" : "queued");
      ws.close();
    });
  }

  it("prefers the real manifest entry over the job's own on a name collision", async () => {
    // `ae.safetensors` 是 curated（有官方核可的 sha256），所以就算單子上存的
    // 是未驗證項目，派工時合併仍以真 manifest 為準。
    const { ws } = await connectFetchReadyAgent(5);
    const [jobId, jobEntry] = await makeModelFetchJob("ae.safetensors");

    const pushedPromise = nextMessage(ws);
    await runDurableObjectAlarm(hub());

    const pushed = await pushedPromise;
    expect(pushed.job_id).toBe(jobId);
    const entry = pushed.fetch_models[0];
    expect(entry).not.toEqual(jobEntry);
    expect(entry.unverified).not.toBe(true);
    expect(entry.sha256).toHaveLength(64);
    ws.close();
  });
});

describe("model_fetch job_done (spec §9)", () => {
  it("learns the reported hash, mints an unbilled receipt, and records no stats", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 5 }));

    const seed = await resolvePlatformSeed(db(), (env as any).PLATFORM_ED25519_SEED);
    const entry = await modelFetch.signUnverifiedEntry(seed, {
      name: "unknown_vae.safetensors",
      directory: "vae",
      url: "https://huggingface.co/x/resolve/main/unknown_vae.safetensors",
      sizeBytes: 335_000_000,
    });
    // The agent never sets `started_at` for a model_fetch job (the whole job
    // is spent in `fetching_models`), so this row has none either.
    const jobId = await makeJob({
      status: "running",
      workerId,
      kind: "model_fetch",
      fetchEntry: JSON.stringify(entry),
      requiredModels: ["unknown_vae.safetensors"],
    });

    const receiptMsg = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "job_done",
        job_id: jobId,
        result_files: [],
        exec_seconds: 0,
        fetched_models: [
          {
            name: "unknown_vae.safetensors",
            directory: "vae",
            size_bytes: entry.size_bytes,
            sha256: "ab".repeat(32),
          },
          // Not in this job's required_models -- a worker must not be able to
          // teach the platform hashes for anything it likes just because it
          // finished one fetch.
          { name: "not-in-job", directory: "", size_bytes: 1, sha256: "cd".repeat(32) },
          { name: "unknown_vae.safetensors", size_bytes: -1, sha256: "zz".repeat(32) },
          // Untrusted shapes that must be dropped, not crash the handler.
          { name: ["unknown_vae.safetensors"], size_bytes: 1, sha256: "ab".repeat(32) },
          { name: "unknown_vae.safetensors", size_bytes: true, sha256: "ab".repeat(32) },
          { name: "unknown_vae.safetensors", size_bytes: 5, sha256: "AB".repeat(32) },
          "not-even-a-dict",
        ],
      })
    );

    const receipt = await receiptMsg;
    expect(receipt.type).toBe("receipt");
    expect(receipt.kind).toBe("model_fetch");
    expect(receipt.billable).toBe(false);
    expect(receipt.basis).toBe("model_fetch");
    expect(receipt.payload).toBe(`${jobId}|${workerId}|0.0`);

    const hashes = await db().prepare("SELECT * FROM model_hashes").all<any>();
    expect(hashes.results).toHaveLength(1);
    expect(hashes.results[0].name).toBe("unknown_vae.safetensors");
    expect(hashes.results[0].sha256).toBe("ab".repeat(32));
    expect(hashes.results[0].size_bytes).toBe(entry.size_bytes);

    const receipts = await getReceiptsForJob(db(), jobId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.gpuSeconds).toBe(0);

    expect((await getJobById(db(), jobId))!.status).toBe("done");
    const stats = await db().prepare("SELECT COUNT(*) AS n FROM worker_job_stats").first<any>();
    expect(stats.n).toBe(0);
    ws.close();
  });

  it("ignores fetched_models reported for an ordinary prompt job", async () => {
    // 普通 prompt 單就算回報 fetched_models 也不學 -- 只有 model_fetch 單的
    // 回報算數（spec §9）。
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 5 }));

    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(Date.now() - 10_000) });
    const receiptMsg = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "job_done",
        job_id: jobId,
        result_files: [],
        exec_seconds: 1.0,
        fetched_models: [{ name: "whatever.safetensors", size_bytes: 1, sha256: "ab".repeat(32) }],
      })
    );

    const receipt = await receiptMsg;
    expect(receipt.kind).toBe("completed");
    expect(receipt.billable).toBe(true);

    const hashes = await db().prepare("SELECT COUNT(*) AS n FROM model_hashes").first<any>();
    expect(hashes.n).toBe(0);
    ws.close();
  });
});

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
  // The hello is processed by the DO asynchronously after the frame lands;
  // a fixed wait (the old `expectNoMessage(ws, 300)` doubled as the delay)
  // is load-sensitive -- it failed once in a fresh-clone ci-build right
  // after `npm ci`, and passed 3/3 in isolation. Poll the row instead.
  async function waitForHardware(
    workerId: string,
    ready: (hardware: Record<string, unknown>) => boolean,
    timeoutMs = 3000
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    let last: Record<string, unknown> = {};
    while (Date.now() < deadline) {
      const row = await db().prepare("SELECT hardware FROM workers WHERE id = ?").bind(workerId).first<{ hardware: string }>();
      last = row?.hardware ? (JSON.parse(row.hardware) as Record<string, unknown>) : {};
      if (ready(last)) return last;
      await new Promise((r) => setTimeout(r, 50));
    }
    return last; // let the caller's expect() report the actual final state
  }

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
    await none; // still asserts hello draws no reply frame

    const hardware = await waitForHardware(workerId, (h) => h.peer_upload_min_mbps !== undefined);
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
      // `landed: 1` is a marker: the negative assertion below is only
      // meaningful once THIS hello has been processed -- without it, an
      // unprocessed hello leaves `{}` and "no property" passes vacuously.
      const msg: Record<string, unknown> = { type: "hello", protocol: 4, hardware: { landed: 1 } };
      if (bad !== undefined) msg.peer_upload_min_mbps = bad;
      ws.send(JSON.stringify(msg));
      await none;

      const hardware = await waitForHardware(workerId, (h) => h.landed === 1);
      expect(hardware.landed).toBe(1);
      expect(hardware).not.toHaveProperty("peer_upload_min_mbps");
      ws.close();
    }
  });

  // Phase 3.1 P2P seeder advertisement -- ports agentws.py's _parse_peer_url
  // test coverage.
  it("stores a valid http(s) peer_url", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    // Phase 3.4 §4.3: hello now always answers with one peer_status once the
    // reachability check finishes (a private peer_url is rejected statically,
    // so this one is `reachable: false` without any probe).
    const status = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://192.168.1.5:8850" }));
    expect((await status).type).toBe("peer_status");

    let row: { peer_url: string | null; protocol: number } | null = null;
    for (const deadline = Date.now() + 3000; Date.now() < deadline; ) {
      row = await db().prepare("SELECT peer_url, protocol FROM workers WHERE id = ?").bind(workerId).first<{ peer_url: string | null; protocol: number }>();
      if (row?.peer_url) break;
      await new Promise((r) => setTimeout(r, 50));
    }
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

  it("does not record stats for a split child (final-review I1)", async () => {
    // 子 job 繼承父 job 的 signature，卻只跑 1/k 批。收它的 exec_seconds 會把
    // 這個簽章的 EWMA 拉到實際全批時間的 1/k，speed_index 也跟著被拉偏。
    // 後續：幫子 job 算一個含切片長度的自己的簽章。與 agentws._record_job_stats 同步。
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const parentId = await makeJob({ status: "queued", signature: "sig" });
    const childId = await makeJob({
      status: "running",
      workerId,
      startedAt: new Date(Date.now() - 60_000),
      signature: "sig",
      parentId,
      splitIndex: 0,
    });

    const receiptMsg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "job_done", job_id: childId, result_files: ["a.png"], exec_seconds: 12.5 }));
    expect((await receiptMsg).type).toBe("receipt");

    const count = await db().prepare("SELECT COUNT(*) AS n FROM worker_job_stats").first<any>();
    expect(count.n).toBe(0);
    const worker = await db().prepare("SELECT speed_index FROM workers WHERE id = ?").bind(workerId).first<any>();
    expect(worker.speed_index).toBe(1.0);
    ws.close();
  });

  it("still records stats for a plain job (final-review I1 control)", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    ws.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const jobId = await makeJob({
      status: "running",
      workerId,
      startedAt: new Date(Date.now() - 60_000),
      signature: "sig",
    });

    const receiptMsg = nextMessage(ws);
    ws.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: ["a.png"], exec_seconds: 12.5 }));
    expect((await receiptMsg).type).toBe("receipt");

    const row = await db()
      .prepare("SELECT ewma_seconds, samples FROM worker_job_stats WHERE worker_id = ? AND signature = 'sig'")
      .bind(workerId)
      .first<any>();
    expect(row.ewma_seconds).toBeCloseTo(12.5, 10);
    expect(row.samples).toBe(1);
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


// ---------------------------------------------------------------------------
// Phase 3.3 §3.4/§3.6: split families through the real Hub DO
//
// Ports tests/server/test_agent_ws.py's split-cancel/derivation block. The
// three derivation hook sites live in hub.ts's own handlers (heartbeat ->
// running, job_done, job_failed), NOT in dispatch.ts's mark* -- hub writes
// through `queries` directly -- so they can only be covered from here.

describe("split families (§3.4/§3.6)", () => {
  /** Parent + one running child per worker. Written straight to D1 rather
   * than produced by a real tick: this block pins what happens to an
   * ALREADY-split family, and the splitting itself is covered by
   * split.spec.ts / dispatch.spec.ts. */
  async function makeSplitFamily(workerIds: (string | null)[]): Promise<{ parentId: string; childIds: string[] }> {
    const parentId = uniqueId("parent");
    await db()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, input_assets, split_count, split_plan)
         VALUES (?, '{}', 'running', ?, '[]', ?, ?)`
      )
      .bind(
        parentId,
        toSqliteTimestamp(new Date()),
        workerIds.length,
        JSON.stringify({ source_node_id: "1", batch_size: 2 })
      )
      .run();

    const childIds: string[] = [];
    for (let index = 0; index < workerIds.length; index++) {
      const childId = `${parentId}-c${index}`;
      childIds.push(childId);
      await db()
        .prepare(
          `INSERT INTO jobs (id, workflow_json, status, worker_id, created_at, input_assets, parent_id, split_index)
           VALUES (?, '{}', ?, ?, ?, '[]', ?, ?)`
        )
        .bind(
          childId,
          workerIds[index] ? "running" : "queued",
          workerIds[index] ?? null,
          toSqliteTimestamp(new Date()),
          parentId,
          index
        )
        .run();
    }
    return { parentId, childIds };
  }

  async function cancelViaHub(jobId: string, reason = "cancelled by admin"): Promise<any> {
    const res = await hub().fetch("http://hub.internal/internal/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ job_id: jobId, reason }),
    });
    expect(res.ok).toBe(true);
    return res.json();
  }

  it("cancelling the parent tells EVERY child's worker", async () => {
    // Review fix 1: the sibling cascade inside the first child's cancel used
    // to swallow the other owners, so only one of k workers ever heard about
    // it and the rest rendered to completion for nothing.
    const [kpA, kpB] = [KEYPAIRS[0]!, KEYPAIRS[1]!];
    const workerA = await makeWorker({ pubkeyHex: kpA.pubkey_hex });
    const workerB = await makeWorker({ pubkeyHex: kpB.pubkey_hex });
    const { parentId, childIds } = await makeSplitFamily([workerA, workerB]);

    const wsA = await connectAgent(workerA, kpA.seed_hex);
    const wsB = await connectAgent(workerB, kpB.seed_hex);
    // protocol 2 -> job_cancelled is deliverable at all (a protocol-1
    // connection never receives it; see "never sends job_cancelled to a
    // protocol-1 connection"). Draws no reply frame to drain.
    wsA.send(JSON.stringify({ type: "hello", protocol: 2 }));
    wsB.send(JSON.stringify({ type: "hello", protocol: 2 }));
    // The hello is processed by the DO asynchronously after the frame lands,
    // and the cancel below arrives over a SEPARATE (HTTP) path -- so settle
    // first, or the push can be suppressed as protocol-1.
    await expectNoMessage(wsA, 150);
    await expectNoMessage(wsB, 150);
    try {
      // Listeners attached BEFORE the trigger (see collectMessages' docstring).
      const gotA = nextMessage(wsA);
      const gotB = nextMessage(wsB);

      await cancelViaHub(parentId);

      expect(await gotA).toEqual({ type: "job_cancelled", job_id: childIds[0] });
      expect(await gotB).toEqual({ type: "job_cancelled", job_id: childIds[1] });
    } finally {
      wsA.close();
      wsB.close();
    }

    const parent = (await getJobById(db(), parentId))!;
    expect(parent.status).toBe("cancelled");
    for (const [index, childId] of childIds.entries()) {
      const child = (await getJobById(db(), childId))!;
      expect(child.status).toBe("cancelled");
      // 串聯掉的兄弟帶的是這次取消的理由，不是「sibling cancelled」。
      expect(child.error).toBe("cancelled by admin");
      expect(child.workerId).toBeNull();
      expect(child.lastWorkerId).toBe(index === 0 ? workerA : workerB);
    }
  });

  it("a busy heartbeat on a child moves the parent to running", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const { parentId, childIds } = await makeSplitFamily([workerId, null]);
    // The child must be `assigned` for the running transition to fire.
    await db().prepare("UPDATE jobs SET status = 'assigned' WHERE id = ?").bind(childIds[0]).run();
    await db().prepare("UPDATE jobs SET status = 'assigned' WHERE id = ?").bind(parentId).run();

    const ws = await connectAgent(workerId, kp.seed_hex);
    try {
      ws.send(
        JSON.stringify({ type: "heartbeat", state: "busy", progress: 0.0, job_id: childIds[0], dynamic: {} })
      );
      await expectNoMessage(ws, 200);
    } finally {
      ws.close();
    }

    expect((await getJobById(db(), childIds[0]!))!.status).toBe("running");
    expect((await getJobById(db(), parentId))!.status).toBe("running");
  });

  it("the parent turns done only once every child is done, and collects their outputs", async () => {
    const [kpA, kpB] = [KEYPAIRS[0]!, KEYPAIRS[1]!];
    const workerA = await makeWorker({ pubkeyHex: kpA.pubkey_hex });
    const workerB = await makeWorker({ pubkeyHex: kpB.pubkey_hex });
    const { parentId, childIds } = await makeSplitFamily([workerA, workerB]);

    const wsA = await connectAgent(workerA, kpA.seed_hex);
    try {
      const receiptA = nextMessage(wsA);
      wsA.send(JSON.stringify({ type: "job_done", job_id: childIds[0], result_files: ["a.png"] }));
      // job_done mints and pushes a completed receipt -- drain it, which also
      // synchronises on the handler having finished.
      expect((await receiptA).type).toBe("receipt");
    } finally {
      wsA.close();
    }
    expect((await getJobById(db(), parentId))!.status).toBe("running");

    const wsB = await connectAgent(workerB, kpB.seed_hex);
    try {
      const receiptB = nextMessage(wsB);
      wsB.send(JSON.stringify({ type: "job_done", job_id: childIds[1], result_files: ["b.png"] }));
      expect((await receiptB).type).toBe("receipt");
    } finally {
      wsB.close();
    }

    const parent = (await getJobById(db(), parentId))!;
    expect(parent.status).toBe("done");
    expect(parent.progress).toBe(1);
    // 父 job 自己沒有 result_files；輸出由 parentOutputs 依 split_index 串起來。
    expect(parent.resultFiles).toEqual([]);
    expect(await split.parentOutputs(db(), parent)).toEqual([
      [childIds[0], "a.png"],
      [childIds[1], "b.png"],
    ]);
  });

  it("a failed child fails the parent, cancels the sibling and tells its worker", async () => {
    const [kpA, kpB] = [KEYPAIRS[0]!, KEYPAIRS[1]!];
    const workerA = await makeWorker({ pubkeyHex: kpA.pubkey_hex });
    const workerB = await makeWorker({ pubkeyHex: kpB.pubkey_hex });
    const { parentId, childIds } = await makeSplitFamily([workerA, workerB]);

    const wsB = await connectAgent(workerB, kpB.seed_hex);
    const wsA = await connectAgent(workerA, kpA.seed_hex);
    wsA.send(JSON.stringify({ type: "hello", protocol: 2 }));
    wsB.send(JSON.stringify({ type: "hello", protocol: 2 }));
    try {
      const gotB = nextMessage(wsB);
      wsA.send(JSON.stringify({ type: "job_failed", job_id: childIds[0], error: "CUDA OOM" }));
      expect(await gotB).toEqual({ type: "job_cancelled", job_id: childIds[1] });
    } finally {
      wsA.close();
      wsB.close();
    }

    const parent = (await getJobById(db(), parentId))!;
    expect(parent.status).toBe("failed");
    expect(parent.error).toBe("子任務 1/2：CUDA OOM");
    const sibling = (await getJobById(db(), childIds[1]!))!;
    expect(sibling.status).toBe("cancelled");
    expect(sibling.error).toBe("sibling failed");
    expect(sibling.workerId).toBeNull();
    expect(sibling.lastWorkerId).toBe(workerB);
  });

  it("a failed child's cascade-cancelled sibling gets a cancelled receipt", async () => {
    // 一致性裁決：被**失敗**連坐取消的兄弟，如果取消當下正在跑，也要拿到一張
    // non-billable 的 `cancelled` 收據 —— 和取消父 job 那條路徑同一個 helper、
    // 同一個 wall-clock 基準。失敗的那一個自己照舊拿 `failed` 收據。
    const [kpA, kpB] = [KEYPAIRS[0]!, KEYPAIRS[1]!];
    const workerA = await makeWorker({ pubkeyHex: kpA.pubkey_hex });
    const workerB = await makeWorker({ pubkeyHex: kpB.pubkey_hex });
    const { parentId, childIds } = await makeSplitFamily([workerA, workerB]);
    // makeSplitFamily 直接寫 DB，沒有 started_at；沒有它兩邊都不算「真的燒過
    // GPU」，收據語意就不成立。
    const startedAt = toSqliteTimestamp(new Date(Date.now() - 3_600_000));
    for (const childId of childIds) {
      await db().prepare("UPDATE jobs SET started_at = ? WHERE id = ?").bind(startedAt, childId).run();
    }

    const wsB = await connectAgent(workerB, kpB.seed_hex);
    const wsA = await connectAgent(workerA, kpA.seed_hex);
    wsA.send(JSON.stringify({ type: "hello", protocol: 2 }));
    wsB.send(JSON.stringify({ type: "hello", protocol: 2 }));
    try {
      // 兩個 frame（job_cancelled 然後 receipt）要用同一個 listener 收，
      // 連續兩次 nextMessage 會把空隙裡到達的那個弄丟（見 helpers/ws.ts）。
      const gotB = collectMessages(wsB, 2);
      const gotA = nextMessage(wsA);
      wsA.send(JSON.stringify({ type: "job_failed", job_id: childIds[0], error: "CUDA OOM" }));

      const framesB = await gotB;
      expect(framesB[0]).toEqual({ type: "job_cancelled", job_id: childIds[1] });
      expect(framesB[1].type).toBe("receipt");
      expect(framesB[1].kind).toBe("cancelled");
      expect(framesB[1].billable).toBe(false);
      expect(framesB[1].basis).toBe("wall");
      // 失敗的那一個：照舊是 failed 收據，一行都沒變。
      const frameA = await gotA;
      expect(frameA.type).toBe("receipt");
      expect(frameA.kind).toBe("failed");
      expect(frameA.billable).toBe(false);
    } finally {
      wsA.close();
      wsB.close();
    }

    const failedReceipts = await getReceiptsForJob(db(), childIds[0]!);
    expect(failedReceipts).toHaveLength(1);
    expect(failedReceipts[0]!.kind).toBe("failed");
    expect(failedReceipts[0]!.workerId).toBe(workerA);

    const siblingReceipts = await getReceiptsForJob(db(), childIds[1]!);
    expect(siblingReceipts).toHaveLength(1);
    expect(siblingReceipts[0]!.kind).toBe("cancelled");
    expect(siblingReceipts[0]!.billable).toBe(false);
    expect(siblingReceipts[0]!.workerId).toBe(workerB);
    expect(siblingReceipts[0]!.gpuSeconds).toBeGreaterThan(0);
    // 父 job 自己從來沒有 started_at -> 零張。
    expect(await getReceiptsForJob(db(), parentId)).toHaveLength(0);
  });

  it("a child's heartbeat progress drives the parent's progress (§3.4 mean)", async () => {
    const [kpA, kpB] = [KEYPAIRS[0]!, KEYPAIRS[1]!];
    const workerA = await makeWorker({ pubkeyHex: kpA.pubkey_hex });
    const workerB = await makeWorker({ pubkeyHex: kpB.pubkey_hex });
    const { parentId, childIds } = await makeSplitFamily([workerA, workerB]);

    const wsA = await connectAgent(workerA, kpA.seed_hex);
    try {
      wsA.send(
        JSON.stringify({ type: "heartbeat", state: "busy", progress: 0.2, job_id: childIds[0], dynamic: {} })
      );
      await expectNoMessage(wsA, 200);
    } finally {
      wsA.close();
    }

    const wsB = await connectAgent(workerB, kpB.seed_hex);
    try {
      wsB.send(
        JSON.stringify({ type: "heartbeat", state: "busy", progress: 0.6, job_id: childIds[1], dynamic: {} })
      );
      await expectNoMessage(wsB, 200);
    } finally {
      wsB.close();
    }

    expect((await getJobById(db(), parentId))!.progress).toBeCloseTo(0.4, 10);
  });
});

describe("Phase 3.4: ready.remote_ip and hello NAT fields", () => {
  it("ready carries CF-Connecting-IP", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await openAgentWs({ "CF-Connecting-IP": "203.0.113.7" });
    const challenge = await nextMessage(ws);
    const sig = await signHex(kp.seed_hex, new TextEncoder().encode(challenge.nonce));
    ws.send(JSON.stringify({ type: "auth", worker_id: workerId, sig }));
    const ready = await nextMessage(ws);
    expect(ready.type).toBe("ready");
    expect(ready.remote_ip).toBe("203.0.113.7");
    ws.close();
  });

  it("hello stores peer_lan_url, peer_nat and remote_ip", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await openAgentWs({ "CF-Connecting-IP": "203.0.113.7" });
    const challenge = await nextMessage(ws);
    const sig = await signHex(kp.seed_hex, new TextEncoder().encode(challenge.nonce));
    ws.send(JSON.stringify({ type: "auth", worker_id: workerId, sig }));
    await nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 4,
        peer_url: "http://203.0.113.7:8850",
        peer_lan_url: "http://192.168.1.5:8850",
        peer_nat: "upnp",
      })
    );
    await expectNoMessage(ws, 300);
    const row = await db()
      .prepare("SELECT peer_url, peer_lan_url, peer_nat, remote_ip FROM workers WHERE id = ?")
      .bind(workerId)
      .first<any>();
    expect(row.peer_url).toBe("http://203.0.113.7:8850");
    expect(row.peer_lan_url).toBe("http://192.168.1.5:8850");
    expect(row.peer_nat).toBe("upnp");
    expect(row.remote_ip).toBe("203.0.113.7");
    ws.close();
  });

  it("an old agent's hello defaults peer_lan_url to null and peer_nat to lan", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const ws = await connectAgent(workerId, kp.seed_hex);
    const status = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://192.168.1.9:8850" }));
    // Phase 3.4 §4.3: the hello-triggered check always answers once.
    expect((await status).type).toBe("peer_status");
    const row = await db()
      .prepare("SELECT peer_lan_url, peer_nat FROM workers WHERE id = ?")
      .bind(workerId)
      .first<any>();
    expect(row.peer_lan_url).toBeNull();
    expect(row.peer_nat).toBe("lan");
    ws.close();
  });
});

describe("Phase 3.4: reachability check on hello and heartbeat", () => {
  it("probes the advertised peer_url after hello and pushes peer_status", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const ws = await connectAgent(workerId, kp.seed_hex);

    const status = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 4,
        peer_url: "http://203.0.113.7:8850",
        peer_lan_url: "http://192.168.1.5:8850",
        peer_nat: "natpmp",
      })
    );

    expect(await status).toEqual({
      type: "peer_status",
      reachable: true,
      checked_url: "http://203.0.113.7:8850/peer/health",
    });
    expect(probe).toHaveBeenCalledWith("http://203.0.113.7:8850/peer/health");
    const row = await db().prepare("SELECT peer_reachable FROM workers WHERE id = ?").bind(workerId).first<any>();
    expect(row.peer_reachable).toBe(1);
    ws.close();
    vi.restoreAllMocks();
  });

  it("marks a private peer_url unreachable without probing", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const ws = await connectAgent(workerId, kp.seed_hex);

    const status = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://192.168.1.5:8850" }));

    expect((await status).reachable).toBe(false);
    expect(probe).not.toHaveBeenCalled();
    ws.close();
    vi.restoreAllMocks();
  });

  it("rechecks on heartbeat once peer_checked_at is older than 10 minutes, pushing only on a changed verdict", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const ws = await connectAgent(workerId, kp.seed_hex);
    const hello = nextMessage(ws);
    ws.send(JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://203.0.113.7:8850" }));
    expect((await hello).reachable).toBe(true);

    const checkedAt = async () =>
      (await db().prepare("SELECT peer_checked_at FROM workers WHERE id = ?").bind(workerId).first<any>())
        .peer_checked_at as string;
    const backdate = async (minutes: number) => {
      const stale = toSqliteTimestamp(new Date(Date.now() - minutes * 60 * 1000));
      await db().prepare("UPDATE workers SET peer_checked_at = ? WHERE id = ?").bind(stale, workerId).run();
      return stale;
    };

    // A fresh verdict is not rechecked at all.
    const fresh = await checkedAt();
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle" }));
    await expectNoMessage(ws, 300);
    expect(await checkedAt()).toBe(fresh);

    // Older than 10 minutes but the same verdict: rechecked (timestamp moves),
    // silent (ruling).
    const stale = await backdate(11);
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle" }));
    await expectNoMessage(ws, 300);
    await waitFor(async () => ((await checkedAt()) !== stale ? true : undefined), {
      label: "peer_checked_at refreshed by the heartbeat recheck",
    });

    // Verdict flips: one push.
    probe.mockResolvedValue(false);
    await backdate(11);
    const changed = nextMessage(ws);
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle" }));
    expect(await changed).toEqual({
      type: "peer_status",
      reachable: false,
      checked_url: "http://203.0.113.7:8850/peer/health",
    });
    ws.close();
    vi.restoreAllMocks();
  });
});

describe("Phase 3.4 fix round 1: advert normalization and probe gating", () => {
  it("stores peer_url/peer_lan_url as scheme://host[:port]", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const ws = await connectAgent(workerId, kp.seed_hex);

    const status = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 4,
        peer_url: "http://admin:secret@203.0.113.7:8850/some/path?q=1#frag",
        peer_lan_url: "http://192.168.1.5:8850/",
      })
    );
    await status;

    const row = await db()
      .prepare("SELECT peer_url, peer_lan_url FROM workers WHERE id = ?")
      .bind(workerId)
      .first<any>();
    expect(row.peer_url).toBe("http://203.0.113.7:8850");
    expect(row.peer_lan_url).toBe("http://192.168.1.5:8850");
    ws.close();
    vi.restoreAllMocks();
  });

  it("drops the scheme's default port from the advert urls (parity with `_normalize_advert_url`)", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const ws = await connectAgent(workerId, kp.seed_hex);

    const status = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 4,
        peer_url: "https://203.0.113.7:443/",
        peer_lan_url: "http://192.168.1.5:80/",
      })
    );
    await status;

    const row = await db()
      .prepare("SELECT peer_url, peer_lan_url FROM workers WHERE id = ?")
      .bind(workerId)
      .first<any>();
    expect(row.peer_url).toBe("https://203.0.113.7");
    expect(row.peer_lan_url).toBe("http://192.168.1.5");
    ws.close();
    vi.restoreAllMocks();
  });

  it("probes once for repeated identical advertisements, replaying the stored verdict", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const hello = JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://203.0.113.7:8850" });

    const first = await connectAgent(workerId, kp.seed_hex);
    const status = nextMessage(first);
    first.send(hello);
    expect((await status).type).toBe("peer_status");
    first.close();

    // A reconnect advertising the SAME endpoint does not probe again (the
    // 10-minute heartbeat cadence re-verifies), but the stored verdict is
    // replayed straight away so a restarted agent isn't left on "unknown"
    // (fix round 2).
    const second = await connectAgent(workerId, kp.seed_hex);
    const replayed = nextMessage(second);
    second.send(hello);
    expect(await replayed).toEqual({
      type: "peer_status",
      reachable: true,
      checked_url: "http://203.0.113.7:8850/peer/health",
    });
    second.close();

    expect(probe).toHaveBeenCalledTimes(1);
    const row = await db().prepare("SELECT peer_reachable FROM workers WHERE id = ?").bind(workerId).first<any>();
    expect(row.peer_reachable).toBe(1);
    vi.restoreAllMocks();
  });

  it("replays a stored unreachable verdict, and stays silent when there is none", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const hello = JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://203.0.113.7:8850" });
    await db()
      .prepare("UPDATE workers SET peer_url = ?, peer_reachable = 0, peer_checked_at = ? WHERE id = ?")
      .bind("http://203.0.113.7:8850", toSqliteTimestamp(new Date()), workerId)
      .run();

    const ws = await connectAgent(workerId, kp.seed_hex);
    const replayed = nextMessage(ws);
    ws.send(hello);
    expect(await replayed).toEqual({
      type: "peer_status",
      reachable: false,
      checked_url: "http://203.0.113.7:8850/peer/health",
    });
    ws.close();

    // Verdict cleared (e.g. the stale sweep just ran): nothing to replay, and
    // the address did not change either -- so nothing is sent and nothing is
    // probed.
    await db().prepare("UPDATE workers SET peer_reachable = NULL WHERE id = ?").bind(workerId).run();
    const quiet = await connectAgent(workerId, kp.seed_hex);
    const none = expectNoMessage(quiet, 400);
    quiet.send(hello);
    await none;
    quiet.close();

    expect(probe).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("re-probes and resets the verdict when the advertised peer_url changes", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);

    const first = await connectAgent(workerId, kp.seed_hex);
    const firstStatus = nextMessage(first);
    first.send(JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://203.0.113.7:8850" }));
    await firstStatus;
    first.close();

    const second = await connectAgent(workerId, kp.seed_hex);
    const secondStatus = nextMessage(second);
    second.send(JSON.stringify({ type: "hello", protocol: 4, peer_url: "http://198.51.100.9:8850" }));
    expect((await secondStatus).checked_url).toBe("http://198.51.100.9:8850/peer/health");
    second.close();

    expect(probe).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
});
