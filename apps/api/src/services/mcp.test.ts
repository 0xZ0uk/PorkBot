import { InProcessRealtimeFanout, McpServerEmulator } from "@porkbot/adapters";
import {
  BlockedUrlError,
  InvalidOAuthStateError,
  McpServerUnavailableError,
  NameConflictError,
  NotFoundError,
} from "@porkbot/effect";
import type {
  CredentialRotation,
  CredentialSummary,
  Credentials,
  McpGrantRecord,
  McpRunServers,
  McpServerRecord,
  McpServers,
  McpServerView,
  McpToolRecord,
  NewMcpServer,
} from "@porkbot/effect";
import type { OAuthStateBinding, OAuthStateStore, UserActor, UserRepositories } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createApiApp, serviceName } from "../app.ts";
import type { ApiServices } from "../app.ts";
import { createMcpService, mcpCallbackPath, mcpCredentialName } from "./mcp.ts";

/**
 * The MCP install and OAuth service (slice 9.5), over the real orchestration
 * and in-memory seam doubles: the scripted emulator provider, a one-time state
 * ledger and an actor-scoped registry. The acceptance criteria this suite
 * pins are the service's own: a URL that fails the URL-safety rules is refused
 * before anything is written, OAuth state is bound and single-use so a replayed
 * callback fails, discovery persists the tools, and the credential — client
 * secret or access token — is only ever visible through `resolve`.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const serverUrl = "https://mcp.example.invalid/mcp";
const callbackUrl = "https://api.example.invalid/oauth/mcp/callback";

const tools = [
  {
    name: "list_issues",
    description: "List open issues.",
    parameters: { type: "object", properties: { limit: { type: "integer" } } },
  },
] as const;

/** A one-time state ledger with the real seam's contract, in memory. */
function memoryStateStore(): OAuthStateStore & { readonly issued: readonly string[] } {
  const rows = new Map<string, { binding: OAuthStateBinding; consumed: boolean }>();
  const issued: string[] = [];

  return {
    issued,
    async issue({ actor, state }): Promise<boolean> {
      if (rows.has(state)) {
        return false;
      }

      rows.set(state, {
        binding: { spaceId: actor.spaceId, userId: actor.userId },
        consumed: false,
      });
      issued.push(state);

      return true;
    },
    async consume(state): Promise<OAuthStateBinding | undefined> {
      const row = rows.get(state);

      if (row === undefined || row.consumed) {
        return undefined;
      }

      row.consumed = true;

      return row.binding;
    },
  };
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface RegistryRow extends Mutable<McpServerRecord> {
  tools: McpToolRecord[];
}

/** The operator's registry and the run's read half, over one in-memory state. */
function memoryStore(): { readonly user: McpServers; readonly system: McpRunServers } {
  const servers = new Map<string, RegistryRow>();
  const grants = new Map<string, McpGrantRecord>();
  let nextId = 1;

  function scoped(id: string): RegistryRow {
    const row = servers.get(id);

    if (row === undefined) {
      throw new NotFoundError("mcp server", id);
    }

    return row;
  }

  function view(row: RegistryRow): McpServerView {
    return { ...row, tools: row.tools.map((tool) => ({ ...tool })) };
  }

  const user: McpServers = {
    async list() {
      return [...servers.values()].map(view);
    },
    async findById(id) {
      return view(scoped(id));
    },
    async create(input: NewMcpServer): Promise<McpServerRecord> {
      if ([...servers.values()].some((row) => row.name === input.name)) {
        throw new NameConflictError("MCP server", input.name);
      }

      const now = new Date();
      const row: RegistryRow = {
        // A UUID-shaped id, because the callback parses the server id out of
        // the state and the service refuses anything that cannot be one.
        id: `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`,
        name: input.name,
        url: input.url,
        auth: input.auth,
        status: "pending_authorization",
        credentialName: input.credentialName,
        lastError: null,
        createdAt: now,
        updatedAt: now,
        tools: [],
      };
      nextId += 1;
      servers.set(row.id, row);

      return { ...row };
    },
    async setStatus(id, status, lastError): Promise<McpServerRecord> {
      const row = scoped(id);
      row.status = status;
      row.lastError = lastError;
      row.updatedAt = new Date();

      return { ...row };
    },
    async replaceTools(id, nextTools): Promise<void> {
      scoped(id).tools = nextTools.map((tool) => ({ ...tool }));
    },
    async remove(id): Promise<void> {
      scoped(id);
      servers.delete(id);

      for (const [key, grant] of grants) {
        if (grant.serverId === id) {
          grants.delete(key);
        }
      }
    },
    async grant(botId, serverId): Promise<void> {
      scoped(serverId);
      grants.set(`${botId}:${serverId}`, { botId, serverId, revokedAt: null });
    },
    async revoke(botId, serverId): Promise<void> {
      const key = `${botId}:${serverId}`;

      if (!grants.has(key)) {
        throw new NotFoundError("mcp server grant", key);
      }

      grants.set(key, { botId, serverId, revokedAt: new Date() });
    },
    async listForServer(serverId) {
      scoped(serverId);

      return [...grants.values()].filter((grant) => grant.serverId === serverId);
    },
  };

  const system: McpRunServers = {
    async listGrantedForBot(botId) {
      return [...grants.values()]
        .filter((grant) => grant.botId === botId && grant.revokedAt === null)
        .map((grant) => {
          const { tools: rowTools, ...server } = scoped(grant.serverId);

          return { server: { ...server }, tools: rowTools.map((tool) => ({ ...tool })) };
        });
    },
    async isGranted(botId, serverId): Promise<boolean> {
      const grant = grants.get(`${botId}:${serverId}`);

      return grant !== undefined && grant.revokedAt === null;
    },
  };

  return { user, system };
}

/** The credential seam with the encrypted store's contract, in memory. */
function memoryCredentials(): Credentials & { readonly stored: Map<string, string> } {
  const stored = new Map<string, string>();

  return {
    stored,
    async resolve(name) {
      return stored.get(name);
    },
    async list(): Promise<readonly CredentialSummary[]> {
      return [...stored.keys()].map((name) => ({
        id: name,
        name,
        maskedValue: "••••",
        createdAt: new Date(),
        updatedAt: new Date(),
      }));
    },
    async store(name, value): Promise<CredentialSummary> {
      stored.set(name, value);

      return {
        id: name,
        name,
        maskedValue: "••••",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
    async remove(name): Promise<void> {
      stored.delete(name);
    },
    async rotate(): Promise<CredentialRotation> {
      return { activeKeyId: "k1", reencrypted: 0, total: stored.size };
    },
  };
}

interface Fixture {
  readonly service: ReturnType<typeof createMcpService>;
  readonly provider: McpServerEmulator;
  readonly store: ReturnType<typeof memoryStore>;
  readonly credentials: ReturnType<typeof memoryCredentials>;
  readonly state: ReturnType<typeof memoryStateStore>;
  readonly repositories: UserRepositories;
}

function fixture(): Fixture {
  const provider = new McpServerEmulator()
    .serve({ url: serverUrl, serverName: "issue-tracker", serverVersion: "2.0.0", tools })
    .answerTool("list_issues", { content: "issue #1" });
  const store = memoryStore();
  const credentials = memoryCredentials();
  const state = memoryStateStore();
  const repositories = { credentials, mcp: store.user } as unknown as UserRepositories;
  const service = createMcpService({
    provider,
    ingress: state,
    callbackUrl,
    resolveActorFromBinding: async () => owner,
    repositoriesFor: () => repositories,
  });

  return { service, provider, store, credentials, state, repositories };
}

function installInput(overrides: Record<string, unknown> = {}) {
  return {
    name: "issues",
    url: serverUrl,
    auth: "none" as const,
    ...overrides,
  };
}

async function startOAuth(f: Fixture): Promise<string> {
  f.provider.serveOAuth({});

  const result = await f.service.install(owner, f.repositories, {
    name: "oauth-issues",
    url: serverUrl,
    auth: "oauth",
    clientId: "porkbot-client",
    clientSecret: "client-secret",
  });

  return new URL(result.authorizationUrl ?? "").searchParams.get("state") ?? "";
}

describe("installing an MCP server", () => {
  it("discovers a public server's tools and marks it ready", async () => {
    const { service, store, repositories } = fixture();

    const result = await service.install(owner, repositories, installInput());

    expect(result.authorizationUrl).toBeNull();
    expect(result.server.status).toBe("ready");
    expect(result.server.tools).toEqual(tools);

    const listed = await store.user.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.tools).toEqual(tools);
  });

  it("refuses a non-HTTPS URL before any server row exists", async () => {
    const { service, store, repositories } = fixture();

    await expect(
      service.install(owner, repositories, installInput({ url: "http://mcp.example.invalid/mcp" })),
    ).rejects.toBeInstanceOf(BlockedUrlError);

    expect(await store.user.list()).toEqual([]);
  });

  it("refuses a loopback address before any server row exists", async () => {
    const { service, store, repositories } = fixture();

    await expect(
      service.install(owner, repositories, installInput({ url: "https://127.0.0.1/mcp" })),
    ).rejects.toBeInstanceOf(BlockedUrlError);

    expect(await store.user.list()).toEqual([]);
  });

  it("refuses a name already installed in the space", async () => {
    const { service, repositories } = fixture();

    await service.install(owner, repositories, installInput());

    await expect(service.install(owner, repositories, installInput())).rejects.toBeInstanceOf(
      NameConflictError,
    );
  });

  it("records a provider failure and answers the shared vocabulary", async () => {
    const { service, store, repositories } = fixture();

    const failing = await service
      .install(
        owner,
        repositories,
        installInput({ name: "gone", url: "https://missing.example.invalid/mcp" }),
      )
      .catch((error: unknown) => error);

    expect(failing).toBeInstanceOf(McpServerUnavailableError);
    expect((failing as McpServerUnavailableError).kind).toBe("not_found");

    const rows = await store.user.list();
    expect(rows.find((row) => row.name === "gone")?.status).toBe("error");
  });
});

describe("the OAuth flow", () => {
  it("stores the client secret, binds a one-time state and returns the consent URL", async () => {
    const f = fixture();
    const state = await startOAuth(f);

    expect(state).not.toBe("");
    expect(state.startsWith(`${(await f.store.user.list())[0]?.id}.`)).toBe(true);

    const stored = f.credentials.stored.get(mcpCredentialName("oauth-issues")) ?? "";
    expect(stored).toContain("client-secret");
    expect(f.provider.authorizations[0]?.redirectUri).toBe(callbackUrl);
  });

  it("exchanges the code, stores the token and discovers the tools", async () => {
    const f = fixture();
    const state = await startOAuth(f);

    const result = await f.service.completeAuthorization(state, "code-1");

    expect(result.server.status).toBe("ready");
    expect(result.server.tools).toEqual(tools);

    const stored = f.credentials.stored.get(mcpCredentialName("oauth-issues")) ?? "";
    expect(stored).toContain("emulator-access-token");
    expect(stored).toContain("client-secret");
    // The result shape has no field for either secret.
    expect(JSON.stringify(result)).not.toContain("emulator-access-token");
    expect(JSON.stringify(result)).not.toContain("client-secret");
  });

  it("refuses a replayed callback: the state is single-use", async () => {
    const f = fixture();
    const state = await startOAuth(f);

    await f.service.completeAuthorization(state, "code-1");

    const replay = await f.service
      .completeAuthorization(state, "code-1")
      .catch((error: unknown) => error);

    expect(replay).toBeInstanceOf(InvalidOAuthStateError);
    expect((replay as InvalidOAuthStateError).reason).toBe("unknown_or_used");
    expect(f.provider.exchanges).toHaveLength(1);
  });

  it("refuses a missing code without burning a valid state", async () => {
    const f = fixture();
    const state = await startOAuth(f);

    const missing = await f.service
      .completeAuthorization(state, undefined)
      .catch((error: unknown) => error);

    expect(missing).toBeInstanceOf(InvalidOAuthStateError);
    expect((missing as InvalidOAuthStateError).reason).toBe("missing_code");

    // A browser hiccup that drops the code must not kill the flow: the state
    // is still there for the callback that carries one.
    const after = await f.service.completeAuthorization(state, "code-1");

    expect(after.server.status).toBe("ready");
  });

  it("refuses an unknown state without touching a server", async () => {
    const f = fixture();
    await startOAuth(f);

    const unknown = await f.service
      .completeAuthorization("server-1.deadbeef", "code-1")
      .catch((error: unknown) => error);

    expect(unknown).toBeInstanceOf(InvalidOAuthStateError);
    expect((unknown as InvalidOAuthStateError).reason).toBe("unknown_or_used");
  });

  it("refuses a state whose membership is gone", async () => {
    const f = fixture();
    const state = await startOAuth(f);
    const service = createMcpService({
      provider: f.provider,
      ingress: f.state,
      callbackUrl,
      resolveActorFromBinding: async () => null,
      repositoriesFor: () => f.repositories,
    });

    const gone = await service
      .completeAuthorization(state, "code-1")
      .catch((error: unknown) => error);

    expect(gone).toBeInstanceOf(InvalidOAuthStateError);
    expect((gone as InvalidOAuthStateError).reason).toBe("actor_gone");
  });
});

describe("the callback route", () => {
  function appFor(service: ReturnType<typeof createMcpService>) {
    const services: ApiServices = {
      deployment: {
        async status() {
          return { kind: "open" } as const;
        },
        async ownership() {
          return { kind: "configured", ownerEmail: null } as const;
        },
      },
      realtime: new InProcessRealtimeFanout(),
      mcp: service,
    };

    return createApiApp({
      services,
      logger: createLogger({ service: serviceName, write: () => {} }),
    });
  }

  it("answers connected for a fresh state and 400 for a replay", async () => {
    const f = fixture();
    const state = await startOAuth(f);
    const app = appFor(f.service);

    const first = await app.request(
      `${mcpCallbackPath}?state=${encodeURIComponent(state)}&code=code-1`,
    );
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ status: "connected" });

    const replay = await app.request(
      `${mcpCallbackPath}?state=${encodeURIComponent(state)}&code=code-1`,
    );
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toEqual({ error: "BAD_REQUEST" });
  });

  it("answers 400 without a state", async () => {
    const f = fixture();
    await startOAuth(f);
    const app = appFor(f.service);

    const response = await app.request(`${mcpCallbackPath}?code=code-1`);

    expect(response.status).toBe(400);
  });
});
