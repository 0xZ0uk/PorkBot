import { describe, expect, it } from "vitest";
import type { PostgresDatabase } from "./database.ts";
import { resolveUserActor } from "./membership.ts";

/**
 * The membership read without a server: a recording query-builder chain stands
 * in for the driver, so what this proves is the read's own contract — the
 * first row becomes the actor, no row becomes `null`, and the lookup is
 * bounded to one row. Whether the `where` clause really filters by user id is
 * the integration suite's question, because only Postgres can answer it.
 */

function fakeDatabase(rows: readonly unknown[]): {
  readonly database: PostgresDatabase;
  readonly limits: readonly number[];
} {
  const limits: number[] = [];

  const database = {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: (count: number) => {
              limits.push(count);
              return Promise.resolve(rows);
            },
          }),
        }),
      }),
    }),
  } as unknown as PostgresDatabase;

  return { database, limits };
}

describe("resolving the actor behind a session", () => {
  it("returns the membership's space and role", async () => {
    const { database, limits } = fakeDatabase([{ spaceId: "space-1", role: "owner" }]);

    const actor = await resolveUserActor(database, { userId: "user-1" });

    expect(actor).toEqual({
      kind: "user",
      spaceId: "space-1",
      userId: "user-1",
      role: "owner",
    });
    expect(limits).toEqual([1]);
  });

  it("answers null for a user with no membership", async () => {
    const { database } = fakeDatabase([]);

    await expect(resolveUserActor(database, { userId: "user-1" })).resolves.toBeNull();
  });

  it("carries a member's role unchanged", async () => {
    const { database } = fakeDatabase([{ spaceId: "space-1", role: "member" }]);

    await expect(resolveUserActor(database, { userId: "user-1" })).resolves.toMatchObject({
      role: "member",
    });
  });
});
