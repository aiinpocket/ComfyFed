import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// @cloudflare/vitest-pool-workers 0.22.x (targeting vitest 4's new
// plugin-based config API) dropped both the old `defineWorkersConfig` helper
// (from the now-removed "@cloudflare/vitest-pool-workers/config" subpath --
// see that package's dist/codemods/vitest-v3-to-v4.mjs for the shape this
// migrates to) AND the automatic "apply migrations from wrangler.jsonc's
// migrations_dir" behavior older versions had. The pool now only exposes:
//   - `readD1Migrations(dir)` (Node-side, reads .sql files from disk) here
//     at config time, and
//   - `applyD1Migrations(db, migrations)` (worker-side, from
//     `cloudflare:test`) which cloud/test/apply-migrations.ts calls in a
//     `beforeAll`, once per test file, before any test runs.
// The migrations are read here and threaded into the worker via `define` (a
// worker global) since Node's `fs` isn't available inside the Workers
// runtime. See task-1-report.md for the full writeup of this approach.
const migrations = await readD1Migrations("migrations");

export default defineConfig({
  define: {
    __D1_MIGRATIONS__: JSON.stringify(migrations),
  },
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Test-only SETUP_TOKEN: wrangler.jsonc deliberately ships none (see
      // its comment) so a real deployment refuses /api/setup until the
      // operator sets one via `wrangler secret put`. `miniflare.bindings`
      // merges over the wrangler-derived vars for the test Worker only.
      miniflare: { bindings: { SETUP_TOKEN: "test-setup-token" } },
    }),
  ],
});
