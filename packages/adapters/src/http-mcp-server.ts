import type {
  McpAuthorizationRequest,
  McpCallRequest,
  McpCallResult,
  McpCodeExchangeRequest,
  McpDiscoverRequest,
  McpOAuthTokens,
  McpServerDescription,
  McpServerProvider,
  McpToolDescriptor,
} from "@porkbot/adapter-kit";
import { assertAllowedUrl, BlockedUrlError, safeFetch } from "@porkbot/effect";
import type { SafeFetch } from "@porkbot/effect";
import { jsonRpcFailure, McpProviderError, mcpStatusFailure } from "./mcp-errors.ts";

/**
 * The one real MCP server provider: the streamable-HTTP JSON-RPC transport
 * (2025-06-18), so any server that speaks the protocol is installable by URL.
 *
 *   POST <the server's url>
 *   { "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": { … } }
 *   { "jsonrpc": "2.0", "id": 1, "result": { "serverInfo": { … }, … } }
 *
 *   POST <the server's url>            the notification completes the handshake
 *   { "jsonrpc": "2.0", "method": "notifications/initialized" }
 *
 *   POST <the server's url>
 *   { "jsonrpc": "2.0", "id": 2, "method": "tools/list" }
 *   { "jsonrpc": "2.0", "id": 2, "result": { "tools": [ … ] } }
 *
 *   POST <the server's url>
 *   { "jsonrpc": "2.0", "id": 3, "method": "tools/call",
 *     "params": { "name": "…", "arguments": { … } } }
 *   { "jsonrpc": "2.0", "id": 3, "result": { "content": [ … ], "isError": false } }
 *
 * A response may arrive as `application/json` or as an SSE frame
 * (`text/event-stream`, first `data:` line); both are read under the body
 * budget. A session id the initialize response returns is echoed on every
 * later request.
 *
 * OAuth follows the same metadata document the MCP specification names:
 * `GET <origin>/.well-known/oauth-authorization-server` answers
 * `{ "authorization_endpoint", "token_endpoint" }`, the browser gets the
 * authorization URL, and the code is exchanged as a form-encoded
 * `authorization_code` grant. The client secret is passed per request, resolved
 * by the caller; this provider never reads an environment or a store.
 *
 * The transport is injected and defaults to `safeFetch` (PRD decision 23), so
 * a shipped deployment dials only HTTPS, refuses embedded credentials and
 * checks the address on the connection rather than on the string; the offline
 * wire test injects a plain fetch to reach its loopback server. Address safety
 * is not repeated here: a destination the URL-safety rules refuse is classified
 * `auth_failed`, and no response body is ever quoted in an error.
 */

const protocolVersion = "2025-06-18";
const wellKnownPath = "/.well-known/oauth-authorization-server";
const defaultTimeoutMs = 10_000;
const defaultMaxBytes = 1_000_000;

export interface HttpMcpServerOptions {
  /**
   * Transport seam for the offline wire test, which speaks plain HTTP on
   * loopback; defaults to the URL-safety module's `safeFetch`.
   */
  readonly fetch?: SafeFetch;
  /** Per-request budget; defaults to ten seconds. */
  readonly timeoutMs?: number;
  /** Response body budget; defaults to 1 MiB. */
  readonly maxBytes?: number;
  /**
   * Whether the OAuth metadata's endpoints may skip the URL-safety policy.
   * Only the offline wire test sets this, because its loopback token endpoint
   * is plain http; a shipped configuration leaves it unset and both endpoints
   * must pass `assertAllowedUrl` before the browser or the exchange uses them.
   */
  readonly allowInsecureOAuthEndpoints?: boolean;
}

