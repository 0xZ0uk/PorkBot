import { INITIAL_RUN_STATUS } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { messageColumns, runColumns, taskColumns } from "./records.ts";
import type { MessageRecord, RunRecord, TaskRecord } from "./records.ts";
import { insertedRow, requiredRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/**
 * The run-creation commands, and the only code in the package that inserts a
 * `task`, a `run` or the links between them.
 *
 * The reference implementation grew 13–17 near-duplicate creation sites, each
 * with its own idea of ordering, status and idempotency. Here there are three
 * commands for the three ways a run begins — a message, a due routine slot and
 * an operator's test run — and they share this module, this ordering and this
 * idempotency discipline, so a fourth trigger is a fourth command here rather
 * than a new insert elsewhere.
 *
 * `createRunAndTask` is the message-triggered command: one call builds the
 * user message, the task, the run and the links between them. The database
 * owns the duplicate decision: the run's `(space_id, client_nonce)` unique
 * index is a NOT NULL key, so a resubmission is an
 * `insert ... on conflict do nothing`, never a read-then-write race. The task
 * is inserted first (a run cannot exist without it) and the transaction rolls
 * it back when the run conflicts, so a duplicate leaves no stray task behind.
 * Under concurrency, the losing insert waits for the winner at the index and
 * then replays it, so parallel duplicate submissions return the same run.
 *
 * `createRoutineRun` is the routine-triggered command, called by the
 * scheduler. It has no user message — the routine's instruction is the task's
 * prompt and `source_message_id` stays null — and it settles the routine's
 * occurrence ledger in the same transaction that creates the task and the run,
 * so a fire and its outcome link commit together. The routine row is locked
 * for the transaction and the slot is deduped by
 * `routine_occurrence (routine_id, scheduled_for)` on NOT NULL columns, so two
 * scheduler passes racing one slot produce one run, and the loser returns
 * undefined without writing anything.
 *
 * Both commands take the initial status from `INITIAL_RUN_STATUS` in the run
 * state machine; they are the only writers of a run's first status, and the
 * transition map is the one place that decides what "initial" means.
 *
 * Scope comes from the actor, never from an argument: the thread is looked up
 * inside the actor's space, and a thread that does not exist and one in another
 * space are the same `NotFoundError`. The message, the task and the run are
 * attributed to the actor's user, and both directions of the message link are
 * written — `run.source_message_id` and `message.run_id` — so the transcript
 * and the run agree without a later backfill.
 */

export interface NewRunAndTask {
  readonly threadId: string;
  /**
   * The caller's idempotency key. The messaging policy owns its validity
   * (non-empty, bounded); this command only demands that it is stable for one
   * submission, because the database scopes it to the space and replays it.
   */
  readonly clientNonce: string;
  readonly prompt: string;
  /** The user message's content, stored as jsonb; its shape is the wire's. */
  readonly blocks: readonly unknown[];
}

/** The three rows one accepted submission creates, already linked. */
export interface CreatedRunAndTask {
  readonly run: RunRecord;
  readonly task: TaskRecord;
  readonly message: MessageRecord;
}

/**
 * Thrown inside the transaction when the run insert matched the unique key, so
 * the transaction rolls the task back; the catch outside the transaction
 * decides whether to replay the winner or report not-found. It never escapes
 * this module.
 */
class SubmissionSettled extends Error {
  constructor() {
    super("the submission did not insert a run");
    this.name = "SubmissionSettled";
  }
}

export async function createRunAndTask(
  actor: UserActor,
  database: Queryable,
  input: NewRunAndTask,
): Promise<CreatedRunAndTask> {
  const created = await createOnce(actor, database, input).catch((error: unknown) => {
    if (error instanceof SubmissionSettled) {
      return undefined;
    }

    throw error;
  });

  if (created !== undefined) {
    return created;
  }

  // The conflict was resolved at the index, so by the time the insert returns
  // empty the winner is committed and visible: this read replays it instead of
  // racing it.
  const existing = await readByNonce(database, actor.spaceId, input.clientNonce);
  if (existing !== undefined) {
    return existing;
  }

  throw new NotFoundError("thread", input.threadId);
}

async function createOnce(
  actor: UserActor,
  database: Queryable,
  input: NewRunAndTask,
): Promise<CreatedRunAndTask> {
  return withTransaction(database, async (transaction) => {
    const { rows: taskRows } = await transaction.query<TaskRecord>(
      "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
        "select $1, t.bot_id, t.id, $2, $3, 'queued' " +
        "from thread t where t.id = $4 and t.space_id = $1 " +
        `returning ${taskColumns}`,
      [actor.spaceId, actor.userId, input.prompt, input.threadId],
    );

    if (taskRows[0] === undefined) {
      // The thread does not exist in the actor's space, and the scoped insert
      // wrote nothing; roll back and report not-found, never forbidden.
      throw new NotFoundError("thread", input.threadId);
    }

    const task = taskRows[0];

    const { rows: runRows } = await transaction.query<RunRecord>(
      "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
        "select $1, t.bot_id, t.thread_id, t.id, $2, $3::run_status, 'message', $4 " +
        "from task t where t.id = $5 and t.space_id = $1 " +
        "on conflict (space_id, client_nonce) do nothing " +
        `returning ${runColumns}`,
      [actor.spaceId, actor.userId, INITIAL_RUN_STATUS, input.clientNonce, task.id],
    );

    const run = runRows[0];
    if (run === undefined) {
      throw new SubmissionSettled();
    }

    const { rows: seqRows } = await transaction.query<{ readonly seq: number }>(
      "update thread set next_message_seq = next_message_seq + 1 " +
        "where id = $1 and space_id = $2 " +
        "returning next_message_seq - 1 as seq",
      [input.threadId, actor.spaceId],
    );

    // The thread row the task was built from is gone: a concurrent delete wins,
    // and the whole submission rolls back as not-found.
    const seq = requiredRow(seqRows, "thread", input.threadId).seq;

    const { rows: messageRows } = await transaction.query<MessageRecord>(
      "insert into message (thread_id, seq, role, blocks, client_nonce, run_id) " +
        "values ($1, $2, 'user', $3::jsonb, $4, $5) " +
        `returning ${messageColumns}`,
      [input.threadId, seq, JSON.stringify(input.blocks), input.clientNonce, run.id],
    );

    const message = insertedRow(messageRows);

    const { rows: linkedRows } = await transaction.query<RunRecord>(
      "update run set source_message_id = $1 where id = $2 and space_id = $3 " +
        `returning ${runColumns}`,
      [message.id, run.id, actor.spaceId],
    );

    return { run: insertedRow(linkedRows), task, message };
  });
}

/**
 * A test run an operator triggers from the editor: the routine to fire now,
 * and the caller's idempotency key.
 *
 * This is the third run-creation command and it is deliberately here beside
 * the other two: the test run is the routine's instruction executed as an
 * ordinary run in the routine's own thread, so the module that owns "how a run
 * begins" owns this too. It settles no occurrence and moves no cursor — the
 * schedule is untouched — which is what distinguishes a test run from a fire.
 */
export interface NewRoutineTestRun {
  readonly routineId: string;
  /** The caller's idempotency key; a retried submission returns the same run. */
  readonly clientNonce: string;
}

/**
 * The deterministic nonce a test run stores, shaped like the scheduler's
 * `routine:<id>:<slot>` keys: the routine and the caller's key both bind, so a
 * test run can never collide with a scheduled fire or with another routine's
 * test in the run table's `(space, client_nonce)` unique index.
 */
export function routineTestRunNonce(routineId: string, clientNonce: string): string {
  return `routine-test:${routineId}:${clientNonce}`;
}

/**
 * Fires a routine once, now, outside its schedule.
 *
 * The operator's counterpart of the scheduler's fire: it reads the same four
 * fields from the routine row (so the caller supplies no prompt and addresses
 * no bot), creates the task and the run with the routine trigger, and writes
 * no occurrence — there was no slot, and the outcome history is the ledger of
 * slots. The run is queued and unowned like every new run, so the ordinary
 * dispatcher reconciliation picks it up and no second executor exists; the
 * `routine-test:` nonce makes a resubmission a replay instead of a second run.
 *
 * A routine outside the actor's space and a routine that does not exist are
 * the same `NotFoundError`. A deleted routine is not testable; a disabled one
 * is, because validating a paused routine is a reason to use this.
 */
export async function createRoutineTestRun(
  actor: UserActor,
  database: Queryable,
  input: NewRoutineTestRun,
): Promise<RunRecord> {
  const created = await testRoutineOnce(actor, database, input).catch((error: unknown) => {
    if (error instanceof TestRunSettled) {
      return undefined;
    }

    throw error;
  });

  if (created !== undefined) {
    return created;
  }

  const existing = await readRunByNonce(
    database,
    actor.spaceId,
    routineTestRunNonce(input.routineId, input.clientNonce),
  );

  if (existing !== undefined) {
    return existing;
  }

  throw new NotFoundError("routine", input.routineId);
}

/**
 * Thrown inside the transaction when the run's unique nonce already exists, so
 * the transaction rolls the task back; the catch outside replays the winner.
 * It never escapes this module.
 */
class TestRunSettled extends Error {
  constructor() {
    super("the routine test run did not insert a run");
    this.name = "TestRunSettled";
  }
}

async function testRoutineOnce(
  actor: UserActor,
  database: Queryable,
  input: NewRoutineTestRun,
): Promise<RunRecord> {
  return withTransaction(database, async (transaction) => {
    const { rows: routineRows } = await transaction.query<FiringRoutine>(
      'select id, bot_id as "botId", thread_id as "threadId", user_id as "userId", instruction ' +
        "from routine where id = $1 and space_id = $2 and deleted_at is null",
      [input.routineId, actor.spaceId],
    );

    const routine = routineRows[0];
    if (routine === undefined) {
      throw new NotFoundError("routine", input.routineId);
    }

    const { rows: taskRows } = await transaction.query<TaskRecord>(
      "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
        "values ($1, $2, $3, $4, $5, 'queued') " +
        `returning ${taskColumns}`,
      [actor.spaceId, routine.botId, routine.threadId, routine.userId, routine.instruction],
    );

    const task = insertedRow(taskRows);

    const { rows: runRows } = await transaction.query<RunRecord>(
      "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
        "values ($1, $2, $3, $4, $5, $6::run_status, 'routine', $7) " +
        "on conflict (space_id, client_nonce) do nothing " +
        `returning ${runColumns}`,
      [
        actor.spaceId,
        routine.botId,
        routine.threadId,
        task.id,
        routine.userId,
        INITIAL_RUN_STATUS,
        routineTestRunNonce(input.routineId, input.clientNonce),
      ],
    );

    const run = runRows[0];
    if (run === undefined) {
      throw new TestRunSettled();
    }

    return run;
  });
}

/**
 * The run a `(space, nonce)` pair already created, if any. The scheduler's
 * fire reads its own replay through the same table; this is the operator's
 * side of the same idempotency.
 */
async function readRunByNonce(
  database: Queryable,
  spaceId: string,
  clientNonce: string,
): Promise<RunRecord | undefined> {
  const { rows } = await database.query<RunRecord>(
    `select ${runColumns} from run where space_id = $1 and client_nonce = $2`,
    [spaceId, clientNonce],
  );

  return rows[0];
}

/**
 * One scheduled fire: the routine, the slot it is settling, and the next slot
 * the scheduler advances it to.
 *
 * The command reads the instruction, the bot, the thread and the owner from
 * the locked routine row — never from this input — so a scheduler job that
 * only knows the routine id and the two instants cannot smuggle a prompt or
 * address another bot's thread.
 */
export interface NewRoutineRun {
  readonly routineId: string;
  /** The slot being settled; the ledger's idempotency key. */
  readonly scheduledFor: Date;
  /** The next fire the routine row advances to, decided by `@porkbot/core`. */
  readonly nextRunAt: Date;
}

/** The run one fire created, with the ledger row that links to it. */
export interface CreatedRoutineRun {
  readonly run: RunRecord;
  readonly occurrenceId: string;
}

/**
 * The routine's deterministic idempotency key for one slot: a retried fire
 * addresses the same `(space, client_nonce)` the run table already dedupes,
 * so the ledger and the run's unique index agree about what a duplicate is.
 */
export function routineRunNonce(routineId: string, scheduledFor: Date): string {
  return `routine:${routineId}:${scheduledFor.getTime()}`;
}

/** The routine fields one fire reads while holding the row lock. */
interface FiringRoutine {
  readonly id: string;
  readonly botId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly instruction: string;
}

/**
 * Fires one due routine: inserts the occurrence, the task and the run, links
 * the occurrence to the run, and advances the schedule, all in one
 * transaction.
 *
 * Returns undefined when the routine is no longer live (disabled, deleted or
 * moved to another slot) or when the slot already has an occurrence — both are
 * superseded passes that must write nothing rather than an error. The routine
 * row is locked with `for update` and re-checked against `scheduledFor`, so
 * the decision the scheduler made from its scan is validated against the row
 * it is about to change.
 */
export async function createRoutineRun(
  actor: SystemActor,
  database: Queryable,
  input: NewRoutineRun,
): Promise<CreatedRoutineRun | undefined> {
  return fireRoutineOnce(actor, database, input).catch((error: unknown) => {
    if (error instanceof RoutineSlotSettled) {
      return undefined;
    }

    throw error;
  });
}

/**
 * Thrown inside the transaction when the run's unique nonce already exists, so
 * the transaction rolls the ledger insert back; the catch outside decides that
 * the slot is settled. It never escapes this module. This mirrors the message
 * command's `SubmissionSettled`: the ledger is the scheduler's first dedupe,
 * and the run's `(space_id, client_nonce)` index is the second, so a state
 * where only the second fires (a restored or hand-cleaned ledger) still
 * resolves to "settled", not to a unique violation that fails the tick.
 */
class RoutineSlotSettled extends Error {
  constructor() {
    super("the routine slot did not insert a run");
    this.name = "RoutineSlotSettled";
  }
}

async function fireRoutineOnce(
  actor: SystemActor,
  database: Queryable,
  input: NewRoutineRun,
): Promise<CreatedRoutineRun | undefined> {
  return withTransaction(database, async (transaction) => {
    const { rows: routineRows } = await transaction.query<FiringRoutine>(
      'select id, bot_id as "botId", thread_id as "threadId", user_id as "userId", instruction ' +
        "from routine where id = $1 and space_id = $2 and enabled and deleted_at is null " +
        "and date_trunc('milliseconds', next_run_at) = $3 for update",
      [input.routineId, actor.spaceId, input.scheduledFor],
    );

    const firing = routineRows[0];
    if (firing === undefined) {
      return undefined;
    }

    const { rows: occurrenceRows } = await transaction.query<{ readonly id: string }>(
      "insert into routine_occurrence (routine_id, scheduled_for) values ($1, $2) " +
        "on conflict (routine_id, scheduled_for) do nothing returning id",
      [firing.id, input.scheduledFor],
    );

    const occurrence = occurrenceRows[0];
    if (occurrence === undefined) {
      return undefined;
    }

    const { rows: taskRows } = await transaction.query<TaskRecord>(
      "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
        "values ($1, $2, $3, $4, $5, 'queued') " +
        `returning ${taskColumns}`,
      [actor.spaceId, firing.botId, firing.threadId, firing.userId, firing.instruction],
    );

    const task = insertedRow(taskRows);

    const { rows: runRows } = await transaction.query<RunRecord>(
      "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
        "values ($1, $2, $3, $4, $5, $6::run_status, 'routine', $7) " +
        "on conflict (space_id, client_nonce) do nothing " +
        `returning ${runColumns}`,
      [
        actor.spaceId,
        firing.botId,
        firing.threadId,
        task.id,
        firing.userId,
        INITIAL_RUN_STATUS,
        routineRunNonce(firing.id, input.scheduledFor),
      ],
    );

    const run = runRows[0];
    if (run === undefined) {
      throw new RoutineSlotSettled();
    }

    await transaction.query(
      "update routine_occurrence set run_id = $1, updated_at = now() where id = $2",
      [run.id, occurrence.id],
    );

    const { rows: advancedRows } = await transaction.query<{ readonly id: string }>(
      "update routine set next_run_at = $1, updated_at = now() " +
        "where id = $2 and space_id = $3 and date_trunc('milliseconds', next_run_at) = $4 " +
        "returning id",
      [input.nextRunAt, firing.id, actor.spaceId, input.scheduledFor],
    );

    if (advancedRows[0] === undefined) {
      // The lock makes this unreachable; if it ever happens, the slot must not
      // be left half-settled, so the throw rolls the whole fire back.
      throw new Error(`the routine "${firing.id}" moved while its slot was firing`);
    }

    return { run, occurrenceId: occurrence.id };
  });
}

/** The first result of a nonce, read the same way for a sequential resubmission and a lost race. */
async function readByNonce(
  database: Queryable,
  spaceId: string,
  clientNonce: string,
): Promise<CreatedRunAndTask | undefined> {
  const { rows: runRows } = await database.query<RunRecord>(
    `select ${runColumns} from run where space_id = $1 and client_nonce = $2`,
    [spaceId, clientNonce],
  );

  const run = runRows[0];
  if (run === undefined) {
    return undefined;
  }

  if (run.sourceMessageId === null) {
    // Only this command inserts message-triggered runs, and it writes the
    // source message in the same transaction, so a run without one is a state
    // this package cannot produce.
    throw new Error(`the run-creation replay found run "${run.id}" without its source message`);
  }

  const { rows: taskRows } = await database.query<TaskRecord>(
    `select ${taskColumns} from task where id = $1 and space_id = $2`,
    [run.taskId, spaceId],
  );

  const { rows: messageRows } = await database.query<MessageRecord>(
    `select ${messageColumns} from message where id = $1 and thread_id = $2`,
    [run.sourceMessageId, run.threadId],
  );

  return {
    run,
    task: replayedRow(taskRows, "task", run.id),
    message: replayedRow(messageRows, "message", run.id),
  };
}

function replayedRow<Row>(rows: readonly Row[], what: string, runId: string): Row {
  const row = rows[0];

  if (row === undefined) {
    throw new Error(`the run-creation replay found no ${what} for run "${runId}"`);
  }

  return row;
}
