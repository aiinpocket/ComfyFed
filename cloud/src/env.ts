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
  /** First-run setup gate (see routes/auth.ts `/api/setup`). A `vars` entry
   * in wrangler.jsonc for local dev/tests; production deployments should
   * override it with `wrangler secret put SETUP_TOKEN` instead of leaving
   * the plaintext var in source control. */
  SETUP_TOKEN: string;
}
