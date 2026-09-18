import {
  InvalidRoutineCron,
  InvalidRoutineTimezone,
  isRoutineTimezone,
  nextRoutineFire,
  parseRoutineCron,
  UnreachableRoutineSchedule,
} from "@porkbot/core";
import { InvalidRoutineScheduleError } from "@porkbot/effect";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { requiredRow } from "./rows.ts";
import { routineColumns, routineOccurrenceColumns } from "./records.ts";
import type {
  RoutineOccurrenceRecord,
  RoutineOutcomeRecord,
  RoutineRecord,
  RunRecord,
} from "./records.ts";
import { createRoutineRun, createRoutineTestRun } from "./run-creation.ts";
import type { CreatedRoutineRun, NewRoutineRun } from "./run-creation.ts";
import { withTransaction } from "./transaction.ts";

/**
 * The durable half of routines (slice 8.4, PRD decision 22): the schedule
 * rows, the occurrence ledger, and the two commands the scheduler uses.
 *
 * The operator's half and the scheduler's half live here together because they
 * are two views of one row. An operator creates, edits, pauses and deletes
 * through the actor-scoped repository and never touches a slot; the scheduler
 * reads due rows across spaces, settles exactly one slot per pass, and never
 * sees a routine through an actor it was not derived from. Keeping both halves
 * in one module is what makes "who may change a schedule" auditable.
 *
 * The schedule itself is `@porkbot/core`'s, not this module's: every boundary
 * where a cron string or a timezone enters — create, edit, re-enable — parses
 * through `parseRoutineCron` and `nextRoutineFire` with the database's clock,
 * so an invalid expression is a typed core error before a row exists, and
 * `next_run_at` is never computed from the app host's clock. `next_run_at` is
 * a stored instant rather than a computed one because the scheduler's CAS and
 * the occurrence ledger both key on it.
 *
 * Two reads are deliberately cross-space and take no actor, exactly as
 * `findExpiredLeases` is: a scheduler pass cannot start from an actor because
 * the space it needs comes from the row it has not found yet. `listDueRoutines`
 * returns addressing plus the schedule fields the decision needs, and every
 * write that follows goes through a `SystemActor` for the row's space, so the
 * scope is still enforced one step later. Neither is reachable through
 * `createRoutineStore`.
 */

/** How many due routines one scheduler pass addresses. */
export const ROUTINE_SCHEDULER_BATCH_LIMIT = 50;

/** How many outcomes a routine history read returns without an explicit limit. */
export const ROUTINE_OUTCOME_DEFAULT_LIMIT = 20;

/** The most outcomes one history read returns, so a caller cannot ask for all of them. */
export const ROUTINE_OUTCOME_MAX_LIMIT = 200;

/** How many fire times a schedule preview returns without an explicit count. */
export const ROUTINE_PREVIEW_DEFAULT_COUNT = 5;

/** The most fire times one preview returns, so a caller cannot ask for years of them. */
export const ROUTINE_PREVIEW_MAX_COUNT = 10;

/**
 * How long a queued routine run may sit unclaimed before the scheduler
 * re-enqueues it. The initial delivery and its job are written a moment apart,
 * so this is longer than that gap and shorter than a lost run is acceptable.
 */
export const ROUTINE_DISPATCH_GRACE_SECONDS = 60;

/** What an operator supplies to create a routine; the thread is created with it. */
export interface NewRoutine {
  readonly botId: string;
  readonly instruction: string;
  readonly cron: string;
  readonly timezone: string;
}

/** The mutable routine fields; an absent key is left untouched. */
export interface RoutinePatch {
  readonly instruction?: string;
  readonly cron?: string;
  readonly timezone?: string;
  readonly enabled?: boolean;
}

export interface RoutineReader {
  /** Throws `NotFoundError` for a missing id, a deleted routine and another space alike. */
  findById(id: string): Promise<RoutineRecord>;
  list(): Promise<readonly RoutineRecord[]>;
  listForBot(botId: string): Promise<readonly RoutineRecord[]>;
  /** The outcome history, newest first; the routine is validated first. */
  outcomes(routineId: string, limit?: number): Promise<readonly RoutineOutcomeRecord[]>;
  /** The most recent settled slot, or undefined when the routine never fired. */
  lastOutcome(routineId: string): Promise<RoutineOutcomeRecord | undefined>;
  /**
   * The next fire times for a submitted schedule, computed from the
   * database's clock — the same clock every write and the scheduler use. An
   * invalid expression, an unknown timezone and an unreachable schedule are
   * the typed `InvalidRoutineScheduleError`, so the editor shows the mistake
   * before a row exists rather than after.
   */
  preview(cron: string, timezone: string, count?: number): Promise<readonly Date[]>;
}

