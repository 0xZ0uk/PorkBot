import { describe, expect, it } from "vitest";
import { InProcessRealtimeFanout } from "./realtime.ts";

/**
 * The in-process fanout is a wake-up bus, not an event store: these tests pin
 * the promises a subscriber depends on — signals ahead of its cursor arrive,
 * signals at or behind it are ignored, threads are isolated, and returning from
 * the subscription unsubscribes.
 */

describe("the in-process realtime fanout", () => {
  it("delivers a signal published ahead of the subscriber's cursor", async () => {
    const fanout = new InProcessRealtimeFanout();
    const signals = fanout.subscribe("thread-1", 3)[Symbol.asyncIterator]();

    await fanout.publish({ threadId: "thread-1", latestSeq: 4 });

    await expect(signals.next()).resolves.toEqual({
      done: false,
      value: { threadId: "thread-1", latestSeq: 4 },
    });

    await signals.return?.(undefined);
  });

  it("ignores a signal at or behind the cursor, so a replay cannot wake it forever", async () => {
    const fanout = new InProcessRealtimeFanout();
    const iterator = fanout.subscribe("thread-1", 3)[Symbol.asyncIterator]();
    const next = iterator.next();

    await fanout.publish({ threadId: "thread-1", latestSeq: 3 });
    await fanout.publish({ threadId: "thread-1", latestSeq: 2 });

    // The two publishes must not have resolved the pull; a fourth-position
    // signal does, proving the wait survived the ignored ones.
    await fanout.publish({ threadId: "thread-1", latestSeq: 4 });

    await expect(next).resolves.toEqual({
      done: false,
      value: { threadId: "thread-1", latestSeq: 4 },
    });

    await iterator.return?.(undefined);
  });

  it("queues signals that arrive before the consumer pulls, without losing one", async () => {
    const fanout = new InProcessRealtimeFanout();
    const iterator = fanout.subscribe("thread-1", 0)[Symbol.asyncIterator]();

    await fanout.publish({ threadId: "thread-1", latestSeq: 1 });
    await fanout.publish({ threadId: "thread-1", latestSeq: 2 });

    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { threadId: "thread-1", latestSeq: 1 },
    });
    await expect(iterator.next()).resolves.toEqual({
      done: false,
      value: { threadId: "thread-1", latestSeq: 2 },
    });

    await iterator.return?.(undefined);
  });

  it("keeps threads and subscribers apart", async () => {
    const fanout = new InProcessRealtimeFanout();
    const first = fanout.subscribe("thread-1", 0)[Symbol.asyncIterator]();
    const second = fanout.subscribe("thread-1", 0)[Symbol.asyncIterator]();
    const other = fanout.subscribe("thread-2", 0)[Symbol.asyncIterator]();

    await fanout.publish({ threadId: "thread-1", latestSeq: 1 });

    await expect(first.next()).resolves.toMatchObject({ value: { latestSeq: 1 } });
    await expect(second.next()).resolves.toMatchObject({ value: { latestSeq: 1 } });

    await fanout.publish({ threadId: "thread-2", latestSeq: 9 });

    await expect(other.next()).resolves.toMatchObject({
      value: { threadId: "thread-2", latestSeq: 9 },
    });

    await first.return?.(undefined);
    await second.return?.(undefined);
    await other.return?.(undefined);
  });

  it("stops delivering after the subscription is returned", async () => {
    const fanout = new InProcessRealtimeFanout();
    const iterator = fanout.subscribe("thread-1", 0)[Symbol.asyncIterator]();

    await iterator.return?.(undefined);

    await expect(fanout.publish({ threadId: "thread-1", latestSeq: 1 })).resolves.toBeUndefined();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
