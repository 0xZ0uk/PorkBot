/**
 * The durable half of MCP servers (slice 9.5, PRD story 38; epic E9).
 *
 * An installed server is one URL, its auth mode and the name its credential
 * resolves under; discovery caches the tool list beside it; a grant attaches a
 * server to one bot. `@porkbot/db` implements these interfaces in a single
 * module over the server, tool and grant rows — the only module that names
 * them — and the factory splits by actor the way every store does:
 *
 *   - A `UserActor` receives `McpServers`: the operator's install, list,
 *     remove, refresh and per-bot grants, every statement bound to the actor's
 *     space. A by-id read of another space's server is the shared
 *     `NotFoundError`, exactly like every other scoped read.
 *   - A `SystemActor` receives `McpRunServers`: the run path's two questions —
 *     which servers and tools this bot holds, and whether one grant is still
 *     live. The grant check is a read, not a cached answer, so a revoke takes
 *     effect while a run is open.
 *
 * No shape here carries a token or a client secret. A credential is resolved
 * by name through `Credentials`; the record only names the row it lives under.
 */

import type { McpAuthMode, McpServerStatus } from "@porkbot/core";

/**
 * The auth mode and lifecycle status vocabularies live in `@porkbot/core`;
 * they are re-exported here so a consumer of this seam has one import and the
 * database enum, the store and the wire schema cannot drift.
 */
export type { McpAuthMode, McpServerStatus };

/** One installed server, without the credential or the discovered tools. */
export interface McpServerRecord {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth: McpAuthMode;
  readonly status: McpServerStatus;
  /** The name the encrypted credential row resolves under. */
  readonly credentialName: string;
  /** An operator-safe line from the last failed discovery, or `null`. */
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One discovered tool. `parameters` is the server's JSON Schema, unchanged. */
export interface McpToolRecord {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
}

/** A server with the tools discovery most recently persisted. */
export interface McpServerView extends McpServerRecord {
  readonly tools: readonly McpToolRecord[];
}

/** The operator's install input; the space comes from the actor. */
export interface NewMcpServer {
  readonly name: string;
  readonly url: string;
  readonly auth: McpAuthMode;
  readonly credentialName: string;
}

/** One bot-to-server attachment. A revoked grant stays as history. */
export interface McpGrantRecord {
  readonly botId: string;
  readonly serverId: string;
  readonly revokedAt: Date | null;
}

/** What the run path needs for one granted server. */
export interface McpGrantedServer {
  readonly server: McpServerRecord;
  readonly tools: readonly McpToolRecord[];
}

/** The operator's half: install, inspect, refresh, remove and grant. */
export interface McpServers {
  list(): Promise<readonly McpServerView[]>;
  /** The scoped by-id read; a foreign or missing id is the shared not-found. */
  findById(id: string): Promise<McpServerView>;
  /** Inserts a server; a name taken in the space is a `NameConflictError`. */
  create(input: NewMcpServer): Promise<McpServerRecord>;
  /** Records the lifecycle outcome of install or discovery. */
  setStatus(
    id: string,
    status: McpServerStatus,
    lastError: string | null,
  ): Promise<McpServerRecord>;
  /** Replaces the discovered tool list in one statement. */
  replaceTools(id: string, tools: readonly McpToolRecord[]): Promise<void>;
  /** Removes the server; its grants and tools go with it. */
  remove(id: string): Promise<void>;
  /** Attaches a server to one bot, clearing any prior revoke. */
  grant(botId: string, serverId: string): Promise<void>;
  /** Revokes one attachment without deleting its history. */
  revoke(botId: string, serverId: string): Promise<void>;
  /** Every server in the space, with the bots each is granted to. */
  listForServer(serverId: string): Promise<readonly McpGrantRecord[]>;
}

/** The run path's half: what this bot holds, and whether one grant is live. */
export interface McpRunServers {
  /** Servers granted and not revoked, with their persisted tools. */
  listGrantedForBot(botId: string): Promise<readonly McpGrantedServer[]>;
  /**
   * Whether the bot's grant is live at this moment. The run path asks this
   * before every MCP tool call, so a revoke stops the next call rather than
   * waiting for the run to end.
   */
  isGranted(botId: string, serverId: string): Promise<boolean>;
}
