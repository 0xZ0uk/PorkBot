import { createHash } from "node:crypto";
import { Cause, Effect, Option } from "effect";
import type {
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ProviderFailure,
} from "@porkbot/adapter-kit";
import { LeaseLostError, ToolCallConflictError, ToolLedgerError } from "./errors.ts";
import type { ToolCall, ToolCallLedger } from "./tool-dispatcher.ts";

/**
 * The fenced computer command runner (slice 7.4, PRD decision 26).
 *
 * `ComputerProvider.exec` is deliberately unfenced: a provider serves a
 * machine, not a run. This module owns the layer above the seam where "whose
 * command is this, and may it still commit" is decided, and every computer tool
 * runs through it:
 *
 *   - **Fenced like a run write.** The command's holder is the run's own
 *     `(runId, owner, fence)` and the computer lease is written only while the
 *     run row still carries that fence with a live `lease_expires_at`. After
 *     the provider answers, the lease is held again before the command is
 *     recorded: a reclaim that moved the fence in the meantime makes that
 *     renewal match nothing and the command fails with the typed
 *     `LeaseLostError` (the transport's `CONFLICT`) instead of committing. A
 *     raw provider timeout is never the signal that the lease was lost.
 *   - **Idempotent by key.** Every command carries the tool call's durable
 *     `callId` as its idempotency key, namespaced under a hash so it cannot
 *     collide with the tool-call claim the dispatcher already made. A retry of
 *     the same key replays the recorded result instead of running the command
 *     again, and a claim that a reclaim settled as failed stays a failure
 *     rather than being repeated.
 *   - **One TTL, asserted once.** The computer lease may not outlive the run
 *     lease. This constructor is the one place that compares them and refuses
 *     to build a guard that violates it, so a reclaimed run's command cannot
 *     outlive the run lease the product already accounts for.
 *
 * A machine held live by another run is not waited for: the guard answers a
 * classified `ComputerLeaseHeldError` (`rate_limited`) at once, so backoff is
 * a decision rather than a provider timeout.
 */

/** The run a computer lease write is fenced on. */
export interface ComputerLeaseHolder {
  readonly botId: string;
  readonly runId: string;
  readonly owner: string;
  readonly fence: number;
}

/** A held computer lease. */
export interface ComputerLease {
  readonly botId: string;
  readonly runId: string;
  readonly owner: string;
  readonly fence: number;
  readonly expiresAt: Date;
}

/**
 * The result of one hold. `busy` means a live foreign holder has the machine;
 * `run_lost` means the run lease this holder named is no longer live, so the
 * caller has lost the run and must not command anything.
 */
export type ComputerLeaseAcquisition =
  | { readonly status: "held"; readonly lease: ComputerLease }
  | { readonly status: "busy"; readonly expiresAt: Date }
  | { readonly status: "run_lost" };

/**
 * The durable half of the fence: acquire-or-renew and release, implemented by
 * `@porkbot/db` over the computer-lease rows. Both writes are fenced on the
 * run's live lease, so this seam cannot be used to hold or clear a lease the
 * caller does not own.
 */
export interface ComputerLeaseStore {
  hold(holder: ComputerLeaseHolder, ttlSeconds: number): Promise<ComputerLeaseAcquisition>;
  release(holder: ComputerLeaseHolder): Promise<boolean>;
}

/** One command, addressed to one run's computer with one durable key. */
export interface ComputerCommandRequest {
  readonly computer: ComputerRef;
  readonly runId: string;
  /** The tool call's durable id; the command's idempotency key derives from it. */
  readonly callId: string;
  /** The tool that asked, recorded in the command's ledger row. */
  readonly tool: string;
  readonly command: string;
  readonly timeoutMs: number;
}

/**
 * The command door the computer tools use. It is the `ComputerProvider.exec`
 * seam plus the run's fence, so the tools never hold a raw provider.
 */
export interface ComputerCommandRunner {
  readonly exec: (request: ComputerCommandRequest) => Effect.Effect<ComputerExecResult, unknown>;
}

/**
 * The machine is held by another live run. It is a classified provider failure
 * (`rate_limited`), so retry and backoff code branches on the kind and the
 * model reads an operator-safe sentence rather than a vendor timeout.
 */
export class ComputerLeaseHeldError extends Error implements ProviderFailure {
  readonly kind = "rate_limited" as const;
  readonly detail: string;

