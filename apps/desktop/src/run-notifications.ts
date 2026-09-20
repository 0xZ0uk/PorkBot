/**
 * What a settled run says on the desktop (slice 11.6).
 *
 * The web console reduces the stream; the desktop never parses an event of its
 * own. The renderer forwards the run lifecycle frames it already reduced across
 * the preload bridge, and this module turns the terminal ones into the two
 * fields a native notification needs. A cancelled run is the operator's own
 * action, so it says nothing; a failure carries the error the run reported,
 * clipped so an enormous model error cannot own the notification.
 *
 * This is the local, OS-governed channel. The server's notification
 * preferences govern the durable delivery adapters (slice 8.6), not whether a
 * window that is already open tells the operator what happened.
 */

import type { RunEvent } from "@porkbot/core";

export const maxNotificationBodyLength = 160;

export interface RunNotification {
  readonly kind: "run.completed" | "run.failed";
  readonly title: string;
  readonly body: string;
}

/** Clips a sentence to the notification body budget, with an ellipsis. */
export function clipNotificationBody(text: string): string {
  const trimmed = text.trim();

  if (trimmed.length <= maxNotificationBodyLength) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxNotificationBodyLength - 1).trimEnd()}…`;
}

/** The notification for one run event, or `null` when the event says nothing. */
export function notificationForRunEvent(event: RunEvent): RunNotification | null {
  switch (event.type) {
    case "run.completed":
      return {
        kind: "run.completed",
        title: "Run completed",
        body: "A PorkBot run finished.",
      };
    case "run.failed":
      return {
        kind: "run.failed",
        title: "Run failed",
        body: clipNotificationBody(event.error.length > 0 ? event.error : "The run failed."),
      };
    default:
      return null;
  }
}

/** True for a terminal frame: the run will not emit more lifecycle events. */
export function isSettledRunEvent(event: RunEvent): boolean {
  return (
    event.type === "run.completed" || event.type === "run.failed" || event.type === "run.cancelled"
  );
}
