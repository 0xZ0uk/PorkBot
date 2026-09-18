export const moduleInfo = {
  name: "@porkbot/db",
  summary: "Drizzle schema, migrations and actor-scoped repositories. Tenant isolation lives here.",
} as const;

// The schema convention every table uses. Slice 2.2's identity tables and slice
// 2.3's runs tables are the first callers; `pnpm db:generate` diffs whatever
// `src/schema/index.ts` exports, so adding a table is adding one import there.
export { primaryKeyId } from "./schema/columns.ts";

// Applying migrations, exported so the API, the worker and scripts share one
// implementation with the `db:migrate` command rather than each shelling out.
export {
  countAppliedMigrations,
  formatMigrationReport,
  migrationsSchema,
  migrationsTable,
} from "./migrate.ts";
export type { MigrationRunOptions, MigrationRunReport } from "./migrate.ts";
export { runMigrations } from "./run-migrations.ts";
