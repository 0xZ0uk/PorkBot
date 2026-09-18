import type {
  CredentialStore,
  StorageBody,
  StorageObject,
  StorageProvider,
  StoragePutRequest,
} from "@porkbot/adapter-kit";
import { BlockedUrlError, CredentialMissingError, safeFetch } from "@porkbot/effect";
import type { SafeFetch, SafeFetchBody } from "@porkbot/effect";
import { canonicalQueryString, signS3Request, uriEncode } from "./sigv4.ts";
import {
  StorageConfigurationError,
  StorageProtocolError,
  StorageProviderError,
} from "./storage-errors.ts";
import { assertStorageKey } from "./storage-keys.ts";

/**
 * Storage on an S3-compatible endpoint (slice 7.7): AWS S3, MinIO, Cloudflare
 * R2, Wasabi or anything else that speaks the S3 REST API over HTTPS.
 *
 * The provider signs its own requests (SigV4, checked against the examples AWS
 * publishes) and dials through the URL-safety module's `safeFetch`, so storage
 * egress crosses the same door every other provider does and no vendor SDK is
 * needed. Requests are path-style: `{endpoint}/{bucket}/{key}`. Nothing here is
 * required for a self-hosted deployment — the local provider is the default and
 * works with no endpoint, no key and no network.
 *
 * Credentials are resolved by name from the injected `CredentialStore` on every
 * operation, never read from the environment here and never a constructor
 * argument. A name the store does not hold fails closed with
 * `CredentialMissingError` before any request; a key the provider refuses
 * (401/403) fails closed with `auth_failed`. An upload streams with
 * `x-amz-content-sha256: UNSIGNED-PAYLOAD`, which S3 accepts over HTTPS and
 * which is what lets a large artifact avoid being buffered; reads and deletes
 * sign the empty-body hash.
 *
 * Failure mapping: a refused credential is `auth_failed`, a missing bucket is
 * `gone`, throttling and transient 5xx are `rate_limited`, and a transfer that
 * exceeds its budget is `timed_out` with the partial upload discarded. A
 * response outside that set is a defect in this adapter and raises
 * `StorageProtocolError` rather than guessing a lifecycle kind.
 */

export interface S3CompatibleStorageProviderOptions {
  /**
   * The service root, e.g. `https://s3.example.com` or an R2/MinIO endpoint.
   * Embedded credentials are rejected: the keys belong in the credential store.
   */
  readonly endpoint: string;
  readonly bucket: string;
  /** The region the signature is scoped to; defaults to `us-east-1`. */
  readonly region?: string;
  /** Resolves the keys; never read from the environment here. */
  readonly credentials: CredentialStore;
  /** The store name holding the access key id. */
  readonly accessKeyIdCredentialName: string;
  /** The store name holding the secret access key. */
  readonly secretAccessKeyCredentialName: string;
  /** The store name holding a temporary session token, when the keys are temporary. */
  readonly sessionTokenCredentialName?: string;
  /**
   * Transport seam for the offline wire emulator, which speaks plain HTTP on
   * loopback; defaults to the URL-safety module's `safeFetch`, so a shipped
   * deployment only ever dials an HTTPS endpoint whose resolved address is
   * public (PRD decision 23).
   */
  readonly fetch?: SafeFetch;
  /** Per-transfer budget; defaults to 30 seconds. */
  readonly timeoutMs?: number;
  /** Clock seam for tests; defaults to the system clock. */
  readonly now?: () => Date;
}

const emptyPayloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const unsignedPayload = "UNSIGNED-PAYLOAD";
const defaultTimeoutMs = 30_000;
const maximumListPages = 1000;

interface SendSpec {
  readonly method: string;
  /** The raw object key; the bucket is prepended and each segment is encoded. */
  readonly key?: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: SafeFetchBody;
  readonly payloadHash: string;
}

interface ListedObject {
  readonly key: string;
  readonly size: number;
  readonly lastModified: string;
}

