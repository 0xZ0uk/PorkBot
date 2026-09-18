import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalStorageProvider } from "./local-storage.ts";
import { StorageConfigurationError, StorageProviderError } from "./storage-errors.ts";
import { storageConformance } from "./storage-conformance.ts";

/**
 * The local provider's half of the storage conformance suite, plus the
 * behaviors specific to a directory: a root that does not exist yet is an empty
 * store, a blank root is a configuration error, and a body with no content type
 * reads back without one.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createLocalHarness(): Promise<{
  readonly storage: LocalStorageProvider;
  readonly reportsMissingDeletes: boolean;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "porkbot-storage-"));
  roots.push(root);

  return { storage: new LocalStorageProvider({ root }), reportsMissingDeletes: true };
}

storageConformance("the local provider", createLocalHarness);

describe("the local provider's directory behavior", () => {
  it("needs nothing but a root directory, so self-hosting never requires S3", async () => {
    const { storage } = await createLocalHarness();

    await storage.put({
      key: "homes/bot-1/notes.txt",
      body: (async function* () {
        yield Buffer.from("local only", "utf8");
      })(),
    });

    const read = await storage.get("homes/bot-1/notes.txt");

    expect(read).toBeDefined();
  });

  it("treats a root that was never written to as an empty store", async () => {
    const { storage } = await createLocalHarness();

    await expect(storage.list("")).resolves.toEqual([]);
    await expect(storage.delete("never/written")).resolves.toBe(false);
  });

  it("reads back a body written without a content type without inventing one", async () => {
    const { storage } = await createLocalHarness();

    await storage.put({
      key: "artifacts/anonymous",
      body: (async function* () {
        yield Buffer.from("bytes", "utf8");
      })(),
    });

    const read = await storage.get("artifacts/anonymous");

    expect(read?.object.contentType).toBeUndefined();
  });

  it("rejects a blank root as a configuration error", () => {
    expect(() => new LocalStorageProvider({ root: "   " })).toThrow(StorageConfigurationError);
  });

  it("reports a corrupted object as a typed failure instead of trusting its header", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "porkbot-storage-"));
    roots.push(root);
    const storage = new LocalStorageProvider({ root });

    // A metadata length of 0xffffffff and no bytes behind it would otherwise
    // drive a four-gigabyte allocation from a damaged file.
    await writeFile(path.join(root, "corrupt"), Buffer.from([0xff, 0xff, 0xff, 0xff, 0x00]));
    await writeFile(path.join(root, "truncated"), Buffer.from([0x00, 0x00, 0x00, 0x20, 0x7b]));

    await expect(storage.get("corrupt")).rejects.toBeInstanceOf(StorageProviderError);
    await expect(storage.get("truncated")).rejects.toBeInstanceOf(StorageProviderError);
    await expect(storage.list("")).rejects.toBeInstanceOf(StorageProviderError);
  });
});
