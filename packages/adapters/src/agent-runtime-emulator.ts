import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Mailbox,
  Option,
  Queue,
  Ref,
  Stream,
} from "effect";
import { RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { AgentRuntime, reportUsage, requestScoped, UnknownToolError } from "@porkbot/effect";
import type {
  AgentRuntimeLayer,
  RunCommand,
  RunSession,
  RunStartRequest,
  ToolDispatcher,
  UsageRecorder,
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
 * or waits.
 *
 * Commands are consumed by a command loop beside the script (slice 6.7), the
 * same shape the Pi adapter uses: a steer is emitted as `run.steered` with the
 * durable message id and handed to a waiting `await.steer` step, an approve or
 * deny resolves the gate it names even if it arrives before that gate is
 * reached, and a stop finishes the run with `run.cancelled` and interrupts the
 * script — so a token loop or a tool call in flight ends there instead of
 * running to completion.
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
  /**
   * One completed model turn's usage (slice 8.8, story 34). Omitted or null
   * fields are "not reported" — the script can say a provider stayed silent,
   * which a test asserts is never rendered as a zero. Reported through the
   * runtime's `usage` recorder when one was supplied; a script without a
   * recorder simply has no ledger to write to.
   */
  | {
      readonly kind: "usage";
      readonly provider?: string | null;
      readonly model?: string | null;
      readonly inputTokens?: number | null;
      readonly outputTokens?: number | null;
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
  /**
   * Where completed turns' usage goes (slice 8.8, story 34). The run executor
   * passes its per-run recorder here; absent, a `usage` step records nothing,
   * which keeps the scripted seam tests database-free.
   */
  readonly usage?: UsageRecorder | undefined;
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

type DecisionOutcome =
  { readonly kind: "approved" } | { readonly kind: "denied"; readonly reason: string | undefined };

/**
 * One call's gate: either the run is waiting for a decision or the decision
 * arrived first. Both cases live in the same keyed slot so the handoff is one
 * atomic exchange — a decision that lands between a step's check and its wait
 * would otherwise be dropped, which is exactly the flaky seam a scripted
 * runtime must not have.
 */
type DecisionSlot =
  | { readonly kind: "waiting"; readonly deferred: Deferred.Deferred<DecisionOutcome> }
  | { readonly kind: "early"; readonly outcome: DecisionOutcome };

/** One steer as the command loop hands it to a waiting script step. */
interface SteerDelivery {
  readonly messageId: string;
  readonly text: string;
}

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
    const steers = yield* Queue.unbounded<SteerDelivery>();
    const decisions = yield* Ref.make(new Map<string, DecisionSlot>());

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

    /**
     * Waits for the next steer. The command loop owns the mailbox and has
     * already emitted `run.steered` by the time a step wakes here, so a steer
     * that arrives between steps is queued rather than lost.
     */
    const awaitSteer = (): Effect.Effect<SteerDelivery> => Queue.take(steers);

    /**
     * Waits for this call's decision. A decision that already arrived is taken
     * from the slot; otherwise the wait is registered, and the registration
     * and the check are one atomic exchange with the command loop's delivery,
     * so an approve or deny can never land in between and be dropped.
     */
    const awaitDecision = (callId: string): Effect.Effect<DecisionOutcome> =>
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<DecisionOutcome>();

        const early = yield* Ref.modify(decisions, (current) => {
          const slot = current.get(callId);

          if (slot?.kind === "early") {
            const next = new Map(current);
            next.delete(callId);

            return [slot.outcome, next] as const;
          }

          const next = new Map(current);
          next.set(callId, { kind: "waiting", deferred });

          return [undefined, next] as const;
        });

        if (early !== undefined) {
          return early;
        }

        return yield* Deferred.await(deferred).pipe(
          Effect.ensuring(
            Ref.update(decisions, (current) => {
              const slot = current.get(callId);

              if (slot?.kind !== "waiting" || slot.deferred !== deferred) {
                return current;
              }

              const next = new Map(current);
              next.delete(callId);

              return next;
            }),
          ),
        );
      });

    /**
     * Hands one approve or deny to the call it names: a waiting step is woken,
     * a decision that arrived before the step is remembered for it, and a
     * second decision for an already-resolved call is ignored — the first
     * answer is the answer, exactly as a real gate resolves once.
     */
    const deliverDecision = (callId: string, outcome: DecisionOutcome): Effect.Effect<void> =>
      Effect.gen(function* () {
        const waiting = yield* Ref.modify(decisions, (current) => {
          const slot = current.get(callId);

          if (slot?.kind === "waiting") {
            const next = new Map(current);
            next.delete(callId);

            return [slot.deferred, next] as const;
          }

          if (slot?.kind === "early") {
            return [undefined, current] as const;
          }

          const next = new Map(current);
          next.set(callId, { kind: "early", outcome });

          return [undefined, next] as const;
        });

        if (waiting !== undefined) {
          yield* Deferred.succeed(waiting, outcome);
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

            if (outcome.kind === "approved") {
              yield* executeToolStep(step);
            } else {
              yield* emit((seq) => ({
                ...base(seq),
                type: "tool.failed",
                callId: step.callId,
                error: outcome.reason ?? "the operator denied this tool call",
              }));
            }

            break;
          }

          case "usage": {
            yield* reportUsage(options.usage, {
              runId: request.runId,
              provider: step.provider ?? null,
              model: step.model ?? null,
              inputTokens: step.inputTokens ?? null,
              outputTokens: step.outputTokens ?? null,
            });
            break;
          }

          case "await.steer": {
            yield* awaitSteer();
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

    /**
     * The command half owns the mailbox, exactly as the Pi adapter's does: a
     * steer is acknowledged with `run.steered` and handed to whichever step is
     * waiting, an approve or deny resolves the matching gate, and a stop
     * finishes the run with `run.cancelled` and then interrupts the script.
     *
     * The stop interrupt is what makes stopping prompt: a token loop or a tool
     * call in flight is a fiber inside `runLoop`, so the operator's stop ends
     * it there instead of waiting for the script to reach its next await
     * (stories 21 and 26).
     */
    const commandLoop = Mailbox.toStream(commands).pipe(
      Stream.runForEach((command) =>
        Effect.gen(function* () {
          switch (command.type) {
            case "stop": {
              yield* finish(cancelled(command.reason ?? "stop"));
              yield* Fiber.interrupt(runLoopFiber);
              return;
            }

            case "steer": {
              yield* emit((seq) => ({
                ...base(seq),
                type: "run.steered",
                messageId: command.messageId,
                text: command.text,
              }));
              yield* Queue.offer(steers, { messageId: command.messageId, text: command.text });
              return;
            }

            case "approve":
            case "deny": {
              const decision: DecisionOutcome =
                command.type === "approve"
                  ? { kind: "approved" }
                  : { kind: "denied", reason: command.reason };

              yield* deliverDecision(command.callId, decision);
              return;
            }
          }
        }),
      ),
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
        });
      }),
    );

    yield* emit((seq) => ({ ...base(seq), type: "run.started" }));
    const runLoopFiber = yield* Effect.forkScoped(runLoop);
    yield* Effect.forkScoped(commandLoop);

    return {
      session: {
        events: Mailbox.toStream(events).pipe(Stream.orDie),
        commands,
      } satisfies RunSession,
    };
  });

  return requestScoped(Layer.scoped(AgentRuntime, acquire));
}
