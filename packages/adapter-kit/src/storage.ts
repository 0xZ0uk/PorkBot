import type { FailureMapping } from "./failures.ts";

/**
 * The storage seam (slice 7.7; stories 32, 33).
 *
 * Bot homes, message attachments, artifacts and backups are bytes that must
 * outlive a computer: with a remote computer provider the home is remote, so
 * this seam is also where "what is backed up" is stated per provider. Two
 * implementations ship: local storage, so self-hosting needs no vendor, and an
 * S3-compatible one for deployments that already have object storage. Both are
 * conformance-tested against the same suite, and no feature requires the S3
 * implementation to work.
 *
 * Bodies are `AsyncIterable<Uint8Array>` rather than strings so a large
 * artifact streams instead of buffering in memory; a partially uploaded object
 * is never visible, so a failed transfer leaves the previous revision intact.
 * S3 credentials resolve through `CredentialStore` like every other provider
 * key and never appear in a request at this seam.
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
  /** Delete an object; `false` means there was nothing to delete. */
  delete(key: string): Promise<boolean>;
  list(prefix: string): Promise<readonly StorageObject[]>;
}

export const failureMapping: FailureMapping = {
  gone: "The storage location itself is gone (a deleted bucket, an unmounted volume); an operator fault, surfaced rather than retried.",
  not_found:
    "No object exists at the key; reads answer `undefined` and deletes answer `false` instead of raising.",
  rate_limited:
    "An S3-compatible provider throttles a transfer (HTTP 429 or `SlowDown`); retried with backoff.",
  timed_out: "A transfer exceeded its budget; the partial upload is aborted and stays invisible.",
  auth_failed:
    "S3 credentials are missing or refused (403); fail closed and surface it to the operator.",
};
