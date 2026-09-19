import { Data } from "effect";
import type { ProviderFailureKind } from "@porkbot/adapter-kit";
import type { RunStatus } from "@porkbot/core";

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
 * A name the caller chose is already taken in their scope: a bot section named
 * "Research" exists, and sections are unique per space and user. The name is
 * carried because the caller supplied it — the error is their own input coming
 * back — and the resource is named so one error serves every uniquely-named
 * row rather than growing a class per table.
 */
export class NameConflictError extends Data.TaggedError("NameConflictError")<{
  readonly resource: string;
  readonly name: string;
  readonly message: string;
}> {
  constructor(resource: string, name: string) {
    super({ resource, name, message: `a ${resource} named "${name}" already exists` });
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
 * A run an operator command addressed exists in the caller's space but is no
 * longer active: it completed, failed or was cancelled. Steering is a write
 * into a live run, so a finished one refuses the command rather than dropping
 * the message silently or starting a second run (slice 6.7, PRD story 20). The
 * status travels because the caller's next move depends on it — a finished run
 * means "send again to start fresh", a cancelled one means the operator
 * already stopped it — and the mapping answers `PRECONDITION_FAILED`: the run
 * was the precondition, and it no longer holds.
 */
export class RunNotActiveError extends Data.TaggedError("RunNotActiveError")<{
  readonly runId: string;
  readonly status: RunStatus;
  readonly message: string;
}> {
  constructor(runId: string, status: RunStatus) {
    super({ runId, status, message: `run ${runId} is no longer active (${status})` });
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
 * Why the encrypted credential store could not answer. The reasons are
 * distinct because an operator acts on them differently: `locked` means the
 * deployment was started without its keyring, `unknown_key` means the row was
 * written under a key this deployment no longer holds — the state rotation
 * exists to make impossible — and `corrupt` means the ciphertext failed
 * authentication, which includes a record moved to another row.
 */
export type CredentialStoreFailure = "locked" | "unknown_key" | "corrupt";

function credentialStoreMessage(reason: CredentialStoreFailure, keyId: string | undefined): string {
  switch (reason) {
    case "locked":
      return (
        "the credential store is locked: no encryption keyring is configured. " +
        "Set PORKBOT_CREDENTIAL_KEYS and PORKBOT_CREDENTIAL_ACTIVE_KEY and restart."
      );
    case "unknown_key":
      return (
        `the credential was encrypted with key "${keyId ?? "unknown"}", which this keyring does not hold. ` +
        "Restore that key or re-encrypt the row before the credential can be used."
      );
    case "corrupt":
      return (
        "the credential ciphertext failed authentication. " +
        "It was truncated, tampered with, or moved to another record."
      );
  }
}

/**
 * The encrypted credential store could not read or unlock a value (slice 9.1,
 * PRD decision 10). The adapter-kit credential seam's `auth_failed` mapping
 * says a store that cannot unlock itself raises rather than reading past the
 * failure; this is that raise, and the transport boundary answers it
 * `SERVICE_UNAVAILABLE` because only an operator can repair a keyring.
 *
 * The error names the key id at most — a key id names a slot, not material —
 * and never the value, the envelope or the database's cause: a decryption
 * failure is exactly the place a careless message echoes what it failed to
 * read.
 */
export class CredentialStoreError extends Data.TaggedError("CredentialStoreError")<{
  readonly reason: CredentialStoreFailure;
  readonly keyId: string | undefined;
  readonly message: string;
}> {
  constructor(reason: CredentialStoreFailure, keyId?: string) {
    super({
      reason,
      keyId,
      message: credentialStoreMessage(reason, keyId),
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
 * The durable approval store could not be read or written, so the gate cannot
 * record the request and therefore must not run the tool: an approval nobody
 * can see is an approval nobody can grant (PRD decision 13). The operation is
 * named; the driver's cause is deliberately not carried.
 */
export class ApprovalStoreError extends Data.TaggedError("ApprovalStoreError")<{
  readonly operation: "open" | "read" | "time_out";
  readonly message: string;
}> {
  constructor(operation: "open" | "read" | "time_out") {
    super({
      operation,
      message: `the approval store could not ${operation.replace("_", " ")} the approval`,
    });
  }
}

/**
 * Why a send was refused before anything was written: the text or the nonce
 * broke a rule `@porkbot/core` owns. The reasons are the core rule's own
 * vocabulary, translated at the boundary instead of parsing an error message.
 */
export type InvalidMessageReason = "empty" | "too_long" | "missing_nonce" | "nonce_too_long";

function invalidMessageText(reason: InvalidMessageReason): string {
  switch (reason) {
    case "empty":
      return "a message must carry text";
    case "too_long":
      return "the message text is longer than the send limit";
    case "missing_nonce":
      return "a message requires a client nonce";
    case "nonce_too_long":
      return "the client nonce is longer than the send limit";
  }
}

/**
 * A send that core's message rules refuse: blank text, text over the limit, or
 * a missing or oversized client nonce. It is the caller's own input coming
 * back, answered as a typed `BAD_REQUEST` rather than a 500 (PRD decision 28).
 */
export class InvalidMessageError extends Data.TaggedError("InvalidMessageError")<{
  readonly reason: InvalidMessageReason;
  readonly message: string;
}> {
  constructor(reason: InvalidMessageReason) {
    super({ reason, message: invalidMessageText(reason) });
  }
}

/**
 * A client nonce that already names a different send: it was reused for other
 * text, or for a message on another thread. The nonce is the send's
 * idempotency key, so the refusal is a typed `CONFLICT` — the caller's retry
 * answer is the first message, and a resubmission with new text is a new
 * nonce, never a silent overwrite (PRD decision 5).
 */
export class MessageNonceReusedError extends Data.TaggedError("MessageNonceReusedError")<{
  readonly messageId: string;
  readonly reason: "different_text" | "another_thread";
  readonly message: string;
}> {
  constructor(messageId: string, reason: "different_text" | "another_thread") {
    super({
      messageId,
      reason,
      message:
        reason === "different_text"
          ? `client nonce was already used by message ${messageId} for different text`
          : `client nonce was already used by message ${messageId} on another thread`,
    });
  }
}

/**
 * Why a routine schedule was refused. The reasons are distinct because an
 * operator acts on them differently: `invalid_cron` and `invalid_timezone` are
 * fields to correct, while `unreachable` is a syntactically valid expression
 * (`0 0 31 2 *`) that never fires (PRD decision 22).
 */
export type RoutineScheduleRejection = "invalid_cron" | "invalid_timezone" | "unreachable";

/**
 * A routine schedule an operator submitted cannot become a row: the
 * five-field cron expression is malformed, the timezone is not an IANA zone
 * this runtime knows, or the expression has no fire within its horizon. The
 * grammar belongs to `@porkbot/core`'s scheduler; this is the transport-facing
 * fact, so a bad schedule is the contract's typed `BAD_REQUEST` rather than a
 * 500 from an error the boundary does not know.
 *
 * The message is the scheduler's own sentence, which names the offending field
 * or value but carries nothing else — the expression is operator input, not
 * secret material.
 */
export class InvalidRoutineScheduleError extends Data.TaggedError("InvalidRoutineScheduleError")<{
  readonly reason: RoutineScheduleRejection;
  readonly message: string;
}> {
  constructor(reason: RoutineScheduleRejection, message: string) {
    super({ reason, message });
  }
}

/**
 * An MCP server could not be installed, discovered or called (slice 9.5). The
 * provider classified the failure into the shared vocabulary inside
 * `@porkbot/adapters`; this is that classification crossing the transport
 * boundary, so an install that cannot reach the URL answers a typed
 * `SERVICE_UNAVAILABLE` rather than an opaque 500. The detail is the
 * operator-safe sentence the adapter wrote and never a response body.
 */
export class McpServerUnavailableError extends Data.TaggedError("McpServerUnavailableError")<{
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly message: string;
}> {
  constructor(kind: ProviderFailureKind, detail: string) {
    super({
      kind,
      detail,
      message: `the MCP server could not be reached (${kind}): ${detail}`,
    });
  }
}

/**
 * The supervisor could not be reached, or refused a lifecycle call (slice
 * 7.1, PRD decision 20). The API and the worker hold no provider credential —
 * the supervisor does — so a supervisor that is down or misconfigured is a
 * deployment-level unavailability, answered as a typed `SERVICE_UNAVAILABLE`
 * rather than an opaque 500. The kind is the shared provider vocabulary the
 * supervisor classified, so an operator can tell a timeout from a refusal.
 */
export class ComputerUnavailableError extends Data.TaggedError("ComputerUnavailableError")<{
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly message: string;
}> {
  constructor(kind: ProviderFailureKind, detail: string) {
    super({
      kind,
      detail,
      message: `the computer service could not be reached (${kind}): ${detail}`,
    });
  }
}

/**
 * Why an OAuth callback was refused before any code was exchanged. The reasons
 * are distinct because they mean different things to whoever reads a log: the
 * state was unknown, already consumed or expired; the state named a server the
 * initiating actor cannot see; the membership that started the flow is gone; or
 * the callback carried no code at all.
 */
export type OAuthCallbackRejection =
  "unknown_or_used" | "unknown_server" | "missing_code" | "actor_gone";

function oauthCallbackText(reason: OAuthCallbackRejection): string {
  switch (reason) {
    case "unknown_or_used":
      return "the OAuth state is unknown, already used or expired";
    case "unknown_server":
      return "the OAuth state names a server that does not exist in the initiating space";
    case "missing_code":
      return "the OAuth callback carried no authorization code";
    case "actor_gone":
      return "the membership that started the OAuth flow no longer exists";
  }
}

/**
 * A callback that cannot complete the flow (slice 9.5). The state is the
 * one-time binding the install issued, so a replay, a foreign server id or a
 * missing code is the caller's bad request — the contract's typed `BAD_REQUEST`
 * — never a 500 and never a silent success. The error carries no part of the
 * state, which is a bearer value.
 */
export class InvalidOAuthStateError extends Data.TaggedError("InvalidOAuthStateError")<{
  readonly reason: OAuthCallbackRejection;
  readonly message: string;
}> {
  constructor(reason: OAuthCallbackRejection) {
    super({ reason, message: oauthCallbackText(reason) });
  }
}

/**
 * Every error that has a row in the mapping table. A new member fails the
 * `satisfies` check in `mapping.ts` until it has a status, and that is the
 * exhaustiveness the table's test suite then proves at runtime.
 */
export type TypedError =
  | NotFoundError
  | NameConflictError
  | RunGoneError
  | RunNotActiveError
  | LeaseLostError
  | GateTimeoutError
  | ApprovalStoreError
  | DeploymentSettingsConflictError
  | CredentialMissingError
  | CredentialStoreError
  | BlockedUrlError
  | CursorRejectedError
  | UnknownToolError
  | InvalidToolCallError
  | ToolCallConflictError
  | ToolLedgerError
  | InvalidMessageError
  | MessageNonceReusedError
  | InvalidRoutineScheduleError
  | McpServerUnavailableError
  | ComputerUnavailableError
  | InvalidOAuthStateError;

/** The literal tag of every typed error, i.e. the table's key space. */
export type TypedErrorTag = TypedError["_tag"];
