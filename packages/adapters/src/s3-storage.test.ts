import { CredentialMissingError } from "@porkbot/effect";
import { afterEach, describe, expect, it } from "vitest";
import { createMemoryCredentialStore } from "./credentials.ts";
import { S3CompatibleStorageProvider } from "./s3-storage.ts";
import { S3StorageEmulator } from "./s3-storage-emulator.ts";
import {
  StorageConfigurationError,
  StorageProtocolError,
  StorageProviderError,
} from "./storage-errors.ts";
import { storageConformance } from "./storage-conformance.ts";

/**
 * The S3-compatible provider against its offline emulator: the conformance
 * suite over the real wire protocol, plus the wire details the seam promises
 * (a signed request per operation, an unsigned payload for a streamed upload)
 * and the failure classification the shared vocabulary needs. No key here is
 * real and no request leaves the process.
 */

const accessKeyId = "test-access-key-id";
const secretAccessKey = "test-secret-access-key";
const accessKeyIdName = "storage-access-key-id";
const secretAccessKeyName = "storage-secret-access-key";

const openEmulators: S3StorageEmulator[] = [];

afterEach(async () => {
  await Promise.all(openEmulators.splice(0).map((emulator) => emulator.stop()));
});

async function startEmulator(pageSize = 3): Promise<S3StorageEmulator> {
  const emulator = await S3StorageEmulator.start({
    bucket: "porkbot-test",
    accessKeyId,
    secretAccessKey,
    pageSize,
  });

  openEmulators.push(emulator);

  return emulator;
}

function credentials(
  access = accessKeyId,
  secret = secretAccessKey,
): ReturnType<typeof createMemoryCredentialStore> {
  return createMemoryCredentialStore([
    [accessKeyIdName, access],
    [secretAccessKeyName, secret],
  ]);
}

function build(
  emulator: S3StorageEmulator,
  overrides: Partial<ConstructorParameters<typeof S3CompatibleStorageProvider>[0]> = {},
): S3CompatibleStorageProvider {
  return new S3CompatibleStorageProvider({
    endpoint: emulator.endpoint,
    bucket: emulator.bucket,
    credentials: credentials(),
    accessKeyIdCredentialName: accessKeyIdName,
    secretAccessKeyCredentialName: secretAccessKeyName,
    // The emulator speaks plain HTTP on loopback; the shipped default is the
    // URL-safety module, exercised in its own suite below.
    fetch: globalThis.fetch,
    ...overrides,
  });
}

async function createS3Harness(): Promise<{
  readonly storage: S3CompatibleStorageProvider;
  readonly reportsMissingDeletes: boolean;
}> {
  const emulator = await startEmulator();

  return { storage: build(emulator), reportsMissingDeletes: false };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the promise to reject");
}

function configurationError(run: () => unknown): StorageConfigurationError {
  try {
    run();
  } catch (error) {
    if (error instanceof StorageConfigurationError) {
      return error;
    }

    throw error;
  }

  throw new Error("expected a StorageConfigurationError");
}

storageConformance("the S3-compatible provider over the emulator", createS3Harness);

