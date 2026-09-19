import type { BotSecretAuth, BotSecretDestination, BotSecretStatus } from "@porkbot/core";
import type { CredentialRotation } from "./credential-store.ts";

/**
 * Bot secrets, the seam between the durable rows and the two callers that may
 * touch them (slice 9.6, E9 epic; reference parity BotSecret and
 * `request_secret` / `list_secrets` / `forget_secret`).
 *
 * A bot secret belongs to one bot: a value, the one HTTPS origin it may be sent
 * to, and how it authenticates. The durable half lives in `@porkbot/db`, in one
 * module over the bot secret rows — the only module that names them, proven
 * by the call-site suite beside it — and it is the only code that decrypts a
 * value. Three actor-scoped shapes are cut from that module:
 *
 *   - `BotSecrets` is the operator's half: list, put a value beside its
 *     destination, forget one, and rotate the keyring. A list answer carries
 *     the destination and a status, never a value or a value-derived mask.
 *   - `BotSecretRequests` is the run's half: the metadata the agent's tools may
 *     read and the forget they may perform. It deliberately has no method that
 *     returns a value, so "the model never reads a secret" is a property of the
 *     type rather than a promise about a handler.
 *   - `BotSecretResolver` is the one method that does return a value, and only
 *     the run's credential-proxy composition calls it. The value becomes a
 *     request header inside the proxy handle and is never returned to a tool.
 *
 * `request` — the metadata an ask records — is deliberately not a store
 * method: the agent's ask is a durable approval row, and the operator's answer
 * is what writes a value. A row with a null envelope is a forgotten secret.
 */

/** One row as any list may show it: its destination and whether a value is held. */
export interface BotSecretSummary {
  /** The name an ask, a list and a proxy upstream are addressed by. */
  readonly name: string;
  /** `stored` when a value is held; `forgotten` when it was cleared. */
  readonly status: BotSecretStatus;
  /** The bare HTTPS origin this value may be sent to, and no other. */
  readonly origin: string;
  /** How the value authenticates at that origin. */
  readonly auth: BotSecretAuth;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * A resolved destination and its value. The value is the only shape in which a
 * secret crosses this seam unmasked, and only `BotSecretResolver` returns it.
 */
export interface BotSecretValue {
  readonly destination: BotSecretDestination;
  readonly value: string;
}

/** The reads both halves share; neither returns a value. */
export interface BotSecretReader {
  list(botId: string): Promise<readonly BotSecretSummary[]>;
  find(botId: string, name: string): Promise<BotSecretSummary | undefined>;
}

/**
 * The run's half. Every call is scoped to the actor's space and to the named
 * bot; a foreign bot is the shared not-found rather than an empty answer.
 * Nothing here returns a value.
 */
export interface BotSecretRequests extends BotSecretReader {
  /**
   * Clears the value and marks the row forgotten. Immediate in the only way
   * that matters: the ciphertext is gone before the call returns, so every
   * later resolve answers nothing. Idempotent — a name no row holds is a
   * no-op answer rather than an error.
   */
  forget(botId: string, name: string): Promise<{ readonly removed: boolean }>;
}

/**
 * The server-side resolver. Only the run's credential-proxy handle calls it,
 * and its answer is turned into a header inside that handle; no tool option
 * carries this interface.
 */
export interface BotSecretResolver {
  resolve(botId: string, name: string): Promise<BotSecretValue | undefined>;
}

/** The operator's half: the settings surface's list, write, forget and rotate. */
export interface BotSecrets extends BotSecretReader {
  /**
   * Encrypts and stores the value under the destination's name. A destination
   * that disagrees with a value already held is refused rather than silently
   * re-pointed: the value is bound to the origin the operator stored it for.
   */
  put(botId: string, destination: BotSecretDestination, value: string): Promise<BotSecretSummary>;
  /** The operator's forget; the same immediate clear the run's tool performs. */
  forget(botId: string, name: string): Promise<{ readonly removed: boolean }>;
  /** Re-encrypts every held value not on the active key. */
  rotate(): Promise<CredentialRotation>;
}
