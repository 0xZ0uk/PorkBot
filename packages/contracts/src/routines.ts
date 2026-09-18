import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The routines module (slice 8.5, PRD decision 22): the operator's authoring
 * surface beside the scheduler that slice 8.4 landed.
 *
 * A routine is a first-class row, so the transport is row-shaped: the list and
 * the mutations return the routine's schedule fields, `preview` answers the
 * next fire times before a row exists, `testRun` fires the instruction once
 * outside the schedule, and `outcomes` is the occurrence ledger with each
 * slot's result. The schedule grammar and the DST policy are `@porkbot/core`'s
 * and the row arithmetic is `@porkbot/db`'s; this module only carries their
 * shapes to the client, so a routine edited in a browser and one fired by the
 * scheduler cannot disagree about what the fields mean.
 *
 * Every input is an explicit narrow shape: no space id, no user id, no
 * `next_run_at` and no run status — those are the server's to derive. The one
 * caller-supplied idempotency key is `testRun`'s `clientNonce`, because a
 * retried test run must return the run the first submission created rather
 * than start a second one.
 */

/** What the scheduler decided about one settled slot, read from the run itself. */
export const routineOutcomeStatusSchema = z.enum([
  "success",
  "failure",
  "cancelled",
  "missed",
  "running",
]);

export type RoutineOutcomeStatus = z.infer<typeof routineOutcomeStatusSchema>;

/**
 * One row of a routine's outcome history: the slot and what became of it.
 * `runId` is null exactly when the slot was missed, so a client can tell a
 * schedule that never fired from a run whose row is gone, and can link every
 * other outcome to its run.
 */
export const routineOutcomeSchema = z.object({
  occurrenceId: z.string().min(1),
  scheduledFor: z.iso.datetime(),
  status: routineOutcomeStatusSchema,
  runId: z.string().min(1).nullable(),
});

export type RoutineOutcome = z.infer<typeof routineOutcomeSchema>;

/**
 * A routine as the operator reads it. `nextRunAt` is the cursor the scheduler
 * is waiting on, so the editor shows the pending fire rather than recomputing
 * one; the space and the owner are omitted because the caller already knows
 * the scope it is acting in (PRD decision 7).
 */
export const routineSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  threadId: z.string().min(1),
  instruction: z.string().min(1),
  cron: z.string().min(1),
  timezone: z.string().min(1),
  enabled: z.boolean(),
  nextRunAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Routine = z.infer<typeof routineSchema>;

/**
 * The schedule the editor submits, bounded so a routine's fields stay a row
 * and not a payload. The bounds are the transport's; the grammar's rejection
 * is the typed `BAD_REQUEST` below.
 */
const scheduleFields = {
  instruction: z.string().min(1).max(10_000),
  cron: z.string().min(1).max(200),
  timezone: z.string().min(1).max(100),
} as const;

/**
 * No such routine *in the actor's space*: a missing id, a deleted routine and
 * a routine in another space are intentionally indistinguishable.
 */
const routineNotFoundError = {
  NOT_FOUND: {
    status: 404,
    message: "No such routine in this space",
  },
} as const;

/**
 * The scheduler cannot resolve the submitted schedule: the cron grammar
 * rejected the expression, the timezone is not an IANA zone this runtime
 * knows, or the expression has no fire in its horizon. The client's recovery
 * is to correct the field, not to retry.
 */
const invalidScheduleError = {
  BAD_REQUEST: {
    status: 400,
    message: "The routine schedule is invalid",
  },
} as const;

export const routinesListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/routines",
    operationId: "routinesList",
    summary: "The actor's live routines, all of them or one bot's",
  })
  .input(z.object({ botId: z.string().min(1).optional() }))
  .output(z.object({ routines: z.array(routineSchema) }));

export const routinesCreateContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/routines",
    operationId: "routinesCreate",
    summary: "Create a routine and its dedicated thread",
  })
  .input(z.object({ botId: z.string().min(1), ...scheduleFields }))
  .errors({ ...routineNotFoundError, ...invalidScheduleError })
  .output(routineSchema);

export const routinesUpdateContract = authenticatedProcedure
  .route({
    method: "PATCH",
    path: "/routines/{id}",
    operationId: "routinesUpdate",
    summary: "Edit, pause or re-enable a routine",
  })
  .input(
    z.object({
      id: z.string().min(1),
      instruction: scheduleFields.instruction.optional(),
      cron: scheduleFields.cron.optional(),
      timezone: scheduleFields.timezone.optional(),
      enabled: z.boolean().optional(),
    }),
  )
  .errors({ ...routineNotFoundError, ...invalidScheduleError })
  .output(routineSchema);

export const routinesRemoveContract = authenticatedProcedure
  .route({
    method: "DELETE",
    path: "/routines/{id}",
    operationId: "routinesRemove",
    summary: "Tombstone a routine, keeping its thread and its history",
  })
  .input(z.object({ id: z.string().min(1) }))
  .errors(routineNotFoundError)
  .output(z.object({ id: z.string().min(1) }));

export const routinesPreviewContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/routines/preview",
    operationId: "routinesPreview",
    summary: "The next fire times for a schedule the operator is editing",
  })
  .input(
    z.object({
      cron: scheduleFields.cron,
      timezone: scheduleFields.timezone,
      count: z.number().int().min(1).max(10).optional(),
    }),
  )
  .errors(invalidScheduleError)
  .output(z.object({ fireTimes: z.array(z.iso.datetime()) }));

export const routinesTestRunContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/routines/{id}/test-runs",
    operationId: "routinesTestRun",
    summary: "Fire a routine once, now, and link the run it created",
  })
  .input(z.object({ id: z.string().min(1), clientNonce: z.string().min(1).max(200) }))
  .errors(routineNotFoundError)
  .output(z.object({ runId: z.string().min(1), threadId: z.string().min(1) }));

export const routinesOutcomesContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/routines/{id}/outcomes",
    operationId: "routinesOutcomes",
    summary: "A routine's settled slots with each run's result",
  })
  .input(
    z.object({
      id: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
  )
  .errors(routineNotFoundError)
  .output(z.object({ outcomes: z.array(routineOutcomeSchema) }));
