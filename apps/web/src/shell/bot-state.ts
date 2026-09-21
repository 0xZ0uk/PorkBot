import type { RunLiveness } from "@porkbot/contracts";
import type { StateChipState } from "@porkbot/ui";

/**
 * The shell's half of the state vocabulary (design record, State vocabulary).
 *
 * The full roster state — a bot is idle, working, stuck, failed or stopped
 * from its runs — arrives with the roster and run-surface slices. The shell
 * knows two things today: a live run it is subscribed to (the thread route
 * reports its liveness) and a pending approval, which the API can list for
 * every bot. A bot whose state the shell cannot know renders no chip rather
 * than an "Idle" it cannot stand behind.
 */

/** A pending approval is the loudest state; it is the one the product is about. */
export function stateFromPending(pending: number): StateChipState | null {
  return pending > 0 ? "waiting" : null;
}

/** A run's liveness as one of the six words the operator reads. */
export function stateFromLiveness(liveness: RunLiveness | null): StateChipState | null {
  if (liveness === null) {
    return null;
  }

  switch (liveness.state) {
    case "starting":
    case "thinking":
    case "working":
      return "working";
    case "waiting":
      return "waiting";
    case "stopping":
      return "stopped";
    case "stuck":
      return "stuck";
  }
}
