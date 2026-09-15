import { afterEach, describe, expect, it } from "vitest";
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { toSqliteTimestamp, getJobById } from "../src/db/queries";
import { connectAgent, connectPanel, collectMessages, expectNoMessage, hub, nextMessage, openPanelWs } from "./helpers/ws";
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
 * panel WS upgrade's `Cookie` header, plus the admin's own uid -- Phase 3.0
 * Task 10 scopes every panel-native frame to `origin === "panel" AND
 * user_id === <the connecting session's own uid>` (see `panelVisibleTo` in
 * do/hub.ts), so a directly-inserted test job must be stamped with THIS
 * uid (via `makeJob`'s `userId` option) to be visible on a socket opened
 * with this cookie. */
async function loginCookie(): Promise<{ cookie: string; uid: string; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const r = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  if (!r.setCookie) throw new Error("login did not set a cookie");
  const row = await d1().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>();
  if (!row) throw new Error("admin user row not found after setup");
  return { cookie: r.setCookie, uid: row.id, csrf: r.body.csrf };
}

/** Creates a non-admin `role: "user"` account and logs in as it, returning
 * its own cookie/uid -- Phase 3.0 Task 10's WS frame-filtering isolation
 * tests need a SECOND authenticated panel connection, distinct from
 * `loginCookie()`'s admin, to prove a job-scoped frame reaches only the
 * socket for its own owning user. Requires `loginCookie()` (or another
 * `/api/setup` call) to have already provisioned the admin account this
 * borrows CSRF from. */
async function secondUserCookie(admin: { cookie: string; csrf: string }, username: string): Promise<{ cookie: string; uid: string }> {
  const password = "a-long-enough-password1";
  const created = await call("/api/users", {
    json: { username, role: "user", password },
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
  const login = await call("/api/auth/login", { json: { username, password } });
  if (!login.setCookie) throw new Error("second user login did not set a cookie");
  return { cookie: login.setCookie, uid: created.body.id };
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
  /** Phase 3.0 Task 10: `origin`/`userId` so a job-scoped panel frame's
   * `panelVisibleTo` check finds a match -- default to `"panel"`/`null`
   * (an ownerless legacy-shaped row), NOT visible to any authenticated
   * connection; every test in this file that expects a job's events to
   * reach its panel socket passes `userId: <that socket's own uid>`
   * explicitly (mirroring how a real panel-submitted job is always stamped
   * with its submitter's uid). */
  origin?: string;
  userId?: string | null;
}): Promise<string> {
  const id = uniqueId("job");
  await d1()
    .prepare(
      `INSERT INTO jobs (id, workflow_json, status, worker_id, created_at, started_at, input_assets, origin, user_id)
       VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`
    )
    .bind(
      id,
      opts.workflowJson ?? "{}",
      opts.status,
      opts.workerId ?? null,
      toSqliteTimestamp(new Date()),
      opts.startedAt ? toSqliteTimestamp(opts.startedAt) : null,
      opts.origin ?? "panel",
      opts.userId ?? null
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
    const { cookie } = await loginCookie();
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

    const { cookie } = await loginCookie();
    const ws = await connectPanel(cookie);
    const [status] = await collectMessages(ws, 1);
    expect(status.data.status).toEqual({ exec_info: { queue_remaining: 2 } });
    ws.close();
  });

  it("serves the same handshake at both /comfy/api/ws and /comfy/ws", async () => {
    const { cookie } = await loginCookie();
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
    const { cookie, uid } = await loginCookie();
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(), userId: uid });

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
    const { cookie, uid } = await loginCookie();
    const jobId = await makeJob({ status: "assigned", workerId, userId: uid });

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
    const { cookie, uid } = await loginCookie();
    const jobId = await makeJob({
      status: "running",
      workerId,
      startedAt: new Date(Date.now() - 1000),
      workflowJson: JSON.stringify(workflow),
      userId: uid,
    });
    await store().put(`artifacts/${jobId}/note.txt`, "hello from the worker");

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
    const { cookie, uid } = await loginCookie();
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(), userId: uid });

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
    const { cookie, uid } = await loginCookie();
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(), userId: uid });

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
    const { cookie, uid } = await loginCookie();
    const jobId = await makeJob({ status: "queued", userId: uid });

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
    const { cookie } = await loginCookie();
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
    const { cookie } = await loginCookie();
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

