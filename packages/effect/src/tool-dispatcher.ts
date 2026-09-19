import { Cause, Effect, Option } from "effect";
import { PROVIDER_FAILURE_KINDS } from "@porkbot/adapter-kit";
import type { ModelToolDefinition, ProviderFailure } from "@porkbot/adapter-kit";
import {
  InvalidToolCallError,
  LeaseLostError,
  NotFoundError,
  ToolCallConflictError,
  ToolLedgerError,
  UnknownToolError,
} from "./errors.ts";

/**
 * The tool dispatch seam (slice 5.5, PRD decision 26; audit section 3).
 *
 * The reference implementation matched a tool name in a single executor with a
 * 53-branch `name ===` chain: the list the model saw (name, description,
 * schema) lived in one module and the handler that ran lived in another
 * expression of the same name, so the two could disagree and a rename was two
 * edits coupled by string equality. Here a tool is one registration: its
 * metadata and its handler are the same value, the model-facing
 * `ModelToolDefinition` is generated from it, and `canHandle`/`execute` cannot
 * know about a tool the registry does not hold.
 *
 * Every call carries a durable `callId` from the model and is refused when it
 * does not, because that id is the non-null idempotency key (PRD decision 26):
 * the dispatcher claims it in a ledger before any side effect, and a retry of
 * the same call replays the stored outcome instead of running the handler
 * twice. A call whose id is already executing, or whose id was used for a
 * different request, is a typed conflict rather than a silent double effect.
 *
 * The caller supplies the run's fenced heartbeat; the dispatcher awaits it
 * after the durable claim and before the handler, so a tool never starts on a
 * lease the worker has already lost. The run lease TTL must cover every tool's
 * declared `maxDurationMs`, and the dispatcher refuses to be built otherwise:
 * a tool that can outlive its lease is a tool whose side effect can commit
 * after another worker owns the run. The declared duration is also the hard
 * budget — a handler that exceeds it is interrupted and reported as failed.
 *
 * The ledger is an interface, not a database call: `@porkbot/db` implements it
 * over the `external_effect` rows, and a test can implement it in memory. The
 * dispatcher never imports a driver, and the run runtime never inspects a
 * vendor error — a handler that throws is reported to the model as the failed
 * outcome of its call, and the message it threw is the model's recovery hint.
 */

/** One tool call the model asked for. `callId` is the durable idempotency key. */
export interface ToolCall {
  readonly runId: string;
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
}

/**
 * What one call produced. A handler failure is an outcome, not an Effect
 * failure: the model asked for a tool, the tool refused or broke, and the model
 * recovers by reading the failure as the call's result. Only facts the caller's
 * own machinery owns (an unknown tool, a conflicting id, a lost lease, an
 * unreadable ledger) travel in the error channel.
 */
export type ToolOutcome =
  | { readonly status: "completed"; readonly result: unknown }
  | { readonly status: "failed"; readonly error: string };

/**
 * One tool, metadata and handler in the same value — the "one registration"
 * the acceptance criterion is about. `parameters` is the provider-neutral JSON
 * Schema `ModelToolDefinition` carries, and `maxDurationMs` is both the tool's
 * declared hard budget and its claim on the run lease.
 */
export interface ToolRegistration {
  readonly name: string;
  readonly description: string;
  readonly parameters: unknown;
  /**
   * The most wall-clock time one call may take. Must not exceed the run lease
   * TTL, because a side effect that outlives the lease commits against a run
   * another worker may already own.
   */
  readonly maxDurationMs: number;
  /**
   * Runs one call. A failure classified as a `ProviderFailure` reaches the
   * model and the ledger as its `kind` and `detail` — the vocabulary's
   * operator-safe text (PRD decision 19). Any other failure is reported as a
   * generic `tool "name" failed`, so a vendor message, a credential or a raw
   * response body can never round-trip through the model or the durable
   * record by accident.
   */
  readonly execute: (call: ToolCall) => Effect.Effect<unknown, unknown>;
}

/**
 * What the ledger knows about a call when the dispatcher claims it. `started`
 * is the claim the caller must settle; the others are settled facts replayed so
 * a retry is a no-op.
 */
