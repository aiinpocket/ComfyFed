import { afterEach, describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp, getJobById } from "../src/db/queries";
import { connectAgent, connectPanel, collectMessages, hub, nextMessage, openPanelWs } from "./helpers/ws";
import golden from "./fixtures/golden.json";

// Ports the panel-facing half of tests/server/test_panel_ws.py against the
// real (miniflare) Hub Durable Object -- see do/hub.ts's docstring
// ("Part 2 (Task 7, this pass)") for the panel WS + event relay this
// exercises. Every event this test asserts on is a direct in-DO method call
// triggered from an agent-socket message or an `/internal/*` HTTP call,
// exactly mirroring how agentws.py's handlers call panelws.py's broadcast
// functions.
//
// Every multi-message assertion below uses `collectMessages` (one listener,
// attached before the trigger, gathering N messages) rather than chained
// `await nextMessage(ws)` calls: a DO method that sends several panel
// events back to back can deliver all of them before the test's `await`
// chain gets back around to attaching the NEXT listener, and a message
// dispatched with no listener attached is lost forever, not queued.

function d1(): D1Database {
  return (env as any).DB as D1Database;
}

afterEach(async () => {
  await d1().prepare("DELETE FROM jobs").run();
  await d1().prepare("DELETE FROM workers").run();
  await d1().prepare("DELETE FROM receipts").run();
  await d1().prepare("DELETE FROM nonces").run();
  await d1().prepare("DELETE FROM settings").run();
  await d1().prepare("DELETE FROM users").run();
  await d1().prepare("DELETE FROM login_attempts").run();
});

let idCounter = 0;
function uniqueId(base: string): string {
  idCounter += 1;
  return `${base}-${idCounter}`;
}

const KEYPAIRS = golden.keypairs;
const ADMIN_PASSWORD = "correct-horse-battery-staple";

/** Setup + login, returning a `cf_session=...` cookie pair usable on the
 * panel WS upgrade's `Cookie` header. */
async function loginCookie(): Promise<string> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const r = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  if (!r.setCookie) throw new Error("login did not set a cookie");
  return r.setCookie;
}

async function makeWorker(opts: { pubkeyHex: string; id?: string }): Promise<string> {
  const id = opts.id ?? uniqueId("w");
  await d1()
    .prepare("INSERT INTO workers (id, name, pubkey, created_at, disabled) VALUES (?, ?, ?, ?, 0)")
    .bind(id, id, opts.pubkeyHex, toSqliteTimestamp(new Date()))
    .run();
  return id;
}

