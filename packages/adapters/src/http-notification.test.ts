import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import type { OperatorNotification } from "@porkbot/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import {
  NotificationConfigurationError,
  NotificationProviderError,
  createHttpNotificationProvider,
  createMemoryCredentialStore,
} from "./index.ts";
import { notificationConformance } from "./notification-conformance.ts";

/**
 * The real notification provider is exercised against a wire emulator: an
 * in-process HTTP server that speaks the documented contract. No key leaves the
 * process and no external network is touched, but the request the provider
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

const credentialName = "notification-webhook-key";
const credentialValue = "test-webhook-key-not-real-0001";

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

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(close));
});

async function startWireProvider(
  respond: (response: ServerResponse, requestNumber: number) => void,
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

      respond(response, requests.length);
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

  return { server, endpoint: `http://127.0.0.1:${address.port}/notify`, requests };
}

function jsonResponse(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function emptyResponse(response: ServerResponse, status: number): void {
  response.writeHead(status);
  response.end();
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
  readonly credentialName?: string;
  readonly credential?: string;
  readonly timeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
}): ReturnType<typeof createHttpNotificationProvider> {
  const name = options.credentialName ?? credentialName;
  const credentials = createMemoryCredentialStore(
    options.credential === undefined ? [] : [[name, options.credential]],
  );

  return createHttpNotificationProvider({
    endpoint: options.endpoint,
    credentialName: name,
    credentials,
    // The wire emulator speaks plain HTTP on loopback; the shipped default is
    // the URL-safety module, exercised in its own suite.
    fetch: options.fetch ?? globalThis.fetch,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

const notification = {
  title: "Run failed",
  body: "The nightly report run failed while calling the summary tool.",
  url: "https://porkbot.example.invalid/runs/run-42",
} as const;

describe("the HTTP notification provider wire contract", () => {
  it("posts the notification to the endpoint with the bearer credential", async () => {
    const wire = await startWireProvider((response) => jsonResponse(response, 200, { id: "d-1" }));
    const notifications = build({ endpoint: wire.endpoint, credential: credentialValue });

    const receipt = await notifications.deliver(notification);

    expect(receipt).toEqual({ id: "d-1" });
    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]).toMatchObject({
      method: "POST",
      path: "/notify",
      authorization: `Bearer ${credentialValue}`,
      contentType: "application/json",
      body: {
        title: notification.title,
        body: notification.body,
        url: notification.url,
      },
    });
  });

  it("sends exactly the interface's three fields, dropping anything else", async () => {
    const wire = await startWireProvider((response) => jsonResponse(response, 200, { id: "d-1" }));
    const notifications = build({ endpoint: wire.endpoint, credential: credentialValue });

    await notifications.deliver({
      title: "Run failed",
      body: "The run failed.",
      arguments: { apiKey: credentialValue },
    } as OperatorNotification);

    expect(Object.keys(wire.requests[0]?.body ?? {}).sort()).toEqual(["body", "title"]);
  });

  it("omits the url key when the notification has none", async () => {
    const wire = await startWireProvider((response) => jsonResponse(response, 200, { id: "d-1" }));
    const notifications = build({ endpoint: wire.endpoint, credential: credentialValue });

    await notifications.deliver({ title: "Run finished", body: "All good." });

    expect(wire.requests[0]?.body).toEqual({ title: "Run finished", body: "All good." });
  });
});

describe("the HTTP notification provider's configuration", () => {
  it("refuses a missing endpoint at construction", () => {
    let error: unknown;

    try {
      createHttpNotificationProvider({
        endpoint: "  ",
        credentialName,
        credentials: createMemoryCredentialStore(),
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(NotificationConfigurationError);
    expect(error).toMatchObject({ setting: "endpoint", reason: "missing" });
  });

  it("refuses a relative or non-http endpoint at construction", () => {
    for (const endpoint of ["not-a-url", "ftp://alerts.example.invalid/notify"]) {
      let error: unknown;

      try {
        createHttpNotificationProvider({
          endpoint,
          credentialName,
          credentials: createMemoryCredentialStore(),
        });
      } catch (thrown) {
        error = thrown;
      }

      expect(error, endpoint).toBeInstanceOf(NotificationConfigurationError);
      expect(error).toMatchObject({ setting: "endpoint", reason: "invalid" });
    }
  });

  it("refuses an endpoint with embedded credentials", () => {
    let error: unknown;

    try {
      createHttpNotificationProvider({
        endpoint: "https://user:pass@alerts.example.invalid/notify",
        credentialName,
        credentials: createMemoryCredentialStore(),
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(NotificationConfigurationError);
    expect(error).toMatchObject({ setting: "endpoint", reason: "invalid" });
  });

  it("refuses a blank credential name and a non-positive timeout", () => {
    const refuses = (options: { readonly credentialName: string; readonly timeoutMs?: number }) => {
      try {
        createHttpNotificationProvider({
          endpoint: "https://alerts.example.invalid/notify",
          credentialName: options.credentialName,
          credentials: createMemoryCredentialStore(),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch (error) {
        return error;
      }

      throw new Error("expected construction to refuse");
    };

    expect(refuses({ credentialName: "  " })).toMatchObject({
      setting: "credential",
      reason: "missing",
    });
    expect(refuses({ credentialName, timeoutMs: 0 })).toMatchObject({
      setting: "timeoutMs",
      reason: "invalid",
    });
  });
});

describe("the HTTP notification provider's failure classification", () => {
  it("classifies a missing credential as auth_failed without a request", async () => {
    const wire = await startWireProvider((response) => jsonResponse(response, 200, { id: "d-1" }));
    const notifications = build({ endpoint: wire.endpoint });

    const error = await rejection(notifications.deliver(notification));

    expect(error).toBeInstanceOf(NotificationProviderError);
    expect(error).toMatchObject({ kind: "auth_failed" });
    expect(wire.requests).toEqual([]);
  });

  it("classifies 401 and 403 as auth_failed", async () => {
    for (const status of [401, 403]) {
      const wire = await startWireProvider((response) => emptyResponse(response, status));
      const notifications = build({ endpoint: wire.endpoint, credential: credentialValue });

      expect(await rejection(notifications.deliver(notification))).toMatchObject({
        kind: "auth_failed",
        status,
      });
    }
  });

  it("classifies 404 as not_found", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 404));
    const notifications = build({ endpoint: wire.endpoint, credential: credentialValue });

    expect(await rejection(notifications.deliver(notification))).toMatchObject({
      kind: "not_found",
      status: 404,
    });
  });

  it("classifies 429 as rate_limited", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 429));
    const notifications = build({ endpoint: wire.endpoint, credential: credentialValue });

    expect(await rejection(notifications.deliver(notification))).toMatchObject({
      kind: "rate_limited",
      status: 429,
    });
  });

  it("classifies a 5xx and a refused transport as timed_out", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 503));
    const serverDown = build({ endpoint: wire.endpoint, credential: credentialValue });
    const transportDown = build({
      endpoint: wire.endpoint,
      credential: credentialValue,
      fetch: () => Promise.reject(new Error("the network is down")),
    });

    expect(await rejection(serverDown.deliver(notification))).toMatchObject({
      kind: "timed_out",
      status: 503,
    });
    expect(await rejection(transportDown.deliver(notification))).toMatchObject({
      kind: "timed_out",
    });
  });

  it("classifies a 2xx response without a receipt as timed_out", async () => {
    const wire = await startWireProvider((response) => jsonResponse(response, 200, { ok: true }));
    const notifications = build({ endpoint: wire.endpoint, credential: credentialValue });

    expect(await rejection(notifications.deliver(notification))).toMatchObject({
      kind: "timed_out",
    });
  });
});

describe("the HTTP notification provider's shipped transport", () => {
  it("refuses a plain-http endpoint at construction, before any request", async () => {
    const wire = await startWireProvider((response) => jsonResponse(response, 200, { id: "d-1" }));
    let error: unknown;

    try {
      createHttpNotificationProvider({
        endpoint: wire.endpoint,
        credentialName,
        credentials: createMemoryCredentialStore([[credentialName, credentialValue]]),
      });
    } catch (thrown) {
      error = thrown;
    }

    expect(error).toBeInstanceOf(NotificationConfigurationError);
    expect(error).toMatchObject({ setting: "endpoint", reason: "invalid" });
    expect(wire.requests).toEqual([]);
  });

  it("surfaces an https endpoint that resolves to a blocked address as not_found", async () => {
    const wire = await startWireProvider((response) => jsonResponse(response, 200, { id: "d-1" }));
    const notifications = createHttpNotificationProvider({
      endpoint: wire.endpoint.replace("http://", "https://"),
      credentialName,
      credentials: createMemoryCredentialStore([[credentialName, credentialValue]]),
    });

    const error = await rejection(notifications.deliver(notification));

    expect(error).toBeInstanceOf(NotificationProviderError);
    expect(error).toMatchObject({ kind: "not_found" });
    expect(wire.requests).toEqual([]);
  });
});

notificationConformance("the HTTP provider", async () => {
  const wire = await startWireProvider((response, requestNumber) =>
    jsonResponse(response, 200, { id: `wire-${requestNumber}` }),
  );
  const provider = createHttpNotificationProvider({
    endpoint: wire.endpoint,
    credentialName,
    credentials: createMemoryCredentialStore([[credentialName, credentialValue]]),
    fetch: globalThis.fetch,
  });

  return {
    provider,
    delivered: () => wire.requests.map((request) => request.body),
  };
});