function resolveEndpoint(raw: string): URL {
  const endpoint = raw.trim();

  if (endpoint === "") {
    throw new StorageConfigurationError(
      "endpoint",
      "missing",
      "Set the S3-compatible endpoint URL, for example https://s3.example.com.",
    );
  }

  let url: URL;

  try {
    url = new URL(endpoint);
  } catch {
    throw new StorageConfigurationError(
      "endpoint",
      "invalid",
      "Expected an absolute http(s) URL, for example https://s3.example.com.",
    );
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new StorageConfigurationError(
      "endpoint",
      "invalid",
      `Expected an http(s) URL, got "${url.protocol}" instead.`,
    );
  }

  if (url.username !== "" || url.password !== "") {
    throw new StorageConfigurationError(
      "endpoint",
      "invalid",
      "Remove the credentials from the URL and store the keys in the credential store.",
    );
  }

  if (url.pathname !== "" && url.pathname !== "/") {
    throw new StorageConfigurationError(
      "endpoint",
      "invalid",
      "Use the service root as the endpoint; the bucket is a separate setting.",
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new StorageConfigurationError(
      "endpoint",
      "invalid",
      "The endpoint is a service root: no query string and no fragment.",
    );
  }

  return url;
}

function resolveBucket(raw: string): string {
  const bucket = raw.trim();

  if (bucket === "") {
    throw new StorageConfigurationError(
      "bucket",
      "missing",
      "Name the bucket to store objects in.",
    );
  }

  if (bucket.length > 255 || /[\s/?#]/.test(bucket)) {
    throw new StorageConfigurationError(
      "bucket",
      "invalid",
      "A bucket name has no whitespace, no slash and no query characters.",
    );
  }

  return bucket;
}

function resolveRegion(raw: string | undefined): string {
  const region = (raw ?? "us-east-1").trim();

  if (region === "") {
    throw new StorageConfigurationError(
      "region",
      "missing",
      "Name the region the endpoint expects.",
    );
  }

  return region;
}

function resolveTimeout(raw: number | undefined): number {
  if (raw === undefined) {
    return defaultTimeoutMs;
  }

  if (!Number.isFinite(raw) || raw <= 0) {
    throw new StorageConfigurationError(
      "timeoutMs",
      "invalid",
      "Expected a positive number of milliseconds.",
    );
  }

  return raw;
}

function resolveCredentialName(setting: string, raw: string): string {
  const name = raw.trim();

  if (name === "") {
    throw new StorageConfigurationError(
      setting,
      "missing",
      `Name the credential store entry that holds the ${setting}.`,
    );
  }

  return name;
}

function unescapeXml(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (entity, body: string) => {
    if (body.startsWith("#x")) {
      return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    }

    if (body.startsWith("#")) {
      return String.fromCodePoint(Number.parseInt(body.slice(1), 10));
    }

    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default:
        return entity;
    }
  });
}

function tag(block: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block)?.[1];
}

function parseListResponse(xml: string): {
  readonly contents: readonly ListedObject[];
  readonly nextContinuationToken?: string;
} {
  const contents: ListedObject[] = [];

  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const block = match[1] ?? "";
    const rawKey = tag(block, "Key");
    const rawLastModified = tag(block, "LastModified");
    const size = Number(tag(block, "Size"));

    if (rawKey === undefined || rawLastModified === undefined || !Number.isFinite(size)) {
      throw new StorageProtocolError("a listed object was missing its key, time or size");
    }

    contents.push({ key: unescapeXml(rawKey), size, lastModified: rawLastModified });
  }

  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(xml);
  const rawToken = tag(xml, "NextContinuationToken");

  if (truncated && rawToken === undefined) {
    throw new StorageProtocolError("the provider truncated the list without a continuation token");
  }

  return {
    contents,
    ...(truncated && rawToken !== undefined
      ? { nextContinuationToken: unescapeXml(rawToken) }
      : {}),
  };
}

async function* countBytes(
  body: AsyncIterable<Uint8Array>,
  counted: (bytes: number) => void,
  failed: (cause: unknown) => void,
): AsyncGenerator<Uint8Array> {
  try {
    for await (const chunk of body) {
      counted(chunk.byteLength);
      yield chunk;
    }
  } catch (cause) {
    failed(cause);
    throw cause;
  }
}

/** The platform fetch needs `duplex: "half"` for a body that is not buffered. */
function isStreamedBody(body: SafeFetchBody): boolean {
  return typeof body !== "string" && !(body instanceof Uint8Array);
}

