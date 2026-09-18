import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, header-based (slice 7.7).
 *
 * The S3-compatible storage provider signs its own requests instead of pulling
 * a vendor SDK: the algorithm is documented, the provider stays on the one
 * egress door (`safeFetch`), and a self-hoster's S3-compatible endpoint is
 * reachable without shipping the AWS SDK. The implementation is checked against
 * the examples AWS publishes as a test suite (GET Object, PUT Object, GET
 * Bucket Lifecycle, List Objects), so a change in canonicalization fails the
 * vectors rather than a live bucket.
 *
 * Only the shapes S3 needs are implemented: query parameters are distinct
 * names (repeated names, which this provider never sends, are not supported),
 * the payload hash is either a hex digest or the literal `UNSIGNED-PAYLOAD`
 * (which the provider uses to stream a body it has not buffered), and
 * `x-amz-content-sha256` is always signed.
 */

export interface SigV4Request {
  readonly method: string;
  /** The request URL; its path and query are what get canonicalized. */
  readonly url: URL;
  /** Headers the caller will send and wants signed, in any case. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Hex SHA-256 of the payload, or `UNSIGNED-PAYLOAD`. */
  readonly payloadHash: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  /** Included as `x-amz-security-token` and signed when the credentials are temporary. */
  readonly sessionToken?: string;
  readonly now: Date;
}

/**
 * URI-encodes one component the way SigV4 requires: every byte except
 * unreserved characters, uppercase hex, space as `%20`. `encodeURIComponent`
 * leaves `!'()*` alone and this fills that gap.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/** `20130524T000000Z`, the timestamp form the credential scope and signature use. */
export function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/** `20130524`, the date stamp the signing key is scoped to. */
export function dateStamp(date: Date): string {
  return amzDate(date).slice(0, 8);
}

/** The canonical query string: encoded name/value pairs, sorted by name. */
export function canonicalQueryString(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((name) => `${uriEncode(name)}=${uriEncode(query[name] ?? "")}`)
    .join("&");
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function hexDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function signingKey(
  secretAccessKey: string,
  date: string,
  region: string,
  service: string,
): Buffer {
  const dateKey = hmac(`AWS4${secretAccessKey}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, service);
  return hmac(serviceKey, "aws4_request");
}

/**
 * Signs one S3 request and returns the headers to send: the caller's headers
 * plus `host`, `x-amz-date`, `x-amz-content-sha256`, the session token when
 * there is one, and the `Authorization` header.
 */
export function signS3Request(request: SigV4Request): Readonly<Record<string, string>> {
  const service = "s3";
  const timestamp = amzDate(request.now);
  const date = dateStamp(request.now);
  const scope = `${date}/${request.region}/${service}/aws4_request`;

  const headers: Record<string, string> = {};

  // Header names are case-insensitive on the wire, so normalize before
  // canonicalizing: a caller passing `Content-Type` must sign the value it
  // actually sends.
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  headers["host"] = request.url.host;
  headers["x-amz-date"] = timestamp;
  headers["x-amz-content-sha256"] = request.payloadHash;

  if (request.sessionToken !== undefined) {
    headers["x-amz-security-token"] = request.sessionToken;
  }

  const names = Object.keys(headers)
    .map((name) => name.toLowerCase())
    .sort();
  const canonicalHeaders = names
    .map((name) => `${name}:${canonicalHeaderValue(headers[name] ?? "")}\n`)
    .join("");
  const signedHeaders = names.join(";");

  const canonicalRequest = [
    request.method.toUpperCase(),
    request.url.pathname === "" ? "/" : request.url.pathname,
    request.url.search === "" ? "" : canonicalQueryString(queryFrom(request.url)),
    canonicalHeaders,
    signedHeaders,
    request.payloadHash,
  ].join("\n");

  const stringToSign = ["AWS4-HMAC-SHA256", timestamp, scope, hexDigest(canonicalRequest)].join(
    "\n",
  );

  const signature = hmac(
    signingKey(request.secretAccessKey, date, request.region, service),
    stringToSign,
  ).toString("hex");

  return {
    ...headers,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${request.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function queryFrom(url: URL): Readonly<Record<string, string>> {
  const query: Record<string, string> = {};

  for (const [name, value] of url.searchParams) {
    query[name] = value;
  }

  return query;
}
