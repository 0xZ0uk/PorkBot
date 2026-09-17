import { e2e } from "@porkbot/testkit";

// A one-second budget, so the proof that a hanging test fails rather than blocks
// does not cost half a minute of CI time. The tier's own timeout is the default;
// see TierOptions["timeouts"].
export default e2e({
  include: ["test/fixtures/flake/hanging.fixture.ts"],
  timeouts: { testTimeout: 1_000, hookTimeout: 1_000, teardownTimeout: 1_000 },
});
