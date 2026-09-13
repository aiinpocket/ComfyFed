/**
 * Session gate for the embedded ComfyUI panel (`/comfy/*`), porting
 * `server/comfyfed_server/app.py`'s `_comfy_session_gate` HTTP middleware
 * exactly:
 *
 *   - `/comfy/api/*` is excluded: those routes (comfyapi.ts) carry their own
 *     `requireAdmin`/`requireCsrf` and must answer 401 JSON, not a redirect
 *     -- the panel's own `fetch()` calls can't usefully follow a login
 *     redirect.
 *   - Everything else under `/comfy` (the panel page itself, and every
 *     static asset it loads -- JS/CSS/fonts/images) is a browser navigation
 *     or a same-origin asset fetch, so an unauthenticated hit is redirected
 *     to `/` (the console's login), matching `RedirectResponse("/", 302)`.
 *   - The panel/agent WebSocket upgrade endpoints (`/comfy/ws`,
 *     `/comfy/api/ws`) are ALSO excluded, even though `/comfy/ws` doesn't
 *     start with `/comfy/api`: in Python, `@app.middleware("http")` only
 *     wraps HTTP request scopes, never the WebSocket upgrade scope, so
 *     `/comfy/ws` was never subject to `_comfy_session_gate` in the first
 *     place -- `do/hub.ts`'s `handlePanelWsUpgrade` already does its own
 *     cookie check (401 on failure) as the parity-preserving equivalent.
 *     Excluding it here (rather than relying on route-registration order in
 *     index.ts) makes that exclusion explicit and independently testable.
 *
 * Unlike Python, a Cloudflare Worker with an `ASSETS` binding + `wrangler.
 * jsonc`'s `run_worker_first: ["/comfy", "/comfy/*", ...]` means every
 * `/comfy*` request reaches THIS Worker first -- there is no separate
 * "static files mount" the platform falls through to on its own. So once a
 * request passes the gate (authenticated, or `/comfy/api/*`/websocket
 * exempt), something here must still serve the asset: `serveComfyAsset`
 * does that explicit `env.ASSETS.fetch(...)` passthrough for anything that
 * reaches it un-terminated by a more specific route (comfyapi.ts, the panel
 * WS handlers in index.ts).
 */

import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { readSession } from "./guard";

const COMFY_PREFIX = "/comfy";
const COMFY_API_PREFIX = "/comfy/api";
const COMFY_WS_PATH = "/comfy/ws";

function inComfy(path: string): boolean {
  return path === COMFY_PREFIX || path.startsWith(COMFY_PREFIX + "/");
}

function inComfyApi(path: string): boolean {
  return path === COMFY_API_PREFIX || path.startsWith(COMFY_API_PREFIX + "/");
}

/** True for a path the gate must never touch: `/comfy/api/*` (own auth) and
 * the panel WebSocket upgrade path (own auth, and not even an HTTP-scope
 * request on the Python side -- see file docstring). */
export function isGateExempt(path: string): boolean {
  return inComfyApi(path) || path === COMFY_WS_PATH;
}

/**
 * Hono middleware: redirects an unauthenticated request under `/comfy/*`
 * (excluding the exemptions above) to `/`, 302, exactly like
 * `_comfy_session_gate`. An authenticated (or exempt) request falls through
 * to `next()` so a more specific route (comfyapi.ts, the WS handlers) can
 * still claim it; anything left unclaimed after that is served as a static
 * asset by `serveComfyAsset` below.
 */
export const comfySessionGate: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (inComfy(path) && !isGateExempt(path)) {
    const payload = await readSession(c);
    if (!payload || !payload.authenticated) {
      return c.redirect("/", 302);
    }
  }
  await next();
};

/**
 * Serves a `/comfy/*` request that made it past `comfySessionGate` and
 * wasn't claimed by any more specific route (comfyapi.ts's routes,
 * index.ts's `/comfy/ws` handler) -- i.e. the panel page itself or one of
 * its static assets. A plain passthrough to the `ASSETS` binding: with
 * `not_found_handling: "single-page-application"` in wrangler.jsonc, a
 * missing path under `/comfy/` still resolves to the console's own
 * `index.html` at the assets root rather than a 404, same as any other
 * unmatched path once `run_worker_first` hands control back this way --
 * that fallback is intentionally NOT worked around here, it's the
 * platform's documented SPA behavior for the whole site.
 */
export function serveComfyAsset(c: { req: { raw: Request }; env: Env }): Promise<Response> {
  return c.env.ASSETS.fetch(c.req.raw);
}
