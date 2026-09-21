import { getEventMeta } from "@orpc/client";
import { backoffDelayMs } from "@porkbot/core";
import type { BackoffPolicy, RunEvent } from "@porkbot/core";
import { ORPCError } from "./errors.ts";

/**
 * The client half of a resumable thread subscription (PRD decision 18, story
 * 19): consume `threads.events` until the caller aborts, reconnecting with the
 * core backoff policy and the last received event's signed cursor.
 *
 * The cursor is the SSE `id` of the last event, read with `getEventMeta`; it is
 * bound to the actor, the space and the thread, so the server refuses a forged
 * or foreign one instead of silently replaying someone else's stream. A
 * reconnect therefore sends `Last-Event-ID` and receives every event after the
 * cursor and nothing it has already seen — a dropped connection costs latency,
 * never an event or a duplicate.
 *
 * Retry policy: a transport failure or a 5xx/429 reconnect with bounded
 * exponential backoff plus jitter, implemented once in `@porkbot/core`; a
 * 4xx — the typed `NOT_FOUND`, `UNAUTHORIZED` or `BAD_REQUEST` the server
 * answers — is rethrown, because retrying a cursor the server rejected would
 * loop forever. The attempt counter resets only when a frame is delivered, so
 * a server accepting connections that immediately end still backs off.
 * Connection state is different: once the procedure has accepted the
 * subscription, an idle thread is live even with no event to deliver yet.
 *
 * The loop is also the one authority on connection state: `onState` reports
 * `connecting`, `live`, `reconnecting` and `resumed` as they happen, so a
 * surface renders the phase from the loop that owns it instead of guessing
 * from frame timing.
 */

/** The input the subscription takes; the cursor travels in the header. */
export interface ThreadEventsInput {
  readonly threadId: string;
}

/** The per-call options the oRPC client carries the signal and cursor in. */
export interface ThreadEventsCallOptions {
  readonly signal?: AbortSignal;
  readonly lastEventId?: string;
}

/**
 * The connection's phase, as a surface renders it. `connecting` is an attempt
 * the server has not accepted yet; `live` is an accepted first connection;
 * `reconnecting` is the backoff wait after one; and `resumed` is the next
 * accepted connection after it. Acceptance, rather than the first event,
 * decides `live`: an idle thread is still connected when it has no frame to
 * send.
 */
export type ThreadSubscriptionState = "connecting" | "live" | "reconnecting" | "resumed";

/**
 * The subscription procedure's shape, structurally: `AppClient["threads"]
 * ["events"]` satisfies it, and a test can hand in a fake without the nominal
 * `AsyncIteratorClass` the derived client returns.
 */
export interface ThreadEventsProcedure {
  (input: ThreadEventsInput, options: ThreadEventsCallOptions): Promise<AsyncIterable<RunEvent>>;
}

export interface ThreadSubscriptionOptions {
  /** Ends the subscription; an in-flight reconnect delay is interrupted too. */
  readonly signal?: AbortSignal;
  /** Overrides the core policy; `DEFAULT_BACKOFF` when unset. */
  readonly policy?: BackoffPolicy;
  /** Injectable randomness so the jitter is deterministic in tests. */
  readonly random?: () => number;
  /** Injectable delay so tests do not wait on real timers. */
  readonly sleep?: (delayMs: number, signal: AbortSignal | undefined) => Promise<void>;
  /**
   * Reports every phase change, so a surface renders connection state from the
   * one reconnect loop rather than re-deriving it from frame timing. It is
   * called synchronously before the frame that caused the change is yielded;
   * a caller that only needs the events can ignore it.
   */
  readonly onState?: (state: ThreadSubscriptionState) => void;
}

/**
 * Subscribes to one thread's events, yielding typed events and reconnecting
 * transparently. The cursor of each yielded event is `getEventMeta(event)?.id`,
 * which a surface persists when it needs to resume after a reload.
 */
export async function* subscribeThreadEvents(
  events: ThreadEventsProcedure,
  input: ThreadEventsInput,
  options: ThreadSubscriptionOptions = {},
): AsyncGenerator<RunEvent> {
  const { signal, onState } = options;
  const sleep = options.sleep ?? delay;
  const aborted = (): boolean => signal?.aborted === true;
  let lastEventId: string | undefined;
  let attempt = 0;
  let dropped = false;

  while (!aborted()) {
    onState?.("connecting");

    try {
      const stream = await events(input, {
        ...(signal === undefined ? {} : { signal }),
        ...(lastEventId === undefined ? {} : { lastEventId }),
      });

      // Resolving the procedure means the server accepted the subscription.
      // A new or idle thread may correctly hold it open without yielding a
      // frame, so frame timing cannot decide whether the connection is live.
      onState?.(dropped ? "resumed" : "live");

      for await (const event of stream) {
        const id = getEventMeta(event)?.id;

        if (id !== undefined) {
          lastEventId = id;
          attempt = 0;
        }

        yield event;
      }
    } catch (error) {
      if (aborted() || !isRetryable(error)) {
        throw error;
      }
    }

    if (aborted()) {
      return;
    }

    dropped = true;
    onState?.("reconnecting");

    attempt += 1;
    await sleep(
      backoffDelayMs(attempt, {
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.random === undefined ? {} : { random: options.random }),
      }),
      signal,
    );
  }
}

/**
 * A refusal the client can act on is not retried: a typed 4xx means the same
 * request will keep failing, while a network error (no status at all) and a
 * 5xx/429 are the drop the backoff exists for.
 */
function isRetryable(error: unknown): boolean {
  if (!(error instanceof ORPCError)) {
    return true;
  }

  return error.status >= 500 || error.status === 429;
}

/** A sleep that wakes immediately when the subscription is aborted. */
function delay(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal === undefined) {
      setTimeout(resolve, delayMs);
      return;
    }

    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    signal.addEventListener("abort", onAbort, { once: true });

    if (signal.aborted) {
      onAbort();
    }
  });
}
