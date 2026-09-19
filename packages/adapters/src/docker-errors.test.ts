import { isProviderFailure, PROVIDER_FAILURE_KINDS } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { ComputerProviderError } from "./computer-errors.ts";
import { classifyDockerFailure, DockerProtocolError } from "./docker-errors.ts";
import type { DockerFailureSubject } from "./docker-errors.ts";
import { DockerEngineError } from "./docker-engine.ts";

/**
 * The Docker failure classifier (slice 7.2, PRD decision 19). The table below
 * is the contract: every Docker condition the provider can meet maps onto one
 * of the five shared kinds, an already-classified failure passes through, and
 * a condition with no known meaning stays a protocol error rather than
 * becoming a guessed kind. The provider's own suite drives these through the
 * seam; this one pins the mapping itself, condition by condition.
 */

function http(status: number, message = ""): DockerEngineError {
  return new DockerEngineError("http", "the daemon refused the call", {
    status,
    daemonMessage: message,
  });
}

function streamed(message: string): DockerEngineError {
  return new DockerEngineError("stream", "the registry refused the pull", {
    daemonMessage: message,
  });
}

function kindOf(error: DockerEngineError, subject: DockerFailureSubject): string {
  const classified = classifyDockerFailure(error, subject);

  if (!isProviderFailure(classified)) {
    throw new Error(`expected a ProviderFailure for ${String(error)}`);
  }

  return classified.kind;
}

describe("the Docker failure classifier", () => {
  it("classifies a container the daemon no longer holds as gone", () => {
    expect(kindOf(http(404, "No such container: abc"), "container")).toBe("gone");
    expect(kindOf(http(409, "Container abc is not running"), "container")).toBe("gone");
    expect(kindOf(http(409, "Container abc is not running"), "exec")).toBe("gone");
  });

  it("classifies a named thing inside a healthy daemon as not_found", () => {
    expect(kindOf(http(404, "No such image: node:24"), "image")).toBe("not_found");
    expect(kindOf(http(404, "network porkbot-bot-x not found"), "network")).toBe("not_found");
    expect(
      kindOf(http(404, "Could not find the file /home/agent in container abc"), "archive"),
    ).toBe("not_found");
    expect(kindOf(http(500, "No such image: node:24"), "image")).toBe("not_found");
  });

  it("classifies a quota as rate_limited wherever the registry says it", () => {
    expect(kindOf(http(429, ""), "image")).toBe("rate_limited");
    expect(
      kindOf(streamed("toomanyrequests: You have reached your pull rate limit"), "image"),
    ).toBe("rate_limited");
  });

  it("classifies a refused credential as auth_failed, including a refused pull", () => {
    expect(kindOf(http(401, ""), "image")).toBe("auth_failed");
    expect(kindOf(http(403, ""), "container")).toBe("auth_failed");
    expect(kindOf(http(500, "pull access denied for private/image"), "image")).toBe("auth_failed");
    expect(kindOf(streamed("unauthorized: authentication required"), "image")).toBe("auth_failed");
  });

  it("classifies an unanswered daemon or an expired budget as timed_out", () => {
    expect(kindOf(new DockerEngineError("timeout", "the call expired"), "container")).toBe(
      "timed_out",
    );
    expect(kindOf(new DockerEngineError("transport", "the socket refused"), "container")).toBe(
      "timed_out",
    );
  });

  it("tells an expected failure apart from an unknown one", () => {
    for (const kind of PROVIDER_FAILURE_KINDS) {
      const classified = classifyDockerFailure(
        new ComputerProviderError(kind, "already classified"),
        "container",
      );

      expect(isProviderFailure(classified)).toBe(true);
      expect((classified as ComputerProviderError).kind).toBe(kind);
    }

    const unknown = classifyDockerFailure(http(500, "the daemon fell over"), "container");

    expect(unknown).toBeInstanceOf(DockerProtocolError);
    expect(isProviderFailure(unknown)).toBe(false);

    const notAnEngineError = classifyDockerFailure(new Error("plain"), "container");

    expect(notAnEngineError).toBeInstanceOf(DockerProtocolError);
  });
});
