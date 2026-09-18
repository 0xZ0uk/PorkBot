import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { CredentialMissingError } from "@porkbot/effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  MailConfigurationError,
  MailDeliveryError,
  createHttpMailProvider,
  createMemoryCredentialStore,
} from "./index.ts";

/**
 * The real provider is exercised against a wire emulator: an in-process HTTP
 * server that speaks the documented Resend-compatible contract. No key leaves
 * the process and no external network is touched, but the request the provider
 * actually makes — method, path, headers and JSON body — is what the assertions
 * read, so this is the wire protocol rather than a mock of it.
 */

interface RecordedRequest {
  readonly method: string | undefined;
  readonly path: string | undefined;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Record<string, unknown>;
}

interface WireProvider {
  readonly server: Server;
  readonly endpoint: string;
  readonly requests: RecordedRequest[];
}

const openServers: Server[] = [];

const resetEmail = {
  to: "operator@example.invalid",
  subject: "Reset your PorkBot password",
  text: "Open https://bots.example.invalid/reset?token=abc",
} as const;

const from = "PorkBot <bots@example.invalid>";
const credentialName = "transactional-mail-api-key";
const credentialValue = "test-mail-key-not-real-0001";

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
    server.closeAllConnections();
  });
}

async function stop(wire: WireProvider): Promise<void> {
  const index = openServers.indexOf(wire.server);

  if (index >= 0) {
    openServers.splice(index, 1);
  }

  await close(wire.server);
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(close));
});

async function startWireProvider(
  respond: (response: ServerResponse) => void,
): Promise<WireProvider> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");

      requests.push({
        method: request.method,
        path: request.url,
        authorization: request.headers.authorization,
        contentType: request.headers["content-type"],
        body: raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>),
      });

      respond(response);
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  openServers.push(server);

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("the wire provider did not bind a TCP port");
  }

  return { server, endpoint: `http://127.0.0.1:${address.port}/emails`, requests };
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the promise to reject");
}

function build(options: {
  readonly endpoint: string;
  readonly from?: string;
  readonly credentialName?: string;
  readonly credential?: string;
  readonly timeoutMs?: number;
}): ReturnType<typeof createHttpMailProvider> {
  const credentials = createMemoryCredentialStore(
    options.credential === undefined ? [] : [[credentialName, options.credential]],
  );

  return createHttpMailProvider({
    endpoint: options.endpoint,
    from: options.from ?? from,
    credentialName: options.credentialName ?? credentialName,
    credentials,
    // The wire emulator speaks plain HTTP on loopback; the shipped default is
    // the URL-safety module, exercised in its own suite below.
    fetch: globalThis.fetch,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

describe("the HTTP mail provider wire contract", () => {
  it("posts the documented body and returns the provider's receipt", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { id: "provider-message-1" });
    });
    const mail = build({ endpoint: wire.endpoint, credential: credentialValue });

    const receipt = await mail.send({ ...resetEmail, html: "<p>Open the link</p>" });

    expect(receipt.id).toBe("provider-message-1");
    expect(wire.requests).toHaveLength(1);

    const request = wire.requests[0];

    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/emails");
    expect(request?.authorization).toBe(`Bearer ${credentialValue}`);
    expect(request?.contentType).toBe("application/json");
    expect(request?.body).toEqual({
      from,
      to: [resetEmail.to],
      subject: resetEmail.subject,
      text: resetEmail.text,
      html: "<p>Open the link</p>",
    });
  });

  it("omits the HTML part when the message has none", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { id: "provider-message-2" });
    });
    const mail = build({ endpoint: wire.endpoint, credential: credentialValue });

    await mail.send(resetEmail);

    expect(wire.requests[0]?.body).toEqual({
      from,
      to: [resetEmail.to],
      subject: resetEmail.subject,
      text: resetEmail.text,
    });
  });

  it("resolves the credential on every send, so a rotated key is used immediately", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { id: "provider-message-3" });
    });
    const store = createMemoryCredentialStore([[credentialName, "key-one"]]);
    const mail = createHttpMailProvider({
      endpoint: wire.endpoint,
      from,
      credentialName,
      credentials: store,
      fetch: globalThis.fetch,
    });

    await mail.send(resetEmail);
    store.set(credentialName, "key-two");
    await mail.send(resetEmail);

    expect(wire.requests.map((request) => request.authorization)).toEqual([
      "Bearer key-one",
      "Bearer key-two",
    ]);
  });
});

