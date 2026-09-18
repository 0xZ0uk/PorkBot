import { Deferred, Effect, Layer, Ref } from "effect";
import type { Mailbox, Scope, Stream } from "effect";
import type {
  ModelConnection,
  ModelMessage,
  ModelToolDefinition,
  ProviderFailure,
} from "@porkbot/adapter-kit";
import type { RunEvent } from "@porkbot/core";
import { RunGoneError } from "./errors.ts";
import type { LeaseLostError } from "./errors.ts";
import { processSingleton, processTag, requestTag } from "./lifetimes.ts";
import type { ProcessLayer, ProcessTag, RequestLayer, RequestTag } from "./lifetimes.ts";

/**
 * The duplex run seam (PRD decision 13; audit P0 item 1).
 *
 * A run is not a read-only stream: steering and approval are writes into a live
 * run, and a consumer that can only read cannot make them. `AgentRuntime`
 * therefore exposes a `RunSession` with two halves — an `events` stream
 * carrying the run's `RunEvent` vocabulary and a `commands` mailbox carrying
 * `Steer | Stop | Approve | Deny` — so operator input travels the other
 * direction from the events it answers.
 *
 * Why this lives above `@porkbot/adapter-kit`: both halves are Effect values
 * and the event vocabulary is `@porkbot/core`'s `RunEvent`. The seam package
 * declares provider-shaped records and imports nothing outside its own modules
 * (its contract test asserts both), while this package owns Effect services and
 * their tags (PRD decision 27). The vendor implementation stays in
 * `@porkbot/adapters` and names its vendor nowhere else.
 *
 * Lifetimes (PRD decision 27): a session belongs to exactly one run, so the
 * layer that provides it is run-scoped — `requestTag` + `requestScoped`, built
 * inside the run's scope beside the run's repositories, never baked into a
 * boot-time singleton. The layer holds no database handle: it turns commands
 * into run work and run work into events, and everything durable is the
 * caller's business.
 *
 * Interruption is the cancellation channel: closing the run's scope (because
 * the worker lost the fence, because the operator stopped the run, or because
 * the process is shutting down) interrupts the whole run fiber tree, so an
 * implementation cancels in-flight work and reports the cancellation as a
 * terminal `run.cancelled` event rather than letting a tool call finish and
 * commit its side effect.
 */

/** The four writes an operator can make into a live run (PRD decision 13). */
export type RunCommand =
  | { readonly type: "steer"; readonly text: string }
  | { readonly type: "stop"; readonly reason?: string }
  | { readonly type: "approve"; readonly callId: string }
  | { readonly type: "deny"; readonly callId: string; readonly reason?: string };

/**
 * Everything an implementation needs to start one run's session. The request
 * carries the run's identity and its already-composed context; it never carries
 * a tenant id, because the caller resolved the actor before building it.
 */
export interface RunStartRequest {
  readonly runId: string;
  readonly threadId: string;
  /**
   * The next per-thread event sequence. A session allocates contiguously from
   * it, so the events it emits slot into the thread's stream without a second
   * allocator.
   */
  readonly startSeq: number;
  /** Where the model lives and which stored credential opens it — a name, never a value. */
  readonly connection: ModelConnection;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ModelToolDefinition[];
}

/**
 * The duplex half of a run: events out, commands in. One consumer reads the
 * stream, and the same `Mailbox` the runtime takes from is the one callers
 * offer into.
 */
export interface RunSession {
  /**
   * The run's events in order, from `run.started` to exactly one terminal
   * event. The stream is not replayable and carries no cursor: durability and
   * resumption are the event sink's job, not the session's.
   */
  readonly events: Stream.Stream<RunEvent>;
  /**
   * Writes into the live run. A command is a request, not a transaction: its
   * acknowledgement is the event it causes (`steer` answers as `run.steered`).
   */
  readonly commands: Mailbox.Mailbox<RunCommand>;
}

/** What a run-scoped runtime layer provides: the live session for its run. */
export interface AgentRuntimeShape {
  readonly session: RunSession;
}

/**
 * The run-scoped runtime service. Provide a layer per run inside that run's
 * scope; the layer's finalizer is the cancellation path described above.
 */
export const AgentRuntime: RequestTag<AgentRuntimeShape> = requestTag<AgentRuntimeShape>(
  "@porkbot/effect/AgentRuntime",
);

/**
 * How a runtime that refuses to start reports why. Implementations classify
 * their own failures onto the shared vocabulary, and lifecycle code branches on
 * the kind (PRD decision 19) instead of reading a vendor message.
 */
