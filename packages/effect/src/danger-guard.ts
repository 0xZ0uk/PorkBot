import { Effect } from "effect";
import {
  APPROVAL_POLL_INTERVAL_MS,
  classifyDangerousAction,
  COMPUTER_HOME_DIRECTORY,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  EMPTY_EGRESS_ALLOWLIST,
} from "@porkbot/core";
import type { DangerousAction, DangerousActionClass, EgressAllowlist } from "@porkbot/core";
import { createApprovalGate } from "./approval-gate.ts";
import type { ApprovalGateError, ApprovalRecord, ApprovalStore } from "./approval-gate.ts";
import { GateTimeoutError } from "./errors.ts";
import type { ToolCall } from "./tool-dispatcher.ts";

/**
 * The dangerous-action guard (slice 10.2, PRD decision 30; story 40).
 *
 * The policy in `@porkbot/core` says what is dangerous; this module is the
 * enforcement edge every tool consults before it acts. A tool declares the
 * classes its surface can perform and the guard hands the call to
 * `classifyDangerousAction`; the classes read from arguments — a credential
 * path, a write outside the home, an unlisted host — fire only when the call's
 * own arguments match, and a flagged call opens the run's durable approval
 * gate and waits on the row (slice 5.7). Approval is pending state, not a live
 * socket: a decision made in another process resolves the wait, and an offline
 * operator times out to a deny rather than a hang.
 *
 * The guard answers with a value the tool reports to the model rather than an
 * Effect failure, because a denial is a legitimate answer the model reads and
 * adapts to: `allowed` proceeds, `approved` proceeds carrying the settled row,
 * `denied` is an operator's refusal or the deadline, and `refused` is a call
 * the policy would not even ask about — a destination that cannot be
 * attributed to a host, or a dangerous call in a deployment with no gate to
 * ask. Only facts the caller's machinery owns (a store that cannot record the
 * gate, a row that disappeared) travel in the error channel.
 *
 * The gate row carries the call's redacted arguments (the gate redacts them
 * before the write), so a decision is durable with the actor, the instant, the
 * call id and what the call was going to do — the audit #87 renders.
 */

export interface DangerousActionGuardOptions {
  /**
   * The run's durable approval store. Absent, a dangerous call is refused
   * rather than run: a deployment with no gate must fail closed.
   */
  readonly store?: ApprovalStore | undefined;
  /**
   * The bot's home. A `write_outside_home` claim is decided against it, and
   * an approved write acts on the path this home resolves.
   */
  readonly home?: string | undefined;
  /**
   * The run's egress allowlist. The default is the empty, fail-closed list, so
   * a guard built without one asks about every destination.
   */
  readonly allowlist?: EgressAllowlist | undefined;
  /** Defaults to `DEFAULT_APPROVAL_TIMEOUT_MS` from `@porkbot/core`. */
  readonly timeoutMs?: number | undefined;
  /** Defaults to `APPROVAL_POLL_INTERVAL_MS` from `@porkbot/core`. */
  readonly pollIntervalMs?: number | undefined;
}

/**
 * What a tool does after the guard answers. `refused` is the policy's own
 * answer without a vote; `denied` is the answer a person gave or the deadline
 * forced.
 */
export type ActionAuthorization =
  | { readonly status: "allowed" }
  | { readonly status: "refused"; readonly reason: "invalid_url" }
  | {
      readonly status: "refused";
      readonly reason: "approval_unavailable";
      readonly action: DangerousAction;
    }
  | {
      readonly status: "approved";
      readonly action: DangerousAction;
      readonly approval: ApprovalRecord;
    }
  | {
      readonly status: "denied";
      readonly action: DangerousAction;
      readonly reason: "operator_denied" | "approval_timed_out";
      /** The settled row, present when an operator decided; absent on timeout. */
      readonly approval?: ApprovalRecord | undefined;
    };

export interface DangerousActionGuardShape {
  /**
   * Classifies one call and, when the policy flags it, opens the run's durable
   * gate and waits. `declared` is the tool's own claim about its surface (see
   * `DangerousActionRequest`); the arguments still have to support it.
   */
  readonly authorize: (input: {
    readonly call: ToolCall;
    readonly declared?: readonly DangerousActionClass[] | undefined;
  }) => Effect.Effect<ActionAuthorization, ApprovalGateError>;
}

export function createDangerousActionGuard(
  options: DangerousActionGuardOptions = {},
): DangerousActionGuardShape {
  const home = options.home ?? COMPUTER_HOME_DIRECTORY;
  const allowlist = options.allowlist ?? EMPTY_EGRESS_ALLOWLIST;
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? APPROVAL_POLL_INTERVAL_MS;

  const authorize: DangerousActionGuardShape["authorize"] = (input) =>
    Effect.gen(function* () {
      const classification = classifyDangerousAction({
        tool: input.call.tool,
        arguments: input.call.arguments,
        home,
        allowlist,
        declared: input.declared,
      });

      if (classification.verdict === "safe") {
        return { status: "allowed" } satisfies ActionAuthorization;
      }

      if (classification.verdict === "refused") {
        return {
          status: "refused",
          reason: classification.reason,
        } satisfies ActionAuthorization;
      }

      const action = classification.action;

      if (options.store === undefined) {
        return {
          status: "refused",
          reason: "approval_unavailable",
          action,
        } satisfies ActionAuthorization;
      }

      const gate = createApprovalGate({
        runId: input.call.runId,
        store: options.store,
        timeoutMs,
        pollIntervalMs,
      });

      const requested = yield* gate.open({
        callId: input.call.callId,
        tool: input.call.tool,
        arguments: input.call.arguments,
      });

      return yield* gate.waitFor(requested).pipe(
        Effect.map((record): ActionAuthorization =>
          record.status === "approved"
            ? { status: "approved", action, approval: record }
            : { status: "denied", action, reason: "operator_denied", approval: record },
        ),
        Effect.catchIf(
          (error): error is GateTimeoutError => error instanceof GateTimeoutError,
          () =>
            Effect.succeed({
              status: "denied",
              action,
              reason: "approval_timed_out",
            } satisfies ActionAuthorization),
        ),
      );
    });

  return { authorize };
}

/**
 * The model-readable result for a call the guard would not let through. It is
 * a completed tool result, not a failure: the class and the operator's own
 * reason tell the model what was refused and why, so it can adapt instead of
 * retrying the same call blindly. A refusal carries no secret — only the
 * summary the gate row already shows the operator.
 */
export function actionRefusalResult(
  authorization: Extract<ActionAuthorization, { status: "refused" | "denied" }>,
): unknown {
  if (authorization.status === "refused") {
    if (authorization.reason === "invalid_url") {
      return { ok: false, reason: "invalid_url", message: "the URL is not a valid destination" };
    }

    return {
      ok: false,
      reason: "approval_unavailable",
      class: authorization.action.class,
      message: `this run has no approval gate, so ${authorization.action.summary} was refused`,
    };
  }

  if (authorization.reason === "approval_timed_out") {
    return {
      ok: false,
      reason: "approval_timed_out",
      class: authorization.action.class,
      message: `no one answered the approval request to ${authorization.action.summary} before the deadline`,
    };
  }

  const operatorReason = authorization.approval?.reason;

  return {
    ok: false,
    reason: "approval_denied",
    class: authorization.action.class,
    message: `the operator denied a request to ${authorization.action.summary}`,
    ...(operatorReason === null || operatorReason === undefined ? {} : { operatorReason }),
  };
}
