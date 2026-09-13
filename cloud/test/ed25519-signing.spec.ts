import { describe, expect, it } from "vitest";
import { hexToBytes, bytesToHex } from "../src/lib/hex";
import { signHex, verifyHex } from "../src/lib/ed25519";
import {
  buildReceiptPayload,
  buildRegistrationPayload,
  buildReleasePayload,
  buildCanonicalRequestMessage,
  signRequest,
  verifySignedRequest,
} from "../src/lib/signing";
import golden from "./fixtures/golden.json";

const encoder = new TextEncoder();

describe("golden vector parity", () => {
  for (const [i, kp] of golden.keypairs.entries()) {
    describe(`keypair ${i}`, () => {
      it("every receipt payload/signature verifies against the fixture pubkey", async () => {
        for (const c of kp.receipt_cases) {
          const payload = buildReceiptPayload(c.job_id, c.worker_id, c.gpu_seconds);
          expect(payload).toBe(c.payload);
          const ok = await verifyHex(kp.pubkey_hex, encoder.encode(payload), c.signature_hex);
          expect(ok).toBe(true);
        }
      });

      it("registration cert payload/signature verifies against the fixture pubkey", async () => {
        const s = kp.registration_sample;
        const payload = buildRegistrationPayload(s.worker_id, s.pubkey_hex);
        expect(payload).toBe(s.payload);
        const ok = await verifyHex(kp.pubkey_hex, encoder.encode(payload), s.certificate_hex);
        expect(ok).toBe(true);
      });

      it("release signature payload/signature verifies against the fixture pubkey", async () => {
        const s = kp.release_sample;
        const payload = buildReleasePayload(s.version, s.sha256_hex);
        expect(payload).toBe(s.payload);
        const ok = await verifyHex(kp.pubkey_hex, encoder.encode(payload), s.signature_hex);
        expect(ok).toBe(true);
      });

      it("signed-request canonical message (with query) matches byte-for-byte and verifies", async () => {
        const s = kp.signed_request_sample;
        const body = hexToBytes(s.body_hex);
        const message = buildCanonicalRequestMessage(s.method, s.path, s.query, s.ts, s.nonce, body);
        expect(bytesToHex(message)).toBe(s.canonical_message_hex);
        const ok = await verifyHex(kp.pubkey_hex, message, s.signature_hex);
        expect(ok).toBe(true);
      });

      it("signed-request canonical message (no query, empty body) matches byte-for-byte and verifies", async () => {
        const s = kp.signed_request_sample_no_query;
        const body = hexToBytes(s.body_hex);
        const message = buildCanonicalRequestMessage(s.method, s.path, s.query, s.ts, s.nonce, body);
        expect(bytesToHex(message)).toBe(s.canonical_message_hex);
        const ok = await verifyHex(kp.pubkey_hex, message, s.signature_hex);
        expect(ok).toBe(true);
      });

      it("verifySignedRequest() end-to-end wrapper agrees", async () => {
        const s = kp.signed_request_sample;
        const body = hexToBytes(s.body_hex);
        const ok = await verifySignedRequest(
          kp.pubkey_hex,
          s.method,
          s.path,
          s.query,
          s.ts,
          s.nonce,
          body,
          s.signature_hex
        );
        expect(ok).toBe(true);
      });
    });
  }
});

describe("TS-signed round trips", () => {
  const kp = golden.keypairs[0]!;

  it("TS sign -> TS verify round trips for a receipt payload", async () => {
    const payload = buildReceiptPayload("job-x", "worker-x", 42.05);
    const sig = await signHex(kp.seed_hex, encoder.encode(payload));
    const ok = await verifyHex(kp.pubkey_hex, encoder.encode(payload), sig);
    expect(ok).toBe(true);
  });

  it("TS-signed receipt cross-checks against the fixture pubkey (same seed, independent signature)", async () => {
    // Different signature bytes than the fixture's (Ed25519 is randomized... actually
    // deterministic per RFC 8032, so this should equal the fixture signature exactly
    // for the same message and key).
    const c = kp.receipt_cases[0]!;
    const payload = buildReceiptPayload(c.job_id, c.worker_id, c.gpu_seconds);
    const sig = await signHex(kp.seed_hex, encoder.encode(payload));
    expect(sig).toBe(c.signature_hex);
    const ok = await verifyHex(kp.pubkey_hex, encoder.encode(payload), sig);
    expect(ok).toBe(true);
  });

  it("signRequest() produces a signature that verifies against the fixture pubkey", async () => {
    const s = kp.signed_request_sample_no_query;
    const body = hexToBytes(s.body_hex);
    const sig = await signRequest(kp.seed_hex, s.method, s.path, s.query, s.ts, s.nonce, body);
    expect(sig).toBe(s.signature_hex);
    const ok = await verifySignedRequest(
      kp.pubkey_hex,
      s.method,
      s.path,
      s.query,
      s.ts,
      s.nonce,
      body,
      sig
    );
    expect(ok).toBe(true);
  });

  it("verify fails for a corrupted signature", async () => {
    const payload = buildReceiptPayload("job-x", "worker-x", 1.0);
    const sig = await signHex(kp.seed_hex, encoder.encode(payload));
    const corrupted = (sig[0] === "0" ? "1" : "0") + sig.slice(1);
    const ok = await verifyHex(kp.pubkey_hex, encoder.encode(payload), corrupted);
    expect(ok).toBe(false);
  });

  it("verify fails for a message signed by a different keypair's key", async () => {
    const otherKp = golden.keypairs[1]!;
    const payload = buildReceiptPayload("job-x", "worker-x", 1.0);
    const sig = await signHex(kp.seed_hex, encoder.encode(payload));
    const ok = await verifyHex(otherKp.pubkey_hex, encoder.encode(payload), sig);
    expect(ok).toBe(false);
  });
});
