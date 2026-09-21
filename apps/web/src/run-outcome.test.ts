import type { RunSnapshot, ToolCallSnapshot } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import { maxTargetLength, runOutcome, toolTarget } from "./run-outcome.ts";

/**
 * The report card's derivation: one ✓ line per completed call and one → line
 * per thing the operator reads, read from the same reduced events the timeline
 * renders. The target is the one-line argument summary the collapsed timeline
 * entry shares, so the card and the entry name the same thing.
 */

function call(overrides: Partial<ToolCallSnapshot> = {}): ToolCallSnapshot {
  return { callId: "call-1", tool: "shell", arguments: {}, status: "requested", ...overrides };
}

function run(overrides: Partial<RunSnapshot> = {}): RunSnapshot {
  return { runId: "run-1", status: "completed", toolCalls: [], ...overrides };
}

describe("the one-line target", () => {
  it("prefers the argument that names what the call acted on", () => {
    expect(toolTarget(call({ arguments: { command: "ls -la" } }))).toBe("ls -la");
    expect(toolTarget(call({ tool: "file_read", arguments: { path: "notes.txt" } }))).toBe(
      "notes.txt",
    );
    expect(
      toolTarget(
        call({ tool: "browser", arguments: { action: "open", url: "https://x.example" } }),
      ),
    ).toBe("https://x.example");
    expect(toolTarget(call({ tool: "web_search", arguments: { query: "release notes" } }))).toBe(
      "release notes",
    );
  });

  it("collapses a multi-line value into one line", () => {
    expect(toolTarget(call({ arguments: { command: "echo one\necho two" } }))).toBe(
      "echo one echo two",
    );
  });

  it("cuts a value that would not fit one line", () => {
    const target = toolTarget(call({ arguments: { command: "x".repeat(maxTargetLength * 2) } }));

    expect(target).toHaveLength(maxTargetLength);
    expect(target?.endsWith("…")).toBe(true);
  });

  it("falls back to the compact arguments when no field names the target", () => {
    expect(toolTarget(call({ tool: "mcp__mail__bulk", arguments: { archived: 26 } }))).toBe(
      '{"archived":26}',
    );
  });

  it("has no target for a call with nothing to name", () => {
    expect(toolTarget(call({ arguments: {} }))).toBeNull();
    expect(toolTarget(call({ arguments: 7 }))).toBeNull();
    expect(toolTarget(call({ arguments: { command: "  " } }))).toBeNull();
  });
});

describe("the run's outcome lines", () => {
  it("reads a completed call as done, with its target", () => {
    expect(
      runOutcome(
        run({
          toolCalls: [call({ status: "completed", arguments: { command: "ls" }, durationMs: 120 })],
        }),
      ),
    ).toEqual([{ kind: "done", text: "shell — ls" }]);
  });

  it("reads a failure as a follow-up, with the reason the run recorded", () => {
    expect(
      runOutcome(
        run({
          status: "failed",
          toolCalls: [
            call({
              status: "failed",
              tool: "rm",
              error: 'tool "rm" failed (timed_out): no answer before the deadline',
            }),
          ],
        }),
      ),
    ).toEqual([
      { kind: "follow_up", text: 'tool "rm" failed (timed_out): no answer before the deadline' },
    ]);
  });

  it("hands off a produced file as a follow-up of its own", () => {
    expect(
      runOutcome(
        run({
          toolCalls: [
            call({
              status: "completed",
              tool: "file_write",
              arguments: { path: "report.md" },
              result: {
                ok: true,
                artifact: {
                  id: "01900000-0000-7000-8000-00000000a1f0",
                  filename: "summary.md",
                  sizeBytes: 2_048,
                },
              },
            }),
          ],
        }),
      ),
    ).toEqual([
      { kind: "done", text: "file_write — report.md" },
      { kind: "follow_up", text: "Handed off summary.md" },
    ]);
  });

  it("reads a denied or expired gate as a follow-up rather than a silent call", () => {
    expect(
      runOutcome(
        run({
          toolCalls: [
            call({
              tool: "gmail.send",
              approval: { status: "denied", expiresAt: "2026-01-01T00:05:00.000Z" },
            }),
            call({
              callId: "call-2",
              tool: "shell",
              approval: { status: "timed_out", expiresAt: "2026-01-01T00:05:00.000Z" },
            }),
            call({
              callId: "call-3",
              tool: "browser",
              approval: { status: "pending", expiresAt: "2026-01-01T00:05:00.000Z" },
            }),
          ],
        }),
      ),
    ).toEqual([
      { kind: "follow_up", text: "gmail.send — denied by you" },
      { kind: "follow_up", text: "shell — approval expired" },
    ]);
  });

  it("carries a run that failed before its first call", () => {
    expect(
      runOutcome(run({ status: "failed", failure: { message: "the model connection dropped" } })),
    ).toEqual([{ kind: "follow_up", text: "the model connection dropped" }]);
  });

  it("has nothing to say about a completed run that called nothing", () => {
    expect(runOutcome(run())).toEqual([]);
  });
});
