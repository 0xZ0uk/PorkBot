import type { Queryable } from "./queryable.ts";

/**
 * The two database roles every service connects with, and the one place their
 * passwords are set.
 *
 * PRD decision 7 makes authorization structure rather than discipline, and that
 * starts at the database: the API and the worker are separate always-on
 * processes, so they get separate login roles whose grants do not overlap. The
 * deployment connects each process with its own role (`porkbot_api`,
 * `porkbot_worker`), and `migrations/0004_database_roles.sql` owns the grants —
 * see that file for the table-by-table division. This module is what the
 * migration runner uses to give those roles their passwords.
 *
 * Passwords never live in a migration: the DDL is committed, the credential is
 * not. `pnpm db:migrate` reads `PORKBOT_API_DB_PASSWORD` and
 * `PORKBOT_WORKER_DB_PASSWORD` and applies them with `setRolePasswords` after
 * the migrations, so a checked-in file never carries a secret and a deployment
 * supplies one per environment. A role with no password variable set is left
 * alone — a deployment that authenticates some other way (peer, certificate,
 * IAM) can create its own credential without this command fighting it.
 *
 * The roles are created `LOGIN`, deliberately: a process connects as its role
 * and the database decides what that role may do. `LOGIN` without a password is
 * not a usable account over a TCP connection, so creating the roles in the
 * migration is safe before any credential exists.
 */

export const apiRole = "porkbot_api";
export const workerRole = "porkbot_worker";

/**
 * Graphile Worker's schema, which the worker role owns. It belongs here because
 * a grant is deployment DDL: the migration creates the schema and grants it to
 * the worker alone, so the queue's tables and payloads are out of the API
 * role's reach. The worker also holds `CREATE` on the database — broader than
 * least privilege — because Graphile's boot runs `create schema if not exists`
 * on every start and Postgres checks the database privilege even when the
 * schema exists; the migration comment states that trade-off.
 */
export const graphileWorkerSchema = "graphile_worker";

export const apiRolePasswordEnvVar = "PORKBOT_API_DB_PASSWORD";
export const workerRolePasswordEnvVar = "PORKBOT_WORKER_DB_PASSWORD";

/** Passwords by service role; an absent role is left as it is. */
export interface RolePasswords {
  readonly api?: string;
  readonly worker?: string;
}

/** Reads the two password variables, treating a blank value as "not set". */
export function readRolePasswords(env: Record<string, string | undefined>): RolePasswords {
  const api = nonBlank(env[apiRolePasswordEnvVar]);
  const worker = nonBlank(env[workerRolePasswordEnvVar]);

  return {
    ...(api === undefined ? {} : { api }),
    ...(worker === undefined ? {} : { worker }),
  };
}

/**
 * Applies `ALTER ROLE ... WITH PASSWORD ...` for each password supplied. The
 * password is passed as a bind parameter and only ever exists as a Postgres
 * literal built by `format('%L')` on the server, so it cannot be quoted into an
 * injection or accidentally interpolated here. Identifiers are our own
 * constants, and they are quoted anyway.
 *
 * `ALTER ROLE ... PASSWORD` necessarily sends the cleartext in the statement,
 * so a deployment running this command should keep `log_statement = all` and
 * `pg_stat_statements` off for the migration connection — or supply an
 * already-hashed verifier (`SCRAM-SHA-256$...`), which Postgres stores verbatim.
 */
export async function setRolePasswords(
  database: Queryable,
  passwords: RolePasswords,
): Promise<void> {
  const assignments: ReadonlyArray<readonly [role: string, password: string | undefined]> = [
    [apiRole, passwords.api],
    [workerRole, passwords.worker],
  ];

  for (const [role, password] of assignments) {
    if (password === undefined) {
      continue;
    }

    const { rows } = await database.query<{ statement: string }>(
      "select format('alter role %I with password %L', $1::text, $2::text) as statement",
      [role, password],
    );

    const statement = rows[0]?.statement;
    if (statement === undefined) {
      throw new Error(`format() produced no statement for role "${role}"`);
    }

    await database.query(statement);
  }
}

function nonBlank(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
