import { integration } from "@porkbot/testkit";

// The database-backed tier. It gets its Postgres from the testkit harness in
// packages/testkit/src/harness: a container of the production major, or the
// server TESTKIT_DATABASE_URL points at, cloned per suite from a migrated
// template. There is no service to configure, and turbo is told not to cache
// `test:integration` (see the root turbo.json): a cached pass would not have
// touched a database, which is the only thing this tier is here to prove.
export default integration({ include: ["test/integration/**/*.integration.test.ts"] });
