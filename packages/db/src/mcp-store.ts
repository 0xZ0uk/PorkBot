import { NameConflictError, NotFoundError } from "@porkbot/effect";
import type {
  McpGrantRecord,
  McpGrantedServer,
  McpRunServers,
  McpServerRecord,
  McpServerStatus,
  McpServers,
  McpServerView,
  McpToolRecord,
  NewMcpServer,
} from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { insertedRow, isUniqueViolation, requiredRow } from "./rows.ts";

/**
 * The durable half of MCP servers (slice 9.5, PRD story 38), over the
 * `mcp_server`, `mcp_server_tool` and `bot_mcp_server` rows.
 *
 * This is the one module that names those tables, and
 * `mcp-store.call-sites.test.ts` walks the shipped source and fails when a
 * table name appears anywhere else — the same ownership the memory,
 * notification and credential stores have. Every statement binds the actor's
 * `space_id`; a by-id fetch of another space's row is the shared
 * `NotFoundError`, and a tool or grant insert selects its parent inside the
 * statement, so a cross-space parent cannot be written even by a guessed id.
 *
 * The factory splits by actor as every store does:
 *
 *   - A `UserActor` receives `McpServers`: install, list, by-id read, status
 *     and tool caching, remove, grant and revoke, plus the two grant reads the
 *     settings surface renders. A name taken in the space is the shared
 *     `NameConflictError`.
 *   - A `SystemActor` receives `McpRunServers`: the servers and tools granted
 *     to one bot, and the live `isGranted` re-check the tool layer asks before
 *     every call — a read, not a cached answer, so a revoke stops the next
 *     call of an open run.
 *
 * No value, ciphertext or token is ever selected: the row stores the name of
 * the credential, and the value lives in the encrypted credential store.
 */

const serverColumns =
  "id, name, url, auth::text as auth, status::text as status, " +
  'credential_name as "credentialName", last_error as "lastError", ' +
  'created_at as "createdAt", updated_at as "updatedAt"';

interface JoinedServerRow {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly auth: McpServerRecord["auth"];
  readonly status: McpServerRecord["status"];
  readonly credentialName: string;
  readonly lastError: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly toolName: string | null;
  readonly toolDescription: string | null;
  readonly toolParameters: unknown;
}

function toServerView(row: JoinedServerRow): McpServerRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    auth: row.auth,
    status: row.status,
    credentialName: row.credentialName,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Groups a server join into views in row order. The query orders by server
 * name then tool name, so a server's tools arrive together and in a stable
 * order; a server with no tools still arrives as one row with null tool
 * columns.
 */
function groupServers(rows: readonly JoinedServerRow[]): McpServerView[] {
  const byId = new Map<string, { server: McpServerRecord; tools: McpToolRecord[] }>();

  for (const row of rows) {
    let entry = byId.get(row.id);

    if (entry === undefined) {
      entry = { server: toServerView(row), tools: [] };
      byId.set(row.id, entry);
    }

    if (row.toolName !== null) {
      entry.tools.push({
        name: row.toolName,
        description: row.toolDescription ?? "",
        parameters: row.toolParameters,
      });
    }
  }

  return [...byId.values()].map(({ server, tools }) => ({ ...server, tools }));
}

const joinedServerColumns =
  `s.id, s.name, s.url, s.auth::text as auth, s.status::text as status, ` +
  's.credential_name as "credentialName", s.last_error as "lastError", ' +
  's.created_at as "createdAt", s.updated_at as "updatedAt", ' +
  't.name as "toolName", t.description as "toolDescription", t.parameters as "toolParameters"';

