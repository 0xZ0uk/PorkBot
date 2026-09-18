import { decideRoutineDue, parseRoutineCron, RoutineScheduleError } from "@porkbot/core";
import {
  createRepositories,
  findQueuedRoutineRuns,
  listDueRoutines,
  ROUTINE_SCHEDULER_BATCH_LIMIT,
} from "@porkbot/db";
import type { DueRoutine, Queryable } from "@porkbot/db";
import { JobPayloadError } from "../job-registry.ts";
import type { JobContext, JobDefinition } from "../job-registry.ts";
import { systemActorForJob } from "../system-actor.ts";
import { runExecuteIdentifier } from "./run-execute.ts";

/**
 * The routine scheduler (slice 8.4, PRD decision 22): the minute job that
 * turns a due schedule row into an ordinary run.
 *
 * The job's whole product is a delivery. It never executes anything: it
 * settles at most one slot per routine by calling the same run-creation
 * command the message path uses, and then enqueues `run.execute` with the new
 * run's id and fence — the lease, the heartbeat, the watchdog and the resume
 * behaviour are the ones that already exist, and the scheduler adds no second
 * executor.
 *
 * Three properties are the design:
 *
 *   - **The decision is pure and the clock is the database's.** The scan
 *     carries `now()` on every row, and `decideRoutineDue` compares it with the
 *     slot. A host clock that disagrees with Postgres cannot fire early or
 *     mislabel a slot, because the host's clock is never consulted.
 *   - **Settling is idempotent by construction.** The fire and miss commands
 *     lock the routine row and dedupe the slot in the occurrence ledger, so a
 *     retried tick that re-addresses a slot writes nothing and is answered by
 *     the row. The enqueue's `jobKey` collapses duplicate deliveries the same
 *     way.
 *   - **A stranded delivery is recovered.** A run whose enqueue failed after
 *     its creation would otherwise sit `queued` and unowned forever; every
 *     tick re-addresses routine runs older than the dispatch grace, which is
 *     what makes the queue a delivery mechanism rather than a single point of
 *     loss.
 *
 * A schedule row that cannot be parsed or has no fire within its horizon is
 * logged and skipped rather than retried forever: the API validates every
 * write, so such a row can only come from a manual edit, and one bad row must
 * not stop every other routine from firing.
 */

export const routineTickIdentifier = "routine.tick";

/**
 * The payload carries nothing: the tick addresses no routine and receives no
 * work. Graphile's cron scheduler adds a `_cron` marker to deliveries it
 * schedules, so that one field is tolerated and dropped; anything else is a
 * producer smuggling work into a payload that has no use for it.
 */
export type RoutineTickPayload = Record<never, never>;

export function parseRoutineTickPayload(payload: unknown): RoutineTickPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new JobPayloadError(routineTickIdentifier, "must be an object");
  }

  for (const key of Object.keys(payload)) {
    if (key !== "_cron") {
      throw new JobPayloadError(
        routineTickIdentifier,
        `carries "${key}"; the scheduler addresses no routine and never carries work`,
      );
    }
  }

  return {};
}

export interface RoutineTickOptions {
  /** How many due routines and stranded runs one pass addresses. */
  readonly batchLimit?: number;
}

type SlotOutcome = "fired" | "missed" | "skipped" | "invalid" | "failed";

export function routineTickJob(
  options: RoutineTickOptions = {},
): JobDefinition<RoutineTickPayload> {
  const batchLimit = options.batchLimit ?? ROUTINE_SCHEDULER_BATCH_LIMIT;

  return {
    identifier: routineTickIdentifier,
    parse: parseRoutineTickPayload,
    async handle(_payload, context): Promise<void> {
      await context.withPgClient(async (client) => {
        const due = await listDueRoutines(client, batchLimit);
        const outcomes = new Map<SlotOutcome, number>();

        for (const candidate of due) {
          const outcome = await settleSafely(candidate, context, client);
          outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
        }

        const dispatched = await dispatchQueuedRuns(context, client, batchLimit);

        context.logger.info("routine tick complete", {
          scanned: due.length,
          fired: outcomes.get("fired") ?? 0,
          missed: outcomes.get("missed") ?? 0,
          skipped: outcomes.get("skipped") ?? 0,
          invalid: outcomes.get("invalid") ?? 0,
          failed: outcomes.get("failed") ?? 0,
          dispatched,
        });
      });
    },
  };
}

