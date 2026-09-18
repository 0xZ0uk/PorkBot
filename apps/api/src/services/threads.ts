import {
  ClientNonceReused,
  ClientNonceTooLong,
  decideMessageSend,
  EmptyMessage,
  MessageTooLong,
  messageText,
  MissingClientNonce,
  textMessageBlocks,
} from "@porkbot/core";
import type { MessageRuleError } from "@porkbot/core";
import type { Message, Thread, ThreadCursor } from "@porkbot/contracts";
import type { MessageRecord, ThreadRecord, UserRepositories } from "@porkbot/db";
import { InvalidMessageError, MessageNonceReusedError } from "@porkbot/effect";

/**
 * The thread service (slice 6.5): the policy half of a conversation.
 *
 * The repository layer owns the rows and the actor scope; this module owns the
 * decisions that sit between the transport and the rows:
 *
 *   - **Sending is one decision.** `decideMessageSend` in `@porkbot/core` reads
 *     the nonce's earlier send and the thread's live run, and this service
 *     performs the action it returns. The database's unique indexes are still
 *     the authority under a race — the policy steers the normal case, the
 *     index resolves the concurrent one — and a nonce that names another
 *     thread's run is refused rather than replayed, because the run's
 *     idempotency key is scoped to the space while a send's is scoped to its
 *     thread.
 *   - **Pagination is keyset.** A page's cursor is the ordering key of its last
 *     row, so the walk is stable under writes; `nextCursor`/`nextSeq` are null
 *     exactly when the page was not full, which is the only correct "no more
 *     rows" signal for a limit-plus-one-free query.
 *   - **Clearing is explicit and bounded.** It empties the transcript and the
 *     event stream and resets both counters; nothing here names a memory
 *     document, a run or a task, so the bot's durable knowledge and the audit
 *     of what ran survive the act.
 *
 * The service takes repositories per call rather than holding them: they are
 * built per request from the resolved actor, and a service instance that
 * remembered one would be the request-scoped layer baked into a process
 * singleton the lifetimes rule forbids.
 */

export interface ThreadsService {
  create(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
  }): Promise<ThreadRecord>;
  list(input: {
    readonly repositories: UserRepositories;
    readonly botId: string;
    readonly limit: number;
    readonly after: ThreadCursor | undefined;
  }): Promise<{
    readonly threads: readonly ThreadRecord[];
    readonly nextCursor: ThreadCursor | null;
  }>;
  messages(input: {
    readonly repositories: UserRepositories;
    readonly threadId: string;
    readonly limit: number;
    readonly afterSeq: number | undefined;
  }): Promise<{
    readonly messages: readonly MessageRecord[];
    readonly nextSeq: number | null;
  }>;
  send(input: {
    readonly repositories: UserRepositories;
    readonly threadId: string;
    readonly text: string;
    readonly clientNonce: string;
  }): Promise<{
    readonly action: "start_run" | "steer" | "replay";
    readonly message: MessageRecord;
    readonly runId: string | null;
  }>;
  clear(input: {
    readonly repositories: UserRepositories;
    readonly threadId: string;
  }): Promise<ThreadRecord>;
}

/** The first transcript position; `seq > -1` is every message from zero. */
const beforeFirstMessage = -1;

