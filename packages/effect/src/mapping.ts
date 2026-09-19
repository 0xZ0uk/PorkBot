import { Cause, Chunk } from "effect";
import { ORPCError } from "@porkbot/contracts";
import {
  ApprovalStoreError,
  BlockedUrlError,
  CredentialMissingError,
  CredentialStoreError,
  CursorRejectedError,
  DeploymentSettingsConflictError,
  GateTimeoutError,
  InvalidMessageError,
  InvalidOAuthStateError,
  InvalidRoutineScheduleError,
  InvalidToolCallError,
  LeaseLostError,
  McpServerUnavailableError,
  MessageNonceReusedError,
  NameConflictError,
  NotFoundError,
  RunGoneError,
  ToolCallConflictError,
  ToolLedgerError,
  UnknownToolError,
} from "./errors.ts";
import type { TypedErrorTag } from "./errors.ts";

/**
 * The one `Cause -> ORPCError` table (PRD decision 28).
 *
 * Routers never inspect an error: a handler throws a typed error — or an
 * Effect service fails with one in its error channel — and this module turns
 * that fact into the transport envelope. The table is exhaustive over
 * `TypedError`, so adding a typed error without a row fails the build, and the
 * unit suite walks every row to prove each one has a status.
 *
 * The default row is the important one: anything that is not a typed error is
 * an unmapped defect. It answers 500 with a fixed message, keeps the original
 * value for a redacted log line, and never puts a stack, a cause or an
 * operator message into the response.
 */

/**
 * One row of the table. `code` is the oRPC code the client receives when the
 * procedure has not declared a matching error; the procedure's declaration, if
 * any, supplies the status and the message so the response stays a *typed*
 * error rather than an unexpected one.
 */
export interface ErrorMapping {
  readonly code: string;
  readonly message: string;
  readonly matches: (error: unknown) => boolean;
}

/**
 * The table. Row keys are the `_tag` of every `TypedError`, and the `satisfies`
 * clause is what makes the vocabulary complete: a class added to
 * `TypedError` without a row here does not compile.
 */
