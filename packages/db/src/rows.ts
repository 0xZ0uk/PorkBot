import { NotFoundError } from "@porkbot/effect";

/**
 * Turning statement results into rows, in one place so the empty-result rules
 * are the same everywhere.
 */

/**
 * Postgres' unique-violation SQLSTATE. A repository that translates a violated
 * unique index into the shared `NameConflictError` has to recognize it, and
 * this is the one place that string lives, so a second translation cannot
 * invent a second spelling. Only the code is read; the driver's message can
 * echo the row's values.
 */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "23505"
  );
}

/** `select` that must match: an empty result is the caller's not-found. */
export function requiredRow<Row>(rows: readonly Row[], resource: string, id: string): Row {
  const row = rows[0];

  if (row === undefined) {
    throw new NotFoundError(resource, id);
  }

  return row;
}

/**
 * `insert ... returning` yields exactly one row or throws; an empty result is a
 * `Queryable` that is not a Postgres client, not a missing row, so it must not
 * masquerade as a not-found.
 */
export function insertedRow<Row>(rows: readonly Row[]): Row {
  const row = rows[0];

  if (row === undefined) {
    throw new Error("the database returned no row for an insert");
  }

  return row;
}
