import { Hono } from "hono";

export { Hub } from "./do/hub";

export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
  STORE: R2Bucket;
  ASSETS: Fetcher;
  MODE: string;
}

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

export default app;