describe("the HTTP mail provider fails closed on misconfiguration", () => {
  it("rejects a missing, malformed or credential-bearing endpoint before any request", () => {
    const cases = [
      ["", "missing"],
      ["   ", "missing"],
      ["not a url", "invalid"],
      ["smtp://mail.example.invalid/emails", "invalid"],
      ["https://user:password@mail.example.invalid/emails", "invalid"],
    ] as const;

    for (const [endpoint, reason] of cases) {
      const error = configurationError(() => build({ endpoint }));

      expect(error).toBeInstanceOf(MailConfigurationError);
      expect(error).toMatchObject({ setting: "endpoint", reason });
    }
  });

  it("rejects a missing or unrecognisable sender before any request", () => {
    const missing = configurationError(() =>
      build({ endpoint: "https://mail.example.invalid/emails", from: " " }),
    );
    const invalid = configurationError(() =>
      build({ endpoint: "https://mail.example.invalid/emails", from: "not-an-address" }),
    );

    expect(missing).toMatchObject({ setting: "sender", reason: "missing" });
    expect(invalid).toMatchObject({ setting: "sender", reason: "invalid" });
  });

  it("rejects a missing credential name before any request", () => {
    const error = configurationError(() =>
      build({ endpoint: "https://mail.example.invalid/emails", credentialName: " " }),
    );

    expect(error).toMatchObject({ setting: "credential", reason: "missing" });
  });

  it("refuses an empty key without calling the provider", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { id: "provider-message-4" });
    });
    const mail = build({ endpoint: wire.endpoint, credential: "   " });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(CredentialMissingError);
    expect(error).toMatchObject({ credentialName });
    expect(wire.requests).toEqual([]);
  });

  it("refuses a key the store does not hold without calling the provider", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { id: "provider-message-5" });
    });
    const mail = build({ endpoint: wire.endpoint });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(CredentialMissingError);
    expect(wire.requests).toEqual([]);
  });

  it("reports a refused credential as a configuration error and never echoes the provider body", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 401, { message: `invalid API key: Bearer ${credentialValue}` });
    });
    const mail = build({ endpoint: wire.endpoint, credential: credentialValue });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(MailConfigurationError);
    expect(error).toMatchObject({ setting: "credential", reason: "rejected" });
    expect(String((error as Error).message)).not.toContain(credentialValue);
  });

  it("refuses an unusable timeout", () => {
    const error = configurationError(() =>
      build({ endpoint: "https://mail.example.invalid/emails", timeoutMs: 0 }),
    );

    expect(error).toMatchObject({ setting: "timeoutMs", reason: "invalid" });
  });
});

describe("the HTTP mail provider's shipped transport", () => {
  it("refuses a plain-http endpoint as a configuration error, without a request", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { id: "provider-message-6" });
    });
    const mail = createHttpMailProvider({
      endpoint: wire.endpoint,
      from,
      credentialName,
      credentials: createMemoryCredentialStore([[credentialName, credentialValue]]),
    });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(MailConfigurationError);
    expect(error).toMatchObject({ setting: "endpoint", reason: "invalid" });
    expect(wire.requests).toEqual([]);
  });

  it("refuses an https endpoint that resolves to a blocked address", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { id: "provider-message-7" });
    });
    const mail = createHttpMailProvider({
      endpoint: wire.endpoint.replace("http://", "https://"),
      from,
      credentialName,
      credentials: createMemoryCredentialStore([[credentialName, credentialValue]]),
    });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(MailConfigurationError);
    expect(error).toMatchObject({ setting: "endpoint", reason: "invalid" });
    expect(wire.requests).toEqual([]);
  });
});

describe("the HTTP mail provider classifies delivery failures", () => {
  it("marks 429 and 5xx as retryable and other rejections as permanent", async () => {
    const cases = [
      [429, true],
      [500, true],
      [503, true],
      [422, false],
      [400, false],
    ] as const;

    for (const [status, retryable] of cases) {
      const wire = await startWireProvider((response) => {
        jsonResponse(response, status, { message: "provider said no" });
      });
      const mail = build({ endpoint: wire.endpoint, credential: credentialValue });

      const error = await rejection(mail.send(resetEmail));

      expect(error).toBeInstanceOf(MailDeliveryError);
      expect(error).toMatchObject({ status, retryable });
    }
  });

  it("marks a transport failure as retryable with no status", async () => {
    const wire = await startWireProvider(() => {});
    const endpoint = wire.endpoint;

    await stop(wire);

    const mail = build({ endpoint, credential: credentialValue });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error).toMatchObject({ retryable: true, status: undefined });
    expect((error as Error).cause).toBeDefined();
  });

  it("marks a request that outlives its budget as a retryable transport failure", async () => {
    const wire = await startWireProvider(() => {});
    const mail = build({ endpoint: wire.endpoint, credential: credentialValue, timeoutMs: 25 });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error).toMatchObject({ retryable: true, status: undefined });
  });

  it("refuses a 2xx that carries no usable receipt id", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { delivered: true });
    });
    const mail = build({ endpoint: wire.endpoint, credential: credentialValue });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error).toMatchObject({ status: 200, retryable: false });
  });

  it("refuses a 2xx whose body is not JSON", async () => {
    const wire = await startWireProvider((response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("accepted");
    });
    const mail = build({ endpoint: wire.endpoint, credential: credentialValue });

    const error = await rejection(mail.send(resetEmail));

    expect(error).toBeInstanceOf(MailDeliveryError);
    expect(error).toMatchObject({ status: 200, retryable: false });
  });
});

/**
 * Runs a synchronous factory that is expected to throw and returns the thrown
 * error with its concrete type, so a test can assert the typed fields.
 */
function configurationError(run: () => unknown): MailConfigurationError {
  try {
    run();
  } catch (error) {
    if (error instanceof MailConfigurationError) {
      return error;
    }

    throw error;
  }

  throw new Error("expected a MailConfigurationError");
}
