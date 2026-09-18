import type { RealtimeFanout, ThreadSignal } from "@porkbot/adapter-kit";

/**
 * The in-process realtime fanout (slice 4.3): the first implementation of the
 * seam in `@porkbot/adapter-kit/src/realtime.ts`.
 *
 * It carries wake-ups, never events. A publisher announces "this thread has
 * persisted events up to `latestSeq`" after the rows are durable, and a
 * subscriber that missed a signal simply reads its cursor against the persisted
 * events, so the only thing this class owes is that a signal it accepted is
 * eventually delivered. Publishing the same signal twice is harmless; a
 * subscriber only hears about a thread it asked for and only about positions
 * ahead of the cursor it subscribed with.
 *
 * The scope is one process — the API streams and a same-process publisher
 * wakes it. The worker that actually executes runs is a separate process, which
 * is why the durable cross-process implementation over Postgres
 * `LISTEN`/`NOTIFY` is planned for slice 6.1; swapping it in cannot change what
 * a subscriber has seen, because both are wake-ups over the persisted rows.
 *
 * Failure mapping: nothing here can fail. A dropped signal degrades to the
 * next read of the durable event rows, so the loss is latency, never data.
 */

interface Waiter {
  readonly fromSeq: number;
  readonly deliver: (signal: ThreadSignal) => void;
}

const done: IteratorResult<ThreadSignal> = { done: true, value: undefined };

export class InProcessRealtimeFanout implements RealtimeFanout {
  readonly #waiters = new Map<string, Set<Waiter>>();

  async publish(signal: ThreadSignal): Promise<void> {
    const waiters = this.#waiters.get(signal.threadId);

    if (waiters === undefined) {
      return;
    }

    // A copy: a delivery may synchronously unsubscribe through the consumer's
    // loop and mutate the set mid-iteration.
    for (const waiter of [...waiters]) {
      if (signal.latestSeq > waiter.fromSeq) {
        waiter.deliver(signal);
      }
    }
  }

  subscribe(threadId: string, fromSeq: number): AsyncIterable<ThreadSignal> {
    // Registration is eager rather than lazy: a signal published between the
    // subscribe call and the consumer's first pull must not be dropped.
    const registry = this.#waiters;
    const queue: ThreadSignal[] = [];
    let wake: (() => void) | undefined;
    let released = false;

    const waiter: Waiter = {
      fromSeq,
      deliver: (signal) => {
        queue.push(signal);
        const resolve = wake;
        wake = undefined;
        resolve?.();
      },
    };

    const waiters = registry.get(threadId) ?? new Set<Waiter>();
    waiters.add(waiter);
    registry.set(threadId, waiters);

    function unsubscribe(): void {
      waiters.delete(waiter);

      if (waiters.size === 0) {
        registry.delete(threadId);
      }

      queue.length = 0;
      released = true;
      const resolve = wake;
      wake = undefined;
      resolve?.();
    }

    const iterator: AsyncIterator<ThreadSignal> = {
      async next(): Promise<IteratorResult<ThreadSignal>> {
        if (released) {
          return done;
        }

        while (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });

          if (released) {
            return done;
          }
        }

        const signal = queue.shift();

        return signal === undefined ? done : { done: false, value: signal };
      },

      async return(): Promise<IteratorResult<ThreadSignal>> {
        unsubscribe();

        return done;
      },
    };

    return {
      [Symbol.asyncIterator]: () => iterator,
    };
  }
}
