import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * The offline S3-compatible emulator (slice 7.7): the wire endpoint the
 * S3-compatible storage provider is tested against.
 *
 * It is a real HTTP server on loopback that stores objects in memory and speaks
 * the subset of the S3 REST API the provider uses — path-style PUT/GET/DELETE
 * of one object, and ListObjectsV2 with continuation tokens. When the emulator
 * is given credentials it verifies the SigV4 signature the way S3 does
 * (canonical request, signing key, constant-time compare), so the provider's
 * signing is exercised over the wire and not just asserted against fixtures; no
 * request leaves the process and the configured keys are test placeholders.
 *
 * Tests can also script the failures the vocabulary needs: `failNext` answers
 * one request with a chosen status and S3 error code, and `delayNext` holds one
 * response open so the provider's deadline can be observed.
 *
 * Non-goals, deliberately: it serves one bucket with path-style addressing, it
 * does not compare the payload hash to the body (uploads are signed
 * `UNSIGNED-PAYLOAD`), it does not enforce clock skew, and it does not
 * implement multipart, ACLs or presigned URLs. It is the wire the provider
 * needs in tests, not a second S3.
 *
 * Determinism: object keys and bodies are what a test put there, page sizes are
 * chosen by the test, and the clock can be injected, so the same scenario
 * produces the same XML.
 */

export interface S3StorageEmulatorOptions {
  /** The one bucket this emulator serves; defaults to `porkbot`. */
  readonly bucket?: string;
  /** The region every signature must be scoped to; defaults to `us-east-1`. */
  readonly region?: string;
  /** When both are set, requests must carry a valid SigV4 signature. */
  readonly accessKeyId?: string;
  readonly secretAccessKey?: string;
  /** When set, requests must carry this `x-amz-security-token`. */
  readonly sessionToken?: string;
  /** Keys per ListObjectsV2 page; defaults to 20. */
  readonly pageSize?: number;
  readonly now?: () => Date;
}

export interface RecordedS3Request {
  readonly method: string;
  /** The raw request target, path and query. */
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentSha256: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

export interface StoredS3Object {
  readonly body: Buffer;
  readonly contentType?: string;
  readonly lastModified: Date;
}

interface ScriptedFailure {
  readonly status: number;
  readonly code: string;
}

const maximumObjectBytes = 32 * 1024 * 1024;

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function xml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(body);
}

function errorXml(response: ServerResponse, status: number, code: string, message: string): void {
  xml(
    response,
    status,
    `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${xmlEscape(code)}</Code>` +
      `<Message>${xmlEscape(message)}</Message></Error>`,
  );
}

function headerValue(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];

  if (Array.isArray(value)) {
    return value.join(", ");
  }

  return value;
}

interface ParsedAuthorization {
  readonly accessKeyId: string;
  readonly date: string;
  readonly region: string;
  readonly service: string;
  readonly signedHeaders: readonly string[];
  readonly signature: string;
}

function parseAuthorization(value: string): ParsedAuthorization | undefined {
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(
      value,
    );

  if (match === null) {
    return undefined;
  }

  const [, credential = "", signedHeaders = "", signature = ""] = match;
  const [accessKeyId, date, region, service, terminator] = credential.split("/");

  if (
    accessKeyId === undefined ||
    date === undefined ||
    region === undefined ||
    service !== "s3" ||
    terminator !== "aws4_request"
  ) {
    return undefined;
  }

  return {
    accessKeyId,
    date,
    region,
    service,
    signedHeaders: signedHeaders.split(";"),
    signature,
  };
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac("sha256", key).update(value, "utf8").digest();
}

function expectedSignature(
  request: IncomingMessage,
  parsed: ParsedAuthorization,
  secretAccessKey: string,
  payloadHash: string,
): string | undefined {
  const rawUrl = request.url ?? "/";
  const question = rawUrl.indexOf("?");
  const rawPath = question < 0 ? rawUrl : rawUrl.slice(0, question);
  const rawQuery = question < 0 ? "" : rawUrl.slice(question + 1);

  const query = new URLSearchParams(rawQuery);
  const names = [...new Set([...query.keys()])].sort();
  const canonicalQuery = names
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(query.get(name) ?? "")}`)
    .join("&");

  const canonicalHeaders: string[] = [];

  for (const name of parsed.signedHeaders) {
    const value = headerValue(request, name);

    if (value === undefined) {
      return undefined;
    }

    canonicalHeaders.push(`${name}:${value.trim().replace(/\s+/g, " ")}\n`);
  }

  const canonicalRequest = [
    (request.method ?? "GET").toUpperCase(),
    rawPath === "" ? "/" : rawPath,
    canonicalQuery,
    canonicalHeaders.join(""),
    parsed.signedHeaders.join(";"),
    payloadHash,
  ].join("\n");

  const scope = `${parsed.date}/${parsed.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    headerValue(request, "x-amz-date") ?? "",
    scope,
    createHash("sha256").update(canonicalRequest, "utf8").digest("hex"),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, parsed.date), parsed.region), "s3"),
    "aws4_request",
  );

  return hmac(signingKey, stringToSign).toString("hex");
}

