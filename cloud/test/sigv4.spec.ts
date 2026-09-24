import { describe, expect, it } from "vitest";
import { presignUrl } from "../src/lib/sigv4";

// AWS's own documented test vector for query-string (presigned URL) SigV4
// auth -- the "GET Object" example from "Authenticating Requests: Using
// Query Parameters (AWS Signature Version 4)" in the S3 API reference.
// Byte-exact agreement here is what proves this hand-rolled implementation
// against a real, independently-published reference rather than merely
// being internally self-consistent.
describe("presignUrl (AWS SigV4 query-auth test vector)", () => {
  it("matches AWS's documented GET Object presigned URL", async () => {
    const url = await presignUrl({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "s3",
      path: "/test.txt",
      host: "examplebucket.s3.amazonaws.com",
      method: "GET",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });

    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?" +
        "X-Amz-Algorithm=AWS4-HMAC-SHA256&" +
        "X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&" +
        "X-Amz-Date=20130524T000000Z&" +
        "X-Amz-Expires=86400&" +
        "X-Amz-SignedHeaders=host&" +
        "X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404"
    );
  });

  it("produces a different signature for a different secret key", async () => {
    const url = await presignUrl({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "different-secret-key-not-the-example-one",
      region: "us-east-1",
      service: "s3",
      path: "/test.txt",
      host: "examplebucket.s3.amazonaws.com",
      method: "GET",
      expiresSeconds: 86400,
      now: new Date("2013-05-24T00:00:00Z"),
    });
    expect(url).not.toContain("aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d07");
  });
});
