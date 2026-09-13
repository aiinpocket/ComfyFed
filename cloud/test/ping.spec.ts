import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

describe("GET /api/ping", () => {
  it("returns ok:true, mode:cloud once migrations have applied", async () => {
    const request = new Request("http://example.com/api/ping");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env as any, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, mode: "cloud" });
  });
});