  constructor(retryAfterSeconds: number) {
    const detail = `another run holds this computer for up to ${String(retryAfterSeconds)}s`;

    super(detail);
    this.name = "ComputerLeaseHeldError";
    this.detail = detail;
  }
}

/**
 * A computer lease that would outlive its run. It is a wiring defect, refused
 * while the worker builds its run, not a runtime state.
 */
export class ComputerLeaseTtlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerLeaseTtlError";
  }
}

/** A command whose recorded outcome was a failure, replayed on a retry. */
export class ComputerCommandFailedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerCommandFailedError";
  }
}

export interface FencedComputerCommandsOptions {
  readonly provider: ComputerProvider;
  readonly ledger: ToolCallLedger;
  readonly leases: ComputerLeaseStore;
  /** The run and machine the runner is bound to; never a tool argument. */
  readonly lease: ComputerLeaseHolder;
  /** The run's lease TTL, in whole seconds. */
  readonly runLeaseTtlSeconds: number;
  /** The computer lease's TTL, in whole seconds; must not exceed the run's. */
  readonly computerLeaseTtlSeconds: number;
  /**
   * The per-command environment (slice 7.8): what the run's capability is
   * carried in, built fresh for each command from that command's own budget.
   * It is never a credential — the run's credentials live in the computer's
   * proxy, and this environment names the proxy and its short-lived token. A
   * run without a proxy leaves it out, and the provider passes no environment.
   */
  readonly environment?: ((timeoutMs: number) => Readonly<Record<string, string>>) | undefined;
  /** The clock backing the `busy` detail; injected for tests, `Date.now` by default. */
  readonly now?: (() => number) | undefined;
}

export function createFencedComputerCommands(
  options: FencedComputerCommandsOptions,
): ComputerCommandRunner {
  assertLeaseTtls(options);

  const now = options.now ?? (() => Date.now());

  /** The command's idempotency key: the call id, namespaced under a hash. */
  const commandKey = (callId: string): string =>
    `computer-command:${createHash("sha256").update(`computer-command\u0000${callId}`).digest("hex")}`;

  const ledgerCall = <A>(
    operation: "begin" | "complete" | "fail",
    run: () => Promise<A>,
  ): Effect.Effect<A, ToolLedgerError> =>
    Effect.tryPromise({
      try: run,
      catch: () => new ToolLedgerError(operation),
    });

  /** Holds the computer for this run, or fails with the loss the fence proves. */
  const hold = (
    phase: "before" | "after",
  ): Effect.Effect<void, LeaseLostError | ComputerLeaseHeldError> =>
    Effect.tryPromise({
      try: () => options.leases.hold(options.lease, options.computerLeaseTtlSeconds),
      catch: () => new LeaseLostError(options.lease.runId),
    }).pipe(
      Effect.flatMap(
        (acquisition): Effect.Effect<void, LeaseLostError | ComputerLeaseHeldError> => {
          if (acquisition.status === "run_lost") {
            return Effect.fail(new LeaseLostError(options.lease.runId));
          }

          if (acquisition.status === "busy") {
            if (phase === "after") {
              // Our own binding was replaced before the command could commit:
              // the run lost the machine, and waiting would only record a
              // stale result.
              return Effect.fail(new LeaseLostError(options.lease.runId));
            }

            const retryAfterSeconds = Math.max(
              1,
              Math.ceil((acquisition.expiresAt.getTime() - now()) / 1000),
            );

            return Effect.fail(new ComputerLeaseHeldError(retryAfterSeconds));
          }

          return Effect.void;
        },
      ),
    );

  return {
    exec: (request) =>
      Effect.gen(function* () {
        const call: ToolCall = {
          runId: request.runId,
          callId: commandKey(request.callId),
          tool: "computer.command",
          arguments: { tool: request.tool, command: request.command },
        };

        const admission = yield* ledgerCall("begin", () => options.ledger.begin(call));

        switch (admission.status) {
          case "completed":
            // The command happened under a fence that was live when it was
            // recorded; the durable outcome is the answer.
            return admission.result as ComputerExecResult;
          case "failed":
            return yield* Effect.fail(new ComputerCommandFailedError(admission.error));
          case "in_flight":
            return yield* Effect.fail(
              new ToolCallConflictError(request.runId, request.callId, "in_flight"),
            );
          case "call_id_reused":
            return yield* Effect.fail(
              new ToolCallConflictError(request.runId, request.callId, "call_id_reused"),
            );
          case "started":
            break;
        }

        // A held machine is a legitimate refusal the model reads and backs off
        // from; the claim is settled so the same key is not left in flight. A
        // lost run settles the claim too — a reclaim would settle it anyway —
        // and both failures travel unchanged.
        yield* hold("before").pipe(
          Effect.catchAll((error) =>
            settleFailure(options.ledger, call, failureMessage(error)).pipe(
              Effect.zipRight(Effect.fail(error)),
            ),
          ),
        );

        const environment = options.environment?.(request.timeoutMs);

        const result = yield* Effect.tryPromise({
          try: () =>
            options.provider.exec({
              computer: request.computer,
              command: request.command,
              timeoutMs: request.timeoutMs,
              ...(environment === undefined ? {} : { environment }),
            }),
          catch: (error) => error,
        }).pipe(
          // The command failed while the fence was still ours: record the
          // attempt's outcome so a retry replays it, then report the failure.
          // An interrupt is not a failure: the fence that cancelled this fiber
          // owns the claim, and the reclaim settles it.
          Effect.catchAllCause((cause) =>
            Effect.gen(function* () {
              if (Cause.isInterrupted(cause)) {
                return yield* Effect.interrupt;
              }

              const failure = firstFailure(cause);

              if (failure instanceof LeaseLostError) {
                return yield* Effect.fail(failure);
              }

              const settled = yield* settleFailure(options.ledger, call, failureMessage(failure));

              if (!settled) {
                // The claim could not be settled, so a reclaim already owns the
                // run's in-flight rows: this execution lost the run.
                return yield* Effect.fail(new LeaseLostError(request.runId));
              }

              return yield* Effect.fail(failure);
            }),
          ),
        );

        // The commit gate: hold only if the run still carries this fence, so a
        // reclaimed run's in-flight command cannot be recorded as completed.
        yield* hold("after");

        const recorded = yield* ledgerCall("complete", () => options.ledger.complete(call, result));

        if (recorded.status !== "completed") {
          return yield* Effect.fail(new ToolLedgerError("complete"));
        }

        return result;
      }),
  };
}

