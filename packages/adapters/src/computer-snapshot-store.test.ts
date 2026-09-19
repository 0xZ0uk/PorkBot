import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
