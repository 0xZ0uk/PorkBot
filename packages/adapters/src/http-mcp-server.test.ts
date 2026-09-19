import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHttpMcpServerProvider } from "./http-mcp-server.ts";
import { mcpServerConformance } from "./mcp-conformance.ts";

/**
 * The HTTP MCP provider over a real wire: an in-process loopback server speaks
 * the streamable-HTTP JSON-RPC transport, the OAuth metadata document and the
 * token endpoint, so the provider's parsing, handshake, session header and
 * classification are exercised without a network or a key. The same conformance
 * suite the emulator passes runs here, over the wire protocol.
 */

const tools = [
  {
    name: "echo",
    description: "Echo the text back.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "explode",
    description: "Fail on purpose.",
    parameters: { type: "object" },
  },
  {
    name: "list_issues",
    description: "List the issues.",
    parameters: { type: "object" },
  },
] as const;

/** The wire form of the tool list: the protocol names the schema `inputSchema`. */
function wireTools(): readonly Record<string, unknown>[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }));
}

const accessToken = "wire-conformance-token";
const rejectedCode = "denied-code";

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly sessionId: string | undefined;
  readonly body: string;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id, result };
}

function dispatchJsonRpc(response: ServerResponse, body: string): void {
  let message: Record<string, unknown>;

  try {
    message = JSON.parse(body) as Record<string, unknown>;
  } catch {
    json(response, 400, { error: "not json" });
    return;
  }

  const id = message["id"];
  const method = message["method"];

  if (method === "notifications/initialized") {
    response.writeHead(202);
    response.end();
    return;
  }

  if (method === "initialize") {
    response.setHeader("mcp-session-id", "wire-session-1");
    json(
      response,
      200,
      rpcResult(id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "wire-server", version: "9.9" },
      }),
    );
    return;
  }

  if (method === "tools/list") {
    json(response, 200, rpcResult(id, { tools: wireTools() }));
    return;
  }

  if (method === "tools/call") {
    const params = (message["params"] ?? {}) as Record<string, unknown>;
    const name = params["name"];

    if (name === "echo") {
      const args = (params["arguments"] ?? {}) as Record<string, unknown>;
      json(
        response,
        200,
        rpcResult(id, { content: [{ type: "text", text: `echo: ${String(args["text"])}` }] }),
      );
      return;
    }

    if (name === "explode") {
      json(
        response,
        200,
        rpcResult(id, { content: [{ type: "text", text: "boom" }], isError: true }),
      );
      return;
    }

    json(response, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "unknown tool" } });
    return;
  }

  json(response, 200, { jsonrpc: "2.0", id, error: { code: -32601, message: "unknown method" } });
}

function dispatchToken(response: ServerResponse, body: string): void {
  const form = new URLSearchParams(body);

  if (form.get("code") === rejectedCode) {
    json(response, 400, { error: "invalid_grant" });
    return;
  }

  if (form.get("client_id") !== "porkbot") {
    json(response, 401, { error: "invalid_client" });
    return;
  }

  json(response, 200, {
    access_token: "wire-access-token",
    token_type: "Bearer",
    refresh_token: "wire-refresh-token",
    expires_in: 3_600,
  });
}

interface Wire {
  readonly server: Server;
  readonly requests: RecordedRequest[];
  readonly origin: string;
}

