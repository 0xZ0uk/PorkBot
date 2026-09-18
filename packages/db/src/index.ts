export const moduleInfo = {
  name: "@porkbot/db",
  summary: "Drizzle schema, migrations and actor-scoped repositories. Tenant isolation lives here.",
} as const;

// The schema: every table, enum and the conventions they share. Identity and
// tenancy tables landed first (slice 2.2) and the runs tables follow (slice
// 2.3); `pnpm db:generate` diffs whatever `src/schema/index.ts` exports, so
// adding a table is adding one export there, and repositories read the same
// definitions the migration was generated from. This is the only entry point
// other packages may import.
export * from "./schema/index.ts";

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