export interface RoutineWriter {
  /** Creates the routine and its dedicated thread in one transaction. */
  create(input: NewRoutine): Promise<RoutineRecord>;
  /**
   * Edits a live routine. A schedule edit or a re-enable recomputes
   * `next_run_at` from the database's clock; pausing leaves it untouched.
   */
  update(id: string, patch: RoutinePatch): Promise<RoutineRecord>;
  /**
   * Stops future runs without deleting history: the row is tombstoned and
   * disabled, its thread and runs stay, and the scheduler no longer sees it.
   */
  remove(id: string): Promise<RoutineRecord>;
  /**
   * Fires the routine once, now, outside its schedule: the editor's test run.
   * The run is an ordinary routine run in the routine's thread, deduped by the
   * caller's nonce; the schedule and the occurrence ledger are untouched.
   */
  testRun(id: string, clientNonce: string): Promise<RunRecord>;
}

/** The scheduler's half: settling one slot, and only through a `SystemActor`. */
export interface RoutineScheduler {
  /** Creates the scheduled run and advances the schedule; undefined when superseded. */
  fire(input: NewRoutineRun): Promise<CreatedRoutineRun | undefined>;
  /** Records the slot as missed and advances the schedule; undefined when superseded. */
  recordMissed(input: MissedRoutineOccurrence): Promise<RoutineOccurrenceRecord | undefined>;
}

/** The slot the scheduler's decision marked missed, and the next one to wait on. */
export interface MissedRoutineOccurrence {
  readonly routineId: string;
  readonly scheduledFor: Date;
  readonly nextRunAt: Date;
}

/** One due routine as the scheduler's cross-space scan returns it. */
export interface DueRoutine {
  readonly id: string;
  readonly spaceId: string;
  readonly botId: string;
  readonly userId: string;
  readonly threadId: string;
  readonly instruction: string;
  readonly cron: string;
  readonly timezone: string;
  readonly nextRunAt: Date;
  /** The database's clock for this pass, so the decision needs no host clock. */
  readonly now: Date;
}

/** One queued routine run the dispatcher may re-address. */
export interface QueuedRoutineRun {
  readonly runId: string;
  readonly spaceId: string;
  readonly fence: number;
}

export function createRoutineStore(
  actor: UserActor,
  database: Queryable,
): RoutineReader & RoutineWriter;
export function createRoutineStore(actor: SystemActor, database: Queryable): RoutineScheduler;
export function createRoutineStore(
  actor: UserActor | SystemActor,
  database: Queryable,
): (RoutineReader & RoutineWriter) | RoutineScheduler;
export function createRoutineStore(
  actor: UserActor | SystemActor,
  database: Queryable,
): (RoutineReader & RoutineWriter) | RoutineScheduler {
  if (actor.kind === "system") {
    return {
      fire: (input) => createRoutineRun(actor, database, input),
      recordMissed: (input) => recordMissedOccurrence(actor, database, input),
    };
  }

  return {
    findById: (id) => findRoutine(database, actor.spaceId, id),
    list: () => listRoutines(database, actor.spaceId),
    listForBot: (botId) => listRoutines(database, actor.spaceId, botId),
    outcomes: (routineId, limit) => listOutcomes(database, actor.spaceId, routineId, limit),
    lastOutcome: async (routineId) => {
      const rows = await listOutcomes(database, actor.spaceId, routineId, 1);
      return rows[0];
    },
    preview: (cron, timezone, count) => previewRoutineSchedule(database, cron, timezone, count),
    create: (input) => createRoutine(actor, database, input),
    update: (id, patch) => updateRoutine(actor, database, id, patch),
    remove: (id) => removeRoutine(actor, database, id),
    testRun: (id, clientNonce) =>
      createRoutineTestRun(actor, database, { routineId: id, clientNonce }),
  };
}

/**
 * The scheduler's scan: every live, enabled routine whose slot has arrived,
 * oldest slot first.
 *
 * This is a deliberate cross-space read, the same exception the lease watchdog
 * makes and for the same reason, and it returns addressing plus the schedule
 * fields only — no run, no work, no checkpoint. The `now()` column is the
 * database's clock, carried on each row so the pure `decideRoutineDue` call
 * that follows cannot disagree with the `next_run_at <= now()` predicate that
 * selected the row.
 */
