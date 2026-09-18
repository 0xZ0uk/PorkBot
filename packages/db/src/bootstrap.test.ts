import { describe, expect, it } from "vitest";
import type { SpaceMemberRole } from "./actor.ts";
import { bootstrapSignup, defaultSpaceName } from "./bootstrap.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The bootstrap without a server: a recording fake stands in for the pg
 * client, so what these tests prove is the command's own contract — it takes
 * the advisory lock before it reads, it writes only the tenancy rows, it binds
 * the role and the user it was given, a replay writes nothing, and a second
 * owner request lands as a member. Whether the SQL is valid against Postgres,
 * and whether concurrent bootstraps really serialize, is not provable here; the
 * integration suite runs the same calls on the real thing.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

const spaceSelect = "select id from space order by created_at asc, id asc limit 1";
const spaceInsert = "insert into space (name) values ($1) returning id";
const membershipSelect = "select role from space_member where space_id = $1 and user_id = $2";
const ownerSelect =
  "select 1 as one from space_member where space_id = $1 and role = 'owner' limit 1";
const membershipInsert =
  "insert into space_member (space_id, user_id, role) values ($1, $2, $3) returning role";

interface FakeState {
  spaceId?: string;
  readonly memberships: Map<string, SpaceMemberRole>;
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
  readonly state: FakeState;
}

/**
 * A fake that answers the statements the command issues and mutates just enough
 * state for a second call to see the first call's rows. It does not reimplement
 * the database; the assertions below read the recorded SQL, and the integration
 * suite is what proves the SQL's meaning.
 */
function fakeDatabase(): FakeDatabase {
  const calls: QueryCall[] = [];
  const state: FakeState = { memberships: new Map() };

  return {
    calls,
    state,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      calls.push({ text, values });

      const respond = (rows: readonly unknown[] = []): { readonly rows: readonly Row[] } => ({
        rows: rows as readonly Row[],
      });

      if (text === spaceSelect) {
        return respond(state.spaceId === undefined ? [] : [{ id: state.spaceId }]);
      }

      if (text === spaceInsert) {
        state.spaceId = "space-1";
        return respond([{ id: state.spaceId }]);
      }

      if (text === membershipSelect) {
        const role = state.memberships.get(String(values[1]));
        return respond(role === undefined ? [] : [{ role }]);
      }

      if (text === ownerSelect) {
        const owner = [...state.memberships.entries()].find(([, role]) => role === "owner");
        return respond(owner === undefined ? [] : [{ one: 1 }]);
      }

      if (text === membershipInsert) {
        state.memberships.set(String(values[1]), values[2] as SpaceMemberRole);
        return respond([{ role: values[2] }]);
      }

      return respond();
    },
  };
}

/**
 * The calls below are deliberately wrong and are never invoked. They exist so
 * `tsc` fails if the command ever grows a call shape that lets the caller pick
 * the space or a role outside the membership enum.
 */
function rejectedInputs(database: Queryable): readonly (() => unknown)[] {
  return [
    // @ts-expect-error -- the space is chosen by the bootstrap, not the caller.
    () => bootstrapSignup(database, { userId: "user-1", role: "owner", spaceId: "space-1" }),
    // @ts-expect-error -- a role outside the membership enum is not a membership role.
    () => bootstrapSignup(database, { userId: "user-1", role: "superuser" }),
  ];
}

function inserts(database: FakeDatabase): readonly QueryCall[] {
  return database.calls.filter((call) => call.text.startsWith("insert into"));
}

