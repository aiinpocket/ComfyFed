/**
 * `/api/settings` GET/POST -- parity source: server/comfyfed_server/auth.py
 * (`_current_settings` / `read_settings` / `update_settings`). Every key the
 * Python settings surface exposes, ported: `platform_url`, `lang`,
 * `object_info_mode`, `upload_max_file_mb`, `upload_user_quota_gb` (that is
 * the complete set -- auth.py's settings router defines no others; `admin_password_hash` and `session_secret` are internal
 * settings rows never surfaced through this endpoint).
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { getSetting, setSetting } from "../db/queries";
import { requireAdmin, requireCsrf, errorJson } from "../lib/guard";
import { MESSAGES } from "../core/auth";
import {
  MAX_UPLOAD_MAX_FILE_MB,
  MAX_UPLOAD_USER_QUOTA_GB,
  MIN_UPLOAD_MAX_FILE_MB,
  MIN_UPLOAD_USER_QUOTA_GB,
  UPLOAD_MAX_FILE_MB_KEY,
  UPLOAD_USER_QUOTA_GB_KEY,
  readLimits,
} from "../lib/limits";

const PLATFORM_URL_KEY = "platform_url";
const LANG_KEY = "lang";
const OBJECT_INFO_MODE_KEY = "object_info_mode";
const OBJECT_INFO_MODES = ["union", "intersection"] as const;
const DEFAULT_OBJECT_INFO_MODE = "union";
const LANGS = ["zh-TW", "en"] as const;

interface CurrentSettings {
  platform_url: string;
  lang: string;
  object_info_mode: string;
  upload_max_file_mb: number;
  upload_user_quota_gb: number;
}

async function currentSettings(db: D1Database): Promise<CurrentSettings> {
  // Both upload limits go through `readLimits`'s DEFENSIVE parse rather than
  // being reported raw: a hand-edited or out-of-range row must read (and be
  // enforced) as the default, never as itself.
  const limits = await readLimits(db);
  return {
    platform_url: (await getSetting(db, PLATFORM_URL_KEY)) || "",
    lang: (await getSetting(db, LANG_KEY)) || "en",
    object_info_mode: (await getSetting(db, OBJECT_INFO_MODE_KEY)) || DEFAULT_OBJECT_INFO_MODE,
    upload_max_file_mb: limits.maxFileMb,
    upload_user_quota_gb: limits.quotaGb,
  };
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/settings", requireAdmin, async (c) => {
  return c.json(await currentSettings(c.env.DB));
});

app.post("/api/settings", requireCsrf, async (c) => {
  const body = await c.req
    .json<{
      platform_url?: unknown;
      lang?: unknown;
      object_info_mode?: unknown;
      upload_max_file_mb?: unknown;
      upload_user_quota_gb?: unknown;
    }>()
    .catch(() => ({}) as any);

  const updates: Record<string, string> = {};

  if (body.platform_url !== undefined && body.platform_url !== null) {
    if (typeof body.platform_url !== "string") {
      return errorJson(c, 400, "settings.bad_platform_url", MESSAGES.badPlatformUrl);
    }
    const url = body.platform_url.trim();
    if (url && !(url.startsWith("http://") || url.startsWith("https://"))) {
      return errorJson(c, 400, "settings.bad_platform_url", MESSAGES.badPlatformUrl);
    }
    updates[PLATFORM_URL_KEY] = url;
  }

  if (body.lang !== undefined && body.lang !== null) {
    if (typeof body.lang !== "string" || !(LANGS as readonly string[]).includes(body.lang)) {
      return errorJson(c, 400, "settings.bad_lang", MESSAGES.badLang);
    }
    updates[LANG_KEY] = body.lang;
  }

  if (body.object_info_mode !== undefined && body.object_info_mode !== null) {
    if (
      typeof body.object_info_mode !== "string" ||
      !(OBJECT_INFO_MODES as readonly string[]).includes(body.object_info_mode)
    ) {
      return errorJson(c, 400, "settings.bad_object_info_mode", MESSAGES.badObjectInfoMode);
    }
    updates[OBJECT_INFO_MODE_KEY] = body.object_info_mode;
  }

  // Validated STRICTLY here (an admin typing an out-of-range number deserves
  // to be told) even though every READ of these parses defensively -- the
  // lenient parse exists for rows not written through this endpoint.
  if (body.upload_max_file_mb !== undefined && body.upload_max_file_mb !== null) {
    const mb = Number(body.upload_max_file_mb);
    if (
      !Number.isFinite(mb) ||
      !Number.isInteger(mb) ||
      mb < MIN_UPLOAD_MAX_FILE_MB ||
      mb > MAX_UPLOAD_MAX_FILE_MB
    ) {
      return errorJson(
        c,
        400,
        "settings.bad_upload_max_file_mb",
        `單檔上限必須是 ${MIN_UPLOAD_MAX_FILE_MB}–${MAX_UPLOAD_MAX_FILE_MB} 之間的整數 MB。` +
          ` / Max file size must be a whole number of MB between ${MIN_UPLOAD_MAX_FILE_MB} and ${MAX_UPLOAD_MAX_FILE_MB}.`
      );
    }
    updates[UPLOAD_MAX_FILE_MB_KEY] = String(mb);
  }

  if (body.upload_user_quota_gb !== undefined && body.upload_user_quota_gb !== null) {
    const gb = Number(body.upload_user_quota_gb);
    if (!Number.isFinite(gb) || gb < MIN_UPLOAD_USER_QUOTA_GB || gb > MAX_UPLOAD_USER_QUOTA_GB) {
      return errorJson(
        c,
        400,
        "settings.bad_upload_user_quota_gb",
        `每人儲存配額必須介於 ${MIN_UPLOAD_USER_QUOTA_GB} 與 ${MAX_UPLOAD_USER_QUOTA_GB} GB 之間。` +
          ` / Per-user storage quota must be between ${MIN_UPLOAD_USER_QUOTA_GB} and ${MAX_UPLOAD_USER_QUOTA_GB} GB.`
      );
    }
    updates[UPLOAD_USER_QUOTA_GB_KEY] = String(gb);
  }

  for (const [key, value] of Object.entries(updates)) {
    await setSetting(c.env.DB, key, value);
  }

  return c.json(await currentSettings(c.env.DB));
});

export default app;
