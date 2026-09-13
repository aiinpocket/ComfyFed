import { DurableObject } from "cloudflare:workers";

/**
 * Placeholder for the `Hub` Durable Object (agent WS + panel WS + dispatch
 * alarm -- see plan Tasks 6-7). This stub only exists so `wrangler.jsonc`'s
 * `HUB` binding and DO SQLite migration are valid and `wrangler dev` /
 * vitest-pool-workers can boot; no behavior is implemented yet.
 */
export class Hub extends DurableObject {
  async fetch(_request: Request): Promise<Response> {
    return new Response("Hub placeholder: not implemented (see plan Task 6/7).", {
      status: 501,
    });
  }
}
