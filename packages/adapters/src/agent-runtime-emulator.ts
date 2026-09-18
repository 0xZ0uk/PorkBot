import { Cause, Effect, Exit, Layer, Mailbox, Option, Ref, Stream } from "effect";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { AgentRuntime, requestScoped, UnknownToolError } from "@porkbot/effect";
import type {
  AgentRuntimeLayer,
  RunCommand,
  RunSession,
  RunStartRequest,
  ToolDispatcher,
} from "@porkbot/effect";

/**
 * The offline `AgentRuntime`: a deterministic, scripted session that speaks the
 * duplex seam over `Mailbox`es with no keys, no network and no clock.
 *
 * It exists to prove the seam is a seam. The orchestrator in `@porkbot/effect`
 * is written against `AgentRuntimeLayer` alone; swapping this emulator for the
 * Pi adapter (slice 5.3) changes the layer the worker provides and nothing in
 * the orchestrator. Scripts are data: the same script produces the same event
 * sequence, in order, every run, and each step either emits exactly one event
 * or waits for exactly one command.
 *
 * Tool steps are real when the caller passes a `ToolDispatcher` (slice 6.9):
 * the script names the call, the dispatcher executes it through the same
 * ledger, heartbeat and budget machinery Pi's tools use, and the outcome — the
 * real result or the real failure — is what the session emits. Without a
 * dispatcher a tool step still needs its scripted `result`, which is how the
 * seam tests stay independent of any tool implementation.
 *
 * The emulator lives in `@porkbot/adapters` beside the other offline
 * implementations, and its tests drive the shipped seam — it is never imported
 * by the orchestrator.
 */

/**
 * One step of a run script. Steps are executed in order; a script must end in a
 * terminal step (`run.completed` / `run.failed`) or in an await, so a run that
 * should stay open stays open rather than completing by accident.
 *
 * A tool step's `result` is the scripted outcome used when no dispatcher is
 * supplied; with a dispatcher the machine's real result replaces it and the
 * field may be omitted.
 */
export type EmulatorStep =
  | { readonly kind: "token.delta"; readonly messageId: string; readonly delta: string }
  | {
      readonly kind: "tool.immediate";
      readonly callId: string;
      readonly tool: string;
      readonly arguments: unknown;
      readonly result?: unknown;
    }
  | {
      readonly kind: "tool.awaiting_approval";
      readonly callId: string;
      readonly tool: string;
      readonly arguments: unknown;
      readonly result?: unknown;
    }
  /** Suspends until a steer arrives, then answers with `run.steered` and continues. */
  | { readonly kind: "await.steer" }
  | { readonly kind: "run.completed"; readonly messageId?: string }
  | { readonly kind: "run.failed"; readonly error: string; readonly code?: string };

/**
 * How the offline runtime executes tool steps. With a dispatcher the script is
 * only the model's half of the run — which call to make — and the tool's
 * outcome is the machine's, exactly as it is under Pi.
 */
export interface EmulatorRuntimeOptions {
  readonly tools?: ToolDispatcher | undefined;
}

/**
 * A script ran off its end, or kept a malformed step it could not execute. The
 * run fails loudly instead of reporting a completion nothing wrote.
 */
export class EmulatorScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmulatorScriptError";
  }
}

type CommandOutcome =
  | { readonly kind: "steered" }
  | { readonly kind: "approved" }
  | { readonly kind: "denied"; readonly reason: string | undefined }
  | { readonly kind: "stopped"; readonly reason: string };

/**
 * Builds the run-scoped layer for one scripted run: a session whose `events`
 * half replays the script and whose `commands` half is the mailbox the script
 * waits in. Closing the scope interrupts the run loop, which expects the
 * interruption: it reports a terminal `run.cancelled` and commits nothing that
 * was in flight (PRD decision 26).
 */