export type ToolCallAdmission =
  | { readonly status: "started" }
  | { readonly status: "completed"; readonly result: unknown }
  | { readonly status: "failed"; readonly error: string }
  /** The id is claimed but not settled: another attempt may be mid-effect. */
  | { readonly status: "in_flight" }
  /** The id was claimed for a different tool or different arguments. */
  | { readonly status: "call_id_reused" };

/**
 * The durable half of dispatch: a row keyed by `(runId, callId)` that exists
 * before the side effect and records its outcome after. `begin` must be atomic
 * — two racing attempts at the same id produce one `started` claim — and the
 * implementation decides what durability means; `@porkbot/db` uses the
 * `external_effect` unique index rather than a read-then-write check.
 *
 * `complete` and `fail` return the outcome as durably recorded, not merely
 * what the handler produced: a ledger whose column cannot carry a result
 * settles that call as failed and says so, so the caller and every later retry
 * answer the model the same way.
 */
export interface ToolCallLedger {
  begin(call: ToolCall): Promise<ToolCallAdmission>;
  complete(call: ToolCall, result: unknown): Promise<ToolOutcome>;
  fail(call: ToolCall, error: string): Promise<ToolOutcome>;
}

/**
 * The dispatcher's error channel. These are the facts the run runtime answers:
 * `UnknownToolError` becomes a `tool.failed` event the model reads and recovers
 * from, a conflict and a lost lease stop the call before its side effect, and
 * a ledger failure stops it because a call that cannot be recorded cannot be
 * retried safely.
 */
export type ToolDispatchError =
  | InvalidToolCallError
  | UnknownToolError
  | ToolCallConflictError
  | ToolLedgerError
  | NotFoundError
  | LeaseLostError;

/**
 * The interface the run runtime and the model-facing tool list consume.
 * `definitions` is generated from the same registrations `execute` dispatches,
 * so the list the model is offered and the code that runs a call cannot drift.
 */
export interface ToolDispatcher {
  /** Whether a registration handles this tool name. */
  readonly canHandle: (tool: string) => boolean;
  /** The model-facing metadata, generated from the registrations. */
  readonly definitions: () => readonly ModelToolDefinition[];
  /**
   * Claims, executes and settles one call. A retry of a settled `callId`
   * replays the stored outcome without invoking the handler.
   */
  readonly execute: (call: ToolCall) => Effect.Effect<ToolOutcome, ToolDispatchError>;
}

/** Why a registration was refused, so the boot failure names the mistake. */
export type ToolRegistrationErrorReason =
  | "invalid_lease_ttl"
  | "empty_name"
  | "untrimmed_name"
  | "duplicate_name"
  | "empty_description"
  | "invalid_parameters"
  | "invalid_duration"
  | "duration_exceeds_lease";

/**
 * A malformed registration. This is a programming error discovered while the
 * worker wires its tools — at boot, not at the first call — so it throws rather
 * than travelling as a typed failure.
 */
export class ToolRegistrationError extends Error {
  readonly reason: ToolRegistrationErrorReason;
  readonly tool: string;

  constructor(reason: ToolRegistrationErrorReason, tool: string, detail: string) {
    super(`${detail} (tool "${tool}")`);
    this.name = "ToolRegistrationError";
    this.reason = reason;
    this.tool = tool;
  }
}

export interface ToolDispatcherOptions {
  /** The tools this run may call, in the order the model should see them. */
  readonly registrations: readonly ToolRegistration[];
  readonly ledger: ToolCallLedger;
  /** The run's lease TTL; every registration's `maxDurationMs` must fit. */
  readonly leaseTtlMs: number;
  /**
   * Persists the run's heartbeat. The dispatcher awaits it before every
   * execution the ledger admits, and a lease that moved on stops the call
   * before the handler runs.
   */
  readonly heartbeat: Effect.Effect<void, LeaseLostError>;
}

/**
 * Builds the dispatcher from the one registration list. Invalid registrations
 * fail here, before a run can reach them: a duplicate name (the model cannot
 * choose between two), a missing description or schema, a non-positive
 * duration, or a duration longer than the lease TTL.
 */
