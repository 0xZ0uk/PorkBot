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
  ProviderFailureKind,
} from "@porkbot/adapter-kit";
import { McpProviderError } from "./mcp-errors.ts";

/**
 * The offline MCP server provider (slice 9.5): scripted servers, tools and
 * OAuth exchanges with no network, no key and no clock. It is what the whole
 * product runs on with no server configured, and it is the surface the install,
 * discovery and run paths are exercised against.
 *
 * Scripts are data and the emulator is deterministic: a server is keyed by its
 * normalized URL, discovery returns the tools in the order they were served,
 * and calls and OAuth exchanges are recorded for assertions by position. A
 * URL with no script is the seam's `not_found`; `serveFailure` scripts a
 * persistent classified failure for one URL and `failNext` injects one for the
 * next request, so lifecycle code that branches on the shared vocabulary is
 * testable offline.
 *
 * The emulator is part of the product, not a test double: the tool layer labels
 * whatever this returns exactly as it labels the HTTP provider's answer, and
 * the install path persists exactly the description this reports.
 */

export interface EmulatedMcpFailure {
  readonly kind: ProviderFailureKind;
  readonly detail?: string | undefined;
  readonly status?: number | undefined;
}

export interface EmulatedMcpServer {
  /** Absolute URL the server is reachable at, as a caller would name it. */
  readonly url: string;
  /** Defaults to `emulated-server`. */
  readonly serverName?: string | undefined;
  /** Defaults to `1.0.0`. */
  readonly serverVersion?: string | undefined;
  readonly tools?: readonly McpToolDescriptor[] | undefined;
  /**
   * A token the server requires. When set, a discovery or call without the
   * matching token is `auth_failed`, exactly as a real server's 401 is.
   */
  readonly accessToken?: string | undefined;
}

export interface EmulatedMcpAnswer {
  readonly content: string;
  readonly isError?: boolean | undefined;
}

export interface EmulatedMcpOAuth {
  readonly authorizationEndpoint?: string | undefined;
  readonly tokenEndpoint?: string | undefined;
  /** When set, the exchange must carry this client id or it is `auth_failed`. */
  readonly clientId?: string | undefined;
  /** When set, the exchange must carry this client secret or it is `auth_failed`. */
  readonly clientSecret?: string | undefined;
}

const DEFAULT_AUTHORIZATION_ENDPOINT = "https://auth.example.invalid/authorize";
const DEFAULT_ACCESS_TOKEN = "emulator-access-token";
const DEFAULT_REFRESH_TOKEN = "emulator-refresh-token";

function normalizeUrl(url: string): string | undefined {
  try {
    return new URL(url).href;
  } catch {
    return undefined;
  }
}

export class McpServerEmulator implements McpServerProvider {
  readonly #servers = new Map<string, EmulatedMcpServer>();
  readonly #failures = new Map<string, EmulatedMcpFailure>();
  readonly #answers = new Map<string, EmulatedMcpAnswer>();
  readonly #discoveries: McpDiscoverRequest[] = [];
  readonly #calls: McpCallRequest[] = [];
  readonly #authorizations: McpAuthorizationRequest[] = [];
  readonly #exchanges: McpCodeExchangeRequest[] = [];
  #oauth: EmulatedMcpOAuth = {};
  #nextFailure: EmulatedMcpFailure | undefined;

  /** Every discovery request received, oldest first. */
  get discoveries(): readonly McpDiscoverRequest[] {
    return this.#discoveries;
  }

  /** Every tool call received, oldest first. */
  get calls(): readonly McpCallRequest[] {
    return this.#calls;
  }

  /** Every authorization URL built, oldest first. */
  get authorizations(): readonly McpAuthorizationRequest[] {
    return this.#authorizations;
  }

  /** Every code exchange received, oldest first. */
  get exchanges(): readonly McpCodeExchangeRequest[] {
    return this.#exchanges;
  }

  /** Serve one server; the last registration for a URL wins. */
  serve(server: EmulatedMcpServer): this {
    const url = normalizeUrl(server.url);

    if (url === undefined) {
      throw new RangeError(`serve needs an absolute URL, received "${server.url}"`);
    }

    this.#servers.set(url, { ...server, url });
    return this;
  }

  /** Script what one tool call returns. The last registration for a tool wins. */
  answerTool(tool: string, answer: EmulatedMcpAnswer): this {
    this.#answers.set(tool, { ...answer });
    return this;
  }

  /** Make every request to one served URL fail with this classification. */
  serveFailure(url: string, failure: EmulatedMcpFailure): this {
    const normalized = normalizeUrl(url);

    if (normalized === undefined) {
      throw new RangeError(`serveFailure needs an absolute URL, received "${url}"`);
    }

    this.#failures.set(normalized, { ...failure });
    return this;
  }

  /** Configure the authorization and token endpoints the OAuth methods answer. */
  serveOAuth(oauth: EmulatedMcpOAuth): this {
    this.#oauth = { ...oauth };
    return this;
  }

