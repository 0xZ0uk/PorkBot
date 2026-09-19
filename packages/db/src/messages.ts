import { ACTIVE_RUN_STATUSES, isRunStatus, messageText } from "@porkbot/core";
import type { MessageBlock } from "@porkbot/core";
import { NotFoundError, RunNotActiveError } from "@porkbot/effect";
import type { PendingSteer } from "@porkbot/effect";
import type { Actor, SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { messageColumns, threadColumns } from "./records.ts";
import type { MessageRecord, MessageRole, ThreadRecord } from "./records.ts";
import { insertedRow, isUniqueViolation, requiredRow } from "./rows.ts";
import { withTransaction } from "./transaction.ts";

/**
 * The message store (slice 6.5): the transcript's read paths, the one
 * insertion primitive every message writer shares, and the commands that own
 * the writes run creation does not.
 *
 * `allocateMessageSeq` advances the thread's counter in the same statement
 * that returns the position, and `insertMessage` writes the row — so the
 * steering command, the assistant-message command and the run-creation command
 * allocate and insert identically. `(thread_id, seq)` unique is what makes the
 * counter the only correct allocation, and the call-site suite beside this
 * module keeps this file the only shipped source that names an
 * `insert into message`.
 *
 * Every command is scoped by the actor: a thread in another space matches no
 * row and is reported as the shared `NotFoundError`, and every write either
 * selects over the thread (or the run and thread together) or is preceded by a
 * scoped read, so no statement can address another space's transcript.
 *
 * Sends are idempotent on the caller's nonce: `(thread_id, client_nonce)` is
 * unique, so a resubmitted send collides at the index instead of racing a
 * read-then-write, and the commands replay the first row rather than inserting
 * a second. Assistant messages carry the same discipline: their nonce is
 * derived from the run and message they record, so a retried append is a
 * replay.
 */

/** Which slice of a transcript to read; `afterSeq` is exclusive. */
export interface MessagePage {
  readonly limit: number;
  readonly afterSeq: number;
}

/** What a run's terminal output is recorded as; the nonce is its retry key. */
export interface NewAssistantMessage {
  readonly threadId: string;
  readonly runId: string;
  readonly clientNonce: string;
  readonly blocks: readonly MessageBlock[];
}

/** What a send into a live run is recorded as, bound to the run it addressed. */
export interface NewSteeringMessage {
  readonly threadId: string;
  readonly clientNonce: string;
  readonly blocks: readonly MessageBlock[];
  readonly runId: string;
}

export interface MessageReader {
  /** `seq > afterSeq`, oldest first, scoped to the actor's space. */
  listForThread(threadId: string, page: MessagePage): Promise<readonly MessageRecord[]>;
  /**
   * The message a nonce already names on this thread, or undefined. The send
   * path uses it to replay or refuse before it writes anything. The read is
   * role-agnostic on purpose: the unique index that resolves a concurrent
   * duplicate does not distinguish roles, so this lookup must not either, or
   * the two would disagree about what a collision is.
   */
  findByNonce(threadId: string, clientNonce: string): Promise<MessageRecord | undefined>;
}

/** The worker's half: the assistant message a finished run produced. */
export interface AssistantMessageWriter {
  append(input: NewAssistantMessage): Promise<MessageRecord>;
}

/** The operator's half: a message sent into the thread's live run. */
export interface SteeringMessageWriter {
  steer(input: NewSteeringMessage): Promise<MessageRecord>;
}

/** The row one message insert takes; the run link may be null. */
export interface NewMessage {
  readonly threadId: string;
  readonly seq: number;
  readonly role: MessageRole;
  readonly blocks: readonly MessageBlock[];
  readonly clientNonce: string;
  readonly runId: string | null;
}

/**
 * Takes the thread's next transcript position and advances the counter, in one
 * statement, so ordering stays contiguous under concurrent writers and a
 * failed insert cannot leave a gap. The thread must be in the actor's space;
 * the returned position is 0-based, matching `(thread_id, seq)`.
 */
export async function allocateMessageSeq(
  transaction: Queryable,
  spaceId: string,
  threadId: string,
): Promise<number> {
  const { rows } = await transaction.query<{ readonly seq: number }>(
    "update thread set next_message_seq = next_message_seq + 1, updated_at = now() " +
      "where id = $1 and space_id = $2 " +
      "returning next_message_seq - 1 as seq",
    [threadId, spaceId],
  );

  return requiredRow(rows, "thread", threadId).seq;
}

/** One message row, projected like every other read of the table. */
export async function insertMessage(
  transaction: Queryable,
  input: NewMessage,
): Promise<MessageRecord> {
  const { rows } = await transaction.query<MessageRecord>(
    "insert into message (thread_id, seq, role, blocks, client_nonce, run_id) " +
      "values ($1, $2, $3::message_role, $4::jsonb, $5, $6) " +
      `returning ${messageColumns}`,
    [
      input.threadId,
      input.seq,
      input.role,
      JSON.stringify(input.blocks),
      input.clientNonce,
      input.runId,
    ],
  );

  return insertedRow(rows);
}

/** The actor-scoped read half; the same reads serve the API and the worker. */
export function readMessages(actor: Actor, database: Queryable): MessageReader {
  async function readByNonce(
    threadId: string,
    clientNonce: string,
  ): Promise<MessageRecord | undefined> {
    const { rows } = await database.query<MessageRecord>(
      `select ${messageColumns} from message ` +
        "where thread_id = $1 and client_nonce = $2 and exists (" +
        "select 1 from thread t where t.id = message.thread_id and t.space_id = $3)",
      [threadId, clientNonce, actor.spaceId],
    );

    return rows[0];
  }

  return {
    async listForThread(threadId, page): Promise<readonly MessageRecord[]> {
      const { rows } = await database.query<MessageRecord>(
        `select ${messageColumns} from message ` +
          "where thread_id = $1 and seq > $2 and exists (" +
          "select 1 from thread t where t.id = message.thread_id and t.space_id = $3) " +
          "order by seq asc limit $4",
        [threadId, page.afterSeq, actor.spaceId, page.limit],
      );

      return rows;
    },

    findByNonce: readByNonce,
  };
}

/**
 * The worker's assistant-message command. The run guard rides in the sequence
 * allocation: the thread must be in the job's space *and* the run must belong
 * to it, so a job cannot write a message into a run it is not executing. A
 * resubmitted nonce is answered by the first row, exactly as a send is.
 */
export function createAssistantMessageStore(
  actor: SystemActor,
  database: Queryable,
): AssistantMessageWriter {
  return {
    async append(input: NewAssistantMessage): Promise<MessageRecord> {
      try {
        return await withTransaction(database, async (transaction) => {
          const { rows } = await transaction.query<{ readonly seq: number }>(
            "update thread set next_message_seq = next_message_seq + 1, updated_at = now() " +
              "where id = $1 and space_id = $2 and exists (" +
              "select 1 from run r where r.id = $3 and r.space_id = $2 and r.thread_id = $1) " +
              "returning next_message_seq - 1 as seq",
            [input.threadId, actor.spaceId, input.runId],
          );

          const allocated = rows[0];
          if (allocated === undefined) {
            throw await missingThreadOrRun(actor.spaceId, input.threadId, input.runId, transaction);
          }

          return insertMessage(transaction, {
            threadId: input.threadId,
            seq: allocated.seq,
            role: "assistant",
            blocks: input.blocks,
            clientNonce: input.clientNonce,
            runId: input.runId,
          });
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }

        const existing = await readMessages(actor, database).findByNonce(
          input.threadId,
          input.clientNonce,
        );

        if (existing === undefined) {
          throw error;
        }

        return existing;
      }
    },
  };
}

/**
 * The steering command: the message row and its `steering_message` delivery
 * record are written in one transaction, bound to the run the send addressed,
 * so a live run can claim it and a finished one leaves it unclaimed. The bot
 * comes from the thread row, never from the caller, so a steer cannot target a
 * thread's message at another bot's run.
 *
 * The addressed run must be non-terminal (slice 6.7): a steer is a write into
 * a live run, so a send that raced the run's finish is refused with the typed
 * `RunNotActiveError` instead of quietly appending a message no session will
 * ever claim. The caller decides what to tell the operator; what the steer
 * cannot do is look applied while doing nothing.
 */
export function createSteeringMessageStore(
  actor: UserActor,
  database: Queryable,
): SteeringMessageWriter {
  return {
    async steer(input: NewSteeringMessage): Promise<MessageRecord> {
      try {
        return await withTransaction(database, async (transaction) => {
          const { rows } = await transaction.query<{
            readonly seq: number;
            readonly botId: string;
          }>(
            "update thread set next_message_seq = next_message_seq + 1, updated_at = now() " +
              "where id = $1 and space_id = $2 and exists (" +
              "select 1 from run r where r.id = $3 and r.space_id = $2 and r.thread_id = $1 and " +
              "r.bot_id = thread.bot_id and r.status = any($4::run_status[])) " +
              'returning next_message_seq - 1 as seq, bot_id as "botId"',
            [input.threadId, actor.spaceId, input.runId, ACTIVE_RUN_STATUSES],
          );

          const allocated = rows[0];
          if (allocated === undefined) {
            throw await steerRefusal(actor.spaceId, input.threadId, input.runId, transaction);
          }

          const message = await insertMessage(transaction, {
            threadId: input.threadId,
            seq: allocated.seq,
            role: "user",
            blocks: input.blocks,
            clientNonce: input.clientNonce,
            runId: input.runId,
          });

          await transaction.query(
            "insert into steering_message (message_id, bot_id, user_id, run_id) " +
              "values ($1, $2, $3, $4)",
            [message.id, allocated.botId, actor.userId, input.runId],
          );

          return message;
        });
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }

        const existing = await readMessages(actor, database).findByNonce(
          input.threadId,
          input.clientNonce,
        );

        if (existing === undefined) {
          throw error;
        }

        return existing;
      }
    },
  };
}

/**
 * Clears one thread's transcript and event stream in one transaction, keeping
 * the thread row and every run: clearing is a reset of the conversation, not a
 * deletion of its history, and the bot's memory documents are bot-scoped rows
 * this command never names. Both sequence counters return to zero together
 * with the deletes, so the next message is position 0 again and a reconnecting
 * subscriber replays the new stream from the start.
 */
export async function clearThread(
  actor: UserActor,
  database: Queryable,
  threadId: string,
): Promise<ThreadRecord> {
  return withTransaction(database, async (transaction) => {
    const { rows } = await transaction.query<ThreadRecord>(
      "update thread set next_message_seq = 0, next_event_seq = 0, updated_at = now() " +
        "where id = $1 and space_id = $2 " +
        `returning ${threadColumns}`,
      [threadId, actor.spaceId],
    );

    const thread = requiredRow(rows, "thread", threadId);

    // Events first: a message delete cascades through steering rows and clears
    // the run's source link, and the events of the run being cleared are gone
    // before that.
    await transaction.query("delete from event where space_id = $1 and thread_id = $2", [
      actor.spaceId,
      threadId,
    ]);
    await transaction.query("delete from message where thread_id = $1", [threadId]);

    return thread;
  });
}

/**
 * Names which scoped row the allocation missed. The follow-up read is itself
 * space-scoped, so it can say "this thread is in your space but that run is
 * not" without confirming that either exists anywhere else.
 */
async function missingThreadOrRun(
  spaceId: string,
  threadId: string,
  runId: string,
  database: Queryable,
): Promise<NotFoundError> {
  const { rows } = await database.query<{ readonly id: string }>(
    "select id from thread where id = $1 and space_id = $2",
    [threadId, spaceId],
  );

  return rows.length === 0
    ? new NotFoundError("thread", threadId)
    : new NotFoundError("run", runId);
}

/**
 * Why a steer found no live run to write into. The distinction is the point:
 * a thread or run the actor cannot see is the shared `NotFoundError`, exactly
 * like every other scoped read, while a run that exists and is terminal is the
 * typed `RunNotActiveError` — a finished run is not a missing one, and the
 * caller's retry differs (a new send, not a corrected id).
 */
async function steerRefusal(
  spaceId: string,
  threadId: string,
  runId: string,
  database: Queryable,
): Promise<NotFoundError | RunNotActiveError> {
  const missing = await missingThreadOrRun(spaceId, threadId, runId, database);

  if (missing.resource === "thread") {
    return missing;
  }

  const { rows } = await database.query<{ readonly status: string }>(
    "select status::text as status from run " +
      "where id = $1 and space_id = $2 and thread_id = $3",
    [runId, spaceId, threadId],
  );

  const status = rows[0]?.status;

  return isRunStatus(status) ? new RunNotActiveError(runId, status) : missing;
}

/**
 * The live run's half of steering (slice 6.7): claim every unclaimed
 * `steering_message` row bound to the run, oldest first, and return the text
 * and durable message id of each. `claimed_at` is the handoff mark, so two
 * claimants can never deliver one steer twice, and the statement carries the
 * same live-status guard the steer write does: a row bound to a run that has
 * finished stays unclaimed, because no session will ever consume it. The rows
 * are claimed with the update and read back in transcript order in the same
 * statement, so a session receives its corrections in the order the operator
 * wrote them.
 */
export async function claimSteeringMessages(
  actor: SystemActor,
  database: Queryable,
  runId: string,
): Promise<readonly PendingSteer[]> {
  const { rows } = await database.query<{
    readonly messageId: string;
    readonly blocks: unknown;
  }>(
    "with claimed as (" +
      "update steering_message s set claimed_at = now() " +
      "where s.run_id = $1 and s.claimed_at is null and exists (" +
      "select 1 from run r where r.id = $1 and r.space_id = $2 " +
      "and r.status = any($3::run_status[])) " +
      "returning s.message_id) " +
      'select m.id as "messageId", m.blocks from claimed ' +
      "join message m on m.id = claimed.message_id order by m.seq asc",
    [runId, actor.spaceId, ACTIVE_RUN_STATUSES],
  );

  return rows.map((row) => ({
    messageId: row.messageId,
    text: messageText(row.blocks) ?? "",
  }));
}
