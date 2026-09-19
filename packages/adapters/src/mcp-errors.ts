import type { ProviderFailure, ProviderFailureKind } from "@porkbot/adapter-kit";

/**
 * The typed failures an MCP provider can raise (slice 9.5).
 *
 * The classification is the shared vocabulary, never a vendor string: a
 * transport failure is `timed_out`, a destination the URL-safety rules refuse
 * is `auth_failed`, and the HTTP status decides the rest. The detail is
 * operator-safe and never quotes a response body, because a server is free to
 * echo whatever it was sent.
 */

export class McpProviderError extends Error implements ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly status: number | undefined;

  constructor(kind: ProviderFailureKind, detail: string, status?: number, options?: ErrorOptions) {
    super(`MCP server failed (${kind}): ${detail}`, options);
    this.name = "McpProviderError";
    this.kind = kind;
    this.detail = detail;
    this.status = status;
  }
}

export interface McpStatusFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
}

/** How an HTTP status classifies, or `undefined` for 2xx. */
export function mcpStatusFailure(status: number): McpStatusFailure | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }

  if (status === 401 || status === 403) {
    return { kind: "auth_failed", detail: "the server refused the request" };
  }

  if (status === 404 || status === 410) {
    return { kind: "not_found", detail: "the server does not exist at that URL" };
  }

  if (status === 429) {
    return { kind: "rate_limited", detail: "the server is refusing work for now" };
  }

  return { kind: "timed_out", detail: `the server answered HTTP ${status}` };
}

/**
 * How a JSON-RPC error object classifies. The message is deliberately not
 * carried: only the code decides. An unknown method or tool is `not_found`;
 * anything else is a response that did not match the contract (`timed_out`).
 */
export function jsonRpcFailure(code: number | undefined): McpProviderError {
  if (code === -32601 || code === -32602) {
    return new McpProviderError("not_found", "the server does not offer that method or tool");
  }

  return new McpProviderError("timed_out", "the server answered a JSON-RPC error");
}
