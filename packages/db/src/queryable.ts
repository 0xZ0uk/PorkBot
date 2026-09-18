/**
 * The part of a Postgres client this package needs, so a caller can hand in a
 * `pg` Client or Pool and a test can hand in a stub without a server. Keep it
 * narrow: every method added here is one more thing a fake has to satisfy.
 */
export interface Queryable {
  query<Row>(text: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

/** Quote an identifier for interpolation into DDL or a catalog query. */
export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}
