import { describe, expect, it } from "vitest";
import type { PostgresDatabase } from "@porkbot/db";
import { createActorResolver } from "./actor.ts";
import type { Auth } from "./create-auth.ts";

/**
 * The gate's composition without a server: a session stub and a recording
 * query-builder chain stand in for Better Auth and the driver. What this
 * proves is the two failure modes — anonymous is `null`, an unreadable session
 * is an error — and that the user id the session reports is the one the
 * membership lookup is asked for. The integration suite runs the same gate
 * against a real session cookie and a real membership row.
 */

/** Whether a drizzle condition carries the given bound value. */
function binds(value: unknown, needle: string, seen: WeakSet<object> = new WeakSet()): boolean {
  if (typeof value === "string") {
    return value === needle;
  }

  if (typeof value !== "object" || value === null || seen.has(value)) {
    return false;
  }

  seen.add(value);

  return Object.values(value).some((entry) => binds(entry, needle, seen));
}

function fakeDatabase(rows: readonly unknown[]): {
  readonly database: PostgresDatabase;
  readonly conditions: readonly unknown[];
} {
  const conditions: unknown[] = [];

  const database = {
    select: () => ({
      from: () => ({
        where: (condition: unknown) => ({
          orderBy: () => ({
            limit: () => {
              conditions.push(condition);
              return Promise.resolve(rows);
            },
          }),
        }),
      }),
    }),
  } as unknown as PostgresDatabase;

  return { database, conditions };
}

function fakeAuth(getSession: (options: { headers: Headers }) => Promise<unknown>): Auth {
  return { api: { getSession } } as unknown as Auth;
}

const session = { user: { id: "user-1" } };

describe("the actor resolver", () => {
  it("answers null for a request with no session", async () => {
    const { database, conditions } = fakeDatabase([]);
    const resolve = createActorResolver({ auth: fakeAuth(async () => null), database });

    await expect(resolve(new Headers())).resolves.toBeNull();
    expect(conditions).toEqual([]);
  });

  it("asks the membership read for the session's user", async () => {
    const { database, conditions } = fakeDatabase([{ spaceId: "space-1", role: "owner" }]);
    const resolve = createActorResolver({ auth: fakeAuth(async () => session), database });

    await expect(resolve(new Headers())).resolves.toEqual({
      kind: "user",
      spaceId: "space-1",
      userId: "user-1",
      role: "owner",
    });

    expect(conditions).toHaveLength(1);
    expect(binds(conditions[0], "user-1")).toBe(true);
  });

  it("answers null when the signed-in user holds no membership", async () => {
    const { database } = fakeDatabase([]);
    const resolve = createActorResolver({ auth: fakeAuth(async () => session), database });

    await expect(resolve(new Headers())).resolves.toBeNull();
  });

  it("propagates a session read that fails instead of answering anonymous", async () => {
    const { database } = fakeDatabase([]);
    const failure = new Error("the session store is unreachable");
    const resolve = createActorResolver({
      auth: fakeAuth(async () => {
        throw failure;
      }),
      database,
    });

    await expect(resolve(new Headers())).rejects.toBe(failure);
  });
});
