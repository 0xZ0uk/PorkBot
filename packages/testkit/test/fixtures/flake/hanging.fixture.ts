import { it } from "vitest";

// Never settles: the tier's testTimeout has to turn this into a failure, not
// into a job that sits there until CI gives up.
it("never settles", async () => {
  await new Promise<never>(() => {});
});
