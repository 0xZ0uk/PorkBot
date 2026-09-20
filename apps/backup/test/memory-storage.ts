import { createHash } from "node:crypto";
import type {
  StorageBody,
  StorageObject,
  StorageProvider,
  StoragePutRequest,
} from "@porkbot/adapter-kit";

/**
 * An in-memory `StorageProvider` for the backup suites: the same contract the
 * local and S3 providers implement, so a test exercises the archive, the run
 * and the drill without a filesystem or a bucket. It lives in `test/` because
 * it is test infrastructure; shipped code reaches storage through the seam.
 */
export interface MemoryStorage extends StorageProvider {
  readonly objects: ReadonlyMap<string, Buffer>;
}

export interface MemoryStorageOptions {
  readonly initial?: Readonly<Record<string, string>>;
  /** Every object reports this instant; defaults to now. */
  readonly lastModified?: string;
}

export function createMemoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
  const objects = new Map<string, Buffer>(
    Object.entries(options.initial ?? {}).map(([key, value]) => [key, Buffer.from(value, "utf8")]),
  );
  const modified = (): string => options.lastModified ?? new Date().toISOString();

  return {
    objects,

    async put(request: StoragePutRequest): Promise<StorageObject> {
      const parts: Buffer[] = [];

      for await (const chunk of request.body) {
        parts.push(Buffer.from(chunk));
      }

      const body = Buffer.concat(parts);

      objects.set(request.key, body);

      return {
        key: request.key,
        size: body.byteLength,
        ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
        lastModified: modified(),
      };
    },

    async get(key: string): Promise<StorageBody | undefined> {
      const body = objects.get(key);

      if (body === undefined) {
        return undefined;
      }

      return {
        object: {
          key,
          size: body.byteLength,
          lastModified: modified(),
        },
        body: (async function* one() {
          yield body;
        })(),
      };
    },

    async delete(key: string): Promise<boolean> {
      return objects.delete(key);
    },

    async list(prefix: string): Promise<readonly StorageObject[]> {
      return [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, body]) => ({
          key,
          size: body.byteLength,
          lastModified: modified(),
        }));
    },
  };
}

/** A deterministic SHA-256 of a buffer, for tests that assert a checksum. */
export function sha256(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}
