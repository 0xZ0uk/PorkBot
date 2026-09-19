import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ORPCError, call } from "@orpc/server";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient } from "@porkbot/contracts";
import type { AppClient } from "@porkbot/contracts";
import { NotFoundError } from "@porkbot/effect";
import type { BotRecord, UserActor, UserRepositories } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { afterAll, beforeAll, beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { createApiApp, rpcPath, serviceName } from "./app.ts";
import type { ApiServices } from "./app.ts";
import { authenticated, publicOnly } from "./gate.ts";
import type { ProcedureContext } from "./gate.ts";
import { clientPrincipal, createRateLimits, resolveLimits, routeRules } from "./limits.ts";
import { createApiServer } from "./server.ts";
import type { DeploymentStatus } from "./services/deployment.ts";

/**
 * The gate's behaviour over the real HTTP surface and through the real typed
 * client: authenticated is the default, the public marker is checked, the
 * handler's repository comes from the actor, and a by-id read outside the
 * actor's space is a not-found. The types are checked too — the handler
 * context has no raw space id and the client cannot send one — because the
 * PRD's "authorization as structure" only holds if the compiler can see it.
 */

const lines: string[] = [];
const logger: Logger = createLogger({
  service: serviceName,
  write: (line) => lines.push(line),
});

const services: ApiServices = {
  deployment: {
    async status(): Promise<DeploymentStatus> {
      return { kind: "open" };
    },
  },
  realtime: new InProcessRealtimeFanout(),
};

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };

const bot: BotRecord = {
  id: "bot-1",
  spaceId: "space-1",
  userId: "user-1",
  name: "Ada",
  title: "Researcher",
  description: "",
  instructions: "Be useful",
  color: "#4f46e5",
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  spawnKey: "spawn-1",
  avatarKey: null,
  computerId: null,
  computerProvider: null,
  modelConnectionId: null,
  model: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
};

/** The reads and fakes the gate composes; reset before every test. */
let actor: UserActor | null = null;
let sessionFailure: Error | undefined;
let sessionReads = 0;
let repositoryActors: UserActor[] = [];

function fakeRepositories(forActor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the gate suite");
  };

  return {
    actor: forActor,
    membership: { requireActive: notExercised },
    bots: {
      async findById(id: string): Promise<BotRecord> {
        if (bot.id !== id || bot.spaceId !== forActor.spaceId) {
          throw new NotFoundError("bot", id);
        }

        return bot;
      },
      async list(): Promise<readonly BotRecord[]> {
        return bot.spaceId === forActor.spaceId ? [bot] : [];
      },
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
      async findById(id: string): Promise<never> {
        throw new NotFoundError("thread", id);
      },
      async listForBot(): Promise<never[]> {
        return [];
      },
      createForBot: notExercised,
      clear: notExercised,
    },
    runs: {
      async findById(id: string): Promise<never> {
        throw new NotFoundError("run", id);
      },
      async listForThread(): Promise<never[]> {
        return [];
      },
      async findActiveForThread(): Promise<undefined> {
        return undefined;
      },
      create: notExercised,
      requestStop: notExercised,
    },
    events: {
      async listAfter(): Promise<never[]> {
        return [];
      },
    },
    messages: {
      async listForThread(): Promise<never[]> {
        return [];
      },
      async findByNonce(): Promise<undefined> {
        return undefined;
      },
      steer: notExercised,
    },
    files: {
      createAttachment: notExercised,
      findAttachments: notExercised,
      findStoredFile: notExercised,
    },
    computerSnapshots: { create: notExercised, findById: notExercised, listForBot: notExercised },
    toolResults: { read: notExercised },
    routines: {
      async findById(id: string): Promise<never> {
        throw new NotFoundError("routine", id);
      },
      async list(): Promise<never[]> {
        return [];
      },
      async listForBot(): Promise<never[]> {
        return [];
      },
      async outcomes(): Promise<never[]> {
        return [];
      },
      async lastOutcome(): Promise<undefined> {
        return undefined;
      },
      preview: notExercised,
      create: notExercised,
      update: notExercised,
      remove: notExercised,
      testRun: notExercised,
    },
    notifications: {
      read: notExercised,
      set: notExercised,
    },
    credentials: {
      resolve: notExercised,
      list: notExercised,
      store: notExercised,
      rotate: notExercised,
      remove: notExercised,
    },
    mcp: {
      list: notExercised,
      findById: notExercised,
      create: notExercised,
      setStatus: notExercised,
      replaceTools: notExercised,
      remove: notExercised,
      grant: notExercised,
      revoke: notExercised,
      listForServer: notExercised,
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
    usage: { forBot: notExercised },
  };
}

const server = createApiServer({
  services,
  logger,
  resolveActor: async () => {
    sessionReads += 1;

    if (sessionFailure !== undefined) {
      throw sessionFailure;
    }

    return actor;
  },
  repositoriesFor: (forActor) => {
    repositoryActors.push(forActor);

    return fakeRepositories(forActor);
  },
});
let client: AppClient;
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
  client = createApiClient({ url: `${baseUrl}/rpc` });
});

