/**
 * `/api/settings` GET/POST -- parity source: server/comfyfed_server/auth.py
 * (`_current_settings` / `read_settings` / `update_settings`). Every key the
 * Python settings surface exposes, ported: `platform_url`, `lang`,
 * `object_info_mode` (that is the complete set -- auth.py's settings router
 * defines no others; `admin_password_hash` and `session_secret` are internal
 * settings rows never surfaced through this endpoint).
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { getSetting, setSetting } from "../db/queries";
import { requireAdmin, requireCsrf, errorJson } from "../lib/guard";
import { MESSAGES } from "../core/auth";

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
}

async function currentSettings(db: D1Database): Promise<CurrentSettings> {
  return {
    platform_url: (await getSetting(db, PLATFORM_URL_KEY)) || "",
    lang: (await getSetting(db, LANG_KEY)) || "en",
    object_info_mode: (await getSetting(db, OBJECT_INFO_MODE_KEY)) || DEFAULT_OBJECT_INFO_MODE,
  };
}

const app = new Hono<{ Bindings: Env }>();

app.get("/api/settings", requireAdmin, async (c) => {
  return c.json(await currentSettings(c.env.DB));
});

app.post("/api/settings", requireCsrf, async (c) => {
  const body = await c.req
    .json<{ platform_url?: unknown; lang?: unknown; object_info_mode?: unknown }>()
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

  for (const [key, value] of Object.entries(updates)) {
    await setSetting(c.env.DB, key, value);
  }

  return c.json(await currentSettings(c.env.DB));
});

export default app;
