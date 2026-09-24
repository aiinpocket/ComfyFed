/**
 * 2026-09-24 single-stack spec §2.2: `POST /api/workers/:id/update` (the
 * console's「立刻更新」button) and the Hub DO's `/internal/update_worker`
 * hop behind it. Drives a REAL agent WebSocket through the same handshake
 * hub.spec.ts uses, so the `update_agent` → `update_ack` round-trip is
 * exercised end to end, not mocked.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import { call, db, SETUP_TOKEN } from "./helpers/http";
import { connectAgent, hub, nextMessage } from "./helpers/ws";
import golden from "./fixtures/golden.json";

// Same reasoning as hub.spec.ts: every handshake arms a real dispatch alarm;
// keep it from firing inside an unrelated test.
async function deletePendingAlarm(): Promise<void> {
  await runInDurableObject(hub(), (_instance, state) => state.storage.deleteAlarm());
}

beforeEach(deletePendingAlarm);

afterEach(async () => {
  await deletePendingAlarm();
  await db().prepare("DELETE FROM settings").run();
  await db().prepare("DELETE FROM users").run();
  await db().prepare("DELETE FROM workers").run();
  await db().prepare("DELETE FROM register_tokens").run();
  await db().prepare("DELETE FROM nonces").run();
  await db().prepare("DELETE FROM login_attempts").run();
});

const ADMIN_PASSWORD = "correct-horse-battery-staple";

async function adminSession(): Promise<{ cookie: string | null; csrf: string }> {
  await call("/api/setup", { json: { token: SETUP_TOKEN, password: ADMIN_PASSWORD } });
  const login = await call("/api/auth/login", { json: { username: "admin", password: ADMIN_PASSWORD } });
  return { cookie: login.setCookie, csrf: login.body.csrf };
}

interface Admin {
  cookie: string | null;
  csrf: string;
}

/** Registers a worker through the real token → register flow (so the row
 * carries the golden pubkey `connectAgent` signs with), then stamps the
 * `hardware` JSON the way a hello would have. */
async function registerWorker(admin: Admin, agentVersion: string | null): Promise<{ workerId: string; seedHex: string }> {
  const kp = golden.keypairs[0]!;
  const issued = await call("/api/workers/tokens", {
    json: { name: "gpu-box" },
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
  expect(issued.status).toBe(200);
  const registered = await call("/api/agent/register", {
    json: { token: issued.body.bundle.register_token, pubkey: kp.pubkey_hex },
  });
  expect(registered.status).toBe(200);
  const workerId: string = registered.body.worker_id;
  const hardware = agentVersion === null ? {} : { gpu: "RTX 4090", agent_version: agentVersion };
  await db().prepare("UPDATE workers SET hardware = ? WHERE id = ?").bind(JSON.stringify(hardware), workerId).run();
  return { workerId, seedHex: kp.seed_hex };
}

function postUpdate(admin: Admin, workerId: string) {
  return call(`/api/workers/${workerId}/update`, {
    method: "POST",
    json: {},
    cookie: admin.cookie,
    headers: { "X-CSRF": admin.csrf },
  });
}

describe("POST /api/workers/:id/update", () => {
  it("401s without a session", async () => {
    const r = await call("/api/workers/whatever/update", { method: "POST", json: {} });
    expect(r.status).toBe(401);
  });

  it("404s workers.not_found for an unknown worker", async () => {
    const admin = await adminSession();
    const r = postUpdate(admin, "does-not-exist");
    expect((await r).status).toBe(404);
    expect((await r).body.error.code).toBe("workers.not_found");
  });

  it("404s for a soft-deleted worker", async () => {
    const admin = await adminSession();
    const { workerId } = await registerWorker(admin, "0.1.18");
    await db().prepare("UPDATE workers SET deleted = 1, disabled = 1 WHERE id = ?").bind(workerId).run();
    const r = await postUpdate(admin, workerId);
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe("workers.not_found");
  });

  it("409s workers.agent_too_old when hardware.agent_version is 0.1.17", async () => {
    const admin = await adminSession();
    const { workerId } = await registerWorker(admin, "0.1.17");
    const r = await postUpdate(admin, workerId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("workers.agent_too_old");
    expect(r.body.error.message).toContain("agent");
  });

  it("409s workers.agent_too_old when hardware.agent_version is missing", async () => {
    const admin = await adminSession();
    const { workerId } = await registerWorker(admin, null);
    const r = await postUpdate(admin, workerId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("workers.agent_too_old");
  });

  it("409s workers.offline when the agent is new enough but has no live socket", async () => {
    const admin = await adminSession();
    const { workerId } = await registerWorker(admin, "0.1.18");
    const r = await postUpdate(admin, workerId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("workers.offline");
  });

  it("pushes update_agent to the live socket and passes the agent's update_ack back", async () => {
    const admin = await adminSession();
    const { workerId, seedHex } = await registerWorker(admin, "0.1.18");
    const ws = await connectAgent(workerId, seedHex);

    const pushed = nextMessage(ws);
    const pending = postUpdate(admin, workerId);
    expect(await pushed).toEqual({ type: "update_agent" });

    ws.send(JSON.stringify({ type: "update_ack", status: "deferred", detail: "busy with job-1" }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "deferred", detail: "busy with job-1" });
    ws.close(1000, "done");
  });

  it("treats a malformed update_ack as failed", async () => {
    const admin = await adminSession();
    const { workerId, seedHex } = await registerWorker(admin, "0.1.18");
    const ws = await connectAgent(workerId, seedHex);

    const pushed = nextMessage(ws);
    const pending = postUpdate(admin, workerId);
    await pushed;

    ws.send(JSON.stringify({ type: "update_ack", status: "bogus" }));
    const r = await pending;
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "failed", detail: "malformed ack" });
    ws.close(1000, "done");
  });
});

describe("internal update_worker", () => {
  it("400s without a worker_id", async () => {
    const res = await hub().fetch("http://hub.internal/internal/update_worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("409s workers.offline with no live socket", async () => {
    const res = await hub().fetch("http://hub.internal/internal/update_worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: "nobody-home" }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("workers.offline");
  });

  it("answers status=sent when no update_ack arrives before the deadline", async () => {
    const admin = await adminSession();
    const { workerId, seedHex } = await registerWorker(admin, "0.1.18");
    const ws = await connectAgent(workerId, seedHex);

    const pushed = nextMessage(ws);
    // `timeout_ms` is a TEST-ONLY knob (see `handleInternalUpdateWorker`):
    // the route never forwards it, so production always waits the full 15 s.
    const res = await hub().fetch("http://hub.internal/internal/update_worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: workerId, timeout_ms: 200 }),
    });
    expect(await pushed).toEqual({ type: "update_agent" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "sent", detail: "" });
    ws.close(1000, "done");
  });

  it("truncates an over-long detail to 500 characters", async () => {
    const admin = await adminSession();
    const { workerId, seedHex } = await registerWorker(admin, "0.1.18");
    const ws = await connectAgent(workerId, seedHex);

    const pushed = nextMessage(ws);
    const pending = hub().fetch("http://hub.internal/internal/update_worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ worker_id: workerId }),
    });
    await pushed;
    ws.send(JSON.stringify({ type: "update_ack", status: "failed", detail: "x".repeat(600) }));
    const res = await pending;
    const body = (await res.json()) as { status: string; detail: string };
    expect(body.status).toBe("failed");
    expect(body.detail).toHaveLength(500);
    ws.close(1000, "done");
  });
});