export const errorMappings = {
  NotFoundError: {
    code: "NOT_FOUND",
    message: "The requested resource was not found.",
    matches: (error: unknown): error is NotFoundError => error instanceof NotFoundError,
  },
  NameConflictError: {
    code: "CONFLICT",
    message: "A resource with that name already exists.",
    matches: (error: unknown): error is NameConflictError => error instanceof NameConflictError,
  },
  RunGoneError: {
    code: "NOT_FOUND",
    message: "This run no longer exists.",
    matches: (error: unknown): error is RunGoneError => error instanceof RunGoneError,
  },
  LeaseLostError: {
    code: "CONFLICT",
    message: "Another worker owns this run now.",
    matches: (error: unknown): error is LeaseLostError => error instanceof LeaseLostError,
  },
  GateTimeoutError: {
    code: "TIMEOUT",
    message: "The approval gate timed out.",
    matches: (error: unknown): error is GateTimeoutError => error instanceof GateTimeoutError,
  },
  ApprovalStoreError: {
    code: "SERVICE_UNAVAILABLE",
    message: "The approval record is not available.",
    matches: (error: unknown): error is ApprovalStoreError => error instanceof ApprovalStoreError,
  },
  DeploymentSettingsConflictError: {
    code: "SERVICE_UNAVAILABLE",
    message: "The deployment's configuration is not readable.",
    matches: (error: unknown): error is DeploymentSettingsConflictError =>
      error instanceof DeploymentSettingsConflictError,
  },
  CredentialMissingError: {
    code: "PRECONDITION_FAILED",
    message: "The deployment is missing a required credential.",
    matches: (error: unknown): error is CredentialMissingError =>
      error instanceof CredentialMissingError,
  },
  CredentialStoreError: {
    code: "SERVICE_UNAVAILABLE",
    message: "The credential store could not be read.",
    matches: (error: unknown): error is CredentialStoreError =>
      error instanceof CredentialStoreError,
  },
  BlockedUrlError: {
    code: "BAD_REQUEST",
    message: "The URL was refused by the deployment's network policy.",
    matches: (error: unknown): error is BlockedUrlError => error instanceof BlockedUrlError,
  },
  CursorRejectedError: {
    code: "BAD_REQUEST",
    message: "The resume cursor is not valid for this stream.",
    matches: (error: unknown): error is CursorRejectedError => error instanceof CursorRejectedError,
  },
  UnknownToolError: {
    code: "BAD_REQUEST",
    message: "The requested tool is not available in this run.",
    matches: (error: unknown): error is UnknownToolError => error instanceof UnknownToolError,
  },
  InvalidToolCallError: {
    code: "BAD_REQUEST",
    message: "The tool call is missing a required field.",
    matches: (error: unknown): error is InvalidToolCallError =>
      error instanceof InvalidToolCallError,
  },
  ToolCallConflictError: {
    code: "CONFLICT",
    message: "That tool call is already in flight or was used for a different request.",
    matches: (error: unknown): error is ToolCallConflictError =>
      error instanceof ToolCallConflictError,
  },
  ToolLedgerError: {
    code: "SERVICE_UNAVAILABLE",
    message: "The tool-call record is not available.",
    matches: (error: unknown): error is ToolLedgerError => error instanceof ToolLedgerError,
  },
  InvalidMessageError: {
    code: "BAD_REQUEST",
    message: "The message did not pass the send rules.",
    matches: (error: unknown): error is InvalidMessageError => error instanceof InvalidMessageError,
  },
  MessageNonceReusedError: {
    code: "CONFLICT",
    message: "That client nonce already belongs to another message.",
    matches: (error: unknown): error is MessageNonceReusedError =>
      error instanceof MessageNonceReusedError,
  },
  InvalidRoutineScheduleError: {
    code: "BAD_REQUEST",
    message: "The routine schedule is invalid.",
    matches: (error: unknown): error is InvalidRoutineScheduleError =>
      error instanceof InvalidRoutineScheduleError,
  },
  McpServerUnavailableError: {
    code: "SERVICE_UNAVAILABLE",
    message: "The MCP server could not be reached.",
    matches: (error: unknown): error is McpServerUnavailableError =>
      error instanceof McpServerUnavailableError,
  },
  InvalidOAuthStateError: {
    code: "BAD_REQUEST",
    message: "The OAuth callback is not valid for this flow.",
    matches: (error: unknown): error is InvalidOAuthStateError =>
      error instanceof InvalidOAuthStateError,
  },
} as const satisfies { readonly [K in TypedErrorTag]: ErrorMapping };

/** The oRPC code each typed error maps to, as a literal union. */
export type MappedErrorCode = (typeof errorMappings)[TypedErrorTag]["code"];

/**
 * The procedure's declared entry for a mapped code, when it has one. The
 * contract owns the status and the message a caller sees; this is the shape
 * the boundary reads without importing the contract package.
 */
export interface DeclaredError {
  readonly status?: number | undefined;
  readonly message?: string | undefined;
}

/** {@link DeclaredError} lookup, usually the procedure's own error map. */
export type DeclaredErrorLookup = (code: MappedErrorCode) => DeclaredError | undefined;

export interface BoundaryOptions {
  /**
   * Resolves the procedure's declared entry for a mapped code, so a mapped
   * error goes out as the contract's typed error (`defined: true`) instead of
   * an unexpected one. Omit outside a procedure; the mapping still applies.
   */
  readonly declaredFor?: DeclaredErrorLookup | undefined;
}

/**
 * The outcome of mapping one error or cause: the envelope for the client, and
 * the values the boundary must write to a redacted log. An empty `report` means
 * the error was expected (a typed mapping or an interrupt); a non-empty one
 * means a defect, named so the caller can log it without inspecting the error.
 */
export interface BoundaryError {
  readonly error: ORPCError<string, unknown>;
  readonly report: readonly unknown[];
}

const unexpectedMessage = "The server failed to handle the request.";

