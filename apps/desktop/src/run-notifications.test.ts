import { describe, expect, it } from "vitest";
import {
  clipNotificationBody,
  isSettledRunEvent,
  notificationForRunEvent,
} from "./run-notifications.ts";
import type { RunEvent } from "@porkbot/core";

function event(type: RunEvent["type"], extra: Record<string, unknown> = {}): RunEvent {
  return {
    schemaVersion: 1,
    seq: 1,
    threadId: "thread-1",
    runId: "run-1",
    type,
    ...extra,
  } as RunEvent;
}

describe("run notifications", () => {
  it("says a run completed", () => {
    expect(notificationForRunEvent(event("run.completed"))).toEqual({
      kind: "run.completed",
      title: "Run completed",
      body: "A PorkBot run finished.",
    });
  });

  it("carries the failure's own sentence", () => {
    const notification = notificationForRunEvent(
      event("run.failed", { error: "The model connection refused the request." }),
    );

    expect(notification).toEqual({
      kind: "run.failed",
      title: "Run failed",
      body: "The model connection refused the request.",
    });
  });

  it("stays silent for a cancelled run and for everything that is not a settle", () => {
    expect(notificationForRunEvent(event("run.cancelled"))).toBeNull();
    expect(notificationForRunEvent(event("run.started"))).toBeNull();
    expect(notificationForRunEvent(event("run.steered"))).toBeNull();
    expect(
      notificationForRunEvent(event("token.delta", { messageId: "m", delta: "x" })),
    ).toBeNull();
    expect(
      notificationForRunEvent(event("tool.completed", { callId: "c", result: null })),
    ).toBeNull();
  });

  it("clips an enormous failure sentence", () => {
    const clipped = clipNotificationBody("x".repeat(500));

    expect(clipped.length).toBeLessThanOrEqual(160);
    expect(clipped.endsWith("…")).toBe(true);
    expect(clipNotificationBody("  short  ")).toBe("short");
  });

  it("falls back when a failure carries no sentence", () => {
    const notification = notificationForRunEvent(event("run.failed", { error: "" }));

    expect(notification?.body).toBe("The run failed.");
  });

  it("knows which frames end a run", () => {
    expect(isSettledRunEvent(event("run.completed"))).toBe(true);
    expect(isSettledRunEvent(event("run.failed", { error: "x" }))).toBe(true);
    expect(isSettledRunEvent(event("run.cancelled"))).toBe(true);
    expect(isSettledRunEvent(event("run.started"))).toBe(false);
    expect(isSettledRunEvent(event("token.delta", { messageId: "m", delta: "x" }))).toBe(false);
  });
});