function signaturesMatch(expected: string, received: string): boolean {
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(received, "utf8");

  return left.length === right.length && timingSafeEqual(left, right);
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.length;

      if (size > maximumObjectBytes) {
        reject(new Error("the emulator object limit was exceeded"));
        request.destroy();
        return;
      }

      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export class S3StorageEmulator {
  readonly #server: Server;
  readonly #options: Required<Pick<S3StorageEmulatorOptions, "bucket" | "region" | "pageSize">> & {
    readonly accessKeyId: string | undefined;
    readonly secretAccessKey: string | undefined;
    readonly sessionToken: string | undefined;
  };
  readonly #now: () => Date;
  readonly #objects = new Map<string, StoredS3Object>();
  readonly #requests: RecordedS3Request[] = [];
  readonly #failures: ScriptedFailure[] = [];
  readonly #delays: number[] = [];
  #port = 0;

  private constructor(server: Server, options: S3StorageEmulatorOptions, now: () => Date) {
    this.#server = server;
    this.#options = {
      bucket: options.bucket ?? "porkbot",
      region: options.region ?? "us-east-1",
      pageSize: options.pageSize ?? 20,
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      sessionToken: options.sessionToken,
    };
    this.#now = now;

    if (
      (this.#options.accessKeyId === undefined) !==
      (this.#options.secretAccessKey === undefined)
    ) {
      throw new Error("the S3 emulator needs both an access key id and a secret access key");
    }
  }

  static async start(options: S3StorageEmulatorOptions = {}): Promise<S3StorageEmulator> {
    const server = createServer((request, response) => {
      void emulator.handle(request, response).catch(() => {
        if (!response.headersSent) {
          errorXml(response, 500, "InternalError", "the emulator failed");
          return;
        }

        response.destroy();
      });
    });
    const emulator = new S3StorageEmulator(server, options, options.now ?? (() => new Date()));

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      await emulator.stop();
      throw new Error("the S3 emulator did not bind a loopback port");
    }

    emulator.#port = address.port;
    return emulator;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get bucket(): string {
    return this.#options.bucket;
  }

  get region(): string {
    return this.#options.region;
  }

  get requests(): readonly RecordedS3Request[] {
    return this.#requests;
  }

  /** Answer the next request, whatever it is, with a scripted S3 error. */
  failNext(status: number, code: string): void {
    this.#failures.push({ status, code });
  }

  /** Hold the next request's response for this long, to exercise a deadline. */
  delayNext(milliseconds: number): void {
    this.#delays.push(milliseconds);
  }

  objectKeys(): readonly string[] {
    return [...this.#objects.keys()].sort((left, right) =>
      Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
    );
  }

  object(key: string): StoredS3Object | undefined {
    return this.#objects.get(key);
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
      this.#server.closeAllConnections();
    });
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);

    this.#requests.push({
      method: request.method ?? "GET",
      path: request.url ?? "/",
      authorization: headerValue(request, "authorization"),
      contentSha256: headerValue(request, "x-amz-content-sha256"),
      contentType: headerValue(request, "content-type"),
      body,
    });

    const delay = this.#delays.shift();

    if (delay !== undefined) {
      await sleep(delay);
    }

    if (!this.#authorized(request, response)) {
      return;
    }

    const failure = this.#failures.shift();

    if (failure !== undefined) {
      errorXml(
        response,
        failure.status,
        failure.code,
        `The emulator was scripted to answer ${failure.code}.`,
      );
      return;
    }

    const rawUrl = request.url ?? "/";
    const question = rawUrl.indexOf("?");
    const pathname = question < 0 ? rawUrl : rawUrl.slice(0, question);
    const query = new URLSearchParams(question < 0 ? "" : rawUrl.slice(question + 1));
    const segments = pathname.split("/").filter((segment) => segment !== "");
    const bucket = segments.shift();

    if (bucket !== this.#options.bucket) {
      errorXml(response, 404, "NoSuchBucket", "The bucket does not exist in this emulator.");
      return;
    }

    const encodedKey = segments.join("/");
    const key = encodedKey
      .split("/")
      .map((segment) => decodeURIComponent(segment))
      .join("/");

    if (query.get("list-type") === "2") {
      this.#list(response, query);
      return;
    }

    if (key === "") {
      errorXml(response, 400, "InvalidRequest", "Name an object key.");
      return;
    }

    if (request.method === "PUT") {
      this.#put(response, request, key, body);
      return;
    }

    if (request.method === "GET") {
      this.#get(response, key);
      return;
    }

    if (request.method === "DELETE") {
      this.#objects.delete(key);
      response.writeHead(204);
      response.end();
      return;
    }

    errorXml(
      response,
      405,
      "MethodNotAllowed",
      "The emulator serves PUT, GET, DELETE and ListObjectsV2.",
    );
  }

  #authorized(request: IncomingMessage, response: ServerResponse): boolean {
    const { accessKeyId, secretAccessKey, sessionToken, region } = this.#options;

    if (accessKeyId === undefined || secretAccessKey === undefined) {
      return true;
    }

    const authorization = headerValue(request, "authorization");

    if (authorization === undefined) {
      errorXml(response, 403, "AccessDenied", "The request is not signed.");
      return false;
    }

    const parsed = parseAuthorization(authorization);

    if (parsed === undefined) {
      errorXml(response, 403, "SignatureDoesNotMatch", "The authorization header is malformed.");
      return false;
    }

    if (!parsed.signedHeaders.includes("host")) {
      errorXml(response, 403, "SignatureDoesNotMatch", "The host header must be signed.");
      return false;
    }

    const payloadHash = headerValue(request, "x-amz-content-sha256");
    const amzDate = headerValue(request, "x-amz-date");

    if (
      payloadHash === undefined ||
      amzDate === undefined ||
      parsed.accessKeyId !== accessKeyId ||
      parsed.region !== region ||
      amzDate.slice(0, 8) !== parsed.date ||
      !amzDate.endsWith("Z")
    ) {
      errorXml(response, 403, "SignatureDoesNotMatch", "The credential scope does not match.");
      return false;
    }

    if (
      sessionToken !== undefined &&
      headerValue(request, "x-amz-security-token") !== sessionToken
    ) {
      errorXml(response, 403, "SignatureDoesNotMatch", "The session token does not match.");
      return false;
    }

    const expected = expectedSignature(request, parsed, secretAccessKey, payloadHash);

    if (expected === undefined || !signaturesMatch(expected, parsed.signature)) {
      errorXml(response, 403, "SignatureDoesNotMatch", "The signature does not match.");
      return false;
    }

    return true;
  }

  #put(response: ServerResponse, request: IncomingMessage, key: string, body: Buffer): void {
    const contentType = headerValue(request, "content-type");
    const lastModified = this.#now();

    this.#objects.set(key, {
      body: Buffer.from(body),
      ...(contentType === undefined ? {} : { contentType }),
      lastModified,
    });

    const etag = createHash("md5").update(body).digest("hex");

    response.writeHead(200, {
      etag: `"${etag}"`,
      "last-modified": lastModified.toUTCString(),
    });
    response.end();
  }

  #get(response: ServerResponse, key: string): void {
    const object = this.#objects.get(key);

    if (object === undefined) {
      errorXml(response, 404, "NoSuchKey", "The object does not exist in this emulator.");
      return;
    }

    response.writeHead(200, {
      "content-length": object.body.length,
      "last-modified": object.lastModified.toUTCString(),
      ...(object.contentType === undefined ? {} : { "content-type": object.contentType }),
    });
    response.end(object.body);
  }

  #list(response: ServerResponse, query: URLSearchParams): void {
    const prefix = query.get("prefix") ?? "";
    const token = query.get("continuation-token");
    const keys = this.objectKeys().filter((key) => key.startsWith(prefix));
    let start = 0;

    if (token !== null) {
      const after = Buffer.from(token, "base64url").toString("utf8");
      const index = keys.findIndex((key) => key > after);
      start = index < 0 ? keys.length : index;
    }

    const page = keys.slice(start, start + this.#options.pageSize);
    const truncated = start + this.#options.pageSize < keys.length;
    const contents = page
      .map((key) => {
        const object = this.#objects.get(key);

        if (object === undefined) {
          return "";
        }

        return (
          "<Contents>" +
          `<Key>${xmlEscape(key)}</Key>` +
          `<LastModified>${object.lastModified.toISOString()}</LastModified>` +
          `<ETag>&quot;${createHash("md5").update(object.body).digest("hex")}&quot;</ETag>` +
          `<Size>${object.body.length}</Size>` +
          "<StorageClass>STANDARD</StorageClass>" +
          "</Contents>"
        );
      })
      .join("");

    const lastKey = truncated ? page[page.length - 1] : undefined;

    xml(
      response,
      200,
      '<?xml version="1.0" encoding="UTF-8"?>' +
        '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">' +
        `<Name>${xmlEscape(this.#options.bucket)}</Name>` +
        `<Prefix>${xmlEscape(prefix)}</Prefix>` +
        `<KeyCount>${page.length}</KeyCount>` +
        `<MaxKeys>${this.#options.pageSize}</MaxKeys>` +
        `<IsTruncated>${truncated ? "true" : "false"}</IsTruncated>` +
        (lastKey === undefined
          ? ""
          : `<NextContinuationToken>${Buffer.from(lastKey, "utf8").toString("base64url")}</NextContinuationToken>`) +
        contents +
        "</ListBucketResult>",
    );
  }
}