// ---------------------------------------------------------------------------
// Phase 3.0 Task 10: panel WS frame filtering -- `do/hub.ts`'s
// `panelVisibleTo` must scope every job-specific frame (`progress`/
// `executing`/`executed`/`execution_error`) to ONLY the socket for that
// job's own panel origin and user. Every case here binds a SECOND panel
// socket (a non-admin user, via `secondUserCookie`) alongside the admin's,
// and proves the frame reaches the owner's socket while `expectNoMessage`
// proves it does NOT reach the other one -- absence, not just presence, is
// the point of this whole describe block.

describe("panel WS: frame filtering is per-owner (Phase 3.0 Task 10)", () => {
  it("progress: reaches the owning user's socket, never the other user's", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const admin = await loginCookie();
    const other = await secondUserCookie(admin, "alice");
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(), userId: admin.uid });

    const ownerPanel = await connectPanel(admin.cookie);
    await collectMessages(ownerPanel, 2); // status, feature_flags
    const otherPanel = await connectPanel(other.cookie);
    await collectMessages(otherPanel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const ownerAbsence = expectNoMessage(otherPanel, 300);
    const progressPromise = nextMessage(ownerPanel);
    agent.send(JSON.stringify({ type: "heartbeat", state: "idle", job_id: jobId, progress: 0.42 }));
    const progress = await progressPromise;
    expect(progress).toEqual({ type: "progress", data: { value: 42, max: 100, prompt_id: jobId } });
    await ownerAbsence;

    agent.close();
    ownerPanel.close();
    otherPanel.close();
  });

  it("job_done: the 'executed' fan-out reaches only the owner's socket", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const admin = await loginCookie();
    const other = await secondUserCookie(admin, "alice");
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(), userId: admin.uid });

    const ownerPanel = await connectPanel(admin.cookie);
    await collectMessages(ownerPanel, 2);
    const otherPanel = await connectPanel(other.cookie);
    await collectMessages(otherPanel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    // `job_done` fans out into 3 owner frames (executed, executing:null,
    // status) but only the LAST -- the aggregate status refresh, which
    // carries no job identity -- reaches `otherPanel` too (see
    // `panelJobStatusRefresh`); the job-scoped `executed`/`executing` frames
    // must not.
    const ownerEventsPromise = collectMessages(ownerPanel, 3);
    const otherEventsPromise = collectMessages(otherPanel, 1);
    agent.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: [], exec_seconds: 1 }));
    const [executed] = await ownerEventsPromise;
    expect(executed.type).toBe("executed");
    expect(executed.data.prompt_id).toBe(jobId);

    const [otherOnly] = await otherEventsPromise;
    expect(otherOnly.type).toBe("status");

    agent.close();
    ownerPanel.close();
    otherPanel.close();
  });

  it("cancel: 'executing:null' reaches only the owner's socket (aggregate status refresh still broadcasts to both)", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const admin = await loginCookie();
    const other = await secondUserCookie(admin, "alice");
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(), userId: admin.uid });

    const ownerPanel = await connectPanel(admin.cookie);
    await collectMessages(ownerPanel, 2);
    const otherPanel = await connectPanel(other.cookie);
    await collectMessages(otherPanel, 2);

    // The job-scoped `executing:null` frame must not reach `otherPanel`, but
    // the AGGREGATE `status` refresh right after it (no job identity, see
    // `panelJobStatusRefresh`) still broadcasts to every connected socket --
    // so `otherPanel` gets exactly one frame (status), never two.
    const ownerEventsPromise = collectMessages(ownerPanel, 2); // executing:null, status
    const otherEventsPromise = collectMessages(otherPanel, 1); // status only
    const otherNoSecond = new Promise<void>((resolve, reject) => {
      let count = 0;
      const onMessage = () => {
        count += 1;
        if (count > 1) reject(new Error("otherPanel received more than one frame"));
      };
      otherPanel.addEventListener("message", onMessage);
      setTimeout(() => {
        otherPanel.removeEventListener("message", onMessage);
        resolve();
      }, 500);
    });

    const response = await hub().fetch(
      new Request("http://do/internal/cancel", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ job_id: jobId, reason: "admin cancel" }),
      })
    );
    expect((await response.json<{ cancelled: boolean }>()).cancelled).toBe(true);

    const [executingNull, status] = await ownerEventsPromise;
    expect(executingNull).toEqual({ type: "executing", data: { node: null, prompt_id: jobId } });
    expect(status.type).toBe("status");

    const [otherStatus] = await otherEventsPromise;
    expect(otherStatus.type).toBe("status");
    await otherNoSecond;

    ownerPanel.close();
    otherPanel.close();
  });

  it("execution_error (job_failed): reaches only the owning user's socket", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const admin = await loginCookie();
    const other = await secondUserCookie(admin, "alice");
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(), userId: admin.uid });

    const ownerPanel = await connectPanel(admin.cookie);
    await collectMessages(ownerPanel, 2);
    const otherPanel = await connectPanel(other.cookie);
    await collectMessages(otherPanel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    // Same aggregate-vs-job-scoped split as the job_done case above: the
    // job-scoped `execution_error` reaches only the owner; the trailing
    // status refresh reaches both.
    const ownerEventsPromise = collectMessages(ownerPanel, 2); // execution_error, status
    const otherEventsPromise = collectMessages(otherPanel, 1); // status only
    agent.send(JSON.stringify({ type: "job_failed", job_id: jobId, error: "boom", exec_seconds: 0.5 }));
    const [executionError] = await ownerEventsPromise;
    expect(executionError.type).toBe("execution_error");
    expect(executionError.data.prompt_id).toBe(jobId);
    expect(executionError.data.exception_message).toBe("boom");

    const [otherOnly] = await otherEventsPromise;
    expect(otherOnly.type).toBe("status");

    agent.close();
    ownerPanel.close();
    otherPanel.close();
  });

  it("a job with no user_id (pre-Phase-3.0 shaped row) is invisible to any authenticated panel socket", async () => {
    // Fails CLOSED, not open: panelVisibleTo requires origin === "panel" AND
    // user_id === connUid, so a null user_id never matches any real uid.
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const admin = await loginCookie();
    const jobId = await makeJob({ status: "running", workerId, startedAt: new Date(), userId: null });

    const panel = await connectPanel(admin.cookie);
    await collectMessages(panel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const absence = expectNoMessage(panel, 300);
    agent.send(JSON.stringify({ type: "heartbeat", state: "idle", job_id: jobId, progress: 0.5 }));
    await absence;

    agent.close();
    panel.close();
  });

  it("a job-scoped frame for a job id that no longer resolves fails CLOSED, not open (final review finding #5)", async () => {
    // The old rule fell back to an unscoped broadcast when `jobOwner`
    // couldn't resolve a row for a job-identifying frame ("swallowing a
    // real event is worse than a one-off leak") -- reasoning that predates
    // the panel being multi-tenant. Drives the DO's own (otherwise private)
    // `panelJobRunning` directly with a job id that was never inserted,
    // mirroring how the Python suite's `relay(panelws.job_running(...))`
    // exercises the same module-level function without a full HTTP/WS
    // round trip. Proven by ordering: an unscoped `status` refresh issued
    // right after must be the ONLY thing the connected socket receives.
    const admin = await loginCookie();
    const panel = await connectPanel(admin.cookie);
    await collectMessages(panel, 2); // status, feature_flags

    const eventsPromise = collectMessages(panel, 1);
    await runInDurableObject(hub(), async (instance) => {
      const anyInstance = instance as any;
      await anyInstance.panelJobRunning("never-inserted-job-id");
      await anyInstance.panelJobStatusRefresh();
    });

    const [onlyMessage] = await eventsPromise;
    expect(onlyMessage.type).toBe("status");

    panel.close();
  });
});

