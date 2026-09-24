/**
 * Cloud-local password hashing. NOT parity with the former Python server's
 * argon2-based hashing -- Workers' WebCrypto has no argon2, so this is
 * a deliberately different, self-describing scheme:
 *
 *   pbkdf2$<iterations>$<b64 salt>$<b64 hash>
 *
 * PBKDF2-HMAC-SHA256, 100000 iterations -- the HARD platform maximum:
 * Cloudflare Workers' WebCrypto rejects PBKDF2 above 100,000 iterations in
 * production (local workerd does NOT enforce it, so only a real deploy
 * surfaces the throw -- caught live during the Phase 2.0 deployment).
 * OWASP's 600k recommendation is therefore unreachable here; the login
 * backoff (auth.ts) and a single high-entropy admin password are the
 * compensating controls. The hash string is self-describing, so verify()
 * honors whatever iteration count a stored hash carries -- 16-byte random
 * salt, 32-byte derived key. Verification
 * uses a constant-time comparison built by XOR-accumulation (not
 * short-circuiting on the first mismatched byte) since Node's
 * `crypto.timingSafeEqual` is unavailable in the Workers runtime.
 */

import { bytesToBase64, base64ToBytes } from "./base64";

const ALGORITHM_TAG = "pbkdf2";
const ITERATIONS = 100_000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;

const encoder = new TextEncoder();

async function deriveBits(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await deriveBits(password, salt, ITERATIONS);
  return `${ALGORITHM_TAG}$${ITERATIONS}$${bytesToBase64(salt)}$${bytesToBase64(hash)}`;
}

/** Constant-time byte comparison: always walks the full (shorter of the two)
 * length and accumulates differences via OR, never branching or returning
 * early on a mismatch, so timing does not leak *where* two equal-length
 * buffers first differ. Different lengths are rejected -- length itself
 * isn't secret (a fixed-size digest), so short-circuiting on length is safe. */
function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!;
  }
  return diff === 0;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4) return false;
  const [tag, iterationsStr, saltB64, hashB64] = parts;
  if (tag !== ALGORITHM_TAG) return false;

  const iterations = Number.parseInt(iterationsStr!, 10);
  if (!Number.isInteger(iterations) || iterations <= 0 || String(iterations) !== iterationsStr) {
    return false;
  }

  let salt: Uint8Array;
  let expectedHash: Uint8Array;
  try {
    salt = base64ToBytes(saltB64!);
    expectedHash = base64ToBytes(hashB64!);
  } catch {
    return false;
  }
  if (salt.length === 0 || expectedHash.length === 0) return false;

  const actualHash = await deriveBits(password, salt, iterations);
  return constantTimeEqual(actualHash, expectedHash);
}
