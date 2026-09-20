import { Cause, FiberId } from "effect";
import { ORPCError } from "@porkbot/contracts";
import { describe, expect, it } from "vitest";
import {
  ApprovalStoreError,
  BlockedUrlError,
  BotSecretDestinationError,
  ComputerUnavailableError,
  CredentialMissingError,
  CredentialStoreError,
  CursorRejectedError,
  DeploymentSettingsConflictError,
  GateTimeoutError,
  InvalidComputerPathError,
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
  RunNotActiveError,
  ToolCallConflictError,
  ToolLedgerError,
  UnknownToolError,
} from "./errors.ts";
import type { TypedError, TypedErrorTag } from "./errors.ts";
import { boundaryReports, errorMappings, mapCause, mapError } from "./mapping.ts";

/**
 * Every typed error, with the one status the table promises. The record is
 * keyed by `TypedErrorTag`, so a class added to the vocabulary without a sample
 * here fails the build; the runtime walk below then proves every row really
 * produces the code and the HTTP status it claims. That is the exhaustiveness
 * the issue asks for: not "the table is long", but "the table cannot be
 * incomplete".
 */
const samples = {
  NotFoundError: {
    error: new NotFoundError("bot", "bot-1"),
    code: "NOT_FOUND",
    status: 404,
  },
  NameConflictError: {
    error: new NameConflictError("bot section", "Research"),
    code: "CONFLICT",
    status: 409,
  },
  RunGoneError: { error: new RunGoneError("run-1"), code: "NOT_FOUND", status: 404 },
  RunNotActiveError: {
    error: new RunNotActiveError("run-1", "completed"),
    code: "PRECONDITION_FAILED",
    status: 412,
  },
  LeaseLostError: { error: new LeaseLostError("run-1"), code: "CONFLICT", status: 409 },
  GateTimeoutError: { error: new GateTimeoutError("call-1"), code: "TIMEOUT", status: 408 },
  ApprovalStoreError: {
    error: new ApprovalStoreError("open"),
    code: "SERVICE_UNAVAILABLE",
    status: 503,
  },
  DeploymentSettingsConflictError: {
    error: new DeploymentSettingsConflictError(2),
    code: "SERVICE_UNAVAILABLE",
    status: 503,
  },
  CredentialMissingError: {
    error: new CredentialMissingError("transactional-mail-api-key"),
    code: "PRECONDITION_FAILED",
    status: 412,
  },
  CredentialStoreError: {
    error: new CredentialStoreError("unknown_key", "k1"),
    code: "SERVICE_UNAVAILABLE",
    status: 503,
  },
  BlockedUrlError: {
    error: new BlockedUrlError("blocked_address", "example.com", "127.0.0.1"),
    code: "BAD_REQUEST",
    status: 400,
  },
  CursorRejectedError: {
    error: new CursorRejectedError("forged"),
    code: "BAD_REQUEST",
    status: 400,
  },
  UnknownToolError: {
    error: new UnknownToolError("shell"),
    code: "BAD_REQUEST",
    status: 400,
  },
  InvalidToolCallError: {
    error: new InvalidToolCallError("callId"),
    code: "BAD_REQUEST",
    status: 400,
  },
  ToolCallConflictError: {
    error: new ToolCallConflictError("run-1", "call-1", "in_flight"),
    code: "CONFLICT",
    status: 409,
  },
  ToolLedgerError: {
    error: new ToolLedgerError("begin"),
    code: "SERVICE_UNAVAILABLE",
    status: 503,
  },
  InvalidMessageError: {
    error: new InvalidMessageError("empty"),
    code: "BAD_REQUEST",
    status: 400,
  },
  MessageNonceReusedError: {
    error: new MessageNonceReusedError("message-1", "different_text"),
    code: "CONFLICT",
    status: 409,
  },
  InvalidRoutineScheduleError: {
    error: new InvalidRoutineScheduleError("invalid_cron", "the cron expression is invalid"),
    code: "BAD_REQUEST",
    status: 400,
  },
  McpServerUnavailableError: {
    error: new McpServerUnavailableError("timed_out", "the server did not answer"),
    code: "SERVICE_UNAVAILABLE",
    status: 503,
  },
  ComputerUnavailableError: {
    error: new ComputerUnavailableError("timed_out", "the supervisor did not answer"),
    code: "SERVICE_UNAVAILABLE",
    status: 503,
  },
  InvalidComputerPathError: {
    error: new InvalidComputerPathError("/etc/passwd"),
    code: "BAD_REQUEST",
    status: 400,
  },
  InvalidOAuthStateError: {
    error: new InvalidOAuthStateError("unknown_or_used"),
    code: "BAD_REQUEST",
    status: 400,
  },
  BotSecretDestinationError: {
    error: new BotSecretDestinationError("example_api"),
    code: "CONFLICT",
    status: 409,
  },
} satisfies {
  readonly [K in TypedErrorTag]: {
    readonly error: TypedError;
    readonly code: string;
    readonly status: number;
  };
};