export type AgentRuntimeFailure = ProviderFailure;

export type AgentRuntimeTag = RequestTag<AgentRuntimeShape>;

/** A layer that starts one run's session and must be built inside that run's scope. */
export type AgentRuntimeLayer<E = never, R = never> = RequestLayer<AgentRuntimeTag, E, R>;

/** The process's registry of live run sessions: the write half of the seam. */
export interface LiveRunsShape {
  /**
   * Publishes one session for the lifetime of the calling scope. Detaching is
   * the scope's job, so a run that ends and a run that was cancelled both
   * leave a command sent afterwards resolving to a typed error.
   */
  readonly attach: (runId: string, session: RunSession) => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Routes one operator command to the run's live session. A run this process
   * does not hold — never started here, or already finished — is the typed
   * `RunGoneError`, never a hang and never a silent drop.
   */
  readonly dispatch: (runId: string, command: RunCommand) => Effect.Effect<void, RunGoneError>;
  /** Whether this process currently holds a live session for the run. */
  readonly isLive: (runId: string) => Effect.Effect<boolean>;
}

export type LiveRunsTag = ProcessTag<LiveRunsShape>;

/**
 * The registry is process-scoped because it is exactly "which runs this process
 * is executing", and that set is per process by definition. It holds sessions,
 * never a database handle.
 */
export const LiveRuns: LiveRunsTag = processTag<LiveRunsShape>("@porkbot/effect/LiveRuns");

export const liveRunsLayer: ProcessLayer<LiveRunsTag> = processSingleton(
  Layer.effect(
    LiveRuns,
    Effect.gen(function* () {
      const runs = yield* Ref.make(new Map<string, RunSession>());

      return {
        attach: (runId, session) =>
          Effect.acquireRelease(
            Ref.modify(runs, (current) => {
              if (current.has(runId)) {
                return [false, current] as const;
              }

              const next = new Map(current);
              next.set(runId, session);
              return [true, next] as const;
            }).pipe(
              Effect.flatMap((attached) =>
                attached
                  ? Effect.void
                  : Effect.die(
                      new Error(
                        `a live session for run ${runId} is already attached in this process`,
                      ),
                    ),
              ),
            ),
            () =>
              Ref.update(runs, (current) => {
                if (current.get(runId) !== session) {
                  return current;
                }

                const next = new Map(current);
                next.delete(runId);
                return next;
              }),
          ),
        dispatch: (runId, command) =>
          Effect.gen(function* () {
            const current = yield* Ref.get(runs);
            const session = current.get(runId);

            if (session === undefined) {
              return yield* Effect.fail(new RunGoneError(runId));
            }

            const accepted = yield* session.commands.offer(command);

            if (!accepted) {
              return yield* Effect.fail(new RunGoneError(runId));
            }
          }),
        isLive: (runId) => Ref.get(runs).pipe(Effect.map((current) => current.has(runId))),
      } satisfies LiveRunsShape;
    }),
  ),
);

/**
 * Runs one session for the caller's scope: builds the run-scoped `AgentRuntime`
 * layer, publishes the session to `LiveRuns` for exactly that scope, and hands
 * it to `use`. Building the layer here — not at boot — is what keeps a session
 * from outliving its run and from carrying another run's actor.
 */
export function withLiveRun<A, E, R, E2, R2>(
  runId: string,
  runtime: Layer.Layer<AgentRuntimeTag, E2, R2>,
  use: (session: RunSession) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | E2, R | R2 | LiveRunsTag> {
  return Effect.scoped(
    Effect.gen(function* () {
      const agentRuntime = yield* AgentRuntime;
      const liveRuns = yield* LiveRuns;
      yield* liveRuns.attach(runId, agentRuntime.session);
      return yield* use(agentRuntime.session);
    }).pipe(Effect.provide(runtime)),
  );
}

/**
 * Turns losing the fence into interruption of the whole run fiber tree (PRD
 * decisions 1 and 26). The worker's heartbeat completes `fenceLost` when the
 * row's `leaseFence` moved on; the race interrupts `run` — every child fiber,
 * the runtime loop and the tools it was running — and raises the typed
 * `LeaseLostError`, so the adapter cancels and reports instead of completing
 * and committing work the next owner has already been promised.
 */
export function fenced<A, E, R>(
  fenceLost: Deferred.Deferred<LeaseLostError>,
  run: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | LeaseLostError, R> {
  return Effect.raceFirst(
    run,
    Deferred.await(fenceLost).pipe(Effect.flatMap((error) => Effect.fail(error))),
  );
}
