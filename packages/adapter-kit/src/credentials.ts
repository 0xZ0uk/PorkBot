import type { FailureMapping } from "./failures.ts";

/**
 * The credential seam (PRD decision 29: providers hold secrets server-side).
 *
 * An adapter never reads `process.env`, a file or a vault directly: it asks a
 * store for one named secret. That keeps "where this deployment keeps its
 * secrets" a composition decision — the environment for a local bootstrap, a
 * mounted file, or the encrypted credential table slice 9.1 adds — instead of a
 * hard-coded read inside provider code. It also makes rotation a property of the
 * store rather than of every adapter: a provider re-resolves on each use.
 *
 * A store returns `undefined` for a name it does not hold; it never invents a
 * value, never logs one, and never includes one in an error. The adapter that
 * asked turns `undefined` into its own typed, fail-closed configuration error,
 * because "no credential" is a deployment fault the operator must see, not an
 * empty string a transport should try.
 */
export interface CredentialStore {
  resolve(name: string): Promise<string | undefined>;
}

/**
 * Failure mapping: a store failure is never folded into `undefined`, because
 * `undefined` is the deliberate answer "this deployment does not hold that
 * name". A backend that cannot be read fails closed and loudly instead, so a
 * transient fault cannot silently disable a provider the operator configured.
 */
export const failureMapping: FailureMapping = {
  gone: "Not produced: the store owns no per-credential resource, and a deleted credential resolves as `undefined` like any other name it does not hold.",
  not_found:
    "`resolve` answers `undefined`; the adapter that asked turns that into its own fail-closed missing-configuration error.",
  rate_limited:
    "Not produced by the planned implementations: the environment, memory and encrypted stores read locally.",
  timed_out:
    "A backend read exceeded its budget and raises; it never resolves `undefined`, so a slow store cannot look like a missing secret.",
  auth_failed:
    "The store cannot unlock itself (for example a missing encryption key) and raises; fail closed rather than reading past it.",
};
