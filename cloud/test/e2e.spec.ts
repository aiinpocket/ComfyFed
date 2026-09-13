import { afterEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import { env, createExecutionContext, waitOnExecutionContext, runDurableObjectAlarm } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { connectAgent, connectPanel, collectMessages, expectNoMessage, hub, nextMessage } from "./helpers/ws";
import { signRequest } from "../src/lib/signing";
import { signHex } from "../src/lib/ed25519";
import { bytesToHex } from "../src/lib/hex";
import { getJobById, getReceiptsForJob } from "../src/db/queries";
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

afterEach(async () => {
  await db().prepare("DELETE FROM settings").run();
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
      const loginRes = await call("/api/auth/login", { json: { password: ADMIN_PASSWORD } });
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

      const workerRow = await db()
        .prepare("SELECT protocol, backend, node_classes, status FROM workers WHERE id = ?")
        .bind(workerId)
        .first<{ protocol: number; backend: string; node_classes: string; status: string }>();
      expect(workerRow!.protocol).toBe(2);
      expect(workerRow!.backend).toBe("cuda");
      const nodeClasses = JSON.parse(workerRow!.node_classes) as string[];
      expect(nodeClasses).toEqual(expect.arrayContaining(["LoadImage", "SaveImage"]));
      expect(workerRow!.status).toBe("online");

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
      expect(await store().get("staging/input.png")).not.toBeNull();

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
      // receipt_ack has no reply frame -- poll the DB for the write, same
      // pattern hub.spec.ts's job_done test uses.
      await new Promise((r) => setTimeout(r, 50));

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
      });
      const cancelledEntry = workerReport.receipts.find((r: any) => r.kind === "cancelled");
      expect(cancelledEntry).toEqual({
        job_id: jobId2,
        kind: "cancelled",
        billable: false,
        basis: "wall",
        gpu_seconds: receiptRow2.gpuSeconds,
        acked: false,
      });

      agent.close();
      panel.close();
    },
    20000
  );
});
