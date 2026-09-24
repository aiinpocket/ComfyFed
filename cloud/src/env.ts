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
  /** Optional R2 S3-compatible API credentials (Task 8's presign upload
   * protocol). When ALL FOUR are present, `POST
   * /api/agent/jobs/{id}/artifacts/presign` returns an aws4-sigv4-signed S3
   * PUT URL (`mode: "s3"`) instead of the platform-mediated "direct" upload
   * token flow -- lets a deployment's agents upload straight to R2's S3
   * endpoint, bypassing the Worker entirely for the bytes themselves. Absent
   * (the default) means every presign request gets `mode: "direct"`. Set via
   * `wrangler secret put R2_S3_*`; see `lib/sigv4.ts`. */
  R2_S3_ACCOUNT_ID: string | undefined;
  R2_S3_ACCESS_KEY_ID: string | undefined;
  R2_S3_SECRET_ACCESS_KEY: string | undefined;
  R2_S3_BUCKET: string | undefined;
}
