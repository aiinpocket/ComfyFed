import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { env, createExecutionContext, waitOnExecutionContext, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { connectAgent, connectPanel, collectMessages, expectNoMessage, hub, nextMessage, openAgentWs, waitFor } from "./helpers/ws";
import * as modelManifest from "../src/core/model_manifest";
import * as peerhealth from "../src/core/peerhealth";
import { signRequest } from "../src/lib/signing";
import { signHex, verifyHex, derivePublicKeyHexFromSeed } from "../src/lib/ed25519";
import { bytesToHex } from "../src/lib/hex";
import { getJobById, getReceiptsForJob, resolvePlatformSeed, toSqliteTimestamp } from "../src/db/queries";
import golden from "./fixtures/golden.json";

// ---------------------------------------------------------------------------
// Task 13: cloud end-to-end story.
//
// ONE test, every step asserted, in order -- deliberately not split into
// several `it()`s: the whole point is to prove the full chain (console/panel
// session -> worker registration -> agent WS handshake -> dispatch ->
// artifact round-trip -> receipt dual-signature -> panel/console read
// surfaces -> cancellation -> billing report) works end to end wired
// together, the way none of the narrower per-route spec files (jobs/workers/
// hub/panel-ws/comfyapi/reports.spec.ts) individually exercise. Those files
// remain the source of truth for each step's edge cases; this file only
// re-asserts the "happy path" shape of each step while chaining them.
//
// Dispatch alarms never fire on their own under vitest-pool-workers -- every
// tick here is driven explicitly via `runDurableObjectAlarm(hub())`, exactly
// like hub.spec.ts/jobs.spec.ts/panel-ws.spec.ts already do; there is no
// simulated-clock alternative available in this test harness (documented
// per the task brief's "whatever miniflare affords").

// Same alarm hygiene as hub.spec.ts, for the same root cause: every
// `connectAgent` handshake arms a REAL 5s dispatch alarm and miniflare fires
// due alarms for real. This chain runs well past 5s on a loaded box -- and
// `ci-build` runs it right after two `npm ci`s, the loudest moment a CI
// container has -- so an alarm armed earlier in the chain fired inside one of
// the fixed `expectNoMessage(...)` windows below, dispatched, and the extra
// frame failed the test (caught once in a fresh-clone ci-build, 3/3 green in
// isolation). Deleting the pending alarm around every test means a tick only
// ever runs through the explicit `runDurableObjectAlarm(hub())` calls; each
// test's own `connectAgent` re-arms before those, so `ran === true` holds.
async function deletePendingAlarm(): Promise<void> {
  await runInDurableObject(hub(), (_instance, state) => state.storage.deleteAlarm());
}

beforeEach(deletePendingAlarm);
afterEach(deletePendingAlarm);

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  await db().prepare("DELETE FROM login_attempts").run();
  await db().prepare("DELETE FROM jobs").run();
  await db().prepare("DELETE FROM receipts").run();
  await db().prepare("DELETE FROM upload_tokens").run();
  for (const prefix of ["staging/", "object_info/", "artifacts/", "job_inputs/"]) {
    const listed = await store().list({ prefix });
    await Promise.all(listed.objects.map((o) => store().delete(o.key)));
  }
});

function store(): R2Bucket {
  return (env as any).STORE as R2Bucket;
}

const ADMIN_PASSWORD = "correct-horse-battery-staple";

interface RawResult {
  status: number;
  body: any;
  headers: Headers;
}

/** Fires a request with an arbitrary body (FormData, raw bytes, or none)
 * straight through the worker export -- same pattern as workers.spec.ts's
 * `raw`, duplicated here rather than imported since each spec file owns its
 * helpers independently in this codebase. */
async function raw(
  path: string,
  opts: { method?: string; body?: BodyInit | null; headers?: Record<string, string>; cookie?: string | null } = {}
): Promise<RawResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  const method = opts.method ?? (opts.body !== undefined ? "POST" : "GET");
  const canCarryBody = method !== "GET" && method !== "HEAD";
  const request = new Request(`http://example.com${path}`, {
    method,
    headers,
    body: canCarryBody ? (opts.body ?? undefined) : undefined,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);
  let body: any = null;
  const text = await response.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, body, headers: response.headers };
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

async function signedCall(
  workerId: string,
  seedHex: string,
  method: string,
  path: string,
  body: Uint8Array,
  headers: Record<string, string> = {}
): Promise<RawResult> {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().replace(/-/g, "");
  const sig = await signRequest(seedHex, method, path, "", ts, nonce, body);
  return raw(path, {
    method,
    body,
    headers: { "X-Worker-Id": workerId, "X-Ts": ts, "X-Nonce": nonce, "X-Sig": sig, ...headers },
  });
}