function isoOr(value: string | null, fallback: string): string {
  if (value === null) {
    return fallback;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

export class S3CompatibleStorageProvider implements StorageProvider {
  readonly #endpoint: URL;
  readonly #bucket: string;
  readonly #region: string;
  readonly #credentials: CredentialStore;
  readonly #accessKeyIdName: string;
  readonly #secretAccessKeyName: string;
  readonly #sessionTokenName: string | undefined;
  readonly #transport: SafeFetch;
  readonly #timeoutMs: number;
  readonly #now: () => Date;

  constructor(options: S3CompatibleStorageProviderOptions) {
    this.#endpoint = resolveEndpoint(options.endpoint);
    this.#bucket = resolveBucket(options.bucket);
    this.#region = resolveRegion(options.region);
    this.#credentials = options.credentials;
    this.#accessKeyIdName = resolveCredentialName("accessKeyId", options.accessKeyIdCredentialName);
    this.#secretAccessKeyName = resolveCredentialName(
      "secretAccessKey",
      options.secretAccessKeyCredentialName,
    );
    this.#sessionTokenName =
      options.sessionTokenCredentialName === undefined
        ? undefined
        : resolveCredentialName("sessionToken", options.sessionTokenCredentialName);
    this.#transport = options.fetch ?? safeFetch;
    this.#timeoutMs = resolveTimeout(options.timeoutMs);
    this.#now = options.now ?? (() => new Date());
  }

  async put(request: StoragePutRequest): Promise<StorageObject> {
    assertStorageKey(request.key);
    let size = 0;
    let bodyFailure: unknown;
    let response: Response;

    try {
      response = await this.#send({
        method: "PUT",
        key: request.key,
        ...(request.contentType === undefined
          ? {}
          : { headers: { "content-type": request.contentType } }),
        body: countBytes(
          request.body,
          (bytes) => {
            size += bytes;
          },
          (cause) => {
            bodyFailure = cause;
          },
        ),
        payloadHash: unsignedPayload,
      });
    } catch (cause) {
      // A source that threw is the caller's failure, not the provider's: it is
      // rethrown unwrapped, exactly as the local provider does, so lifecycle
      // code cannot mistake a bad source for a retryable transfer.
      if (bodyFailure !== undefined) {
        throw bodyFailure;
      }

      throw cause;
    }

    await this.#requireOk(response, "the write");

    return {
      key: request.key,
      size,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
      lastModified: isoOr(response.headers.get("last-modified"), this.#now().toISOString()),
    };
  }

  async get(key: string): Promise<StorageBody | undefined> {
    assertStorageKey(key);
    const response = await this.#send({ method: "GET", key, payloadHash: emptyPayloadHash });

    if (response.status === 404) {
      const code = await this.#readErrorCode(response);

      if (code === "NoSuchBucket") {
        throw new StorageProviderError("gone", "the bucket is gone at the provider", 404);
      }

      return undefined;
    }

    await this.#requireOk(response, "the read");

    if (response.body === null) {
      throw new StorageProtocolError("the read answered without a body");
    }

    const rawLength = response.headers.get("content-length");
    const contentLength = rawLength === null ? Number.NaN : Number(rawLength);

    if (!Number.isFinite(contentLength) || contentLength < 0) {
      throw new StorageProtocolError("the read answered without a content length");
    }

    const contentType = response.headers.get("content-type");

    return {
      object: {
        key,
        size: contentLength,
        ...(contentType === null ? {} : { contentType }),
        lastModified: isoOr(response.headers.get("last-modified"), this.#now().toISOString()),
      },
      body: response.body,
    };
  }

  async delete(key: string): Promise<boolean> {
    assertStorageKey(key);
    const response = await this.#send({ method: "DELETE", key, payloadHash: emptyPayloadHash });

    if (response.status === 404) {
      const code = await this.#readErrorCode(response);

      if (code === "NoSuchBucket") {
        throw new StorageProviderError("gone", "the bucket is gone at the provider", 404);
      }

      // An S3-compatible delete is idempotent: a missing object is normally a
      // 2xx, and a 404 here still means the key is gone.
      return true;
    }

    await this.#requireOk(response, "the delete");

    return true;
  }

  async list(prefix: string): Promise<readonly StorageObject[]> {
    const objects: StorageObject[] = [];
    const seenTokens = new Set<string>();
    let token: string | undefined;
    let pages = 0;

    do {
      const query: Record<string, string> = { "list-type": "2", prefix };

      if (token !== undefined) {
        query["continuation-token"] = token;
      }

      const response = await this.#send({
        method: "GET",
        query,
        payloadHash: emptyPayloadHash,
      });
      await this.#requireOk(response, "the list");
      const parsed = parseListResponse(await response.text());

      for (const entry of parsed.contents) {
        objects.push({ key: entry.key, size: entry.size, lastModified: entry.lastModified });
      }

      token = parsed.nextContinuationToken;
      pages += 1;

      if (token !== undefined) {
        if (seenTokens.has(token)) {
          throw new StorageProtocolError("the provider repeated a continuation token");
        }

        seenTokens.add(token);
      }

      if (pages > maximumListPages) {
        throw new StorageProtocolError("the provider kept paginating past the page budget");
      }
    } while (token !== undefined);

    return objects.sort((left, right) =>
      Buffer.compare(Buffer.from(left.key, "utf8"), Buffer.from(right.key, "utf8")),
    );
  }

  async #send(spec: SendSpec): Promise<Response> {
    const accessKeyId = await this.#resolveCredential(this.#accessKeyIdName);
    const secretAccessKey = await this.#resolveCredential(this.#secretAccessKeyName);
    const sessionToken =
      this.#sessionTokenName === undefined
        ? undefined
        : await this.#resolveCredential(this.#sessionTokenName);

    const url = new URL(this.#endpoint);
    url.pathname =
      spec.key === undefined
        ? `/${uriEncode(this.#bucket)}`
        : `/${uriEncode(this.#bucket)}/${spec.key.split("/").map(uriEncode).join("/")}`;
    url.search = canonicalQueryString(spec.query ?? {});

    const headers = signS3Request({
      method: spec.method,
      url,
      ...(spec.headers === undefined ? {} : { headers: spec.headers }),
      payloadHash: spec.payloadHash,
      region: this.#region,
      accessKeyId,
      secretAccessKey,
      ...(sessionToken === undefined ? {} : { sessionToken }),
      now: this.#now(),
    });

    try {
      return await this.#transport(url, {
        method: spec.method,
        headers,
        ...(spec.body === undefined
          ? {}
          : { body: spec.body, ...(isStreamedBody(spec.body) ? { duplex: "half" as const } : {}) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      if (cause instanceof BlockedUrlError) {
        // A refused URL is a permanent configuration fact, not a transfer to
        // retry: the URL-safety module decided before any request.
        throw new StorageConfigurationError(
          "endpoint",
          "invalid",
          "Expected an https endpoint whose host resolves to a public address.",
        );
      }

      throw new StorageProviderError("timed_out", "the transfer did not complete", undefined, {
        cause,
      });
    }
  }

  async #resolveCredential(name: string): Promise<string> {
    const value = await this.#credentials.resolve(name);

    if (value === undefined || value.trim() === "") {
      throw new CredentialMissingError(name);
    }

    return value;
  }

  async #requireOk(response: Response, context: string): Promise<void> {
    if (response.ok) {
      return;
    }

    const code = await this.#readErrorCode(response);

    if (response.status === 401 || response.status === 403) {
      throw new StorageProviderError(
        "auth_failed",
        `${context} was refused (HTTP ${response.status}); replace the credential in the store`,
        response.status,
      );
    }

    if (response.status === 404 && code === "NoSuchBucket") {
      throw new StorageProviderError("gone", "the bucket is gone at the provider", 404);
    }

    if (response.status === 429 || response.status >= 500) {
      throw new StorageProviderError(
        "rate_limited",
        `${context} was refused transiently (HTTP ${response.status})`,
        response.status,
      );
    }

    throw new StorageProtocolError(
      `${context} answered HTTP ${response.status}${code === undefined ? "" : ` (${code})`}`,
      response.status,
    );
  }

  async #readErrorCode(response: Response): Promise<string | undefined> {
    try {
      const text = (await response.text()).slice(0, 4096);
      const code = tag(text, "Code");

      return code === undefined ? undefined : unescapeXml(code);
    } catch {
      return undefined;
    }
  }
}
