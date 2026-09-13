/**
 * WebCrypto Ed25519 sign/verify, hex in/out, matching PyNaCl's
 * `SigningKey(seed)` / `VerifyKey(pubkey).verify()` semantics used by
 * server/comfyfed_server/security.py and agentws.py.
 *
 * PyNaCl signing keys are stored as a raw 32-byte seed. WebCrypto's
 * `importKey("pkcs8", ...)` wants a full PKCS#8 DER document, so private-key
 * import wraps the 32-byte seed in the fixed PKCS#8 header for Ed25519
 * (RFC 8410 OneAsymmetricKey with no attributes/public key, algorithm OID
 * 1.3.101.112). That header is a *constant* 16-byte prefix -- Ed25519 seeds
 * are always exactly 32 bytes, so the ASN.1 lengths never vary:
 *
 *   30 2e                figure: SEQUENCE, 46 bytes follow
 *      02 01 00           INTEGER version = 0
 *      30 05              SEQUENCE (AlgorithmIdentifier), 5 bytes follow
 *         06 03 2b 65 70   OID 1.3.101.112 (id-Ed25519)
 *      04 22              OCTET STRING, 34 bytes follow (the CurvePrivateKey)
 *         04 20            OCTET STRING, 32 bytes follow (the raw seed)
 *            <32-byte seed>
 *
 * Public keys import directly via the "raw" format (WebCrypto supports raw
 * Ed25519 public keys natively -- no wrapping needed).
 */

import { hexToBytes, bytesToHex } from "./hex";

const PKCS8_ED25519_SEED_PREFIX_HEX = "302e020100300506032b657004220420";

export async function importPrivateKeyFromSeedHex(seedHex: string): Promise<CryptoKey> {
  const seed = hexToBytes(seedHex);
  if (seed.length !== 32) {
    throw new Error(`importPrivateKeyFromSeedHex: seed must be 32 bytes, got ${seed.length}`);
  }
  const prefix = hexToBytes(PKCS8_ED25519_SEED_PREFIX_HEX);
  const pkcs8 = new Uint8Array(prefix.length + seed.length);
  pkcs8.set(prefix, 0);
  pkcs8.set(seed, prefix.length);

  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
}

export async function importPublicKeyFromHex(pubkeyHex: string): Promise<CryptoKey> {
  const raw = hexToBytes(pubkeyHex);
  if (raw.length !== 32) {
    throw new Error(`importPublicKeyFromHex: public key must be 32 bytes, got ${raw.length}`);
  }
  return crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
}

/** Sign `message` with the Ed25519 seed given as hex; returns a 64-byte
 * signature as lowercase hex, matching PyNaCl's `SigningKey.sign(msg).signature.hex()`. */
export async function signHex(seedHex: string, message: Uint8Array): Promise<string> {
  const key = await importPrivateKeyFromSeedHex(seedHex);
  const sig = await crypto.subtle.sign({ name: "Ed25519" }, key, message);
  return bytesToHex(new Uint8Array(sig));
}

/** Verify a hex signature against `message` for the given hex public key.
 * Matches PyNaCl's `VerifyKey(pubkey).verify(msg, sig)` except it returns
 * `false` instead of raising on a bad signature or malformed inputs. */
export async function verifyHex(
  pubkeyHex: string,
  message: Uint8Array,
  signatureHex: string
): Promise<boolean> {
  try {
    const key = await importPublicKeyFromHex(pubkeyHex);
    const sig = hexToBytes(signatureHex);
    if (sig.length !== 64) return false;
    return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, message);
  } catch {
    return false;
  }
}
