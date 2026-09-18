import { eventIterator } from "@orpc/contract";
import {
  MAX_CLIENT_NONCE_LENGTH,
  MAX_MESSAGE_TEXT_LENGTH,
  RUN_EVENT_SCHEMA_VERSION,
} from "@porkbot/core";
import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The thread module: a bot's conversations, their transcripts and the
 * resumable SSE subscription over a thread's run events (slices 4.3 and 6.5,
 * PRD decisions 5, 14, 18 and 25).
 *
 * A thread belongs to a bot, and every procedure names a bot, a thread or a
 * message — never a space. The actor-scoped repository binds the space, so a
 * foreign id and a missing one are the same typed `NOT_FOUND` (PRD decision
 * 7). Creation is explicit (`threads.create`); sending is idempotent on the
 * caller's nonce (`threads.send`), because the client may retry a request it
 * never saw answered and the retry must replay the first message and run
 * rather than create a second (PRD decision 5).
 *
 * Lists are keyset-paginated and stable: threads are ordered by last activity
 * with the id as the tiebreaker, messages by their contiguous per-thread
 * sequence, and each page carries the cursor for the next one. The cursor is
 * typed rather than opaque — it is the ordering key itself — so a caller
 * cannot present a malformed one and a new ordering field is a contract edit.
 *
 * The wire event is the `RunEvent` union from `@porkbot/core`, mirrored here as
 * a discriminated zod union. The contract owns the transport shape while core
 * owns the interpretation, and `threads.test.ts` pins the two together: a
 * client consumes the subscription through the derived `AppClient`, feeds the
 * typed events to the same reducer the web and desktop surfaces share, and
 * cannot invent a second reading of the stream (PRD decision 14).
 *
 * Resumption is a header, not an input: the SSE `id` of the last received
 * event is the opaque signed cursor, a reconnecting client sends it as
 * `Last-Event-ID`, and oRPC hands it to the handler as `lastEventId`. A
 * cursor is bound to the actor, the space and the thread, so replaying another
 * space's stream by guessing an event id is refused with the typed
 * `BAD_REQUEST` below (PRD decision 18).
 */

/**
 * One block of a message's content. The union has one member today because the
 * composer sends plain text; core's `MessageBlock` is the domain vocabulary
 * this mirrors, and a second kind arrives in both places together.
 */
export const messageBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string() }),
]);

export const messageRoleSchema = z.enum(["user", "assistant"]);

export const messageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  /** The position in the thread's transcript; contiguous and 0-based. */
  seq: z.number().int().min(0),
  role: messageRoleSchema,
  blocks: z.array(messageBlockSchema),
  /** The run this message started or steered, when it is known. */
  runId: z.string().nullable(),
  createdAt: z.iso.datetime(),
});

export type Message = z.infer<typeof messageSchema>;

export const threadSchema = z.object({
  id: z.string().min(1),
  botId: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Thread = z.infer<typeof threadSchema>;

/** How many rows a page asks for when the caller does not say. */
export const defaultThreadPageSize = 20;
export const defaultMessagePageSize = 50;
export const maxPageSize = 100;

/**
 * The keyset cursor for `threads.list`: the ordering key of the last row of a
 * page. Typed rather than opaque on purpose — `(updatedAt, id)` is what the
 * query orders by, and a caller that echoes it back verbatim is asking for the
 * rows after that exact position even while threads move.
 */
export const threadCursorSchema = z.object({
  updatedAt: z.iso.datetime(),
  // A uuid because the query casts it to one; a cursor the database would
  // refuse is refused at the schema instead of failing mid-statement.
  id: z.uuid(),
});

export type ThreadCursor = z.infer<typeof threadCursorSchema>;

export const threadsCreateContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/threads",
    operationId: "threadsCreate",
    summary: "Start a thread for one bot",
  })
  .input(z.object({ botId: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(threadSchema);

export const threadsListContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/bots/{botId}/threads",
    operationId: "threadsList",
    summary: "A bot's threads, most recently active first",
  })
  .input(
    z.object({
      botId: z.string().min(1),
      limit: z.number().int().min(1).max(maxPageSize).default(defaultThreadPageSize),
      /** The previous page's `nextCursor`; absent asks for the first page. */
      after: threadCursorSchema.optional(),
    }),
  )
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such bot in this space",
    },
  })
  .output(
    z.object({
      threads: z.array(threadSchema),
      /** The cursor for the next page, or `null` when this page is the last. */
      nextCursor: threadCursorSchema.nullable(),
    }),
  );

export const threadsMessagesContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/threads/{threadId}/messages",
    operationId: "threadsMessages",
    summary: "A thread's transcript in sequence order",
  })
  .input(
    z.object({
      threadId: z.string().min(1),
      limit: z.number().int().min(1).max(maxPageSize).default(defaultMessagePageSize),
      /** Return messages with a sequence greater than this one. */
      afterSeq: z.number().int().min(0).optional(),
    }),
  )
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such thread in this space",
    },
  })
  .output(
    z.object({
      messages: z.array(messageSchema),
      /** The sequence to pass as `afterSeq` for the next page, or `null`. */
      nextSeq: z.number().int().min(0).nullable(),
    }),
  );

