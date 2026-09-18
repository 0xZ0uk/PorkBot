import { StorageKeyError } from "./storage-errors.ts";

/**
 * The one place a storage key is checked (slice 7.7).
 *
 * The seam addresses objects by key, never by path, and both implementations
 * accept exactly the same keys: a relative, slash-separated name whose segments
 * are non-empty and never `.` or `..`, at most 1024 bytes, with no backslash and
 * no NUL. Checking in one module is what keeps "the same key is valid in a
 * directory and in a bucket" true instead of a convention each implementation
 * remembers differently; the local provider maps a key onto path segments after
 * this check, never before.
 */

const maximumKeyBytes = 1024;

export function assertStorageKey(key: string): void {
  if (key === "") {
    throw new StorageKeyError("A key must not be empty.");
  }

  if (Buffer.byteLength(key, "utf8") > maximumKeyBytes) {
    throw new StorageKeyError(`A key must be at most ${maximumKeyBytes} bytes.`);
  }

  if (key.includes("\\")) {
    throw new StorageKeyError("A key uses forward slashes only; backslashes are not separators.");
  }

  for (const segment of key.split("/")) {
    if (segment === "") {
      throw new StorageKeyError(
        "A key has no empty segments: no `//`, no leading or trailing `/`.",
      );
    }

    if (segment === "." || segment === "..") {
      throw new StorageKeyError("A key has no `.` or `..` segments.");
    }
  }

  if (key.includes("\0")) {
    throw new StorageKeyError("A key must not contain a NUL byte.");
  }
}
