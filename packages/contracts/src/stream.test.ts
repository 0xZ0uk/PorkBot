import { ORPCError, withEventMeta } from "@orpc/client";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { AppClient } from "./client.ts";
import { subscribeThreadEvents } from "./stream.ts";
import type { ThreadEventsCallOptions, ThreadEventsProcedure } from "./stream.ts";

/**
 * The reconnect loop, without a server and without real timers: a fake
 * subscription procedure scripts the drops, the backoff policy is the core
 * one with jitter pinned off, and the injected sleep records the delays. What
 * is proven here is the promise story 19 makes — resume from the last cursor
 * rather than refetch, back off between attempts, and do not retry a refusal.
 */

const input = { threadId: "thread-1" } as const;

const firstEvent: RunEvent = {
  schemaVersion: RUN_EVENT_SCHEMA_VERSION,
  seq: 1,
  threadId: "thread-1",
  runId: "run-1",
  type: "run.started",
};

const pinnedPolicy = { baseDelayMs: 100, maxDelayMs: 10_000, multiplier: 2, jitterRatio: 0 };

function emptyStream(): AsyncIterable<RunEvent> {
  return {
    [Symbol.asyncIterator](): AsyncIterator<RunEvent> {
      return {
        next: async (): Promise<IteratorResult<RunEvent>> => ({ done: true, value: undefined }),
      };
    },
  };
}

describe("the reconnecting subscription", () => {
  it("accepts the derived client's procedure", () => {
    expectTypeOf<AppClient["threads"]["events"]>().toExtend<ThreadEventsProcedure>();
  });

  it("reconnects from the last cursor and backs off between drops", async () => {
    const attempts: ThreadEventsCallOptions[] = [];
    const delays: number[] = [];

    const procedure: ThreadEventsProcedure = async (_input, options) => {
      attempts.push(options);

      if (attempts.length === 1) {
        throw new TypeError("the network is down");
      }

      if (attempts.length === 2) {
        return (async function* () {
          yield withEventMeta(firstEvent, { id: "cursor-1" });
          throw new TypeError("the connection dropped mid-stream");
        })();
      }

      throw new ORPCError("BAD_REQUEST", {
        defined: true,
        status: 400,
        message: "the resume cursor is not valid for this stream",
      });
    };

    const received: RunEvent[] = [];
    const subscription = (async () => {
      for await (const event of subscribeThreadEvents(procedure, input, {
        policy: pinnedPolicy,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
      })) {
        received.push(event);
      }
    })();

    await expect(subscription).rejects.toBeInstanceOf(ORPCError);
    expect(received).toEqual([firstEvent]);
    expect(delays).toEqual([100, 100]);
    expect(attempts).toEqual([{}, {}, { lastEventId: "cursor-1" }]);
  });

  it("grows the delay when a reconnect ends without delivering a frame", async () => {
    const controller = new AbortController();
    const delays: number[] = [];

    const procedure: ThreadEventsProcedure = async () => emptyStream();

    for await (const event of subscribeThreadEvents(procedure, input, {
      signal: controller.signal,
      policy: pinnedPolicy,
      sleep: async (delayMs) => {
        delays.push(delayMs);

        if (delays.length === 3) {
          controller.abort();
        }
      },
    })) {
      expect(event).toBeDefined();
      throw new Error("an empty stream yields nothing");
    }

    expect(delays).toEqual([100, 200, 400]);
  });

  it("ends an open subscription when the caller aborts", async () => {
    const controller = new AbortController();

    const procedure: ThreadEventsProcedure = async (_input, options) =>
      (async function* () {
        yield firstEvent;

        if (options.signal?.aborted === true) {
          return;
        }

        await new Promise<void>((resolve) => {
          options.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      })();

    const iterator = subscribeThreadEvents(procedure, input, { signal: controller.signal });

    await expect(iterator.next()).resolves.toEqual({ done: false, value: firstEvent });

    controller.abort();

    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it("does not retry a typed client refusal", async () => {
    const controller = new AbortController();
    let calls = 0;

    const procedure: ThreadEventsProcedure = async () => {
      calls += 1;
      throw new ORPCError("NOT_FOUND", { defined: true, status: 404, message: "no such thread" });
    };

    const iterator = subscribeThreadEvents(procedure, input, {
      signal: controller.signal,
      sleep: async () => {
        throw new Error("a refusal must not reach the backoff delay");
      },
    });

    await expect(iterator.next()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(calls).toBe(1);

    controller.abort();
  });
});
