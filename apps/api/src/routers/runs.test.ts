import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient, ORPCError } from "@porkbot/contracts";
import type { RunRecord, UserActor, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceName } from "../app.ts";
import type { ApiServices } from "../app.ts";
import { createApiServer } from "../server.ts";

/**
 * The run control surface through the real transport (slice 6.7, story 21).
 *
 * What this suite proves is the shape the acceptance criteria name: a stop
 * records the durable request and answers with the run's state, a second click
 * is the same answer rather than a second effect, a run that already finished
 * answers with its terminal state instead of an error, a run outside the
 * actor's space is the shared typed `NOT_FOUND`, and a request without a
 * session is refused before the handler.
 *
 * The repositories are an in-memory stand-in for the actor-scoped layer; the
 * SQL they translate to is proven against Postgres in `@porkbot/db`'s suite.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };

const runs = new Map<string, RunRecord>();
let sessionActor: UserActor | null = owner;

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    userId: "user-1",
    status: "running",
    trigger: "message",
    error: null,
    errorCode: null,
    leaseOwner: "job-1",
    leaseFence: 1,
    leaseExpiresAt: new Date(120_000),
    stopRequestedAt: null,
    checkpoint: {},
    clientNonce: "nonce-1",
    sourceMessageId: null,
    startedAt: new Date(0),
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the runs suite");
  };

  return {
    actor,
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
      findById: async (id) => {
        const run = runs.get(id);

        if (run === undefined || run.spaceId !== actor.spaceId) {
          throw new NotFoundError("run", id);
        }

        return run;
      },
      listForThread: notExercised,
      findActiveForThread: notExercised,
      create: notExercised,
      requestStop: async (id) => {
        const run = runs.get(id);

        if (run === undefined || run.spaceId !== actor.spaceId) {
          throw new NotFoundError("run", id);
        }

        if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
          return run;
        }

        const marked: RunRecord = {
          ...run,
          stopRequestedAt: run.stopRequestedAt ?? new Date("2026-01-01T00:00:00.000Z"),
          updatedAt: new Date(),
        };
        runs.set(id, marked);

        return marked;
      },
    },
    events: { listAfter: notExercised },
    toolResults: { read: notExercised },
    messages: {
      listForThread: notExercised,
      findByNonce: notExercised,
      steer: notExercised,
    },
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
  };
}

const services: ApiServices = {
  deployment: {
    async status() {
      return { kind: "open" } as const;
    },
  },
  realtime: new InProcessRealtimeFanout(),
};

const logger = createLogger({ service: serviceName, write: () => {} });
const server = createApiServer({
  services,
  logger,
  resolveActor: async () => sessionActor,
  repositoriesFor,
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

function client() {
  return createApiClient({ url: `${baseUrl}/rpc` });
}

describe("the run stop surface", () => {
  it("records the request on a live run and answers with the run's state", async () => {
    runs.clear();
    sessionActor = owner;
    runs.set("run-1", runRecord());

    const stopped = await client().runs.stop({ runId: "run-1" });

    expect(stopped).toEqual({
      id: "run-1",
      status: "running",
      stopRequestedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(runs.get("run-1")?.stopRequestedAt).toBeInstanceOf(Date);
  });

  it("keeps the first instant under a double click", async () => {
    runs.clear();
    sessionActor = owner;
    runs.set("run-1", runRecord());

    const first = await client().runs.stop({ runId: "run-1" });
    const second = await client().runs.stop({ runId: "run-1" });

    expect(second).toEqual(first);
  });

  it("answers a run that already finished with its terminal state, not an error", async () => {
    runs.clear();
    sessionActor = owner;
    runs.set("run-1", runRecord({ status: "cancelled", completedAt: new Date(1) }));

    const stopped = await client().runs.stop({ runId: "run-1" });

    expect(stopped).toEqual({ id: "run-1", status: "cancelled", stopRequestedAt: null });
  });

  it("reports a run outside the actor's space as the shared typed not-found", async () => {
    runs.clear();
    sessionActor = owner;
    runs.set("run-foreign", runRecord({ id: "run-foreign", spaceId: "space-2" }));

    await expect(client().runs.stop({ runId: "run-foreign" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("answers the typed 401 without a session", async () => {
    runs.clear();
    sessionActor = null;

    const error = await client()
      .runs.stop({ runId: "run-1" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
  });
});
