import type { ProviderFailureKind } from "@porkbot/adapter-kit";

/**
 * The shared computer failure classifier (slices 7.2 and 7.3, PRD decision 19).
 *
 * Each computer provider speaks a different wire, but the questions its
 * refusals answer are the same: is the machine itself gone, is a named thing
 * inside a healthy provider missing, was the caller's credential refused, is
 * the provider asking for backoff, did the call outrun its budget? This module
 * owns that translation once, so "the computer is gone" is a single decision
 * both providers reach rather than two tables that drift.
 *
 * A provider module supplies only what is genuinely its own: the words its
 * vendor uses (the `rules`), and the error classes it raises. The verdict is
 * provider-neutral — a kind from the shared vocabulary, or "unclassified",
 * which each adapter turns into its own protocol error because the vocabulary
 * has no "unknown" member and lifecycle code must not be handed a guessed
 * kind.
 *
 * The rules run in the order a refusal is most dangerous to misread:
 *
 *   1. a budget or a socket that never answered is `timed_out` — the state is
 *      unknown and must be re-read;
 *   2. the provider's own message rules, most specific first (a quota, then a
 *      refused credential, then "the machine is not there"), because a pull
 *      stream and a shared status carry no machine-readable kind;
 *   3. 401/403 is `auth_failed`, 429 is `rate_limited`;
 *   4. a 404 is `gone` when the subject is the machine or one of its commands
 *      and `not_found` when the subject is a named thing inside a healthy
 *      provider (an image, a network, an archive, a file);
 *   5. anything else is unclassified on purpose.
 */

/** Where the refusal was observed. The status and message are all it carries. */
export type ComputerFailureOrigin = "http" | "stream" | "transport" | "timeout" | "protocol";

/**
 * What the failed call was about. `machine` is the computer itself (a
 * container, a sandbox), `exec` is a command or an operation on one that must
 * exist, and `named` is a thing inside a healthy provider.
 */
export type ComputerFailureSubject = "machine" | "exec" | "named";

/** One vendor phrase and the kind it means. Providers order their own table. */
export interface ComputerFailureRule {
  readonly pattern: RegExp;
  readonly kind: ProviderFailureKind;
}

export interface ComputerFailureInput {
  readonly origin: ComputerFailureOrigin;
  readonly status?: number | undefined;
  /** The provider's own text; read here and nowhere else. */
  readonly message: string;
  readonly subject: ComputerFailureSubject;
  readonly rules: readonly ComputerFailureRule[];
}

export interface ComputerFailureVerdict {
  readonly kind: ProviderFailureKind;
  readonly status?: number | undefined;
}

/**
 * The one decision. `undefined` means the refusal is outside the shared
 * vocabulary and the calling adapter must raise its own protocol error.
 */
export function computerFailureKind(
  input: ComputerFailureInput,
): ComputerFailureVerdict | undefined {
  if (input.origin === "timeout" || input.origin === "transport") {
    return { kind: "timed_out" };
  }

  for (const rule of input.rules) {
    if (rule.pattern.test(input.message)) {
      return { kind: rule.kind, status: input.status };
    }
  }

  if (input.status === 401 || input.status === 403) {
    return { kind: "auth_failed", status: input.status };
  }

  if (input.status === 408) {
    // "Request Timeout" is the toolbox's answer when a command outran the
    // budget it was given, and it is a caller-fixable state, not a defect.
    return { kind: "timed_out", status: input.status };
  }

  if (input.status === 429) {
    return { kind: "rate_limited", status: input.status };
  }

  if (input.status === 404) {
    return {
      kind: input.subject === "named" ? "not_found" : "gone",
      status: input.status,
    };
  }

  return undefined;
}
