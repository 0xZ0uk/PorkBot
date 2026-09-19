import { isProviderFailure } from "@porkbot/adapter-kit";
import { computerFailureKind } from "./computer-failure.ts";
import type { ComputerFailureRule, ComputerFailureSubject } from "./computer-failure.ts";
import { ComputerProviderError } from "./computer-errors.ts";
import { DaytonaEngineError } from "./daytona-engine.ts";

/**
 * The Daytona failure classifier (slice 7.3, PRD decision 19).
 *
 * The one module allowed to read a Daytona status or message. The control
 * plane answers refusals with an HTTP status, a `code` and a human message,
 * and the toolbox answers a command that outran its budget with a `408`;
 * this table translates all of them into the shared vocabulary — `gone`,
 * `not_found`, `rate_limited`, `timed_out`, `auth_failed` — so lifecycle code
 * never reads a vendor string or an SDK error class.
 *
 * The decision itself (which status means which kind, and that a missing
 * sandbox is `gone` while a missing file is `not_found`) is the same
 * implementation the Docker classifier uses, in `computer-failure.ts`. What
 * lives here is Daytona's vocabulary and `DaytonaProtocolError`, the
 * deliberately unclassified answer: the shared vocabulary has no "unknown"
 * member, and a lifecycle branch on a guessed kind is the bug this module
 * exists to prevent.
 *
 * `error.providerMessage` is embedded in a protocol error because an operator
 * has to see it; it is never returned to a client, only logged by the API's
 * redacted error line.
 */

/**
 * What the failed call was about: the sandbox itself, a command running in
 * one, or a named file inside one.
 */
export type DaytonaFailureSubject = "sandbox" | "command" | "file" | "archive";

/** A refusal the classifier could not translate, for the reason above. */
export class DaytonaProtocolError extends Error {
  readonly status: number | undefined;

  constructor(detail: string, options?: ErrorOptions) {
    super(`Daytona protocol error: ${detail}`, options);
    this.name = "DaytonaProtocolError";
  }
}

/**
 * Daytona's own words, checked in order. The status rules run first; these
 * catch the conditions the service reports with a status it shares with
 * unrelated errors (the toolbox answers a bad command and a dead sandbox with
 * different statuses, and a control-plane state is not always a status at
 * all).
 */
const messageRules: readonly ComputerFailureRule[] = [
  { pattern: /rate ?limit|too many requests|quota exceeded/i, kind: "rate_limited" },
  { pattern: /unauthorized|invalid api key|authentication failed|forbidden/i, kind: "auth_failed" },
  // A sandbox that is stopped, paused, archived or mid-transition is not a
  // live machine the caller can command; the state is re-read, not guessed.
  {
    pattern:
      /not running|is stopped|sandbox (?:is )?(?:stopped|paused|archived)|already (?:stopped|paused|deleted)|no such sandbox|sandbox not found/i,
    kind: "gone",
  },
  { pattern: /\btimed? ?out\b|deadline exceeded|exceeded its .*timeout/i, kind: "timed_out" },
];

const originWord: Record<DaytonaEngineError["origin"], string> = {
  http: "the Daytona control plane refused the request",
  transport: "the Daytona service could not be reached",
  timeout: "the Daytona service did not answer in time",
  protocol: "the Daytona service answered with something unexpected",
};

const sharedSubject: Record<DaytonaFailureSubject, ComputerFailureSubject> = {
  sandbox: "machine",
  command: "exec",
  file: "named",
  archive: "named",
};

function classified(subject: DaytonaFailureSubject, why: string): string {
  return `${why} (${subject})`;
}

/**
 * Translates anything a Daytona call threw into the shared vocabulary. A value
 * that is already a `ProviderFailure` passes through with its kind intact, so
 * a caller can wrap this at any depth.
 */
export function classifyDaytonaFailure(
  error: unknown,
  subject: DaytonaFailureSubject,
): ComputerProviderError | DaytonaProtocolError {
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

  if (!(error instanceof DaytonaEngineError)) {
    return new DaytonaProtocolError(
      `${originWord.protocol} (${subject}) and the error is not a Daytona engine error`,
      { cause: error },
    );
  }

  const origin = error.origin;
  const message = error.providerMessage ?? "";
  const verdict = computerFailureKind({
    origin,
    status: error.status,
    message,
    subject: sharedSubject[subject],
    rules: messageRules,
  });

  if (verdict === undefined) {
    return new DaytonaProtocolError(
      `${originWord[origin]} with status ${String(error.status ?? "none")} and no known classification (${subject}): ${message}`,
      { cause: error },
    );
  }

  const detail = classified(subject, originWord[origin]);

  return new ComputerProviderError(verdict.kind, detail, verdict.status, { cause: error });
}