export async function listDueRoutines(
  database: Queryable,
  limit: number = ROUTINE_SCHEDULER_BATCH_LIMIT,
): Promise<readonly DueRoutine[]> {
  const { rows } = await database.query<DueRoutine>(
    'select id, space_id as "spaceId", bot_id as "botId", user_id as "userId", ' +
      'thread_id as "threadId", instruction, cron, timezone, next_run_at as "nextRunAt", ' +
      'now() as "now" from routine ' +
      "where enabled and deleted_at is null and next_run_at <= now() " +
      "order by next_run_at asc, id asc limit $1",
    [limit],
  );

  return rows;
}

/**
 * The dispatcher's reconciliation read: routine-triggered runs that are still
 * queued and unowned after the delivery grace.
 *
 * The scheduler creates a run and then enqueues its `run.execute` delivery;
 * if the process died between the two, the run row exists and no job points at
 * it, which neither the schedule (already advanced) nor the lease watchdog
 * (which scans active leases) would notice. This read is how a stranded run is
 * found and re-delivered. Like the due scan it is cross-space and addressing
 * only, and the handler that runs the delivery re-reads the run through a
 * `SystemActor` before anything acts on it.
 */
export async function findQueuedRoutineRuns(
  database: Queryable,
  limit: number = ROUTINE_SCHEDULER_BATCH_LIMIT,
  graceSeconds: number = ROUTINE_DISPATCH_GRACE_SECONDS,
): Promise<readonly QueuedRoutineRun[]> {
  const { rows } = await database.query<QueuedRoutineRun>(
    'select id as "runId", space_id as "spaceId", lease_fence as "fence" from run ' +
      "where trigger = 'routine' and status = 'queued' and lease_owner is null " +
      "and created_at <= now() - make_interval(secs => $2) " +
      "order by created_at asc, id asc limit $1",
    [limit, graceSeconds],
  );

  return rows;
}

async function findRoutine(
  database: Queryable,
  spaceId: string,
  id: string,
): Promise<RoutineRecord> {
  const { rows } = await database.query<RoutineRecord>(
    `select ${routineColumns} from routine where id = $1 and space_id = $2 and deleted_at is null`,
    [id, spaceId],
  );

  return requiredRow(rows, "routine", id);
}

async function listRoutines(
  database: Queryable,
  spaceId: string,
  botId?: string,
): Promise<readonly RoutineRecord[]> {
  const values: unknown[] = [spaceId];
  let predicate = "and deleted_at is null";

  if (botId !== undefined) {
    values.push(botId);
    predicate += ` and bot_id = $${values.length}`;
  }

  const { rows } = await database.query<RoutineRecord>(
    `select ${routineColumns} from routine where space_id = $1 ${predicate} ` +
      "order by created_at asc, id asc",
    values,
  );

  return rows;
}

/**
 * The outcome history: each occurrence with its run's status mapped onto the
 * shared vocabulary, newest slot first. The routine is read first, so a
 * routine outside the actor's space is a `NotFoundError` and a routine with no
 * outcomes is an empty list — the two are different answers.
 */
async function listOutcomes(
  database: Queryable,
  spaceId: string,
  routineId: string,
  limit?: number,
): Promise<readonly RoutineOutcomeRecord[]> {
  await findRoutine(database, spaceId, routineId);

  const { rows } = await database.query<RoutineOutcomeRecord>(
    'select occurrence.id as "occurrenceId", occurrence.scheduled_for as "scheduledFor", ' +
      'occurrence.run_id as "runId", ' +
      "case " +
      "when occurrence.run_id is null then 'missed' " +
      "when run.status = 'completed' then 'success' " +
      "when run.status = 'failed' then 'failure' " +
      "when run.status = 'cancelled' then 'cancelled' " +
      "else 'running' end as status " +
      "from routine_occurrence occurrence " +
      "left join run run on run.id = occurrence.run_id " +
      "where occurrence.routine_id = $1 " +
      "order by occurrence.scheduled_for desc, occurrence.id desc limit $2",
    [routineId, outcomeLimit(limit)],
  );

  return rows;
}

/**
 * Bounds a caller's history request. The default is used for an absent or
 * non-finite value, and the result is always at least one and at most
 * `ROUTINE_OUTCOME_MAX_LIMIT`, so a procedure cannot turn the read into an
 * unbounded scan by passing a bad number.
 */
function outcomeLimit(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return ROUTINE_OUTCOME_DEFAULT_LIMIT;
  }

  return Math.min(Math.max(Math.trunc(requested), 1), ROUTINE_OUTCOME_MAX_LIMIT);
}

/** Bounds a caller's preview request the way `outcomeLimit` bounds a history read. */
function previewCount(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return ROUTINE_PREVIEW_DEFAULT_COUNT;
  }

  return Math.min(Math.max(Math.trunc(requested), 1), ROUTINE_PREVIEW_MAX_COUNT);
}

