import { integration } from "@porkbot/testkit";

// The container-backed tier: these specs boot a real Postgres 18 through the
// harness in src/harness, so they need Docker or TESTKIT_DATABASE_URL. They
// never skip themselves when neither is present — a tier that quietly does
// nothing is worse than no tier — and CI pre-pulls the digest-pinned Postgres
// image so the pull happens outside the test hooks.
export default integration({ include: ["test/integration/**/*.integration.test.ts"] });