describe("the S3-compatible provider's wire contract", () => {
  it("signs every operation and sends an unsigned payload only for a streamed upload", async () => {
    const emulator = await startEmulator();
    const storage = build(emulator);
    const body = Buffer.from("home archive bytes", "utf8");

    await storage.put({
      key: "homes/bot-1.tar",
      body: (async function* () {
        yield body;
      })(),
      contentType: "application/gzip",
    });
    await storage.get("homes/bot-1.tar");

    const put = emulator.requests[0];
    const get = emulator.requests[1];

    expect(put?.method).toBe("PUT");
    expect(put?.path).toBe("/porkbot-test/homes/bot-1.tar");
    expect(put?.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=test-access-key-id\//);
    expect(put?.contentSha256).toBe("UNSIGNED-PAYLOAD");
    expect(put?.contentType).toBe("application/gzip");
    expect(put?.body.equals(body)).toBe(true);
    expect(get?.contentSha256).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("lists across continuation pages, so more objects than one page still arrive", async () => {
    const emulator = await startEmulator(2);
    const storage = build(emulator);

    for (const key of ["keys/a", "keys/b", "keys/c", "keys/d", "keys/e"]) {
      await storage.put({
        key,
        body: (async function* () {
          yield Buffer.from(key, "utf8");
        })(),
      });
    }

    const listed = await storage.list("keys/");

    expect(listed.map((object) => object.key)).toEqual([
      "keys/a",
      "keys/b",
      "keys/c",
      "keys/d",
      "keys/e",
    ]);
    expect(emulator.requests.some((request) => request.path.includes("continuation-token"))).toBe(
      true,
    );
  });

  it("fails closed before any request when the credential store does not hold the keys", async () => {
    const emulator = await startEmulator();
    const storage = build(emulator, { credentials: createMemoryCredentialStore() });

    const error = await rejection(storage.get("homes/bot-1.tar"));

    expect(error).toBeInstanceOf(CredentialMissingError);
    expect(emulator.requests).toEqual([]);
  });

  it("rates a refused credential as auth_failed and never echoes the key", async () => {
    const emulator = await startEmulator();
    const storage = build(emulator, { credentials: credentials(accessKeyId, "the-wrong-secret") });

    const error = await rejection(storage.get("homes/bot-1.tar"));

    expect(error).toBeInstanceOf(StorageProviderError);
    expect(error).toMatchObject({ kind: "auth_failed", status: 403 });
    expect(String((error as Error).message)).not.toContain("the-wrong-secret");
  });

  it("rates scripted throttling and transient failures as rate_limited", async () => {
    const cases = [
      [429, "SlowDown"],
      [503, "ServiceUnavailable"],
    ] as const;

    for (const [status, code] of cases) {
      const emulator = await startEmulator();
      const storage = build(emulator);
      emulator.failNext(status, code);

      const error = await rejection(storage.delete("attachments/one"));

      expect(error).toBeInstanceOf(StorageProviderError);
      expect(error).toMatchObject({ kind: "rate_limited", status });
    }
  });

  it("rates a missing bucket as gone", async () => {
    const emulator = await startEmulator();
    const storage = build(emulator, { bucket: "another-bucket" });

    const error = await rejection(storage.get("any/key"));

    expect(error).toBeInstanceOf(StorageProviderError);
    expect(error).toMatchObject({ kind: "gone", status: 404 });
  });

  it("rates a transfer that outlives its budget as timed_out", async () => {
    const emulator = await startEmulator();
    const storage = build(emulator, { timeoutMs: 25 });
    emulator.delayNext(500);

    const error = await rejection(storage.get("homes/bot-1.tar"));

    expect(error).toBeInstanceOf(StorageProviderError);
    expect(error).toMatchObject({ kind: "timed_out" });
  });

  it("raises a protocol error, not a guessed lifecycle kind, on an unclassifiable response", async () => {
    const emulator = await startEmulator();
    const storage = build(emulator);
    emulator.failNext(400, "InvalidRequest");

    const error = await rejection(storage.delete("attachments/one"));

    expect(error).toBeInstanceOf(StorageProtocolError);
    expect(error).toMatchObject({ status: 400 });
    expect(error).not.toBeInstanceOf(StorageProviderError);
  });

  it("refuses a read that answers without a content length rather than reporting zero bytes", async () => {
    const storage = build(await startEmulator(), {
      fetch: async () => new Response("no length", { status: 200 }),
    });

    const error = await rejection(storage.get("bots/bot-1/home/notes.txt"));

    expect(error).toBeInstanceOf(StorageProtocolError);
  });

  it("refuses a provider that repeats a continuation token instead of looping forever", async () => {
    const page =
      "<ListBucketResult>" +
      "<IsTruncated>true</IsTruncated>" +
      "<NextContinuationToken>the-same-token</NextContinuationToken>" +
      "<Contents><Key>a</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>1</Size></Contents>" +
      "</ListBucketResult>";
    const storage = build(await startEmulator(), {
      fetch: async () =>
        new Response(page, { status: 200, headers: { "content-type": "application/xml" } }),
    });

    const error = await rejection(storage.list(""));

    expect(error).toBeInstanceOf(StorageProtocolError);
    expect(String((error as Error).message)).toContain("repeated a continuation token");
  });
});

describe("the S3 emulator's signature verification", () => {
  it("refuses an unsigned raw request with a 403", async () => {
    const emulator = await startEmulator();

    const response = await fetch(`${emulator.endpoint}/${emulator.bucket}/raw.txt`, {
      method: "PUT",
      body: "raw",
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("AccessDenied");
    expect(emulator.objectKeys()).toEqual([]);
  });

  it("refuses a forged signature with a 403", async () => {
    const emulator = await startEmulator();

    const response = await fetch(`${emulator.endpoint}/${emulator.bucket}/raw.txt`, {
      method: "PUT",
      headers: {
        authorization:
          "AWS4-HMAC-SHA256 Credential=test-access-key-id/20130524/us-east-1/s3/aws4_request, " +
          "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
          `Signature=${"0".repeat(64)}`,
        "x-amz-content-sha256": "UNSIGNED-PAYLOAD",
        "x-amz-date": "20130524T000000Z",
      },
      body: "raw",
    });

    expect(response.status).toBe(403);
    await expect(response.text()).resolves.toContain("SignatureDoesNotMatch");
    expect(emulator.objectKeys()).toEqual([]);
  });
});

describe("the S3-compatible provider's configuration", () => {
  it("rejects a missing, malformed, credential-bearing, non-root or query-bearing endpoint", () => {
    const cases = [
      ["", "missing"],
      ["   ", "missing"],
      ["not a url", "invalid"],
      ["smtp://s3.example.invalid", "invalid"],
      ["https://user:password@s3.example.invalid", "invalid"],
      ["https://s3.example.invalid/mount", "invalid"],
      ["https://s3.example.invalid/?region=us-east-1", "invalid"],
      ["https://s3.example.invalid/#fragment", "invalid"],
    ] as const;

    for (const [endpoint, reason] of cases) {
      const error = configurationError(
        () =>
          new S3CompatibleStorageProvider({
            endpoint,
            bucket: "bucket",
            credentials: createMemoryCredentialStore(),
            accessKeyIdCredentialName: accessKeyIdName,
            secretAccessKeyCredentialName: secretAccessKeyName,
          }),
      );

      expect(error).toMatchObject({ setting: "endpoint", reason });
    }
  });

  it("rejects a missing or unusable bucket, region, credential name and timeout", () => {
    const base = {
      endpoint: "https://s3.example.invalid",
      bucket: "bucket",
      credentials: createMemoryCredentialStore(),
      accessKeyIdCredentialName: accessKeyIdName,
      secretAccessKeyCredentialName: secretAccessKeyName,
    } as const;

    expect(
      configurationError(() => new S3CompatibleStorageProvider({ ...base, bucket: " " })),
    ).toMatchObject({ setting: "bucket", reason: "missing" });
    expect(
      configurationError(() => new S3CompatibleStorageProvider({ ...base, bucket: "a/b" })),
    ).toMatchObject({ setting: "bucket", reason: "invalid" });
    expect(
      configurationError(() => new S3CompatibleStorageProvider({ ...base, region: " " })),
    ).toMatchObject({ setting: "region", reason: "missing" });
    expect(
      configurationError(
        () => new S3CompatibleStorageProvider({ ...base, accessKeyIdCredentialName: "  " }),
      ),
    ).toMatchObject({ setting: "accessKeyId", reason: "missing" });
    expect(
      configurationError(
        () => new S3CompatibleStorageProvider({ ...base, secretAccessKeyCredentialName: "" }),
      ),
    ).toMatchObject({ setting: "secretAccessKey", reason: "missing" });
    expect(
      configurationError(() => new S3CompatibleStorageProvider({ ...base, timeoutMs: 0 })),
    ).toMatchObject({ setting: "timeoutMs", reason: "invalid" });
  });

  it("refuses a plain-http endpoint through the shipped transport, without a request", async () => {
    const emulator = await startEmulator();
    const storage = new S3CompatibleStorageProvider({
      endpoint: emulator.endpoint,
      bucket: emulator.bucket,
      credentials: credentials(),
      accessKeyIdCredentialName: accessKeyIdName,
      secretAccessKeyCredentialName: secretAccessKeyName,
    });

    const error = await rejection(storage.get("anything"));

    expect(error).toBeInstanceOf(StorageConfigurationError);
    expect(error).toMatchObject({ setting: "endpoint", reason: "invalid" });
    expect(emulator.requests).toEqual([]);
  });
});