describe("cloud end-to-end", () => {
  it(
    "setup -> login -> register -> handshake -> dispatch -> artifact -> receipt -> cancel -> reports",
    async () => {
      // -----------------------------------------------------------------
      // 1. Setup + login (SETUP_TOKEN), issuing a cookie+csrf session.
      const setupRes = await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
      expect(setupRes.status).toBe(200);
      const loginRes = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.setCookie;
      const csrf = loginRes.body.csrf;
      expect(cookie).not.toBeNull();
      expect(typeof csrf).toBe("string");

      // Connect the panel WS EARLY (before anything else happens) so it can
      // observe every subsequent event, per the brief's "connect a panel
      // client early" requirement.
      const panel = await connectPanel(cookie!);
      const [status0, flags0] = await collectMessages(panel, 2);
      expect(status0.type).toBe("status");
      expect(status0.data.status).toEqual({ exec_info: { queue_remaining: 0 } });
      expect(flags0.type).toBe("feature_flags");

      // -----------------------------------------------------------------
      // 2. Issue a register token, then HTTP-register a fake worker with a
      // golden keypair.
      const tokenRes = await call("/api/workers/tokens", {
        json: { name: "gpu-e2e" },
        cookie,
        headers: { "X-CSRF": csrf },
      });
      expect(tokenRes.status).toBe(200);
      const registerToken = tokenRes.body.bundle.register_token;
      const platformPubkey = tokenRes.body.bundle.platform_pubkey;
      expect(typeof registerToken).toBe("string");

      const kp = golden.keypairs[0]!;
      const registerRes = await call("/api/agent/register", { json: { token: registerToken, pubkey: kp.pubkey_hex } });
      expect(registerRes.status).toBe(200);
      const workerId = registerRes.body.worker_id as string;
      const seedHex = kp.seed_hex;
      expect(typeof workerId).toBe("string");
      expect(typeof platformPubkey).toBe("string");

      // -----------------------------------------------------------------
      // 3. Open the agent WS, complete the challenge/response handshake.
      const agent = await connectAgent(workerId, seedHex);

      // -----------------------------------------------------------------
      // 4. hello v2: protocol 2, a Linux agent reporting hardware + the
      // node classes needed below (LoadImage/SaveImage, plus a couple more
      // for realism). Protocol 2 sends no reply frame at all.
      const helloNone = expectNoMessage(agent, 300);
      agent.send(
        JSON.stringify({
          type: "hello",
          protocol: 2,
          backend: "cuda",
          torch_version: "2.4.0",
          platform: "Linux",
          hardware: { vram_gb: 24, gpu_name: "RTX4090" },
          node_classes: ["LoadImage", "SaveImage", "KSampler", "CheckpointLoaderSimple"],
        })
      );
      await helloNone;

      // Poll until the hub has finished processing the hello and persisted
      // the worker row (protocol 2 sends no reply frame to synchronize on).
      const workerRow = await waitFor(
        async () => {
          const row = await db()
            .prepare("SELECT protocol, backend, node_classes, status FROM workers WHERE id = ?")
            .bind(workerId)
            .first<{ protocol: number; backend: string; node_classes: string; status: string }>();
          return row && row.protocol === 2 ? row : undefined;
        },
        { label: "worker row reflects hello (protocol 2)" }
      );
      expect(workerRow.backend).toBe("cuda");
      const nodeClasses = JSON.parse(workerRow.node_classes) as string[];
      expect(nodeClasses).toEqual(expect.arrayContaining(["LoadImage", "SaveImage"]));
      expect(workerRow.status).toBe("online");

      // -----------------------------------------------------------------
      // 5. Upload a small gzip object_info snapshot over the signed agent
      // route.
      const oiPayload = new TextEncoder().encode(
        JSON.stringify({ LoadImage: { input: {} }, SaveImage: { input: {} } })
      );
      const oiGz = await gzip(oiPayload);
      const oiHash = await sha256Hex(oiPayload);
      const oiRes = await signedCall(workerId, seedHex, "POST", "/api/agent/object_info", oiGz, {
        "X-OI-Hash": oiHash,
      });
      expect(oiRes.status).toBe(200);
      expect(oiRes.body).toEqual({ ok: true });
      const oiStored = await store().get(`object_info/${workerId}.json.gz`);
      expect(oiStored).not.toBeNull();

      // -----------------------------------------------------------------
      // 6. Stage an input asset via the real panel staging path (the same
      // one the pinned ComfyUI frontend's image-upload widget uses) --
      // exercising the actual staging seed rather than poking R2 directly.
      const stagedBytes = new TextEncoder().encode("PNGDATA-e2e");
      const uploadForm = new FormData();
      uploadForm.set("image", new File([stagedBytes], "input.png", { type: "image/png" }));
      const uploadRes = await raw("/comfy/api/upload/image", { method: "POST", body: uploadForm, cookie });
      expect(uploadRes.status).toBe(200);
      expect(uploadRes.body).toEqual({ name: "input.png", subfolder: "", type: "input" });
      const adminRow = await db().prepare("SELECT id FROM users WHERE username = 'admin'").first<{ id: string }>();
      expect(await store().get(`staging/${adminRow!.id}/input.png`)).not.toBeNull();

      // -----------------------------------------------------------------
      // 7. Panel POST /comfy/api/prompt with a ZERO-model workflow (no
      // CheckpointLoaderSimple/UNETLoader node) that references the staged
      // asset.
      const workflow1 = {
        "1": { class_type: "LoadImage", inputs: { image: "input.png" } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
      };
      const promptRes = await call("/comfy/api/prompt", { json: { prompt: workflow1 }, cookie });
      expect(promptRes.status).toBe(200);
      expect(promptRes.body.node_errors).toEqual({});
      const jobId = promptRes.body.prompt_id as string;
      expect(typeof jobId).toBe("string");

      const jobRow = await db().prepare("SELECT origin, required_models FROM jobs WHERE id = ?").bind(jobId).first<any>();
      expect(jobRow.origin).toBe("panel");
      expect(JSON.parse(jobRow.required_models)).toEqual([]);

      // The staged file was copied (not moved) into this job's inputs.
      const stagedInInputs = await store().get(`job_inputs/${jobId}/input.png`);
      expect(stagedInInputs).not.toBeNull();
      expect(await stagedInInputs!.text()).toBe("PNGDATA-e2e");

      // -----------------------------------------------------------------
      // 8. Alarm tick: dispatches the queued job to the idle connected
      // worker. `runDurableObjectAlarm` is the miniflare-supported way to
      // drive the Hub DO's dispatch loop deterministically in tests (no
      // wall-clock wait, no simulated-time API is available here).
      const jobPushPromise = nextMessage(agent);
      const ran1 = await runDurableObjectAlarm(hub());
      expect(ran1).toBe(true);
      const pushed1 = await jobPushPromise;
      expect(pushed1.type).toBe("job");
      expect(pushed1.job_id).toBe(jobId);
      expect(JSON.parse(pushed1.workflow_json)).toEqual(workflow1);
      expect(pushed1.input_assets).toEqual(["input.png"]);

      const assignedJob = await getJobById(db(), jobId);
      expect(assignedJob!.status).toBe("assigned");
      expect(assignedJob!.workerId).toBe(workerId);

      // -----------------------------------------------------------------
      // 9. Agent downloads the input asset via a signed GET.
      const inputRes = await signedCall(
        workerId,
        seedHex,
        "GET",
        `/api/agent/jobs/${jobId}/inputs/input.png`,
        new Uint8Array()
      );
      expect(inputRes.status).toBe(200);
      expect(inputRes.body).toBe("PNGDATA-e2e");

      // -----------------------------------------------------------------
      // 10. Agent reports busy -- assigned -> running, and the panel sees
      // the transition as an `executing` event.
      const runningEventPromise = nextMessage(panel);
      agent.send(JSON.stringify({ type: "heartbeat", state: "busy", job_id: jobId }));
      const runningEvent = await runningEventPromise;
      expect(runningEvent).toEqual({
        type: "executing",
        data: { node: "comfyfed", prompt_id: jobId, display_node: "comfyfed" },
      });
      const runningJob = await getJobById(db(), jobId);
      expect(runningJob!.status).toBe("running");

      // -----------------------------------------------------------------
      // 11. Agent uploads the rendered artifact via the presign + raw PUT
      // direct-mode flow.
      const artifactBytes = new TextEncoder().encode("rendered-e2e-bytes");
      const artifactSha = await sha256Hex(artifactBytes);
      const presignPath = `/api/agent/jobs/${jobId}/artifacts/presign`;
      const presignBody = new TextEncoder().encode(
        JSON.stringify({ filename: "out.png", sha256: artifactSha, size: artifactBytes.length })
      );
      const presignRes = await signedCall(workerId, seedHex, "POST", presignPath, presignBody);
      expect(presignRes.status).toBe(200);
      expect(presignRes.body.mode).toBe("direct");
      expect(presignRes.body.url).toMatch(new RegExp(`^/api/agent/jobs/${jobId}/artifacts/raw/`));

      const putRes = await raw(presignRes.body.url, { method: "PUT", body: artifactBytes });
      expect(putRes.status).toBe(200);
      expect(putRes.body.sha256).toBe(artifactSha);
      const storedArtifact = await store().get(`artifacts/${jobId}/out.png`);
      expect(storedArtifact).not.toBeNull();
      expect(await storedArtifact!.text()).toBe("rendered-e2e-bytes");

      // -----------------------------------------------------------------
      // 12. job_done with exec_seconds -> a `receipt` frame on the agent WS
      // AND a 3-frame panel fan-out (executed, executing:null, status),
      // both attached BEFORE the trigger per collectMessages's contract.
      const panelDonePromise = collectMessages(panel, 3);
      const receiptPromise = nextMessage(agent);
      agent.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: ["out.png"], exec_seconds: 1 }));

      const receipt = await receiptPromise;
      expect(receipt.type).toBe("receipt");
      expect(receipt.kind).toBe("completed");
      expect(receipt.billable).toBe(true);
      expect(receipt.basis).toBe("exec");
      // `exec_seconds` is capped at the actual wall-clock span the job ran
      // for (do/hub.ts's `createAndPushReceipt` -- see hub.spec.ts's "caps
      // exec_seconds at the wall-clock span" test), which in a fast test run
      // can be well under the 1s `exec_seconds` this test reports. Assert
      // the shape/prefix rather than a specific value.
      expect(receipt.payload).toMatch(new RegExp(`^${jobId}\\|${workerId}\\|\\d+\\.\\d$`));
      expect(typeof receipt.platform_sig).toBe("string");
      expect(typeof receipt.receipt_id).toBe("string");

      const [executed, executingNull, statusAfterDone] = await panelDonePromise;
      expect(executed).toEqual({
        type: "executed",
        data: {
          prompt_id: jobId,
          output: { images: [{ filename: "out.png", subfolder: jobId, type: "output" }] },
          node: "2",
          display_node: "2",
        },
      });
      expect(executingNull).toEqual({ type: "executing", data: { node: null, prompt_id: jobId } });
      expect(statusAfterDone.type).toBe("status");
      expect(statusAfterDone.data.status).toEqual({ exec_info: { queue_remaining: 0 } });

      const doneJob = await getJobById(db(), jobId);
      expect(doneJob!.status).toBe("done");
      expect(doneJob!.resultFiles).toEqual(["out.png"]);

      // -----------------------------------------------------------------
      // 13. Counter-sign the receipt with the golden key and ack it.
      const workerSig = await signHex(seedHex, new TextEncoder().encode(receipt.payload));
      agent.send(JSON.stringify({ type: "receipt_ack", receipt_id: receipt.receipt_id, worker_sig: workerSig }));
      // receipt_ack has no reply frame -- poll the DB until the worker_sig
      // lands (a fixed sleep was load-flaky: 3 failures in 11 suite runs).
      await waitFor(
        async () => {
          const rows = await getReceiptsForJob(db(), jobId);
          return rows[0]?.workerSig ? rows : undefined;
        },
        { label: "receipt row shows worker_sig after receipt_ack" }
      );

      // -----------------------------------------------------------------
      // 14. Verify the receipt row directly.
      const receiptsJob1 = await getReceiptsForJob(db(), jobId);
      expect(receiptsJob1).toHaveLength(1);
      const receiptRow1 = receiptsJob1[0]!;
      expect(receiptRow1.kind).toBe("completed");
      expect(receiptRow1.billable).toBe(true);
      expect(receiptRow1.basis).toBe("exec");
      expect(receiptRow1.workerSig).toBe(workerSig);

      // -----------------------------------------------------------------
      // 15. Panel GET /comfy/api/history shows the job with its outputs.
      const historyRes = await call("/comfy/api/history", { method: "GET", cookie });
      expect(historyRes.status).toBe(200);
      expect(historyRes.body[jobId].status).toEqual({ status_str: "success", completed: true, messages: [] });
      expect(historyRes.body[jobId].outputs["2"].images[0]).toEqual({
        filename: "out.png",
        subfolder: jobId,
        type: "output",
      });

      // -----------------------------------------------------------------
      // 16. Console GET /api/jobs/{id} shows the receipt embed.
      const jobDetail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie });
      expect(jobDetail.status).toBe(200);
      expect(jobDetail.body.status).toBe("done");
      expect(jobDetail.body.receipt).toEqual({
        gpu_seconds: receiptRow1.gpuSeconds,
        kind: "completed",
        billable: true,
        basis: "exec",
        acked: true,
      });

      // =====================================================================
      // Cancellation mini-arc.
      // =====================================================================

      // Flip the agent back to idle (job_done never resets `state` on its
      // own -- see do/hub.ts's dispatch loop, which only ever assigns to
      // workers whose LAST heartbeat reported idle) so the next tick can
      // dispatch a second job to it.
      const idleNone = expectNoMessage(agent, 200);
      agent.send(JSON.stringify({ type: "heartbeat", state: "idle" }));
      await idleNone;

      // Poll until the hub has applied the idle heartbeat (status flips back
      // from "busy" to "online") -- the next dispatch alarm tick only ever
      // dispatches to a worker it currently sees as idle.
      await waitFor(
        async () => {
          const row = await db().prepare("SELECT status FROM workers WHERE id = ?").bind(workerId).first<{ status: string }>();
          return row?.status === "online" ? true : undefined;
        },
        { label: "worker status flips back to online after idle heartbeat" }
      );

      // -----------------------------------------------------------------
      // Second job queued (panel origin again, so the history-hide flow
      // below applies to it), no assets needed.
      const workflow2 = {
        "1": { class_type: "KSampler", inputs: { seed: 1 } },
        "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } },
      };
      const prompt2Res = await call("/comfy/api/prompt", { json: { prompt: workflow2 }, cookie });
      expect(prompt2Res.status).toBe(200);
      const jobId2 = prompt2Res.body.prompt_id as string;

      const job2PushPromise = nextMessage(agent);
      const ran2 = await runDurableObjectAlarm(hub());
      expect(ran2).toBe(true);
      const pushed2 = await job2PushPromise;
      expect(pushed2.type).toBe("job");
      expect(pushed2.job_id).toBe(jobId2);

      const assigned2 = await getJobById(db(), jobId2);
      expect(assigned2!.status).toBe("assigned");

      // Assigned -> running, same as job 1.
      const running2Promise = nextMessage(panel);
      agent.send(JSON.stringify({ type: "heartbeat", state: "busy", job_id: jobId2 }));
      const running2 = await running2Promise;
      expect(running2).toEqual({
        type: "executing",
        data: { node: "comfyfed", prompt_id: jobId2, display_node: "comfyfed" },
      });
      const running2Job = await getJobById(db(), jobId2);
      expect(running2Job!.status).toBe("running");

      // -----------------------------------------------------------------
      // Console cancel: the Hub mints+pushes a cancelled receipt to the
      // owning agent BEFORE pushing job_cancelled (see do/hub.ts's
      // `handleInternalCancel`), so both are attached as one collect.
      const agentCancelEventsPromise = collectMessages(agent, 2);
      const panelCancelEventsPromise = collectMessages(panel, 2); // executing:null, status
      const cancelRes = await call(`/api/jobs/${jobId2}/cancel`, {
        method: "POST",
        cookie,
        headers: { "X-CSRF": csrf },
      });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.status).toBe("cancelled");

      const [cancelledReceiptFrame, jobCancelledMsg] = await agentCancelEventsPromise;
      expect(cancelledReceiptFrame.type).toBe("receipt");
      expect(cancelledReceiptFrame.kind).toBe("cancelled");
      expect(cancelledReceiptFrame.billable).toBe(false);
      expect(cancelledReceiptFrame.basis).toBe("wall");
      expect(jobCancelledMsg).toEqual({ type: "job_cancelled", job_id: jobId2 });

      const [panelExecutingNull, panelStatusAfterCancel] = await panelCancelEventsPromise;
      expect(panelExecutingNull).toEqual({ type: "executing", data: { node: null, prompt_id: jobId2 } });
      expect(panelStatusAfterCancel.type).toBe("status");

      const cancelledJob = await getJobById(db(), jobId2);
      expect(cancelledJob!.status).toBe("cancelled");

      // -----------------------------------------------------------------
      // Verify the cancelled receipt row: non-billable, wall-clock basis.
      const receiptsJob2 = await getReceiptsForJob(db(), jobId2);
      expect(receiptsJob2).toHaveLength(1);
      const receiptRow2 = receiptsJob2[0]!;
      expect(receiptRow2.kind).toBe("cancelled");
      expect(receiptRow2.billable).toBe(false);
      expect(receiptRow2.basis).toBe("wall");

      // A cancelled job is never a HISTORY_STATUSES member (only
      // done/failed are -- comfyapi.ts's `HISTORY_STATUSES`), so job 2 never
      // shows up in /comfy/api/history at all; confirm that directly, then
      // exercise the actual history-hide flow against job 1 (the completed
      // job from earlier, still visible in history at this point).
      const historyAfterCancel = await call("/comfy/api/history", { method: "GET", cookie });
      expect(historyAfterCancel.body[jobId2]).toBeUndefined();
      expect(historyAfterCancel.body[jobId]).toBeDefined();

      // -----------------------------------------------------------------
      // Panel history hide flow (job 1): visible, then hidden on request.
      const hideRes = await call("/comfy/api/history", { json: { delete: [jobId] }, cookie });
      expect(hideRes.status).toBe(200);

      const historyAfterHide = await call("/comfy/api/history", { method: "GET", cookie });
      expect(historyAfterHide.body[jobId]).toBeUndefined();

      // =====================================================================
      // Final: GET /api/reports/contributions asserts the billable +
      // unbilled split across the two jobs this one worker ran.
      // =====================================================================
      const reportsRes = await call("/api/reports/contributions", { method: "GET", cookie });
      expect(reportsRes.status).toBe(200);
      const workerReport = reportsRes.body.find((w: any) => w.worker_id === workerId);
      expect(workerReport).toBeDefined();
      expect(workerReport.jobs).toBe(1); // only the completed (billable) job counts here
      expect(workerReport.gpu_seconds).toBe(receiptRow1.gpuSeconds);
      expect(workerReport.unbilled_gpu_seconds).toBe(receiptRow2.gpuSeconds);
      const kinds = workerReport.receipts.map((r: any) => r.kind).sort();
      expect(kinds).toEqual(["cancelled", "completed"]);
      const completedEntry = workerReport.receipts.find((r: any) => r.kind === "completed");
      expect(completedEntry).toEqual({
        job_id: jobId,
        kind: "completed",
        billable: true,
        basis: "exec",
        gpu_seconds: receiptRow1.gpuSeconds,
        acked: true,
        bytes: null,
      });
      const cancelledEntry = workerReport.receipts.find((r: any) => r.kind === "cancelled");
      expect(cancelledEntry).toEqual({
        job_id: jobId2,
        kind: "cancelled",
        billable: false,
        basis: "wall",
        gpu_seconds: receiptRow2.gpuSeconds,
        acked: false,
        bytes: null,
      });

      agent.close();
      panel.close();
    },
    20000
  );

  // ===========================================================================
  // Phase 2.1 Task 7: model auto-fetch mini-arc.
  //
  // A single fake worker: report inventory WITH a known model (name +
  // sha256) once so the server LEARNS its hash, then report a SECOND
  // inventory WITHOUT that model -- the server now sees it missing from the
  // fleet but still knows a signed hash for it, which is exactly what makes
  // `model_manifest.entries()` publish a manifest entry for it. Submitting a
  // job that needs the model then dispatches with `fetch_models` attached
  // (the worker is opted into auto_fetch, protocol 3, with ample free disk),
  // and the fake agent reports a `fetching_models` progress stage before
  // completing the job normally.
  it(
    "model auto-fetch: learn a hash from a departed model, dispatch with fetch_models, report fetch progress, complete",
    async () => {
      const setupRes = await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
      expect(setupRes.status).toBe(200);
      const loginRes = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
      const cookie = loginRes.setCookie;
      const csrf = loginRes.body.csrf;

      const panel = await connectPanel(cookie!);
      await collectMessages(panel, 2); // initial status + feature_flags

      // -----------------------------------------------------------------
      // 1. Register a worker and complete its handshake.
      const tokenRes = await call("/api/workers/tokens", {
        json: { name: "gpu-fetch" },
        cookie,
        headers: { "X-CSRF": csrf },
      });
      const kp = golden.keypairs[1]!; // a different fixture keypair than the main test's
      const registerRes = await call("/api/agent/register", {
        json: { token: tokenRes.body.bundle.register_token, pubkey: kp.pubkey_hex },
      });
      const workerId = registerRes.body.worker_id as string;
      const seedHex = kp.seed_hex;
      const agent = await connectAgent(workerId, seedHex);

      // -----------------------------------------------------------------
      // 2. hello v3: opted into auto_fetch, protocol 3 (the minimum that can
      // ever receive fetch_models -- see assess.ts's `MIN_AUTO_FETCH_PROTOCOL`).
      const helloNone = expectNoMessage(agent, 300);
      agent.send(
        JSON.stringify({
          type: "hello",
          protocol: 3,
          auto_fetch: true,
          backend: "cuda",
          torch_version: "2.4.0",
          hardware: { vram_gb: 24 },
          node_classes: ["CLIPLoader"],
        })
      );
      await helloNone;

      // Poll until the hub has persisted this hello's protocol/auto_fetch
      // (needed by the dispatch tick's eligible_after_fetch check below).
      await waitFor(
        async () => {
          const row = await db()
            .prepare("SELECT protocol, auto_fetch FROM workers WHERE id = ?")
            .bind(workerId)
            .first<{ protocol: number; auto_fetch: number }>();
          return row && row.protocol === 3 && row.auto_fetch === 1 ? true : undefined;
        },
        { label: "worker row reflects hello (protocol 3, auto_fetch)" }
      );

      // Ample free disk (well over 1.2x the ~0.23 GB curated clip_l.safetensors)
      // so the disk-margin gate clears.
      const heartbeatIdleNone = expectNoMessage(agent, 200);
      agent.send(JSON.stringify({ type: "heartbeat", state: "idle", dynamic: { free_disk_gb: 50 } }));
      await heartbeatIdleNone;

      // Poll until the hub has persisted the reported free disk (the
      // dispatch tick's disk-margin gate reads it back from this column).
      await waitFor(
        async () => {
          const row = await db().prepare("SELECT dynamic FROM workers WHERE id = ?").bind(workerId).first<{ dynamic: string }>();
          return row?.dynamic && JSON.parse(row.dynamic).free_disk_gb === 50 ? true : undefined;
        },
        { label: "worker dynamic reflects reported free_disk_gb" }
      );

      // -----------------------------------------------------------------
      // 3. Report inventory WITH clip_l.safetensors + sha256 -- the server
      // learns the hash (model_manifest.recordHash), even though this exact
      // report will be superseded a moment later.
      const modelName = "clip_l.safetensors";
      const sizeGb = 0.23; // matches model_guide.SOURCES' curated size exactly
      const sizeBytes = Math.round(sizeGb * 1024 ** 3);
      const sha256 = bytesToHex(
        new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("e2e-fetch-arc-clip_l")))
      );
      const inventoryWithModelNone = expectNoMessage(agent, 200);
      agent.send(
        JSON.stringify({
          type: "inventory",
          models: [{ name: modelName, size: sizeGb, size_bytes: sizeBytes, sha256 }],
        })
      );
      await inventoryWithModelNone;

      // Poll until the hub has learned + persisted the hash from this
      // inventory report.
      const hashRow = await waitFor(
        async () => {
          const row = await db()
            .prepare("SELECT sha256 FROM model_hashes WHERE name = ? AND size_bytes = ?")
            .bind(modelName, sizeBytes)
            .first<{ sha256: string }>();
          return row?.sha256 ? row : undefined;
        },
        { label: "model_hashes row learned from inventory" }
      );
      expect(hashRow.sha256).toBe(sha256);

      // -----------------------------------------------------------------
      // 4. A SECOND inventory report WITHOUT the model -- the fleet now sees
      // it missing everywhere, but the learned hash row from step 3 is still
      // in `model_hashes`, so it's a fetch-manifest candidate.
      const inventoryEmptyNone = expectNoMessage(agent, 200);
      agent.send(JSON.stringify({ type: "inventory", models: [] }));
      await inventoryEmptyNone;

      // Poll until the second (empty) inventory report has overwritten the
      // worker's model_inventory column.
      const inventoryRow = await waitFor(
        async () => {
          const row = await db().prepare("SELECT model_inventory FROM workers WHERE id = ?").bind(workerId).first<any>();
          return row && JSON.parse(row.model_inventory).length === 0 ? row : undefined;
        },
        { label: "worker model_inventory cleared by empty inventory report" }
      );
      expect(JSON.parse(inventoryRow.model_inventory)).toEqual([]);

      // -----------------------------------------------------------------
      // 5. Submit a job needing clip_l.safetensors via the console. Missing
      // fleet-wide, but fetchable (manifest entry + this online opted-in
      // worker clears the disk margin) -- the submission-relaxation gate
      // (jobs.ts's `unfetchableMissingModels`) lets it through instead of
      // 400ing.
      const workflow = { "1": { class_type: "CLIPLoader", inputs: { clip_name: modelName } } };
      const submitForm = new FormData();
      submitForm.set("workflow_json", JSON.stringify(workflow));
      const submitRes = await raw("/api/jobs", { method: "POST", body: submitForm, cookie, headers: { "X-CSRF": csrf } });
      expect(submitRes.status).toBe(200);
      const jobId = submitRes.body.job_id as string;
      expect(typeof jobId).toBe("string");

      const jobRow = await db().prepare("SELECT required_models FROM jobs WHERE id = ?").bind(jobId).first<any>();
      expect(JSON.parse(jobRow.required_models)).toEqual([modelName]);

      // -----------------------------------------------------------------
      // 6. Alarm tick: dispatches with `fetch_models` attached, since this
      // worker's verdict for the job is eligible_after_fetch.
      const jobPushPromise = nextMessage(agent);
      const ran = await runDurableObjectAlarm(hub());
      expect(ran).toBe(true);
      const pushed = await jobPushPromise;
      expect(pushed.type).toBe("job");
      expect(pushed.job_id).toBe(jobId);
      expect(Array.isArray(pushed.fetch_models)).toBe(true);
      const fetchEntry = pushed.fetch_models.find((e: any) => e.name === modelName);
      expect(fetchEntry).toBeDefined();
      expect(fetchEntry.sha256).toBe(sha256);
      expect(fetchEntry.size_bytes).toBe(sizeBytes);
      expect(fetchEntry.directory).toBe("text_encoders");

      // The entry's signature verifies against the platform's public key --
      // proves this cloud port's manifest entry is byte-parity signed the
      // same way `model_manifest.py`'s `entries()` signs one.
      const platformSeed = await resolvePlatformSeed(db(), (env as any).PLATFORM_ED25519_SEED);
      const platformPubkeyHex = await derivePublicKeyHexFromSeed(platformSeed);
      const payload = `${fetchEntry.name}|${fetchEntry.directory}|${fetchEntry.sha256}|${fetchEntry.size_bytes}`;
      const sigOk = await verifyHex(platformPubkeyHex, new TextEncoder().encode(payload), fetchEntry.sig);
      expect(sigOk).toBe(true);

      const assignedJob = await getJobById(db(), jobId);
      expect(assignedJob!.status).toBe("assigned");
      expect(assignedJob!.workerId).toBe(workerId);

      // -----------------------------------------------------------------
      // 7. Fake agent reports the fetching_models progress stage. Phase 3.0
      // Task 10: the panel WS is a per-user PANEL workspace now -- a
      // job-scoped frame only reaches a panel socket when the job's own
      // `origin === "panel"` (see do/hub.ts's `panelVisibleTo`), which this
      // one isn't (submitted via the console in step 5). So the panel must
      // NOT see this relayed, unlike pre-Task-10 -- proven with
      // `expectNoMessage` rather than the old `nextMessage` wait. The
      // progress itself is still verified below via the console's own `GET
      // /api/jobs/{id}` transient-field surface, which every role's own
      // console session can read regardless of panel scoping.
      const fetchProgressAbsence = expectNoMessage(panel, 300);
      agent.send(
        JSON.stringify({
          type: "heartbeat",
          state: "busy",
          job_id: jobId,
          stage: "fetching_models",
          fetch_pct: 0.42,
          fetch_model: modelName,
        })
      );
      await fetchProgressAbsence;

      // Poll GET /api/jobs/{id} until the fetching_models heartbeat above has
      // been fully processed and its transient fields surfaced (a fixed
      // 100ms sleep here was load-flaky).
      const jobDetailDuringFetch = await waitFor(
        async () => {
          const detail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie });
          return detail.body.stage === "fetching_models" ? detail : undefined;
        },
        { label: "job detail reports fetching_models stage" }
      );
      expect(jobDetailDuringFetch.body.fetch_pct).toBe(0.42);
      expect(jobDetailDuringFetch.body.fetch_model).toBe(modelName);

      // M1 fix: fetch wall time is not billable execution, so the
      // fetching_models stage must NOT start the job's clock -- it stays
      // "assigned" (no startedAt) for the whole download phase. Safe to
      // assert now that the heartbeat above is confirmed processed.
      const stillAssignedJob = await getJobById(db(), jobId);
      expect(stillAssignedJob!.status).toBe("assigned");
      expect(stillAssignedJob!.startedAt).toBeNull();

      // -----------------------------------------------------------------
      // 8. A plain busy heartbeat (fetch finished, now actually running)
      // clears the transient fetch-progress fields AND is the heartbeat that
      // finally starts the job's clock.
      agent.send(JSON.stringify({ type: "heartbeat", state: "busy", job_id: jobId, progress: 0.1 }));
      // Poll until the plain busy heartbeat has cleared the transient
      // fetch-progress fields (replaces a bounded 25ms-interval loop with
      // the shared waitFor helper).
      const jobDetailAfterFetch = await waitFor(
        async () => {
          const detail = await call(`/api/jobs/${jobId}`, { method: "GET", cookie });
          return detail.body.stage === undefined ? detail : undefined;
        },
        { label: "job detail clears fetching_models stage after plain busy heartbeat" }
      );
      expect(jobDetailAfterFetch.body.stage).toBeUndefined();
      expect(jobDetailAfterFetch.body.fetch_pct).toBeUndefined();
      expect(jobDetailAfterFetch.body.fetch_model).toBeUndefined();

      // Poll until the job transitions to running (startedAt set) now that
      // the fetch stage is over.
      const runningJob = await waitFor(
        async () => {
          const job = await getJobById(db(), jobId);
          return job?.status === "running" ? job : undefined;
        },
        { label: "job transitions to running after fetch completes" }
      );
      expect(runningJob.startedAt).not.toBeNull();

      // -----------------------------------------------------------------
      // 9. job_done completes normally.
      const doneReceiptPromise = nextMessage(agent);
      agent.send(JSON.stringify({ type: "job_done", job_id: jobId, result_files: [], exec_seconds: 0.5 }));
      const doneReceipt = await doneReceiptPromise;
      expect(doneReceipt.type).toBe("receipt");
      expect(doneReceipt.kind).toBe("completed");

      const doneJob = await getJobById(db(), jobId);
      expect(doneJob!.status).toBe("done");

      agent.close();
      panel.close();
    },
    20000
  );

  // ===========================================================================
  // Phase 3.3 Task 10: batch-split end-to-end across TWO workers.
  //
  // Parity twin: `tests/server/test_agent_ws.py`'s
  // `test_batch_split_across_two_workers_end_to_end` +
  // `test_split_batches_false_keeps_the_prompt_whole` +
  // `test_cancelling_a_running_split_parent_stops_both_workers`.
  //
  // split.spec.ts / dispatch.spec.ts own the per-function edge cases; these
  // two `it`s only prove the whole chain wired together: a PANEL prompt with
  // `EmptySD3LatentImage batch_size=4` -> one real dispatch tick splitting it
  // into two children on two different workers -> each worker uploading two
  // DELIBERATELY identically named files -> the parent collecting all four in
  // batch order with the owning child as the `/view` subfolder -> the console
  // surfaces -> one receipt per worker and none on the parent.

  const SPLIT_NODE_CLASSES = [
    "EmptySD3LatentImage",
    "KSampler",
    "VAEDecode",
    "SaveImage",
    // The extra node every child workflow carries. A worker that doesn't
    // declare it fails the §2.3 required-nodes check for the CHILD (see
    // split.ts's `createChildren`, which unions it into `requiredNodes`).
    "LatentFromBatch",
  ];

  // All six §3.2 conditions hold: a single batch source with a literal
  // batch_size >= 2, no other `batch_size` input, every class allowlisted,
  // the KSampler's latent reaching the source along slot 0, and the
  // SaveImage descending from the source.
  const SPLIT_WORKFLOW = {
    "1": { class_type: "EmptySD3LatentImage", inputs: { width: 512, height: 512, batch_size: 4 } },
    "2": { class_type: "KSampler", inputs: { latent_image: ["1", 0], steps: 4, seed: 424242 } },
    "3": { class_type: "VAEDecode", inputs: { samples: ["2", 0] } },
    "4": { class_type: "SaveImage", inputs: { images: ["3", 0] } },
  };

  // Both workers report the SAME two filenames: ComfyUI numbers outputs from
  // each machine's own counter, so a collision across children of one parent
  // is the normal case, not an edge case. The `subfolder` (= the owning
  // child's id) is what keeps the four apart.
  const COLLIDING_FILES = ["ComfyUI_00001_.png", "ComfyUI_00002_.png"];

  interface SplitAgent {
    workerId: string;
    seedHex: string;
    ws: WebSocket;
  }

  /** setup + login, returning the console session. */
  async function loginAdmin(): Promise<{ cookie: string; csrf: string }> {
    const setupRes = await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
    expect(setupRes.status).toBe(200);
    const loginRes = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
    expect(loginRes.status).toBe(200);
    return { cookie: loginRes.setCookie!, csrf: loginRes.body.csrf as string };
  }

  /** Registers a worker, opens its agent WS, declares protocol 2 with the
   * split node classes, and reports idle -- polling the worker row each time
   * so the next dispatch tick really sees an idle, node-capable worker. */
  async function connectIdleSplitWorker(
    cookie: string,
    csrf: string,
    name: string,
    keypairIndex: number
  ): Promise<SplitAgent> {
    const tokenRes = await call("/api/workers/tokens", { json: { name }, cookie, headers: { "X-CSRF": csrf } });
    expect(tokenRes.status).toBe(200);
    const kp = golden.keypairs[keypairIndex]!;
    const registerRes = await call("/api/agent/register", {
      json: { token: tokenRes.body.bundle.register_token, pubkey: kp.pubkey_hex },
    });
    expect(registerRes.status).toBe(200);
    const workerId = registerRes.body.worker_id as string;
    const ws = await connectAgent(workerId, kp.seed_hex);

    const helloNone = expectNoMessage(ws, 250);
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 2,
        backend: "cuda",
        torch_version: "2.4.0",
        platform: "Linux",
        hardware: { vram_gb: 24, gpu_name: "RTX4090" },
        node_classes: SPLIT_NODE_CLASSES,
      })
    );
    await helloNone;
    await waitFor(
      async () => {
        const row = await db()
          .prepare("SELECT protocol, node_classes FROM workers WHERE id = ?")
          .bind(workerId)
          .first<{ protocol: number; node_classes: string }>();
        return row && row.protocol === 2 ? row : undefined;
      },
      { label: `worker ${name} row reflects hello` }
    );

    const idleNone = expectNoMessage(ws, 200);
    ws.send(JSON.stringify({ type: "heartbeat", state: "idle" }));
    await idleNone;
    await waitFor(
      async () => {
        const row = await db().prepare("SELECT status FROM workers WHERE id = ?").bind(workerId).first<{ status: string }>();
        return row?.status === "online" ? true : undefined;
      },
      { label: `worker ${name} is idle/online` }
    );

    return { workerId, seedHex: kp.seed_hex, ws };
  }

  interface ChildRow {
    id: string;
    split_index: number;
    worker_id: string | null;
    workflow_json: string;
    signature: string | null;
  }

  async function childRows(parentId: string): Promise<ChildRow[]> {
    const { results } = await db()
      .prepare(
        "SELECT id, split_index, worker_id, workflow_json, signature FROM jobs WHERE parent_id = ? ORDER BY split_index ASC"
      )
      .bind(parentId)
      .all<ChildRow>();
    return results;
  }

  /** Uploads one artifact through the presign + raw-PUT direct-mode flow --
   * the same two calls the main chain's step 11 proved. */
  async function uploadArtifact(agent: SplitAgent, jobId: string, filename: string, text: string): Promise<void> {
    const bytes = new TextEncoder().encode(text);
    const sha = await sha256Hex(bytes);
    const presignBody = new TextEncoder().encode(JSON.stringify({ filename, sha256: sha, size: bytes.length }));
    const presignRes = await signedCall(
      agent.workerId,
      agent.seedHex,
      "POST",
      `/api/agent/jobs/${jobId}/artifacts/presign`,
      presignBody
    );
    expect(presignRes.status).toBe(200);
    const putRes = await raw(presignRes.body.url, { method: "PUT", body: bytes });
    expect(putRes.status).toBe(200);
    expect(putRes.body.sha256).toBe(sha);
  }

  /** Pushes a job's `started_at` an hour into the past so the wall-clock cap
   * in `createAndPushReceipt` (gpuSeconds = min(exec, wall)) can't shave the
   * reported exec_seconds down to a fast test run's near-zero span. */
  async function backdateStartedAt(jobId: string): Promise<void> {
    const hourAgo = toSqliteTimestamp(new Date(Date.now() - 3600_000));
    await db().prepare("UPDATE jobs SET started_at = ? WHERE id = ?").bind(hourAgo, jobId).run();
  }

  it(
    "splits a batch_size=4 panel prompt across two workers, merges the four outputs, and keeps the prompt whole once split_batches is off",
    async () => {
      const { cookie, csrf } = await loginAdmin();
      const agentA = await connectIdleSplitWorker(cookie, csrf, "gpu-split-0", 0);
      const agentB = await connectIdleSplitWorker(cookie, csrf, "gpu-split-1", 1);
      const agentByWorker = new Map<string, SplitAgent>([
        [agentA.workerId, agentA],
        [agentB.workerId, agentB],
      ]);

      // -----------------------------------------------------------------
      // 1. Panel submit. The split plan is computed and stored AT SUBMIT
      // TIME (`split.planForJob` in routes/comfyapi.ts), before any tick.
      const promptRes = await call("/comfy/api/prompt", { json: { prompt: SPLIT_WORKFLOW }, cookie });
      expect(promptRes.status).toBe(200);
      const parentId = promptRes.body.prompt_id as string;

      const parentAtSubmit = await db()
        .prepare("SELECT split_plan, split_count FROM jobs WHERE id = ?")
        .bind(parentId)
        .first<{ split_plan: string; split_count: number }>();
      expect(JSON.parse(parentAtSubmit!.split_plan)).toEqual({ source_node_id: "1", batch_size: 4 });
      expect(parentAtSubmit!.split_count).toBe(0);

      // -----------------------------------------------------------------
      // 2. ONE dispatch tick: split into two children and push one to each
      // worker. Listeners attached before the alarm (see helpers/ws.ts).
      const pushA = nextMessage(agentA.ws);
      const pushB = nextMessage(agentB.ws);
      expect(await runDurableObjectAlarm(hub())).toBe(true);
      const pushed = [await pushA, await pushB];
      expect(pushed.map((p) => p.type)).toEqual(["job", "job"]);

      const children = await childRows(parentId);
      expect(children.map((c) => c.split_index)).toEqual([0, 1]);
      expect(new Set(children.map((c) => c.worker_id))).toEqual(new Set([agentA.workerId, agentB.workerId]));
      expect(JSON.parse(children[0]!.workflow_json)["cfsplit"].inputs).toEqual({
        samples: ["1", 0],
        batch_index: 0,
        length: 2,
      });
      expect(JSON.parse(children[1]!.workflow_json)["cfsplit"].inputs).toEqual({
        samples: ["1", 0],
        batch_index: 2,
        length: 2,
      });
      // The child's KSampler now eats the split node, not the batch source.
      expect(JSON.parse(children[0]!.workflow_json)["2"].inputs.latent_image).toEqual(["cfsplit", 0]);

      // Each connection got ITS OWN child's range on the wire.
      const frameByJob = new Map(pushed.map((p) => [p.job_id as string, p]));
      expect(new Set(frameByJob.keys())).toEqual(new Set(children.map((c) => c.id)));
      for (const child of children) {
        const wf = JSON.parse(frameByJob.get(child.id)!.workflow_json);
        expect(wf["cfsplit"].inputs.batch_index).toBe(child.split_index * 2);
        expect(wf["cfsplit"].inputs.length).toBe(2);
      }

      const parentAfterDispatch = await getJobById(db(), parentId);
      expect(parentAfterDispatch!.splitCount).toBe(2);
      // Claiming a child re-derives the parent in the SAME tick: `assignJobs`
      // calls `split.childStatusChanged` after every successful claim of a job
      // that has a `parent_id`, so the moment both children are `assigned` the
      // parent is `assigned` too (§3.4's `[... assigned] -> assigned` row).
      // Without it the parent would sit at `queued` until the first child's
      // busy heartbeat -- a whole window where the console shows `queued`
      // while two workers are already fetching. Same on the Python stack.
      expect(parentAfterDispatch!.status).toBe("assigned");
      expect(parentAfterDispatch!.workerId).toBeNull();

      // The panel's queue only ever shows the parent.
      const queueMid = await call("/comfy/api/queue", { method: "GET", cookie });
      const queuedIds = [...queueMid.body.queue_running, ...queueMid.body.queue_pending].map((e: any) => e[1]);
      expect(queuedIds).toEqual([parentId]);

      // -----------------------------------------------------------------
      // 3. Both children start running -> the parent is derived running with
      // the mean of their progress.
      for (const child of children) {
        const agent = agentByWorker.get(child.worker_id!)!;
        const none = expectNoMessage(agent.ws, 150);
        agent.ws.send(JSON.stringify({ type: "heartbeat", state: "busy", job_id: child.id, progress: 0.5 }));
        await none;
      }
      const runningParent = await waitFor(
        async () => {
          const job = await getJobById(db(), parentId);
          return job?.status === "running" && job.progress === 0.5 ? job : undefined;
        },
        { label: "parent derived running with the children's mean progress" }
      );
      expect(runningParent.workerId).toBeNull();

      // -----------------------------------------------------------------
      // 4. Each child uploads its two (identically named!) files and reports
      // job_done with exec_seconds; each earns exactly one receipt frame.
      for (const child of children) {
        const agent = agentByWorker.get(child.worker_id!)!;
        await backdateStartedAt(child.id);
        for (const name of COLLIDING_FILES) {
          await uploadArtifact(agent, child.id, name, `c${child.split_index}-${name}`);
        }
        const receiptPromise = nextMessage(agent.ws);
        agent.ws.send(
          JSON.stringify({
            type: "job_done",
            job_id: child.id,
            result_files: COLLIDING_FILES,
            exec_seconds: 12.5,
          })
        );
        const receipt = await receiptPromise;
        expect(receipt.type).toBe("receipt");
        expect(receipt.kind).toBe("completed");
        expect(receipt.billable).toBe(true);
        expect(receipt.payload).toBe(`${child.id}|${agent.workerId}|12.5`);
      }

      await waitFor(
        async () => {
          const job = await getJobById(db(), parentId);
          return job?.status === "done" ? job : undefined;
        },
        { label: "parent reaches done once both children finish" }
      );
      const doneParent = await getJobById(db(), parentId);
      expect(doneParent!.resultFiles).toEqual([]); // the parent owns no bytes

      // -----------------------------------------------------------------
      // 5. Panel history: only the parent, four images in batch order, each
      // carrying the id of the child that actually holds the bytes.
      const historyRes = await call("/comfy/api/history", { method: "GET", cookie });
      expect(Object.keys(historyRes.body)).toEqual([parentId]);
      const images = Object.values(historyRes.body[parentId].outputs).flatMap((o: any) => o.images ?? []);
      expect(images.map((i: any) => i.filename)).toEqual([...COLLIDING_FILES, ...COLLIDING_FILES]);
      expect(images.map((i: any) => i.subfolder)).toEqual([
        children[0]!.id,
        children[0]!.id,
        children[1]!.id,
        children[1]!.id,
      ]);

      // A child's own history entry is empty -- it isn't a panel job.
      const childHistory = await call(`/comfy/api/history/${children[0]!.id}`, { method: "GET", cookie });
      expect(childHistory.body).toEqual({});

      // -----------------------------------------------------------------
      // 6. /view resolves a COLLIDING filename by subfolder, serving each
      // child's own bytes.
      for (const child of children) {
        for (const name of COLLIDING_FILES) {
          const viewRes = await raw(
            `/comfy/api/view?filename=${encodeURIComponent(name)}&subfolder=${child.id}&type=output`,
            { cookie }
          );
          expect(viewRes.status).toBe(200);
          expect(viewRes.body).toBe(`c${child.split_index}-${name}`);
        }
      }

      // -----------------------------------------------------------------
      // 7. Console: the list hides children by default, `?include_children=1`
      // opts into all three rows.
      const listRes = await call("/api/jobs", { method: "GET", cookie });
      expect(listRes.body.map((j: any) => j.id)).toEqual([parentId]);
      expect(listRes.body[0].split_count).toBe(2);
      const listAllRes = await call("/api/jobs?include_children=1", { method: "GET", cookie });
      expect(new Set(listAllRes.body.map((j: any) => j.id))).toEqual(
        new Set([parentId, children[0]!.id, children[1]!.id])
      );
      expect(new Set(listAllRes.body.map((j: any) => j.parent_id))).toEqual(new Set([null, parentId]));

      // Parent detail: no receipt of its own, a child summary with per-child
      // gpu_seconds, the summed total, and the merged (child, file) outputs.
      const detailRes = await call(`/api/jobs/${parentId}`, { method: "GET", cookie });
      expect(detailRes.body.receipt).toBeNull();
      expect(detailRes.body.split_count).toBe(2);
      expect(detailRes.body.children.map((c: any) => c.split_index)).toEqual([0, 1]);
      expect(detailRes.body.children.map((c: any) => c.gpu_seconds)).toEqual([12.5, 12.5]);
      expect(detailRes.body.gpu_seconds_total).toBe(25);
      expect(detailRes.body.outputs).toEqual([
        { job_id: children[0]!.id, filename: COLLIDING_FILES[0] },
        { job_id: children[0]!.id, filename: COLLIDING_FILES[1] },
        { job_id: children[1]!.id, filename: COLLIDING_FILES[0] },
        { job_id: children[1]!.id, filename: COLLIDING_FILES[1] },
      ]);

      // -----------------------------------------------------------------
      // 8. Exactly two receipts, one per worker; none on the parent. And
      // final-review I1: NO speed sample for a child.
      expect(await getReceiptsForJob(db(), parentId)).toHaveLength(0);
      for (const child of children) {
        const receipts = await getReceiptsForJob(db(), child.id);
        expect(receipts).toHaveLength(1);
        expect(receipts[0]!.kind).toBe("completed");
        expect(receipts[0]!.billable).toBe(true);
        expect(receipts[0]!.gpuSeconds).toBe(12.5);
        expect(receipts[0]!.workerId).toBe(child.worker_id);
      }

      // Final-review I1：子 job 不進統計。子 job 繼承父 job 的簽章，卻只跑 1/k
      // 批；收它的 exec_seconds 會把這個簽章的 EWMA 拉到實際全批時間的 1/k
      // （這裡就是 12.5 而不是 25），speed_index 也跟著偏。後續：幫子 job 算一個
      // 含切片長度的自己的簽章。與 tests/server/test_agent_ws.py 的同一個 e2e 同步。
      const signature = children[0]!.signature;
      expect(children[1]!.signature).toBe(signature);
      for (const agent of [agentA, agentB]) {
        const statRow = await db()
          .prepare("SELECT ewma_seconds FROM worker_job_stats WHERE worker_id = ? AND signature = ?")
          .bind(agent.workerId, signature)
          .first<{ ewma_seconds: number }>();
        expect(statRow).toBeNull();
        const worker = await db()
          .prepare("SELECT speed_index FROM workers WHERE id = ?")
          .bind(agent.workerId)
          .first<{ speed_index: number }>();
        expect(worker!.speed_index).toBe(1);
      }

      // =====================================================================
      // 9. split_batches = false: the SAME prompt stays whole and goes to a
      // single worker.
      // =====================================================================
      const settingsRes = await call("/api/settings", {
        json: { split_batches: false },
        cookie,
        headers: { "X-CSRF": csrf },
      });
      expect(settingsRes.status).toBe(200);
      expect(settingsRes.body.split_batches).toBe(false);

      // Both workers back to idle so the next tick has somewhere to send it.
      for (const agent of [agentA, agentB]) {
        const none = expectNoMessage(agent.ws, 150);
        agent.ws.send(JSON.stringify({ type: "heartbeat", state: "idle" }));
        await none;
        await waitFor(
          async () => {
            const row = await db()
              .prepare("SELECT status FROM workers WHERE id = ?")
              .bind(agent.workerId)
              .first<{ status: string }>();
            return row?.status === "online" ? true : undefined;
          },
          { label: "worker back to idle before the no-split tick" }
        );
      }

      const prompt2Res = await call("/comfy/api/prompt", { json: { prompt: SPLIT_WORKFLOW }, cookie });
      expect(prompt2Res.status).toBe(200);
      const parent2 = prompt2Res.body.prompt_id as string;
      const parent2AtSubmit = await db()
        .prepare("SELECT split_plan FROM jobs WHERE id = ?")
        .bind(parent2)
        .first<{ split_plan: string | null }>();
      expect(parent2AtSubmit!.split_plan).toBeNull();

      const push2A = nextMessage(agentA.ws);
      const push2B = nextMessage(agentB.ws);
      expect(await runDurableObjectAlarm(hub())).toBe(true);
      const pushed2 = await Promise.race([push2A, push2B]);
      expect(pushed2.type).toBe("job");
      expect(pushed2.job_id).toBe(parent2);
      expect(JSON.parse(pushed2.workflow_json)["cfsplit"]).toBeUndefined();

      expect(await childRows(parent2)).toHaveLength(0);
      const parent2Row = await getJobById(db(), parent2);
      expect(parent2Row!.splitCount).toBe(0);
      expect(parent2Row!.status).toBe("assigned");
      expect([agentA.workerId, agentB.workerId]).toContain(parent2Row!.workerId);

      agentA.ws.close();
      agentB.ws.close();
    },
    30_000
  );

  it(
    "cancels a running split parent and tells BOTH children's workers",
    async () => {
      const { cookie, csrf } = await loginAdmin();
      const agentA = await connectIdleSplitWorker(cookie, csrf, "gpu-cancel-0", 0);
      const agentB = await connectIdleSplitWorker(cookie, csrf, "gpu-cancel-1", 1);
      const agentByWorker = new Map<string, SplitAgent>([
        [agentA.workerId, agentA],
        [agentB.workerId, agentB],
      ]);

      const promptRes = await call("/comfy/api/prompt", { json: { prompt: SPLIT_WORKFLOW }, cookie });
      const parentId = promptRes.body.prompt_id as string;

      const pushA = nextMessage(agentA.ws);
      const pushB = nextMessage(agentB.ws);
      expect(await runDurableObjectAlarm(hub())).toBe(true);
      await Promise.all([pushA, pushB]);

      const children = await childRows(parentId);
      expect(children).toHaveLength(2);
      for (const child of children) {
        const agent = agentByWorker.get(child.worker_id!)!;
        const none = expectNoMessage(agent.ws, 150);
        agent.ws.send(JSON.stringify({ type: "heartbeat", state: "busy", job_id: child.id, progress: 0.1 }));
        await none;
      }
      await waitFor(
        async () => {
          const job = await getJobById(db(), parentId);
          return job?.status === "running" ? job : undefined;
        },
        { label: "parent running with both children running" }
      );

      // Console cancel of the PARENT. Each child's worker must hear about its
      // OWN child -- not just whichever one the cascade happened to visit
      // first (the Task 6 fix-round-1 bug).
      // TWO frames per worker now (`job_cancelled`, then its cancelled
      // receipt), so a single listener has to collect both -- awaiting
      // `nextMessage` twice in a row would drop whichever arrives in the gap
      // (see helpers/ws.ts).
      const framesA = collectMessages(agentA.ws, 2);
      const framesB = collectMessages(agentB.ws, 2);
      const cancelRes = await call(`/api/jobs/${parentId}/cancel`, {
        method: "POST",
        cookie,
        headers: { "X-CSRF": csrf },
      });
      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.status).toBe("cancelled");

      const [collectedA, collectedB] = [await framesA, await framesB];
      const childIdByWorker = new Map(children.map((c) => [c.worker_id!, c.id]));
      expect(collectedA[0]).toEqual({ type: "job_cancelled", job_id: childIdByWorker.get(agentA.workerId) });
      expect(collectedB[0]).toEqual({ type: "job_cancelled", job_id: childIdByWorker.get(agentB.workerId) });

      // ...and THEN each worker is handed its cancelled receipt: the children
      // are what actually burned GPU, so every cascaded child that was running
      // at cancel time gets the same non-billable `cancelled` receipt the
      // single-job cancel path mints.
      for (const frame of [collectedA[1], collectedB[1]]) {
        expect(frame.type).toBe("receipt");
        expect(frame.kind).toBe("cancelled");
        expect(frame.billable).toBe(false);
        expect(frame.basis).toBe("wall");
      }

      const parentRow = await getJobById(db(), parentId);
      expect(parentRow!.status).toBe("cancelled");
      for (const child of children) {
        const row = await getJobById(db(), child.id);
        expect(row!.status).toBe("cancelled");
        expect(row!.error).toBe("cancelled by admin");
        expect(row!.workerId).toBeNull();
        expect(row!.lastWorkerId).toBe(child.worker_id);
        // Exactly one cancelled, non-billable receipt per child -- one per
        // worker, booked against the CHILD (the parent never had a
        // `started_at` of its own, so it stays receipt-free).
        const childReceipts = await getReceiptsForJob(db(), child.id);
        expect(childReceipts).toHaveLength(1);
        expect(childReceipts[0]!.kind).toBe("cancelled");
        expect(childReceipts[0]!.billable).toBe(false);
        expect(childReceipts[0]!.workerId).toBe(child.worker_id);
      }
      expect(await getReceiptsForJob(db(), parentId)).toHaveLength(0);

      agentA.ws.close();
      agentB.ws.close();
    },
    30_000
  );
});

