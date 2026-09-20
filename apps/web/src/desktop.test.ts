import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "@porkbot/core";
import { forwardRunEvent, isRunLifecycleFrame } from "./desktop.ts";

/**
 * The bridge is a no-op in a browser and a one-way note in the shell, so these
 * tests fake `globalThis.porkbot` and assert the two rules: only the run's own
 * lifecycle frames cross (a token delta is not one), and a malformed bridge is
 * ignored rather than fatal.
 */

function runEvent(type: RunEvent["type"], extra: Record<string, unknown> = {}): RunEvent {
  return {
    schemaVersion: 1,
    seq: 1,
    threadId: "thread-1",
    runId: "run-1",
    type,
    ...extra,
  } as RunEvent;
}

afterEach(() => {
  delete (globalThis as { porkbot?: unknown }).porkbot;
});

describe("the desktop bridge", () => {
  it("is silent when no desktop is hosting the page", () => {
    expect(() => {
      forwardRunEvent(runEvent("run.completed"));
    }).not.toThrow();
  });

  it("forwards the run's lifecycle frames", () => {
    const forwarded: RunEvent[] = [];
    (globalThis as { porkbot?: unknown }).porkbot = {
      forwardRunEvent: (event: RunEvent) => forwarded.push(event),
    };

    const completed = runEvent("run.completed");

    forwardRunEvent(runEvent("run.started"));
    forwardRunEvent(completed);
    forwardRunEvent(runEvent("run.failed", { error: "boom" }));
    forwardRunEvent(runEvent("run.cancelled"));
    forwardRunEvent(runEvent("run.steered", { text: "stop" }));

    expect(forwarded).toHaveLength(5);
    expect(forwarded[1]).toBe(completed);
  });

  it("keeps token deltas and tool frames on this side", () => {
    const forwarded: RunEvent[] = [];
    (globalThis as { porkbot?: unknown }).porkbot = {
      forwardRunEvent: (event: RunEvent) => forwarded.push(event),
    };

    forwardRunEvent(runEvent("token.delta", { messageId: "m", delta: "x" }));
    forwardRunEvent(runEvent("tool.requested", { callId: "c", tool: "shell", arguments: {} }));
    forwardRunEvent(runEvent("tool.completed", { callId: "c", result: null }));
    forwardRunEvent(
      runEvent("approval.requested", { callId: "c", expiresAt: "2026-01-01T00:00:00Z" }),
    );

    expect(forwarded).toEqual([]);
  });

  it("ignores a bridge that is not the one it knows", () => {
    (globalThis as { porkbot?: unknown }).porkbot = { forwardRunEvent: "not a function" };

    expect(() => {
      forwardRunEvent(runEvent("run.completed"));
    }).not.toThrow();
    expect(isRunLifecycleFrame(runEvent("run.completed"))).toBe(true);
    expect(isRunLifecycleFrame(runEvent("token.delta", { messageId: "m", delta: "x" }))).toBe(
      false,
    );
  });
});
