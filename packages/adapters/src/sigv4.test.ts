import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signS3Request } from "./sigv4.ts";

/**
 * The signer is checked against the examples AWS publishes as a test suite
 * (S3 User Guide, "Examples: Signature Calculations"). The credentials are the
 * documentation's own placeholders, not a real key, and the fixed timestamp
 * makes every value deterministic; a canonicalization change that the live
 * examples would reject fails here instead.
 */

const accessKeyId = "AKIAIOSFODNN7EXAMPLE";
const secretAccessKey = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const now = new Date("2013-05-24T00:00:00Z");
const region = "us-east-1";
const emptyPayloadHash = createHash("sha256").update("").digest("hex");

const credentials = { accessKeyId, secretAccessKey, region, now } as const;

describe("the SigV4 signer against the AWS examples", () => {
  it("matches the GET Object example", () => {
    const headers = signS3Request({
      ...credentials,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      headers: { range: "bytes=0-9" },
      payloadHash: emptyPayloadHash,
    });

    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("matches the PUT Object example with a signed payload", () => {
    const headers = signS3Request({
      ...credentials,
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/test%24file.text"),
      headers: {
        date: "Fri, 24 May 2013 00:00:00 GMT",
        "x-amz-storage-class": "REDUCED_REDUNDANCY",
      },
      payloadHash: "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072",
    });

    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class, " +
        "Signature=98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd",
    );
  });

  it("matches the GET Bucket Lifecycle example with an empty-value subresource", () => {
    const headers = signS3Request({
      ...credentials,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?lifecycle"),
      payloadHash: emptyPayloadHash,
    });

    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    );
  });

  it("matches the List Objects example with sorted query parameters", () => {
    const headers = signS3Request({
      ...credentials,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/?prefix=J&max-keys=2"),
      payloadHash: emptyPayloadHash,
    });

    expect(headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    );
  });
});

describe("the SigV4 signer's header set", () => {
  it("signs headers whatever case the caller used", () => {
    const lower = signS3Request({
      ...credentials,
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/home.tar"),
      headers: { "content-type": "application/gzip" },
      payloadHash: "UNSIGNED-PAYLOAD",
    });
    const mixed = signS3Request({
      ...credentials,
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/home.tar"),
      headers: { "Content-Type": "application/gzip" },
      payloadHash: "UNSIGNED-PAYLOAD",
    });

    expect(mixed["authorization"]).toBe(lower["authorization"]);
    expect(mixed["content-type"]).toBe("application/gzip");
  });

  it("signs a session token when the credentials are temporary", () => {
    const headers = signS3Request({
      ...credentials,
      method: "GET",
      url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
      payloadHash: emptyPayloadHash,
      sessionToken: "session-token-not-a-secret",
    });

    expect(headers["x-amz-security-token"]).toBe("session-token-not-a-secret");
    expect(headers["authorization"]).toContain("x-amz-security-token");
  });

  it("canonicalizes a streamed upload as unsigned without hashing it", () => {
    const headers = signS3Request({
      ...credentials,
      method: "PUT",
      url: new URL("https://examplebucket.s3.amazonaws.com/home.tar"),
      headers: { "content-type": "application/gzip" },
      payloadHash: "UNSIGNED-PAYLOAD",
    });

    expect(headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
    expect(headers["authorization"]).toContain("content-type;host;x-amz-content-sha256;x-amz-date");
  });
});
