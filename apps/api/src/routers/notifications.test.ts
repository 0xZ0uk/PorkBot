import { NOTIFICATION_KINDS } from "@porkbot/core";
import type { NotificationKind, NotificationPreferenceSet } from "@porkbot/core";
import { createApiClient, ORPCError } from "@porkbot/contracts";
import type { UserActor, UserRepositories } from "@porkbot/db";
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

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the notifications suite");
  };

  return {
    actor,
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
    },
    events: { listAfter: notExercised },
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
