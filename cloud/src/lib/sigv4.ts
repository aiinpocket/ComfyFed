/**
 * Hand-rolled AWS Signature Version 4 presigned-URL signing (no npm
 * dependency -- WebCrypto HMAC/SHA-256 only), used by `routes/jobs.ts`'s
 * `POST /api/agent/jobs/{id}/artifacts/presign` to build an S3-compatible
 * presigned PUT URL against R2's S3 API when a deployment has configured
 * `R2_S3_*` credentials (see `env.ts`).
 *
 * Implements exactly the "presigned URL, query-string auth" variant of
 * SigV4 (RFC: AWS's "Authenticating Requests: Using Query Parameters"),
 * always with an `UNSIGNED-PAYLOAD` body hash -- correct for a PUT whose
 * body isn't known at signing time (the agent streams the artifact bytes
 * directly to R2, this Worker never sees them in the S3-mode path).
 *
 * Verified against AWS's own documented test vector in
 * `test/sigv4.spec.ts` (the "GET Object" query-string-auth example from
 * AWS's S3 REST API signing docs) -- a byte-exact match on the canonical
 * request, string-to-sign, and final signature confirms this
 * implementation, not just internal self-consistency.
 */

const encoder = new TextEncoder();

async function sha256Hex(data: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(data));
  return bytesToHex(new Uint8Array(digest));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(keyBytes: Uint8Array, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return new Uint8Array(sig);
}

/** `YYYYMMDD'T'HHMMSS'Z'` -- SigV4's `X-Amz-Date` format. */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export function amzDateStamp(date: Date): string {
  return amzDate(date).slice(0, 8);
}

/** Percent-encodes exactly the way SigV4 requires (RFC 3986 unreserved set
 * kept literal, everything else `%XX` uppercase-hex) -- `encodeURIComponent`
 * alone under-encodes `!'()*`, which SigV4 requires escaped too. */
export function uriEncode(value: string, encodeSlash = true): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()) as string;
  // Note: `encodeSlash` kept for API completeness (object keys with `/` are
  // encoded per-segment by the caller instead of relying on this flag).
  void encodeSlash;
}

function encodePathSegments(path: string): string {
  return path
    .split("/")
    .map((seg) => uriEncode(seg))
    .join("/");
}

export interface Sigv4PresignParams {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  service: string;
  /** Bucket-and-key path, e.g. `/my-bucket/artifacts/job1/out.png`. */
  path: string;
  host: string;
  method?: string;
  /** Seconds until the presigned URL expires (max 604800 per AWS). */
  expiresSeconds?: number;
  now?: Date;
  /** Extra query params to include in the signed query string (rare;
   * unused by the presign callers today but kept for completeness/tests). */
  extraQuery?: Record<string, string>;
}

/**
 * Builds a full presigned URL (`https://{host}{path}?...&X-Amz-Signature=...`)
 * for a query-string-authenticated SigV4 request with an unsigned payload.
 * `host` is signed as the sole `SignedHeaders` entry (just `host`), matching
 * AWS's own presigned-URL example -- correct for a plain PUT/GET with no
 * other headers the client must send.
 */
export async function presignUrl(params: Sigv4PresignParams): Promise<string> {
  const {
    accessKeyId,
    secretAccessKey,
    region,
    service,
    path,
    host,
    method = "PUT",
    expiresSeconds = 600,
    now = new Date(),
    extraQuery = {},
  } = params;

  const dateStamp = amzDateStamp(now);
  const amzDateVal = amzDate(now);
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const credential = `${accessKeyId}/${scope}`;

  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": credential,
    "X-Amz-Date": amzDateVal,
    "X-Amz-Expires": String(expiresSeconds),
    "X-Amz-SignedHeaders": "host",
    ...extraQuery,
  };

  const canonicalQuery = Object.keys(queryParams)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(queryParams[k]!)}`)
    .join("&");

  const canonicalUri = encodePathSegments(path);
  const canonicalHeaders = `host:${host}\n`;
  const signedHeaders = "host";
  const payloadHash = "UNSIGNED-PAYLOAD";

  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDateVal,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  const kDate = await hmac(encoder.encode(`AWS4${secretAccessKey}`), dateStamp);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  const kSigning = await hmac(kService, "aws4_request");
  const signatureBytes = await hmac(kSigning, stringToSign);
  const signature = bytesToHex(signatureBytes);

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** R2's S3-compatible endpoint host for a given account id. */
export function r2S3Host(accountId: string): string {
  return `${accountId}.r2.cloudflarestorage.com`;
}