describe("the first signup", () => {
  it("creates the space and the owner membership in one transaction", async () => {
    const database = fakeDatabase();

    const result = await bootstrapSignup(database, { userId: "user-1", role: "owner" });

    expect(result).toEqual({
      actor: { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" },
      createdSpace: true,
      createdMembership: true,
    });
    expect(database.calls.map((call) => call.text)).toEqual([
      "begin",
      "select pg_advisory_xact_lock($1)",
      spaceSelect,
      spaceInsert,
      membershipSelect,
      ownerSelect,
      membershipInsert,
      "commit",
    ]);
    expect(database.calls[1]?.values).toEqual([1_349_481_067]);
    expect(inserts(database)).toEqual([
      { text: spaceInsert, values: [defaultSpaceName] },
      { text: membershipInsert, values: ["space-1", "user-1", "owner"] },
    ]);
  });

  it("takes the advisory lock before it reads the space", async () => {
    const database = fakeDatabase();

    await bootstrapSignup(database, { userId: "user-1", role: "owner" });

    const lock = database.calls.findIndex((call) => call.text.includes("pg_advisory_xact_lock"));
    const read = database.calls.findIndex((call) => call.text === spaceSelect);

    expect(lock).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(lock);
  });

  it("writes only the tenancy rows: space and space_member", async () => {
    const database = fakeDatabase();

    await bootstrapSignup(database, { userId: "user-1", role: "owner" });

    for (const call of inserts(database)) {
      expect(call.text).toMatch(/^insert into (space|space_member)\b/);
    }

    expect(inserts(database)[1]?.values).toContain("space-1");
  });

  it("lets a later member join the space the first signup created", async () => {
    const database = fakeDatabase();

    await bootstrapSignup(database, { userId: "user-1", role: "owner" });
    const result = await bootstrapSignup(database, { userId: "user-2", role: "member" });

    expect(result).toEqual({
      actor: { kind: "user", spaceId: "space-1", userId: "user-2", role: "member" },
      createdSpace: false,
      createdMembership: true,
    });
    expect(inserts(database)).toHaveLength(3);
  });
});

describe("a replay", () => {
  it("writes nothing and returns the first role", async () => {
    const database = fakeDatabase();

    await bootstrapSignup(database, { userId: "user-1", role: "owner" });
    const before = database.calls.length;

    const replay = await bootstrapSignup(database, { userId: "user-1", role: "owner" });

    expect(replay).toEqual({
      actor: { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" },
      createdSpace: false,
      createdMembership: false,
    });
    expect(inserts(database)).toHaveLength(2);
    expect(database.calls.slice(before).map((call) => call.text)).toEqual([
      "begin",
      "select pg_advisory_xact_lock($1)",
      spaceSelect,
      membershipSelect,
      "commit",
    ]);
  });

  it("never re-grants: an existing member stays a member when told owner", async () => {
    const database = fakeDatabase();

    await bootstrapSignup(database, { userId: "user-1", role: "member" });
    const result = await bootstrapSignup(database, { userId: "user-1", role: "owner" });

    expect(result.actor.role).toBe("member");
    expect(result.createdMembership).toBe(false);
  });
});

describe("a second owner request", () => {
  it("joins as a member instead of creating a second owner", async () => {
    const database = fakeDatabase();

    await bootstrapSignup(database, { userId: "user-1", role: "owner" });
    const result = await bootstrapSignup(database, { userId: "user-2", role: "owner" });

    expect(result.actor.role).toBe("member");
    expect(result.createdMembership).toBe(true);
    expect([...database.state.memberships.values()]).toEqual(["owner", "member"]);
  });
});

describe("failure", () => {
  it("rolls back when a write fails, so no partial bootstrap survives", async () => {
    const database = fakeDatabase();
    const failing: Queryable = {
      query(text, values = []) {
        if (text === membershipInsert) {
          return Promise.reject(new Error("the insert failed"));
        }

        return database.query(text, values);
      },
    };

    await expect(bootstrapSignup(failing, { userId: "user-1", role: "owner" })).rejects.toThrow(
      "the insert failed",
    );
    expect(database.calls.at(-1)?.text).toBe("rollback");
  });

  it("treats an empty insert result as a fault, not a missing row", async () => {
    const emptyInserts: Queryable = {
      query(text) {
        if (text.startsWith("insert into")) {
          return Promise.resolve({ rows: [] });
        }

        return Promise.resolve({ rows: [] });
      },
    };

    await expect(
      bootstrapSignup(emptyInserts, { userId: "user-1", role: "owner" }),
    ).rejects.toThrow("the database returned no row for an insert");
  });
});

describe("construction", () => {
  it("takes a user and a role, never a space", () => {
    const database = fakeDatabase();

    expect(rejectedInputs(database)).toHaveLength(2);
    expect(() => bootstrapSignup(database, { userId: "user-1", role: "owner" })).not.toThrow();
  });
});
