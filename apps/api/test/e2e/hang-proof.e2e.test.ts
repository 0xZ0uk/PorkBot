import { it } from "vitest";

// PROOF (reverted in the next commit): a test that never settles. The tier's
// timeout has to turn this into a failure in seconds, not a job that blocks.
it("never settles", async () => {
  await new Promise<never>(() => {});
}, 2_000);
