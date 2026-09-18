import { INITIAL_RUN_STATUS } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import type { UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { messageColumns, runColumns, taskColumns } from "./records.ts";
import type { MessageRecord, RunRecord, TaskRecord } from "./records.ts";
import { insertedRow, requiredRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/**
 * The single run-creation command: one call builds the user message, the task,
 * the run and the links between them.
 *
 * The reference implementation grew 13–17 near-duplicate creation sites, each
 * with its own idea of ordering, status and idempotency. Here there is one
 * path, and the database owns the duplicate decision: the run's
 * `(space_id, client_nonce)` unique index is a NOT NULL key, so a resubmission
 * is an `insert ... on conflict do nothing`, never a read-then-write race. The
 * task is inserted first (a run cannot exist without it) and the transaction
 * rolls it back when the run conflicts, so a duplicate leaves no stray task
 * behind. Under concurrency, the losing insert waits for the winner at the
 * index and then replays it, so parallel duplicate submissions return the same
 * run.
 *
 * The initial status is `INITIAL_RUN_STATUS` from the run state machine, and
 * this command is the only writer of a run's first status; the transition map
 * is the one place that decides what "initial" means.
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
