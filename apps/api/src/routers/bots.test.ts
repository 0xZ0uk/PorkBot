import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { InProcessRealtimeFanout, LocalStorageProvider } from "@porkbot/adapters";
import type { StorageProvider } from "@porkbot/adapter-kit";
import { createApiClient } from "@porkbot/contracts";
import type { BotRecord, UserActor, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serviceName } from "../app.ts";
import { createApiServer } from "../server.ts";
import { avatarStorageKey } from "../services/bots.ts";

/**
 * The avatar seam through the real transport: the typed client calls
 * `bots.setAvatar` and the bytes come back through `bots.avatar`, with a
 * local-filesystem provider standing at the storage seam. What this suite
 * proves is the property the acceptance criterion names — there is one storage
 * path, and upload, read, clear and delete all use it — plus the scope rule:
 * a bot from another space is refused before anything is written.
 *
 * The repositories are an in-memory stand-in for the actor-scoped layer; the
 * SQL they translate to is proven against Postgres in `@porkbot/db`'s
 * integration suite.
 */

const owner: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const stranger: BotRecord = {
  id: "bot-other",
  spaceId: "space-2",
  userId: "user-2",
  name: "Elsewhere",
  title: "",
  description: "",
  instructions: "",
  color: "#000000",
  pinned: false,
  position: 0,
  sectionId: null,
  archivedAt: null,
  spawnKey: "spawn-other",
  avatarKey: null,
  computerId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

let root = "";
let storage: StorageProvider;
let server: ReturnType<typeof createApiServer>;

function seedBot(): BotRecord {
  const now = new Date();
  const bot: BotRecord = {
    id: randomUUID(),
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
    spawnKey: randomUUID(),
    avatarKey: null,
    computerId: null,
    createdAt: now,
    updatedAt: now,
  };

  records.set(bot.id, bot);
  records.set(stranger.id, stranger);

  return bot;
}

const records = new Map<string, BotRecord>();

function repositoriesFor(actor: UserActor): UserRepositories {
  const notExercised = async (): Promise<never> => {
    throw new Error("not exercised by the bots suite");
  };

  async function findScoped(id: string): Promise<BotRecord> {
    const bot = records.get(id);

    if (bot === undefined || bot.spaceId !== actor.spaceId) {
      throw new NotFoundError("bot", id);
    }

    return bot;
  }

  function save(record: BotRecord): BotRecord {
    records.set(record.id, record);
    return record;
  }

  return {
    actor,
    bots: {
      findById: findScoped,
      async list(scope = "active") {
        return [...records.values()].filter((bot) => {
          if (bot.spaceId !== actor.spaceId) {
            return false;
          }

          return scope === "all"
            ? true
            : scope === "archived"
              ? bot.archivedAt !== null
              : bot.archivedAt === null;
        });
      },
      async create(input) {
        const now = new Date();

        return save({
          id: randomUUID(),
          spaceId: actor.spaceId,
          userId: actor.userId,
          name: input.name,
          title: input.title ?? "",
          description: input.description ?? "",
          instructions: input.instructions ?? "",
          color: input.color,
          pinned: input.pinned ?? false,
          position: input.position ?? 0,
          sectionId: input.sectionId ?? null,
          archivedAt: null,
          spawnKey: input.spawnKey,
          avatarKey: null,
          computerId: input.computerId ?? null,
          createdAt: now,
          updatedAt: now,
        });
      },
      async update(id, patch) {
        const bot = await findScoped(id);

        return save({ ...bot, ...definedOnly(patch), updatedAt: new Date() });
      },
      async archive(id) {
        const bot = await findScoped(id);

        return save({ ...bot, archivedAt: bot.archivedAt ?? new Date(), updatedAt: new Date() });
      },
      async restore(id) {
        const bot = await findScoped(id);

        return save({ ...bot, archivedAt: null, updatedAt: new Date() });
      },
      async delete(id) {
        const bot = await findScoped(id);
        records.delete(id);

        return bot;
      },
      async setAvatar(id, avatarKey) {
        const bot = await findScoped(id);

        return save({ ...bot, avatarKey, updatedAt: new Date() });
      },
    },
    sections: {
      list: notExercised,
      create: notExercised,
      update: notExercised,
      delete: notExercised,
    },
    threads: { findById: notExercised, listForBot: notExercised, createForBot: notExercised },
    runs: { findById: notExercised, listForThread: notExercised, create: notExercised },
    events: { listAfter: notExercised },
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
      read: notExercised,
      set: notExercised,
    },
  };
}

function definedOnly(patch: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "porkbot-avatar-api-"));
  storage = new LocalStorageProvider({ root });
  server = createApiServer({
    services: {
      deployment: {
        async status() {
          return { kind: "closed" };
        },
      },
      realtime: new InProcessRealtimeFanout(),
      storage,
    },
    logger: createLogger({ service: serviceName, write: () => undefined }),
    resolveActor: async () => owner,
    repositoriesFor,
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(root, { recursive: true, force: true });
});

function client() {
  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }

  return createApiClient({ url: `http://127.0.0.1:${address.port}/rpc` });
}

describe("the avatar seam", () => {
  it("uploads through the storage provider and reads the same bytes back", async () => {
    const bot = seedBot();
    const api = client();

    const uploaded = await api.bots.setAvatar({
      id: bot.id,
      contentType: "image/png",
      data: base64("avatar-bytes"),
    });

    expect(uploaded.avatarKey).toBe(avatarStorageKey(owner.spaceId, bot.id));

    const stored = await storage.get(avatarStorageKey(owner.spaceId, bot.id));
    expect(stored?.object.contentType).toBe("image/png");

    const read = await api.bots.avatar({ id: bot.id });

    expect(read).toEqual({ contentType: "image/png", data: base64("avatar-bytes") });
  });

  it("clears the object and the key together", async () => {
    const bot = seedBot();
    const api = client();
    const key = avatarStorageKey(owner.spaceId, bot.id);

    await api.bots.setAvatar({ id: bot.id, contentType: "image/webp", data: base64("x") });
    const cleared = await api.bots.clearAvatar({ id: bot.id });

    expect(cleared.avatarKey).toBeNull();
    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(api.bots.avatar({ id: bot.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("deletes the object when the bot is deleted", async () => {
    const bot = seedBot();
    const api = client();
    const key = avatarStorageKey(owner.spaceId, bot.id);

    await api.bots.setAvatar({ id: bot.id, contentType: "image/gif", data: base64("gif") });
    const removed = await api.bots.delete({ id: bot.id });

    expect(removed.id).toBe(bot.id);
    await expect(storage.get(key)).resolves.toBeUndefined();
    await expect(api.bots.get({ id: bot.id })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses another space's bot for every avatar operation, writing nothing", async () => {
    const api = client();
    const before = await storage.list("");

    await expect(
      api.bots.setAvatar({ id: stranger.id, contentType: "image/png", data: base64("nope") }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(api.bots.avatar({ id: stranger.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.bots.clearAvatar({ id: stranger.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(api.bots.delete({ id: stranger.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await expect(storage.list("")).resolves.toEqual(before);
  });

  it("answers a missing avatar for a bot that has none", async () => {
    const bot = seedBot();

    await expect(client().bots.avatar({ id: bot.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("rejects an oversized avatar before it reaches the provider", async () => {
    const bot = seedBot();
    const api = client();
    const before = await storage.list("");
    const oversized = "A".repeat(700_000);

    await expect(
      api.bots.setAvatar({ id: bot.id, contentType: "image/png", data: oversized }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(storage.list("")).resolves.toEqual(before);
  });
});