/**
 * Records a command failure as the claim's outcome. False means the claim was
 * no longer settleable — a reclaim settled it first — which the caller answers
 * as a lost lease. Tracing a settlement failure rather than swallowing it is
 * the point: a call that cannot be recorded cannot be retried safely.
 */
function settleFailure(
  ledger: ToolCallLedger,
  call: ToolCall,
  message: string,
): Effect.Effect<boolean, never> {
  return Effect.tryPromise({
    try: async () => (await ledger.fail(call, message)).status === "failed",
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false));
}

/**
 * The one place the two TTLs are compared. Building a guard whose computer
 * lease outlives its run lease is refused here, so no second module can decide
 * the relationship differently and no reclaimed run can leave a command alive
 * beyond the run lease the watchdog already accounts for.
 */
function assertLeaseTtls(options: FencedComputerCommandsOptions): void {
  const { runLeaseTtlSeconds, computerLeaseTtlSeconds } = options;

  if (!Number.isSafeInteger(runLeaseTtlSeconds) || runLeaseTtlSeconds <= 0) {
    throw new ComputerLeaseTtlError(
      `the run lease TTL must be a positive integer of seconds, got ${String(runLeaseTtlSeconds)}`,
    );
  }

  if (!Number.isSafeInteger(computerLeaseTtlSeconds) || computerLeaseTtlSeconds <= 0) {
    throw new ComputerLeaseTtlError(
      "the computer lease TTL must be a positive integer of seconds, " +
        `got ${String(computerLeaseTtlSeconds)}`,
    );
  }

  if (computerLeaseTtlSeconds > runLeaseTtlSeconds) {
    throw new ComputerLeaseTtlError(
      `the computer lease TTL ${String(computerLeaseTtlSeconds)}s exceeds the run lease TTL ` +
        `${String(runLeaseTtlSeconds)}s; a command that outlives its run's lease can commit ` +
        "under another owner",
    );
  }
}

function firstFailure(cause: Cause.Cause<unknown>): unknown {
  const failure = Cause.failureOption(cause);

  return Option.isSome(failure) ? failure.value : undefined;
}

function failureMessage(value: unknown): string {
  if (typeof value === "object" && value !== null && "detail" in value) {
    const detail = (value as ProviderFailure).detail;

    if (typeof detail === "string" && detail.trim() !== "") {
      return detail;
    }
  }

  if (value instanceof Error && value.message.trim() !== "") {
    return value.message;
  }

  return "the computer command failed";
}
