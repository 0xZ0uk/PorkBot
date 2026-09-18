import { drizzle } from "drizzle-orm/node-postgres";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

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
 */

export type PostgresDatabase = NodePgDatabase;

export interface DatabaseHandle {
  /** The drizzle view over the pool: query builders and adapter transactions. */
  readonly database: PostgresDatabase;
  /** Releases the pool. Safe to call more than once. */
  close(): Promise<void>;
}

export function openDatabase(connectionString: string): DatabaseHandle {
  const pool = new Pool({ connectionString, connectionTimeoutMillis: 10_000 });
  let closed = false;

  return {
    database: drizzle(pool),
    async close(): Promise<void> {
      if (closed) {
        return;
      }

      closed = true;
      await pool.end();
    },
  };
}
