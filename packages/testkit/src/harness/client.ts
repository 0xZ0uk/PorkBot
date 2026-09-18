import { Client } from "pg";
import type { SuiteDatabase } from "./postgres.ts";

/**
 * A connection to a suite's database, owned by the harness.
 *
 * The module map gives `pg` to `@porkbot/db` and this package only, so a suite
 * whose production code may not name the driver — the worker — gets its
 * fixtures and its role-scoped connections here. The returned client is the
 * same one-connection shape the repositories are built on (structurally
 * `@porkbot/db`'s `Queryable`; this package declares it rather than importing
 * it, because `@porkbot/db`'s tests depend on this package and the manifest
 * edge back would be a cycle), so a suite can either run SQL directly or hand
 * it to `createRepositories`.
 *
 * `connectToSuite` with a `role` sets Postgres' `role` setting in the startup
 * packet, which is `SET ROLE` before the first statement. The connecting user
 * (the harness user) must be allowed to become that role — a superuser is — and
 * permission checks then run as the role: `current_user` is the role and
 * `is_superuser` is off, so a denied operation is denied for the role's grants,
 * not for the harness user's. `session_user` stays the harness user, which is
 * what makes the role change possible at all.
 */

/** One connected session: a `Queryable` plus close. */
export interface SuiteClient {
  query<Row>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
  end(): Promise<void>;
}

/** Postgres identifiers this harness will put in a startup option unquoted. */
const roleNamePattern = /^[a-z_][a-z0-9_$]*$/i;

/** The suite's URL with the session's role set in the startup options. */
export function connectionStringForRole(connectionString: string, role: string): string {
  if (!roleNamePattern.test(role)) {
    throw new Error(
      `"${role}" is not a plain Postgres role name; connectionStringForRole will not ` +
        "interpolate it into the startup options.",
    );
  }

  const url = new URL(connectionString);
  url.searchParams.set("options", `-c role=${role}`);

  return url.toString();
}

export interface ConnectToSuiteOptions {
  /** The session role to run as; defaults to the harness's own user. */
  readonly role?: string;
}

export async function connectToSuite(
  suite: SuiteDatabase,
  options: ConnectToSuiteOptions = {},
): Promise<SuiteClient> {
  const connectionString =
    options.role === undefined
      ? suite.connectionString
      : connectionStringForRole(suite.connectionString, options.role);

  const client = new Client({ connectionString });

  await client.connect();

  return {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      const result = await client.query(text, [...values]);

      return { rows: result.rows as readonly Row[] };
    },
    async end(): Promise<void> {
      await client.end();
    },
  };
}
