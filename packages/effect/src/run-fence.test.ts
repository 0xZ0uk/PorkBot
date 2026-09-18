import { Cause, Effect, Option, Ref } from "effect";
import { describe, expect, it } from "vitest";
import { LeaseLostError } from "./errors.ts";
import { withRunFence } from "./run-fence.ts";

/**
 * The run's fenced lifetime, driven by a heartbeat the test owns. Each case
 * counts beats and decides when the lease is lost, so "interrupts the work" and
 * "stops beating when the work ends" are observable rather than inferred.
 */

function counter(): Effect.Effect<Ref.Ref<number>> {
  return Ref.make(0);
}

function beat(ref: Ref.Ref<number>, failAt?: number): Effect.Effect<void, LeaseLostError> {
  return Ref.updateAndGet(ref, (count) => count + 1).pipe(
    Effect.flatMap((count) =>
      failAt !== undefined && count >= failAt
        ? Effect.fail(new LeaseLostError("run-1"))
        : Effect.void,
    ),
  );
}

describe("withRunFence", () => {
  it("beats while the work runs and returns the work's value", async () => {
    const beats = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* counter();
        const result = yield* withRunFence(
          { runId: "run-1", heartbeat: beat(ref), interval: "5 millis" },
          Effect.sleep("30 millis").pipe(Effect.as("done")),
        );

        return { result, count: yield* Ref.get(ref) };
      }),
    );

    expect(beats.result).toBe("done");
    expect(beats.count).toBeGreaterThan(1);
  });

  it("interrupts the run the moment a beat reports a lost lease", async () => {
    const cancelled = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* counter();

        return yield* withRunFence(
          { runId: "run-1", heartbeat: beat(ref, 2), interval: "5 millis" },
          Effect.never,
        ).pipe(Effect.exit);
      }),
    );

    expect(cancelled._tag).toBe("Failure");
    if (cancelled._tag === "Failure") {
      const failure = Cause.failureOption(cancelled.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (Option.isSome(failure)) {
        expect(failure.value).toBeInstanceOf(LeaseLostError);
      }
    }
  });

  it("treats a heartbeat failure that is not a lease loss as a lost lease, fail-closed", async () => {
    const count = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* counter();
        const exit = yield* withRunFence(
          {
            runId: "run-1",
            heartbeat: Ref.updateAndGet(ref, (value) => value + 1).pipe(
              Effect.zipRight(Effect.die(new Error("the database is unreachable"))),
            ),
            interval: "5 millis",
          },
          Effect.never,
        ).pipe(Effect.exit);

        expect(exit._tag).toBe("Failure");
        return yield* Ref.get(ref);
      }),
    );

    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("stops beating once the work is done", async () => {
    const counts = await Effect.runPromise(
      Effect.gen(function* () {
        const ref = yield* counter();
        yield* withRunFence(
          { runId: "run-1", heartbeat: beat(ref), interval: "5 millis" },
          Effect.sleep("15 millis"),
        );

        const settled = yield* Ref.get(ref);
        yield* Effect.sleep("30 millis");

        return { settled, later: yield* Ref.get(ref) };
      }),
    );

    expect(counts.settled).toBeGreaterThan(0);
    expect(counts.later).toBe(counts.settled);
  });
});
