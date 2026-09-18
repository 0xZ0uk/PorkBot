/**
 * The part of a Postgres client this package needs, so a caller can hand in a
 * `pg` Client and a test can hand in a stub without a server. Keep it narrow:
 * every method added here is one more thing a fake has to satisfy.
 *
 * A `Queryable` is one connection, not a pool: the run-creation command opens a
 * transaction on it, and `begin`/`commit` only guard the work when every
 * statement travels on the same connection. A caller holding a `pg.Pool`
 * checks a client out for the duration and hands that in.
 */
export interface Queryable {
  query<Row>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

/** Quote an identifier for interpolation into DDL or a catalog query. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
