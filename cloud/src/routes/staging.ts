/**
 * `/api/staging` -- console-side management of the caller's OWN uploaded
 * reference files. Ported from the former Python server's
 * `comfyapi.create_staging_router` (2026-09; same paths, same shapes, same
 * status codes); this file is now the only implementation.
 *
 * Deliberately NOT part of the `/comfy/api` surface in routes/comfyapi.ts:
 * this is ComfyFed's own console API (standard `{error:{code,message}}`
 * envelope, `X-CSRF` on the mutation), not a ComfyUI-compatible endpoint.
 * What it manages is the same per-user staging namespace
 * (`lib/store.ts`'s `stagingKey`, R2 `staging/<uid>/<filename>`) that
 * `POST /comfy/api/upload/image` writes to, which until now nothing could
 * list or clean up -- an upload was permanent and invisible, so a user's
 * storage only ever grew.
 *
 * Scope is the caller's own uid by default. 2026-09-21 管理視角：an admin
 * may ask for `?scope=all` on the listing (every real user's uploads, each
 * row tagged with `user_id`/`username`) and `?user=<uid>` on the delete, so
 * the console's 檔案頁 can act on any user's uploads on their behalf. A
 * non-admin sending either is refused with 403 `auth.forbidden` -- the
 * default (own uid) stays exactly as it was. `SHARED_STAGING_UID`'s
 * platform-shipped template samples are never listed and never deletable
 * from here, admin included.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { requireUser, requireCsrfUser, errorJson, SESSION_VAR } from "../lib/guard";
// `stagingPrefix`/`stagingKey` both come from lib/store.ts, which owns the
// single `staging/` constant -- a local copy of the prefix here would let
// this listing and `stagingKey`'s delete silently address different
// namespaces if that constant were ever renamed.
import { SHARED_STAGING_UID, stagingKey, stagingPrefix, stagingRootPrefix } from "../lib/store";
import { readLimits, usageBreakdown } from "../lib/limits";
import { getUsernamesByIds } from "../db/queries";

const app = new Hono<{ Bindings: Env }>();

const FORBIDDEN = "需要管理員權限。 / Admin role required.";

async function listAll(store: R2Bucket, prefix: string): Promise<R2Object[]> {
  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}

interface StagingRow {
  name: string;
  size: number;
  modified: number;
  user_id?: string;
  username?: string | null;
}

function byName(a: StagingRow, b: StagingRow): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

app.get("/api/staging", requireUser, async (c) => {
  const user = c.get(SESSION_VAR).user;
  const uid = user.uid;
  const scopeAll = c.req.query("scope") === "all";
  if (scopeAll && user.role !== "admin") return errorJson(c, 403, "auth.forbidden", FORBIDDEN);

  let files: StagingRow[];
  if (scopeAll) {
    // 全平台：`staging/<uid>/<name>` 一次抽乾再按 uid 拆；`_shared` 是平台附
    // 的範本素材，不是誰的上傳，跳過。
    const root = stagingRootPrefix();
    const rows: StagingRow[] = [];
    for (const o of await listAll(c.env.STORE, root)) {
      const rest = o.key.slice(root.length);
      const slash = rest.indexOf("/");
      if (slash <= 0) continue;
      const owner = rest.slice(0, slash);
      const name = rest.slice(slash + 1);
      if (owner === SHARED_STAGING_UID || name.length === 0) continue;
      rows.push({ name, size: o.size, modified: o.uploaded.getTime() / 1000, user_id: owner });
    }
    const usernameById = await getUsernamesByIds(c.env.DB, [...new Set(rows.map((r) => r.user_id!))]);
    files = rows
      .map((r) => ({ ...r, username: usernameById.get(r.user_id!) ?? null }))
      .sort((a, b) => {
        const ua = a.username ?? a.user_id!;
        const ub = b.username ?? b.user_id!;
        return ua < ub ? -1 : ua > ub ? 1 : byName(a, b);
      });
  } else {
    const prefix = stagingPrefix(uid);
    files = (await listAll(c.env.STORE, prefix))
      .map((o) => ({
        name: o.key.slice(prefix.length),
        size: o.size,
        // Unix seconds, matching Python's `os.stat().st_mtime`.
        modified: o.uploaded.getTime() / 1000,
      }))
      .filter((f) => f.name.length > 0)
      .sort(byName);
  }

  // Additive fields only -- `files`/`total_bytes` keep their meaning (this
  // listing's own staging objects) so an older console still works.
  // `userdata_bytes` and `jobs_bytes` (2026-09-24) are the OTHER two pieces
  // of what the quota counts, so the console can show "used (staging +
  // userdata + jobs) of quota" without a second endpoint. `jobs_bytes` is
  // the caller's job artifacts + inputs from the per-job counters (see
  // lib/limits.ts); it is the CALLER's even under `scope=all`, where the
  // listing itself spans every user.
  const [limits, usage] = await Promise.all([readLimits(c.env.DB, uid), usageBreakdown(c.env.DB, c.env.STORE, uid)]);

  return c.json({
    files,
    total_bytes: files.reduce((sum, f) => sum + f.size, 0),
    quota_bytes: limits.quotaBytes,
    userdata_bytes: usage.userdata,
    jobs_bytes: usage.jobs,
  });
});

app.delete("/api/staging/:filename", requireCsrfUser, async (c) => {
  const user = c.get(SESSION_VAR).user;
  // `?user=<uid>`：admin 代刪別人的檔。一般使用者只能指到自己（等於沒帶）。
  const target = c.req.query("user");
  if (target !== undefined && target !== "" && target !== user.uid && user.role !== "admin") {
    return errorJson(c, 403, "auth.forbidden", FORBIDDEN);
  }
  const uid = target ? target : user.uid;
  if (uid === SHARED_STAGING_UID) return errorJson(c, 404, "staging.not_found", "檔案不存在。 / File not found.");
  let key: string;
  try {
    key = stagingKey(uid, c.req.param("filename"));
  } catch {
    return errorJson(c, 400, "staging.bad_name", "檔名不合法。 / Invalid filename.");
  }

  const existing = await c.env.STORE.head(key);
  if (!existing) {
    // Also the answer for "that file exists, but in SOMEBODY ELSE's staging
    // namespace" -- the caller's own uid is the only thing this route can
    // address, so another user's file is indistinguishable from a missing one.
    return errorJson(c, 404, "staging.not_found", "檔案不存在。 / File not found.");
  }
  await c.env.STORE.delete(key);
  // Staging objects are standalone bytes -- `/comfy/api/upload/image` writes
  // exactly one object per upload and `/comfy/api/prompt` COPIES it to
  // `job_inputs/<job_id>/<name>` at submit time, so there is no sidecar or
  // derived object to clean up, and already-submitted jobs keep their copy.
  return c.json({ ok: true });
});

export default app;
