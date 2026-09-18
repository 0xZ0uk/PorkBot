import type { Queryable } from "./queryable.ts";

/**
 * Runs `work` as one transaction on the connection behind `database`.
 *
 * A `Queryable` is one connection — a `pg.Client`, or a client checked out of a
 * pool and released by its owner — not a pool itself, so `begin` and `commit`
 * travel on the same connection as the work's statements. That is what makes the
 * run-creation command atomic: a duplicate submission's task insert is rolled
 * back instead of left behind, and nothing but the database ever sees the
 * intermediate rows.
 *
 * The failure path rethrows the original error: a rollback that itself fails
 * (a dead connection) must not hide why the transaction was aborted.
 */
export async function withTransaction<T>(
  database: Queryable,
  work: (transaction: Queryable) => Promise<T>,
): Promise<T> {
  await database.query("begin");

  try {
    const result = await work(database);
    await database.query("commit");
    return result;
  } catch (error) {
    await database.query("rollback").catch(() => undefined);
    throw error;
  }
}
