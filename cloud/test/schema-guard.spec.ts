import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

/**
 * The vitest-pool-workers D1 binding always auto-applies
 * cloud/migrations/*.sql (declared in wrangler.jsonc) before a test file's
 * requests run, so there is no way to spin up this test file's Worker
 * against a genuinely un-migrated D1 instance. Approach taken instead
 * (documented in task-1-report.md): simulate the "not migrated" condition
 * directly by DROPping the settings table that src/index.ts's startup probe
 * queries, then asserting the guard middleware turns that into the bilingual
 * 503 page rather than a raw D1 error. This exercises the exact code path
 * (isSchemaMissing's `no such table` match on the real D1 error message) the
 * middleware would hit on brand-new, un-migrated remote D1.
 *
 * This test's file gets its own isolated storage/isolate (vitest-pool-workers
 * default), so dropping the table here cannot affect ping.spec.ts /
 * migration.spec.ts, and no request in this file runs before the DROP below
 * warms the per-isolate `schemaConfirmed` cache in src/index.ts.
 */
describe("schema-missing guard", () => {
  it("serves the bilingual 503 page when settings table is missing", async () => {
    const db = (env as any).DB as D1Database;
    await db.prepare("DROP TABLE settings").run();

    const request = new Request("http://example.com/api/ping");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(503);
    const body = await response.text();
    expect(body).toContain("資料庫尚未初始化");
    expect(body).toContain("Database not migrated");
    expect(body).toContain("wrangler d1 migrations apply comfyfed --remote");
  });
});
