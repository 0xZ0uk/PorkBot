import { Data } from "effect";

/**
 * The shared typed-error vocabulary the transport boundary maps from (PRD
 * decision 28). Errors live here rather than beside the code that throws them,
 * because `@porkbot/effect` owns the one `Cause -> ORPCError` table and must be
 * able to name every error it maps without importing a data layer.
 *
 * Each class is an Effect `Data.TaggedError`: it is a real `Error` that can be
 * thrown from ordinary promise code, and it carries a literal `_tag` so an
 * Effect program can catch it by tag and the mapping table can key on it.
 * Adding a class to `TypedError` below without a mapping row fails the build,
 * which is what keeps "every typed error has a status" true over time.
 *
 * Nothing here carries secret material or an operator-visible hint: a typed
 * error is a fact the caller already had, not a diagnostic.
 */

/**
 * A resource the caller asked for does not exist *in the caller's scope*. The
 * two cases — "no such row" and "a row in another space" — deliberately produce
 * the same error, so a response can never confirm that a guessed id exists
 * somewhere else (PRD decision 7).
 */
export class NotFoundError extends Data.TaggedError("NotFoundError")<{
  readonly resource: string;
  readonly id: string;
  readonly message: string;
}> {
  constructor(resource: string, id: string) {
    super({ resource, id, message: `${resource} ${id} was not found` });
  }
}

/**
 * A run the caller asked for is no longer there: the row was purged, or the
 * run belongs to a space the caller cannot see. Distinct from `NotFoundError`
 * because the run lifecycle answers it differently — "this run is gone" ends a
 * subscription or a steering attempt, while "no such bot" is a plain miss.
 */
export class RunGoneError extends Data.TaggedError("RunGoneError")<{
  readonly runId: string;
  readonly message: string;
}> {
  constructor(runId: string) {
    super({ runId, message: `run ${runId} no longer exists` });
  }
}

/**
 * This process no longer owns a run it was working on: the lease expired and
 * another worker reclaimed it, or a competing heartbeat advanced the fence.
 * The loser must stop rather than write, so the fact is a typed `CONFLICT`
 * (PRD decision 1); the error names the run and nothing about the winner.
 */
export class LeaseLostError extends Data.TaggedError("LeaseLostError")<{
  readonly runId: string;
  readonly message: string;
}> {
  constructor(runId: string) {
    super({ runId, message: `the lease on run ${runId} was lost to another worker` });
  }
}

/**
 * An approval gate ran out its timeout, so the run resolves the decision to
 * deny rather than waiting forever (PRD decision 13). The tool call id keeps
 * the fact durable and addressable; the timeout policy itself lives in
 * `@porkbot/core`.
 */
export class GateTimeoutError extends Data.TaggedError("GateTimeoutError")<{
  readonly callId: string;
  readonly message: string;
}> {
  constructor(callId: string) {
    super({ callId, message: `approval for tool call ${callId} timed out` });
  }
}

/**
 * The deployment configuration disagrees with itself: the settings table holds
 * more than one row, so "are signups open?" has no single answer. Fail-closed
 * ownership (PRD decision 8) means the resolution must be an explicit
 * misconfiguration surfaced to the operator, never a coin flip between rows,
 * and never a silently-open deployment.
 */
export class DeploymentSettingsConflictError extends Data.TaggedError(
  "DeploymentSettingsConflictError",
)<{
  readonly rows: number;
  readonly message: string;
}> {
  constructor(rows: number) {
    super({
      rows,
      message:
        `deployment_settings holds ${rows} rows; exactly one configuration is expected. ` +
        "Remove the extra rows and keep the one the operator wrote.",
    });
  }
}

/**
 * An adapter asked the credential store for a secret the deployment does not
 * hold, and the provider fails closed rather than sending anything unauthenticated
 * (PRD decision 28 maps this to `PRECONDITION`). The name identifies which
 * credential is missing; the value never existed to leak.
 */
export class CredentialMissingError extends Data.TaggedError("CredentialMissingError")<{
  readonly credentialName: string;
  readonly message: string;
}> {
  constructor(credentialName: string) {
    super({
      credentialName,
      message:
        `credential "${credentialName}" is not configured. ` +
        "Store it through the deployment's credential source before enabling the provider.",
    });
  }
}

/**
 * Why a user-supplied URL was refused. The reasons are distinct because a
 * caller can act on them differently: `insecure_scheme` and
 * `embedded_credentials` are configuration mistakes an operator can fix, while
 * `blocked_address` is the trust boundary holding (PRD decision 23).
 */
export type BlockedUrlReason =
  "invalid_url" | "insecure_scheme" | "embedded_credentials" | "blocked_address";

function blockedUrlMessage(
  reason: BlockedUrlReason,
  host: string | undefined,
  address: string | undefined,
): string {
  switch (reason) {
    case "invalid_url":
      return "the URL is not a valid absolute URL.";
    case "insecure_scheme":
      return (
        `only https URLs may be fetched${host === undefined ? "" : `; got another scheme for "${host}"`}. ` +
        "Plain http can be read and rewritten in flight."
      );
    case "embedded_credentials":
      return (
        `the URL for "${host ?? "the host"}" embeds credentials. ` +
        "Store the secret separately and send it as a header, so it cannot leak through a URL."
      );
    case "blocked_address":
      return (
        `"${host ?? "the host"}" resolves to ${address ?? "an address"} which is private, loopback, ` +
        "link-local, metadata or otherwise not publicly routable. This fetch was refused."
      );
  }
}