async function makeJob(opts: {
  status: string;
  workerId?: string | null;
  startedAt?: Date | null;
  workflowJson?: string;
}): Promise<string> {
  const id = uniqueId("job");
  await d1()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, worker_id, created_at, started_at, input_assets)
       VALUES (?, ?, ?, ?, ?, ?, '[]')`
    )
    .bind(
      id,
      opts.workflowJson ?? "{}",
      opts.status,
      opts.workerId ?? null,
      toSqliteTimestamp(new Date()),
      opts.startedAt ? toSqliteTimestamp(opts.startedAt) : null
    )
    .run();
  return id;
}

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

// ---------------------------------------------------------------------------
// Connect: status + feature_flags frames

describe("panel connect", () => {
  it("sends the initial status frame then an all-false feature_flags frame", async () => {
    const cookie = await loginCookie();
    const ws = await connectPanel(cookie);
    const [status, flags] = await collectMessages(ws, 2);

    expect(status.type).toBe("status");
    expect(status.data.status).toEqual({ exec_info: { queue_remaining: 0 } });
    expect(typeof status.data.sid).toBe("string");
    expect(status.data.sid.length).toBeGreaterThan(0);

    expect(flags).toEqual({
      type: "feature_flags",
      data: {
        assets: false,
        node_replacements: false,
        show_signin_button: false,
        "extension.manager.supports_v4": false,
        "extension.manager.supports_csrf_post": false,
      },
    });

    ws.close();
  });

  it("reflects queued/assigned/running jobs in queue_remaining", async () => {
    await makeJob({ status: "queued" });
    await makeJob({ status: "running" });
    await makeJob({ status: "done" }); // not counted

    const cookie = await loginCookie();
    const ws = await connectPanel(cookie);
    const [status] = await collectMessages(ws, 1);
    expect(status.data.status).toEqual({ exec_info: { queue_remaining: 2 } });
    ws.close();
  });

  it("serves the same handshake at both /comfy/api/ws and /comfy/ws", async () => {
    const cookie = await loginCookie();
    const ws = await connectPanel(cookie, "/comfy/ws");
    const [status] = await collectMessages(ws, 1);
    expect(status.type).toBe("status");
    ws.close();
  });
});

describe("panel connect: unauthenticated", () => {
  it("rejects an upgrade with no session cookie at all", async () => {
    const response = await openPanelWs(null);
    expect(response.status).toBe(401);
    expect(response.webSocket ?? null).toBeNull();
  });

  it("rejects an upgrade with a garbage cookie value", async () => {
    const response = await openPanelWs("cf_session=not-a-valid-token");
    expect(response.status).toBe(401);
  });

  it("rejects an upgrade with an authenticated-shaped but unsigned cookie", async () => {
    // Well-formed `payload.sig` shape, but a signature that can't possibly
    // verify against any secret this server generated.
    const response = await openPanelWs("cf_session=eyJhIjoxfQ.deadbeef");
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Progress + running relay (agent heartbeat -> panel)

describe("progress relay", () => {
  it("relays heartbeat progress to the panel as a progress event", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date() });

    const cookie = await loginCookie();
    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2); // status, feature_flags

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const progressPromise = nextMessage(panel);
    agent.send(JSON.stringify({ type: "heartbeat", state: "idle", job_id: jobId, progress: 0.42 }));
    const progress = await progressPromise;
    expect(progress).toEqual({ type: "progress", data: { value: 42, max: 100, prompt_id: jobId } });

    agent.close();
    panel.close();
  });

  it("relays a busy heartbeat's ownership transition as an executing event", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const jobId = await makeJob({ status: "assigned", workerId });

    const cookie = await loginCookie();
    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const runningPromise = nextMessage(panel);
    agent.send(JSON.stringify({ type: "heartbeat", state: "busy", job_id: jobId }));
    const running = await runningPromise;
    expect(running).toEqual({
      type: "executing",
      data: { node: "comfyfed", prompt_id: jobId, display_node: "comfyfed" },
    });

    agent.close();
    panel.close();
  });
});

// ---------------------------------------------------------------------------
// job_done -> one `executed` event per output node

describe("job_done relay", () => {
  it("emits one executed event per output node (media + text + PreviewAny), then executing:null + status", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const workflow = {
      "5": { class_type: "SaveImage" },
      "7": { class_type: "SaveText" },
      "9": { class_type: "PreviewAny" },
    };
    const jobId = await makeJob({
      status: "running",
      workerId,
      startedAt: new Date(Date.now() - 1000),
      workflowJson: JSON.stringify(workflow),
    });
    await store().put(`artifacts/${jobId}/note.txt`, "hello from the worker");

    const cookie = await loginCookie();
    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2); // status, feature_flags

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    // job_done fans out into 5 panel frames: one `executed` per output node
    // (media "5", SaveText "7", PreviewAny "9"), then executing:null, then a
    // refreshed status -- all attached BEFORE the trigger, per the file
    // docstring.
    const eventsPromise = collectMessages(panel, 5);
    agent.send(
      JSON.stringify({
        type: "job_done",
        job_id: jobId,
        result_files: ["out.png", "note.txt"],
        exec_seconds: 1,
      })
    );
    const [e5, e7, e9, executingNull, status] = await eventsPromise;

    expect(e5).toEqual({
      type: "executed",
      data: {
        prompt_id: jobId,
        output: { images: [{ filename: "out.png", subfolder: jobId, type: "output" }] },
        node: "5",
        display_node: "5",
      },
    });

    expect(e7).toEqual({
      type: "executed",
      data: {
        prompt_id: jobId,
        output: {
          files: [{ filename: "note.txt", subfolder: jobId, type: "output" }],
          text: ["hello from the worker"],
        },
        node: "7",
        display_node: "7",
      },
    });

    expect(e9).toEqual({
      type: "executed",
      data: {
        prompt_id: jobId,
        output: { text: ["hello from the worker"] },
        node: "9",
        display_node: "9",
      },
    });

    expect(executingNull).toEqual({ type: "executing", data: { node: null, prompt_id: jobId } });

    expect(status.type).toBe("status");
    expect(status.data.status).toEqual({ exec_info: { queue_remaining: 0 } });

    const job = await getJobById(d1(), jobId);
    expect(job!.status).toBe("done");

    agent.close();
    panel.close();
  });

  it("falls back to a single FALLBACK_OUTPUT_KEY executed event for a job with no result files", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date() });

    const cookie = await loginCookie();
    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const eventsPromise = collectMessages(panel, 3); // executed, executing:null, status
    agent.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: [], exec_seconds: 1 }));
    const [executed] = await eventsPromise;
    expect(executed).toEqual({
      type: "executed",
      data: { prompt_id: jobId, output: {}, node: "comfyfed", display_node: "comfyfed" },
    });

    agent.close();
    panel.close();
  });
});

// ---------------------------------------------------------------------------
// Cancel relay (/internal/cancel -> panel)

describe("cancel relay", () => {
  it("relays a cancellation as executing:null + a refreshed status", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date() });

    const cookie = await loginCookie();
    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2); // status, feature_flags

    const eventsPromise = collectMessages(panel, 2); // executing:null, status
    const response = await hub().fetch(
      new Request("http://do/internal/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, reason: "admin cancel" }),
      })
    );
    expect(response.status).toBe(200);
    expect((await response.json<{ cancelled: boolean }>()).cancelled).toBe(true);

    const [executingNull, status] = await eventsPromise;
    expect(executingNull).toEqual({ type: "executing", data: { node: null, prompt_id: jobId } });
    expect(status.type).toBe("status");
    expect(status.data.status).toEqual({ exec_info: { queue_remaining: 0 } });

    const job = await getJobById(d1(), jobId);
    expect(job!.status).toBe("cancelled");

    panel.close();
  });

  it("notifies the panel even when the job was never picked up by any worker", async () => {
    // cancel_and_notify parity: the panel is told regardless of ownership --
    // a queued, never-assigned job has no worker to push a job_cancelled
    // to, but the panel's queue badge still needs to drop.
    const jobId = await makeJob({ status: "queued" });

    const cookie = await loginCookie();
    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const eventsPromise = collectMessages(panel, 2);
    const response = await hub().fetch(
      new Request("http://do/internal/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId }),
      })
    );
    expect((await response.json<{ cancelled: boolean }>()).cancelled).toBe(true);

    const [executingNull, status] = await eventsPromise;
    expect(executingNull).toEqual({ type: "executing", data: { node: null, prompt_id: jobId } });
    expect(status.data.status).toEqual({ exec_info: { queue_remaining: 0 } });

    panel.close();
  });
});

// ---------------------------------------------------------------------------
// /internal/event: generic pass-through for callers outside the DO

describe("/internal/event", () => {
  it("broadcasts a {type, data} body verbatim to connected panel clients", async () => {
    const cookie = await loginCookie();
    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const nextPromise = nextMessage(panel);
    const response = await hub().fetch(
      new Request("http://do/internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 7 } } } }),
      })
    );
    expect(response.status).toBe(202);
    const evt = await nextPromise;
    expect(evt).toEqual({ type: "status", data: { status: { exec_info: { queue_remaining: 7 } } } });

    panel.close();
  });

  it("is a no-op (still 202) when the body has no string type", async () => {
    const response = await hub().fetch(
      new Request("http://do/internal/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nope: true }),
      })
    );
    expect(response.status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Alarm re-arm: must key off AGENT connections only, not "any socket"
// (review round 1, M1) -- a lone panel client must never be what keeps the
// 5s dispatch tick alive forever, since it has no work the alarm could
// dispatch. See do/hub.ts's `alarm()` comment for the parity reasoning
// (agentws.py's dispatch loop only ever consults `agentws._connections`,
// which never held panel sockets).

describe("alarm re-arm (agent-kind filter)", () => {
  it("does NOT re-arm when only a panel client is connected (zero agents, zero active jobs)", async () => {
    const cookie = await loginCookie();
    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2); // status, feature_flags

    // Seed an armed alarm directly (as if a previous tick had re-armed it),
    // so this test proves the NEXT run declines to re-arm rather than just
    // observing "never armed in the first place".
    await runInDurableObject(hub(), async (_instance, state) => {
      await state.storage.setAlarm(Date.now() + 5_000);
    });

    const ran = await runDurableObjectAlarm(hub());
    expect(ran).toBe(true);

    const alarmAfter = await runInDurableObject(hub(), (_instance, state) => state.storage.getAlarm());
    expect(alarmAfter).toBeNull();

    panel.close();
  });

  it("DOES re-arm when an agent is connected (even with no panel clients)", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const agent = await connectAgent(workerId, kp.seed_hex); // handshake already arms it once

    const ran = await runDurableObjectAlarm(hub());
    expect(ran).toBe(true);

    const alarmAfter = await runInDurableObject(hub(), (_instance, state) => state.storage.getAlarm());
    expect(alarmAfter).not.toBeNull();

    agent.close();
  });
});
