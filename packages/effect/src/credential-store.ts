import type { CredentialStore } from "@porkbot/adapter-kit";

/**
 * The durable half of stored credentials (slice 9.1, PRD decision 10; stories
 * 14 and 15).
 *
 * The narrow provider seam in `@porkbot/adapter-kit` answers one question —
 * "what is the value of this name?" — and every adapter asks it. This seam is
 * the operator's side of the same rows: list what is stored, write a value,
 * and rotate the keys the values are encrypted under. It extends
 * `CredentialStore`, so the object `@porkbot/db` builds satisfies both the
 * provider seam and the operator surface without a second implementation or a
 * wrapper that could drift.
 *
 * `@porkbot/db` implements this in one module over the encrypted credential
 * rows — the only module that names them, proven by the call-site suite beside
 * it. The factory splits by actor as the memory and notification stores do:
 *
 *   - A `UserActor` receives `Credentials`: the operator lists the actor's
 *     space, writes a value, resolves one by name and rotates the space's rows.
 *   - A `SystemActor` receives only `CredentialStore`: a job resolves by name
 *     through its payload's space and never enumerates or writes.
 *
 * Every read decrypts and every write encrypts; the value never crosses the
 * seam unmasked except through `resolve`, which is the one question the
 * provider seam exists to answer. A store without a keyring answers nothing:
 * every call raises the typed `CredentialStoreError` with reason `locked`
 * rather than returning a value it could not authenticate.
 */

/**
 * One stored credential as a list may show it: the name it resolves under, the
 * row's timestamps, and a display mask derived from the value. There is no
 * field that can carry the value or its ciphertext, so a list response cannot
 * grow one by accident.
 */
export interface CredentialSummary {
  readonly id: string;
  /** The name an adapter resolves, e.g. `model-key`. */
  readonly name: string;
  /**
   * A display-only mask such as `••••4f2a`. It is derived, not stored: the
   * store decrypts to compute it, and the store never returns more than the
   * last few characters.
   */
  readonly maskedValue: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * The outcome of one rotation pass. `reencrypted` counts rows that were
 * re-encrypted under the active key and `total` everything the pass examined,
 * so an operator can see a partially migrated space at a glance.
 */
export interface CredentialRotation {
  readonly activeKeyId: string;
  readonly reencrypted: number;
  readonly total: number;
}

/**
 * The operator's half: the actor's space, read and written.
 *
 * `list` decrypts each row to build its mask and returns only summaries;
 * `store` encrypts and upserts on `(space, name)`; `rotate` re-encrypts every
 * row still under an older key with the active one. Rotation is idempotent and
 * per row, so it can run while requests are served: until a row is rewritten
 * the old key stays in the keyring and the row still decrypts.
 */
export interface Credentials extends CredentialStore {
  list(): Promise<readonly CredentialSummary[]>;
  /**
   * Encrypts and stores the value under `name`, replacing the value already
   * held. Returns the summary, never the value.
   */
  store(name: string, value: string): Promise<CredentialSummary>;
  /** Re-encrypts every row not on the active key. */
  rotate(): Promise<CredentialRotation>;
}