// ---------------------------------------------------------------------------
// Final review finding #6: a session_epoch bump (change-password,
// reset-password, disable) must close that user's open panel WebSocket(s),
// not just make their NEXT handshake fail -- the handshake resolves the
// session once and stores only the uid (serializeAttachment survives
// hibernation too), with no re-check afterwards.

function expectClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener("close", onClose);
      reject(new Error("timeout waiting for the socket to close"));
    }, timeoutMs);
    const onClose = (evt: CloseEvent) => {
      clearTimeout(timer);
      ws.removeEventListener("close", onClose);
      resolve({ code: evt.code });
    };
    ws.addEventListener("close", onClose);
  });
}

describe("session_epoch bump closes open panel sockets (final review finding #6)", () => {
  it("change-password closes the caller's own open panel socket", async () => {
    const admin = await loginCookie();
    const panel = await connectPanel(admin.cookie);
    await collectMessages(panel, 2); // status, feature_flags

    const closed = expectClose(panel);
    const r = await call("/api/auth/change-password", {
      json: { old: ADMIN_PASSWORD, new: "brand-new-password-1" },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(200);
    await closed;
  });

  it("reset-password closes the target user's open panel socket", async () => {
    const admin = await loginCookie();
    const alice = await secondUserCookie(admin, "alice");

    const alicePanel = await connectPanel(alice.cookie);
    await collectMessages(alicePanel, 2); // status, feature_flags

    const closed = expectClose(alicePanel);
    const r = await call(`/api/users/${alice.uid}/reset-password`, {
      method: "POST",
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(200);
    await closed;
  });

  it("disabling a user closes their open panel socket", async () => {
    const admin = await loginCookie();
    const bob = await secondUserCookie(admin, "bob");

    const bobPanel = await connectPanel(bob.cookie);
    await collectMessages(bobPanel, 2); // status, feature_flags

    const closed = expectClose(bobPanel);
    const r = await call(`/api/users/${bob.uid}`, {
      method: "PATCH",
      json: { disabled: true },
      cookie: admin.cookie,
      headers: { "X-CSRF": admin.csrf },
    });
    expect(r.status).toBe(200);
    await closed;
  });
});

// ---------------------------------------------------------------------------
// Phase 3.3 §3.7: children are invisible to the panel
//
// JSON-shape parity with tests/server/test_comfy_panel_ws.py: every frame
// below carries the PARENT's id as `prompt_id`, with the same keys and the
// same nesting the Python relay emits.

describe("split families on the panel (§3.7)", () => {
  async function makeSplitFamily(opts: {
    uid: string;
    parentStatus?: string;
    children: { status: string; workerId?: string | null; progress?: number; resultFiles?: string[] }[];
    workflowJson?: string;
  }): Promise<{ parentId: string; childIds: string[] }> {
    const parentId = uniqueId("parent");
    const workflowJson = opts.workflowJson ?? JSON.stringify({ "5": { class_type: "SaveImage" } });
    await d1()
      .prepare(
        `INSERT INTO jobs (id, workflow_json, status, created_at, input_assets, origin, user_id, split_count)
         VALUES (?, ?, ?, ?, '[]', 'panel', ?, ?)`
      )
      .bind(
        parentId,
        workflowJson,
        opts.parentStatus ?? "running",
        toSqliteTimestamp(new Date()),
        opts.uid,
        opts.children.length
      )
      .run();

    const childIds: string[] = [];
    for (let index = 0; index < opts.children.length; index++) {
      const child = opts.children[index]!;
      const childId = `${parentId}-c${index}`;
      childIds.push(childId);
      await d1()
        .prepare(
          `INSERT INTO jobs (id, workflow_json, status, worker_id, created_at, started_at, input_assets,
                             origin, user_id, parent_id, split_index, progress, result_files)
           VALUES (?, ?, ?, ?, ?, ?, '[]', 'panel', ?, ?, ?, ?, ?)`
        )
        .bind(
          childId,
          workflowJson,
          child.status,
          child.workerId ?? null,
          toSqliteTimestamp(new Date()),
          toSqliteTimestamp(new Date()),
          opts.uid,
          parentId,
          index,
          child.progress ?? 0,
          JSON.stringify(child.resultFiles ?? [])
        )
        .run();
    }
    return { parentId, childIds };
  }

  it("reports a child's heartbeat progress as the parent's mean", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const { cookie, uid } = await loginCookie();
    const { parentId, childIds } = await makeSplitFamily({
      uid,
      children: [
        { status: "running", workerId, progress: 0 },
        { status: "running", progress: 0.1 },
      ],
    });

    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const progressPromise = nextMessage(panel);
    agent.send(JSON.stringify({ type: "heartbeat", state: "idle", job_id: childIds[0], progress: 0.5 }));
    expect(await progressPromise).toEqual({
      type: "progress",
      data: { value: 30, max: 100, prompt_id: parentId },
    });

    agent.close();
    panel.close();
  });

  it("reports a child going busy as the parent executing", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const { cookie, uid } = await loginCookie();
    const { parentId, childIds } = await makeSplitFamily({
      uid,
      parentStatus: "assigned",
      children: [{ status: "assigned", workerId }],
    });

    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const runningPromise = nextMessage(panel);
    agent.send(JSON.stringify({ type: "heartbeat", state: "busy", job_id: childIds[0] }));
    expect(await runningPromise).toEqual({
      type: "executing",
      data: { node: "comfyfed", prompt_id: parentId, display_node: "comfyfed" },
    });

    agent.close();
    panel.close();
  });

  it("emits no executed while a sibling is still running", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const { cookie, uid } = await loginCookie();
    const { childIds } = await makeSplitFamily({
      uid,
      children: [
        { status: "running", workerId },
        { status: "running" },
      ],
    });

    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const eventsPromise = collectMessages(panel, 1);
    agent.send(JSON.stringify({ type: "job_done", job_id: childIds[0], result_files: ["a.png"], exec_seconds: 1 }));
    const [only] = await eventsPromise;
    expect(only.type).toBe("status");

    agent.close();
    panel.close();
  });

  it("emits the parent's merged outputs when the last child finishes", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const { cookie, uid } = await loginCookie();
    const { parentId, childIds } = await makeSplitFamily({
      uid,
      children: [
        { status: "done", resultFiles: ["a.png"] },
        { status: "running", workerId },
      ],
    });

    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const eventsPromise = collectMessages(panel, 3);
    agent.send(JSON.stringify({ type: "job_done", job_id: childIds[1], result_files: ["b.png"], exec_seconds: 1 }));
    const [executed, executingNull, status] = await eventsPromise;

    expect(executed).toEqual({
      type: "executed",
      data: {
        prompt_id: parentId,
        output: {
          images: [
            { filename: "a.png", subfolder: childIds[0], type: "output" },
            { filename: "b.png", subfolder: childIds[1], type: "output" },
          ],
        },
        node: "5",
        display_node: "5",
      },
    });
    expect(executingNull).toEqual({ type: "executing", data: { node: null, prompt_id: parentId } });
    expect(status.type).toBe("status");

    agent.close();
    panel.close();
  });

  it("counts a whole split family once in queue_remaining", async () => {
    const { cookie, uid } = await loginCookie();
    await makeSplitFamily({ uid, children: [{ status: "running" }, { status: "queued" }] });

    const panel = await connectPanel(cookie);
    const [status] = await collectMessages(panel, 1);
    expect(status.data.status).toEqual({ exec_info: { queue_remaining: 1 } });
    panel.close();
  });

  it("reports a child's failure as the parent's execution_error", async () => {
    const kp = KEYPAIRS[0]!;
    const workerId = await makeWorker({ pubkeyHex: kp.pubkey_hex });
    const { cookie, uid } = await loginCookie();
    const { parentId, childIds } = await makeSplitFamily({
      uid,
      children: [
        { status: "running", workerId },
        { status: "queued" },
      ],
    });

    const panel = await connectPanel(cookie);
    await collectMessages(panel, 2);

    const agent = await connectAgent(workerId, kp.seed_hex);
    agent.send(JSON.stringify({ type: "hello", protocol: 2 }));

    const eventsPromise = collectMessages(panel, 1);
    agent.send(JSON.stringify({ type: "job_failed", job_id: childIds[0], error: "boom" }));
    const [failed] = await eventsPromise;
    expect(failed.type).toBe("execution_error");
    expect(failed.data.prompt_id).toBe(parentId);
    expect(failed.data.exception_message).toContain("boom");

    agent.close();
    panel.close();
  });
});