export function createMcpStore(actor: UserActor, database: Queryable): McpServers;
export function createMcpStore(actor: SystemActor, database: Queryable): McpRunServers;
export function createMcpStore(actor: Actor, database: Queryable): McpServers | McpRunServers;
export function createMcpStore(actor: Actor, database: Queryable): McpServers | McpRunServers {
  if (actor.kind === "system") {
    return {
      async listGrantedForBot(botId: string): Promise<readonly McpGrantedServer[]> {
        await requireBot(actor.spaceId, botId, database);

        const { rows } = await database.query<JoinedServerRow>(
          `select ${joinedServerColumns} from mcp_server s ` +
            "join bot_mcp_server g on g.server_id = s.id and g.space_id = s.space_id " +
            "left join mcp_server_tool t on t.server_id = s.id " +
            "where s.space_id = $1 and g.bot_id = $2 and g.revoked_at is null " +
            "and s.status = 'ready' " +
            "order by s.name asc, t.name asc",
          [actor.spaceId, botId],
        );

        return groupServers(rows).map((view) => {
          const { tools, ...server } = view;

          return { server, tools };
        });
      },

      async isGranted(botId: string, serverId: string): Promise<boolean> {
        const { rows } = await database.query<{ readonly id: string }>(
          "select g.id from bot_mcp_server g " +
            "where g.space_id = $1 and g.bot_id = $2 and g.server_id = $3 " +
            "and g.revoked_at is null",
          [actor.spaceId, botId, serverId],
        );

        return rows.length > 0;
      },
    };
  }

  async function requireServer(id: string): Promise<McpServerRecord> {
    const { rows } = await database.query<JoinedServerRow>(
      `select ${joinedServerColumns} from mcp_server s ` +
        "left join mcp_server_tool t on t.server_id = s.id " +
        "where s.id = $1 and s.space_id = $2 order by t.name asc",
      [id, actor.spaceId],
    );

    return toServerView(requiredRow(rows, "mcp server", id));
  }

  return {
    async list(): Promise<readonly McpServerView[]> {
      const { rows } = await database.query<JoinedServerRow>(
        `select ${joinedServerColumns} from mcp_server s ` +
          "left join mcp_server_tool t on t.server_id = s.id " +
          "where s.space_id = $1 order by s.name asc, t.name asc",
        [actor.spaceId],
      );

      return groupServers(rows);
    },

    async findById(id: string): Promise<McpServerView> {
      const { rows } = await database.query<JoinedServerRow>(
        `select ${joinedServerColumns} from mcp_server s ` +
          "left join mcp_server_tool t on t.server_id = s.id " +
          "where s.id = $1 and s.space_id = $2 order by t.name asc",
        [id, actor.spaceId],
      );
      const view = groupServers(rows)[0];

      if (view === undefined) {
        throw new NotFoundError("mcp server", id);
      }

      return view;
    },

    async create(input: NewMcpServer): Promise<McpServerRecord> {
      let rows: readonly JoinedServerRow[];

      try {
        const inserted = await database.query<JoinedServerRow>(
          "insert into mcp_server (space_id, name, url, auth, status, credential_name) " +
            "values ($1, $2, $3, $4::mcp_server_auth, $5::mcp_server_status, $6) " +
            `returning ${serverColumns}`,
          [
            actor.spaceId,
            input.name,
            input.url,
            input.auth,
            "pending_authorization",
            input.credentialName,
          ],
        );
        rows = inserted.rows;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new NameConflictError("MCP server", input.name);
        }

        throw error;
      }

      return toServerView(insertedRow(rows));
    },

    async setStatus(
      id: string,
      status: McpServerStatus,
      lastError: string | null,
    ): Promise<McpServerRecord> {
      const { rows } = await database.query<JoinedServerRow>(
        "update mcp_server set status = $1::mcp_server_status, last_error = $2, " +
          "updated_at = now() where id = $3 and space_id = $4 " +
          `returning ${serverColumns}`,
        [status, lastError, id, actor.spaceId],
      );

      return toServerView(requiredRow(rows, "mcp server", id));
    },

    async replaceTools(id: string, tools: readonly McpToolRecord[]): Promise<void> {
      await requireServer(id);

      await database.query("delete from mcp_server_tool where space_id = $1 and server_id = $2", [
        actor.spaceId,
        id,
      ]);

      for (const tool of tools) {
        const { rows } = await database.query<{ readonly id: string }>(
          "insert into mcp_server_tool (space_id, server_id, name, description, parameters) " +
            "select $1, s.id, $3, $4, $5::jsonb from mcp_server s " +
            "where s.id = $2 and s.space_id = $1 " +
            "returning id",
          [actor.spaceId, id, tool.name, tool.description, JSON.stringify(tool.parameters ?? {})],
        );

        if (rows.length === 0) {
          throw new NotFoundError("mcp server", id);
        }
      }
    },

    async remove(id: string): Promise<void> {
      const { rows } = await database.query<{ readonly id: string }>(
        "delete from mcp_server where id = $1 and space_id = $2 returning id",
        [id, actor.spaceId],
      );

      if (rows.length === 0) {
        throw new NotFoundError("mcp server", id);
      }
    },

    async grant(botId: string, serverId: string): Promise<void> {
      const { rows } = await database.query<{ readonly id: string }>(
        "insert into bot_mcp_server (space_id, bot_id, server_id) " +
          "select $1, b.id, s.id from bot b join mcp_server s " +
          "on s.id = $3 and s.space_id = $1 " +
          "where b.id = $2 and b.space_id = $1 " +
          "on conflict (space_id, bot_id, server_id) " +
          "do update set revoked_at = null, updated_at = now() " +
          "returning id",
        [actor.spaceId, botId, serverId],
      );

      if (rows.length === 0) {
        throw new NotFoundError("mcp server grant", `${botId}:${serverId}`);
      }
    },

    async revoke(botId: string, serverId: string): Promise<void> {
      const { rows } = await database.query<{ readonly id: string }>(
        "update bot_mcp_server set revoked_at = now(), updated_at = now() " +
          "where space_id = $1 and bot_id = $2 and server_id = $3 returning id",
        [actor.spaceId, botId, serverId],
      );

      if (rows.length === 0) {
        throw new NotFoundError("mcp server grant", `${botId}:${serverId}`);
      }
    },

    async listForServer(serverId: string): Promise<readonly McpGrantRecord[]> {
      await requireServer(serverId);

      const { rows } = await database.query<{
        readonly botId: string;
        readonly serverId: string;
        readonly revokedAt: Date | null;
      }>(
        'select bot_id as "botId", server_id as "serverId", revoked_at as "revokedAt" ' +
          "from bot_mcp_server where space_id = $1 and server_id = $2 order by bot_id asc",
        [actor.spaceId, serverId],
      );

      return rows;
    },
  };
}

/** The bot's existence in the actor's space is the scope for a grant read. */
async function requireBot(spaceId: string, botId: string, database: Queryable): Promise<void> {
  const { rows } = await database.query<{ readonly id: string }>(
    "select id from bot where id = $1 and space_id = $2",
    [botId, spaceId],
  );

  requiredRow(rows, "bot", botId);
}
