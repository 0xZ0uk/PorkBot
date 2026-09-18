import { integration } from "@porkbot/testkit";

// The worker's database-backed tier: the suite boots the testkit harness (or
// attaches to the one CI started), clones a migrated template and runs the real
// Graphile runner over the real queue schema, connected as the worker's own
// role. No fake queue stands in: job locking, delivery and deletion are
// Graphile's answers, and the fence is the row's.
export default integration({ include: ["test/integration/**/*.integration.test.ts"] });