export function createToolDispatcher(options: ToolDispatcherOptions): ToolDispatcher {
  if (!Number.isSafeInteger(options.leaseTtlMs) || options.leaseTtlMs <= 0) {
    throw new ToolRegistrationError(
      "invalid_lease_ttl",
      "",
      `the run lease TTL must be a positive integer of milliseconds, got ${String(options.leaseTtlMs)}`,
    );
  }

  const registry = new Map<string, ToolRegistration>();

  for (const registration of options.registrations) {
    validateRegistration(registration, options.leaseTtlMs, registry);
    registry.set(registration.name, registration);
  }

  const definitions = Object.freeze(
    options.registrations.map(({ name, description, parameters }): ModelToolDefinition => ({
      name,
      description,
      parameters,
    })),
  );

  return {
    canHandle: (tool) => registry.has(tool),
    definitions: () => definitions,
    execute: (call) => executeTool(options.ledger, options.heartbeat, registry, call),
  };
}

function validateRegistration(
  registration: ToolRegistration,
  leaseTtlMs: number,
  registry: ReadonlyMap<string, ToolRegistration>,
): void {
  const { name } = registration;

  if (name.trim() === "") {
    throw new ToolRegistrationError("empty_name", name, "a tool needs a non-empty name");
  }

  if (name !== name.trim()) {
    throw new ToolRegistrationError(
      "untrimmed_name",
      name,
      "a tool name must not carry surrounding whitespace; the model is offered the raw string",
    );
  }

  if (registry.has(name)) {
    throw new ToolRegistrationError(
      "duplicate_name",
      name,
      "two registrations claim the same tool name; the model cannot choose between them",
    );
  }

  if (registration.description.trim() === "") {
    throw new ToolRegistrationError(
      "empty_description",
      name,
      "a tool needs a description; it is the model's only instruction for choosing it",
    );
  }

  if (
    typeof registration.parameters !== "object" ||
    registration.parameters === null ||
    Array.isArray(registration.parameters)
  ) {
    throw new ToolRegistrationError(
      "invalid_parameters",
      name,
      "parameters must be a JSON Schema object; a missing or non-object schema is not offered to the model",
    );
  }

  if (!Number.isSafeInteger(registration.maxDurationMs) || registration.maxDurationMs <= 0) {
    throw new ToolRegistrationError(
      "invalid_duration",
      name,
      `maxDurationMs must be a positive integer, got ${String(registration.maxDurationMs)}`,
    );
  }

  if (registration.maxDurationMs > leaseTtlMs) {
    throw new ToolRegistrationError(
      "duration_exceeds_lease",
      name,
      `maxDurationMs ${registration.maxDurationMs} exceeds the run lease TTL ${leaseTtlMs}; ` +
        "a side effect that outlives its lease can commit under another owner",
    );
  }
}

function executeTool(
  ledger: ToolCallLedger,
  heartbeat: Effect.Effect<void, LeaseLostError>,
  registry: ReadonlyMap<string, ToolRegistration>,
  call: ToolCall,
): Effect.Effect<ToolOutcome, ToolDispatchError> {
  return Effect.gen(function* () {
    const field = missingField(call);
    if (field !== undefined) {
      return yield* Effect.fail(new InvalidToolCallError(field));
    }

    const registration = registry.get(call.tool);
    if (registration === undefined) {
      return yield* Effect.fail(new UnknownToolError(call.tool));
    }

    const admission = yield* ledgerCall("begin", () => ledger.begin(call));

    switch (admission.status) {
      case "completed":
        return { status: "completed", result: admission.result } satisfies ToolOutcome;
      case "failed":
        return { status: "failed", error: admission.error } satisfies ToolOutcome;
      case "in_flight":
        return yield* Effect.fail(new ToolCallConflictError(call.runId, call.callId, "in_flight"));
      case "call_id_reused":
        return yield* Effect.fail(
          new ToolCallConflictError(call.runId, call.callId, "call_id_reused"),
        );
      case "started":
        break;
    }

    // The claim is durable now, so the heartbeat is the last gate before the
    // side effect: a lease that moved on fails the call here, and the claim is
    // left in flight for reclaim to reconcile rather than replayed blindly.
    yield* heartbeat;

    const outcome = yield* registration.execute(call).pipe(
      Effect.timeoutFail({
        duration: registration.maxDurationMs,
        onTimeout: () => new ToolDurationExceeded(registration.name, registration.maxDurationMs),
      }),
      Effect.map((result): ToolOutcome => ({ status: "completed", result })),
      Effect.catchAllCause((cause) => {
        if (Cause.isInterrupted(cause)) {
          return Effect.interrupt;
        }

        // A handler that learned the fence moved — the fenced computer command
        // runner is the shipped case, its commit gate raising the typed loss —
        // stops the run with that error instead of becoming a generic tool
        // failure. The claim is deliberately left `running` for the reclaim to
        // settle, exactly as a beat that loses the fence leaves it.
        const failure = Cause.failureOption(cause);

        if (Option.isSome(failure) && failure.value instanceof LeaseLostError) {
          return Effect.fail(failure.value);
        }

        return Effect.succeed({
          status: "failed",
          error: failureMessage(cause, registration.name),
        } satisfies ToolOutcome);
      }),
    );

    // The returned outcome is the one the ledger recorded, so the caller and a
    // later replay cannot disagree about what happened.
    if (outcome.status === "completed") {
      return yield* ledgerCall("complete", () => ledger.complete(call, outcome.result));
    }

    return yield* ledgerCall("fail", () => ledger.fail(call, outcome.error));
  });
}

