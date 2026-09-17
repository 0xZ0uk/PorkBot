import { defineConfig } from "vitest/config";

// The database-backed tier. It needs a real Postgres reachable over
// DATABASE_URL, and turbo is told not to cache `test:integration` (see
// turbo.json): a cached pass would not have touched a database, which is the
// only thing this tier is here to prove.
//
// CI provides the service in the `integration` job of .github/workflows/ci.yml
// (Postgres 18, the production major). Locally:
//
//   docker run --rm -p 5432:5432 -e POSTGRES_USER=porkbot \
//     -e POSTGRES_PASSWORD=porkbot -e POSTGRES_DB=porkbot postgres:18
//
// then:
//
//   DATABASE_URL=postgres://porkbot:porkbot@127.0.0.1:5432/porkbot pnpm test:integration
export default defineConfig({
  test: {
    include: ["test/integration/**/*.integration.test.ts"],
    // Integration suites wait on a service and a socket, so they get their own
    // budget instead of the unit default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
