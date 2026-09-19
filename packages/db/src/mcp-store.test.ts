import { NameConflictError, NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import { createMcpStore } from "./mcp-store.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The MCP store without a server: a recording fake stands in for the pg
 * client, so these tests prove the module's own contract — every statement
 * binds the actor's space, a by-id miss of any kind is the shared not-found, a
 * violated unique index is the shared name conflict, and a join groups into
 * one server with its tools. Whether the unique indexes and cascades really
 * behave is not provable here; the integration matrix runs the same seams
 * against Postgres.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
}

function fakeDatabase(respond: (call: QueryCall) => readonly unknown[] = () => []): FakeDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      const call = { text, values };
      calls.push(call);

      return { rows: respond(call) as readonly Row[] };
    },
  };
}

const operator: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const worker: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };
const serverId = "0198f000-0000-7000-8000-000000000001";
const botId = "0198f000-0000-7000-8000-000000000002";

const serverRow = {
  id: serverId,
  name: "issues",
  url: "https://mcp.example.invalid/mcp",
  auth: "none",
  status: "ready",
  credentialName: "mcp:issues",
  lastError: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const isServerSelect = (text: string): boolean =>
  text.startsWith("select s.id, s.name") || text.startsWith("select id from mcp_server");
const isToolSelect = (text: string): boolean => text.startsWith("select s.id, s.name");
const isToolDelete = (text: string): boolean => text.startsWith("delete from mcp_server_tool");
const isToolInsert = (text: string): boolean => text.startsWith("insert into mcp_server_tool");

describe("the operator's registry half", () => {
  it("lists servers with their tools, in one scoped join", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isToolSelect(text)) {
        return [
          { ...serverRow, toolName: "list_issues", toolDescription: "List.", toolParameters: {} },
          {
            ...serverRow,
            toolName: "create_issue",
            toolDescription: "Create.",
            toolParameters: {},
          },
          {
            ...serverRow,
            id: "server-2",
            name: "empty",
            toolName: null,
            toolDescription: null,
            toolParameters: null,
          },
        ];
      }

      return [];
    });

    const servers = await createMcpStore(operator, database).list();

    expect(servers).toHaveLength(2);
    expect(servers[0]?.tools.map((tool) => tool.name)).toEqual(["list_issues", "create_issue"]);
    expect(servers[1]?.tools).toEqual([]);
    expect(database.calls[0]?.text).toContain("where s.space_id = $1");
    expect(database.calls[0]?.values).toEqual(["space-1"]);
  });

  it("refuses a by-id read that matched no scoped row", async () => {
    const database = fakeDatabase(() => []);

    await expect(createMcpStore(operator, database).findById(serverId)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(database.calls[0]?.values).toEqual([serverId, "space-1"]);
  });

  it("inserts a server scoped to the actor and refuses a taken name", async () => {
    const database = fakeDatabase(({ text }) => {
      if (text.startsWith("insert into mcp_server")) {
        throw Object.assign(new Error("duplicate key"), { code: "23505" });
      }

      return [];
    });

    const error = await createMcpStore(operator, database)
      .create({
        name: "issues",
        url: "https://mcp.example.invalid/mcp",
        auth: "none",
        credentialName: "mcp:issues",
      })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(NameConflictError);
    expect(database.calls[0]?.text).toContain("insert into mcp_server");
    expect(database.calls[0]?.values).toEqual([
      "space-1",
      "issues",
      "https://mcp.example.invalid/mcp",
      "none",
      "pending_authorization",
      "mcp:issues",
    ]);
  });

  it("maps an inserted server row", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("insert into mcp_server")
        ? [{ ...serverRow, status: "pending_authorization" }]
        : [],
    );

    const server = await createMcpStore(operator, database).create({
      name: "issues",
      url: "https://mcp.example.invalid/mcp",
      auth: "none",
      credentialName: "mcp:issues",
    });

    expect(server).toMatchObject({ id: serverId, name: "issues", status: "pending_authorization" });
  });

  it("updates status scoped to the space and refuses a miss", async () => {
    const updated = fakeDatabase(({ text }) =>
      text.startsWith("update mcp_server set status") ? [serverRow] : [],
    );

    await expect(
      createMcpStore(operator, updated).setStatus(serverId, "error", "the server refused"),
    ).resolves.toMatchObject({ id: serverId });
    expect(updated.calls[0]?.values).toEqual(["error", "the server refused", serverId, "space-1"]);

    const missing = fakeDatabase(() => []);

    await expect(
      createMcpStore(operator, missing).setStatus(serverId, "ready", null),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("replaces a server's tools through scoped statements", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isServerSelect(text)) {
        return [serverRow];
      }

      if (isToolInsert(text)) {
        return [{ id: "tool-1" }];
      }

      return [];
    });

    await createMcpStore(operator, database).replaceTools(serverId, [
      { name: "list_issues", description: "List.", parameters: { type: "object" } },
    ]);

    const remove = database.calls.find(({ text }) => isToolDelete(text));
    const insert = database.calls.find(({ text }) => isToolInsert(text));

    expect(remove?.text).toContain("where space_id = $1 and server_id = $2");
    expect(remove?.values).toEqual(["space-1", serverId]);
    expect(insert?.text).toContain("from mcp_server s");
    expect(insert?.values).toEqual([
      "space-1",
      serverId,
      "list_issues",
      "List.",
      '{"type":"object"}',
    ]);
  });

  it("refuses replaceTools for a server outside the space", async () => {
    const database = fakeDatabase(() => []);

    await expect(
      createMcpStore(operator, database).replaceTools(serverId, []),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(database.calls.filter(({ text }) => isToolDelete(text))).toEqual([]);
  });

  it("removes a server scoped to the space", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("delete from mcp_server") ? [{ id: serverId }] : [],
    );

    await createMcpStore(operator, database).remove(serverId);

    const remove = database.calls.find(({ text }) => text.startsWith("delete from mcp_server"));
    expect(remove?.values).toEqual([serverId, "space-1"]);
  });

  it("refuses removing a server that is not in the space", async () => {
    await expect(
      createMcpStore(
        operator,
        fakeDatabase(() => []),
      ).remove(serverId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("grants and revokes one attachment, both scoped", async () => {
    const grant = fakeDatabase(({ text }) =>
      text.startsWith("insert into bot_mcp_server") ? [{ id: "grant-1" }] : [],
    );

    await createMcpStore(operator, grant).grant(botId, serverId);

    expect(grant.calls[0]?.text).toContain("on conflict (space_id, bot_id, server_id)");
    expect(grant.calls[0]?.text).toContain("do update set revoked_at = null");
    expect(grant.calls[0]?.values).toEqual(["space-1", botId, serverId]);

    const revoke = fakeDatabase(({ text }) =>
      text.startsWith("update bot_mcp_server") ? [{ id: "grant-1" }] : [],
    );

    await createMcpStore(operator, revoke).revoke(botId, serverId);

    expect(revoke.calls[0]?.text).toContain("set revoked_at = now()");
    expect(revoke.calls[0]?.values).toEqual(["space-1", botId, serverId]);
  });

  it("refuses a grant or revoke that matched no scoped row", async () => {
    await expect(
      createMcpStore(
        operator,
        fakeDatabase(() => []),
      ).grant(botId, serverId),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      createMcpStore(
        operator,
        fakeDatabase(() => []),
      ).revoke(botId, serverId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists a server's grants after a scoped server read", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isServerSelect(text)) {
        return [serverRow];
      }

      return [{ botId, serverId, revokedAt: null }];
    });

    const grants = await createMcpStore(operator, database).listForServer(serverId);

    expect(grants).toEqual([{ botId, serverId, revokedAt: null }]);
    expect(database.calls[1]?.text).toContain("where space_id = $1 and server_id = $2");
  });
});

describe("the run's read half", () => {
  it("reads the granted servers and tools for one bot, scoped through the bot", async () => {
    const database = fakeDatabase(({ text }) => {
      if (text.startsWith("select id from bot")) {
        return [{ id: botId }];
      }

      return [
        { ...serverRow, toolName: "list_issues", toolDescription: "List.", toolParameters: {} },
      ];
    });

    const granted = await createMcpStore(worker, database).listGrantedForBot(botId);

    expect(granted).toHaveLength(1);
    expect(granted[0]?.server.id).toBe(serverId);
    expect(granted[0]?.tools[0]?.name).toBe("list_issues");

    const join = database.calls.find(({ text }) => text.includes("join bot_mcp_server"));
    expect(join?.text).toContain("g.revoked_at is null");
    expect(join?.text).toContain("s.status = 'ready'");
    expect(join?.values).toEqual(["space-1", botId]);
  });

  it("refuses a bot that is not in the job's space", async () => {
    await expect(
      createMcpStore(
        worker,
        fakeDatabase(() => []),
      ).listGrantedForBot(botId),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("answers whether the grant is live from one scoped read", async () => {
    const live = fakeDatabase(({ text }) =>
      text.includes("from bot_mcp_server g") ? [{ id: "grant-1" }] : [],
    );

    await expect(createMcpStore(worker, live).isGranted(botId, serverId)).resolves.toBe(true);
    expect(live.calls[0]?.values).toEqual(["space-1", botId, serverId]);

    const revoked = fakeDatabase(() => []);

    await expect(createMcpStore(worker, revoked).isGranted(botId, serverId)).resolves.toBe(false);
  });
});
