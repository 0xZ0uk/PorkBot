import { describe, expect, it } from "vitest";
import type { Queryable } from "./queryable.ts";
import { withTransaction } from "./transaction.ts";

/**
 * The transaction seam without a server: a recording fake proves the command
 * that uses it gets exactly one transaction with the right ending, and the
 * integration suite proves the same calls against Postgres.
 */

interface FakeDatabase extends Queryable {
  readonly calls: readonly string[];
}

function fakeDatabase(failOn?: string): FakeDatabase {
  const calls: string[] = [];

  return {
    calls,
    async query<Row>(text: string): Promise<{ readonly rows: readonly Row[] }> {
      calls.push(text);

      if (text === failOn) {
        throw new Error(`the fake refuses "${text}"`);
      }

      return { rows: [] };
    },
  };
}

describe("withTransaction", () => {
  it("runs the work between begin and commit and returns its result", async () => {
    const database = fakeDatabase();

    const result = await withTransaction(database, async (transaction) => {
      await transaction.query("select 1");

      return "done";
    });

    expect(result).toBe("done");
    expect(database.calls).toEqual(["begin", "select 1", "commit"]);
  });

  it("rolls back and rethrows when the work fails", async () => {
    const database = fakeDatabase();

    const rejected = await withTransaction(database, async (transaction) => {
      await transaction.query("select 1");

      throw new Error("the work failed");
    }).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toBe("the work failed");
    expect(database.calls).toEqual(["begin", "select 1", "rollback"]);
  });

  it("keeps the original failure when the rollback itself fails", async () => {
    const database = fakeDatabase("rollback");

    const rejected = await withTransaction(database, async () => {
      throw new Error("the first failure");
    }).catch((error: unknown) => error);

    expect((rejected as Error).message).toBe("the first failure");
  });
});
