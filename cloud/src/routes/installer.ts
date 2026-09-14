/**
 * `GET /install.ps1|.sh|.cmd` and `GET /api/platform` -- the one-line
 * installer endpoints. Parity source: `server/comfyfed_server/
 * installer_routes.py`, read in full -- see that module's docstring and the
 * "一行安裝指令 addendum" section of
 * `docs/superpowers/specs/2026-09-12-comfyfed-spec.md` for the binding spec
 * this ports, INCLUDING the security posture: `?token=` and the configured
 * `platform_url` are validated against the exact same regexes BEFORE any
 * substitution into the scripts' single-quoted string literals (never
 * escaped -- escaping rules differ between PowerShell/POSIX sh/cmd and
 * getting one wrong reopens the injection), every response (success AND
 * error) carries `Cache-Control: no-store`, and error bodies are fixed/typed
 * -- the raw payload is never echoed back.
 *
 * The three installer scripts are copied byte-for-byte at build time
 * (`cloud/scripts/build.mjs`) from `server/comfyfed_server/installers/` into
 * `assets/install-templates/`, and read here through the `ASSETS` binding --
 * same `env.ASSETS.fetch(new Request("https://.../<path>"))` pattern
 * `routes/templates.ts`'s `fetchPackagedRaw` uses. `wrangler.jsonc`'s
 * `run_worker_first` MUST list `/install.ps1`, `/install.sh`, `/install.cmd`
 * -- otherwise the assets binding would serve the raw (unsubstituted, and
 * for install.ps1, BOM-carrying) template straight off disk, bypassing this
 * route -- and its validation -- entirely.
 */

import { Hono } from "hono";
import type { Env } from "../env";
import { getSetting, resolvePlatformSeed } from "../db/queries";
import { derivePublicKeyHexFromSeed } from "../lib/ed25519";

const PLATFORM_URL_KEY = "platform_url";
const INSTALL_TEMPLATES_PREFIX = "install-templates/";

const CONTENT_TYPES = {
  "install.ps1": "text/plain; charset=utf-8",
  "install.sh": "text/plain; charset=utf-8",
  "install.cmd": "text/plain; charset=utf-8",
} as const satisfies Record<string, string>;

const NO_STORE_HEADERS = { "Cache-Control": "no-store" };

// `?token=` values are always `secrets.token_urlsafe`/`generateRegisterToken`
// (workers.ts) output: URL-safe-base64-without-padding -- letters, digits,
// `-`, `_`. Anything else is either not a real token or an attempt to break
// out of the single-quoted shell/PowerShell string literal these values get
// substituted into. Ported verbatim from installer_routes.py's `_TOKEN_RE`.
const TOKEN_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Same reasoning for the platform URL, also substituted verbatim into
// single-quoted string literals in all three scripts. Ported verbatim from
// installer_routes.py's `_PLATFORM_URL_RE`: scheme, host (letters/digits/
// dots/brackets for IPv6/colon for a port/hyphen/underscore), optional path
// of the usual unreserved URL characters. No query, no fragment, no quotes,
// backticks, `$`, or whitespace.
const PLATFORM_URL_RE = /^https?:\/\/[A-Za-z0-9.[\]:_-]+(\/[A-Za-z0-9._~/-]*)?$/;

class InvalidTokenError extends Error {}
class InvalidPlatformUrlError extends Error {}
class InvalidRequestOriginError extends Error {}

/** Fixed, typed error envelope -- matches installer_routes.py's
 * `_error_response` shape EXACTLY (`{error, message}`, flat -- NOT the
 * `{error: {code, message}}` envelope `lib/guard.ts`'s `errorJson` uses
 * elsewhere in this codebase, since `tests/server/test_installers.py`
 * asserts this exact flat shape and this route ports that test file). */
function errorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { "content-type": "application/json", ...NO_STORE_HEADERS },
  });
}

/** Strip a single leading U+FEFF BOM, matching Python's `utf-8-sig` decode
 * of `install.ps1` (stored with a BOM -- PowerShell 5.1's `-File` path needs
 * it to decode the bilingual 中文 strings on a non-UTF-8 system locale) so
 * the served body never leaks the BOM (or, decoded wrong, mojibake). A
 * no-op for install.sh/install.cmd, which carry no BOM. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

async function readTemplate(env: Env, filename: string): Promise<string> {
  const req = new Request(`https://assets.internal/${INSTALL_TEMPLATES_PREFIX}${filename}`);
  const res = await env.ASSETS.fetch(req);
  if (!res.ok) {
    throw new Error(`installer template missing from ASSETS binding: ${filename} (status ${res.status})`);
  }
  // `arrayBuffer()` + an explicit UTF-8 decode rather than `res.text()`:
  // the ASSETS binding guesses a content-type from the extension (e.g.
  // `application/x-sh` for install.sh), and `Response.text()` warns when
  // the guessed type doesn't look like text even though the bytes decode
  // as UTF-8 just fine.
  let text = stripBom(new TextDecoder("utf-8").decode(await res.arrayBuffer()));
  // install.sh only: a Windows checkout (or a zealous git autocrlf) that
  // turns the build-time copy into CRLF would otherwise be served verbatim
  // and die inside `bash` on the stray carriage returns.
  if (filename.endsWith(".sh")) {
    text = text.replace(/\r\n/g, "\n");
  }
  return text;
}

/** Resolve and validate the platform URL to substitute into a script.
 * Throws `InvalidPlatformUrlError` when the *configured* `platform_url`
 * setting fails validation (a server misconfiguration -- 500-style), or
 * `InvalidRequestOriginError` when there is no configured setting and the
 * request's own origin fails validation (client-supplied -- refused without
 * echoing the raw value back). */
