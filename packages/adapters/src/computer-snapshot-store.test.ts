import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProviderFailure } from "@porkbot/adapter-kit";
import type {
  ComputerRef,
  ComputerSnapshot,
  ProviderFailure,
  StorageProvider,
} from "@porkbot/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { computerSnapshotKey, createComputerSnapshotStore } from "./computer-snapshot-store.ts";
import { createMemoryCredentialStore } from "./credentials.ts";
import { LocalStorageProvider } from "./local-storage.ts";
import { S3CompatibleStorageProvider } from "./s3-storage.ts";
import { S3StorageEmulator } from "./s3-storage-emulator.ts";

/**
 * The snapshot store (slice 7.5): the one place a computer's home archive meets
 * the storage seam. The same suite runs against local storage and against the
 * S3-compatible provider over its emulator, because the store must not care
 * which one it was given; the corruption and scope cases pin the failures a
 * restore must surface before it touches a machine.
 */

const accessKeyId = "test-access-key-id";
const secretAccessKey = "test-secret-access-key";
const accessKeyIdName = "storage-access-key-id";
const secretAccessKeyName = "storage-secret-access-key";
const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };
const otherComputer: ComputerRef = { computerId: "computer-2", botId: "bot-2" };

const emulators: S3StorageEmulator[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(emulators.splice(0).map(async (emulator) => emulator.stop()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function failureFrom(call: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await call;
  } catch (error) {
    if (!isProviderFailure(error)) {
      throw new Error(`expected a ProviderFailure, received ${String(error)}`, { cause: error });
    }

    return error;
  }

  throw new Error("expected the call to fail");
}

function localHarness(): Promise<StorageProvider> {
  return temporaryDirectory("porkbot-snapshot-store-").then(
    (root) => new LocalStorageProvider({ root }),
  );
}

async function s3Harness(): Promise<StorageProvider> {
  const emulator = await S3StorageEmulator.start({
    bucket: "porkbot-test",
    accessKeyId,
    secretAccessKey,
  });

  emulators.push(emulator);

  return new S3CompatibleStorageProvider({
    endpoint: emulator.endpoint,
    bucket: emulator.bucket,
    credentials: createMemoryCredentialStore([
      [accessKeyIdName, accessKeyId],
      [secretAccessKeyName, secretAccessKey],
    ]),
    accessKeyIdCredentialName: accessKeyIdName,
    secretAccessKeyCredentialName: secretAccessKeyName,
    fetch: globalThis.fetch,
  });
}

const harnesses: readonly {
  readonly name: string;
  readonly create: () => Promise<StorageProvider>;
}[] = [
  { name: "local storage", create: localHarness },
  { name: "S3-compatible storage", create: s3Harness },
];

describe.each(harnesses)("the snapshot store over $name", ({ create }) => {
  it("captures a produced archive with its size and checksum, and reads it back", async () => {
    const storage = await create();
    const scratch = await temporaryDirectory("porkbot-snapshot-archives-");
    const store = createComputerSnapshotStore({ storage, scratchDirectory: scratch });
    const bytes = Buffer.from("the agent's home, as a tar", "utf8");
    const snapshotId = randomUUID();

    const snapshot = await store.write(computer, snapshotId, async (archive) => {
      await writeFile(archive, bytes);
    });

    expect(snapshot).toEqual({
      snapshotId,
      key: computerSnapshotKey(computer, snapshotId),
      size: bytes.byteLength,
      checksum: createHash("sha256").update(bytes).digest("hex"),
    });

    const consumed = await store.read(computer, snapshot, (archive) => readFile(archive));

    expect(consumed).toEqual(bytes);
    // Neither call leaves a staging file behind.
    await expect(readdir(scratch)).resolves.toEqual([]);
  });

  it("refuses a snapshot that names another computer's scope", async () => {
    const storage = await create();
    const store = createComputerSnapshotStore({
      storage,
      scratchDirectory: await temporaryDirectory("porkbot-snapshot-archives-"),
    });
    const snapshotId = randomUUID();

    const snapshot: ComputerSnapshot = {
      snapshotId,
      key: computerSnapshotKey(otherComputer, snapshotId),
      size: 1,
      checksum: "0".repeat(64),
    };
    const failure = await failureFrom(store.read(computer, snapshot, async () => undefined));

    expect(failure.kind).toBe("not_found");
  });

  it("refuses a missing object as not_found", async () => {
    const storage = await create();
    const store = createComputerSnapshotStore({
      storage,
      scratchDirectory: await temporaryDirectory("porkbot-snapshot-archives-"),
    });
    const snapshotId = randomUUID();
    const failure = await failureFrom(
      store.read(
        computer,
        {
          snapshotId,
          key: computerSnapshotKey(computer, snapshotId),
          size: 5,
          checksum: "0".repeat(64),
        },
        async () => undefined,
      ),
    );

    expect(failure.kind).toBe("not_found");
  });

  it("refuses bytes that are not the archive that was captured", async () => {
    const storage = await create();
    const scratch = await temporaryDirectory("porkbot-snapshot-archives-");
    const store = createComputerSnapshotStore({ storage, scratchDirectory: scratch });
    const snapshotId = randomUUID();
    const snapshot = await store.write(computer, snapshotId, async (archive) => {
      await writeFile(archive, "the archive as captured");
    });

    // The object is replaced behind the handle's back: same key, other bytes.
    await storage.put({
      key: snapshot.key,
      body: (async function* corrupted() {
        yield Buffer.from("a corrupted archive that is not the capture");
      })(),
    });

    const failure = await failureFrom(store.read(computer, snapshot, async () => undefined));

    expect(failure.kind).toBe("not_found");
    await expect(readdir(scratch)).resolves.toEqual([]);
  });

  it("refuses an archive whose length disagrees with the handle", async () => {
    const storage = await create();
    const store = createComputerSnapshotStore({
      storage,
      scratchDirectory: await temporaryDirectory("porkbot-snapshot-archives-"),
    });
    const snapshotId = randomUUID();
    const snapshot = await store.write(computer, snapshotId, async (archive) => {
      await writeFile(archive, "a short archive");
    });
    const failure = await failureFrom(
      store.read(computer, { ...snapshot, size: snapshot.size + 1 }, async () => undefined),
    );

    expect(failure.kind).toBe("not_found");
  });

  it("refuses a snapshot id that is not a UUID before producing anything", async () => {
    const storage = await create();
    const store = createComputerSnapshotStore({
      storage,
      scratchDirectory: await temporaryDirectory("porkbot-snapshot-archives-"),
    });

    await expect(
      store.write(computer, "not-a-uuid", async () => {
        throw new Error("the archive producer must not run");
      }),
    ).rejects.toBeInstanceOf(RangeError);
  });
});

/**
 * Bounded retention (slice 14.4). The store keeps the newest captures per
 * scope, reports every removal before it deletes, and never prunes in place of
 * the capture it just took.
 */

/** In-memory storage with a monotonic clock, so ordering never depends on timing. */
class ClockedStorage implements StorageProvider {
  readonly #objects = new Map<
    string,
    { readonly key: string; readonly size: number; readonly lastModified: string }
  >();
  #clock = 0;

  async put(request: { readonly key: string; readonly body: AsyncIterable<Uint8Array> }): Promise<{
    readonly key: string;
    readonly size: number;
    readonly lastModified: string;
  }> {
    let size = 0;

    for await (const chunk of request.body) {
      size += chunk.byteLength;
    }

    this.#clock += 1_000;
    const object = {
      key: request.key,
      size,
      lastModified: new Date(this.#clock).toISOString(),
    };
    this.#objects.set(request.key, object);
    return object;
  }

  async get(): Promise<undefined> {
    return undefined;
  }

  async delete(key: string): Promise<boolean> {
    return this.#objects.delete(key);
  }

  async list(
    prefix: string,
  ): Promise<readonly { key: string; size: number; lastModified: string }[]> {
    return [...this.#objects.values()].filter((object) => object.key.startsWith(prefix));
  }
}

describe("snapshot retention", () => {
  async function writeCapture(
    store: ReturnType<typeof createComputerSnapshotStore>,
    computerRef: ComputerRef,
  ): Promise<string> {
    const snapshotId = randomUUID();

    await store.write(computerRef, snapshotId, async (archive) => {
      await writeFile(archive, `capture ${snapshotId}`);
    });

    return computerSnapshotKey(computerRef, snapshotId);
  }

  it("keeps the newest captures per bot and reports the removals before deleting", async () => {
    const storage = new ClockedStorage();
    const removedReports: string[][] = [];
    const store = createComputerSnapshotStore({
      storage,
      scratchDirectory: await temporaryDirectory("porkbot-snapshot-archives-"),
      retention: 2,
      onPrune: (removed) => removedReports.push(removed.map((object) => object.key)),
    });

    const first = await writeCapture(store, computer);
    const second = await writeCapture(store, computer);
    const third = await writeCapture(store, computer);
    const fourth = await writeCapture(store, computer);
    const other = await writeCapture(store, otherComputer);

    const kept = (await storage.list("computer-snapshots/")).map((object) => object.key);

    expect(kept).toContain(third);
    expect(kept).toContain(fourth);
    expect(kept).not.toContain(first);
    expect(kept).not.toContain(second);
    // Another scope is never touched by one bot's prune.
    expect(kept).toContain(other);
    // The report is the plan, and no snapshot is reported more than once.
    expect(removedReports).toEqual([[first], [second]]);
  });

  it("keeps every capture when retention is zero", async () => {
    const storage = new ClockedStorage();
    const store = createComputerSnapshotStore({
      storage,
      scratchDirectory: await temporaryDirectory("porkbot-snapshot-archives-"),
      retention: 0,
    });

    const keys = [
      await writeCapture(store, computer),
      await writeCapture(store, computer),
      await writeCapture(store, computer),
    ];

    await expect(store.prune()).resolves.toEqual([]);
    expect((await storage.list("computer-snapshots/")).map((object) => object.key).sort()).toEqual(
      [...keys].sort(),
    );
  });

  it("bounds every scope on a boot prune, including captures taken before retention existed", async () => {
    const storage = new ClockedStorage();
    const store = createComputerSnapshotStore({
      storage,
      scratchDirectory: await temporaryDirectory("porkbot-snapshot-archives-"),
      retention: 1,
    });

    // Seeded straight into storage, the shape a store written before retention
    // shipped holds: three captures a scope and no prune ever having run.
    for (const computerRef of [computer, otherComputer]) {
      for (let index = 0; index < 3; index += 1) {
        await storage.put({
          key: computerSnapshotKey(computerRef, randomUUID()),
          body: (async function* archive() {
            yield Buffer.from(`capture ${String(index)}`);
          })(),
        });
      }
    }

    const removed = await store.prune();

    expect(removed).toHaveLength(4);
    expect(await storage.list("computer-snapshots/")).toHaveLength(2);
  });

  it("sweeps a staging file a crashed capture left, and leaves a fresh one", async () => {
    const scratch = await temporaryDirectory("porkbot-snapshot-archives-");
    const stale = path.join(scratch, "left-behind.tar");
    const fresh = path.join(scratch, "in-flight.tar");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1_000);

    await writeFile(stale, "a crashed capture");
    await writeFile(fresh, "a live capture");
    await utimes(stale, old, old);

    const reported: string[][] = [];
    const store = createComputerSnapshotStore({
      storage: new ClockedStorage(),
      scratchDirectory: scratch,
      onPrune: (removed) => reported.push(removed.map((object) => object.key)),
    });

    const removed = await store.sweepStaging(24 * 60 * 60 * 1_000);

    expect(removed).toEqual(["left-behind.tar"]);
    // The report names the absolute staging path it is about to remove.
    expect(reported).toEqual([[stale]]);
    await expect(readdir(scratch)).resolves.toEqual(["in-flight.tar"]);
  });
});
