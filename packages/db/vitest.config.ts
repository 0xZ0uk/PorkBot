import { unit } from "@porkbot/testkit";

// Unit tier: coverage thresholds gate this package, per PRD decision 45.
//
// Four files are excluded because they cannot run without a live Postgres: the
// `db:migrate` entry point and the drizzle migrator call it delegates to, plus
// the pool handle and the deployment-settings reader, which open a connection
// before they do anything. The integration tiers run all four against the
// testkit's Postgres — the auth suite proves the settings reader's absent,
// configured and conflicting behaviours — and the exclusions are listed here so
// they stay visible instead of silently dragging the aggregate down.
export default unit({
  coverageThresholds: { statements: 90, branches: 90, functions: 90, lines: 90 },
  coverageExclude: [
    "src/**/*.test.ts",
    "src/**/*.test.tsx",
    "src/database.ts",
    "src/deployment-settings.ts",
    "src/migrate-cli.ts",
    "src/run-migrations.ts",
  ],
});