beforeEach(() => {
  lines.length = 0;
  actor = null;
  sessionFailure = undefined;
  sessionReads = 0;
  repositoryActors = [];
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

function records(): Record<string, unknown>[] {
  return lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
}

describe("authenticated by default", () => {
  it("answers an anonymous request with the procedure's typed 401", async () => {
    const error = await client.account.me().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
    expect(repositoryActors).toEqual([]);
    expect(sessionReads).toBe(1);
  });

  it("hands the handler the actor the session resolved to", async () => {
    actor = owner;

    await expect(client.account.me()).resolves.toEqual({
      spaceId: "space-1",
      userId: "user-1",
      role: "owner",
    });

    expect(repositoryActors).toEqual([owner]);
    expect(sessionReads).toBe(1);
  });

  it("fetches a bot by id inside the actor's scope and returns no tenant id", async () => {
    actor = owner;

    const body = await client.bots.get({ id: "bot-1" });

    expect(body).toEqual({
      id: "bot-1",
      name: "Ada",
      title: "Researcher",
      description: "",
      instructions: "Be useful",
      color: "#4f46e5",
      pinned: false,
      position: 0,
      sectionId: null,
      avatarKey: null,
      computerId: null,
      computerProvider: null,
      modelConnectionId: null,
      model: null,
      archivedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(Object.keys(body)).not.toContain("spaceId");
    expect(Object.keys(body)).not.toContain("userId");
    expect(repositoryActors).toEqual([owner]);
  });

  it("answers a bot in another space as not-found, never as forbidden", async () => {
    actor = { kind: "user", spaceId: "space-2", userId: "user-2", role: "member" };

    const error = await client.bots.get({ id: bot.id }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, defined: true });
  });

  it("answers a failing session read as a defect, never as anonymous", async () => {
    sessionFailure = new Error("the session store is unreachable");

    const error = await client.account.me().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500, defined: false });
    expect(repositoryActors).toEqual([]);

    const failure = records().find((record) => record["msg"] === "request failed");

    expect(failure).toMatchObject({ level: "error" });
  });

  it("keeps the public procedure public and the rest closed without a resolver", async () => {
    const closed = createApiApp({ services, logger });

    const status = await closed.request("/rpc/deployment/status", { method: "POST" });
    const me = await closed.request("/rpc/account/me", { method: "POST" });

    expect(status.status).toBe(200);
    expect(me.status).toBe(401);
  });
});

describe("the registration path", () => {
  const context: ProcedureContext = {
    logger,
    requestId: "test-request",
    actor: null,
    repositories: null,
    principal: clientPrincipal("test-client"),
    limits: createRateLimits(resolveLimits(), routeRules(rpcPath)),
    responseHeaders: new Headers(),
  };

  it("refuses a public procedure registered on the authenticated path", async () => {
    const status = authenticated.deployment.status.handler(() => ({ signups: "open" }));

    await expect(call(status, undefined, { context })).rejects.toThrow(/misregistered/);
  });

  it("refuses an authenticated procedure registered on the public path", async () => {
    const me = publicOnly.account.me.handler(() => ({
      spaceId: "space-1",
      userId: "user-1",
      role: "owner",
    }));

    await expect(call(me, undefined, { context })).rejects.toThrow(/misregistered/);
  });

  it("runs the public procedure without an actor on the public path", async () => {
    const status = publicOnly.deployment.status.handler(() => ({ signups: "open" }));

    await expect(call(status, undefined, { context })).resolves.toEqual({ signups: "open" });
  });
});

describe("the type of a handler's scope", () => {
  it("narrows actor and repositories to non-null for an authenticated handler", () => {
    type AccountHandlerContext = Parameters<
      Parameters<typeof authenticated.account.me.handler>[0]
    >[0]["context"];

    expectTypeOf<AccountHandlerContext["actor"]>().toEqualTypeOf<UserActor>();
    expectTypeOf<AccountHandlerContext["repositories"]>().toEqualTypeOf<UserRepositories>();
  });

  it("carries no raw space id in the procedure context", () => {
    function rejectedTenantRead(context: ProcedureContext): unknown {
      // @ts-expect-error -- the context carries an Actor, never a raw space id.
      return context.spaceId;
    }

    expect(rejectedTenantRead).toBeTypeOf("function");
  });

  it("takes no space id in an authenticated input", () => {
    function rejectedTenantInput(client: AppClient): Promise<unknown> {
      // @ts-expect-error -- bots.get takes the bot id, never a space id.
      return client.bots.get({ id: "bot-1", spaceId: "space-1" });
    }

    expect(rejectedTenantInput).toBeTypeOf("function");
  });
});

describe("one session read", () => {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url));

  function sourceFiles(directory: string): readonly string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        return sourceFiles(full);
      }

      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
        return [];
      }

      return [full];
    });
  }

  it("calls the session resolver in exactly one file", () => {
    const readers = sourceFiles(sourceDir)
      .filter((file) => /resolveActor\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(sourceDir, file))
      .sort();

    expect(readers).toEqual(["gate.ts"]);
  });

  it("never reads a session outside @porkbot/auth", () => {
    const readers = sourceFiles(sourceDir).filter((file) =>
      /getSession\s*\(/.test(readFileSync(file, "utf8")),
    );

    expect(readers).toEqual([]);
  });
});
