import { Deferred, Effect, Exit, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import { reportUsage } from "./usage.ts";
import type { RunUsage, UsageRecorder } from "./usage.ts";

/**
 * The "usage never fails a run" policy, pinned where it lives.
 *
 * The adapters' suites prove the reports themselves; this suite proves the
 * policy the adapters delegate to: an absent recorder is a no-op, a rejected
 * write is swallowed, and a recorder that never settles is interruptible —
 * losing the lease must not be mistaken for a usage failure. A defect is
 * deliberately not swallowed, because a broken recorder is a bug to surface,
 * not a transient refusal to ignore.
 */

const usage: RunUsage = {
  runId: "run-1",
  provider: "openai",
  model: "test-model",
  inputTokens: 10,
  outputTokens: 2,
};

describe("reportUsage", () => {
  it("does nothing when the run has no recorder", async () => {
    await expect(Effect.runPromise(reportUsage(undefined, usage))).resolves.toBeUndefined();
  });

  it("records the usage when the recorder accepts it", async () => {
    const recorded: RunUsage[] = [];
    const recorder: UsageRecorder = {
      record: async (entry) => {
        recorded.push(entry);
      },
    };

    await Effect.runPromise(reportUsage(recorder, usage));

    expect(recorded).toEqual([usage]);
  });

  it("swallows a rejected write rather than failing the run", async () => {
    const recorder: UsageRecorder = {
      record: async () => {
        throw new Error("the ledger is down");
      },
    };

    await expect(Effect.runPromise(reportUsage(recorder, usage))).resolves.toBeUndefined();
  });

  it("stays interruptible while the recorder is in flight", async () => {
    const never = await Effect.runPromise(Deferred.make<undefined>());
    const recorder: UsageRecorder = {
      record: () => Effect.runPromise(Deferred.await(never)),
    };

    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(reportUsage(recorder, usage));
        yield* Effect.yieldNow();
        yield* Fiber.interrupt(fiber);
        return yield* Fiber.await(fiber);
      }),
    );

    expect(Exit.isInterrupted(exit)).toBe(true);
  });
});
