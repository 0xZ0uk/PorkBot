import { Effect } from "effect";
import { decideEgress } from "@porkbot/core";
import type { EgressAllowlist } from "@porkbot/core";
import type { ApprovalGateError, ApprovalGateShape, ApprovalRecord } from "./approval-gate.ts";
import { GateTimeoutError } from "./errors.ts";

/**
 * The egress guard: the allowlist's enforcement edge (PRD decision 30; story
 * 40; slice 10.1).
 *
 * A tool that reaches the network asks the guard first, and the guard answers
 * with a value the tool reports to the model: `allowed` when the host is on the
 * run's list, `approved` when an operator opened the gate for this call,
 * `denied` when the operator refused or the durable deadline passed, and
 * `refused` when the destination cannot be attributed to a host at all. The
 * decision comes from `decideEgress`; this module adds the half that needs a
 * durable store — recording the pending approval before any request is made,
 * and waiting on the row rather than on a socket, so a decision made in
 * another process resolves the wait and an offline operator times out to a
 * deny rather than a hang (PRD decision 13).
 *
 * Address safety is not repeated here. `safeFetch` refuses a non-HTTPS URL, a
 * credential-bearing URL and a blocked address when the request is made; the
 * allowlist decides whether asking was allowed at all. A denial is a value
 * rather than a failure because it is a legitimate answer the model reads and
 * adapts to; only facts the caller's machinery owns (a store that cannot
 * record the gate, a row that disappeared) travel in the error channel.
 */

/** What the tool layer does after the guard answers. */
export type EgressAuthorization =
  | { readonly status: "allowed"; readonly host: string }
  | { readonly status: "approved"; readonly host: string; readonly approval: ApprovalRecord }
  | {
      readonly status: "denied";
      readonly reason: "invalid_url" | "operator_denied" | "approval_timed_out";
      readonly host: string | null;
      /** The settled row, present when an operator decided; absent on timeout. */
      readonly approval?: ApprovalRecord | undefined;
    };

export interface EgressGuardOptions {
  /** The run's allowlist, parsed once at configuration time. */
  readonly allowlist: EgressAllowlist;
  /**
   * The run's approval gate. The guard opens one row per gated call, keyed by
   * the tool call's durable `callId`, and waits on that row.
   */
  readonly gate: ApprovalGateShape;
}

export interface EgressGuardShape {
  /**
   * Authorizes one destination for one tool call. An allowlisted host returns
   * immediately; anything else opens a durable approval and waits for it. The
   * gate is only consulted for a URL that yields a host.
   */
  readonly authorize: (input: {
    readonly callId: string;
    readonly tool: string;
    readonly url: string;
  }) => Effect.Effect<EgressAuthorization, ApprovalGateError>;
}

export function createEgressGuard(options: EgressGuardOptions): EgressGuardShape {
  const authorize: EgressGuardShape["authorize"] = (input) =>
    Effect.gen(function* () {
      const decision = decideEgress(options.allowlist, input.url);

      if (decision.decision === "refused") {
        return {
          status: "denied",
          reason: "invalid_url",
          host: null,
        } satisfies EgressAuthorization;
      }

      if (decision.decision === "allowed") {
        return { status: "allowed", host: decision.host } satisfies EgressAuthorization;
      }

      const requested = yield* options.gate.open({ callId: input.callId, tool: input.tool });

      return yield* options.gate.waitFor(requested).pipe(
        Effect.map((record): EgressAuthorization =>
          record.status === "approved"
            ? { status: "approved", host: decision.host, approval: record }
            : {
                status: "denied",
                reason: "operator_denied",
                host: decision.host,
                approval: record,
              },
        ),
        Effect.catchIf(
          (error): error is GateTimeoutError => error instanceof GateTimeoutError,
          () =>
            Effect.succeed({
              status: "denied",
              reason: "approval_timed_out",
              host: decision.host,
            } satisfies EgressAuthorization),
        ),
      );
    });

  return { authorize };
}
