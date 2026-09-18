import type { ProviderFailure, ProviderFailureKind } from "@porkbot/adapter-kit";

/**
 * The typed failures the storage implementations raise.
 *
 * A configuration error is operator-facing: it names the setting that is wrong
 * and says what to do, and it never carries a credential. A provider failure
 * implements `ProviderFailure`, so lifecycle code branches on the kind and
 * never on a status line or a vendor message; `detail` is written to be safe in
 * a log and never echoes a provider body.
 *
 * A key that breaks the seam's key rules is neither: it is a caller bug, and
 * `StorageKeyError` says so before any store is touched.
 */

export type StorageConfigurationReason =
  /** The setting was not provided at all. */
  | "missing"
  /** The setting was provided but cannot be used. */
  | "invalid"
  /** The provider refused the configured credential. */
  | "rejected";

const reasonWords: Record<StorageConfigurationReason, string> = {
  missing: "is not configured",
  invalid: "is not valid",
  rejected: "was refused by the provider",
};

export class StorageConfigurationError extends Error {
  /** Which operator setting is wrong: `endpoint`, `bucket`, `region`, `credential`, `timeoutMs` or `root`. */
  readonly setting: string;
  readonly reason: StorageConfigurationReason;

  constructor(setting: string, reason: StorageConfigurationReason, guidance: string) {
    super(`Storage configuration: ${setting} ${reasonWords[reason]}. ${guidance}`);
    this.name = "StorageConfigurationError";
    this.setting = setting;
    this.reason = reason;
  }
}

/** A misuse of the storage seam: the key is not an address the seam accepts. */
export class StorageKeyError extends Error {
  constructor(guidance: string) {
    super(`Storage key rejected. ${guidance}`);
    this.name = "StorageKeyError";
  }
}

/** A storage provider failure translated into the shared lifecycle vocabulary. */
export class StorageProviderError extends Error implements ProviderFailure {
  readonly kind: ProviderFailureKind;
  readonly detail: string;
  readonly status: number | undefined;

  constructor(kind: ProviderFailureKind, detail: string, status?: number, options?: ErrorOptions) {
    super(`Storage provider failed (${kind}): ${detail}`, options);
    this.name = "StorageProviderError";
    this.kind = kind;
    this.detail = detail;
    this.status = status;
  }
}

/**
 * A response the adapter cannot classify: a defect in the adapter, not a
 * provider state. It is deliberately not a `ProviderFailure`, because the
 * shared vocabulary has no "unknown" member and lifecycle code must not be
 * handed a guessed kind.
 */
export class StorageProtocolError extends Error {
  readonly status: number | undefined;

  constructor(detail: string, status?: number, options?: ErrorOptions) {
    super(`Storage protocol error: ${detail}`, options);
    this.name = "StorageProtocolError";
    this.status = status;
  }
}
