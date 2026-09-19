import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient, ORPCError } from "@porkbot/contracts";
import type { UsageSummary, UserActor, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceName } from "../app.ts";
import type { ApiServices } from "../app.ts";
import { createApiServer } from "../server.ts";

/**
 * The usage read through the real transport (slice 8.8, story 34).
 *
 * This suite proves the contract's shape rather than the SQL: null token
 * figures stay null (the "not reported" answer, never a zero), UTC days are
 * ISO instants, a foreign bot is the shared typed `NOT_FOUND`, and the window
 * begins at UTC midnight so the screen's days are whole days. The aggregates
 * themselves are proven against Postgres in `@porkbot/db`.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };

let sessionActor: UserActor | null = owner;
const sinceCalls: Date[] = [];

/** The summary the stub answers with; tests swap it per case. */
let summary: UsageSummary = {
  total: { inputTokens: null, outputTokens: null, reported: 0, unreported: 0 },
  periods: [],
};

/** Bots the stub knows; anything else is the scoped not-found. */
const knownBots = new Set(["bot-1"]);

const services: ApiServices = {
  deployment: {
    async status() {
      return { kind: "open" } as const;
    },
  },
  realtime: new InProcessRealtimeFanout(),
};

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the usage suite");
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
      findById: notExercised,
      listForThread: notExercised,
      findActiveForThread: notExercised,
      create: notExercised,
      requestStop: notExercised,
    },
    events: { listAfter: notExercised },
    toolResults: { read: notExercised },
    computerSnapshots: { create: notExercised, findById: notExercised, listForBot: notExercised },
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
      markUsed: notExercised,
    },
    memory: {
      list: notExercised,
      find: notExercised,
      listDeleted: notExercised,
      revisions: notExercised,
      write: notExercised,
      restore: notExercised,
    },
    usage: {
      forBot: async (botId, options) => {
        sinceCalls.push(options.since);

        if (!knownBots.has(botId)) {
          throw new NotFoundError("bot", botId);
        }

        return summary;
      },
    },
  };
}

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

describe("the usage read", () => {
  it("answers the all-time total and the day buckets in the contract shape", async () => {
    sessionActor = owner;
    summary = {
      total: { inputTokens: 3500, outputTokens: 700, reported: 4, unreported: 1 },
      periods: [
        {
          startsAt: new Date("2026-01-02T00:00:00.000Z"),
          ...{ inputTokens: 1200, outputTokens: 200, reported: 2, unreported: 0 },
        },
        {
          startsAt: new Date("2026-01-01T00:00:00.000Z"),
          ...{ inputTokens: null, outputTokens: null, reported: 0, unreported: 1 },
        },
      ],
    };

    const read = await client().usage.bot({ botId: "bot-1", days: 30 });

    expect(read).toEqual({
      botId: "bot-1",
      total: { inputTokens: 3500, outputTokens: 700, reported: 4, unreported: 1 },
      periods: [
        {
          startsAt: "2026-01-02T00:00:00.000Z",
          inputTokens: 1200,
          outputTokens: 200,
          reported: 2,
          unreported: 0,
        },
        {
          startsAt: "2026-01-01T00:00:00.000Z",
          inputTokens: null,
          outputTokens: null,
          reported: 0,
          unreported: 1,
        },
      ],
    });
  });

  it("keeps an unreported total null, never a fake zero", async () => {
    sessionActor = owner;
    summary = {
      total: { inputTokens: null, outputTokens: null, reported: 0, unreported: 2 },
      periods: [],
    };

    const read = await client().usage.bot({ botId: "bot-1" });

    expect(read.total.inputTokens).toBeNull();
    expect(read.total.outputTokens).toBeNull();
    expect(read.total.unreported).toBe(2);
    expect(read.periods).toEqual([]);
  });

  it("starts the window at UTC midnight so the buckets are whole days", async () => {
    sessionActor = owner;
    sinceCalls.length = 0;
    summary = {
      total: { inputTokens: 1, outputTokens: 1, reported: 1, unreported: 0 },
      periods: [],
    };

    await client().usage.bot({ botId: "bot-1", days: 7 });

    const since = sinceCalls[0];

    expect(since).toBeDefined();
    expect(since?.toISOString()).toMatch(/T00:00:00\.000Z$/);

    const today = new Date();
    const todayMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

    expect((todayMidnight - (since?.getTime() ?? 0)) / 86_400_000).toBe(6);
  });

  it("reports a bot outside the actor's space as the shared typed not-found", async () => {
    sessionActor = owner;

    await expect(client().usage.bot({ botId: "bot-foreign" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("answers the typed 401 without a session", async () => {
    sessionActor = null;

    const error = await client()
      .usage.bot({ botId: "bot-1" })
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
  });
});
