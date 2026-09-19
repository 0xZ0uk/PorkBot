import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { bot } from "./bots.ts";
import { primaryKeyId, timestamps } from "./columns.ts";
import { mcpServerAuth, mcpServerStatus } from "./enums.ts";
import { space } from "./tenancy.ts";

/**
 * The MCP server registry (slice 9.5, PRD story 38; epic E9).
 *
 * Three rows carry one installed server: `mcp_server` is the URL, its auth mode
 * and the lifecycle status; `mcp_server_tool` is the tool list discovery
 * persisted, so the run path reads the same definitions the model was offered
 * without a network round trip; `bot_mcp_server` is the per-bot grant.
 *
 * Everything is space-scoped and cascades with its parents, so uninstalling a
 * server or deleting a bot leaves nothing behind. The credential itself is not
 * a column: `credential_name` names the encrypted credential row, which is the
 * only place a token or a client secret rests.
 *
 * A name is unique per space, the tool list is unique per server and name, and
 * the grant is unique per `(space, bot, server)` so attaching the same server
 * twice is an upsert rather than a duplicate row; `revoked_at` is how a revoke
 * stays auditable and how a re-grant clears it.
 */

export const mcpServer = pgTable(
  "mcp_server",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    url: text("url").notNull(),
    auth: mcpServerAuth("auth").notNull(),
    status: mcpServerStatus("status").notNull(),
    /** The encrypted credential row this server's tokens resolve under. */
    credentialName: text("credential_name").notNull(),
    /** An operator-safe line from the last failed install or discovery. */
    lastError: text("last_error"),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("mcp_server_space_name_unique").on(table.spaceId, table.name),
    index("mcp_server_space_id_idx").on(table.spaceId),
    check("mcp_server_name_check", sql`length(btrim(${table.name})) > 0`),
    check("mcp_server_url_check", sql`length(btrim(${table.url})) > 0`),
    check("mcp_server_credential_name_check", sql`length(btrim(${table.credentialName})) > 0`),
  ],
);

export const mcpServerTool = pgTable(
  "mcp_server_tool",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServer.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    /** The server's JSON Schema for this tool's arguments, unchanged. */
    parameters: jsonb("parameters").notNull(),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("mcp_server_tool_server_name_unique").on(table.serverId, table.name),
    index("mcp_server_tool_server_id_idx").on(table.serverId),
    index("mcp_server_tool_space_id_idx").on(table.spaceId),
    check("mcp_server_tool_name_check", sql`length(btrim(${table.name})) > 0`),
  ],
);

export const botMcpServer = pgTable(
  "bot_mcp_server",
  {
    id: primaryKeyId(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => space.id, { onDelete: "cascade" }),
    botId: uuid("bot_id")
      .notNull()
      .references(() => bot.id, { onDelete: "cascade" }),
    serverId: uuid("server_id")
      .notNull()
      .references(() => mcpServer.id, { onDelete: "cascade" }),
    /** Set when the grant was revoked; cleared when it is granted again. */
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("bot_mcp_server_space_bot_server_unique").on(
      table.spaceId,
      table.botId,
      table.serverId,
    ),
    index("bot_mcp_server_bot_id_idx").on(table.botId),
    index("bot_mcp_server_server_id_idx").on(table.serverId),
    index("bot_mcp_server_space_id_idx").on(table.spaceId),
  ],
);