describe("the mapping table is exhaustive", () => {
  it("has one row for every typed error and no row without one", () => {
    expect(Object.keys(errorMappings).sort()).toEqual(Object.keys(samples).sort());
  });

  it.each(Object.entries(samples))("maps %s to its declared code and status", (_tag, sample) => {
    const { error, report } = mapError(sample.error);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code: sample.code, status: sample.status, defined: false });
    expect(error.cause).toBeUndefined();
    expect(report).toEqual([]);
  });
});

describe("a mapped error inside a declared procedure", () => {
  it("carries the contract's status and message and reads as a typed error", () => {
    const { error } = mapError(new NotFoundError("bot", "bot-1"), {
      declaredFor: (code) =>
        code === "NOT_FOUND" ? { status: 404, message: "No such bot in this space" } : undefined,
    });

    expect(error).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
      defined: true,
      message: "No such bot in this space",
    });
  });

  it("falls back to the table's message when the procedure declares no entry", () => {
    const { error } = mapError(new LeaseLostError("run-1"), { declaredFor: () => undefined });

    expect(error).toMatchObject({
      code: "CONFLICT",
      status: 409,
      defined: false,
      message: errorMappings.LeaseLostError.message,
    });
  });
});

describe("an error that is already the transport envelope", () => {
  it("passes through untouched and reports nothing", () => {
    const declared = new ORPCError("SERVICE_UNAVAILABLE", {
      defined: true,
      status: 503,
      message: "The deployment's signup configuration is not readable",
    });

    const { error, report } = mapError(declared);

    expect(error).toBe(declared);
    expect(report).toEqual([]);
  });
});

describe("an unmapped defect", () => {
  it("answers 500 with a fixed message and never leaks the value to the client", () => {
    const secret = "sk-live-abc123";
    const defect = new Error(`service exploded with token=${secret}`);
    const { error, report } = mapError(defect);

    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      status: 500,
      defined: false,
      message: "The server failed to handle the request.",
    });
    expect(report).toEqual([defect]);

    // The client sees the envelope, never the defect: no message, no token, no
    // stack, and no nested cause.
    expect(error.cause).toBeUndefined();
    const envelope = JSON.stringify(error.toJSON());
    expect(envelope).not.toContain(secret);
    expect(envelope).not.toContain("service exploded");
    expect(envelope).not.toContain("stack");
    expect(envelope).not.toContain("cause");
  });

  it("leaves the report on the error for the boundary's redacted log", () => {
    const defect = new Error("boom");
    const { error } = mapError(defect);

    expect(boundaryReports(error)).toEqual([defect]);
  });
});

describe("boundaryReports", () => {
  it("is null for a value the table never mapped", () => {
    expect(boundaryReports(new Error("not mapped"))).toBeNull();
    expect(boundaryReports("not even an error")).toBeNull();
    expect(boundaryReports(null)).toBeNull();
  });

  it("is empty for a mapped error that is expected", () => {
    const { error } = mapError(new RunGoneError("run-1"));

    expect(boundaryReports(error)).toEqual([]);
  });
});

describe("mapping an Effect cause", () => {
  it("maps a typed failure and reports nothing", () => {
    const { error, report } = mapCause(Cause.fail(new LeaseLostError("run-1")));

    expect(error).toMatchObject({ code: "CONFLICT", status: 409 });
    expect(report).toEqual([]);
  });

  it("maps a typed failure even when the cause also holds a defect, and reports the defect", () => {
    const defect = new Error("a bug beside the failure");
    const cause = Cause.parallel(Cause.fail(new NotFoundError("bot", "bot-1")), Cause.die(defect));

    const { error, report } = mapCause(cause);

    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(report).toEqual([defect]);
  });

  it("uses the first mapped failure and still reports the failures that have no row", () => {
    const plain = new Error("plain, not typed");
    const cause = Cause.sequential(Cause.fail(plain), Cause.fail(new RunGoneError("run-1")));

    const { error, report } = mapCause(cause);

    expect(error).toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(report).toEqual([plain]);
  });

  it("answers an unmapped failure with 500 and reports the failure", () => {
    const failure = new Error("plain, not typed");
    const { error, report } = mapCause(Cause.fail(failure));

    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500 });
    expect(report).toEqual([failure]);
  });

  it("answers a defect with 500 and reports it", () => {
    const defect = new Error("a bug");
    const { error, report } = mapCause(Cause.die(defect));

    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500, defined: false });
    expect(report).toEqual([defect]);
  });

  it("answers an interruption as the client closing the request, and reports nothing", () => {
    const { error, report } = mapCause(Cause.interrupt(FiberId.none));

    expect(error).toMatchObject({ code: "CLIENT_CLOSED_REQUEST", status: 499 });
    expect(report).toEqual([]);
  });

  it("answers an empty cause with 500 and reports nothing", () => {
    const { error, report } = mapCause(Cause.empty);

    expect(error).toMatchObject({ code: "INTERNAL_SERVER_ERROR", status: 500 });
    expect(report).toEqual([]);
  });
});
