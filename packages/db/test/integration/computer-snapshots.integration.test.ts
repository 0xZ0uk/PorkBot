import { randomUUID } from "node:crypto";
import { NotFoundError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserActor } from "../../src/actor.ts";
import { createComputerSnapshotStore } from "../../src/computer-snapshots.ts";
import type { ComputerSnapshotRecord } from "../../src/computer-snapshots.ts";
import { createRepositories } from "../../src/repositories.ts";

/**
 * The snapshot index against real Postgres (slice 7.5): the actor-scoped read
 * and write that make a snapshot recoverable only inside the space that took
 * it, and the newest-first list a recovery screen reads.
 *
 * The cross-space proof is two real spaces and the shared `NotFoundError`: a
 * foreign snapshot id, a foreign bot's list and a capture recorded against a
 * foreign bot all refuse through the real store, with the foreign rows left
 * exactly as they were. The integrity fields round-trip as data — the size a
 * restore verifies against and the checksum it proves — because a store that
 * silently truncated either would fail at restore time instead of at review.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;
let owner: UserActor;
let foreign: UserActor;
let foreignBotId: string;
let foreignSnapshot: ComputerSnapshotRecord;

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

async function mountSpace(label: string): Promise<UserActor> {
  const { rows: spaceRows } = await db().query<{ id: string }>(
    "insert into space (name) values ($1) returning id",
    [label],
  );
  const space = spaceRows[0];

  if (space === undefined) {
    throw new Error(`the suite could not mount the ${label} space`);
  }

  const { rows: userRows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id',
    [`${label} owner`, `${randomUUID()}@example.test`],
  );
  const user = userRows[0];

  if (user === undefined) {
    throw new Error(`the suite could not mount the ${label} owner`);
  }

  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, 'owner')", [
    space.id,
    user.id,
  ]);

  return { kind: "user", spaceId: space.id, userId: user.id, role: "owner" };
}

async function createBot(actor: UserActor, name: string): Promise<string> {
  const bot = await createRepositories(actor, db()).bots.create({
    name,
    color: "fixture-color",
    spawnKey: randomUUID(),
  });

  return bot.id;
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_computer_snapshots" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  owner = await mountSpace("computer snapshots");
  foreign = await mountSpace("computer snapshots foreign");

  foreignBotId = await createBot(foreign, "Foreign snapshot bot");

  foreignSnapshot = await createComputerSnapshotStore(foreign, db()).create({
    botId: foreignBotId,
    snapshotId: randomUUID(),
    storageKey: "computer-snapshots/ffffffffffffffff/foreign.tar",
    sizeBytes: 7,
    checksum: "f".repeat(64),
  });
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

describe("recording a capture", () => {
  it("round-trips the integrity fields and lists newest first", async () => {
    const store = createComputerSnapshotStore(owner, db());
    const botId = await createBot(owner, "Snapshot listing bot");
    const firstId = randomUUID();
    const secondId = randomUUID();

    await store.create({
      botId,
      snapshotId: firstId,
      storageKey: `computer-snapshots/0123456789abcdef/${firstId}.tar`,
      sizeBytes: 12,
      checksum: "a".repeat(64),
    });
    const second = await store.create({
      botId,
      snapshotId: secondId,
      storageKey: `computer-snapshots/0123456789abcdef/${secondId}.tar`,
      sizeBytes: 34,
      checksum: "b".repeat(64),
    });

    expect(second).toMatchObject({
      botId,
      snapshotId: secondId,
      sizeBytes: 34,
      checksum: "b".repeat(64),
    });
    expect(second.createdAt).toBeInstanceOf(Date);

    await expect(store.findById(second.id)).resolves.toEqual(second);

    const listed = await store.listForBot(botId);

    // Both captures are there, and the list is newest first.
    expect(listed.map((record) => record.id)).toEqual([second.id, expect.any(String)]);
    expect(listed.map((record) => record.sizeBytes)).toEqual([34, 12]);
  });

  it("refuses a capture recorded against a bot outside the actor's space", async () => {
    const store = createComputerSnapshotStore(owner, db());

    await expect(
      store.create({
        botId: foreignBotId,
        snapshotId: randomUUID(),
        storageKey: "computer-snapshots/0123456789abcdef/foreign.tar",
        sizeBytes: 1,
        checksum: "c".repeat(64),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("the space boundary", () => {
  it("refuses a foreign snapshot by id, as a missing one", async () => {
    const store = createComputerSnapshotStore(owner, db());

    await expect(store.findById(foreignSnapshot.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to list a foreign bot's snapshots", async () => {
    const store = createComputerSnapshotStore(owner, db());

    await expect(store.listForBot(foreignSnapshot.botId)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("leaves the foreign row untouched by every refusal", async () => {
    const { rows } = await db().query<ComputerSnapshotRecord>(
      'select storage_key as "storageKey", size_bytes::int as "sizeBytes", checksum ' +
        "from computer_snapshot where id = $1",
      [foreignSnapshot.id],
    );

    expect(rows[0]).toEqual({
      storageKey: foreignSnapshot.storageKey,
      sizeBytes: foreignSnapshot.sizeBytes,
      checksum: foreignSnapshot.checksum,
    });
  });
});
