/**
 * The MCP server registry's closed vocabularies (slice 9.5, PRD story 38).
 *
 * An installed server authenticates with nothing or with an OAuth flow, and it
 * is either waiting for that flow, ready, or failed. The database enum, the
 * durable store's rows and the transport contract all build from these
 * constants, so a status the database accepts is a status the domain knows —
 * the same rule the run state machine sets for run status.
 *
 * The registry itself (URLs, tools, per-bot grants) is durable state owned by
 * `@porkbot/db`; only the vocabulary lives here, where it can be named without
 * a framework or a driver.
 */

/** How an installed server authenticates. */
export const MCP_AUTH_MODES = ["none", "oauth"] as const;

export type McpAuthMode = (typeof MCP_AUTH_MODES)[number];

/** Where an installed server is in its lifecycle. */
export const MCP_SERVER_STATUSES = ["pending_authorization", "ready", "error"] as const;

export type McpServerStatus = (typeof MCP_SERVER_STATUSES)[number];

/** The status a newly installed server starts in. */
export const MCP_SERVER_INITIAL_STATUS: McpServerStatus = "pending_authorization";

/** Whether a stored value is one of the statuses this build knows. */
export function isMcpServerStatus(value: unknown): value is McpServerStatus {
  return typeof value === "string" && (MCP_SERVER_STATUSES as readonly string[]).includes(value);
}
