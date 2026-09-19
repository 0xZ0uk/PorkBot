import { COMPUTER_STATES } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { appContract } from "./contract.ts";
import { computerStateSchema, computerViewSchema } from "./computers.ts";

/**
 * The computer contract's two drift checks (slice 7.1).
 *
 * The state vocabulary belongs to `@porkbot/adapter-kit` — lifecycle code
 * branches on it — and the contract mirrors it for the wire. The pin fails
 * when a state is added or removed on either side. The second check walks the
 * contract tree to the computers procedures, so renaming or dropping one is a
 * change a reviewer sees here as well as in the router.
 */

describe("the computer contract", () => {
  it("mirrors the adapter-kit computer state vocabulary", () => {
    expect(computerStateSchema.options).toEqual([...COMPUTER_STATES]);
  });

  it("carries the five lifecycle procedures under the contract's computers key", () => {
    expect(Object.keys(appContract.computers).sort()).toEqual([
      "boot",
      "recover",
      "reset",
      "status",
      "stop",
    ]);
  });

  it("answers an unassigned bot without a state and an assigned one with it", () => {
    expect(computerViewSchema.safeParse({ assigned: false }).success).toBe(true);
    expect(
      computerViewSchema.safeParse({ assigned: true, state: "running", instanceId: "i-1" }).success,
    ).toBe(true);
    expect(computerViewSchema.safeParse({ assigned: true, state: "zombie" }).success).toBe(false);
    expect(computerViewSchema.safeParse({ assigned: true }).success).toBe(false);
  });
});
