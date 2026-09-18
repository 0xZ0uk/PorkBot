import type { StorageBody, StorageObject, StorageProvider } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { StorageKeyError } from "./storage-errors.ts";

/**
 * The storage conformance suite (slice 7.7): one set of behaviors every
 * `StorageProvider` implementation must show, run against the local provider
 * over a directory and against the S3-compatible provider over the emulator's
 * wire. An implementation that drifts from the seam — a partial write made
 * visible, a prefix that leaks, a body that gets buffered into a different size
 * — fails here rather than in the feature that happens to use it.
 *
 * The suite calls no network and holds no real key: the S3 side dials the
 * in-process emulator on loopback, which is why the same file can run both.
 */

export interface StorageConformanceHarness {
  readonly storage: StorageProvider;
  /**
   * True when `delete` can tell that the key was already absent. An
   * S3-compatible store cannot: its delete is idempotent and answers `true`.
   */
  readonly reportsMissingDeletes: boolean;
}

export type StorageHarnessFactory = () => Promise<StorageConformanceHarness>;

async function readAll(body: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;

  for await (const chunk of body) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }

  const joined = new Uint8Array(length);
  let offset = 0;

  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return joined;
}

async function readObject(
  storage: StorageProvider,
  key: string,
): Promise<{ readonly object: StorageObject; readonly bytes: Uint8Array }> {
  const read: StorageBody | undefined = await storage.get(key);

  if (read === undefined) {
    throw new Error(`expected ${JSON.stringify(key)} to exist`);
  }

  return { object: read.object, bytes: await readAll(read.body) };
}

function bytes(text: string): Uint8Array {
  return Buffer.from(text, "utf8");
}

async function* one(text: string): AsyncGenerator<Uint8Array> {
  yield bytes(text);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }

  throw new Error("expected the promise to reject");
}

export function storageConformance(name: string, create: StorageHarnessFactory): void {
  describe(`${name} storage conformance`, () => {
    it("round-trips bytes, size and content type through put and get", async () => {
      const { storage } = await create();
      const body = "A bot's notes, with a trailing newline.\n";

      const stored = await storage.put({
        key: "bots/bot-1/home/notes.txt",
        body: one(body),
        contentType: "text/plain",
      });

      expect(stored).toMatchObject({
        key: "bots/bot-1/home/notes.txt",
        size: bytes(body).byteLength,
        contentType: "text/plain",
      });
      expect(Number.isNaN(Date.parse(stored.lastModified))).toBe(false);

      const read = await readObject(storage, "bots/bot-1/home/notes.txt");

      expect(read.object).toMatchObject({
        key: "bots/bot-1/home/notes.txt",
        size: bytes(body).byteLength,
        contentType: "text/plain",
      });
      expect(Number.isNaN(Date.parse(read.object.lastModified))).toBe(false);
      expect(Buffer.from(read.bytes).toString("utf8")).toBe(body);
    });

    it("answers undefined for a key that was never written", async () => {
      const { storage } = await create();

      await expect(storage.get("bots/never/seen")).resolves.toBeUndefined();
    });

    it("overwrites an object and reports the new revision", async () => {
      const { storage } = await create();

      await storage.put({ key: "artifacts/report", body: one("old and short") });
      await storage.put({
        key: "artifacts/report",
        body: one("a new revision"),
        contentType: "text/plain",
      });

      const read = await readObject(storage, "artifacts/report");

      expect(read.object.size).toBe(bytes("a new revision").byteLength);
      expect(read.object.contentType).toBe("text/plain");
      expect(Buffer.from(read.bytes).toString("utf8")).toBe("a new revision");
    });

    it("deletes an object and reports a missing delete where the store can", async () => {
      const harness = await create();
      const { storage } = harness;

      await storage.put({ key: "attachments/one", body: one("attachment") });

      await expect(storage.delete("attachments/one")).resolves.toBe(true);
      await expect(storage.get("attachments/one")).resolves.toBeUndefined();

      const missing = await storage.delete("attachments/one");

      if (harness.reportsMissingDeletes) {
        expect(missing).toBe(false);
      } else {
        expect(missing).toBe(true);
      }

      await expect(storage.get("attachments/one")).resolves.toBeUndefined();
    });

    it("lists only the keys under the prefix, in UTF-8 order, with sizes and times", async () => {
      const { storage } = await create();
      const keys = ["bots/a/one", "bots/a/two", "bots/b/three", "bots/ab/four", "other/five"];

      for (const key of keys) {
        await storage.put({ key, body: one(`body of ${key}`) });
      }

      const listed = await storage.list("bots/a/");

      expect(listed.map((object) => object.key)).toEqual(["bots/a/one", "bots/a/two"]);
      expect(listed.map((object) => object.size)).toEqual([
        bytes("body of bots/a/one").byteLength,
        bytes("body of bots/a/two").byteLength,
      ]);
      expect(listed.every((object) => !Number.isNaN(Date.parse(object.lastModified)))).toBe(true);

      await expect(storage.list("nothing/here")).resolves.toEqual([]);
      await expect(storage.list("")).resolves.toHaveLength(5);
    });

    it("streams a body larger than one chunk without changing a byte", async () => {
      const { storage } = await create();
      const chunk = new Uint8Array(32 * 1024).fill(7);
      const chunks = 8;

      async function* large(): AsyncGenerator<Uint8Array> {
        for (let index = 0; index < chunks; index += 1) {
          yield chunk;
        }
      }

      const stored = await storage.put({ key: "backups/home.tar", body: large() });

      expect(stored.size).toBe(chunk.byteLength * chunks);

      const read = await readObject(storage, "backups/home.tar");

      expect(read.object.size).toBe(chunk.byteLength * chunks);
      expect(read.bytes).toHaveLength(chunk.byteLength * chunks);
      expect(read.bytes.every((byte) => byte === 7)).toBe(true);
    });

    it("leaves the previous revision intact when the body fails mid-stream", async () => {
      const { storage } = await create();
      await storage.put({ key: "homes/bot-1.tar", body: one("the previous backup") });

      async function* failing(): AsyncGenerator<Uint8Array> {
        yield bytes("the new backup, cut off");
        throw new Error("the source failed");
      }

      await expect(storage.put({ key: "homes/bot-1.tar", body: failing() })).rejects.toThrow(
        "the source failed",
      );

      const read = await readObject(storage, "homes/bot-1.tar");

      expect(read.object.size).toBe(bytes("the previous backup").byteLength);
      expect(Buffer.from(read.bytes).toString("utf8")).toBe("the previous backup");
    });

    it("treats keys as opaque names, including spaces, plus signs and unicode", async () => {
      const { storage } = await create();
      const key = "bots/a bot/home/résumé + 100% ? # notes.txt";

      await storage.put({ key, body: one("opaque") });

      const read = await readObject(storage, key);

      expect(read.object.key).toBe(key);
      expect(Buffer.from(read.bytes).toString("utf8")).toBe("opaque");
      await expect(storage.list("bots/a bot/")).resolves.toHaveLength(1);
    });

    it("refuses a key that escapes the seam's addressing rules", async () => {
      const { storage } = await create();
      const refused = [
        "",
        "/absolute",
        "trailing/",
        "a//b",
        "../escape",
        "a/../../escape",
        "back\\slash",
      ];

      for (const key of refused) {
        const error = await rejection(storage.put({ key, body: one("x") }));

        expect(error, `${JSON.stringify(key)} was accepted`).toBeInstanceOf(StorageKeyError);
      }
    });
  });
}
