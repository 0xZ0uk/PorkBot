import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { UserActor } from "../../src/actor.ts";
import { openDatabase } from "../../src/database.ts";
import type { DatabaseHandle } from "../../src/database.ts";
import { createIngressStore, hashOAuthState } from "../../src/ingress.ts";
import type { IngressStore } from "../../src/ingress.ts";

/**
 * The ingress ledgers where the rules live: a real Postgres of the production
 * major. The dedupe, the TTL sweep and the one-time state consumption are
 * database behaviour, so they are answered here rather than against a stub —
 * the unique index decides a replay, the recorder sweeps the rows past their
 * expiry, and the state's `consumed_at is null` predicate decides the winner of
 * two concurrent callbacks.
 */

let suite: SuiteDatabase | undefined;
let handle: DatabaseHandle | undefined;
let client: Client | undefined;
let store: IngressStore;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_ingress" });
  handle = openDatabase(suite.connectionString, "api");
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();
  store = createIngressStore(handle.database);
}, 180_000);

afterAll(async () => {
  await client?.end();
  await handle?.close();
  await suite?.destroy();
});

beforeEach(async () => {
  await query("delete from webhook_delivery");
  // OAuth states cascade from their user and space.
  await query('delete from "user"');
  await query("delete from space");
});

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

async function query<Row>(text: string, values: readonly unknown[] = []): Promise<readonly Row[]> {
  const { rows } = await db().query(text, [...values]);

  return rows as readonly Row[];
}

async function insertUser(): Promise<string> {
  const rows = await query<{ readonly id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    ["Test Operator", `${randomUUID()}@example.invalid`],
  );

  return rows[0]?.id ?? "";
}

async function insertSpace(name: string): Promise<string> {
  const rows = await query<{ readonly id: string }>(
    "insert into space (name) values ($1) returning id::text as id",
    [name],
  );

  return rows[0]?.id ?? "";
}

async function actorFor(spaceName: string): Promise<UserActor> {
  const userId = await insertUser();
  const spaceId = await insertSpace(spaceName);

  await query("insert into space_member (space_id, user_id, role) values ($1, $2, 'owner')", [
    spaceId,
    userId,
  ]);

  return { kind: "user", spaceId, userId, role: "owner" };
}

async function deliveryCount(): Promise<number> {
  const rows = await query<{ readonly count: string }>(
    "select count(*)::text as count from webhook_delivery",
  );

  return Number(rows[0]?.count ?? "0");
}

describe("webhook delivery dedupe", () => {
  it("records a delivery once and answers a replay with false", async () => {
    const input = { source: "github", deliveryId: "delivery-1" };

    await expect(store.record(input)).resolves.toBe(true);
    await expect(store.record(input)).resolves.toBe(false);
    await expect(deliveryCount()).resolves.toBe(1);
  });

  it("scopes the delivery id to its source, so another source is a new delivery", async () => {
    await expect(store.record({ source: "github", deliveryId: "shared-id" })).resolves.toBe(true);
    await expect(store.record({ source: "stripe", deliveryId: "shared-id" })).resolves.toBe(true);
  });

  it("lets exactly one of two parallel recordings win", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => store.record({ source: "github", deliveryId: "parallel" })),
    );

    expect(attempts.filter((recorded) => recorded)).toHaveLength(1);
    await expect(deliveryCount()).resolves.toBe(1);
  });

  it("forgets a released delivery, so a failed handler's redelivery is dispatched again", async () => {
    const input = { source: "github", deliveryId: "delivery-2" };

    await store.record(input);
    await store.release(input);

    await expect(store.record(input)).resolves.toBe(true);
  });
});

