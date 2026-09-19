import type { RunStop } from "@porkbot/contracts";
import { authenticated } from "../gate.ts";

/**
 * The runs router: the operator's one direct command over a single run
 * (slice 6.7, story 21).
 *
 * `stop` records the durable request; it does not transition the run itself.
 * The worker executing the run observes the mark, cancels its live session and
 * settles the row through the fenced write it already owns, so the response
 * reports the run's state rather than promising an outcome. The repository
 * binds the actor's space, so a foreign or missing run is the contract's typed
 * `NOT_FOUND`, and a run that already finished answers with its terminal state
 * — a second click is the same answer, never an error.
 */
export function createRunsRouter() {
  const stop = authenticated.runs.stop.handler(async ({ input, context }) =>
    stopOutput(await context.repositories.runs.requestStop(input.runId)),
  );

  return authenticated.runs.router({ stop });
}

/** The row-to-wire mapping; the contract's schema is the only output shape. */
function stopOutput(run: {
  readonly id: string;
  readonly status: RunStop["status"];
  readonly stopRequestedAt: Date | null;
}): RunStop {
  return {
    id: run.id,
    status: run.status,
    stopRequestedAt: run.stopRequestedAt?.toISOString() ?? null,
  };
}
