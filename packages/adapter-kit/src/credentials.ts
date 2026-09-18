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
