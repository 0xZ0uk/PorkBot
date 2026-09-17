import { unit } from "@porkbot/testkit";

// The unit tier's policy, pointed at the same flaky fixture: no retries, so the
// first failure is the result.
export default unit({ include: ["test/fixtures/flake/flaky.fixture.ts"] });