export const threadsSendContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/threads/{threadId}/messages",
    operationId: "threadsSend",
    summary: "Send a message; an idle thread starts a run, a live one steers it",
  })
  .input(
    z.object({
      threadId: z.string().min(1),
      text: z.string().min(1).max(MAX_MESSAGE_TEXT_LENGTH),
      /**
       * The caller's idempotency key for this send. A resubmission of the same
       * nonce and text replays the first message and run; the same nonce with
       * other text is a typed conflict, never a second message.
       */
      clientNonce: z.string().min(1).max(MAX_CLIENT_NONCE_LENGTH),
    }),
  )
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such thread in this space",
    },
    /** The send broke one of core's message rules (blank or oversized). */
    BAD_REQUEST: {
      status: 400,
      message: "The message did not pass the send rules",
    },
    /** The nonce already belongs to a different message or thread. */
    CONFLICT: {
      status: 409,
      message: "That client nonce already belongs to another message",
    },
  })
  .output(
    z.object({
      /**
       * What the send did: `start_run` created the message and its run,
       * `steer` appended the message to the thread's live run, and `replay`
       * returned the message an earlier submission of this nonce produced.
       */
      action: z.enum(["start_run", "steer", "replay"]),
      message: messageSchema,
      /** The run that started, is live, or was replayed; null if it is gone. */
      runId: z.string().nullable(),
    }),
  );

export const threadsClearContract = authenticatedProcedure
  .route({
    method: "POST",
    path: "/threads/{threadId}/clear",
    operationId: "threadsClear",
    summary: "Clear a thread's transcript and event stream, keeping its memory",
  })
  .input(z.object({ threadId: z.string().min(1) }))
  .errors({
    NOT_FOUND: {
      status: 404,
      message: "No such thread in this space",
    },
  })
  .output(threadSchema);

const eventBase = {
  schemaVersion: z.literal(RUN_EVENT_SCHEMA_VERSION),
  /** The position in the thread's stream; contiguous and 1-based. */
  seq: z.number().int().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
} as const;

/**
 * Where an oversized tool result's full value lives: the `external_effect` row
 * of the call. Mirrors core's `ToolResultArtifact`, so a client can render the
 * preview and link the pointer without a second interpretation (slice 5.6).
 */
const toolResultArtifact = z.object({
  kind: z.literal("tool_call"),
  callId: z.string().min(1),
  bytes: z.number().int().min(0),
});

export const runEventSchema = z.discriminatedUnion("type", [
  z.object({ ...eventBase, type: z.literal("run.started") }),
  z.object({
    ...eventBase,
    type: z.literal("token.delta"),
    messageId: z.string().min(1),
    delta: z.string(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.requested"),
    callId: z.string().min(1),
    tool: z.string().min(1),
    arguments: z.unknown(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("approval.requested"),
    callId: z.string().min(1),
    /** The durable deadline the gate denies at, as an ISO 8601 instant. */
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("approval.resolved"),
    callId: z.string().min(1),
    decision: z.enum(["approved", "denied", "timed_out"]),
    reason: z.exactOptional(z.string().min(1)),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.completed"),
    callId: z.string().min(1),
    result: z.unknown(),
    resultArtifact: z.exactOptional(toolResultArtifact),
    durationMs: z.exactOptional(z.number().int().min(0)),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.failed"),
    callId: z.string().min(1),
    error: z.string(),
    durationMs: z.exactOptional(z.number().int().min(0)),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.completed"),
    messageId: z.exactOptional(z.string().min(1)),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.failed"),
    error: z.string(),
    code: z.exactOptional(z.string().min(1)),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.cancelled"),
    reason: z.exactOptional(z.string()),
  }),
  z.object({
    ...eventBase,
    type: z.literal("run.steered"),
    messageId: z.string().min(1),
    text: z.string(),
  }),
]);

export type RunEventMessage = z.infer<typeof runEventSchema>;

export const threadsEventsContract = authenticatedProcedure
  .route({
    method: "GET",
    path: "/threads/{threadId}/events",
    operationId: "threadsEvents",
    summary: "A thread's events as SSE, resumable from a signed cursor",
  })
  .input(z.object({ threadId: z.string().min(1) }))
  .errors({
    /**
     * No such thread *in the actor's space*, re-checked on every subscribe and
     * resume rather than only on the first connection.
     */
    NOT_FOUND: {
      status: 404,
      message: "No such thread in this space",
    },
    /**
     * The `Last-Event-ID` cursor was malformed, forged, or signed for another
     * actor, space or thread. The client's recovery is to refetch from zero
     * rather than to retry the same cursor.
     */
    BAD_REQUEST: {
      status: 400,
      message: "The resume cursor is not valid for this stream",
    },
  })
  .output(eventIterator(runEventSchema));
