import type { AnyContractProcedure } from "@orpc/contract";
import { COMPUTER_STATES, PROVIDER_FAILURE_KINDS } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { appContract } from "./contract.ts";
import {
  computerDirectoryViewSchema,
  computerFileViewSchema,
  computerProvidersViewSchema,
  computerProviderSchema,
  computerStateSchema,
  computerTerminalViewSchema,
  computerViewSchema,
  maxComputerOutputBytes,
  maxComputerPathLength,
  maxTerminalCommandLength,
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

/** Whether one procedure's declared input schema accepts a value. */
function acceptsInput(procedure: AnyContractProcedure, input: unknown): boolean {
  const schema = procedure["~orpc"].inputSchema;

  return schema !== undefined && schema.safeParse(input).success;
}

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

  it("carries the lifecycle, snapshot, selection, terminal and file procedures under the contract's computers key", () => {
    expect(Object.keys(appContract.computers).sort()).toEqual([
      "boot",
      "file",
      "files",
      "providers",
      "recover",
      "reset",
      "restore",
      "snapshot",
      "snapshots",
      "status",
      "stop",
      "terminal",
    ]);
  });

  it("bounds the terminal input and the file view's path and bytes", () => {
    expect(maxTerminalCommandLength).toBe(16_384);
    expect(maxComputerPathLength).toBe(4_096);
    expect(maxComputerOutputBytes).toBe(65_536);

    expect(
      computerDirectoryViewSchema.safeParse({
        path: "",
        entries: [{ name: "notes.md", kind: "file", sizeBytes: 12 }],
      }).success,
    ).toBe(true);
    expect(
      computerDirectoryViewSchema.safeParse({
        path: "",
        entries: [{ name: "notes.md", kind: "pipe", sizeBytes: 12 }],
      }).success,
    ).toBe(false);
    expect(
      computerTerminalViewSchema.safeParse({
        exitCode: 0,
        stdout: "hi\n",
        stderr: "",
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      computerFileViewSchema.safeParse({ path: "notes.md", content: "hi", truncated: true })
        .success,
    ).toBe(true);
  });

  it("refuses a path or command carrying a NUL byte at the transport", () => {
    const nul = "notes\u0000.md";

    expect(acceptsInput(appContract.computers.file, { botId: "b", path: nul })).toBe(false);
    expect(acceptsInput(appContract.computers.files, { botId: "b", path: nul })).toBe(false);
    expect(acceptsInput(appContract.computers.terminal, { botId: "b", command: nul })).toBe(false);
    expect(acceptsInput(appContract.computers.file, { botId: "b", path: "notes.md" })).toBe(true);
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
