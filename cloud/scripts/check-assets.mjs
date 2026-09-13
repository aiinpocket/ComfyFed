#!/usr/bin/env node
// Fail-fast preflight for `npm run deploy` (final-review.md m5). `deploy`
// only runs migrations + `wrangler deploy` -- it never builds -- so on a
// fresh clone `cloud/assets/` (gitignored, produced by `npm run ci-build` /
// `npm run build`) doesn't exist yet, and `wrangler deploy` would otherwise
// fail deep inside its own asset-upload step with a message that doesn't
// point at the fix. Catch it here instead, before any Cloudflare API call.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cloudDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const marker = path.join(cloudDir, "assets", "index.html");

if (!existsSync(marker)) {
  console.error(
    [
      "cloud/assets/index.html 不存在 -- 部署前必須先建置前端。",
      "cloud/assets/index.html is missing -- the frontend must be built before deploying.",
      "",
      "執行 / Run:",
      "  npm run ci-build",
      "",
      "（deploy 本身不會建置，只跑 migrations + wrangler deploy，",
      "   以免 Workers Builds 重複打包 web/ 前端。）",
      "  (`deploy` itself never builds -- it only runs migrations + `wrangler",
      "   deploy` -- to avoid Workers Builds paying for the web/ frontend twice.)",
    ].join("\n")
  );
  process.exit(1);
}
