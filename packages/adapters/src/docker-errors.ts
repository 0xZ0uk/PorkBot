import { isProviderFailure } from "@porkbot/adapter-kit";
import type { ProviderFailureKind } from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";
import { DockerEngineError } from "./docker-engine.ts";

/**
 * The Docker failure classifier (slice 7.2, PRD decision 19).
 *
 * This is the one module allowed to read a Docker error. The Engine API
 * answers a refusal with an HTTP status, a JSON `code` and a human message
 * whose wording is not part of any contract, and the vocabulary lifecycle code
 * branches on has exactly five members: `gone`, `not_found`, `rate_limited`,
 * `timed_out`, `auth_failed`. So the translation from Docker's words to those
 * five lives here, beside the table below, and nowhere else: the provider in
 * `docker-computer.ts` calls `classifyDockerFailure` and never inspects a
 * status or a message itself. `docker-failure.call-sites.test.ts` scans the
 * shipped sources and fails when that rule is broken.
 *
 * What each Docker state becomes:
 *
 *   - `gone`        the daemon no longer has the container (`404 No such
 *                   container`, `409 ... is not running` when a command or a
 *                   stop targets a parked machine)
 *   - `not_found`   a named image, network or archive path does not exist,
 *                   while the daemon itself is fine
 *   - `rate_limited` the registry or the daemon refused the call for now (HTTP
 *                   429, `toomanyrequests`, a pull stream that says the limit
 *                   was reached)
 *   - `timed_out`   the daemon did not answer inside the caller's budget, or
 *                   the socket could not be reached at all; the machine's
 *                   state is unknown and must be re-read before reuse
 *   - `auth_failed` the daemon or the registry refused the credential (HTTP
 *                   401/403, `unauthorized`, `pull access denied`); fail
 *                   closed and never retry the same credential
 *
 * Anything else — a `409 Conflict`, a `500` that names no known condition, a
 * malformed answer — stays a `DockerProtocolError`, deliberately outside the
 * shared vocabulary. "Unknown" is not a sixth kind: an error this table cannot
 * classify is an adapter bug or an operator problem, and lifecycle code must
 * not be handed a guessed classification.
 *
 * The pull path is special and the comment above the stream rules explains it:
 * the daemon answers `POST /images/create` with `200 OK` and reports the
 * refusal inside the streamed body, so a registry refusal reaches this table
 * with an origin of `stream` and no HTTP status.
 */

/** Where the error came from; the classifier reads no other field. */
export type DockerFailureOrigin = "http" | "stream" | "transport" | "timeout" | "protocol";

/**
 * What the failed call was about, so a bare `404` can be told apart: a missing
 * container is `gone`, a missing image, network or archive is `not_found`.
 */
export type DockerFailureSubject =
  "container" | "image" | "network" | "archive" | "exec" | "daemon";

/**
 * A refusal the classifier could not translate. It is deliberately not a
 * `ProviderFailure`: the shared vocabulary has no "unknown" member, and a
 * lifecycle branch on a guessed kind is the bug this module exists to prevent.
 * The daemon's own message is embedded because an operator has to see it; it is
 * never returned to a client, only logged by the API's redacted error line.
 */
export class DockerProtocolError extends Error {
  readonly status: number | undefined;

  constructor(detail: string, options?: ErrorOptions) {
    super(`Docker protocol error: ${detail}`, options);
    this.name = "DockerProtocolError";
  }
}

/**
 * The daemon's own words, checked in order. The status rules run first; these
 * catch the conditions Docker reports with a status it shares with unrelated
 * errors (a pull stream has no status at all, a `500` carries everything from a
 * missing image to a registry quota).
 */
const messageRules: readonly { readonly pattern: RegExp; readonly kind: ProviderFailureKind }[] = [
  // A quota is a retry-later condition, and its wording ("toomanyrequests",
  // "rate limit exceeded") is the only signal the registry gives.
  { pattern: /toomanyrequests|rate ?limit/i, kind: "rate_limited" },
  // Credentials first: "pull access denied" is also the answer to a repository
  // that does not exist, and the safe reading is the one that never retries.
  {
    pattern:
      /unauthorized|authentication required|pull access denied|no basic auth|denied: request/i,
    kind: "auth_failed",
  },
  // The machine the call named is no longer there.
  { pattern: /no such container|is not running|container .* not found/i, kind: "gone" },
  // A named thing inside a healthy daemon is missing.
  {
    pattern:
      /no such image|no such network|no such volume|manifest unknown|manifest for .* not found|repository .* not found|could not find the file/i,
    kind: "not_found",
  },
];

/** The detail every classification carries; operator-safe and credential-free. */
const originWord: Record<DockerFailureOrigin, string> = {
  http: "the Docker daemon refused the request",
  stream: "the registry refused the pull",
  transport: "the Docker daemon could not be reached",
  timeout: "the Docker daemon did not answer in time",
  protocol: "the Docker daemon answered with something unexpected",
};

function classified(subject: DockerFailureSubject, why: string): string {
  return `${why} (${subject})`;
}

/**
 * Translates anything a Docker call threw into the shared vocabulary. A value
 * that is already a `ProviderFailure` passes through with its kind intact, so
 * a caller can wrap this at any depth.
 */
export function classifyDockerFailure(
  error: unknown,
  subject: DockerFailureSubject,
): ComputerProviderError | DockerProtocolError {
  if (isProviderFailure(error)) {
    const detail =
      typeof error.detail === "string" && error.detail.trim() !== "" ? error.detail : undefined;

    return new ComputerProviderError(
      error.kind,
      detail ?? "the provider refused the call",
      undefined,
      {
        cause: error,
      },
    );
  }

  if (!(error instanceof DockerEngineError)) {
    return new DockerProtocolError(
      `${originWord.protocol} (${subject}) and the error is not a Docker engine error`,
      { cause: error },
    );
  }

  const origin = error.origin;

  if (origin === "timeout") {
    return new ComputerProviderError(
      "timed_out",
      classified(subject, originWord.timeout),
      undefined,
      {
        cause: error,
      },
    );
  }

  if (origin === "transport") {
    // An unreachable daemon is not a retryable provider state: the shared
    // vocabulary has no "unreachable", and `timed_out` is the word that makes
    // the caller re-read the machine's state before reuse.
    return new ComputerProviderError(
      "timed_out",
      classified(subject, originWord.transport),
      undefined,
      {
        cause: error,
      },
    );
  }

  const message = error.daemonMessage ?? "";

  for (const rule of messageRules) {
    if (rule.pattern.test(message)) {
      return new ComputerProviderError(
        rule.kind,
        classified(subject, originWord[origin]),
        error.status,
        {
          cause: error,
        },
      );
    }
  }

  if (error.status === 401 || error.status === 403) {
    return new ComputerProviderError(
      "auth_failed",
      classified(subject, originWord[origin]),
      error.status,
      { cause: error },
    );
  }

  if (error.status === 429) {
    return new ComputerProviderError(
      "rate_limited",
      classified(subject, originWord[origin]),
      error.status,
      { cause: error },
    );
  }

  if (error.status === 404) {
    const kind: ProviderFailureKind =
      subject === "container" || subject === "exec" ? "gone" : "not_found";

    return new ComputerProviderError(kind, classified(subject, originWord[origin]), error.status, {
      cause: error,
    });
  }

  return new DockerProtocolError(
    `${originWord[origin]} with status ${String(error.status ?? "none")} and no known classification (${subject}): ${message}`,
    { cause: error },
  );
}