/**
 * The next fire times for a schedule the operator is still editing: no routine
 * row is read or written, and the search starts from the database's clock so
 * the answer agrees with what a save would store. The times are the schedule's
 * own instants, strictly increasing, exactly as the scheduler would settle
 * them.
 */
async function previewRoutineSchedule(
  database: Queryable,
  cronText: string,
  timezone: string,
  count?: number,
): Promise<readonly Date[]> {
  const cron = scheduleBoundary(() => parseRoutineCron(cronText));
  assertRoutineTimezone(timezone);

  const { rows } = await database.query<{ readonly now: Date }>("select now() as now");
  const clock = rows[0];
  if (clock === undefined) {
    throw new Error("the database returned no clock to preview a routine schedule");
  }

  const fireTimes: Date[] = [];
  let after = clock.now;

  for (let index = 0; index < previewCount(count); index += 1) {
    const next = scheduleBoundary(() => nextRoutineFire(cron, timezone, after));
    fireTimes.push(next);
    after = next;
  }

  return fireTimes;
}

/**
 * Runs a pure schedule computation and turns the scheduler's rejection into
 * the typed error the transport boundary maps: a bad cron expression, an
 * unknown timezone and an unreachable schedule are the caller's 400, and any
 * other `RoutineScheduleError` (an invalid date, a zone that moved its clock
 * by days) is a defect and is rethrown untouched.
 */
function scheduleBoundary<Value>(compute: () => Value): Value {
  try {
    return compute();
  } catch (error) {
    throw asInvalidRoutineSchedule(error);
  }
}

function asInvalidRoutineSchedule(error: unknown): unknown {
  if (error instanceof InvalidRoutineCron) {
    return new InvalidRoutineScheduleError("invalid_cron", error.message);
  }

  if (error instanceof InvalidRoutineTimezone) {
    return new InvalidRoutineScheduleError("invalid_timezone", error.message);
  }

  if (error instanceof UnreachableRoutineSchedule) {
    return new InvalidRoutineScheduleError("unreachable", error.message);
  }

  return error;
}

function assertRoutineTimezone(timezone: string): void {
  if (!isRoutineTimezone(timezone)) {
    throw asInvalidRoutineSchedule(new InvalidRoutineTimezone(timezone));
  }
}

async function createRoutine(
  actor: UserActor,
  database: Queryable,
  input: NewRoutine,
): Promise<RoutineRecord> {
  const cron = scheduleBoundary(() => parseRoutineCron(input.cron));
  assertRoutineTimezone(input.timezone);

  return withTransaction(database, async (transaction) => {
    const { rows: clockRows } = await transaction.query<{ readonly now: Date }>(
      "select now() as now",
    );
    const clock = clockRows[0];
    if (clock === undefined) {
      throw new Error("the database returned no clock for the routine's first fire");
    }

    const { rows: threadRows } = await transaction.query<{ readonly id: string }>(
      "insert into thread (space_id, bot_id, user_id) " +
        "select $1, b.id, $2 from bot b where b.id = $3 and b.space_id = $1 returning id",
      [actor.spaceId, actor.userId, input.botId],
    );

    // The insert-select wrote nothing: the bot is outside the actor's space,
    // and this is the same not-found a missing bot produces.
    const thread = requiredRow(threadRows, "bot", input.botId);

    const { rows } = await transaction.query<RoutineRecord>(
      "insert into routine (space_id, bot_id, user_id, thread_id, instruction, cron, timezone, " +
        "enabled, next_run_at) values ($1, $2, $3, $4, $5, $6, $7, true, $8) " +
        `returning ${routineColumns}`,
      [
        actor.spaceId,
        input.botId,
        actor.userId,
        thread.id,
        input.instruction,
        input.cron,
        input.timezone,
        scheduleBoundary(() => nextRoutineFire(cron, input.timezone, clock.now)),
      ],
    );

    return requiredRow(rows, "routine", input.botId);
  });
}

