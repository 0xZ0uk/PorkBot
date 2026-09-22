import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { poolConnectionLimit } from "./connection-budget.ts";
import type { DatabasePool } from "./connection-budget.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The long-lived database handle, so the driver stays inside this package.
 *
 * `@porkbot/db` owns `pg` and `drizzle-orm` (module map, restricted libraries),
 * which means every other package receives a connected database rather than
 * constructing one. Better Auth's drizzle adapter is the first such consumer:
 * it needs a real drizzle instance and the schema, both of which can only be
 * assembled where those libraries live, so `openDatabase` is the seam.
 *
 * A handle is a pool plus its drizzle view. `close` is idempotent because both
 * the API's shutdown path and a test suite's teardown may call it, and a second
 * `end()` on a released pool throws.
 *
 * The caller names the pool its handle belongs to, and the cap comes from
 * `connection-budget.ts` rather than the driver's default of ten: a process
 * that opens a pool without saying which one it is would put the deployment's
 * connection budget back to a driver's choice.
 */

export type PostgresDatabase = NodePgDatabase & {
  /**
   * The pool behind the drizzle view. It is named so `queryable()` can borrow
   * one connection per statement without a second pool; the driver stays
   * inside this package, which the module map requires.
   */
  readonly $client: Pool;
};

export interface DatabaseHandle {
  /** The drizzle view over the pool: query builders and adapter transactions. */
  readonly database: PostgresDatabase;
  /** Releases the pool. Safe to call more than once. */
  close(): Promise<void>;
}

export function openDatabase(connectionString: string, pool: DatabasePool): DatabaseHandle {
  const connections = new Pool({
    connectionString,
    max: poolConnectionLimit(pool),
    connectionTimeoutMillis: 10_000,
  });
  let closed = false;

  return {
    database: drizzle(connections),
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await connections.end();
    },
  };
}

/**
 * The `Queryable` view of a handle, for a path that builds actor-scoped
 * repositories without an HTTP request's checked-out client — the API's OAuth
 * callback is the first. Each statement borrows one pooled connection; a
 * caller that needs several statements on one connection (a transaction)
 * still checks a client out itself.
 */
export function queryable(handle: DatabaseHandle): Queryable {
  return {
    async query<Row>(
      text: string,
      values?: readonly unknown[],
    ): Promise<{ readonly rows: readonly Row[] }> {
      const result = await handle.database.$client.query(
        text,
        values === undefined ? undefined : [...values],
      );

      return { rows: result.rows as readonly Row[] };
    },
  };
}
