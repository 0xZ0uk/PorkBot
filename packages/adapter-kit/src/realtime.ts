import type { FailureMapping } from "./failures.ts";

/**
 * The realtime fanout seam (PRD decisions 14, 18, 25; story 19).
 *
 * Run events are persisted with a contiguous per-thread sequence number, and a
 * subscriber resumes from a cursor by reading them. This interface carries only
 * the wake-up: a signal saying "this thread has events past `latestSeq`". The
 * payload never travels here, so a dropped signal costs a poll and never an
 * event, and a reconnecting client cannot be handed a second interpretation of
 * a stream that the persisted rows already define.
 *
 * Two implementations are planned: an in-process fanout (slice 4.3) for a
 * single process and the e2e tier, and a durable cross-process fanout over
 * Postgres `LISTEN`/`NOTIFY` (slice 6.1) for the shape that actually ships —
 * the worker executing runs and the API streaming them. Both are wake-ups over
 * the same persisted events, which is why swapping them cannot change what a
 * subscriber has seen.
 *
 * Failure mapping: a provider raises an error that implements
 * `ProviderFailure`, classified by the `failureMapping` table below. Every
 * failure here degrades to the cursor: the durable event rows remain the source
 * of truth, so a signal lost is latency, never data.
 */

/** A thread has events at least up to `latestSeq`; the subscriber reads them. */
export interface ThreadSignal {
  readonly threadId: string;
  /** The highest persisted sequence number the publisher has seen. */
  readonly latestSeq: number;
}

export interface RealtimeFanout {
  /** Announce that a thread has new persisted events; publishing the same signal twice is harmless. */
  publish(signal: ThreadSignal): Promise<void>;
  /**
   * Yield signals for one thread whose `latestSeq` is ahead of the cursor.
   * The subscription ends when the caller stops iterating; a gap in signals is
   * safe because the cursor is re-read after every wake-up.
   */
  subscribe(threadId: string, fromSeq: number): AsyncIterable<ThreadSignal>;
}

export const failureMapping: FailureMapping = {
  gone: "Not produced: signals are ephemeral and own nothing; a subscriber that missed one resumes from its cursor against the persisted events.",
  not_found:
    "Not produced: subscribing to a thread with no events is an idle subscription, not a failure.",
  rate_limited:
    "The backing broker refuses work under a quota; the subscriber falls back to the persisted-event cursor and the signal is retried later.",
  timed_out:
    "A publish or subscription heartbeat exceeded its budget; because the rows are durable, the loss is latency rather than a missing event.",
  auth_failed:
    "The broker credential is missing or refused; fanout fails closed at boot rather than running silently without live updates.",
};
