import { Hono } from "hono";
import type { Env } from "./env";
import authRoutes from "./routes/auth";
import settingsRoutes from "./routes/settings";
import workersRoutes from "./routes/workers";
import jobsRoutes from "./routes/jobs";
import comfyapiRoutes from "./routes/comfyapi";
import templatesRoutes from "./routes/templates";
import reportsRoutes from "./routes/reports";
import metricsRoutes from "./routes/metrics";
import { comfySessionGate, serveComfyAsset } from "./lib/gate";

export { Hub } from "./do/hub";
export type { Env };

const NOT_MIGRATED_HTML = `<!doctype html>
<html lang="zh-Hant">
<head><meta charset="utf-8"><title>503</title></head>
<body>
<h1>資料庫尚未初始化 / Database not migrated</h1>
<p>執行以下指令後再試一次 / Run the following, then retry:</p>
<pre>npx wrangler d1 migrations apply comfyfed --remote</pre>
</body>
</html>`;

// Cached per-isolate: once the settings table is confirmed present, skip the
// startup probe on every subsequent request in this isolate's lifetime. A
// fresh isolate (new deploy, cold start) re-probes once.
let schemaConfirmed = false;

async function isSchemaMissing(db: D1Database): Promise<boolean> {
  if (schemaConfirmed) return false;
  try {
    await db.prepare("SELECT 1 FROM settings LIMIT 1").first();
    schemaConfirmed = true;
    return false;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("no such table")) {
      return true;
    }
    // An unrelated D1 error shouldn't be masked as "not migrated" -- rethrow
    // so it surfaces normally (500) rather than a misleading migration page.
    throw err;
  }
}

const app = new Hono<{ Bindings: Env }>();

app.use("*", async (c, next) => {
  if (await isSchemaMissing(c.env.DB)) {
    return c.html(NOT_MIGRATED_HTML, 503);
  }
  await next();
});

app.get("/api/ping", (c) => c.json({ ok: true, mode: "cloud" }));

// Session gate for the embedded panel, ported from app.py's
// `_comfy_session_gate` -- see lib/gate.ts's docstring. Registered before
// the `/comfy/ws` / `/comfy/api/ws` handlers and the `/comfy/api/*` /
// `/comfy/templates/*` route mounts below: it exempts all of those by path
// itself (see `isGateExempt`), so an unauthenticated hit to any of them
// still reaches its own auth (401 JSON / DO cookie check) rather than being
// redirected -- only the panel page and its static assets get the 302.
app.use("*", comfySessionGate);

// `/comfy` (no trailing slash) -> `/comfy/`, mirroring app.py's
// `_comfy_root`: the pinned frontend derives its API base from
// `location.pathname`, so the trailing slash is load-bearing (see that
// handler's docstring in app.py for the full explanation). Placed after the
// gate (an unauthenticated hit here is already redirected to `/` above) and
// before the wildcard asset passthrough, since neither the assets binding's
// glob patterns nor `run_worker_first` are guaranteed to normalize this on
// their own.
app.get("/comfy", (c) => c.redirect("/comfy/", 307));

// Agent WebSocket: forwarded straight to the singleton Hub Durable Object
// (see do/hub.ts) -- one instance for the whole deployment, per
// progress.md's pre-flight ruling. The DO's own `fetch` handles the
// Upgrade negotiation; nothing about the handshake/protocol belongs here.
app.get("/api/agent/ws", (c) => {
  const stub = c.env.HUB.get(c.env.HUB.idFromName("hub"));
  return stub.fetch(c.req.raw);
});

// Panel WebSocket: same singleton Hub DO (see do/hub.ts's docstring -- "ONE
// Durable Object for agent+panel WS+alarm"). Served at both paths for the
// same reason comfyapi.py's `create_ws_router` does: the pinned frontend
// builds its socket URL as `api_base + "/ws"`, not through the `/api`-
// prefixing helper every other call goes through, so a panel served at
// `/comfy/` connects to `/comfy/ws`; `/comfy/api/ws` is kept as the
// explicit, documented address. Session-cookie auth happens inside the DO's
// `handlePanelWsUpgrade`, off the raw request -- nothing about it belongs here.
app.get("/comfy/api/ws", (c) => {
  const stub = c.env.HUB.get(c.env.HUB.idFromName("hub"));
  return stub.fetch(c.req.raw);
});
app.get("/comfy/ws", (c) => {
  const stub = c.env.HUB.get(c.env.HUB.idFromName("hub"));
  return stub.fetch(c.req.raw);
});

app.route("/", authRoutes);
app.route("/", settingsRoutes);
app.route("/", workersRoutes);
app.route("/", jobsRoutes);
app.route("/", comfyapiRoutes);
app.route("/", templatesRoutes);
app.route("/", reportsRoutes);
app.route("/", metricsRoutes);

// Anything under `/comfy/*` not claimed by a route above (the panel's own
// `index.html`, its JS/CSS/font/image bundle) has already passed
// `comfySessionGate` by the time it gets here -- serve it straight from the
// `ASSETS` binding (see gate.ts's `serveComfyAsset` docstring for why the
// Worker must do this itself rather than relying on the platform to fall
// through, given `run_worker_first` claims every `/comfy*` request).
app.get("/comfy/*", (c) => serveComfyAsset(c));

export default app;
