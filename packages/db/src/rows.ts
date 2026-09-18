import { NotFoundError } from "@porkbot/effect";

/**
 * Turning statement results into rows, in one place so the empty-result rules
 * are the same everywhere.
 */

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
