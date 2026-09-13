/** Worker bindings/vars shape, shared across index.ts and the route/lib
 * modules that need to type their Hono `Bindings` generic (routes importing
 * this instead of `./index` avoids a circular import back into the app
 * entrypoint). */
export interface Env {
  DB: D1Database;
  HUB: DurableObjectNamespace;
  STORE: R2Bucket;
  ASSETS: Fetcher;
  MODE: string;
  /** First-run setup gate (see routes/auth.ts `/api/setup`). Deliberately
   * absent from wrangler.jsonc's `vars` -- a freshly-deployed Worker with no
   * operator-chosen token must refuse `/api/setup` outright, not fall back
   * to a shipped default. Set for real via `wrangler secret put
   * SETUP_TOKEN`; the test suite injects a value via vitest.config.ts's
   * `miniflare.bindings` instead. */
  SETUP_TOKEN: string | undefined;
  /** Platform Ed25519 signing seed (hex, 32 bytes / 64 chars), set via
   * `wrangler secret put PLATFORM_ED25519_SEED`. Optional -- see
   * `db/queries.ts`'s `resolvePlatformSeed` for the env-wins-over-D1
   * resolution order and why. */
  PLATFORM_ED25519_SEED: string | undefined;
}