async function updateRoutine(
  actor: UserActor,
  database: Queryable,
  id: string,
  patch: RoutinePatch,
): Promise<RoutineRecord> {
  const current = await findRoutine(database, actor.spaceId, id);
  const cron = patch.cron ?? current.cron;
  const timezone = patch.timezone ?? current.timezone;
  // A submitted value equal to the stored one changes nothing, so the pending
  // slot keeps its cursor: a form that saves the same schedule must not skip it.
  const scheduleChanged =
    (patch.cron !== undefined && patch.cron !== current.cron) ||
    (patch.timezone !== undefined && patch.timezone !== current.timezone);
  const reenabled = patch.enabled === true && !current.enabled;

  const values: unknown[] = [];
  const assignments = ["updated_at = now()"];

  if (patch.instruction !== undefined) {
    values.push(patch.instruction);
    assignments.push(`instruction = $${values.length}`);
  }

  if (patch.cron !== undefined) {
    values.push(patch.cron);
    assignments.push(`cron = $${values.length}`);
  }

  if (patch.timezone !== undefined) {
    values.push(patch.timezone);
    assignments.push(`timezone = $${values.length}`);
  }

  if (patch.enabled !== undefined) {
    values.push(patch.enabled);
    assignments.push(`enabled = $${values.length}`);
  }

  if (scheduleChanged || reenabled) {
    const parsed = scheduleBoundary(() => parseRoutineCron(cron));
    assertRoutineTimezone(timezone);

    // The database's clock, never the host's: an edit moves the cursor to the
    // next fire after the server's now, exactly as a fire advances it.
    const { rows: clockRows } = await database.query<{ readonly now: Date }>("select now() as now");
    const clock = clockRows[0];
    if (clock === undefined) {
      throw new Error("the database returned no clock to reschedule a routine");
    }

    values.push(scheduleBoundary(() => nextRoutineFire(parsed, timezone, clock.now)));
    assignments.push(`next_run_at = $${values.length}`);
  }

  values.push(id);
  const idParameter = values.length;
  values.push(actor.spaceId);
  const spaceParameter = values.length;

  const { rows } = await database.query<RoutineRecord>(
    `update routine set ${assignments.join(", ")} ` +
      `where id = $${idParameter} and space_id = $${spaceParameter} and deleted_at is null ` +
      `returning ${routineColumns}`,
    values,
  );

  return requiredRow(rows, "routine", id);
}

/**
 * The tombstone, not a delete: `enabled = false` stops the scheduler's scan
 * and `deleted_at` takes the routine out of every operator read, while the
 * thread, the runs and the occurrence ledger keep the history the issue
 * requires. A second remove is the same not-found as a missing routine.
 */
async function removeRoutine(
  actor: UserActor,
  database: Queryable,
  id: string,
): Promise<RoutineRecord> {
  const { rows } = await database.query<RoutineRecord>(
    "update routine set enabled = false, deleted_at = now(), updated_at = now() " +
      "where id = $1 and space_id = $2 and deleted_at is null " +
      `returning ${routineColumns}`,
    [id, actor.spaceId],
  );

  return requiredRow(rows, "routine", id);
}

/**
 * Settles one slot as missed and advances the schedule in the same
 * transaction, using the same row lock and ledger key as a fire. A routine
 * that moved on, was disabled or already settled the slot writes nothing and
 * returns undefined; the loser of a race is answered by the ledger, not by a
 * second advance.
 */
async function recordMissedOccurrence(
  actor: SystemActor,
  database: Queryable,
  input: MissedRoutineOccurrence,
): Promise<RoutineOccurrenceRecord | undefined> {
  return withTransaction(database, async (transaction) => {
    const { rows: routineRows } = await transaction.query<{ readonly id: string }>(
      "select id from routine where id = $1 and space_id = $2 and enabled " +
        "and deleted_at is null and date_trunc('milliseconds', next_run_at) = $3 for update",
      [input.routineId, actor.spaceId, input.scheduledFor],
    );

    if (routineRows[0] === undefined) {
      return undefined;
    }

    const { rows: occurrenceRows } = await transaction.query<RoutineOccurrenceRecord>(
      "insert into routine_occurrence (routine_id, scheduled_for) values ($1, $2) " +
        "on conflict (routine_id, scheduled_for) do nothing " +
        `returning ${routineOccurrenceColumns}`,
      [input.routineId, input.scheduledFor],
    );

    const occurrence = occurrenceRows[0];
    if (occurrence === undefined) {
      return undefined;
    }

    const { rows: advancedRows } = await transaction.query<{ readonly id: string }>(
      "update routine set next_run_at = $1, updated_at = now() " +
        "where id = $2 and space_id = $3 and date_trunc('milliseconds', next_run_at) = $4 " +
        "returning id",
      [input.nextRunAt, input.routineId, actor.spaceId, input.scheduledFor],
    );

    if (advancedRows[0] === undefined) {
      // The lock makes this unreachable; if it ever happens, the ledger row
      // must not stand without the advance, so the throw rolls it back.
      throw new Error(`the routine "${input.routineId}" moved while its slot was missed`);
    }

    return occurrence;
  });
}
