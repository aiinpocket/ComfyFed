/**
 * Vitest `globalSetup` (Node-side, runs once before the whole suite --
 * unlike `apply-migrations.ts`'s `setupFiles`, which runs per-test-file
 * INSIDE the workerd sandbox and has no `node:fs`).
 *
 * Copies the three real installer scripts from
 * `server/comfyfed_server/installers/` into
 * `test/fixtures/assets/install-templates/`, the directory
 * `vitest.config.ts`'s `miniflare.assets.directory` fixture root serves
 * through the `ASSETS` binding during tests. This lets `installer.spec.ts`
 * exercise the REAL templates (byte-for-byte, same source `build.mjs`
 * copies into the production `assets/` at build time) without checking in a
 * second copy that could drift from the real ones -- same reasoning as
 * `build.mjs`'s own installer-scripts step, just targeting the test fixture
 * root instead of the production `assets/` output.
 *
 * `fs.cp` copies raw bytes (no encoding pass), so install.ps1's UTF-8 BOM
 * and install.sh's LF-only endings survive intact, matching what the real
 * ASSETS binding serves in production.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(HERE, "..", "..", "server", "comfyfed_server", "installers");
const DEST_DIR = path.join(HERE, "fixtures", "assets", "install-templates");

export default async function globalSetup(): Promise<void> {
  await rm(DEST_DIR, { recursive: true, force: true });
  await mkdir(DEST_DIR, { recursive: true });
  await cp(SRC_DIR, DEST_DIR, { recursive: true, force: true });
}
