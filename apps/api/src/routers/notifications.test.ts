import { NOTIFICATION_KINDS } from "@porkbot/core";
import type { NotificationKind, NotificationPreferenceSet } from "@porkbot/core";
import { createApiClient, ORPCError } from "@porkbot/contracts";
import type { UserActor, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import type { ApprovalHistoryRecord } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InProcessRealtimeFanout } from "@porkbot/adapters";
import { serviceName } from "../app.ts";
import { createApiServer } from "../server.ts";
import type { ApiServices } from "../app.ts";

/**
 * The notification preference surface through the real transport: the typed
 * client reads the switches, flips one, and reads again. What this suite proves
 * is the shape the acceptance criteria name — every kind is present with the
 * quiet default off, a set returns the whole set, one operator's choices are
 * not another's, and a request without a session is refused before the handler.
 *
 * The repositories are an in-memory stand-in for the actor-scoped layer; the
 * SQL they translate to is proven against Postgres in `@porkbot/db`'s
 * integration suite.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const colleague: UserActor = {
  kind: "user",
  spaceId: "space-1",
  userId: "user-2",
  role: "member",
};

const switches = new Map<string, Set<NotificationKind>>();
const approvalRows = new Map<string, ApprovalHistoryRecord>();
let sessionActor: UserActor | null = owner;

function keyFor(actor: UserActor): string {
  return `${actor.spaceId}:${actor.userId}`;
}

function readFor(actor: UserActor): NotificationPreferenceSet {
  const enabled = switches.get(keyFor(actor)) ?? new Set<NotificationKind>();

  return Object.fromEntries(
    NOTIFICATION_KINDS.map((kind) => [kind, enabled.has(kind)]),
  ) as NotificationPreferenceSet;
}

function approvalKey(runId: string, callId: string): string {
  return `${runId}:${callId}`;
}

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the notifications suite");
  };

  return {
    actor,
    membership: { requireActive: notExercised },
    approvals: {
      async decide(input) {
        const current = approvalRows.get(approvalKey(input.runId, input.callId));

        if (current === undefined) {
          throw new NotFoundError("approval", input.callId);
        }

        if (current.status !== "pending") {
          return { record: current, applied: false };
        }

        const updated: ApprovalHistoryRecord = {
          ...current,
          status: input.vote === "approve" ? "approved" : "denied",
          decidedBy: actor.userId,
          decidedAt: new Date("2026-01-01T00:01:00.000Z"),
          reason: input.vote === "deny" ? (input.reason ?? null) : null,
        };
        approvalRows.set(approvalKey(input.runId, input.callId), updated);

        return { record: updated, applied: true };
      },
      async listForRun(runId) {
        return [...approvalRows.values()].filter((approval) => approval.runId === runId);
      },
      async list(input = {}) {
        return [...approvalRows.values()].filter(
          (approval) =>
            (input.botId === undefined || approval.botId === input.botId) &&
            (input.runId === undefined || approval.runId === input.runId) &&
            (input.status === undefined || approval.status === input.status),
        );
      },
    },
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
    files: {
      createAttachment: notExercised,
      findAttachments: notExercised,
      findStoredFile: notExercised,
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
    notifications: {
      read: async () => readFor(actor),
      set: async (kind, enabled) => {
        const key = keyFor(actor);
        const chosen = switches.get(key) ?? new Set<NotificationKind>();

        if (enabled) {
          chosen.add(kind);
        } else {
          chosen.delete(kind);
        }

        switches.set(key, chosen);

        return readFor(actor);
      },
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
    usage: { forBot: notExercised },
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

describe("the notification preference surface", () => {
  it("answers every kind with the quiet default until one is turned on", async () => {
    switches.clear();
    sessionActor = owner;

    const client = createApiClient({ url: `${baseUrl}/rpc` });

    await expect(client.notifications.preferences()).resolves.toEqual({
      preferences: [
        { kind: "run.completed", enabled: false },
        { kind: "run.failed", enabled: false },
        { kind: "run.needs_approval", enabled: false },
        { kind: "run.stalled", enabled: false },
      ],
    });
  });

  it("turns one switch on, returns the whole set and keeps it for the next read", async () => {
    switches.clear();
    sessionActor = owner;

    const client = createApiClient({ url: `${baseUrl}/rpc` });

    await expect(
      client.notifications.setPreference({ kind: "run.failed", enabled: true }),
    ).resolves.toEqual({
      preferences: [
        { kind: "run.completed", enabled: false },
        { kind: "run.failed", enabled: true },
        { kind: "run.needs_approval", enabled: false },
        { kind: "run.stalled", enabled: false },
      ],
    });

    await expect(client.notifications.preferences()).resolves.toEqual({
      preferences: [
        { kind: "run.completed", enabled: false },
        { kind: "run.failed", enabled: true },
        { kind: "run.needs_approval", enabled: false },
        { kind: "run.stalled", enabled: false },
      ],
    });
  });

  it("keeps one operator's switches out of another's read", async () => {
    switches.clear();
    sessionActor = owner;

    const client = createApiClient({ url: `${baseUrl}/rpc` });

    await client.notifications.setPreference({ kind: "run.stalled", enabled: true });

    sessionActor = colleague;

    await expect(client.notifications.preferences()).resolves.toEqual({
      preferences: [
        { kind: "run.completed", enabled: false },
        { kind: "run.failed", enabled: false },
        { kind: "run.needs_approval", enabled: false },
        { kind: "run.stalled", enabled: false },
      ],
    });
  });

  it("answers the typed 401 without a session", async () => {
    switches.clear();
    sessionActor = null;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.notifications.preferences().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
  });
});

describe("the approval surface", () => {
  it("lists pending history with filters and records an idempotent decision", async () => {
    approvalRows.clear();
    approvalRows.set(approvalKey("run-1", "call-1"), {
      id: "approval-1",
      botId: "bot-1",
      threadId: "thread-1",
      runId: "run-1",
      callId: "call-1",
      tool: "web_fetch",
      arguments: { url: "https://example.invalid", token: "[redacted]" },
      status: "pending",
      expiresAt: new Date("2026-01-01T00:05:00.000Z"),
      decidedBy: null,
      decidedAt: null,
      reason: null,
    });
    sessionActor = owner;

    const client = createApiClient({ url: `${baseUrl}/rpc` });

    await expect(client.approvals.list({ botId: "bot-1", runId: "run-1" })).resolves.toMatchObject({
      approvals: [
        {
          id: "approval-1",
          tool: "web_fetch",
          status: "pending",
          arguments: { token: "[redacted]" },
          expiresAt: "2026-01-01T00:05:00.000Z",
        },
      ],
    });

    await expect(
      client.approvals.decide({ runId: "run-1", callId: "call-1", vote: "deny" }),
    ).resolves.toMatchObject({
      applied: true,
      approval: { status: "denied", decidedBy: "user-1" },
    });

    await expect(
      client.approvals.decide({ runId: "run-1", callId: "call-1", vote: "approve" }),
    ).resolves.toMatchObject({ applied: false, approval: { status: "denied" } });
  });

  it("refuses the approval list without a session", async () => {
    sessionActor = null;

    const client = createApiClient({ url: `${baseUrl}/rpc` });
    const error = await client.approvals.list({}).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 401, defined: true });
  });
});