/**
 * A fetch of a user-supplied URL was refused before any request was sent
 * (PRD decision 23). Blocked fetches produce this typed error — never a raw
 * network failure — so the transport boundary maps one fact instead of parsing
 * an errno, and a caller can tell a policy refusal from an unreachable host.
 *
 * The error carries the host name and the offending address, never the URL:
 * a URL may embed a credential or a secret query parameter, and an error is
 * serialized into logs.
 */
export class BlockedUrlError extends Data.TaggedError("BlockedUrlError")<{
  readonly reason: BlockedUrlReason;
  readonly host: string | undefined;
  readonly address: string | undefined;
  readonly message: string;
}> {
  constructor(reason: BlockedUrlReason, host?: string, address?: string) {
    super({ reason, host, address, message: blockedUrlMessage(reason, host, address) });
  }
}

/**
 * Why a resume cursor was refused. The reasons are distinct because they mean
 * different things to whoever reads a log: `malformed` is not a cursor at all,
 * `forged` is a reassembled or re-signed one, and `binding` is a genuine cursor
 * presented for the wrong actor, space or thread — the replay the signature
 * exists to stop (PRD decision 18).
 */
export type CursorRejection = "malformed" | "forged" | "binding";

/**
 * A resume cursor on an SSE subscription was refused before any event was
 * replayed. The cursor is an opaque HMAC-signed position bound to the actor,
 * the space and the thread, so a guessed or stolen event id cannot replay
 * another space's stream; a rejection is a typed `BAD_REQUEST`, never a 500
 * and never a silent restart from zero (PRD decision 18, story 19).
 *
 * The error deliberately carries no part of the cursor: a cursor encodes tenant
 * ids, and an error is serialized into logs.
 */
export class CursorRejectedError extends Data.TaggedError("CursorRejectedError")<{
  readonly reason: CursorRejection;
  readonly message: string;
}> {
  constructor(reason: CursorRejection) {
    super({ reason, message: `the resume cursor was rejected (${reason})` });
  }
}

/**
 * The model asked for a tool the run's dispatcher does not hold (slice 5.5).
 * The call is refused before any side effect, and the message is what the
 * runtime hands back to the model as the failed tool call, so the model can
 * choose another tool and recover rather than stalling on a dead name.
 */
export class UnknownToolError extends Data.TaggedError("UnknownToolError")<{
  readonly tool: string;
  readonly message: string;
}> {
  constructor(tool: string) {
    super({ tool, message: `the tool "${tool}" is not registered for this run` });
  }
}

/**
 * A tool call without the fields dispatch requires: a run, a tool name, or —
 * the one that matters for idempotency — a non-empty `callId`. A blank call id
 * cannot be persisted, so a retry of the call would be indistinguishable from a
 * new effect (PRD decision 26).
 */
export class InvalidToolCallError extends Data.TaggedError("InvalidToolCallError")<{
  readonly field: "runId" | "callId" | "tool";
  readonly message: string;
}> {
  constructor(field: "runId" | "callId" | "tool") {
    super({ field, message: `a tool call needs a non-empty "${field}"` });
  }
}

/**
 * A `callId` that cannot be dispatched as this call: it is already claimed but
 * not settled (`in_flight`), or it was claimed for a different tool or
 * different arguments (`call_id_reused`). Both are refusals, never a second
 * side effect — a retried effect is only a no-op when it is the same effect.
 */
export class ToolCallConflictError extends Data.TaggedError("ToolCallConflictError")<{
  readonly runId: string;
  readonly callId: string;
  readonly reason: "in_flight" | "call_id_reused";
  readonly message: string;
}> {
  constructor(runId: string, callId: string, reason: "in_flight" | "call_id_reused") {
    super({
      runId,
      callId,
      reason,
      message:
        reason === "in_flight"
          ? `tool call ${callId} is already in flight`
          : `tool call ${callId} was already used for a different request`,
    });
  }
}

/**
 * The durable tool-call ledger could not be read or written, so the call cannot
 * be recorded and therefore must not run: an unrecorded side effect cannot be
 * replayed or deduplicated, which is the property the ledger exists to give.
 * The operation is named; the driver's cause is deliberately not carried, since
 * a database error can echo the arguments it was given.
 */
export class ToolLedgerError extends Data.TaggedError("ToolLedgerError")<{
  readonly operation: "begin" | "complete" | "fail";
  readonly message: string;
}> {
  constructor(operation: "begin" | "complete" | "fail") {
    super({ operation, message: `the tool-call ledger could not ${operation} the call` });
  }
}

/**
 * Every error that has a row in the mapping table. A new member fails the
 * `satisfies` check in `mapping.ts` until it has a status, and that is the
 * exhaustiveness the table's test suite then proves at runtime.
 */
export type TypedError =
  | NotFoundError
  | RunGoneError
  | LeaseLostError
  | GateTimeoutError
  | DeploymentSettingsConflictError
  | CredentialMissingError
  | BlockedUrlError
  | CursorRejectedError
  | UnknownToolError
  | InvalidToolCallError
  | ToolCallConflictError
  | ToolLedgerError;

/** The literal tag of every typed error, i.e. the table's key space. */
export type TypedErrorTag = TypedError["_tag"];
