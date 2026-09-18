import type { RoutineOutcomeRecord, RoutineRecord, RoutinePatch } from "@porkbot/db";
import type { Routine, RoutineOutcome } from "@porkbot/contracts";
import { authenticated } from "../gate.ts";

/**
 * The routines router (slice 8.5, PRD decision 22): the operator's authoring
 * surface over the routine store slice 8.4 landed.
 *
 * Every handler is a read or a command scoped to the actor's space: the
 * repository binds the space predicate, so a routine in another space and a
 * routine that does not exist arrive as the same `NotFoundError`, and the
 * router does not catch it — the gate's error boundary maps it to the
 * contract's typed answer (PRD decision 28). The schedule errors the store
 * raises for a bad cron or timezone travel the same path, which is what makes
 * an invalid submission a typed 400 instead of a 500.
 *
 * The record-to-output mapping is transport translation and nothing more: ISO
 * instants for the wire and a field set the contract fixed. No handler picks a
 * space, computes a fire time or inspects a raw error, so the client's view is
 * the row's and the scheduler's view is unchanged.
 */
export function createRoutinesRouter() {
  const list = authenticated.routines.list.handler(async ({ input, context }) => {
    const records =
      input.botId === undefined
        ? await context.repositories.routines.list()
        : await context.repositories.routines.listForBot(input.botId);

    return { routines: records.map(routineOutput) };
  });

  const create = authenticated.routines.create.handler(async ({ input, context }) => {
    const record = await context.repositories.routines.create({
      botId: input.botId,
      instruction: input.instruction,
      cron: input.cron,
      timezone: input.timezone,
    });

    return routineOutput(record);
  });

  const update = authenticated.routines.update.handler(async ({ input, context }) => {
    // Absent keys are left untouched and `exactOptionalPropertyTypes` keeps
    // "absent" and "explicitly undefined" apart, so the patch is built from
    // the keys the caller actually sent.
    const patch: RoutinePatch = {
      ...(input.instruction === undefined ? {} : { instruction: input.instruction }),
      ...(input.cron === undefined ? {} : { cron: input.cron }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    };

    const record = await context.repositories.routines.update(input.id, patch);

    return routineOutput(record);
  });

  const remove = authenticated.routines.remove.handler(async ({ input, context }) => {
    const record = await context.repositories.routines.remove(input.id);

    return { id: record.id };
  });

  const preview = authenticated.routines.preview.handler(async ({ input, context }) => {
    const fireTimes = await context.repositories.routines.preview(
      input.cron,
      input.timezone,
      input.count,
    );

    return { fireTimes: fireTimes.map((fireTime) => fireTime.toISOString()) };
  });

  const testRun = authenticated.routines.testRun.handler(async ({ input, context }) => {
    const run = await context.repositories.routines.testRun(input.id, input.clientNonce);

    return { runId: run.id, threadId: run.threadId };
  });

  const outcomes = authenticated.routines.outcomes.handler(async ({ input, context }) => {
    const records = await context.repositories.routines.outcomes(input.id, input.limit);

    return { outcomes: records.map(outcomeOutput) };
  });

  return authenticated.routines.router({
    list,
    create,
    update,
    remove,
    preview,
    testRun,
    outcomes,
  });
}

function routineOutput(record: RoutineRecord): Routine {
  return {
    id: record.id,
    botId: record.botId,
    threadId: record.threadId,
    instruction: record.instruction,
    cron: record.cron,
    timezone: record.timezone,
    enabled: record.enabled,
    nextRunAt: record.nextRunAt.toISOString(),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function outcomeOutput(record: RoutineOutcomeRecord): RoutineOutcome {
  return {
    occurrenceId: record.occurrenceId,
    scheduledFor: record.scheduledFor.toISOString(),
    status: record.status,
    runId: record.runId,
  };
}
