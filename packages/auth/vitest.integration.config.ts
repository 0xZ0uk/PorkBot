import { integration } from "@porkbot/testkit";

// The auth tier that needs a real Postgres and nothing else: the suite clones a
// migrated template from the testkit harness, so the registration gate, the
// session rows and the settings reads are exercised against the production
// major rather than a fake.
export default integration({ include: ["test/integration/**/*.integration.test.ts"] });