/**
 * One slot's failure is one slot's failure: an unexpected error settling a
 * candidate is logged and the pass moves on, so a single bad row cannot stop
 * every other routine from firing. The failed slot stays due and is retried
 * on the next tick, and the reconciliation below still runs.
 */
async function settleSafely(
  candidate: DueRoutine,
  context: JobContext,
  client: Queryable,
): Promise<SlotOutcome> {
  try {
    return await settleSlot(candidate, context, client);
  } catch (error) {
    context.logger.child({ routineId: candidate.id }).error("routine slot failed to settle", {
      error: error instanceof Error ? error.message : String(error),
    });
    return "failed";
  }
}

/**
 * One due routine, settled at most one slot. The scan is cross-space and the
 * write is scoped: the `SystemActor` is derived from the candidate's space,
 * exactly as the watchdog derives it, so the routine's fire command re-reads
 * it inside that space and nothing here ever holds a repository that spans
 * spaces.
 */
async function settleSlot(
  candidate: DueRoutine,
  context: JobContext,
  client: Queryable,
): Promise<SlotOutcome> {
  const logger = context.logger.child({ routineId: candidate.id });
  const actor = systemActorForJob({ jobId: context.jobId, spaceId: candidate.spaceId });
  const repositories = createRepositories(actor, client);

  let decision: ReturnType<typeof decideRoutineDue>;

  try {
    decision = decideRoutineDue({
      cron: parseRoutineCron(candidate.cron),
      timezone: candidate.timezone,
      nextRunAt: candidate.nextRunAt,
      now: candidate.now,
    });
  } catch (error) {
    if (error instanceof RoutineScheduleError) {
      logger.warn("routine tick skipped a schedule it cannot resolve", {
        error: error.message,
        cron: candidate.cron,
        timezone: candidate.timezone,
      });
      return "invalid";
    }

    throw error;
  }

  if (decision.action === "wait") {
    // The scan selected the row against the database's clock and the decision
    // read the same clock, so this only happens if the row moved between the
    // two statements; the next pass will see the new slot.
    return "skipped";
  }

  if (decision.action === "miss") {
    const recorded = await repositories.routines.recordMissed({
      routineId: candidate.id,
      scheduledFor: decision.scheduledFor,
      nextRunAt: decision.nextRunAt,
    });

    if (recorded === undefined) {
      return "skipped";
    }

    logger.warn("routine slot missed: the schedule passed beyond the grace", {
      scheduledFor: decision.scheduledFor.toISOString(),
      lateByMs: decision.lateByMs,
    });
    return "missed";
  }

  const fired = await repositories.routines.fire({
    routineId: candidate.id,
    scheduledFor: decision.scheduledFor,
    nextRunAt: decision.nextRunAt,
  });

  if (fired === undefined) {
    return "skipped";
  }

  await context.enqueue(
    runExecuteIdentifier,
    { runId: fired.run.id, fence: fired.run.leaseFence, spaceId: fired.run.spaceId },
    // A duplicate delivery for the same run must collapse: the payload
    // addresses the run's fence, and the handler re-reads the row anyway.
    { jobKey: `${runExecuteIdentifier}:${fired.run.id}`, jobKeyMode: "replace" },
  );

  // The run id is the logger's correlation id, so the line carries it the way
  // every run-scoped line does rather than as an event field.
  logger.child({ runId: fired.run.id }).info("routine fired", {
    scheduledFor: decision.scheduledFor.toISOString(),
    lateByMs: decision.lateByMs,
  });
  return "fired";
}

/**
 * Re-addresses routine runs whose delivery never landed. The filter is
 * `queued` and unowned past the grace, so a run a worker already claimed is
 * never touched, and the enqueue's `jobKey` collapses with the original
 * delivery if both somehow exist.
 */
async function dispatchQueuedRuns(
  context: JobContext,
  client: Queryable,
  batchLimit: number,
): Promise<number> {
  const queued = await findQueuedRoutineRuns(client, batchLimit);

  for (const run of queued) {
    await context.enqueue(
      runExecuteIdentifier,
      { runId: run.runId, fence: run.fence, spaceId: run.spaceId },
      { jobKey: `${runExecuteIdentifier}:${run.runId}`, jobKeyMode: "replace" },
    );

    context.logger.child({ runId: run.runId }).info("routine tick re-addressed a stranded run", {});
  }

  return queued.length;
}
