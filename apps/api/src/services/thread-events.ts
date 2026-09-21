import type { RealtimeFanout, ThreadSignal } from "@porkbot/adapter-kit";
import { storedRunEvent } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import type { EventRecord, UserActor, UserRepositories } from "@porkbot/db";
import { NotFoundError } from "@porkbot/effect";
import type { CursorCodec } from "../cursors.ts";

/**
 * The thread subscription service (slice 4.3, PRD decisions 14, 18 and 25;
 * slice 3.3 for the live revocation check).
 *
 * The durable event rows are the stream; the realtime fanout is only a
 * wake-up. A subscribe call re-resolves the thread inside the actor's scope
 * and verifies the resume cursor before a single frame is emitted, so a
 * failure there is the contract's typed `NOT_FOUND` or `BAD_REQUEST` rather
 * than an error mid-stream. From then on the loop re-reads the actor's
 * membership, replays `seq > cursor` in order, re-reads the membership before
 * each frame is sent, and waits for a fanout signal between passes — so a
 * duplicated signal costs a query, a lost one costs latency, never an event,
 * and a membership revoked while the stream is open ends it before another
 * event is delivered. The client's reconnect is then answered the typed
 * `NOT_FOUND` at subscribe time.
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
  /** Maximum latency for a persisted event whose fanout signal was lost. */
  readonly pollIntervalMs?: number;
}

export const defaultEventPageSize = 100;
export const defaultEventPollIntervalMs = 1_000;

export function createThreadEventsService(
  options: ThreadEventsServiceOptions,
): ThreadEventsService {
  const { realtime, cursors } = options;
  const pageSize = options.pageSize ?? defaultEventPageSize;
  const pollIntervalMs = options.pollIntervalMs ?? defaultEventPollIntervalMs;

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
    let pendingSignal = signals.next();
    let lastSeq = fromSeq;

    try {
      while (subscription.signal?.aborted !== true) {
        // The membership is re-read before every replay step, not only at
        // subscribe, so a stream that outlives its actor's access ends here
        // instead of replaying rows the actor may no longer see. Anything but
        // the typed refusal — an outage, a defect — propagates.
        if (!(await membershipActive(subscription))) {
          return;
        }

        const batch = await subscription.repositories.events.listAfter(
          subscription.threadId,
          lastSeq,
          pageSize,
        );

        for (const record of batch) {
          // Re-checked before every frame, not only before every query: a
          // batch fetched while the membership was live must not deliver an
          // event after it was revoked. The read is the indexed membership
          // lookup, and it is the price of a stream that cannot outlive
          // access.
          if (!(await membershipActive(subscription))) {
            return;
          }

          lastSeq = record.seq;

          yield {
            event: runEventFor(record),
            cursor: cursors.sign({ ...binding, seq: record.seq }),
          };
        }

        if (batch.length === pageSize) {
          continue;
        }

        const wake = await nextSignal(pendingSignal, subscription.signal, pollIntervalMs);

        if (wake.kind === "aborted" || (wake.kind === "signal" && wake.result.done)) {
          return;
        }

        // Keep the same outstanding iterator read after a poll timeout. A
        // second `next()` would overwrite an in-process waiter's resolver and
        // turn a later signal into a leak instead of a wake-up.
        if (wake.kind === "signal") {
          pendingSignal = signals.next();
        }
      }
    } finally {
      await signals.return?.(undefined);
    }
  }

  return {
    async subscribe(subscription: ThreadSubscription): Promise<AsyncGenerator<ThreadEventFrame>> {
      // Membership is re-validated on every subscribe and every resume, beside
      // the thread read: a thread the actor cannot see and a membership that
      // was revoked are both the same typed NOT_FOUND, before any frame is
      // sent. A cursor minted before access was revoked cannot stream past the
      // check, and the replay loop repeats the check on every step and before
      // every frame, so a stream that outlives its access ends at the next
      // wake-up or frame.
      await subscription.repositories.membership.requireActive();
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
 * Whether the actor's membership is still alive. The repository's scoped read
 * answers the typed `NotFoundError` once the row is gone; that refusal is what
 * ends the stream.
 */
async function membershipActive(subscription: ThreadSubscription): Promise<boolean> {
  try {
    await subscription.repositories.membership.requireActive();

    return true;
  } catch (error) {
    if (error instanceof NotFoundError) {
      return false;
    }

    throw error;
  }
}

/**
 * Wakes with the next fanout signal or when the request is aborted, whichever
 * comes first, and cleans the abort listener up either way. The subscription
 * would otherwise stay parked on a signal that may never come while its client
 * is already gone.
 */
type SignalWake =
  | { readonly kind: "signal"; readonly result: IteratorResult<ThreadSignal> }
  | { readonly kind: "poll" }
  | { readonly kind: "aborted" };

async function nextSignal(
  pending: Promise<IteratorResult<ThreadSignal>>,
  signal: AbortSignal | undefined,
  pollIntervalMs: number,
): Promise<SignalWake> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const polled = new Promise<SignalWake>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "poll" }), pollIntervalMs);
  });

  if (signal?.aborted === true) {
    clearTimeout(timer);
    return { kind: "aborted" };
  }

  let onAbort: (() => void) | undefined;
  const aborted = new Promise<SignalWake>((resolve) => {
    onAbort = () => {
      resolve({ kind: "aborted" });
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });

  try {
    return await Promise.race([
      pending.then((result): SignalWake => ({ kind: "signal", result })),
      polled,
      aborted,
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }

    if (signal !== undefined && onAbort !== undefined) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * The persisted row reconstructed into the wire event core parses. The
 * reconstruction is `storedRunEvent`, the one function the worker's replay
 * reads rows through as well, so a replayed frame and a live one can never
 * disagree about what a row meant.
 */
function runEventFor(record: EventRecord): RunEvent {
  return storedRunEvent(record);
}
