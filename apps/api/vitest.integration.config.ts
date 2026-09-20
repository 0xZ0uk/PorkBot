import { integration } from "@porkbot/testkit";

// The tier that needs a real Postgres: the suite clones a migrated template
// from the testkit harness and drives the shipped auth composition through the
// HTTP app, so the cookie, the membership and the resolvers are the ones a
// deployment runs rather than a fake.
export default integration({ include: ["test/integration/**/*.integration.test.ts"] });
