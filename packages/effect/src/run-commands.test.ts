import { Effect, Exit, Fiber, Mailbox, Stream } from "effect";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import type { RunCommand, RunSession } from "./agent-runtime.ts";
import { consumeRunSession, pumpRunCommands } from "./run-commands.ts";
import type { PendingSteer, RunCommandSource } from "./run-commands.ts";

/**
 * The cross-process command path, without a database and without a runtime:
 * the pump is driven against a scripted source and an in-memory mailbox, and
 * the consumer is driven against an in-memory event stream. The emulator and
 * the real execution harness are where the same functions meet a session whose
 * script reacts to what the pump delivered (slice 6.7's acceptance suite).
 */

interface Harness {
  readonly session: RunSession;
  readonly events: Mailbox.Mailbox<RunEvent, unknown>;
  readonly commands: Mailbox.Mailbox<RunCommand>;
}

function makeSession(): Effect.Effect<Harness> {
  return Effect.gen(function* () {
    const events = yield* Mailbox.make<RunEvent, unknown>();
    const commands = yield* Mailbox.make<RunCommand>();

    return {
      session: { events: Mailbox.toStream(events).pipe(Stream.orDie), commands },
      events,
      commands,
    };
  });
}

function base(seq: number): {
  readonly schemaVersion: typeof RUN_EVENT_SCHEMA_VERSION;
  readonly seq: number;
  readonly threadId: string;
  readonly runId: string;
} {
  return {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    seq,
    threadId: "thread-1",
    runId: "run-1",
  };
}

function sourceOf(input: {
  readonly steers: () => readonly PendingSteer[];
  readonly stop?: () => boolean;
}): RunCommandSource {
  return {
    async claimSteers() {
      return input.steers();
    },
    async stopRequested() {
      return input.stop?.() ?? false;
    },
  };
}

/** Runs the pump beside the caller until the caller returns; the pump is ended by the caller. */
function withPump<A, E>(
  harness: Harness,
  source: RunCommandSource,
  use: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return Effect.gen(function* () {
    const pump = yield* pumpRunCommands(harness.session, {
      runId: "run-1",
      source,
      pollIntervalMs: 1,
    }).pipe(Effect.fork);

    const result = yield* use;
    yield* harness.commands.end;
    yield* Fiber.join(pump).pipe(Effect.ignore);

    return result;
  });
}

describe("the run command pump", () => {
  it("claims a steer once and forwards it with the durable message id", async () => {
    const command = await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeSession();
        let ticks = 0;

        const source = sourceOf({
          steers: () => {
            ticks += 1;

            return ticks === 1 ? [{ messageId: "message-1", text: "focus on the report" }] : [];
          },
        });

        return yield* withPump(harness, source, harness.commands.take);
      }),
    );

    expect(command).toEqual({ type: "steer", messageId: "message-1", text: "focus on the report" });
  });

  it("forwards the durable stop request as a stop command and then ends", async () => {
    const commands: RunCommand[] = [];

    await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeSession();
        const source = sourceOf({ steers: () => [], stop: () => true });

        yield* withPump(
          harness,
          source,
          Effect.gen(function* () {
            commands.push(yield* harness.commands.take);
            commands.push(yield* harness.commands.take);
          }).pipe(Effect.timeout("1 second"), Effect.ignore),
        );
      }),
    );

    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ type: "stop" });
  });

  it("survives a source read that fails and delivers the next tick's steer", async () => {
    const command = await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeSession();
        let ticks = 0;

        const source: RunCommandSource = {
          async claimSteers() {
            ticks += 1;

            if (ticks === 1) {
              throw new Error("the database is briefly unreachable");
            }

            return ticks === 2 ? [{ messageId: "message-2", text: "carry on" }] : [];
          },
          async stopRequested() {
            return false;
          },
        };

        return yield* withPump(harness, source, harness.commands.take);
      }),
    );

    expect(command).toMatchObject({ type: "steer", messageId: "message-2", text: "carry on" });
  });
});

describe("the run session consumer", () => {
  it("hands every event to the caller and reports a completed outcome", async () => {
    const observed: string[] = [];
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeSession();

        const consumed = yield* consumeRunSession(harness.session, (event) =>
          Effect.sync(() => {
            observed.push(event.type);
          }),
        ).pipe(Effect.fork);

        yield* harness.events.offer({ ...base(1), type: "run.started" });
        yield* harness.events.offer({
          ...base(2),
          type: "token.delta",
          messageId: "assistant-1",
          delta: "done",
        });
        yield* harness.events.offer({
          ...base(3),
          type: "run.completed",
          messageId: "assistant-1",
        });
        yield* harness.events.end;

        return yield* Fiber.join(consumed);
      }),
    );

    expect(observed).toEqual(["run.started", "token.delta", "run.completed"]);
    expect(outcome).toEqual({ status: "completed" });
  });

  it("reports a cancellation with the operator's reason", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeSession();

        const consumed = yield* consumeRunSession(harness.session, () => Effect.void).pipe(
          Effect.fork,
        );

        yield* harness.events.offer({ ...base(1), type: "run.started" });
        yield* harness.events.offer({
          ...base(2),
          type: "run.cancelled",
          reason: "the operator stopped this run",
        });
        yield* harness.events.end;

        return yield* Fiber.join(consumed);
      }),
    );

    expect(outcome).toEqual({ status: "cancelled", reason: "the operator stopped this run" });
  });

  it("refuses a stream that ends with two terminal events", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(
        Effect.gen(function* () {
          const harness = yield* makeSession();
          const consumed = yield* consumeRunSession(harness.session, () => Effect.void).pipe(
            Effect.fork,
          );

          yield* harness.events.offer({ ...base(1), type: "run.completed" });
          yield* harness.events.offer({ ...base(2), type: "run.cancelled" });
          yield* harness.events.end;

          return yield* Fiber.join(consumed);
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("reports a failed run with the terminal event's error", async () => {
    const outcome = await Effect.runPromise(
      Effect.gen(function* () {
        const harness = yield* makeSession();

        const consumed = yield* consumeRunSession(harness.session, () => Effect.void).pipe(
          Effect.fork,
        );

        yield* harness.events.offer({
          ...base(1),
          type: "run.failed",
          error: "the model endpoint is gone",
          code: "gone",
        });
        yield* harness.events.end;

        return yield* Fiber.join(consumed);
      }),
    );

    expect(outcome).toEqual({
      status: "failed",
      error: "the model endpoint is gone",
      code: "gone",
    });
  });
});
