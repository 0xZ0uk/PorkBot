import { createCredentialKeyring } from "@porkbot/db";
import { describe, expect, it } from "vitest";
import { createMemoryStorage } from "../test/memory-storage.ts";
import { createBackupArchive } from "./archive.ts";
import { BackupError } from "./errors.ts";

/**
 * The archive over the storage seam: plaintext in, ciphertext out, checksums
 * verified on the way back. The in-memory provider stands in for a directory
 * or a bucket, so what these tests prove is the archive's own contract — a
 * round trip, a stored object that is not the plaintext, a tampered object
 * refused before its plaintext is trusted, and a missing key answering
 * `undefined` rather than an empty object.
 */

const keyring = createCredentialKeyring({
  activeKeyId: "k1",
  keys: [{ id: "k1", key: Buffer.alloc(32, 0x5a).toString("base64") }],
});

async function* chunksOf(buffer: Buffer): AsyncGenerator<Uint8Array> {
  yield buffer;
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];

  for await (const chunk of source) {
    parts.push(Buffer.from(chunk));
  }

  return Buffer.concat(parts);
}

describe("the encrypted archive", () => {
  it("round-trips an object and records its ciphertext size and checksum", async () => {
    const storage = createMemoryStorage();
    const archive = createBackupArchive({ storage, keyring });
    const plaintext = Buffer.from("the dump bytes");

    const stored = await archive.put("backups/postgres/run-1.dump.enc", chunksOf(plaintext));

    expect(stored.key).toBe("backups/postgres/run-1.dump.enc");
    expect(stored.size).toBe(storage.objects.get(stored.key)?.byteLength);
    expect(stored.size).toBeGreaterThan(plaintext.byteLength);
    expect(storage.objects.get(stored.key)?.includes(plaintext)).toBe(false);

    const found = await archive.read(stored.key, { size: stored.size, checksum: stored.checksum });

    expect(found).toBeDefined();
    expect(await collect(found?.body ?? (async function* empty() {})())).toEqual(plaintext);
  });

  it("answers undefined for a missing key", async () => {
    const archive = createBackupArchive({ storage: createMemoryStorage(), keyring });

    await expect(archive.read("backups/postgres/nope.dump.enc")).resolves.toBeUndefined();
  });

  it("refuses an object whose checksum disagrees before trusting its plaintext", async () => {
    const storage = createMemoryStorage();
    const archive = createBackupArchive({ storage, keyring });
    const stored = await archive.put("backups/postgres/run-1.dump.enc", chunksOf(Buffer.from("x")));
    const found = await archive.read(stored.key, {
      size: stored.size,
      checksum: "0".repeat(64),
    });

    await expect(collect(found?.body ?? (async function* empty() {})())).rejects.toThrow(
      BackupError,
    );
  });

  it("refuses an object whose bytes were tampered with", async () => {
    const storage = createMemoryStorage();
    const archive = createBackupArchive({ storage, keyring });
    const stored = await archive.put("backups/postgres/run-1.dump.enc", chunksOf(Buffer.from("x")));
    const bytes = storage.objects.get(stored.key);

    if (bytes !== undefined && bytes.length > 0) {
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff;
    }

    const found = await archive.read(stored.key);

    await expect(collect(found?.body ?? (async function* empty() {})())).rejects.toThrow(
      BackupError,
    );
  });

  it("lists and removes objects through the same seam", async () => {
    const storage = createMemoryStorage();
    const archive = createBackupArchive({ storage, keyring });

    await archive.put("backups/postgres/a.dump.enc", chunksOf(Buffer.from("a")));
    await archive.put("backups/homes/a/computer-snapshots/x.tar.enc", chunksOf(Buffer.from("b")));

    expect((await archive.list("backups/postgres/")).map((object) => object.key)).toEqual([
      "backups/postgres/a.dump.enc",
    ]);
    expect(await archive.remove(["backups/postgres/a.dump.enc"])).toBe(1);
    expect((await archive.list("backups/")).length).toBe(1);
  });
});
