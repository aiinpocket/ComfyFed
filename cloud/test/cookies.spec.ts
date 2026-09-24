import { describe, expect, it } from "vitest";
import {
  COOKIE_MAX_AGE_SECONDS,
  generateCsrfToken,
  readSessionCookie,
  signSessionCookie,
} from "../src/lib/cookies";

const SECRET = "test-secret-do-not-use-in-prod";

describe("session cookies", () => {
  it("signs and reads back the payload", async () => {
    const csrf = generateCsrfToken();
    const cookie = await signSessionCookie(SECRET, { uid: "u1", role: "admin", epoch: 0, csrf });
    const payload = await readSessionCookie(SECRET, cookie);
    expect(payload).not.toBeNull();
    expect(payload!.uid).toBe("u1");
    expect(payload!.role).toBe("admin");
    expect(payload!.epoch).toBe(0);
    expect(payload!.csrf).toBe(csrf);
  });

  it("rejects a missing cookie", async () => {
    expect(await readSessionCookie(SECRET, null)).toBeNull();
    expect(await readSessionCookie(SECRET, undefined)).toBeNull();
    expect(await readSessionCookie(SECRET, "")).toBeNull();
  });

  it("rejects a garbage cookie", async () => {
    expect(await readSessionCookie(SECRET, "not-a-cookie")).toBeNull();
    expect(await readSessionCookie(SECRET, "a.b.c")).toBeNull();
  });

  it("rejects a cookie signed with a different secret (secret-rotation semantics)", async () => {
    const cookie = await signSessionCookie(SECRET, { uid: "u1", role: "admin", epoch: 0, csrf: "x" });
    const payload = await readSessionCookie("a-different-secret", cookie);
    expect(payload).toBeNull();
  });

  it("rejects a tampered signature (flip the second-to-last char of a FULL base64 group)", async () => {
    // From the original Python case test_read_session_payload_rejects_absent_and_tampered_cookies's
    // docstring: our HMAC-SHA256 signature is 32 bytes (32 % 3 == 2), so its
    // base64url encoding's *last* character sits in a partially-filled group
    // whose low bits are always zero -- flipping it can silently decode to
    // the same bytes ~1/16 of the time. Flipping the second-to-last
    // character instead sits in a fully-populated group and always changes
    // the decoded bytes.
    const cookie = await signSessionCookie(SECRET, { uid: "u1", role: "admin", epoch: 0, csrf: "x" });
    const dot = cookie.indexOf(".");
    const sig = cookie.slice(dot + 1);
    const pos = sig.length - 2;
    const replacement = sig[pos] !== "A" ? "A" : "B";
    const tamperedSig = sig.slice(0, pos) + replacement + sig.slice(pos + 1);
    const tampered = cookie.slice(0, dot + 1) + tamperedSig;
    expect(tampered).not.toBe(cookie);
    expect(await readSessionCookie(SECRET, tampered)).toBeNull();
  });

  it("rejects a tampered payload even if the signature segment is untouched", async () => {
    const cookie = await signSessionCookie(SECRET, { uid: "u1", role: "admin", epoch: 0, csrf: "x" });
    const dot = cookie.indexOf(".");
    const payloadB64 = cookie.slice(0, dot);
    const pos = payloadB64.length - 2;
    const replacement = payloadB64[pos] !== "A" ? "A" : "B";
    const tamperedPayload = payloadB64.slice(0, pos) + replacement + payloadB64.slice(pos + 1);
    const tampered = tamperedPayload + cookie.slice(dot);
    expect(await readSessionCookie(SECRET, tampered)).toBeNull();
  });

  it("accepts a cookie right up to the max-age boundary and rejects just past it", async () => {
    const issuedAt = 1_000_000;
    const cookie = await signSessionCookie(SECRET, { uid: "u1", role: "admin", epoch: 0, csrf: "x" }, issuedAt);

    const stillValid = await readSessionCookie(
      SECRET,
      cookie,
      COOKIE_MAX_AGE_SECONDS,
      issuedAt + COOKIE_MAX_AGE_SECONDS
    );
    expect(stillValid).not.toBeNull();

    const expired = await readSessionCookie(
      SECRET,
      cookie,
      COOKIE_MAX_AGE_SECONDS,
      issuedAt + COOKIE_MAX_AGE_SECONDS + 1
    );
    expect(expired).toBeNull();
  });

  it("rejects a cookie whose iat is in the future (clock-skew abuse)", async () => {
    const issuedAt = 2_000_000;
    const cookie = await signSessionCookie(SECRET, { uid: "u1", role: "admin", epoch: 0, csrf: "x" }, issuedAt);
    const readEarlier = await readSessionCookie(
      SECRET,
      cookie,
      COOKIE_MAX_AGE_SECONDS,
      issuedAt - 1
    );
    expect(readEarlier).toBeNull();
  });

  it("generateCsrfToken returns distinct, URL-safe tokens", () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});
