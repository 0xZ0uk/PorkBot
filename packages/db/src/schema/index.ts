/**
 * The assembled schema: the single module drizzle-kit diffs, and the module the
 * application reads tables from.
 *
 * Slice 2.1 lands the workflow with no domain tables, so the first migration is
 * the deliberately empty baseline described in `migrations/0000_baseline.sql`.
 * Slice 2.2 adds the identity and tenancy tables and slice 2.3 the runs domain;
 * when they do, `pnpm db:generate` produces the next numbered migration and the
 * conventions exported here — `primaryKeyId` today, the catalog and migration
 * suites around it — apply to every table without being restated.
 */
export { primaryKeyId } from "./columns.ts";
