import { createHash } from "node:crypto";
import type { StorageBody, StorageObject, StorageProvider } from "@porkbot/adapter-kit";
import type { CredentialKeyring } from "@porkbot/db";
import { decryptBackupStream, encryptBackupStream } from "./cipher.ts";
import { BackupError } from "./errors.ts";

/**
 * The encrypted archive over the storage seam (slice 12.3; PRD story 5).
 *
 * Every backup object is written and read through here, so the cipher, the
 * checksum and the storage adapter are one path: a caller hands in plaintext
 * bytes and a key, and the object that lands is ciphertext whose size and
 * SHA-256 are recorded for the drill to verify. Reads stream and verify at the
 * same time — the checksum is checked against the ciphertext as it is
 * decrypted — so a tampered or truncated object fails before its plaintext is
 * trusted, and the object is never buffered in memory.
 *
 * Nothing here knows whether the bytes live in a directory or a bucket; that
 * is `StorageProvider`'s answer, and the same code backs up to either. The
 * destination provider is a separate instance from the source (the primary
 * storage the homes are read from), which is what makes an off-site target a
 * configuration change rather than a second code path.
 */

export interface StoredBackupObject {
  readonly key: string;
  /** Ciphertext bytes, as stored. */
  readonly size: number;
  /** Lowercase hex SHA-256 of the ciphertext. */
  readonly checksum: string;
}

export interface ExpectedObject {
  readonly size: number;
  readonly checksum: string;
}

export interface BackupArchive {
  /** Encrypts `source` and stores it under `key`; the object is invisible until complete. */
  put(
    key: string,
    source: AsyncIterable<Uint8Array>,
    contentType?: string,
  ): Promise<StoredBackupObject>;
  /**
   * Fetches and decrypts `key`. `undefined` means no object exists. When
   * `expected` is given, the ciphertext's size and checksum are verified as
   * the stream is read, and a disagreement raises `cipher_failed` rather than
   * returning bytes that are not the backup that was taken.
   */
  read(
    key: string,
    expected?: ExpectedObject,
  ): Promise<
    { readonly object: StorageObject; readonly body: AsyncIterable<Uint8Array> } | undefined
  >;
  /** Objects under a prefix, as the destination reports them. */
  list(prefix: string): Promise<readonly StorageObject[]>;
  /** Deletes keys, returning how many were gone afterwards. */
  remove(keys: readonly string[]): Promise<number>;
}

export interface BackupArchiveOptions {
  readonly storage: StorageProvider;
  readonly keyring: CredentialKeyring;
}

export function createBackupArchive(options: BackupArchiveOptions): BackupArchive {
  const storage = options.storage;
  const keyring = options.keyring;

  return {
    async put(key, source, contentType): Promise<StoredBackupObject> {
      const hash = createHash("sha256");
      let size = 0;

      const metered = (async function* metered() {
        for await (const chunk of encryptBackupStream(source, keyring)) {
          const bytes = Buffer.from(chunk);

          hash.update(bytes);
          size += bytes.byteLength;
          yield bytes;
        }
      })();

      await storage.put({
        key,
        body: metered,
        ...(contentType === undefined ? {} : { contentType }),
      });

      return { key, size, checksum: hash.digest("hex") };
    },

    async read(key, expected) {
      const found: StorageBody | undefined = await storage.get(key);

      if (found === undefined) {
        return undefined;
      }

      const hash = createHash("sha256");
      let size = 0;

      const verified = (async function* verified() {
        for await (const chunk of found.body) {
          const bytes = Buffer.from(chunk);

          hash.update(bytes);
          size += bytes.byteLength;
          yield bytes;
        }

        if (
          expected !== undefined &&
          (size !== expected.size || hash.digest("hex") !== expected.checksum)
        ) {
          throw new BackupError(
            "cipher_failed",
            `the backup object "${key}" is not the object that was written`,
          );
        }
      })();

      return { object: found.object, body: decryptBackupStream(verified, keyring) };
    },

    list(prefix) {
      return storage.list(prefix);
    },

    async remove(keys) {
      let removed = 0;

      for (const key of keys) {
        await storage.delete(key);
        removed += 1;
      }

      return removed;
    },
  };
}