function missingField(call: ToolCall): "runId" | "callId" | "tool" | undefined {
  if (call.runId.trim() === "") {
    return "runId";
  }

  // The call id is the idempotency key. A blank one cannot be persisted, and
  // without it a retry is indistinguishable from a new call.
  if (call.callId.trim() === "") {
    return "callId";
  }

  if (call.tool.trim() === "") {
    return "tool";
  }

  return undefined;
}

/**
 * Wraps a ledger call: a typed not-found stays typed (the actor-scoped ledger
 * reports a run outside the space that way), and anything else becomes the
 * ledger's own failure. The underlying cause is deliberately dropped — a
 * driver error can echo the arguments it was given, and those are the model's.
 */
function ledgerCall<A>(
  operation: "begin" | "complete" | "fail",
  run: () => Promise<A>,
): Effect.Effect<A, ToolLedgerError | NotFoundError> {
  return Effect.tryPromise({
    try: run,
    catch: (error) => (error instanceof NotFoundError ? error : new ToolLedgerError(operation)),
  });
}

/** A handler that overran its declared budget; never crosses the seam as a value. */
class ToolDurationExceeded extends Error {
  constructor(tool: string, maxDurationMs: number) {
    super(`tool "${tool}" exceeded its ${maxDurationMs}ms budget`);
    this.name = "ToolDurationExceeded";
  }
}

/**
 * The message a failed call shows the model and records durably. Only the
 * dispatcher's own budget fact and a failure classified into the shared
 * `ProviderFailure` vocabulary are specific; anything else is generic. That is
 * what keeps a vendor error string, a credential or a raw response body from
 * round-tripping through the model and the ledger by accident (PRD decision 19
 * and the secret rule in AGENTS.md).
 */
function failureMessage(cause: Cause.Cause<unknown>, tool: string): string {
  const failure = Cause.failureOption(cause);

  if (Option.isNone(failure)) {
    return genericFailure(tool);
  }

  let value = failure.value;

  // A tool that wraps a provider promise with a bare `Effect.tryPromise` gets
  // Effect's wrapper as the failure; the value it meant to raise is the
  // wrapper's cause, so classification reads through the wrapper.
  if (Cause.isUnknownException(value)) {
    value = value.cause;
  }

  if (value instanceof ToolDurationExceeded) {
    return value.message;
  }

  if (isProviderFailure(value)) {
    return value.detail === undefined || value.detail === ""
      ? `tool "${tool}" failed (${value.kind})`
      : `tool "${tool}" failed (${value.kind}): ${value.detail}`;
  }

  return genericFailure(tool);
}

function genericFailure(tool: string): string {
  return `tool "${tool}" failed`;
}

function isProviderFailure(value: unknown): value is ProviderFailure {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as { readonly kind?: unknown; readonly detail?: unknown };

  return (
    typeof candidate.kind === "string" &&
    (PROVIDER_FAILURE_KINDS as readonly string[]).includes(candidate.kind) &&
    (candidate.detail === undefined || typeof candidate.detail === "string")
  );
}
