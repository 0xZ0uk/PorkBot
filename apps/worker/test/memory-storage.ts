import type {
  StorageBody,
  StorageObject,
  StorageProvider,
  StoragePutRequest,
} from "@porkbot/adapter-kit";

/**
 * The in-memory storage seam for worker suites: objects are whole buffers in a
 * map, so a test can seed bytes and assert what a write left behind without a
 * directory or a network. It is test code under `test/`, never shipped.
 */
export class MemoryStorage implements StorageProvider {
  readonly objects = new Map<string, { readonly bytes: Buffer; readonly contentType?: string }>();

  putFrom(key: string, text: string, contentType?: string): void {
    this.objects.set(key, {
      bytes: Buffer.from(text),
      ...(contentType === undefined ? {} : { contentType }),
    });
  }

  async put(request: StoragePutRequest): Promise<StorageObject> {
    const chunks: Buffer[] = [];

    for await (const chunk of request.body) {
      chunks.push(Buffer.from(chunk));
    }

    const bytes = Buffer.concat(chunks);
    this.objects.set(request.key, {
      bytes,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
    });

    return {
      key: request.key,
      size: bytes.byteLength,
      ...(request.contentType === undefined ? {} : { contentType: request.contentType }),
      lastModified: new Date(0).toISOString(),
    };
  }

  async get(key: string): Promise<StorageBody | undefined> {
    const stored = this.objects.get(key);

    if (stored === undefined) {
      return undefined;
    }

    const bytes = stored.bytes;

    return {
      object: {
        key,
        size: bytes.byteLength,
        ...(stored.contentType === undefined ? {} : { contentType: stored.contentType }),
        lastModified: new Date(0).toISOString(),
      },
      body: {
        async *[Symbol.asyncIterator]() {
          yield bytes;
        },
      },
    };
  }

  async delete(key: string): Promise<boolean> {
    return this.objects.delete(key);
  }

  async list(): Promise<readonly StorageObject[]> {
    return [];
  }
}
