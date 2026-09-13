/** Hex <-> bytes helpers. No Node Buffer -- Workers-safe (WebCrypto/Web Streams only). */

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new Error(`hexToBytes: odd-length hex string (${hex.length} chars)`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byteHex = hex.slice(i * 2, i * 2 + 2);
    const byte = Number.parseInt(byteHex, 16);
    if (Number.isNaN(byte)) {
      throw new Error(`hexToBytes: invalid hex byte "${byteHex}" at offset ${i}`);
    }
    out[i] = byte;
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
