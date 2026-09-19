import type { FailureMapping } from "./failures.ts";

/**
 * The MCP server seam: installing a server by URL, discovering its tools and
 * calling them (slice 9.5, PRD story 38; epic E9).
 *
 * An MCP server is a user-supplied URL, so this seam is also an egress door:
 * every implementation sends every request through the URL-safety module (slice
 * 4.6) — HTTPS only, no embedded credentials, no private, loopback or metadata
 * addresses, checked against the address actually connected to. The offline
 * emulator (slice 9.5) serves a scripted server through the same interface, so
 * the whole install, discovery and run path is exercisable with no network and
 * no key; the real HTTP provider (slice 9.5) speaks the streamable-HTTP JSON-RPC
 * transport and resolves OAuth tokens by value, never from the environment.
 *
 * Tokens and client secrets never appear in these shapes as stored state: the
 * caller resolves a credential and passes the value for one request, exactly as
 * the web-access provider does. What is persisted is the credential store's
 * business, not the adapter's.
 *
 * Failure mapping: a provider raises an error that implements
 * `ProviderFailure`, classified by the `failureMapping` table below. The tool
 * layer reports the kind to the model so it can adapt; install and discovery
 * surface it as a typed transport error the operator can act on.
 */

/** One tool a server advertises. `parameters` is the provider-neutral JSON Schema. */
export interface McpToolDescriptor {
  readonly name: string;
  /** The model-facing description; a server that sends none gets a placeholder. */
  readonly description: string;
  /** JSON Schema for the tool's arguments, exactly as the server sent it. */
  readonly parameters: unknown;
}

/** What one discovery returned: the server's self-description and its tools. */
export interface McpServerDescription {
  readonly serverName: string;
  readonly serverVersion: string;
  readonly tools: readonly McpToolDescriptor[];
}

export interface McpDiscoverRequest {
  /** Absolute HTTPS URL of the MCP endpoint. */
  readonly url: string;
  /** The OAuth access token for this server, when its configuration requires one. */
  readonly accessToken?: string | undefined;
}

export interface McpCallRequest {
  readonly url: string;
  readonly accessToken?: string | undefined;
  readonly tool: string;
  /** The model's arguments, sent to the server unchanged. */
  readonly arguments: unknown;
}

/**
 * What one tool call produced. Text content is concatenated; `isError` is the
 * server's own flag, so a tool that reports a domain failure is a completed
 * call the model reads rather than a transport failure.
 */
export interface McpCallResult {
  readonly content: string;
  readonly isError: boolean;
}

/**
 * Builds the URL a browser is sent to for the authorization code. The provider
 * discovers the authorization server's endpoints through the URL-safety module,
 * so the metadata document is fetched under the same policy as every other
 * user-supplied URL.
 */
export interface McpAuthorizationRequest {
  readonly url: string;
  readonly clientId: string;
  readonly redirectUri: string;
  /** The one-time state bound to the initiating actor; the provider echoes it back. */
  readonly state: string;
  readonly scopes?: readonly string[] | undefined;
}

/** Exchanges an authorization code for tokens at the discovered token endpoint. */
export interface McpCodeExchangeRequest {
  readonly url: string;
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly code: string;
  readonly redirectUri: string;
}

export interface McpOAuthTokens {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt?: Date | undefined;
  readonly tokenType: string;
}

export interface McpServerProvider {
  /** Lists the server's tools. A destination the URL-safety rules refuse fails typed. */
  discover(request: McpDiscoverRequest): Promise<McpServerDescription>;
  /** Runs one tool. A tool the server reports as failed is a completed call with `isError`. */
  call(request: McpCallRequest): Promise<McpCallResult>;
  /** Discovers the authorization server and builds the browser's authorization URL. */
  authorizationUrl(request: McpAuthorizationRequest): Promise<string>;
  /** Exchanges the callback's code; the caller stores the tokens encrypted. */
  exchangeCode(request: McpCodeExchangeRequest): Promise<McpOAuthTokens>;
}

export const failureMapping: FailureMapping = {
  gone: "Not produced: a server is addressed by URL, so a server that no longer exists answers `not_found`. A revoked OAuth grant is `auth_failed`.",
  not_found:
    "The URL answers 404/410, the destination is missing from the OAuth metadata document, or a JSON-RPC error names an unknown tool or method.",
  rate_limited:
    "The server or its authorization endpoint answers HTTP 429; the caller backs off instead of hammering it.",
  timed_out:
    "The request exceeded its budget, a stream stalled, a 5xx arrived, or the response did not match the JSON-RPC contract.",
  auth_failed:
    "The destination refused the token (HTTP 401/403), no token is stored for a server that requires one, the OAuth exchange was refused, or the URL-safety rules refused the destination.",
};