  /** Make the next request — any method — fail with this classification. */
  failNext(failure: EmulatedMcpFailure): this {
    this.#nextFailure = { ...failure };
    return this;
  }

  /** The most recent discovery request, or `undefined` when none arrived. */
  lastDiscovery(): McpDiscoverRequest | undefined {
    return this.#discoveries.at(-1);
  }

  /** The most recent tool call, or `undefined` when none arrived. */
  lastCall(): McpCallRequest | undefined {
    return this.#calls.at(-1);
  }

  /** Forget servers, scripts, failures and recorded requests, for the next test. */
  clear(): void {
    this.#servers.clear();
    this.#failures.clear();
    this.#answers.clear();
    this.#discoveries.length = 0;
    this.#calls.length = 0;
    this.#authorizations.length = 0;
    this.#exchanges.length = 0;
    this.#oauth = {};
    this.#nextFailure = undefined;
  }

  async discover(request: McpDiscoverRequest): Promise<McpServerDescription> {
    this.#discoveries.push({ ...request });

    const failure = this.#takeFailure(request.url);

    if (failure !== undefined) {
      throw failure;
    }

    const server = this.#requireServer(request.url);
    this.#requireToken(server, request.accessToken);

    return {
      serverName: server.serverName ?? "emulated-server",
      serverVersion: server.serverVersion ?? "1.0.0",
      tools: (server.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    };
  }

  async call(request: McpCallRequest): Promise<McpCallResult> {
    this.#calls.push({ ...request });

    const failure = this.#takeFailure(request.url);

    if (failure !== undefined) {
      throw failure;
    }

    const server = this.#requireServer(request.url);
    this.#requireToken(server, request.accessToken);

    const known = (server.tools ?? []).some((tool) => tool.name === request.tool);

    if (!known) {
      throw new McpProviderError("not_found", "the server does not offer that tool");
    }

    const answer = this.#answers.get(request.tool);

    if (answer === undefined) {
      throw new McpProviderError("not_found", "no answer is scripted for that tool");
    }

    return { content: answer.content, isError: answer.isError ?? false };
  }

  async authorizationUrl(request: McpAuthorizationRequest): Promise<string> {
    this.#authorizations.push({ ...request });

    const failure = this.#takeFailure(request.url);

    if (failure !== undefined) {
      throw failure;
    }

    const server = this.#requireServer(request.url);

    if (this.#oauth.clientId !== undefined && request.clientId !== this.#oauth.clientId) {
      throw new McpProviderError("auth_failed", "the authorization server refused the client");
    }

    const endpoint = this.#oauth.authorizationEndpoint ?? DEFAULT_AUTHORIZATION_ENDPOINT;
    const url = new URL(endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", request.clientId);
    url.searchParams.set("redirect_uri", request.redirectUri);
    url.searchParams.set("state", request.state);

    for (const scope of request.scopes ?? []) {
      url.searchParams.append("scope", scope);
    }

    // The server is read so an unserved URL fails like every other method; the
    // description itself is not part of an authorization URL.
    void server;

    return url.href;
  }

  async exchangeCode(request: McpCodeExchangeRequest): Promise<McpOAuthTokens> {
    this.#exchanges.push({ ...request });

    const failure = this.#takeFailure(request.url);

    if (failure !== undefined) {
      throw failure;
    }

    this.#requireServer(request.url);

    if (request.code.trim() === "") {
      throw new McpProviderError("auth_failed", "the authorization code was refused");
    }

    if (this.#oauth.clientId !== undefined && request.clientId !== this.#oauth.clientId) {
      throw new McpProviderError("auth_failed", "the token endpoint refused the client");
    }

    if (
      this.#oauth.clientSecret !== undefined &&
      request.clientSecret !== this.#oauth.clientSecret
    ) {
      throw new McpProviderError("auth_failed", "the token endpoint refused the client secret");
    }

    return {
      accessToken: DEFAULT_ACCESS_TOKEN,
      refreshToken: DEFAULT_REFRESH_TOKEN,
      tokenType: "Bearer",
    };
  }

  #requireServer(url: string): EmulatedMcpServer {
    const normalized = normalizeUrl(url);
    const server = normalized === undefined ? undefined : this.#servers.get(normalized);

    if (server === undefined) {
      throw new McpProviderError("not_found", "the server does not exist at that URL");
    }

    return server;
  }

  #requireToken(server: EmulatedMcpServer, accessToken: string | undefined): void {
    if (server.accessToken === undefined) {
      return;
    }

    if (accessToken !== server.accessToken) {
      throw new McpProviderError("auth_failed", "the server refused the access token");
    }
  }

  #takeFailure(url: string): McpProviderError | undefined {
    const normalized = normalizeUrl(url);
    const scripted =
      this.#nextFailure ?? (normalized === undefined ? undefined : this.#failures.get(normalized));

    if (scripted === undefined) {
      return undefined;
    }

    if (this.#nextFailure !== undefined) {
      this.#nextFailure = undefined;
    }

    return new McpProviderError(
      scripted.kind,
      scripted.detail ?? "scripted failure",
      scripted.status,
    );
  }
}
