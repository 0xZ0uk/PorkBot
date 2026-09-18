import type { FailureMapping } from "./failures.ts";

/**
 * The storage seam (slice 7.7; stories 32, 33).
 *
 * Bot homes, message attachments, artifacts and backups are bytes that must
 * outlive a computer: with a remote computer provider the home is remote, so
 * this seam is also where "what is backed up" is stated per provider (see
 * `home-sync.ts`, which the provider plan is checked against). Two
 * implementations ship: local storage, so self-hosting needs no vendor and no
 * network at all, and an S3-compatible one for deployments that already have
 * object storage. Both are conformance-tested against the same suite, and no
 * feature requires the S3 implementation to work.
 *
 * Bodies are `AsyncIterable<Uint8Array>` rather than strings so a large
 * artifact streams instead of buffering in memory; a partially uploaded object
 * is never visible, so a failed transfer leaves the previous revision intact.
 * S3 credentials resolve through `CredentialStore` like every other provider
 * key and never appear in a request at this seam.
 *
 * Keys are the seam's addressing, never a filesystem path: a key is a relative,
 * slash-separated name whose segments are non-empty and never `.` or `..`, at
 * most 1024 bytes, with no backslash. A key that breaks those rules is a caller
 * bug and is refused before any store is touched, which is what makes the same
 * key valid in a directory and in a bucket.
 *
 * Failure mapping: a provider raises an error that implements
 * `ProviderFailure`, classified by the `failureMapping` table below. Backup
 * tooling reads through this interface, not a filesystem path, so a failed
 * store is reported in the shared vocabulary wherever the tool runs.
 */

export interface StorageObject {
  readonly key: string;
  readonly size: number;
  readonly contentType?: string;
  /** Last write time, ISO 8601. */
  readonly lastModified: string;
}

export interface StoragePutRequest {
  readonly key: string;
  readonly body: AsyncIterable<Uint8Array>;
  readonly contentType?: string;
}

export interface StorageBody {
  readonly object: StorageObject;
  readonly body: AsyncIterable<Uint8Array>;
}

export interface StorageProvider {
  /** Write an object atomically: readers see the previous revision or the new one, never a partial. */
  put(request: StoragePutRequest): Promise<StorageObject>;
  /** No object at the key is `undefined`, not a failure. */
  get(key: string): Promise<StorageBody | undefined>;
  /**
   * Delete an object. `true` means the key is gone afterwards; `false` is the
   * best-effort answer "there was nothing to delete", which an S3-compatible
   * store cannot give because its delete is idempotent.
   */
  delete(key: string): Promise<boolean>;
  /** Objects whose key starts with `prefix`, in UTF-8 byte order; no matches is `[]`. */
  list(prefix: string): Promise<readonly StorageObject[]>;
}

export const failureMapping: FailureMapping = {
  gone: "The storage location itself is gone (a deleted bucket, an unmounted volume); an operator fault, surfaced rather than retried.",
  not_found:
    "No object exists at the key; a read answers `undefined` instead of raising, and delete reports an absent key only where the store can tell — an S3-compatible delete is idempotent and answers `true`.",
  rate_limited:
    "An S3-compatible provider refuses or fails a transfer transiently (HTTP 429, `SlowDown`, or a 5xx); retried with backoff. Local storage reads and writes a disk and does not produce it.",
  timed_out:
    "A transfer exceeded its budget; the partial upload is aborted and stays invisible, and a read that was cut off raises rather than returning truncated bytes.",
  auth_failed:
    "S3 credentials are missing or refused (403); fail closed and surface it to the operator.",
};
