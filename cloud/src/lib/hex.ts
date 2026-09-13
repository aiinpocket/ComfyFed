/** Hex <-> bytes helpers. No Node Buffer -- Workers-safe (WebCrypto/Web Streams only). */

const HEX_STRICT_RE = /^[0-9a-fA-F]*$/;

export function hexToBytes(hex: string): Uint8Array {
  // Number.parseInt(chunk, 16) is not strict: it accepts leading whitespace
  // and stops at the first invalid character instead of rejecting the whole
  // chunk, so "1z" -> 1 and " 1" -> 1 silently instead of throwing. Validate
  // the entire string up front against a strict hex-digit-only pattern
  // before chunking, so any non-hex character (including whitespace)
  // anywhere in the string is rejected.
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length} chars)`);
  }
  if (!HEX_STRICT_RE.test(hex)) {
    throw new Error(`hexToBytes: invalid hex string (non-hex character present)`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byteHex = hex.slice(i * 2, i * 2 + 2);
    out[i] = Number.parseInt(byteHex, 16);
  }
  return out;
}

const HEX_CHARS = "0123456789abcdef";

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!;
    out += HEX_CHARS[b >> 4]! + HEX_CHARS[b & 0x0f]!;
  }
  return out;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return bytesToHex(new Uint8Array(digest));
}
