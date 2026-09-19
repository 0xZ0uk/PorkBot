import { COMPUTER_STATES, PROVIDER_FAILURE_KINDS } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { appContract } from "./contract.ts";
import {
  computerProvidersViewSchema,
  computerProviderSchema,
  computerStateSchema,
  computerViewSchema,
} from "./computers.ts";

/**
 * The computer contract's drift checks (slices 7.1 and 9.4).
 *
 * The state vocabulary belongs to `@porkbot/adapter-kit` — lifecycle code
 * branches on it — and the contract mirrors it for the wire. The pin fails
 * when a state is added or removed on either side, and the selection view's
 * failure kinds are pinned the same way. Another check walks the contract tree
 * to the computers procedures, so renaming or dropping one is a change a
 * reviewer sees here as well as in the router.
 */

describe("the computer contract", () => {
  it("mirrors the adapter-kit computer state vocabulary", () => {
    expect(computerStateSchema.options).toEqual([...COMPUTER_STATES]);
  });

  it("mirrors the adapter-kit provider failure vocabulary in the selection view", () => {
    expect(computerProviderSchema.shape.failure.unwrap().options).toEqual([
      ...PROVIDER_FAILURE_KINDS,
    ]);
  });

  it("accepts an available and an unavailable provider, and refuses an unknown failure kind", () => {
    expect(
      computerProvidersViewSchema.safeParse({
        defaultKind: "offline",
        providers: [
          { kind: "offline", available: true, failure: null },
          { kind: "daytona", available: false, failure: "auth_failed" },
        ],
      }).success,
    ).toBe(true);
    expect(
      computerProvidersViewSchema.safeParse({
        defaultKind: "offline",
        providers: [{ kind: "offline", available: false, failure: "unreachable" }],
      }).success,
    ).toBe(false);
  });

  it("carries the lifecycle, snapshot and selection procedures under the contract's computers key", () => {
    expect(Object.keys(appContract.computers).sort()).toEqual([
      "boot",
      "providers",
      "recover",
      "reset",
      "restore",
      "snapshot",
      "snapshots",
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