async function resolvePlatformUrl(env: Env, requestUrl: string): Promise<string> {
  const configured = await getSetting(env.DB, PLATFORM_URL_KEY);
  if (configured) {
    const platformUrl = configured.replace(/\/+$/, "");
    if (!PLATFORM_URL_RE.test(platformUrl)) {
      throw new InvalidPlatformUrlError();
    }
    return platformUrl;
  }

  const base = new URL(requestUrl).origin;
  if (!PLATFORM_URL_RE.test(base)) {
    throw new InvalidRequestOriginError();
  }
  return base;
}

/** Resolve and validate the `?token=` query parameter, before it ever
 * reaches a template substitution. */
function resolveToken(tokenParam: string | undefined): string {
  const token = tokenParam ?? "";
  if (token && !TOKEN_RE.test(token)) {
    throw new InvalidTokenError();
  }
  return token;
}

async function renderScript(env: Env, filename: string, requestUrl: string, tokenParam: string | undefined): Promise<string> {
  // Validate BEFORE any substitution -- both values get spliced into
  // single-quoted shell/PowerShell string literals in the served scripts,
  // so an unvalidated value is a straight injection into whatever runs
  // `irm ... | iex` / `curl ... | bash`. Platform URL first, matching
  // installer_routes.py's `_render` order.
  const platformUrl = await resolvePlatformUrl(env, requestUrl);
  const token = resolveToken(tokenParam);

  let text = await readTemplate(env, filename);
  text = text.split("{{PLATFORM_URL}}").join(platformUrl);
  text = text.split("{{REGISTER_TOKEN}}").join(token);
  if (text.includes("{{TOKEN_QUERY}}")) {
    // install.cmd only: the literal query-string fragment it splices into
    // the `irm` URL it bootstraps -- the addendum's "handle empty token:
    // omit query" behavior. Percent-encoded like Python's `urllib.parse.quote`;
    // TOKEN_RE already restricts `token` to URL-safe characters, so this is
    // a no-op for any value that reaches here, but stays correct in shape.
    const tokenQuery = token ? `?token=${encodeURIComponent(token)}` : "";
    text = text.split("{{TOKEN_QUERY}}").join(tokenQuery);
  }
  return text;
}

function handleRenderError(err: unknown): Response {
  if (err instanceof InvalidTokenError) {
    return errorResponse(400, "invalid_token", "The token parameter is invalid.");
  }
  if (err instanceof InvalidPlatformUrlError) {
    return errorResponse(500, "invalid_platform_url", "The server's configured platform_url is invalid.");
  }
  if (err instanceof InvalidRequestOriginError) {
    return errorResponse(400, "invalid_request_origin", "Unable to determine a valid platform URL for this request.");
  }
  throw err;
}

const app = new Hono<{ Bindings: Env }>();

async function serve(filename: keyof typeof CONTENT_TYPES, c: { env: Env; req: { url: string; query: (name: string) => string | undefined } }): Promise<Response> {
  let text: string;
  try {
    text = await renderScript(c.env, filename, c.req.url, c.req.query("token"));
  } catch (err) {
    return handleRenderError(err);
  }
  return new Response(text, {
    headers: { "content-type": CONTENT_TYPES[filename], ...NO_STORE_HEADERS },
  });
}

app.get("/install.ps1", (c) => serve("install.ps1", c));
app.get("/install.sh", (c) => serve("install.sh", c));
app.get("/install.cmd", (c) => serve("install.cmd", c));

app.get("/api/platform", async (c) => {
  let platformUrl: string;
  try {
    platformUrl = await resolvePlatformUrl(c.env, c.req.url);
  } catch (err) {
    return handleRenderError(err);
  }
  const seed = await resolvePlatformSeed(c.env.DB, c.env.PLATFORM_ED25519_SEED);
  const platformPubkey = await derivePublicKeyHexFromSeed(seed);
  return c.json({ platform_url: platformUrl, platform_pubkey: platformPubkey });
});

export default app;
