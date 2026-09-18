import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import type {
  StorageBody,
  StorageObject,
  StorageProvider,
  StoragePutRequest,
} from "@porkbot/adapter-kit";
import { StorageConfigurationError, StorageProviderError } from "./storage-errors.ts";
import { assertStorageKey } from "./storage-keys.ts";

/**
 * Local storage: one directory on the host, no vendor and no network (slice
 * 7.7). This is the implementation a self-hosted deployment gets by default,
 * and nothing in the package requires the S3-compatible one to exist.
 *
 * Each object is one file under the root at the key's path, and an object that
 * has never been written is simply an absent file. A write streams to a
 * temporary file in the target's directory and renames it into place, so a
 * reader sees the previous revision or the new one, never a partial; the
 * temporary names match `.porkbot-<32 hex>.tmp` and are ignored by listing.
 *
 * The file is not raw bytes: a four-byte big-endian metadata length, the JSON
 * metadata (`contentType` when one was given) and then the body. One file
 * carries both, so the rename is the whole atomicity story and a crash cannot
 * pair a new body with stale metadata.
 *
 * The root is operator-controlled and trusted: the provider refuses a key that
 * escapes it, but it does not defend against a symlink already planted inside
 * the root, which is a filesystem permission problem rather than a key problem.
 * The rename is atomic, not durable: there is no fsync, so a machine losing
 * power can lose the most recent write (the previous revision may survive or
 * not) while a process crash cannot expose a partial object.
 *
 * Failure mapping: a filesystem error (an unreadable file, a vanished root, a
 * full disk) classifies as `gone` — an operator fault the caller surfaces
 * instead of retrying. A caller-supplied body that throws is not a provider
 * failure; it is rethrown with the failed write cleaned up.
 */

export interface LocalStorageProviderOptions {
  /** The directory every object lives under. Created on first write. */
  readonly root: string;
}

const metadataLengthBytes = 4;
const maximumMetadataBytes = 64 * 1024;
const temporaryFilePattern = /^\.porkbot-[0-9a-f]{32}\.tmp$/;

interface ObjectHeader {
  readonly metadataLength: number;
  readonly contentType: string | undefined;
}

function isMissing(cause: unknown): boolean {
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    (cause as { code?: unknown }).code === "ENOENT"
  );
}

async function readAt(handle: FileHandle, length: number, position: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);

  if (bytesRead !== length) {
    throw new Error("the object header is truncated");
  }

  return buffer;
}

async function readHeader(handle: FileHandle): Promise<ObjectHeader> {
  try {
    const lengths = await readAt(handle, metadataLengthBytes, 0);
    const metadataLength = lengths.readUInt32BE(0);

    if (metadataLength > maximumMetadataBytes) {
      throw new StorageProviderError("gone", "the local object metadata is unreadable");
    }

    const raw = await readAt(handle, metadataLength, metadataLengthBytes);

    let parsed: unknown;

    try {
      parsed = JSON.parse(raw.toString("utf8")) as unknown;
    } catch (cause) {
      throw new StorageProviderError("gone", "the local object metadata is unreadable", undefined, {
        cause,
      });
    }

    const contentType =
      typeof parsed === "object" && parsed !== null && "contentType" in parsed
        ? (parsed as { contentType?: unknown }).contentType
        : undefined;

    return {
      metadataLength,
      contentType: typeof contentType === "string" ? contentType : undefined,
    };
  } catch (cause) {
    if (cause instanceof StorageProviderError) {
      throw cause;
    }

    throw new StorageProviderError("gone", "the local object is unreadable", undefined, { cause });
  }
}

async function readObjectFile(
  absolute: string,
): Promise<{ readonly object: StorageObject; readonly bodyStart: number } | undefined> {
  let handle: FileHandle;

  try {
    handle = await open(absolute, "r");
  } catch (cause) {
    if (isMissing(cause)) {
      return undefined;
    }

    throw new StorageProviderError("gone", "the local store could not be read", undefined, {
      cause,
    });
  }

  try {
    const header = await readHeader(handle);
    const stats = await handle.stat();
    const bodyStart = metadataLengthBytes + header.metadataLength;

    if (stats.size < bodyStart) {
      throw new StorageProviderError("gone", "the local object is truncated");
    }

    return {
      object: {
        key: "",
        size: stats.size - bodyStart,
        ...(header.contentType === undefined ? {} : { contentType: header.contentType }),
        lastModified: stats.mtime.toISOString(),
      },
      bodyStart,
    };
  } finally {
    await handle.close();
  }
}

