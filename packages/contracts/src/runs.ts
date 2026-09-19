import { RUN_STATUSES } from "@porkbot/core";
import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The run module: the operator's control over a single run (slice 6.7, story
 * 21).
 *
 * A stop is a request, not a transition: the API records the mark on the run
 * row and the worker executing the run observes it, cancels the live session
 * and settles the row through the ordinary fenced write. That is what lets the
 * cancellation carry the session's own event sequence and the lease release,
 * and it is why this procedure answers with the run's state rather than a
 * promised outcome.
 *
 * The procedure is idempotent: stopping a run that is already stopping returns
 * the same mark, and stopping one that already finished returns its terminal
 * state — the second click is the same answer, never an error and never a
 * second effect. A run in another space is the shared typed `NOT_FOUND`.
 */

export const runStatusSchema = z.enum(RUN_STATUSES);

export const runStopSchema = z.object({
  id: z.string().min(1),
  status: runStatusSchema,
  /**
   * When the operator's stop was recorded, or `null` when the run was already
   * terminal and needed no mark. A second stop keeps the first instant.
   */
  stopRequestedAt: z.iso.datetime().nullable(),
});

export type RunStop = z.infer<typeof runStopSchema>;

export const runsStopContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/runs/{runId}/stop",
    operationId: "runsStop",
    summary: "Ask a live run to stop; a finished run answers with its state",
  })
  .input(z.object({ runId: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such run in this space",
    },
  })
  .output(runStopSchema);
