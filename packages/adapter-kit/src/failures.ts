/**
 * The shared provider failure vocabulary (PRD decision 19).
 *
 * Every adapter translates its own errors — HTTP statuses, SDK exception
 * classes, provider-specific message strings — into one of the five kinds below
 * before a failure crosses the adapter boundary, and lifecycle code branches on
 * the kind. That is what keeps retry, approval, notification and run
 * transitions free of provider names: the decision "back off" is made from
 * `rate_limited` without knowing which vendor produced it.
 *
 * The vocabulary is closed on purpose. "Unknown" is not a sixth member: an
 * error an adapter cannot classify is a bug in that adapter, and the conformance
 * suite fails on it rather than letting lifecycle code guess. Each seam ships a
 * `FailureMapping` beside its interface saying how its own provider errors
 * become these kinds, and the plan test in this package fails when a seam's
 * mapping leaves a kind undocumented.
 *
 * The words mean:
 *
 *   gone          the resource the provider owned no longer exists; a retry on
 *                 the same handle cannot succeed, and re-provisioning may
 *   not_found     a request named something that does not exist, while the
 *                 provider itself is fine
 *   rate_limited  the provider is refusing work for now; backing off is the
 *                 only correct response
 *   timed_out     the provider did not answer inside the caller's budget
 *   auth_failed   the credential is missing, refused or no longer valid
 */

export const PROVIDER_FAILURE_KINDS = [
  "gone",
  "not_found",
  "rate_limited",
  "timed_out",
  "auth_failed",
] as const;

export type ProviderFailureKind = (typeof PROVIDER_FAILURE_KINDS)[number];

/**
 * A classified provider failure as it crosses the adapter boundary. `kind` is
 * the decision input; `detail` is operator-facing context that is safe to log.
 *
 * `detail` is never a credential and never a raw provider response body: a
 * provider is free to echo the key it just rejected, so the adapter decides
 * what is safe to say and says only that. An adapter raises a failure as a
 * thrown `Error` that implements this interface, so callers can log the stack
 * while reading the classification from `kind`.
 */
export interface ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly detail?: string;
}

/** One line per kind: how a seam turns its own provider errors into the words. */
export type FailureMapping = Readonly<Record<ProviderFailureKind, string>>;
