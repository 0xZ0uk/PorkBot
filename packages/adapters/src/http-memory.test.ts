import { createServer } from "node:http";
import type { Server, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryConfigurationError,
  MemoryEmulator,
  MemoryProviderError,
  MemoryRecall,
  createHttpMemoryProvider,
  createMemoryCredentialStore,
} from "./index.ts";

/**
 * The real memory provider is exercised against a wire emulator: an in-process
 * HTTP server that speaks the documented contract. No key leaves the process
 * and no external network is touched, but the request the provider actually
 * makes — method, path, headers and JSON body — is what the assertions read,
 * so this is the wire protocol rather than a mock of it.
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

const credentialName = "memory-api-key";
const credentialValue = "test-memory-key-not-real-0001";

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

  return { server, endpoint: `http://127.0.0.1:${address.port}/v1`, requests };
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
}): ReturnType<typeof createHttpMemoryProvider> {
  const name = options.credentialName ?? credentialName;
  const credentials = createMemoryCredentialStore(
    options.credential === undefined ? [] : [[name, options.credential]],
  );

  return createHttpMemoryProvider({
    endpoint: options.endpoint,
    credentialName: name,
    credentials,
    // The wire emulator speaks plain HTTP on loopback; the shipped default is
    // the URL-safety module, exercised in its own suite.
    fetch: globalThis.fetch,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}

const entry = {
  botId: "bot-alpha",
  documentId: "doc-1",
  revision: 3,
  kind: "preference",
  title: "Preferred editor",
  content: "The operator prefers keyboard-driven editing.",
} as const;

describe("the HTTP memory provider wire contract", () => {
  it("posts index entries to /index with the bearer credential", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 204));
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });

    await memory.index([entry]);

    expect(wire.requests).toHaveLength(1);
    expect(wire.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/index",
      authorization: `Bearer ${credentialValue}`,
      contentType: "application/json",
      body: { entries: [entry] },
    });
  });

  it("posts the bot and document ids to /forget", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 204));
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });

    await memory.forget("bot-alpha", ["doc-1", "doc-2"]);

    expect(wire.requests[0]).toMatchObject({
      path: "/v1/forget",
      body: { botId: "bot-alpha", documentIds: ["doc-1", "doc-2"] },
    });
  });

  it("posts a search and returns the provider's matches", async () => {
    const match = {
      documentId: "doc-1",
      revision: 3,
      title: "Preferred editor",
      excerpt: "keyboard-driven",
      score: 4.5,
      mode: "semantic",
    };
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { matches: [match] });
    });
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });

    const matches = await memory.search({ botId: "bot-alpha", text: "editor", limit: 5 });

    expect(matches).toEqual([match]);
    expect(wire.requests[0]).toMatchObject({
      path: "/v1/search",
      body: { botId: "bot-alpha", text: "editor", limit: 5, mode: "auto" },
    });
  });

  it("forwards an explicit search mode", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { matches: [] });
    });
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });

    await memory.search({ botId: "bot-alpha", text: "editor", limit: 5, mode: "semantic" });

    expect(wire.requests[0]?.body).toMatchObject({ mode: "semantic" });
  });

  it("resolves the credential on every call, so a rotated key is used immediately", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 204));
    const credentials = createMemoryCredentialStore([[credentialName, "key-one"]]);
    const memory = createHttpMemoryProvider({
      endpoint: wire.endpoint,
      credentialName,
      credentials,
      fetch: globalThis.fetch,
    });

    await memory.forget("bot-alpha", ["doc-1"]);
    await credentials.set(credentialName, "key-two");
    await memory.forget("bot-alpha", ["doc-2"]);

    expect(wire.requests.map((request) => request.authorization)).toEqual([
      "Bearer key-one",
      "Bearer key-two",
    ]);
  });
});

describe("the HTTP memory provider's failures", () => {
  it("classifies a refused credential as auth_failed", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 401));
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });

    const error = await rejection(memory.search({ botId: "bot-alpha", text: "x", limit: 1 }));

    expect(error).toBeInstanceOf(MemoryProviderError);
    expect((error as MemoryProviderError).kind).toBe("auth_failed");
  });

  it("classifies a quota refusal as rate_limited", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 429));
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });

    const error = await rejection(memory.search({ botId: "bot-alpha", text: "x", limit: 1 }));

    expect((error as MemoryProviderError).kind).toBe("rate_limited");
  });

  it("classifies a server error as timed_out", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 503));
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });

    const error = await rejection(memory.index([entry]));

    expect((error as MemoryProviderError).kind).toBe("timed_out");
  });

  it("classifies an unreachable provider as timed_out", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 204));
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });
    await stop(wire);

    const error = await rejection(memory.search({ botId: "bot-alpha", text: "x", limit: 1 }));

    expect((error as MemoryProviderError).kind).toBe("timed_out");
  });

  it("classifies a URL the safety module refuses as timed_out, so recall can degrade", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 204));
    const credentials = createMemoryCredentialStore([[credentialName, credentialValue]]);
    // No fetch override: the shipped default is safeFetch, which refuses the
    // plain-HTTP loopback endpoint before any connection.
    const memory = createHttpMemoryProvider({
      endpoint: wire.endpoint,
      credentialName,
      credentials,
    });

    const error = await rejection(memory.search({ botId: "bot-alpha", text: "x", limit: 1 }));

    expect(error).toBeInstanceOf(MemoryProviderError);
    expect((error as MemoryProviderError).kind).toBe("timed_out");
    expect(wire.requests).toHaveLength(0);
  });

  it("degrades recall to lexical when the real provider refuses the query", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 429));
    const lexical = new MemoryEmulator();
    await lexical.index([entry]);
    const degradations: string[] = [];
    const recall = new MemoryRecall({
      lexical,
      semantic: build({ endpoint: wire.endpoint, credential: credentialValue }),
      onDegrade: (_error, operation) => degradations.push(operation),
    });

    const matches = await recall.search({ botId: "bot-alpha", text: "editor", limit: 5 });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ documentId: "doc-1", mode: "lexical" });
    expect(degradations).toEqual(["search"]);
  });

  it("fails closed with auth_failed when the credential store has no entry, before any request", async () => {
    const wire = await startWireProvider((response) => emptyResponse(response, 204));
    const memory = build({ endpoint: wire.endpoint });

    const error = await rejection(memory.index([entry]));

    expect((error as MemoryProviderError).kind).toBe("auth_failed");
    expect(wire.requests).toHaveLength(0);
  });

  it("classifies a malformed search response as a provider failure to degrade past", async () => {
    const wire = await startWireProvider((response) => {
      jsonResponse(response, 200, { matches: [{ documentId: "doc-1" }] });
    });
    const memory = build({ endpoint: wire.endpoint, credential: credentialValue });

    const error = await rejection(memory.search({ botId: "bot-alpha", text: "x", limit: 1 }));

    expect(error).toBeInstanceOf(MemoryProviderError);
    expect((error as MemoryProviderError).kind).toBe("timed_out");
  });

  it("refuses an endpoint that cannot be a base URL", () => {
    const credentials = createMemoryCredentialStore([[credentialName, credentialValue]]);
    const cases = [
      { endpoint: "  " },
      { endpoint: "not a url" },
      { endpoint: "ftp://memory.example.invalid" },
      { endpoint: "https://user:pass@memory.example.invalid" },
      { endpoint: "https://memory.example.invalid/v1?tenant=1" },
    ];

    for (const { endpoint } of cases) {
      expect(
        () => createHttpMemoryProvider({ endpoint, credentialName, credentials }),
        `${endpoint} was accepted`,
      ).toThrow(MemoryConfigurationError);
    }
  });
});
