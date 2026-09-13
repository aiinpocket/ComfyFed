import { beforeAll } from "vitest";
import { env, applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";

declare const __D1_MIGRATIONS__: D1Migration[];

// See vitest.config.ts for why this exists: @cloudflare/vitest-pool-workers
// 0.22.x no longer auto-applies D1 migrations from wrangler.jsonc's
// migrations_dir. Runs once per test file (each file gets a fresh isolated
// D1 instance), before any test in that file.
beforeAll(async () => {
  await applyD1Migrations((env as any).DB, __D1_MIGRATIONS__);
});