/**
 * The report travels on the error object itself, under a registry symbol: the
 * boundary throws the mapped error and is handed the same instance back by
 * oRPC, and a symbol (not a module-global `WeakSet`) survives two copies of
 * this module — the source import a test uses and the built package a process
 * loads. It is non-enumerable, so it never serializes into a response or a log
 * of the error.
 */
const reportSymbol = Symbol.for("porkbot.effect.boundary-report");

function marked(error: ORPCError<string, unknown>, report: readonly unknown[]): BoundaryError {
  Object.defineProperty(error, reportSymbol, { value: report, enumerable: false });
  return { error, report };
}

/**
 * The report the boundary left on a mapped error, or `null` when the error did
 * not come from the table. The boundary uses this to decide what to log without
 * ever inspecting a raw error or a cause: a mapped error with an empty report
 * is expected and gets no error line, and a mapped defect arrives with the
 * value to log redacted.
 */
export function boundaryReports(error: unknown): readonly unknown[] | null {
  if (typeof error !== "object" || error === null || !(reportSymbol in error)) {
    return null;
  }

  const report = (error as Record<symbol, unknown>)[reportSymbol];
  return Array.isArray(report) ? report : [];
}

/** The row for a typed error, or `undefined` when the value is not one. */
export function mappingFor(error: unknown): ErrorMapping | undefined {
  for (const mapping of Object.values(errorMappings)) {
    if (mapping.matches(error)) {
      return mapping;
    }
  }

  return undefined;
}

function mappedError(mapping: ErrorMapping, options: BoundaryOptions): ORPCError<string, unknown> {
  const declared = options.declaredFor?.(mapping.code as MappedErrorCode);

  return new ORPCError(mapping.code, {
    defined: declared !== undefined,
    ...(declared?.status === undefined ? {} : { status: declared.status }),
    message: declared?.message ?? mapping.message,
  });
}

function internalServerError(): ORPCError<string, unknown> {
  return new ORPCError("INTERNAL_SERVER_ERROR", {
    defined: false,
    message: unexpectedMessage,
  });
}

/**
 * Maps a thrown value. An `ORPCError` is already the transport envelope — the
 * gate's typed 401, a router's declared error — and passes through untouched.
 * A typed error takes its row; anything else is a defect answered 500 with the
 * value handed back for a redacted log.
 */
export function mapError(error: unknown, options: BoundaryOptions = {}): BoundaryError {
  if (error instanceof ORPCError) {
    return { error, report: [] };
  }

  return mapCause(mappingFor(error) === undefined ? Cause.die(error) : Cause.fail(error), options);
}

/**
 * Maps an Effect `Cause`. The first mapped failure wins, so a typed error is
 * the client's answer even when the cause also holds a defect; everything
 * unexpected is still reported — every defect, and every failure that has no
 * row — because a bug beside a typed error must not be swallowed. A cause that
 * only interrupted (the client went away) answers 499 and reports nothing.
 */
export function mapCause(
  cause: Cause.Cause<unknown>,
  options: BoundaryOptions = {},
): BoundaryError {
  const failures = Chunk.toReadonlyArray(Cause.failures(cause));
  const defects = Chunk.toReadonlyArray(Cause.defects(cause));
  const unexpectedFailures = failures.filter((failure) => mappingFor(failure) === undefined);
  const report = [...defects, ...unexpectedFailures];

  for (const failure of failures) {
    const mapping = mappingFor(failure);

    if (mapping !== undefined) {
      return marked(mappedError(mapping, options), report);
    }
  }

  if (report.length > 0) {
    return marked(internalServerError(), report);
  }

  if (Cause.isEmpty(cause)) {
    // A success has no error to report; mapping one is a programming mistake,
    // answered 500 rather than pretending it was a client close.
    return marked(internalServerError(), []);
  }

  if (Cause.isInterruptedOnly(cause)) {
    return marked(
      new ORPCError("CLIENT_CLOSED_REQUEST", { message: "The client closed the request." }),
      [],
    );
  }

  return marked(internalServerError(), []);
}