async function collectKeys(root: string, directory: string, collected: string[]): Promise<void> {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (isMissing(cause)) {
      return;
    }

    throw new StorageProviderError("gone", "the local store could not be listed", undefined, {
      cause,
    });
  }

  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      await collectKeys(root, absolute, collected);
      continue;
    }

    if (!entry.isFile() || temporaryFilePattern.test(entry.name)) {
      continue;
    }

    collected.push(path.relative(root, absolute).split(path.sep).join("/"));
  }
}

function compareKeys(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

export class LocalStorageProvider implements StorageProvider {
  readonly #root: string;

  constructor(options: LocalStorageProviderOptions) {
    const root = options.root.trim();

    if (root === "") {
      throw new StorageConfigurationError(
        "root",
        "missing",
        "Name the directory local storage lives under.",
      );
    }

    this.#root = path.resolve(root);
  }

  async put(request: StoragePutRequest): Promise<StorageObject> {
    assertStorageKey(request.key);
    const target = this.#targetPath(request.key);
    const temporary = path.join(
      path.dirname(target),
      `.porkbot-${randomBytes(16).toString("hex")}.tmp`,
    );
    const metadata = Buffer.from(
      JSON.stringify(request.contentType === undefined ? {} : { contentType: request.contentType }),
      "utf8",
    );
    let handle: FileHandle | undefined;
    let bodySize = 0;
    let bodyFailed = false;

    try {
      await mkdir(path.dirname(target), { recursive: true });
      handle = await open(temporary, "wx");

      const lengths = Buffer.alloc(metadataLengthBytes);
      lengths.writeUInt32BE(metadata.length, 0);
      await handle.write(lengths);
      await handle.write(metadata);

      try {
        for await (const chunk of request.body) {
          await handle.write(chunk);
          bodySize += chunk.byteLength;
        }
      } catch (cause) {
        bodyFailed = true;
        throw cause;
      }

      await handle.close();
      handle = undefined;
      await rename(temporary, target);
    } catch (cause) {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);

      if (bodyFailed) {
        throw cause;
      }

      throw new StorageProviderError("gone", "the local write failed", undefined, { cause });
    }

    const stats = await stat(target);

    return {
      key: request.key,
      size: bodySize,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
      lastModified: stats.mtime.toISOString(),
    };
  }

  async get(key: string): Promise<StorageBody | undefined> {
    assertStorageKey(key);
    const absolute = this.#targetPath(key);
    const stored = await readObjectFile(absolute);

    if (stored === undefined) {
      return undefined;
    }

    return {
      object: { ...stored.object, key },
      body: createReadStream(absolute, { start: stored.bodyStart }),
    };
  }

  async delete(key: string): Promise<boolean> {
    assertStorageKey(key);

    try {
      await unlink(this.#targetPath(key));
      return true;
    } catch (cause) {
      if (isMissing(cause)) {
        return false;
      }

      throw new StorageProviderError("gone", "the local delete failed", undefined, { cause });
    }
  }

  async list(prefix: string): Promise<readonly StorageObject[]> {
    const collected: string[] = [];
    await collectKeys(this.#root, this.#root, collected);

    const matching = collected.filter((key) => key.startsWith(prefix)).sort(compareKeys);
    const objects: StorageObject[] = [];

    for (const key of matching) {
      const stored = await readObjectFile(this.#targetPath(key));

      if (stored !== undefined) {
        objects.push({ ...stored.object, key });
      }
    }

    return objects;
  }

  #targetPath(key: string): string {
    const target = path.resolve(this.#root, ...key.split("/"));

    if (target !== this.#root && !target.startsWith(`${this.#root}${path.sep}`)) {
      // Unreachable while `assertStorageKey` holds; kept so a future change to
      // the key rules cannot silently turn a key into a path outside the root.
      throw new StorageProviderError("gone", "the key escaped the storage root");
    }

    return target;
  }
}
