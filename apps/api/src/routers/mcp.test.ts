import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient, ORPCError } from "@porkbot/contracts";
import { NotFoundError } from "@porkbot/effect";
import type { McpServerView } from "@porkbot/effect";
import type { UserActor, UserRepositories } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiServices } from "../app.ts";
import { createApiServer, serviceName } from "../server.ts";
import type { McpService } from "../services/mcp.ts";

/**
 * The MCP server registry surface through the real transport: the typed client
 * reads summaries and details, install delegates to the service, remove drops
 * the credential before the row, and grant/revoke name a bot and a server and
 * nothing else. The responses are checked for the one thing the schema must
 * never carry: the credential row's name or a token.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const botId = "00000000-0000-4000-8000-0000000000b1";
const now = new Date("2026-09-18T10:00:00.000Z");

function view(overrides: Partial<McpServerView> = {}): McpServerView {
  return {
    id: "server-1",
    name: "issues",
    url: "https://mcp.example.invalid/mcp",
    auth: "none",
    status: "ready",
    credentialName: "mcp:issues",
    lastError: null,
    createdAt: now,
    updatedAt: now,
    tools: [
      {
        name: "list_issues",
        description: "List open issues.",
        parameters: { type: "object" },
      },
    ],
    ...overrides,
  };
}

interface Calls {
  readonly order: string[];
}

function fakeRepositories(calls: Calls): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the MCP surface suite");
  };

  return {
    actor: owner,
    membership: { requireActive: notExercised },
    bots: {
      findById: notExercised,
      list: notExercised,
      create: notExercised,
      update: notExercised,
      archive: notExercised,
      restore: notExercised,
      delete: notExercised,
      setAvatar: notExercised,
    },
    sections: {
      list: notExercised,
      create: notExercised,
      update: notExercised,
      delete: notExercised,
    },
    threads: {
      findById: notExercised,
      listForBot: notExercised,
      createForBot: notExercised,
      clear: notExercised,
    },
    runs: {
      findById: notExercised,
      listForThread: notExercised,
      findActiveForThread: notExercised,
      create: notExercised,
      requestStop: notExercised,
    },
    events: { listAfter: notExercised },
    messages: {
      listForThread: notExercised,
      findByNonce: notExercised,
      steer: notExercised,
    },
    computerSnapshots: { create: notExercised, findById: notExercised, listForBot: notExercised },
    toolResults: { read: notExercised },
    routines: {
      findById: notExercised,
      list: notExercised,
      listForBot: notExercised,
      outcomes: notExercised,
      lastOutcome: notExercised,
      preview: notExercised,
      create: notExercised,
      update: notExercised,
      remove: notExercised,
      testRun: notExercised,
    },
    notifications: { read: notExercised, set: notExercised },
    credentials: {
      resolve: notExercised,
      list: notExercised,
      store: notExercised,
      rotate: notExercised,
      remove: vi.fn(async (name: string) => {
        calls.order.push(`credentials.remove:${name}`);
      }),
    },
    modelConnections: {
      findById: notExercised,
      list: notExercised,
      create: notExercised,
      update: notExercised,
      setDefault: notExercised,
      delete: notExercised,
    },
    memory: {
      list: notExercised,
      find: notExercised,
      listDeleted: notExercised,
      revisions: notExercised,
      write: notExercised,
      restore: notExercised,
    },
    mcp: {
      list: vi.fn(async () => [view()]),
      findById: vi.fn(async (id: string) => {
        if (id === "missing") {
          throw new NotFoundError("mcp server", id);
        }

        return view();
      }),
      create: vi.fn(async () => view()),
      setStatus: vi.fn(async () => view()),
      replaceTools: vi.fn(async () => undefined),
      remove: vi.fn(async (id: string) => {
        calls.order.push(`mcp.remove:${id}`);
      }),
      grant: vi.fn(async (grantedBotId: string, serverId: string) => {
        calls.order.push(`mcp.grant:${grantedBotId}:${serverId}`);
      }),
      revoke: vi.fn(async (revokedBotId: string, serverId: string) => {
        calls.order.push(`mcp.revoke:${revokedBotId}:${serverId}`);
      }),
      listForServer: vi.fn(async () => [{ botId, serverId: "server-1", revokedAt: null }]),
    },
  };
}

const calls: Calls = { order: [] };
const repositories = fakeRepositories(calls);

const install = vi.fn(async () => ({ server: view(), authorizationUrl: null }));
const service: McpService = {
  install,
  async completeAuthorization() {
    return { server: view() };
  },
};

const services: ApiServices = {
  deployment: {
    async status() {
      return { kind: "open" } as const;
    },
  },
  realtime: new InProcessRealtimeFanout(),
  mcp: service,
};

const lines: string[] = [];
const logger = createLogger({ service: serviceName, write: (line) => lines.push(line) });
let sessionActor: UserActor | null = owner;

const server = createApiServer({
  services,
  logger,
  resolveActor: async () => sessionActor,
  repositoriesFor: () => repositories,
});

let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("the MCP server surface", () => {
  it("lists summaries with a tool count and never the credential name", async () => {
    sessionActor = owner;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const answer = await client.mcpServers.list();

    expect(answer.servers).toEqual([
      {
        id: "server-1",
        name: "issues",
        url: "https://mcp.example.invalid/mcp",
        auth: "none",
        status: "ready",
        lastError: null,
        createdAt: "2026-09-18T10:00:00.000Z",
        updatedAt: "2026-09-18T10:00:00.000Z",
        toolCount: 1,
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain("credentialName");
    expect(JSON.stringify(answer)).not.toContain("mcp:issues");
  });

  it("reads one server's tools", async () => {
    sessionActor = owner;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const answer = await client.mcpServers.get({ id: "server-1" });

    expect(answer.server.tools).toEqual([
      { name: "list_issues", description: "List open issues.", parameters: { type: "object" } },
    ]);
  });

  it("answers the typed 404 for a server the actor cannot see", async () => {
    sessionActor = owner;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.mcpServers.get({ id: "missing" }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, defined: true });
  });

  it("installs through the service and returns the consent URL when there is one", async () => {
    sessionActor = owner;
    calls.order.length = 0;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const answer = await client.mcpServers.create({
      name: "issues",
      url: "https://mcp.example.invalid/mcp",
      auth: "none",
    });

    expect(install).toHaveBeenCalledWith(
      owner,
      repositories,
      expect.objectContaining({ name: "issues", auth: "none" }),
    );
    expect(answer.authorizationUrl).toBeNull();
    expect(JSON.stringify(answer)).not.toContain("credentialName");
  });

  it("removes the credential before the server row", async () => {
    sessionActor = owner;
    calls.order.length = 0;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const answer = await client.mcpServers.remove({ id: "server-1" });

    expect(answer).toEqual({ id: "server-1" });
    expect(calls.order).toEqual(["credentials.remove:mcp:issues", "mcp.remove:server-1"]);
  });

  it("lists, grants and revokes a bot's attachment", async () => {
    sessionActor = owner;
    calls.order.length = 0;

    const client = createApiClient({ url: `${baseUrl}/rpc` });

    const grants = await client.mcpServers.grants({ id: "server-1" });
    expect(grants.grants).toEqual([{ botId, revokedAt: null }]);

    await expect(client.mcpServers.grant({ id: "server-1", botId })).resolves.toEqual({
      serverId: "server-1",
      botId,
    });
    await expect(client.mcpServers.revoke({ id: "server-1", botId })).resolves.toEqual({
      serverId: "server-1",
      botId,
    });

    expect(calls.order).toEqual([`mcp.grant:${botId}:server-1`, `mcp.revoke:${botId}:server-1`]);
  });

  it("answers the typed 401 without a session", async () => {
    sessionActor = null;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.mcpServers.list().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
  });
});
