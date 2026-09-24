/** Base64 / base64url helpers operating on raw bytes. No Node Buffer, no
 * reliance on `btoa`/`atob` (those choke on bytes outside Latin1 unless
 * pre-escaped) -- Workers-safe. */

const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function encode(bytes: Uint8Array, alphabet: string, pad: boolean): string {
  let out = "";
  let i = 0;
  for (; i + 3 <= bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    const b2 = bytes[i + 2]!;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += alphabet[((b1 & 0x0f) << 2) | (b2 >> 6)];
    out += alphabet[b2 & 0x3f];
  }
  const remaining = bytes.length - i;
  if (remaining === 1) {
    const b0 = bytes[i]!;
    out += alphabet[b0 >> 2];
    out += alphabet[(b0 & 0x03) << 4];
    if (pad) out += "==";
  } else if (remaining === 2) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1]!;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += alphabet[(b1 & 0x0f) << 2];
    if (pad) out += "=";
  }
  return out;
}

function decode(str: string, alphabet: string): Uint8Array {
  const clean = str.replace(/=+$/, "");
  const lookup = new Map<string, number>();
  for (let i = 0; i < alphabet.length; i++) lookup.set(alphabet[i]!, i);

  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = lookup.get(ch);
    if (val === undefined) {
      throw new Error(`base64 decode: invalid character "${ch}"`);
    }
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

export function bytesToBase64(bytes: Uint8Array): string {
  return encode(bytes, STD_ALPHABET, true);
}

export function base64ToBytes(str: string): Uint8Array {
  return decode(str, STD_ALPHABET);
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  return encode(bytes, URL_ALPHABET, false);
}

export function base64UrlToBytes(str: string): Uint8Array {
  return decode(str, URL_ALPHABET);
}