describe("the dedupe window", () => {
  it("sweeps rows past their expiry on the next recording instead of growing forever", async () => {
    const recordedAt = new Date("2026-09-18T12:00:00.000Z");
    const afterTtl = new Date(recordedAt.getTime() + 3_600_000);

    await store.record({ source: "github", deliveryId: "old", ttlSeconds: 60, now: recordedAt });
    await store.record({ source: "stripe", deliveryId: "newer", ttlSeconds: 60, now: recordedAt });

    expect(await deliveryCount()).toBe(2);

    await store.record({ source: "github", deliveryId: "fresh", ttlSeconds: 60, now: afterTtl });

    // The two expired rows are gone; only the fresh one remains, and the old
    // delivery id can be recorded again once outside its window.
    await expect(deliveryCount()).resolves.toBe(1);
    await expect(
      store.record({ source: "github", deliveryId: "old", now: afterTtl }),
    ).resolves.toBe(true);
  });
});

describe("one-time OAuth state", () => {
  it("returns the initiating actor and space exactly once", async () => {
    const actor = await actorFor("OAuth space");

    await expect(store.issue({ actor, state: "state-value" })).resolves.toBe(true);

    await expect(store.consume("state-value")).resolves.toEqual({
      spaceId: actor.spaceId,
      userId: actor.userId,
    });
    await expect(store.consume("state-value")).resolves.toBeUndefined();
  });

  it("refuses to rebind a state value that is already known", async () => {
    const first = await actorFor("First space");
    const second = await actorFor("Second space");

    await store.issue({ actor: first, state: "reused-state" });

    await expect(store.issue({ actor: second, state: "reused-state" })).resolves.toBe(false);
    await expect(store.consume("reused-state")).resolves.toMatchObject({ userId: first.userId });
  });

  it("is bound to the issuing actor, not to whoever presents the state", async () => {
    const first = await actorFor("First space");
    const second = await actorFor("Second space");

    await store.issue({ actor: first, state: "first-state" });
    await store.issue({ actor: second, state: "second-state" });

    await expect(store.consume("first-state")).resolves.toMatchObject({ userId: first.userId });
    await expect(store.consume("second-state")).resolves.toMatchObject({ userId: second.userId });
  });

  it("lets exactly one of two parallel callbacks consume the state", async () => {
    const actor = await actorFor("Race space");

    await store.issue({ actor, state: "raced-state" });

    const consumed = await Promise.all([
      store.consume("raced-state"),
      store.consume("raced-state"),
      store.consume("raced-state"),
    ]);

    expect(consumed.filter((binding) => binding !== undefined)).toHaveLength(1);
  });

  it("refuses an unknown state and an expired one", async () => {
    const actor = await actorFor("Expiry space");
    const issuedAt = new Date("2026-09-18T12:00:00.000Z");

    await store.issue({ actor, state: "short-lived", ttlSeconds: 60, now: issuedAt });

    await expect(store.consume("never-issued", issuedAt)).resolves.toBeUndefined();
    await expect(
      store.consume("short-lived", new Date(issuedAt.getTime() + 61_000)),
    ).resolves.toBeUndefined();
  });

  it("stores only the state's hash, never the bearer value", async () => {
    const actor = await actorFor("Hashed space");

    await store.issue({ actor, state: "the-raw-state" });

    const rows = await query<{ readonly hash: string }>(
      "select state_hash as hash from oauth_state",
    );

    expect(rows.map((row) => row.hash)).toEqual([hashOAuthState("the-raw-state")]);
    expect(rows[0]?.hash).not.toBe("the-raw-state");
  });

  it("sweeps expired states on the next issue", async () => {
    const actor = await actorFor("Sweep space");
    const issuedAt = new Date("2026-09-18T12:00:00.000Z");

    await store.issue({ actor, state: "first", ttlSeconds: 60, now: issuedAt });
    await store.issue({
      actor,
      state: "second",
      ttlSeconds: 60,
      now: new Date(issuedAt.getTime() + 61_000),
    });

    const rows = await query<{ readonly count: string }>(
      "select count(*)::text as count from oauth_state",
    );

    expect(rows[0]?.count).toBe("1");
  });
});
