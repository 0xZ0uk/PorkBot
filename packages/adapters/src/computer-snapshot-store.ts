import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
  ComputerRef,
  ComputerSnapshot,
  StorageObject,
  StorageProvider,
} from "@porkbot/adapter-kit";
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
  /**
   * How many captures one computer keeps (slice 14.4): the newest N archives
   * under its scope survive, and the rest are pruned after each capture so the
   * store is bounded per bot instead of growing until the host fills. A count
   * of zero or less disables pruning, which is the explicit "keep everything"
   * the operator can ask for.
   */
  readonly retention?: number | undefined;
  /**
   * Called with the objects a prune is about to delete, before any of them is
   * deleted, so the supervisor's log names what it removes rather than
   * reporting a deletion after the fact. A failing callback never blocks a
   * prune.
   */
  readonly onPrune?: ((removed: readonly StorageObject[]) => void) | undefined;
}

/**
 * The shipped snapshot retention: ten captures per bot. A home's archive is
 * the operator's undo, and ten of them bound the store without asking a
 * self-hoster to reason about bytes.
 */
export const DEFAULT_COMPUTER_SNAPSHOT_KEEP = 10;

/**
 * How old a staging file must be before the boot sweep treats it as an orphan
 * rather than a capture still in flight (slice 14.4): a day. A live capture
 * deletes its own, so anything older is what a crash left.
 */
export const DEFAULT_COMPUTER_ARCHIVE_STALE_MS = 86_400_000;

/**
 * The seam the shared computer lifecycle uses. `write` stages a produced
 * archive into storage and answers the verified handle; `read` fetches a
 * handle's archive, proves it against the handle, and runs `consume` on the
 * staged file. Neither method leaves a staging file behind. `prune` bounds what
 * `write` accumulates, and `sweepStaging` removes a staging file a crash left.
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
  /**
   * Deletes every archive beyond `retention` in each scope, newest kept. The
   * `onPrune` report fires before the first delete, so an operator sees what
   * the pass is about to remove.
   */
  prune(): Promise<readonly StorageObject[]>;
  /**
   * Removes staging files older than `staleMs` that a crashed capture left in
   * the archive directory. A live capture deletes its own, so anything this
   * finds is an orphan.
   */
  sweepStaging(staleMs: number): Promise<readonly string[]>;
}

/**
 * The store's maintenance half as a provider exposes it (slice 14.4): the
 * supervisor's boot pass prunes every scope to retention and sweeps a staging
 * file a crash left behind, so the bound holds even for captures taken before
 * this slice shipped.
 */
export interface ComputerSnapshotMaintenance {
  pruneSnapshots(): Promise<readonly StorageObject[]>;
  sweepStaging(staleMs: number): Promise<readonly string[]>;
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
  const retention = options.retention ?? DEFAULT_COMPUTER_SNAPSHOT_KEEP;

  async function stagedPath(): Promise<string> {
    await mkdir(scratchDirectory, { recursive: true });

    return path.join(scratchDirectory, `${randomUUID()}.tar`);
  }

  /** Newest first, with the key breaking a tie so a prune is deterministic. */
  function byNewest(left: StorageObject, right: StorageObject): number {
    if (left.lastModified !== right.lastModified) {
      return left.lastModified < right.lastModified ? 1 : -1;
    }

    return right.key.localeCompare(left.key);
  }

  /**
   * Selects the objects a scope must lose to keep `retention` newest, and
   * announces them before deleting. The report is best-effort: a logger that
   * throws must not turn a bounded store into a growing one.
   */
  async function prunePrefix(prefix: string): Promise<readonly StorageObject[]> {
    if (retention <= 0) {
      return [];
    }

    const objects = [...(await storage.list(prefix))].sort(byNewest);
    const expired = objects.slice(retention);

    if (expired.length === 0) {
      return [];
    }

    try {
      options.onPrune?.(expired);
    } catch {
      // A broken report is not a reason to keep the host's disk full.
    }

    for (const object of expired) {
      await storage.delete(object.key);
    }

    return expired;
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

        // The capture is kept before older ones are pruned, so a prune can
        // never remove the snapshot the operator just asked for. A pruning
        // failure is reported by the storage seam and does not lose the new
        // capture: the write's own result is already the verified handle.
        await prunePrefix(`${snapshotPrefix}/${snapshotScope(computer)}/`);

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

    async prune(): Promise<readonly StorageObject[]> {
      if (retention <= 0) {
        return [];
      }

      const objects = await storage.list(`${snapshotPrefix}/`);
      const scopes = new Set<string>();

      for (const object of objects) {
        const match = computerSnapshotKeyPattern.exec(object.key);

        if (match !== null && match[1] !== undefined) {
          scopes.add(match[1]);
        }
      }

      const removed: StorageObject[] = [];

      for (const scope of scopes) {
        removed.push(...(await prunePrefix(`${snapshotPrefix}/${scope}/`)));
      }

      return removed;
    },

    async sweepStaging(staleMs: number): Promise<readonly string[]> {
      if (!Number.isFinite(staleMs) || staleMs < 0) {
        throw new RangeError(`staleMs must be a non-negative number, received ${staleMs}`);
      }

      let names: readonly string[];

      try {
        names = await readdir(scratchDirectory);
      } catch {
        // No staging directory means no capture ever ran here, which is the
        // same answer as an empty one.
        return [];
      }

      const cutoff = Date.now() - staleMs;
      const removed: string[] = [];

      for (const name of names) {
        if (!name.endsWith(".tar")) {
          continue;
        }

        const file = path.join(scratchDirectory, name);

        try {
          const details = await stat(file);

          if (!details.isFile() || details.mtimeMs > cutoff) {
            continue;
          }
        } catch {
          // A file that vanished between the listing and the stat is already
          // gone, which is what this pass wanted.
          continue;
        }

        removed.push(name);
      }

      if (removed.length > 0) {
        try {
          options.onPrune?.(
            removed.map((name) => ({
              key: path.join(scratchDirectory, name),
              size: 0,
              lastModified: new Date(cutoff).toISOString(),
            })),
          );
        } catch {
          // See prunePrefix: the report never blocks the sweep.
        }

        for (const name of removed) {
          await rm(path.join(scratchDirectory, name), { force: true }).catch(() => undefined);
        }
      }

      return removed;
    },
  };
}