export function emulatorAgentRuntimeLayer(
  request: RunStartRequest,
  script: readonly EmulatorStep[],
  options: EmulatorRuntimeOptions = {},
): AgentRuntimeLayer {
  const acquire = Effect.gen(function* () {
    const events = yield* Mailbox.make<RunEvent, unknown>();
    const commands = yield* Mailbox.make<RunCommand>();
    const nextSeq = yield* Ref.make(request.startSeq);
    const finished = yield* Ref.make(false);
    const steers = yield* Ref.make(0);

    const base = (seq: number) =>
      ({
        schemaVersion: RUN_EVENT_SCHEMA_VERSION,
        seq,
        threadId: request.threadId,
        runId: request.runId,
      }) as const;

    const emit = (build: (seq: number) => RunEvent) =>
      Ref.modify(nextSeq, (seq) => [seq, seq + 1] as const).pipe(
        Effect.flatMap((seq) => events.offer(build(seq))),
      );

    const finish = (build: (seq: number) => RunEvent) =>
      Effect.gen(function* () {
        const already = yield* Ref.getAndSet(finished, true);

        if (already) {
          return;
        }

        yield* emit(build);
        yield* events.end;
        yield* commands.end;
      });

    const cancelled =
      (reason: string) =>
      (seq: number): RunEvent => ({
        ...base(seq),
        type: "run.cancelled",
        reason,
      });

    const awaitSteer = (): Effect.Effect<CommandOutcome, Cause.NoSuchElementException> =>
      Effect.gen(function* () {
        for (;;) {
          const command = yield* commands.take;

          if (command.type === "stop") {
            return { kind: "stopped", reason: command.reason ?? "stop" };
          }

          if (command.type === "steer") {
            const nth = yield* Ref.updateAndGet(steers, (count) => count + 1);

            yield* emit((seq) => ({
              ...base(seq),
              type: "run.steered",
              messageId: `steer-${nth}`,
              text: command.text,
            }));

            return { kind: "steered" };
          }
        }
      });

    const awaitDecision = (
      callId: string,
    ): Effect.Effect<CommandOutcome, Cause.NoSuchElementException> =>
      Effect.gen(function* () {
        for (;;) {
          const command = yield* commands.take;

          if (command.type === "stop") {
            return { kind: "stopped", reason: command.reason ?? "stop" };
          }

          if (command.type === "approve" && command.callId === callId) {
            return { kind: "approved" };
          }

          if (command.type === "deny" && command.callId === callId) {
            return { kind: "denied", reason: command.reason };
          }
        }
      });

    const emitDispatchFailure = (
      callId: string,
      cause: Cause.Cause<unknown>,
    ): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        const failure = Cause.failureOption(cause);
        const unknownTool =
          Option.isSome(failure) && failure.value instanceof UnknownToolError
            ? failure.value
            : undefined;

        if (unknownTool !== undefined) {
          yield* emit((seq) => ({
            ...base(seq),
            type: "tool.failed",
            callId,
            error: unknownTool.message,
          }));
          return;
        }

        return yield* Effect.failCause(cause);
      });

    /**
     * The outcome half of a tool step: the scripted result when the runtime
     * holds no dispatcher, otherwise the dispatcher's real outcome. A
     * dispatcher failure the model can recover from (an unknown tool) is
     * emitted as `tool.failed`; any other failure is the run's, because a call
     * that cannot be dispatched or durably recorded is not a tool result.
     */
    const executeToolStep = (step: {
      readonly callId: string;
      readonly tool: string;
      readonly arguments: unknown;
      readonly result?: unknown;
    }): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        if (options.tools === undefined) {
          if (step.result === undefined) {
            return yield* Effect.die(
              new EmulatorScriptError(
                `the tool step "${step.callId}" has no scripted result and the runtime holds no dispatcher`,
              ),
            );
          }

          yield* emit((seq) => ({
            ...base(seq),
            type: "tool.completed",
            callId: step.callId,
            result: step.result,
          }));
          return;
        }

        const executed = yield* Effect.exit(
          options.tools.execute({
            runId: request.runId,
            callId: step.callId,
            tool: step.tool,
            arguments: step.arguments,
          }),
        );

        if (Exit.isFailure(executed)) {
          return yield* emitDispatchFailure(step.callId, executed.cause);
        }

        const outcome = executed.value;

        if (outcome.status === "completed") {
          yield* emit((seq) => ({
            ...base(seq),
            type: "tool.completed",
            callId: step.callId,
            result: outcome.result,
          }));
        } else {
          yield* emit((seq) => ({
            ...base(seq),
            type: "tool.failed",
            callId: step.callId,
            error: outcome.error,
          }));
        }
      });

    const runScript = Effect.gen(function* () {
      for (const step of script) {
        switch (step.kind) {
          case "token.delta": {
            yield* emit((seq) => ({
              ...base(seq),
              type: "token.delta",
              messageId: step.messageId,
              delta: step.delta,
            }));
            break;
          }

          case "tool.immediate": {
            yield* emit((seq) => ({
              ...base(seq),
              type: "tool.requested",
              callId: step.callId,
              tool: step.tool,
              arguments: step.arguments,
            }));
            yield* executeToolStep(step);
            break;
          }

          case "tool.awaiting_approval": {
            yield* emit((seq) => ({
              ...base(seq),
              type: "tool.requested",
              callId: step.callId,
              tool: step.tool,
              arguments: step.arguments,
            }));

            const outcome = yield* awaitDecision(step.callId);

            if (outcome.kind === "stopped") {
              yield* finish(cancelled(outcome.reason));
              return;
            }

            if (outcome.kind === "approved") {
              yield* executeToolStep(step);
            } else if (outcome.kind === "denied") {
              yield* emit((seq) => ({
                ...base(seq),
                type: "tool.failed",
                callId: step.callId,
                error: outcome.reason ?? "the operator denied this tool call",
              }));
            }

            break;
          }

          case "await.steer": {
            const outcome = yield* awaitSteer();

            if (outcome.kind === "stopped") {
              yield* finish(cancelled(outcome.reason));
              return;
            }

            break;
          }

          case "run.completed": {
            yield* finish((seq) => ({
              ...base(seq),
              type: "run.completed",
              ...(step.messageId === undefined ? {} : { messageId: step.messageId }),
            }));
            return;
          }

          case "run.failed": {
            yield* finish((seq) => ({
              ...base(seq),
              type: "run.failed",
              error: step.error,
              ...(step.code === undefined ? {} : { code: step.code }),
            }));
            return;
          }
        }
      }

      return yield* Effect.die(
        new EmulatorScriptError("the script ended without a terminal step or an await"),
      );
    });

    const runLoop = runScript.pipe(
      Effect.onInterrupt(() => finish(cancelled("interrupted"))),
      Effect.catchAllCause((cause) => {
        if (Cause.isInterrupted(cause)) {
          return Effect.interrupt;
        }

        return Effect.gen(function* () {
          const already = yield* Ref.getAndSet(finished, true);

          if (already) {
            return;
          }

          yield* events.failCause(cause);
          yield* commands.end;
        });
      }),
    );

    yield* emit((seq) => ({ ...base(seq), type: "run.started" }));
    yield* Effect.forkScoped(runLoop);

    return {
      session: {
        events: Mailbox.toStream(events).pipe(Stream.orDie),
        commands,
      } satisfies RunSession,
    };
  });

  return requestScoped(Layer.scoped(AgentRuntime, acquire));
}