async function startWire(): Promise<Wire> {
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

    void readBody(request)
      .then((body) => {
        requests.push({
          method: request.method ?? "",
          path,
          authorization: request.headers["authorization"] as string | undefined,
          sessionId: request.headers["mcp-session-id"] as string | undefined,
          body,
        });

        if (path === "/.well-known/oauth-authorization-server") {
          const port = (server.address() as AddressInfo).port;
          json(response, 200, {
            // The authorization URL is only built, never dialed, so the harness
            // declares the https form a browser would be sent to; the token
            // endpoint is dialed through the injected loopback transport.
            authorization_endpoint: `https://127.0.0.1:${port}/authorize`,
            token_endpoint: `http://127.0.0.1:${port}/token`,
          });
          return;
        }

        if (path === "/token") {
          dispatchToken(response, body);
          return;
        }

        if (path === "/mcp/rate-limited") {
          json(response, 429, { error: "slow down" });
          return;
        }

        if (path === "/mcp/forbidden") {
          json(response, 403, { error: "no" });
          return;
        }

        if (path === "/mcp/redirect") {
          response.writeHead(302, { location: "/mcp" });
          response.end();
          return;
        }

        if (
          path === "/mcp/private" &&
          request.headers["authorization"] !== `Bearer ${accessToken}`
        ) {
          json(response, 401, { error: "token required" });
          return;
        }

        if (path === "/mcp/streamed") {
          const message = JSON.parse(body) as Record<string, unknown>;

          if (message["method"] === "notifications/initialized") {
            response.writeHead(202);
            response.end();
            return;
          }

          if (message["method"] === "initialize") {
            response.setHeader("mcp-session-id", "wire-session-1");
            json(
              response,
              200,
              rpcResult(message["id"], {
                protocolVersion: "2025-06-18",
                capabilities: { tools: {} },
                serverInfo: { name: "wire-server", version: "9.9" },
              }),
            );
            return;
          }

          const payload = {
            jsonrpc: "2.0",
            id: message["id"],
            result: { tools: wireTools() },
          };
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`);
          return;
        }

        if (path === "/mcp/garbage") {
          json(response, 200, { jsonrpc: "2.0", id: 1, result: "not an object" });
          return;
        }

        if (path !== "/mcp" && path !== "/mcp/private") {
          json(response, 404, { error: "not found" });
          return;
        }

        dispatchJsonRpc(response, body);
      })
      .catch(() => {
        response.writeHead(500);
        response.end();
      });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    server,
    requests,
    origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}

let wire: Wire;

beforeAll(async () => {
  wire = await startWire();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    wire.server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
});

function provider() {
  return createHttpMcpServerProvider({
    fetch: globalThis.fetch,
    // The loopback wire server's token endpoint is plain http; the shipped
    // default keeps both OAuth endpoints under the URL-safety policy.
    allowInsecureOAuthEndpoints: true,
  });
}

await mcpServerConformance("the HTTP provider", async () => ({
  provider: provider(),
  serverUrl: `${wire.origin}/mcp`,
  missingUrl: `${wire.origin}/missing`,
  rateLimitedUrl: `${wire.origin}/mcp/rate-limited`,
  forbiddenUrl: `${wire.origin}/mcp/forbidden`,
  authRequiredUrl: `${wire.origin}/mcp/private`,
  accessToken,
  expectedTools: tools,
  callTool: "echo",
  callArguments: { text: "hi" },
  callContent: "echo: hi",
  failingTool: "explode",
  clientId: "porkbot",
  redirectUri: "https://api.example.invalid/oauth/mcp/callback",
  state: "state-1",
  rejectedCode,
}));

describe("the HTTP MCP provider's own wire behavior", () => {
  it("echoes the session id and carries the bearer token", async () => {
    const http = provider();
    const before = wire.requests.length;

    await http.discover({ url: `${wire.origin}/mcp/private`, accessToken });

    const sent = wire.requests.slice(before);
    const initialize = sent.find((request) => request.body.includes('"method":"initialize"'));
    const list = sent.find((request) => request.body.includes('"method":"tools/list"'));

    expect(initialize?.authorization).toBe(`Bearer ${accessToken}`);
    expect(list?.sessionId).toBe("wire-session-1");
    expect(list?.authorization).toBe(`Bearer ${accessToken}`);
  });

  it("reads an SSE-framed response", async () => {
    const http = provider();

    const description = await http.discover({ url: `${wire.origin}/mcp/streamed` });

    expect(description.serverName).toBe("wire-server");
    expect(description.tools).toHaveLength(3);
  });

  it("classifies a mismatched JSON-RPC result as timed_out", async () => {
    const http = provider();

    await expect(http.discover({ url: `${wire.origin}/mcp/garbage` })).rejects.toMatchObject({
      kind: "timed_out",
    });
  });

  it("refuses a redirect instead of following it", async () => {
    const http = provider();

    await expect(http.discover({ url: `${wire.origin}/mcp/redirect` })).rejects.toMatchObject({
      kind: "auth_failed",
    });
  });

  it("sends the exchange as a form-encoded authorization_code grant", async () => {
    const http = provider();
    const before = wire.requests.length;

    const tokens = await http.exchangeCode({
      url: `${wire.origin}/mcp`,
      clientId: "porkbot",
      clientSecret: "client-secret",
      code: "code-1",
      redirectUri: "https://api.example.invalid/oauth/mcp/callback",
    });

    expect(tokens.accessToken).toBe("wire-access-token");
    expect(tokens.refreshToken).toBe("wire-refresh-token");
    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.expiresAt).toBeInstanceOf(Date);

    const exchange = wire.requests.slice(before).find((request) => request.path === "/token");
    const form = new URLSearchParams(exchange?.body ?? "");

    expect(form.get("grant_type")).toBe("authorization_code");
    expect(form.get("code")).toBe("code-1");
    expect(form.get("client_id")).toBe("porkbot");
    expect(form.get("client_secret")).toBe("client-secret");
    expect(form.get("redirect_uri")).toBe("https://api.example.invalid/oauth/mcp/callback");
  });

  it("refuses a token endpoint that refuses the exchange", async () => {
    const http = provider();

    await expect(
      http.exchangeCode({
        url: `${wire.origin}/mcp`,
        clientId: "porkbot",
        code: rejectedCode,
        redirectUri: "https://api.example.invalid/oauth/mcp/callback",
      }),
    ).rejects.toMatchObject({ kind: "auth_failed" });
  });

  it("refuses a scheme and an address the URL-safety rules block", async () => {
    const http = createHttpMcpServerProvider();

    await expect(http.discover({ url: "http://mcp.example.invalid/mcp" })).rejects.toMatchObject({
      kind: "auth_failed",
    });
    await expect(http.discover({ url: "https://127.0.0.1:9/mcp" })).rejects.toMatchObject({
      kind: "auth_failed",
    });
    // The call path dials the same URL through the same default transport, so
    // it is refused before a request is made too.
    await expect(
      http.call({ url: "https://127.0.0.1:9/mcp", tool: "echo", arguments: {} }),
    ).rejects.toMatchObject({ kind: "auth_failed" });
  });
});