export function createThreadsService(): ThreadsService {
  return {
    async create({ repositories, botId }): Promise<ThreadRecord> {
      // The repository's scoped insert is the guard: a bot outside the actor's
      // space matches no row and is reported as not-found, nothing inserted.
      return repositories.threads.createForBot(botId);
    },

    async list({ repositories, botId, limit, after }) {
      // The bot read is what turns an unknown or foreign bot id into the typed
      // not-found; the threads read itself is a scoped list that would answer
      // an empty page for either.
      await repositories.bots.findById(botId);

      // One extra row is the "is there more" signal: a full page of exactly
      // `limit` rows cannot say whether it is the last one, and guessing from
      // the count is how a paginated walk duplicates or drops its boundary.
      const rows = await repositories.threads.listForBot(botId, {
        limit: limit + 1,
        before:
          after === undefined ? undefined : { updatedAt: new Date(after.updatedAt), id: after.id },
      });

      const threads = rows.slice(0, limit);
      const last = threads[threads.length - 1];

      return {
        threads,
        nextCursor:
          rows.length > limit && last !== undefined
            ? { updatedAt: last.updatedAt.toISOString(), id: last.id }
            : null,
      };
    },

    async messages({ repositories, threadId, limit, afterSeq }) {
      await repositories.threads.findById(threadId);

      const rows = await repositories.messages.listForThread(threadId, {
        limit: limit + 1,
        afterSeq: afterSeq ?? beforeFirstMessage,
      });

      const messages = rows.slice(0, limit);
      const last = messages[messages.length - 1];

      return {
        messages,
        nextSeq: rows.length > limit && last !== undefined ? last.seq : null,
      };
    },

    async send({ repositories, threadId, text, clientNonce }) {
      // A thread outside the actor's space is the same not-found as a missing
      // one, and nothing below it runs.
      await repositories.threads.findById(threadId);

      const existing = await repositories.messages.findByNonce(threadId, clientNonce);
      const active = await repositories.runs.findActiveForThread(threadId);

      const decision = decideMessageSend(
        { text, clientNonce },
        {
          existingSend:
            existing === undefined
              ? undefined
              : {
                  messageId: existing.id,
                  runId: existing.runId,
                  request: { text: messageText(existing.blocks) ?? "", clientNonce },
                },
          activeRun: active === undefined ? undefined : { runId: active.id, status: active.status },
        },
      );

      if (!decision.ok) {
        throw refusedSend(decision.error);
      }

      switch (decision.action.action) {
        case "replay": {
          if (existing === undefined) {
            // The policy only replays a send it was given; a replay without one
            // is a programming mistake, not a client outcome.
            throw new Error("the send decision replayed a message the lookup did not return");
          }

          return { action: "replay", message: existing, runId: decision.action.runId };
        }

        case "steer": {
          const message = await repositories.messages.steer({
            threadId,
            clientNonce,
            blocks: textMessageBlocks(text),
            runId: decision.action.runId,
          });

          return { action: "steer", message, runId: decision.action.runId };
        }

        case "start_run": {
          const created = await repositories.runs.create({
            threadId,
            clientNonce,
            prompt: text,
            blocks: textMessageBlocks(text),
          });

          // The run's nonce is scoped to the space, so a nonce spent on another
          // thread replays that thread's run. Returning it would answer this
          // send with a conversation the caller did not address; the send is
          // refused instead.
          if (created.run.threadId !== threadId) {
            throw new MessageNonceReusedError(created.message.id, "another_thread");
          }

          return { action: "start_run", message: created.message, runId: created.run.id };
        }
      }
    },

    async clear({ repositories, threadId }): Promise<ThreadRecord> {
      return repositories.threads.clear(threadId);
    },
  };
}

/** Core's rule vocabulary onto the transport's typed errors, in one place. */
function refusedSend(error: MessageRuleError): InvalidMessageError | MessageNonceReusedError {
  if (error instanceof ClientNonceReused) {
    return new MessageNonceReusedError(error.messageId, "different_text");
  }

  if (error instanceof EmptyMessage) {
    return new InvalidMessageError("empty");
  }

  if (error instanceof MessageTooLong) {
    return new InvalidMessageError("too_long");
  }

  if (error instanceof MissingClientNonce) {
    return new InvalidMessageError("missing_nonce");
  }

  if (error instanceof ClientNonceTooLong) {
    return new InvalidMessageError("nonce_too_long");
  }

  // Core grew a rule this boundary has not mapped. That is a defect — answered
  // 500 with a redacted line — rather than silently blaming the caller's text.
  throw new Error(`the send was refused by an unmapped message rule: ${error.name}`);
}

/** The record-to-wire mapping; the contract type is the only output shape. */
export function threadOutput(record: ThreadRecord): Thread {
  return {
    id: record.id,
    botId: record.botId,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function messageOutput(record: MessageRecord): Message {
  return {
    id: record.id,
    threadId: record.threadId,
    seq: record.seq,
    role: record.role,
    blocks: record.blocks as Message["blocks"],
    runId: record.runId,
    createdAt: record.createdAt.toISOString(),
  };
}
