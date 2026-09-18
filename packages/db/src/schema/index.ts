/**
 * The assembled schema: the single module drizzle-kit diffs, and the module the
 * application reads tables from.
 *
 * Slice 2.1 landed the workflow with no domain tables, so the first migration
 * is the deliberately empty baseline described in `migrations/0000_baseline.sql`.
 * Slice 2.2 adds the identity and tenancy tables below and slice 2.3 the runs
 * domain; every migration is generated with `pnpm db:generate`, committed and
 * reviewed, and the conventions around it — `primaryKeyId`, `timestamps`, the
 * catalog and migration suites — apply to every table without being restated.
 */
export { primaryKeyId, timestamps } from "./columns.ts";
export { account, session, user, verification } from "./identity.ts";
export { deploymentSettings, space, spaceMember, spaceMemberRole } from "./tenancy.ts";