// ===========================================================================
// Phase 3.4 Task 9: P2P NAT traversal, end to end.
//
// Parity twin: tests/server/test_peer.py's `test_e2e_*` block.
//
// Deliberately NOT the direct-DB `makeSeeder` shortcut peer.spec.ts uses:
// the point here is the whole chain wired together -- a real agent WS
// handshake (whose `ready` carries `CF-Connecting-IP`), a real hello, the
// Hub's reachability check really running, its verdict really deciding who
// counts as a seeder, and the grant route really emitting `seeder_urls` in
// the order the fetcher will try them. peerhealth.spec.ts / hub.spec.ts /
// peer.spec.ts remain the source of truth for each step's edge cases.
//
// `probePeerHealth` is the one function that really `fetch`es (see
// core/peerhealth.ts's docstring), so that is the mock seam -- and the
// hostname case must never reach it, which is why that test asserts zero
// calls rather than just a NULL verdict.

describe("Phase 3.4 e2e: reachability decides who seeds", () => {
  const KEYPAIRS = golden.keypairs;

  afterEach(async () => {
    vi.restoreAllMocks();
    await db().prepare("DELETE FROM model_hashes").run();
    await db().prepare("DELETE FROM p2p_grants").run();
  });

  /** Inserts a registered-looking worker row directly (ported from
   * hub.spec.ts's helper of the same name -- e2e.spec.ts has no `makeWorker`
   * of its own; its `connectIdleSplitWorker` is scoped to the split chain's
   * describe and drives the console register flow, which none of these
   * assertions need). A row plus its pubkey is all the agent WS handshake
   * and the signed grant POST look at. */
  async function makeWorker(opts: { pubkeyHex: string; id?: string }): Promise<string> {
    const id = opts.id ?? `w-${crypto.randomUUID().slice(0, 8)}`;
    await db()
      .prepare("INSERT INTO workers (id, name, pubkey, created_at, disabled, deleted) VALUES (?, ?, ?, ?, 0, 0)")
      .bind(id, id, opts.pubkeyHex, toSqliteTimestamp(new Date()))
      .run();
    return id;
  }

  async function peerColumns(workerId: string): Promise<any> {
    return db()
      .prepare("SELECT peer_url, peer_lan_url, peer_nat, peer_reachable, peer_checked_at, remote_ip FROM workers WHERE id = ?")
      .bind(workerId)
      .first<any>();
  }

  interface SeederSetup {
    seederId: string;
    pullerId: string;
    pullerSeed: string;
    name: string;
    sizeBytes: number;
    ready: any;
    pushed: any;
  }

  /** Brings up one seeder (real handshake + real hello, so the Hub's
   * reachability check really runs) and one puller, then gives the seeder
   * the inventory + consensus hash the grant route looks for.
   *
   * `expectPeerStatus: false` is the hostname case: `peerhealth.refresh`
   * never calls `notify` for a DNS-name `peer_url`, so there is no frame to
   * wait on -- the stamped `peer_checked_at` is the sync point instead. */
  async function setUpSeederAndPuller(opts: {
    seederPeerUrl: string;
    seederPeerLanUrl?: string;
    seederPeerNat?: string;
    seederRemoteIp: string;
    pullerRemoteIp: string;
    expectPeerStatus?: boolean;
  }): Promise<SeederSetup> {
    const seederKp = KEYPAIRS[0]!;
    const pullerKp = KEYPAIRS[1]!;
    const seederId = await makeWorker({ pubkeyHex: seederKp.pubkey_hex });
    const pullerId = await makeWorker({ pubkeyHex: pullerKp.pubkey_hex });
    const name = "checkpoints/e2e.safetensors";
    const sizeBytes = 4096;
    const sha256 = "a".repeat(64);

    const ws = await openAgentWs({ "CF-Connecting-IP": opts.seederRemoteIp });
    const challenge = await nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: "auth",
        worker_id: seederId,
        sig: await signHex(seederKp.seed_hex, new TextEncoder().encode(challenge.nonce)),
      })
    );
    const ready = await nextMessage(ws);
    expect(ready.type).toBe("ready");

    const expectPeerStatus = opts.expectPeerStatus ?? true;
    const statusPromise = expectPeerStatus ? nextMessage(ws) : null;
    ws.send(
      JSON.stringify({
        type: "hello",
        protocol: 4,
        peer_url: opts.seederPeerUrl,
        peer_lan_url: opts.seederPeerLanUrl ?? null,
        peer_nat: opts.seederPeerNat ?? "upnp",
      })
    );
    let pushed: any = null;
    if (statusPromise) {
      pushed = await statusPromise;
    } else {
      await waitFor(
        async () => ((await peerColumns(seederId)).peer_checked_at ? true : undefined),
        { label: "the hostname hello's check stamped peer_checked_at" }
      );
    }
    ws.close();

    await db()
      .prepare("UPDATE workers SET status = 'online', protocol = 4, model_inventory = ? WHERE id = ?")
      .bind(JSON.stringify([{ name, size_bytes: sizeBytes, sha256 }]), seederId)
      .run();
    await db()
      .prepare("UPDATE workers SET status = 'online', protocol = 4, remote_ip = ? WHERE id = ?")
      .bind(opts.pullerRemoteIp, pullerId)
      .run();
    await modelManifest.recordHash(db(), "some-worker", name, sizeBytes, sha256);

    return { seederId, pullerId, pullerSeed: pullerKp.seed_hex, name, sizeBytes, ready, pushed };
  }

  function postGrantRaw(pullerId: string, pullerSeed: string, body: { name: string; size_bytes: number }) {
    return signedCall(pullerId, pullerSeed, "POST", "/api/agent/peer-grant", new TextEncoder().encode(JSON.stringify(body)));
  }

  it("a verified seeder is granted with seeder_urls, and ready carried CF-Connecting-IP", async () => {
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const setup = await setUpSeederAndPuller({
      seederPeerUrl: "http://203.0.113.7:8850",
      seederPeerLanUrl: "http://192.168.1.5:8850",
      seederRemoteIp: "203.0.113.7",
      pullerRemoteIp: "198.51.100.9",
    });

    expect(setup.ready.remote_ip).toBe("203.0.113.7");
    expect(setup.pushed).toEqual({
      type: "peer_status",
      reachable: true,
      checked_url: "http://203.0.113.7:8850/peer/health",
    });
    expect(probe).toHaveBeenCalledWith("http://203.0.113.7:8850/peer/health");
    const columns = await peerColumns(setup.seederId);
    expect(columns.peer_reachable).toBe(1);
    expect(columns.peer_nat).toBe("upnp");
    expect(columns.remote_ip).toBe("203.0.113.7");

    const res = await postGrantRaw(setup.pullerId, setup.pullerSeed, { name: setup.name, size_bytes: setup.sizeBytes });

    expect(res.status).toBe(200);
    expect(res.body.seeder_urls).toEqual(["http://203.0.113.7:8850"]);
    expect(res.body.peer_url).toBe("http://203.0.113.7:8850");
    expect(res.body.grant.seeder_id).toBe(setup.seederId);
    expect(res.body.grant.puller_id).toBe(setup.pullerId);
  });

  it("an unreachable seeder is never chosen", async () => {
    vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(false);
    const setup = await setUpSeederAndPuller({
      seederPeerUrl: "http://203.0.113.7:8850",
      seederRemoteIp: "203.0.113.7",
      pullerRemoteIp: "198.51.100.9",
    });

    expect(setup.pushed).toEqual({
      type: "peer_status",
      reachable: false,
      checked_url: "http://203.0.113.7:8850/peer/health",
    });
    expect((await peerColumns(setup.seederId)).peer_reachable).toBe(0);

    const res = await postGrantRaw(setup.pullerId, setup.pullerSeed, { name: setup.name, size_bytes: setup.sizeBytes });

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("peer.no_seeder");
  });

  it("same remote_ip gets the LAN address first", async () => {
    vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(false);
    const setup = await setUpSeederAndPuller({
      seederPeerUrl: "http://203.0.113.7:8850",
      seederPeerLanUrl: "http://192.168.1.5:8850",
      seederRemoteIp: "203.0.113.7",
      pullerRemoteIp: "203.0.113.7",
    });

    expect((await peerColumns(setup.seederId)).peer_reachable).toBe(0);

    const res = await postGrantRaw(setup.pullerId, setup.pullerSeed, { name: setup.name, size_bytes: setup.sizeBytes });

    expect(res.status).toBe(200);
    expect(res.body.seeder_urls).toEqual(["http://192.168.1.5:8850", "http://203.0.113.7:8850"]);
    expect(res.body.peer_url).toBe("http://192.168.1.5:8850");
  });

  it("a hostname peer_url is never probed: not a seeder far away, still one on the same LAN", async () => {
    const probe = vi.spyOn(peerhealth, "probePeerHealth").mockResolvedValue(true);
    const setup = await setUpSeederAndPuller({
      seederPeerUrl: "http://seeder.example.com:8850",
      seederPeerLanUrl: "http://192.168.1.5:8850",
      seederPeerNat: "manual",
      seederRemoteIp: "203.0.113.7",
      pullerRemoteIp: "198.51.100.9",
      expectPeerStatus: false,
    });

    expect(setup.ready.remote_ip).toBe("203.0.113.7");
    expect(setup.pushed).toBeNull();
    expect(probe).not.toHaveBeenCalled();
    const columns = await peerColumns(setup.seederId);
    expect(columns.peer_reachable).toBeNull();
    expect(columns.peer_url).toBe("http://seeder.example.com:8850");

    const far = await postGrantRaw(setup.pullerId, setup.pullerSeed, { name: setup.name, size_bytes: setup.sizeBytes });
    expect(far.status).toBe(404);
    expect(far.body.error.code).toBe("peer.no_seeder");

    // The same seeder, seen from behind the same public IP, still seeds --
    // over the LAN address, with the (unverified) hostname as the fallback.
    const nearKp = KEYPAIRS[2]!;
    const nearId = await makeWorker({ pubkeyHex: nearKp.pubkey_hex });
    await db()
      .prepare("UPDATE workers SET status = 'online', protocol = 4, remote_ip = '203.0.113.7' WHERE id = ?")
      .bind(nearId)
      .run();

    const near = await postGrantRaw(nearId, nearKp.seed_hex, { name: setup.name, size_bytes: setup.sizeBytes });

    expect(near.status).toBe(200);
    expect(near.body.seeder_urls).toEqual(["http://192.168.1.5:8850", "http://seeder.example.com:8850"]);
    expect(near.body.grant.seeder_id).toBe(setup.seederId);
    expect(probe).not.toHaveBeenCalled();
  });
});
