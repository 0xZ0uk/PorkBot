import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { createApiClient } from "@porkbot/contracts";
import type { AppClient } from "@porkbot/contracts";
import type {
  RoutineOccurrenceRecord,
  RoutineOutcomeRecord,
  RoutineRecord,
  RunRecord,
  UserActor,
  UserRepositories,
} from "@porkbot/db";
import { InvalidRoutineScheduleError, NotFoundError } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import type { Logger } from "@porkbot/logging";
import { serviceName } from "../app.ts";
import type { ApiServices } from "../app.ts";
import { createApiServer } from "../server.ts";
import type { DeploymentStatus } from "../services/deployment.ts";

/**
 * The routines router over the real transport: a stub repository stands in for
 * the database, so what this suite proves is the router's own contract — the
 * actor's scope is the repository's (no input can widen it), the record-to-wire
 * mapping is exactly the contract's shape, an absent patch key stays absent,
 * and the store's typed errors become the contract's typed answers rather than
 * a 500. The statements themselves are `@porkbot/db`'s suites' proof.
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

const createdAt = new Date("2026-01-01T00:00:00.000Z");

const routine: RoutineRecord = {
  id: "routine-1",
  spaceId: "space-1",
  botId: "bot-1",
  userId: "user-1",
  threadId: "thread-1",
  instruction: "summarise the inbox",
  cron: "0 9 * * *",
  timezone: "UTC",
  enabled: true,
  nextRunAt: new Date("2026-01-01T09:00:00.000Z"),
  deletedAt: null,
  createdAt,
  updatedAt: createdAt,
};

const occurrence: RoutineOccurrenceRecord = {
  id: "occurrence-1",
  routineId: routine.id,
  scheduledFor: routine.nextRunAt,
  runId: "run-1",
  createdAt,
  updatedAt: createdAt,
};

const outcome: RoutineOutcomeRecord = {
  occurrenceId: occurrence.id,
  scheduledFor: occurrence.scheduledFor,
  runId: occurrence.runId,
  status: "success",
};

const testRun: RunRecord = {
  id: "run-1",
  spaceId: "space-1",
  botId: "bot-1",
  threadId: "thread-1",
  taskId: "task-1",
  userId: "user-1",
  status: "queued",
  trigger: "routine",
  error: null,
  errorCode: null,
  leaseOwner: null,
  leaseFence: 0,
  leaseExpiresAt: null,
  stopRequestedAt: null,
  lastHeartbeatAt: null,
  lastProgressAt: null,
  currentStep: null,
  currentStepTool: null,
  stalledAt: null,
  notifiedAt: null,
  checkpoint: {},
  clientNonce: "routine-test:nonce-1",
  sourceMessageId: null,
  startedAt: null,
  completedAt: null,
  createdAt,
  updatedAt: createdAt,
};

function stubRepositories(): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the routines router suite");
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
      findById: vi.fn(async () => routine),
      list: vi.fn(async () => [routine]),
      listForBot: vi.fn(async () => [routine]),
      outcomes: vi.fn(async () => [outcome]),
      lastOutcome: vi.fn(async () => outcome),
      preview: vi.fn(async () => [routine.nextRunAt]),
      create: vi.fn(async () => routine),
      update: vi.fn(async () => routine),
      remove: vi.fn(async () => ({ ...routine, enabled: false, deletedAt: createdAt })),
      testRun: vi.fn(async () => testRun),
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
  };
}

let repositories: UserRepositories;

const server = createApiServer({
  services,
  logger,
  resolveActor: async () => owner,
  repositoriesFor: () => repositories,
});

let client: AppClient;

beforeAll(async () => {
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  client = createApiClient({ url: `http://127.0.0.1:${address.port}/rpc` });
});

beforeEach(() => {
  lines.length = 0;
  repositories = stubRepositories();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
});

describe("listing routines", () => {
  it("returns the actor's routines as ISO instants", async () => {
    const listed = await client.routines.list({});

    expect(listed).toEqual({
      routines: [
        {
          id: "routine-1",
          botId: "bot-1",
          threadId: "thread-1",
          instruction: "summarise the inbox",
          cron: "0 9 * * *",
          timezone: "UTC",
          enabled: true,
          nextRunAt: "2026-01-01T09:00:00.000Z",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(repositories.routines.list).toHaveBeenCalledTimes(1);
    expect(repositories.routines.listForBot).not.toHaveBeenCalled();
  });

  it("asks for one bot's routines when the filter is present", async () => {
    await client.routines.list({ botId: "bot-1" });

    expect(repositories.routines.listForBot).toHaveBeenCalledWith("bot-1");
    expect(repositories.routines.list).not.toHaveBeenCalled();
  });
});

describe("creating and editing routines", () => {
  it("passes the submitted schedule to the store and returns the row", async () => {
    const created = await client.routines.create({
      botId: "bot-1",
      instruction: "summarise the inbox",
      cron: "0 9 * * *",
      timezone: "UTC",
    });

    expect(repositories.routines.create).toHaveBeenCalledWith({
      botId: "bot-1",
      instruction: "summarise the inbox",
      cron: "0 9 * * *",
      timezone: "UTC",
    });
    expect(created.id).toBe("routine-1");
  });

  it("sends only the patch keys the caller supplied", async () => {
    await client.routines.update({ id: "routine-1", enabled: false });

    expect(repositories.routines.update).toHaveBeenCalledWith("routine-1", { enabled: false });
  });

  it("carries a full schedule edit", async () => {
    await client.routines.update({
      id: "routine-1",
      instruction: "check the inbox",
      cron: "30 9 * * *",
      timezone: "America/New_York",
    });

    expect(repositories.routines.update).toHaveBeenCalledWith("routine-1", {
      instruction: "check the inbox",
      cron: "30 9 * * *",
      timezone: "America/New_York",
    });
  });

  it("answers a remove with the tombstoned id", async () => {
    await expect(client.routines.remove({ id: "routine-1" })).resolves.toEqual({
      id: "routine-1",
    });
    expect(repositories.routines.remove).toHaveBeenCalledWith("routine-1");
  });
});

describe("previewing and testing a routine", () => {
  it("returns the preview's fire times as ISO instants", async () => {
    const preview = await client.routines.preview({
      cron: "0 9 * * *",
      timezone: "UTC",
      count: 3,
    });

    expect(preview).toEqual({ fireTimes: ["2026-01-01T09:00:00.000Z"] });
    expect(repositories.routines.preview).toHaveBeenCalledWith("0 9 * * *", "UTC", 3);
  });

  it("returns the run and the thread a test run created", async () => {
    const fired = await client.routines.testRun({ id: "routine-1", clientNonce: "nonce-1" });

    expect(fired).toEqual({ runId: "run-1", threadId: "thread-1" });
    expect(repositories.routines.testRun).toHaveBeenCalledWith("routine-1", "nonce-1");
  });
});

describe("reading the outcome history", () => {
  it("maps each settled slot and forwards the limit", async () => {
    const history = await client.routines.outcomes({ id: "routine-1", limit: 10 });

    expect(history).toEqual({
      outcomes: [
        {
          occurrenceId: "occurrence-1",
          scheduledFor: "2026-01-01T09:00:00.000Z",
          status: "success",
          runId: "run-1",
        },
      ],
    });
    expect(repositories.routines.outcomes).toHaveBeenCalledWith("routine-1", 10);
  });
});

describe("the typed failures", () => {
  it("answers a routine outside the actor's space with the contract's 404", async () => {
    vi.mocked(repositories.routines.outcomes).mockRejectedValueOnce(
      new NotFoundError("routine", "routine-9"),
    );

    const error = await client.routines.outcomes({ id: "routine-9" }).catch((thrown: unknown) => {
      return thrown;
    });

    expect(error).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      message: "No such routine in this space",
    });
  });

  it("answers a bad schedule with the contract's 400, not a 500", async () => {
    vi.mocked(repositories.routines.preview).mockRejectedValueOnce(
      new InvalidRoutineScheduleError("unreachable", "no fire time in the next eight years"),
    );

    const error = await client.routines
      .preview({ cron: "0 0 31 2 *", timezone: "UTC" })
      .catch((thrown: unknown) => {
        return thrown;
      });

    expect(error).toMatchObject({
      code: "BAD_REQUEST",
      status: 400,
      message: "The routine schedule is invalid",
    });
  });
});
