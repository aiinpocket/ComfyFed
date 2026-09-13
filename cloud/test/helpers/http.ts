import worker from "../../src/index";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";

export interface CallOptions {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
  cookie?: string | null;
}

export interface CallResult {
  status: number;
  body: any;
  setCookie: string | null;
}

/** Fires one request through the real worker export (schema-guard middleware
 * + mounted routes included), the same pattern ping.spec.ts/schema-guard.spec.ts
 * use. Returns the parsed JSON body plus the raw `cf_session=...` cookie pair
 * (if any) from `Set-Cookie`, ready to forward as a `Cookie` header on the
 * next call -- there's no real cookie jar here, just a plain request/response
 * cycle against the Worker's fetch handler. */
export async function call(path: string, opts: CallOptions = {}): Promise<CallResult> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  if (opts.cookie) {
    headers["Cookie"] = opts.cookie;
  }

  const request = new Request(`http://example.com${path}`, {
    method: opts.method ?? (opts.json !== undefined ? "POST" : "GET"),
    headers,
    body,
  });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env as any, ctx);
  await waitOnExecutionContext(ctx);

  const setCookieHeader = response.headers.get("Set-Cookie");
  let setCookie: string | null = null;
  if (setCookieHeader) {
    setCookie = setCookieHeader.split(";")[0] ?? null; // "cf_session=<value>"
  }

  let json: any = null;
  const text = await response.text();
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }

  return { status: response.status, body: json, setCookie };
}

export function db(): D1Database {
  return (env as any).DB as D1Database;
}

export const SETUP_TOKEN = (env as any).SETUP_TOKEN as string;
