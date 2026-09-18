import { unit } from "@porkbot/testkit";

// Unit tier: coverage thresholds gate this package, per PRD decision 45.
//
// Two files are excluded because they cannot run without a live Postgres: the
// `db:migrate` entry point and the drizzle migrator call it delegates to. The
// integration tier runs both against the testkit's Postgres and asserts the
// command's behaviour; the unit tier measures everything it can execute
// without a server, and the exclusions are listed here so they are visible.
export default unit({
  coverageThresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
  coverageExclude: [
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
    "src/migrate-cli.ts",
    "src/run-migrations.ts",
  ],
});
