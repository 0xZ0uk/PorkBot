/**
 * The foreign-key index rule, read from the catalog rather than trusted.
 *
 * Postgres does not index the referencing side of a foreign key, so a lookup
 * like "every bot in this space" scans the child table unless an index exists.
 * The rule "every lookup FK is indexed" is therefore checked by asking the
 * database, not by convention: this query returns each foreign key whose
 * referencing columns are not the leading columns of any valid index on the
 * child table, and the integration suite fails while it returns anything.
 *
 * "Leading columns" is the honest definition: an index on `(space_id, id)`
 * serves a lookup by `space_id`, while an index on `(id, space_id)` does not.
 * Partial and expression indexes do not count: a lookup that falls outside the
 * predicate, or one that does not use the expression, is still a scan.
 */

import type { Queryable } from "../queryable.ts";

export interface UnindexedForeignKey {
  readonly table: string;
  readonly constraint: string;
  readonly columns: readonly string[];
}

interface ForeignKeyRow {
  readonly table_name: string;
  readonly constraint_name: string;
  readonly column_names: readonly string[];
}

/**
 * Passing the schema as a parameter keeps the query text constant, and the
 * `pg_constraint`/`pg_index` join is the catalog reading the rule asks for: an
 * index covers the key when its first `array_length(conkey)` columns equal the
 * constraint's columns, in order.
 */
export const unindexedForeignKeysSql = `select
  con.conrelid::regclass::text as table_name,
  con.conname as constraint_name,
  array(
    select attribute.attname
    from unnest(con.conkey) with ordinality as key(attnum, position)
    join pg_attribute attribute
      on attribute.attrelid = con.conrelid and attribute.attnum = key.attnum
    order by key.position
  )::text[] as column_names
from pg_constraint con
where con.contype = 'f'
  and con.connamespace = $1::regnamespace
  and not exists (
    select 1
    from pg_index index
    where index.indrelid = con.conrelid
      and index.indisvalid
      and index.indpred is null
      and (index.indkey::int2[])[0:array_length(con.conkey, 1) - 1] = con.conkey
  )
order by table_name, constraint_name`;

export function toUnindexedForeignKeys(rows: readonly ForeignKeyRow[]): UnindexedForeignKey[] {
  return rows.map((row) => ({
    table: row.table_name,
    constraint: row.constraint_name,
    columns: [...row.column_names],
  }));
}

/** Foreign keys in `schema` whose referencing columns no index leads with. */
export async function findUnindexedForeignKeys(
  database: Queryable,
  schema = "public",
): Promise<UnindexedForeignKey[]> {
  const { rows } = await database.query<ForeignKeyRow>(unindexedForeignKeysSql, [schema]);

  return toUnindexedForeignKeys(rows);
}

/** One violation per line, in the shape an assertion message can print. */
export function formatUnindexedForeignKeys(violations: readonly UnindexedForeignKey[]): string {
  return violations
    .map(
      (violation) =>
        `${violation.table} (${violation.columns.join(", ")}) has no index leading with those ` +
        `columns; the FK is ${violation.constraint}`,
    )
    .join("\n");
}
