import { assessRunLiveness } from "@porkbot/core";
import type { RunGet, RunStop } from "@porkbot/contracts";
import type { RunRecord } from "@porkbot/db";
import { authenticated } from "../gate.ts";

/**
 * The runs router: the operator's one direct command over a single run (slice
 * 6.7, story 21) and the liveness read that answers what it is doing (slice
 * 6.10, story 22).
 *
 * `stop` records the durable request; it does not transition the run itself.
 * The worker executing the run observes the mark, cancels its live session and
 * settles the row through the fenced write it already owns, so the response
 * reports the run's state rather than promising an outcome. The repository
 * binds the actor's space, so a foreign or missing run is the contract's typed
 * `NOT_FOUND`, and a run that already finished answers with its terminal state
 * — a second click is the same answer, never an error.
 *
 * `get` assesses the row at the instant of the request with the one function
 * in `@porkbot/core`, so the console's poll renders the same numbers a reload
 * would and the notification path reads the same policy. A terminal or queued
 * run answers `liveness: null` rather than an invented step.
 */
export function createRunsRouter() {
  const get = authenticated.runs.get.handler(async ({ input, context }) =>
    runOutput(await context.repositories.runs.findById(input.runId)),
  );

  const stop = authenticated.runs.stop.handler(async ({ input, context }) =>
    stopOutput(await context.repositories.runs.requestStop(input.runId)),
  );

  return authenticated.runs.router({ get, stop });
}

/** The row-to-wire mapping; the contract's schema is the only output shape. */
function runOutput(run: RunRecord): RunGet {
  const liveness = assessRunLiveness(run, new Date());

  return {
    id: run.id,
    status: run.status,
    liveness:
      liveness === null
        ? null
        : {
            state: liveness.state,
            tool: liveness.tool,
            heartbeatLagMs: liveness.heartbeatLagMs,
            sinceProgressMs: liveness.sinceProgressMs,
          },
  };
}

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
