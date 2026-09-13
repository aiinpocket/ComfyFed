import { Hono } from "hono";
import type { Env } from "./env";
import authRoutes from "./routes/auth";
import settingsRoutes from "./routes/settings";
import workersRoutes from "./routes/workers";

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

// Agent WebSocket: forwarded straight to the singleton Hub Durable Object
// (see do/hub.ts) -- one instance for the whole deployment, per
// progress.md's pre-flight ruling. The DO's own `fetch` handles the
// Upgrade negotiation; nothing about the handshake/protocol belongs here.
app.get("/api/agent/ws", (c) => {
  const stub = c.env.HUB.get(c.env.HUB.idFromName("hub"));
  return stub.fetch(c.req.raw);
});

app.route("/", authRoutes);
app.route("/", settingsRoutes);
app.route("/", workersRoutes);

export default app;
