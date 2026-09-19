import { RUN_LIVENESS_STATES, RUN_STATUSES } from "@porkbot/core";
import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The run module: the operator's control over a single run (slice 6.7, story
 * 21) and the liveness read that answers what it is doing (slice 6.10, story
 * 22).
 *
 * A stop is a request, not a transition: the API records the mark on the run
 * row and the worker executing the run observes it, cancels the live session
 * and settles the row through the ordinary fenced write. That is what lets the
 * cancellation carry the session's own event sequence and the lease release,
 * and it is why this procedure answers with the run's state rather than a
 * promised outcome.
 *
 * The stop procedure is idempotent: stopping a run that is already stopping
 * returns the same mark, and stopping one that already finished returns its
 * terminal state — the second click is the same answer, never an error and
 * never a second effect. A run in another space is the shared typed
 * `NOT_FOUND`.
 *
 * `get` is the assessment read: the API computes it from the run row's
 * persisted liveness at request time with the one implementation in
 * `@porkbot/core`, so a reload renders exactly what a live tick rendered. The
 * console polls it while a run is active, and the notification path consumes
 * the same assessment, which is what "one implementation, two consumers" means
 * here. `liveness` is `null` for a run that is terminal or queued — there is
 * nothing to say.
 */

export const runStatusSchema = z.enum(RUN_STATUSES);

export const runLivenessStateSchema = z.enum(RUN_LIVENESS_STATES);

/**
 * What a running run is doing. `tool` is the tool in flight or awaiting
 * approval when the step names one; the two durations are milliseconds against
 * the server's clock at the instant of the read, so a client renders them
 * without trusting its own clock.
 */
export const runLivenessSchema = z.object({
  state: runLivenessStateSchema,
  tool: z.string().nullable(),
  heartbeatLagMs: z.number().int().nonnegative(),
  sinceProgressMs: z.number().int().nonnegative(),
});

export const runGetSchema = z.object({
  id: z.string().min(1),
  status: runStatusSchema,
  /** `null` when the run is terminal or nobody has claimed it yet. */
  liveness: runLivenessSchema.nullable(),
});

export type RunLiveness = z.infer<typeof runLivenessSchema>;
export type RunGet = z.infer<typeof runGetSchema>;

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

export const runsGetContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/runs/{runId}",
    operationId: "runsGet",
    summary: "One run's liveness: its step, heartbeat lag and progress age",
  })
  .input(z.object({ runId: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such run in this space",
    },
  })
  .output(runGetSchema);
