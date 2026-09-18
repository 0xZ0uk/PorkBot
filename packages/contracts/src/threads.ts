import { eventIterator } from "@orpc/contract";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import { z } from "zod";
import { authenticatedProcedure } from "./access.ts";

/**
 * The thread events module: the resumable SSE subscription (slice 4.3, PRD
 * decisions 14 and 18).
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

const eventBase = {
  schemaVersion: z.literal(RUN_EVENT_SCHEMA_VERSION),
  /** The position in the thread's stream; contiguous and 1-based. */
  seq: z.number().int().min(1),
  threadId: z.string().min(1),
  runId: z.string().min(1),
} as const;

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
    type: z.literal("tool.completed"),
    callId: z.string().min(1),
    result: z.unknown(),
  }),
  z.object({
    ...eventBase,
    type: z.literal("tool.failed"),
    callId: z.string().min(1),
    error: z.string(),
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
