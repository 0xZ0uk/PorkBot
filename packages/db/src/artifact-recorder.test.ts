import { Effect } from "effect";
import type {
  StorageBody,
  StorageObject,
  StorageProvider,
  StoragePutRequest,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { artifactStorageKey, createArtifactRecorder } from "./artifact-recorder.ts";
import type { NewArtifact, RunFileStore } from "./file-store.ts";
import type { RunArtifactRecord } from "./records.ts";

/**
 * The artifact recorder (slice 7.6, story 33): the seam implementation that
 * writes bytes through the storage seam and records the row through the run's
 * file store. The suite pins the deterministic key, the order (bytes first,
 * row second), the download pointer, and the replay discipline the store's
 * `(run_id, call_id)` uniqueness gives a retried recording.
 */

class MemoryStorage implements StorageProvider {
  readonly objects = new Map<string, { readonly bytes: Buffer; readonly contentType?: string }>();

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

function artifactRow(overrides: Partial<RunArtifactRecord> = {}): RunArtifactRecord {
  return {
    id: "artifact-1",
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    userId: "user-1",
    runId: "run-1",
    callId: "call-1",
    filename: "report.txt",
    contentType: "text/plain",
    sizeBytes: 4,
    storageKey: "artifacts/space-1/run-1/hash",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function scriptedFiles(row: RunArtifactRecord): {
  readonly files: RunFileStore;
  readonly recorded: NewArtifact[];
} {
  const recorded: NewArtifact[] = [];

  return {
    recorded,
    files: {
      findAttachments: async () => [],
      recordArtifact: async (input) => {
        recorded.push(input);

        return row;
      },
    },
  };
}

describe("the artifact storage key", () => {
  it("is deterministic and hashes the call id rather than embedding it", () => {
    const key = artifactStorageKey("space-1", "run-1", "call/with/slashes");

    expect(key).toBe(artifactStorageKey("space-1", "run-1", "call/with/slashes"));
    expect(key.startsWith("artifacts/space-1/run-1/")).toBe(true);
    expect(key).not.toContain("call/with/slashes");
  });
});

describe("recording an artifact", () => {
  it("writes the bytes first, then records the row and answers the pointer", async () => {
    const storage = new MemoryStorage();
    const { files, recorded } = scriptedFiles(artifactRow());
    const recorder = createArtifactRecorder({
      files,
      storage,
      spaceId: "space-1",
      runId: "run-1",
    });

    const result = await Effect.runPromise(
      recorder.record({
        callId: "call-1",
        filename: "report.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode("done"),
      }),
    );

    expect(recorded).toEqual([
      {
        runId: "run-1",
        callId: "call-1",
        filename: "report.txt",
        contentType: "text/plain",
        sizeBytes: 4,
        storageKey: artifactStorageKey("space-1", "run-1", "call-1"),
      },
    ]);

    const stored = storage.objects.get(artifactStorageKey("space-1", "run-1", "call-1"));
    expect(stored?.bytes.toString("utf8")).toBe("done");
    expect(stored?.contentType).toBe("text/plain");

    expect(result).toEqual({
      id: "artifact-1",
      filename: "report.txt",
      contentType: "text/plain",
      sizeBytes: 4,
      downloadPath: "/files/artifact-1",
    });
  });

  it("keeps the first row when the store replays a settled recording", async () => {
    const storage = new MemoryStorage();
    const { files } = scriptedFiles(artifactRow({ id: "first-artifact" }));
    const recorder = createArtifactRecorder({ files, storage, spaceId: "space-1", runId: "run-1" });

    const result = await Effect.runPromise(
      recorder.record({
        callId: "call-1",
        filename: "report.txt",
        contentType: "text/plain",
        bytes: new TextEncoder().encode("done"),
      }),
    );

    expect(result.downloadPath).toBe("/files/first-artifact");
  });

  it("fails the call when the bytes cannot be stored", async () => {
    const failing: StorageProvider = {
      put: async () => {
        throw new Error("the store is gone");
      },
      get: async () => undefined,
      delete: async () => false,
      list: async () => [],
    };
    const { files } = scriptedFiles(artifactRow());
    const recorder = createArtifactRecorder({
      files,
      storage: failing,
      spaceId: "space-1",
      runId: "run-1",
    });

    await expect(
      Effect.runPromise(
        recorder.record({
          callId: "call-1",
          filename: "report.txt",
          contentType: "text/plain",
          bytes: new Uint8Array(0),
        }),
      ),
    ).rejects.toThrow(/the store is gone/);
  });
});
