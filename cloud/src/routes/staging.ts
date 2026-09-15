/**
 * `/api/staging` -- console-side management of the caller's OWN uploaded
 * reference files. Parity source: `comfyapi.create_staging_router` in
 * server/comfyfed_server/comfyapi.py (same paths, same shapes, same status
 * codes).
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
 * Scope is the caller's own uid with NO admin override: staging holds a
 * person's own reference images, and "admins can see everyone's uploads" is
 * a privacy regression, not a feature (same ruling as the panel's per-user
 * queue/history scoping). `SHARED_STAGING_UID`'s platform-shipped template
 * samples are likewise never listed and never deletable from here.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { requireUser, requireCsrfUser, errorJson, SESSION_VAR } from "../lib/guard";
// `stagingPrefix`/`stagingKey` both come from lib/store.ts, which owns the
// single `staging/` constant -- a local copy of the prefix here would let
// this listing and `stagingKey`'s delete silently address different
// namespaces if that constant were ever renamed.
import { stagingKey, stagingPrefix } from "../lib/store";

const app = new Hono<{ Bindings: Env }>();

app.get("/api/staging", requireUser, async (c) => {
  const uid = c.get(SESSION_VAR).user.uid;
  const prefix = stagingPrefix(uid);

  const objects: R2Object[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.env.STORE.list({ prefix, cursor });
    objects.push(...page.objects);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  const files = objects
    .map((o) => ({
      name: o.key.slice(prefix.length),
      size: o.size,
      // Unix seconds, matching Python's `os.stat().st_mtime`.
      modified: o.uploaded.getTime() / 1000,
    }))
    .filter((f) => f.name.length > 0)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return c.json({
    files,
    total_bytes: files.reduce((sum, f) => sum + f.size, 0),
  });
});

app.delete("/api/staging/:filename", requireCsrfUser, async (c) => {
  const uid = c.get(SESSION_VAR).user.uid;
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
