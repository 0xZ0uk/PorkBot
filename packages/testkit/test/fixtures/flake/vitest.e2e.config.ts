import { e2e } from "@porkbot/testkit";

// The e2e tier's policy, pointed at the fixtures instead of apps/api.
export default e2e({ include: ["test/fixtures/flake/flaky.fixture.ts"] });
