import { describe, expect, it } from "vitest";
import {
  ApprovalStoreError,
  BlockedUrlError,
  CredentialMissingError,
  DeploymentSettingsConflictError,
  GateTimeoutError,
  LeaseLostError,
  NameConflictError,
  NotFoundError,
  RunGoneError,
} from "./errors.ts";

describe("the typed not-found error", () => {
  it("names the resource and the id the caller asked for", () => {
    const error = new NotFoundError("bot", "bot-1");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("NotFoundError");
    expect(error._tag).toBe("NotFoundError");
    expect(error.resource).toBe("bot");
    expect(error.id).toBe("bot-1");
    expect(error.message).toBe("bot bot-1 was not found");
  });
});

describe("the typed name-conflict error", () => {
  it("names the resource and the taken name the caller supplied", () => {
    const error = new NameConflictError("bot section", "Research");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(NameConflictError);
    expect(error._tag).toBe("NameConflictError");
    expect(error.resource).toBe("bot section");
    expect(error.name).toBe("Research");
    expect(error.message).toBe('a bot section named "Research" already exists');
  });
});

describe("the typed run-gone error", () => {
  it("names the run that no longer exists", () => {
    const error = new RunGoneError("run-1");

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("RunGoneError");
    expect(error.runId).toBe("run-1");
    expect(error.message).toContain("run-1");
    expect(error.message).toContain("no longer exists");
  });
});

describe("the typed lease-lost error", () => {
  it("names the run whose lease moved to another worker", () => {
    const error = new LeaseLostError("run-1");

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("LeaseLostError");
    expect(error.runId).toBe("run-1");
    expect(error.message).toContain("run-1");
    expect(error.message).toContain("lost");
  });
});

describe("the typed gate-timeout error", () => {
  it("names the tool call whose approval ran out of time", () => {
    const error = new GateTimeoutError("call-1");

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("GateTimeoutError");
    expect(error.callId).toBe("call-1");
    expect(error.message).toContain("call-1");
    expect(error.message).toContain("timed out");
  });
});

describe("the typed approval-store error", () => {
  it("names the operation that could not be completed", () => {
    const error = new ApprovalStoreError("time_out");

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("ApprovalStoreError");
    expect(error.operation).toBe("time_out");
    expect(error.message).toBe("the approval store could not time out the approval");
  });
});

describe("the typed credential-missing error", () => {
  it("names the credential without carrying a value", () => {
    const error = new CredentialMissingError("transactional-mail-api-key");

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("CredentialMissingError");
    expect(error.credentialName).toBe("transactional-mail-api-key");
    expect(error.message).toContain("transactional-mail-api-key");
    expect(error.message).toContain("not configured");
  });
});

describe("the typed deployment-settings conflict", () => {
  it("names the row count and how to resolve it", () => {
    const error = new DeploymentSettingsConflictError(2);

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("DeploymentSettingsConflictError");
    expect(error.rows).toBe(2);
    expect(error.message).toContain("2 rows");
    expect(error.message).toContain("exactly one");
  });
});

describe("the typed blocked-url error", () => {
  it("carries the reason, the host and the address without carrying the URL", () => {
    const error = new BlockedUrlError("blocked_address", "example.com", "127.0.0.1");

    expect(error).toBeInstanceOf(Error);
    expect(error._tag).toBe("BlockedUrlError");
    expect(error.reason).toBe("blocked_address");
    expect(error.host).toBe("example.com");
    expect(error.address).toBe("127.0.0.1");
    expect(error.message).toContain("example.com");
    expect(error.message).toContain("127.0.0.1");
    expect(error.message).not.toContain("https://");
  });
});
