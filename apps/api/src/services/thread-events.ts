import type { RealtimeFanout, ThreadSignal } from "@porkbot/adapter-kit";
import { parseRunEvent, RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import type { EventRecord, UserActor, UserRepositories } from "@porkbot/db";
import type { CursorCodec } from "../cursors.ts";

/**
 * The thread subscription service (slice 4.3, PRD decisions 14, 18 and 25).
 *
 * The durable event rows are the stream; the realtime fanout is only a
 * wake-up. A subscribe call re-resolves the thread inside the actor's scope
 * and verifies the resume cursor before a single frame is emitted, so a
 * failure there is the contract's typed `NOT_FOUND` or `BAD_REQUEST` rather
 * than an error mid-stream. From then on the loop replays `seq > cursor` in
 * order, waits for a fanout signal, and re-reads from the cursor — so a
 * duplicated signal costs a query, and a lost one costs latency, never an
 * event.
 *
 * The subscription owns the wire, never the run (PRD decision 25): closing or
 * losing the connection ends this generator and nothing else.
 */

export interface ThreadEventFrame {
  readonly event: RunEvent;
  /** The signed cursor that becomes the SSE `id` of this frame. */
  readonly cursor: string;
}

export interface ThreadSubscription {
  readonly actor: UserActor;
  readonly repositories: UserRepositories;
  readonly threadId: string;
  /** The `Last-Event-ID` header, when the client is resuming. */
  readonly lastEventId: string | undefined;
  readonly signal: AbortSignal | undefined;
}

export interface ThreadEventsService {
  /**
   * Validates the thread and the cursor, then returns the frame generator.
   * Rejects with a typed error before any frame when either check fails.
   */
  subscribe(subscription: ThreadSubscription): Promise<AsyncGenerator<ThreadEventFrame>>;
}

export interface ThreadEventsServiceOptions {
  readonly realtime: RealtimeFanout;
  readonly cursors: CursorCodec;
  /** Events read per query; also the page size that walks a backlog. */
  readonly pageSize?: number;
}

export const defaultEventPageSize = 100;

export function createThreadEventsService(
  options: ThreadEventsServiceOptions,
): ThreadEventsService {
  const { realtime, cursors } = options;
  const pageSize = options.pageSize ?? defaultEventPageSize;

  async function* replay(
    subscription: ThreadSubscription,
    fromSeq: number,
  ): AsyncGenerator<ThreadEventFrame> {
    const binding = {
      spaceId: subscription.actor.spaceId,
      threadId: subscription.threadId,
      userId: subscription.actor.userId,
    };
    const signals = realtime.subscribe(subscription.threadId, fromSeq)[Symbol.asyncIterator]();
    let lastSeq = fromSeq;

    try {
      while (subscription.signal?.aborted !== true) {
        const batch = await subscription.repositories.events.listAfter(
          subscription.threadId,
          lastSeq,
          pageSize,
        );

        for (const record of batch) {
          lastSeq = record.seq;

          yield {
            event: runEventFor(record),
            cursor: cursors.sign({ ...binding, seq: record.seq }),
          };
        }

        if (batch.length === pageSize) {
          continue;
        }

        const signal = await nextSignal(signals, subscription.signal);

        if (signal.done) {
          return;
        }
      }
    } finally {
      await signals.return?.(undefined);
    }
  }

  return {
    async subscribe(subscription: ThreadSubscription): Promise<AsyncGenerator<ThreadEventFrame>> {
      // Membership is re-validated on every subscribe and every resume: a
      // thread the actor cannot see is the same typed NOT_FOUND as one that
      // does not exist, and a cursor minted before access was revoked cannot
      // stream past the check.
      await subscription.repositories.threads.findById(subscription.threadId);

      const fromSeq =
        subscription.lastEventId === undefined
          ? 0
          : cursors.verify(subscription.lastEventId, {
              spaceId: subscription.actor.spaceId,
              threadId: subscription.threadId,
              userId: subscription.actor.userId,
            });

      return replay(subscription, fromSeq);
    },
  };
}

/**
 * Wakes with the next fanout signal or when the request is aborted, whichever
 * comes first, and cleans the abort listener up either way. The subscription
 * would otherwise stay parked on a signal that may never come while its client
 * is already gone.
 */
async function nextSignal(
  signals: AsyncIterator<ThreadSignal>,
  signal: AbortSignal | undefined,
): Promise<IteratorResult<ThreadSignal>> {
  const done: IteratorResult<ThreadSignal> = { done: true, value: undefined };

  if (signal === undefined) {
    return signals.next();
  }

  if (signal.aborted) {
    return done;
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<IteratorResult<ThreadSignal>>((resolve) => {
    onAbort = () => {
      resolve(done);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([signals.next(), aborted]);
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * The persisted row reconstructed into the wire event core parses. The base
 * fields come from the row's columns, never from the payload, so a payload
 * cannot rewrite the sequence position or redirect the thread. A row the
 * vocabulary does not understand is a defect — the reducer's parser names it
 * and the boundary answers 500 — never an event delivered as if understood.
 */
function runEventFor(record: EventRecord): RunEvent {
  const parsed = parseRunEvent({
    ...record.payload,
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq: record.seq,
    threadId: record.threadId,
    runId: record.runId,
    type: record.type,
  });

  if (!parsed.ok) {
    throw parsed.error;
  }

  return parsed.event;
}
