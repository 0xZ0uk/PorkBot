import type { RunLiveness } from "@porkbot/contracts";
import type { StateChipState } from "@porkbot/ui";

/**
 * The shell's half of the state vocabulary (design record, State vocabulary).
 *
 * The shell knows two things today: a live run it is subscribed to (the thread
 * route reports its liveness) and a pending approval, which the API can list
 * for every bot. The run-derived words — working, stuck, failed, stopped —
 * render from the same chip once a run read exists; until then the roster
 * answers the operator's own queue and calls every other bot idle.
 */

/** A pending approval is the loudest state; it is the one the product is about. */
export function stateFromPending(pending: number): StateChipState | null {
  return pending > 0 ? "waiting" : null;
}

/**
 * The roster's state: a bot with a pending approval is waiting for the
 * operator, and a bot without one is idle. The header, the rail and the home
 * rows all read this one word, so they cannot disagree about what it means.
 */
export function stateFromRoster(pending: number): StateChipState {
  return stateFromPending(pending) ?? "idle";
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
