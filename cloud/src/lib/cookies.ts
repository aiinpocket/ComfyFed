/**
 * Cloud-local signed session cookie. FORMAT is cloud-local HMAC-SHA256
 * (`b64url(payload-json).b64url(sig)`), not a port of Python's itsdangerous
 * `URLSafeTimedSerializer` token format -- but the SEMANTICS mirror
 * server/comfyfed_server/auth.py exactly:
 *
 *  - Phase 3.0: payload shape `{ uid, role, epoch, csrf }` (was `{
 *    authenticated, csrf }` pre-multiuser). A payload with no `uid` --
 *    including every pre-Phase-3.0 cookie -- is deliberately NOT mapped onto
 *    any account; `lib/guard.ts`'s session-to-`SessionUser` resolution
 *    treats it as unauthenticated, same as auth.py's `_session_user_from_
 *    payload` docstring: everyone re-authenticates once after this upgrade.
 *  - 7-day max-age, timestamp-checked on read (itsdangerous embeds the issue
 *    time in its token for `max_age` checks on `.loads()`; we embed it
 *    ourselves as `iat` in the JSON payload since a bare HMAC carries no
 *    timestamp of its own)
 *  - Per-user revocation via `epoch`, not secret rotation: pre-Phase-3.0,
 *    auth.py invalidated EVERY outstanding session by overwriting the
 *    stored HMAC signing secret (`session_secret` setting) on password
 *    change -- logging out the whole deployment for one person's password
 *    change. Phase 3.0 instead pins each cookie to the `session_epoch` its
 *    user had at issue time; a change-password/disable/reset-password bumps
 *    that user's `session_epoch`, which invalidates only THAT user's other
 *    cookies (`lib/guard.ts` checks `payload.epoch === user.sessionEpoch`).
 *    The global signing secret is no longer rotated by any of these flows.
 *
 * Tamper-detection note (see tests/server/test_auth.py's
 * `test_read_session_payload_rejects_absent_and_tampered_cookies` docstring):
 * a base64 group with leftover padding bits (length % 3 != 0) has a last
 * character whose low bits are always zero, so flipping the *last* character
 * of a base64-encoded value can accidentally decode to the exact same bytes
 * roughly 1-in-16 times -- a flaky, silent no-op mutation. Our HMAC-SHA256
 * signature is 32 bytes (32 % 3 == 2, same padding situation as the Python
 * side's issue), so tests here must mutate the second-to-last character of
 * the signature segment, not the last, exactly as that test's fix does.
 */

import { bytesToBase64Url, base64UrlToBytes } from "./base64";

export const COOKIE_MAX_AGE_SECONDS = 7 * 24 * 3600; // 7 days

/** Phase 3.0 cookie payload shape. `uid`/`role`/`epoch` are typed as
 * required here for the current signing path (`issueSessionCookie` always
 * writes all four), but a payload DECODED off an old or malformed cookie may
 * lack `uid` entirely -- callers must treat a missing `uid` as unauthenticated
 * (see `lib/guard.ts`'s `sessionUserFromPayload`) rather than assuming this
 * interface's required-ness is runtime-enforced. */
export interface SessionPayload {
  uid: string;
  role: string;
  epoch: number;
  csrf: string;
  [key: string]: unknown;
}

interface StoredPayload extends SessionPayload {
  iat: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Cryptographically random URL-safe CSRF token (mirrors the purpose of
 * Python's `secrets.token_urlsafe(32)`; exact byte length isn't a parity
 * requirement, only "sufficiently random and URL-safe" is). */
export function generateCsrfToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function signSessionCookie(
  secret: string,
  payload: SessionPayload,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<string> {
  const stored: StoredPayload = { ...payload, iat: nowSeconds };
  const payloadB64 = bytesToBase64Url(encoder.encode(JSON.stringify(stored)));

  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const sigB64 = bytesToBase64Url(new Uint8Array(sig));

  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify and decode a signed session cookie. Returns `null` for a missing,
 * malformed, tampered, or expired cookie -- never throws, mirroring
 * `auth.read_session_payload`'s "always resolves to a payload or None"
 * contract so callers don't need a try/catch around every read.
 */
export async function readSessionCookie(
  secret: string,
  cookieValue: string | null | undefined,
  maxAgeSeconds: number = COOKIE_MAX_AGE_SECONDS,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): Promise<SessionPayload | null> {
  if (!cookieValue) return null;

  const dot = cookieValue.indexOf(".");
  if (dot < 0 || cookieValue.indexOf(".", dot + 1) !== -1) return null; // exactly one '.'
  const payloadB64 = cookieValue.slice(0, dot);
  const sigB64 = cookieValue.slice(dot + 1);
  if (!payloadB64 || !sigB64) return null;

  let providedSig: Uint8Array;
  try {
    providedSig = base64UrlToBytes(sigB64);
  } catch {
    return null;
  }

  const key = await importHmacKey(secret);
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    providedSig,
    encoder.encode(payloadB64)
  );
  if (!valid) return null;

  let stored: StoredPayload;
  try {
    const json = decoder.decode(base64UrlToBytes(payloadB64));
    stored = JSON.parse(json) as StoredPayload;
  } catch {
    return null;
  }

  if (typeof stored !== "object" || stored === null || typeof stored.iat !== "number") {
    return null;
  }
  const age = nowSeconds - stored.iat;
  if (age < 0 || age > maxAgeSeconds) return null;

  return stored;
}
