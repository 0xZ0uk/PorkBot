import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import type { ComputerRef, ComputerSnapshot, StorageProvider } from "@porkbot/adapter-kit";
import { ComputerProviderError } from "./computer-errors.ts";

/**
 * Where a computer's snapshot archives live (slice 7.5, PRD story 30).
 *
 * A snapshot is bytes, and the storage seam is the one thing that knows where
 * bytes outlive a machine (slice 7.7). This module is the only place the
 * computer lifecycle meets that seam: it turns a provider's home archive into
 * an object under a scoped key, and it fetches an archive back, verifies it
 * against the size and checksum the capture recorded, and only then lets the
 * caller touch a machine. A local directory and an S3-compatible bucket are
 * interchangeable here because the only thing this module knows is
 * `StorageProvider`.
 *
 * The key is derived, never stored data: `computer-snapshots/<scope>/<id>.tar`,
 * where `<scope>` hashes the computer's `botId` and `computerId`. The bot is
 * space-scoped, so a key is too — a snapshot taken for one space's bot cannot
 * resolve under another's — and a hand-assembled key is refused against the
 * reference before any store is read, so a caller cannot point a restore at
 * another machine's archive.
 *
 * Failure mapping: an absent object, a byte count that disagrees with the
 * capture, and a checksum that disagrees are all `not_found` — the snapshot
 * named does not exist as it was captured — and every one of them is raised
 * before the old machine is replaced. A storage refusal passes through with the
 * kind the storage adapter classified (`gone`, `rate_limited`, `timed_out`,
 * `auth_failed`), so the lifecycle above branches on the shared vocabulary.
 *
 * The staging files this module produces hold an agent's home in the clear, so
 * they are created under a scratch directory the operator controls, with a
 * random name, and removed on every path including failure.
 */

/** The lowercase hex SHA-256 of the archive's bytes, as both sides name it. */
export const snapshotChecksumAlgorithm = "sha256";

/**
 * Where an archive is staged while it is written into or read out of storage.
 * A deployment mounts a volume here; a home in the clear never belongs in a
 * container's ephemeral layer.
 */
export const DEFAULT_COMPUTER_ARCHIVE_DIRECTORY = "/var/lib/porkbot/computer-archives";

/** The scope a computer's snapshots live under; it never names the ids directly. */
export function snapshotScope(computer: ComputerRef): string {
  return createHash("sha256")
    .update(`snapshot\u0000${computer.botId}\u0000${computer.computerId}`)
    .digest("hex")
    .slice(0, 16);
}

/** A snapshot's storage key: `<scope>/<snapshotId>.tar` under `computer-snapshots/`. */
export const computerSnapshotKeyPattern =
  /^computer-snapshots\/([0-9a-f]{16})\/([0-9a-f-]{36})\.tar$/;

const snapshotPrefix = "computer-snapshots";

/** The one key a computer's snapshot is addressed by. */
export function computerSnapshotKey(computer: ComputerRef, snapshotId: string): string {
  return `${snapshotPrefix}/${snapshotScope(computer)}/${snapshotId}.tar`;
}

/**
 * Resolves the key a snapshot handle names, or `undefined` when it does not
 * name this computer's own archive. The id must be a UUID and the key must be
 * exactly the one this computer's scope derives, so neither a foreign
 * snapshot's key nor a crafted path can be restored into this machine.
 */
function checkedKey(computer: ComputerRef, snapshot: ComputerSnapshot): string | undefined {
  const match = computerSnapshotKeyPattern.exec(snapshot.key);

  if (match === null || snapshot.key !== computerSnapshotKey(computer, snapshot.snapshotId)) {
    return undefined;
  }

  return snapshot.key;
}

export interface ComputerSnapshotStoreOptions {
  readonly storage: StorageProvider;
  /** Where an archive is staged while it is written or verified. */
  readonly scratchDirectory: string;
}

/**
 * The seam the shared computer lifecycle uses. `write` stages a produced
 * archive into storage and answers the verified handle; `read` fetches a
 * handle's archive, proves it against the handle, and runs `consume` on the
 * staged file. Neither method leaves a staging file behind.
 */
export interface ComputerSnapshotStore {
  write(
    computer: ComputerRef,
    snapshotId: string,
    produce: (archivePath: string) => Promise<void>,
  ): Promise<ComputerSnapshot>;
  read<T>(
    computer: ComputerRef,
    snapshot: ComputerSnapshot,
    consume: (archivePath: string) => Promise<T>,
  ): Promise<T>;
}

function missingSnapshot(computer: ComputerRef): ComputerProviderError {
  return new ComputerProviderError(
    "not_found",
    `no captured snapshot exists for computer ${computer.computerId}`,
  );
}

export function createComputerSnapshotStore(
  options: ComputerSnapshotStoreOptions,
): ComputerSnapshotStore {
  const storage = options.storage;
  const scratchDirectory = options.scratchDirectory;

  async function stagedPath(): Promise<string> {
    await mkdir(scratchDirectory, { recursive: true });

    return path.join(scratchDirectory, `${randomUUID()}.tar`);
  }

  return {
    async write(computer, snapshotId, produce): Promise<ComputerSnapshot> {
      const key = computerSnapshotKey(computer, snapshotId);

      if (!computerSnapshotKeyPattern.test(key)) {
        throw new RangeError(`a snapshot id must be a UUID, received "${snapshotId}"`);
      }

      const archive = await stagedPath();
      const hash = createHash(snapshotChecksumAlgorithm);
      let size = 0;

      try {
        await produce(archive);

        const source = createReadStream(archive);
        const body = (async function* metered() {
          for await (const chunk of source) {
            const bytes = chunk as Buffer;

            hash.update(bytes);
            size += bytes.byteLength;
            yield bytes;
          }
        })();

        // The object is written under the final key only when the transfer
        // completes, so a failed capture never leaves a readable partial.
        await storage.put({ key, contentType: "application/x-tar", body });

        return { snapshotId, key, size, checksum: hash.digest("hex") };
      } finally {
        await rm(archive, { force: true }).catch(() => undefined);
      }
    },

    async read<T>(
      computer: ComputerRef,
      snapshot: ComputerSnapshot,
      consume: (archivePath: string) => Promise<T>,
    ): Promise<T> {
      const key = checkedKey(computer, snapshot);

      if (key === undefined) {
        throw missingSnapshot(computer);
      }

      const found = await storage.get(key);

      if (found === undefined) {
        throw missingSnapshot(computer);
      }

      // A declared length that already disagrees is refused before a byte is
      // copied; the stream is still verified below, because a store's declared
      // length is metadata and the bytes are the truth.
      if (found.object.size !== snapshot.size) {
        throw new ComputerProviderError(
          "not_found",
          `the snapshot for computer ${computer.computerId} does not match the size it was captured with`,
        );
      }

      const archive = await stagedPath();
      const hash = createHash(snapshotChecksumAlgorithm);
      let size = 0;
      let handle: FileHandle | undefined;

      try {
        try {
          handle = await open(archive, "wx");

          for await (const chunk of found.body) {
            const bytes = chunk as Buffer;

            hash.update(bytes);
            size += bytes.byteLength;
            await handle.write(bytes);
          }
        } finally {
          await handle?.close().catch(() => undefined);
        }

        if (size !== snapshot.size || hash.digest("hex") !== snapshot.checksum) {
          throw new ComputerProviderError(
            "not_found",
            `the snapshot for computer ${computer.computerId} is not the archive that was captured`,
          );
        }

        return await consume(archive);
      } finally {
        await rm(archive, { force: true }).catch(() => undefined);
      }
    },
  };
}
