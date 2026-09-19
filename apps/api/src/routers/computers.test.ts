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

/** The snapshot fixtures: the row a restore names and the capture a snapshot answers. */
const snapshotRowId = "11111111-1111-4111-8111-111111111111";
const storedSnapshotId = "22222222-2222-4222-8222-222222222222";
const storedStorageKey = `computer-snapshots/0123456789abcdef/${storedSnapshotId}.tar`;
const storedChecksum = "a".repeat(64);
let snapshotRowOwner = assignedBotId;
let capturedSnapshots = 0;

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
    usage: { forBot: notExercised },
    computerSnapshots: {
      create: async (input) => {
        if (input.botId !== assignedBotId) {
          throw new NotFoundError("bot", input.botId);
        }

        return {
          id: snapshotRowId,
          botId: input.botId,
          snapshotId: input.snapshotId,
          storageKey: input.storageKey,
          sizeBytes: input.sizeBytes,
          checksum: input.checksum,
          createdAt: new Date(0),
        };
      },
      findById: async (id: string) => {
        if (id !== snapshotRowId) {
          throw new NotFoundError("snapshot", id);
        }

        return {
          id: snapshotRowId,
          botId: snapshotRowOwner,
          snapshotId: storedSnapshotId,
          storageKey: storedStorageKey,
          sizeBytes: 5,
          checksum: storedChecksum,
          createdAt: new Date(0),
        };
      },
      listForBot: async (botId: string) => {
        if (botId !== assignedBotId) {
          throw new NotFoundError("bot", botId);
        }

        return [];
      },
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

      if ((request.url ?? "").endsWith("/snapshot")) {
        capturedSnapshots += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            snapshot: {
              snapshotId: storedSnapshotId,
              key: storedStorageKey,
              size: 5,
              checksum: storedChecksum,
            },
          }),
        );
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

/**
 * The recovery surface (slice 7.5): a capture is dialed and recorded in the
 * actor's space, a list names what is recoverable, and a restore resolves the
 * row before the supervisor ever sees a storage key. A snapshot that belongs to
 * another bot, another space or another state of the world is the typed
 * `NOT_FOUND` with the supervisor untouched.
 */
describe("the snapshot surface", () => {
  it("captures through the supervisor and records the row in the actor's space", async () => {
    sessionActor = owner;
    recorded.length = 0;
    capturedSnapshots = 0;

    await expect(client().computers.snapshot({ botId: assignedBotId })).resolves.toEqual({
      id: snapshotRowId,
      createdAt: new Date(0).toISOString(),
      sizeBytes: 5,
    });
    expect(capturedSnapshots).toBe(1);
    expect(recorded).toEqual([
      {
        path: "/v1/computers/snapshot",
        body: { computer: { computerId, botId: assignedBotId } },
      },
    ]);
  });

  it("lists the bot's snapshots", async () => {
    sessionActor = owner;

    await expect(client().computers.snapshots({ botId: assignedBotId })).resolves.toEqual({
      snapshots: [],
    });
  });

  it("restores a recorded snapshot, carrying its handle to the supervisor", async () => {
    sessionActor = owner;
    recorded.length = 0;
    snapshotRowOwner = assignedBotId;

    await expect(
      client().computers.restore({ botId: assignedBotId, snapshotId: snapshotRowId }),
    ).resolves.toMatchObject({ assigned: true, state: "running" });
    expect(recorded).toEqual([
      {
        path: "/v1/computers/restore",
        body: {
          computer: { computerId, botId: assignedBotId },
          snapshot: {
            snapshotId: storedSnapshotId,
            key: storedStorageKey,
            size: 5,
            checksum: storedChecksum,
          },
        },
      },
    ]);
  });

  it("refuses a snapshot that belongs to another bot without dialing", async () => {
    sessionActor = owner;
    recorded.length = 0;
    snapshotRowOwner = "bot-other";

    await expect(
      client().computers.restore({ botId: assignedBotId, snapshotId: snapshotRowId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(recorded).toEqual([]);
  });

  it("answers a snapshot outside the actor's space as not found", async () => {
    sessionActor = owner;

    await expect(
      client().computers.restore({
        botId: assignedBotId,
        snapshotId: "33333333-3333-4333-8333-333333333333",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers a missing or altered archive as not found, not as unreachable", async () => {
    sessionActor = owner;
    snapshotRowOwner = assignedBotId;
    failNextWith = {
      status: 404,
      kind: "not_found",
      message: "the snapshot is not the archive that was captured",
    };

    await expect(
      client().computers.restore({ botId: assignedBotId, snapshotId: snapshotRowId }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses a capture for an unassigned bot without dialing", async () => {
    sessionActor = owner;
    recorded.length = 0;

    await expect(client().computers.snapshot({ botId: unassignedBotId })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(recorded).toEqual([]);
  });
});
