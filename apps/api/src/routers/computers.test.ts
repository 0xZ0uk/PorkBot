import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { InProcessRealtimeFanout, createSupervisorComputerProvider } from "@porkbot/adapters";
import { createApiClient } from "@porkbot/contracts";
import type { BotRecord, UserActor, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceName } from "../app.ts";
import { createApiServer } from "../server.ts";

/**
 * The computer surface through the real transport, with a scripted supervisor
 * on the other side.
 *
 * This suite proves the API's half of the boundary: the bot is read in the
 * actor's scope, the computer reference is built from the row and not from
 * input, a bot with no assignment is a normal answer for a read and the typed
 * `NOT_FOUND` for a lifecycle call, and a classified provider refusal arrives
 * as the contract's `SERVICE_UNAVAILABLE`. The supervisor's own half — the
 * protocol, the lifecycle, the isolation — is proven in `@porkbot/supervisor`,
 * including the conformance suite over the same wire.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const assignedBotId = "bot-assigned";
const unassignedBotId = "bot-unassigned";
const computerId = "computer-1";
/** The per-bot provider selection the fixture row reports; null is the default. */
let assignedProvider: string | null = null;

let sessionActor: UserActor | null = owner;
const recorded: { readonly path: string; readonly body: unknown }[] = [];
let failNextWith:
  { readonly status: number; readonly kind: string; readonly message: string } | undefined;

function botWith(computer: string | null): BotRecord {
  return {
    id: assignedBotId,
    spaceId: owner.spaceId,
    userId: owner.userId,
    name: "Ada",
    title: "",
    description: "",
    instructions: "",
    color: "#4f46e5",
    pinned: false,
    position: 0,
    sectionId: null,
    archivedAt: null,
    spawnKey: "00000000-0000-4000-8000-000000000000",
    avatarKey: null,
    computerId: computer,
    computerProvider: assignedProvider,
    modelConnectionId: null,
    model: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the computers suite");
  };

  return {
    actor,
    membership: { requireActive: notExercised },
    bots: {
      findById: async (id: string): Promise<BotRecord> => {
        if (id === assignedBotId) {
          return botWith(computerId);
        }

        if (id === unassignedBotId) {
          return { ...botWith(null), id: unassignedBotId };
        }

        // A bot in another space is indistinguishable from one that does not
        // exist, which is the scoped read's contract.
        throw new NotFoundError("bot", id);
      },
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
    messages: { listForThread: notExercised, findByNonce: notExercised, steer: notExercised },
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
    toolResults: { read: notExercised },
  };
}

/** The supervisor's wire, scripted: every answer is the client's own vocabulary. */
const supervisorServer: Server = createServer(
  (request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      recorded.push({
        path: request.url ?? "",
        body: raw === "" ? undefined : JSON.parse(raw),
      });

      if (failNextWith !== undefined) {
        const failure = failNextWith;
        failNextWith = undefined;
        response.writeHead(failure.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { kind: failure.kind, message: failure.message } }));
        return;
      }

      const state = (request.url ?? "").endsWith("/status") ? "gone" : "running";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          status: { computer: { computerId, botId: assignedBotId }, state, instanceId: "i-1" },
        }),
      );
    });
  },
);

const logger = createLogger({ service: serviceName, write: () => {} });
let apiServer: ReturnType<typeof createApiServer>;
let baseUrl = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    supervisorServer.listen(0, "127.0.0.1", resolve);
  });

  const supervisorAddress = supervisorServer.address();

  if (supervisorAddress === null || typeof supervisorAddress === "string") {
    throw new Error("the scripted supervisor did not bind a TCP port");
  }

  const supervisorOrigin = `http://127.0.0.1:${supervisorAddress.port}`;

  apiServer = createApiServer({
    services: {
      deployment: {
        async status() {
          return { kind: "open" } as const;
        },
      },
      realtime: new InProcessRealtimeFanout(),
      computers: createSupervisorComputerProvider({
        baseUrl: supervisorOrigin,
        token: "supervisor-token",
      }),
    },
    logger,
    resolveActor: async () => sessionActor,
    repositoriesFor,
  });

  await new Promise<void>((resolve) => {
    apiServer.listen(0, "127.0.0.1", resolve);
  });

  const address = apiServer.address();

  if (address === null || typeof address === "string") {
    throw new Error("the api test server did not bind a TCP port");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    apiServer.close((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    supervisorServer.close((error) => (error ? reject(error) : resolve()));
  });
});

function client() {
  return createApiClient({ url: `${baseUrl}/rpc` });
}

describe("the computer lifecycle surface", () => {
  it("reads the bot's computer through the supervisor", async () => {
    sessionActor = owner;
    recorded.length = 0;

    await expect(client().computers.status({ botId: assignedBotId })).resolves.toEqual({
      assigned: true,
      state: "gone",
      instanceId: "i-1",
    });
    // The reference is built from the row, not from input.
    expect(recorded).toEqual([
      {
        path: "/v1/computers/status",
        body: { computer: { computerId, botId: assignedBotId } },
      },
    ]);
  });

  it("carries the bot's provider selection to the supervisor", async () => {
    sessionActor = owner;
    recorded.length = 0;
    assignedProvider = "daytona";

    try {
      await client().computers.status({ botId: assignedBotId });
    } finally {
      assignedProvider = null;
    }

    expect(recorded).toEqual([
      {
        path: "/v1/computers/status",
        body: { computer: { computerId, botId: assignedBotId, provider: "daytona" } },
      },
    ]);
  });

  it("boots, stops, resets and recovers through the supervisor", async () => {
    sessionActor = owner;
    recorded.length = 0;

    await expect(client().computers.boot({ botId: assignedBotId })).resolves.toMatchObject({
      assigned: true,
      state: "running",
    });
    await expect(client().computers.stop({ botId: assignedBotId })).resolves.toMatchObject({
      state: "running",
    });
    await expect(client().computers.reset({ botId: assignedBotId })).resolves.toMatchObject({
      state: "running",
    });
    await expect(client().computers.recover({ botId: assignedBotId })).resolves.toMatchObject({
      state: "running",
    });

    expect(recorded.map((request) => request.path)).toEqual([
      "/v1/computers/ensure",
      "/v1/computers/stop",
      "/v1/computers/reset",
      "/v1/computers/recover",
    ]);
  });

  it("answers an unassigned bot without dialing the supervisor, and refuses a lifecycle call", async () => {
    sessionActor = owner;
    recorded.length = 0;

    await expect(client().computers.status({ botId: unassignedBotId })).resolves.toEqual({
      assigned: false,
    });

    await expect(client().computers.boot({ botId: unassignedBotId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(recorded).toEqual([]);
  });

  it("answers a bot outside the actor's space as not found", async () => {
    sessionActor = owner;

    await expect(client().computers.status({ botId: "someone-elses-bot" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("translates a classified refusal into the contract's service unavailable", async () => {
    sessionActor = owner;
    failNextWith = { status: 429, kind: "rate_limited", message: "the daemon is busy" };

    await expect(client().computers.boot({ botId: assignedBotId })).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
  });

  it("refuses every computer call without a session", async () => {
    sessionActor = null;

    await expect(client().computers.status({ botId: assignedBotId })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