function resolvePositive(raw: number | undefined, fallback: number, setting: string): number {
  if (raw === undefined) {
    return fallback;
  }

  if (!Number.isFinite(raw) || raw <= 0) {
    throw new RangeError(`${setting} must be a positive number, received ${raw}`);
  }

  return raw;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readBounded(response: Response, budget: number): Promise<string> {
  const stream = response.body;

  if (stream === null) {
    return "";
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      const remaining = budget - total;

      if (remaining <= 0 || value.byteLength > remaining) {
        throw new McpProviderError("timed_out", "the response exceeded the provider's budget");
      }

      text += decoder.decode(value, { stream: true });
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return text + decoder.decode();
}

/** The JSON a response carries, whether it was sent whole or as an SSE frame. */
function payloadFromBody(body: string, contentType: string): unknown {
  const trimmed = body.trim();

  if (trimmed === "") {
    return undefined;
  }

  const text = contentType.includes("text/event-stream") ? firstEventData(trimmed) : trimmed;

  if (text === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new McpProviderError("timed_out", "the server's response was not JSON");
  }
}

function firstEventData(body: string): string | undefined {
  for (const line of body.split("\n")) {
    if (line.startsWith("data:")) {
      return line.slice(5).trim();
    }
  }

  return undefined;
}

export function createHttpMcpServerProvider(options: HttpMcpServerOptions = {}): McpServerProvider {
  const fetchImpl = options.fetch ?? safeFetch;
  const timeoutMs = resolvePositive(options.timeoutMs, defaultTimeoutMs, "timeoutMs");
  const maxBytes = resolvePositive(options.maxBytes, defaultMaxBytes, "maxBytes");
  const allowInsecureOAuthEndpoints = options.allowInsecureOAuthEndpoints === true;
  let nextId = 1;

  function transportFailure(cause: unknown): McpProviderError {
    if (cause instanceof BlockedUrlError) {
      return new McpProviderError(
        "auth_failed",
        "the URL-safety rules refused the destination",
        undefined,
        { cause },
      );
    }

    if (cause instanceof McpProviderError) {
      return cause;
    }

    return new McpProviderError("timed_out", "the server did not answer", undefined, { cause });
  }

  async function post(
    url: string,
    payload: Record<string, unknown>,
    accessToken: string | undefined,
    sessionId: string | undefined,
  ): Promise<{ response: Response; payload: unknown }> {
    let response: Response;

    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": protocolVersion,
          ...(accessToken === undefined ? {} : { authorization: `Bearer ${accessToken}` }),
          ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
        },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw transportFailure(cause);
    }

    const location = response.headers.get("location");

    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProviderError(
        "auth_failed",
        "the server redirected; install its final URL instead",
        response.status,
      );
    }

    const failure = mcpStatusFailure(response.status);

    if (failure !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProviderError(failure.kind, failure.detail, response.status);
    }

    let body: string;

    try {
      body = await readBounded(response, maxBytes);
    } catch (cause) {
      throw transportFailure(cause);
    }

    return {
      response,
      payload: payloadFromBody(body, response.headers.get("content-type") ?? ""),
    };
  }

  async function initialize(
    url: string,
    accessToken: string | undefined,
  ): Promise<{ sessionId: string | undefined; serverName: string; serverVersion: string }> {
    const id = nextId;
    nextId += 1;

    const { response, payload } = await post(
      url,
      {
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "porkbot", version: "1.0" },
        },
      },
      accessToken,
      undefined,
    );

    const result = jsonRpcResult(payload, id);
    const serverInfo = isRecord(result["serverInfo"]) ? result["serverInfo"] : {};

    const sessionId = response.headers.get("mcp-session-id") ?? undefined;

    // The initialized notification completes the handshake. It is a courtesy
    // the specification only says a client SHOULD send, so a server that
    // refuses it with a 4xx is tolerated; a transport failure or a 5xx is not.
    await post(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized" },
      accessToken,
      sessionId,
    ).catch((cause: unknown) => {
      if (cause instanceof McpProviderError && (cause.status ?? 500) < 500) {
        return undefined;
      }

      throw cause;
    });

    return {
      sessionId,
      serverName: readText(serverInfo["name"]) ?? "mcp-server",
      serverVersion: readText(serverInfo["version"]) ?? "unknown",
    };
  }

  async function jsonRpcCall(
    url: string,
    method: string,
    params: Record<string, unknown>,
    accessToken: string | undefined,
    sessionId: string | undefined,
  ): Promise<Record<string, unknown>> {
    const id = nextId;
    nextId += 1;

    const { payload } = await post(
      url,
      { jsonrpc: "2.0", id, method, params },
      accessToken,
      sessionId,
    );

    return jsonRpcResult(payload, id);
  }

  async function metadata(url: string): Promise<{
    readonly authorizationEndpoint: string;
    readonly tokenEndpoint: string;
  }> {
    const origin = new URL(url).origin;
    let response: Response;

    try {
      response = await fetchImpl(`${origin}${wellKnownPath}`, {
        method: "GET",
        headers: { accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw transportFailure(cause);
    }

    const failure = mcpStatusFailure(response.status);

    if (failure !== undefined) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProviderError(failure.kind, "the server's OAuth metadata is not available");
    }

    let payload: unknown;

    try {
      payload = JSON.parse(await readBounded(response, maxBytes));
    } catch (cause) {
      if (cause instanceof McpProviderError) {
        throw cause;
      }

      throw new McpProviderError("timed_out", "the OAuth metadata was not JSON");
    }

    const document = isRecord(payload) ? payload : {};
    const authorizationEndpoint = readText(document["authorization_endpoint"]);
    const tokenEndpoint = readText(document["token_endpoint"]);

    if (authorizationEndpoint === undefined || tokenEndpoint === undefined) {
      throw new McpProviderError("auth_failed", "the server's OAuth metadata is incomplete");
    }

    // The endpoints are fetched later, but a non-https or credential-bearing
    // endpoint is refused before the browser is ever sent to it. Only the
    // offline wire test opts out, and it says so explicitly.
    if (!allowInsecureOAuthEndpoints) {
      try {
        assertAllowedUrl(authorizationEndpoint);
        assertAllowedUrl(tokenEndpoint);
      } catch (cause) {
        if (cause instanceof BlockedUrlError) {
          throw new McpProviderError(
            "auth_failed",
            "the OAuth endpoints are not allowed destinations",
          );
        }

        throw cause;
      }
    }

    return { authorizationEndpoint, tokenEndpoint };
  }

  function jsonRpcResult(payload: unknown, id: number): Record<string, unknown> {
    if (!isRecord(payload)) {
      throw new McpProviderError("timed_out", "the server answered no JSON-RPC payload");
    }

    if (isRecord(payload["error"])) {
      const code = payload["error"]["code"];
      throw jsonRpcFailure(typeof code === "number" ? code : undefined);
    }

    if (payload["id"] !== id) {
      throw new McpProviderError("timed_out", "the server answered a different request");
    }

    const result = payload["result"];

    if (!isRecord(result)) {
      throw new McpProviderError("timed_out", "the server answered no JSON-RPC result");
    }

    return result;
  }

  function readTools(result: Record<string, unknown>): readonly McpToolDescriptor[] {
    const tools = result["tools"];

    if (!Array.isArray(tools)) {
      throw new McpProviderError("timed_out", "the server's tool list did not match the contract");
    }

    return tools.map((tool) => {
      if (!isRecord(tool)) {
        throw new McpProviderError("timed_out", "a tool entry did not match the contract");
      }

      const name = readText(tool["name"]);

      if (name === undefined) {
        throw new McpProviderError("timed_out", "a tool entry carried no name");
      }

      const description = readText(tool["description"]);
      const schema = tool["inputSchema"];

      return {
        name,
        description: description ?? `The "${name}" tool provided by the MCP server.`,
        parameters: isRecord(schema) ? schema : { type: "object" },
      };
    });
  }

  return {
    async discover(request: McpDiscoverRequest): Promise<McpServerDescription> {
      const url = normalizeRequestUrl(request.url);
      const session = await initialize(url, request.accessToken);
      const result = await jsonRpcCall(
        url,
        "tools/list",
        {},
        request.accessToken,
        session.sessionId,
      );

      return {
        serverName: session.serverName,
        serverVersion: session.serverVersion,
        tools: readTools(result),
      };
    },

    async call(request: McpCallRequest): Promise<McpCallResult> {
      const url = normalizeRequestUrl(request.url);

      if (request.tool.trim() === "") {
        throw new McpProviderError("not_found", "the call named no tool");
      }

      const session = await initialize(url, request.accessToken);
      const result = await jsonRpcCall(
        url,
        "tools/call",
        { name: request.tool, arguments: request.arguments ?? {} },
        request.accessToken,
        session.sessionId,
      );

      return { content: readTextContent(result), isError: result["isError"] === true };
    },

    async authorizationUrl(request: McpAuthorizationRequest): Promise<string> {
      const url = normalizeRequestUrl(request.url);
      const document = await metadata(url);
      let authorization: URL;

      try {
        authorization = new URL(document.authorizationEndpoint);
      } catch {
        throw new McpProviderError("auth_failed", "the authorization endpoint is not a URL");
      }

      authorization.searchParams.set("response_type", "code");
      authorization.searchParams.set("client_id", request.clientId);
      authorization.searchParams.set("redirect_uri", request.redirectUri);
      authorization.searchParams.set("state", request.state);

      for (const scope of request.scopes ?? []) {
        authorization.searchParams.append("scope", scope);
      }

      return authorization.href;
    },

    async exchangeCode(request: McpCodeExchangeRequest): Promise<McpOAuthTokens> {
      const url = normalizeRequestUrl(request.url);
      const document = await metadata(url);
      const form = new URLSearchParams({
        grant_type: "authorization_code",
        code: request.code,
        redirect_uri: request.redirectUri,
        client_id: request.clientId,
      });

      if (request.clientSecret !== undefined) {
        form.set("client_secret", request.clientSecret);
      }

      let response: Response;

      try {
        response = await fetchImpl(document.tokenEndpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          redirect: "manual",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw transportFailure(cause);
      }

      const failure = mcpStatusFailure(response.status);

      if (failure !== undefined) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpProviderError(
          "auth_failed",
          failure.kind === "rate_limited"
            ? "the token endpoint is refusing work for now"
            : "the token endpoint refused the exchange",
          response.status,
        );
      }

      let payload: unknown;

      try {
        payload = JSON.parse(await readBounded(response, maxBytes));
      } catch (cause) {
        if (cause instanceof McpProviderError) {
          throw cause;
        }

        throw new McpProviderError("auth_failed", "the token endpoint answered no token");
      }

      const documentBody = isRecord(payload) ? payload : {};
      const accessToken = readText(documentBody["access_token"]);

      if (accessToken === undefined) {
        throw new McpProviderError("auth_failed", "the token endpoint answered no token");
      }

      const tokenType = readText(documentBody["token_type"]) ?? "Bearer";
      const refreshToken = readText(documentBody["refresh_token"]);
      const expiresIn = documentBody["expires_in"];
      const expiresAt =
        typeof expiresIn === "number" && Number.isFinite(expiresIn) && expiresIn > 0
          ? new Date(Date.now() + expiresIn * 1_000)
          : undefined;

      return {
        accessToken,
        tokenType,
        ...(refreshToken === undefined ? {} : { refreshToken }),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      };
    },
  };
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function normalizeRequestUrl(raw: string): string {
  try {
    return new URL(raw).href;
  } catch {
    throw new McpProviderError("not_found", "the server URL is not an absolute URL");
  }
}

/** Concatenates the text content blocks of a `tools/call` result. */
function readTextContent(result: Record<string, unknown>): string {
  const content = result["content"];

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(
      (block): block is Record<string, unknown> => isRecord(block) && block["type"] === "text",
    )
    .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
    .join("\n");
}
