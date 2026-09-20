import { randomBytes } from "node:crypto";
import { createCredentialKeyring } from "@porkbot/db";
import { describe, expect, it } from "vitest";
import {
  backupKeyringFromEnvironment,
  decryptBackupStream,
  encryptBackupStream,
  keyringKeyIds,
  openKeyEnvelope,
  sealKeyEnvelope,
} from "./cipher.ts";
import { BackupError } from "./errors.ts";

/**
 * The cipher's two layers, without a database or a bucket: a stream round trip
 * that proves chunking and the terminal record, every tamper shape failing
 * closed, and the envelope surviving exactly the passphrase it was sealed
 * with. The key material in these tests is invented and generated per run, so
 * no fixture is a secret.
 */

function keyring(id = "k1", byte = 0x2a) {
  return createCredentialKeyring({
    activeKeyId: id,
    keys: [{ id, key: Buffer.alloc(32, byte).toString("base64") }],
  });
}

async function* chunksOf(buffer: Buffer, size: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < buffer.length; offset += size) {
    yield buffer.subarray(offset, offset + size);
  }
}

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Buffer[] = [];

  for await (const chunk of source) {
    parts.push(Buffer.from(chunk));
  }

  return Buffer.concat(parts);
}

describe("the backup stream format", () => {
  it("round-trips bytes that span several records", async () => {
    const plaintext = randomBytes(200_000);
    const encrypted = await collect(encryptBackupStream(chunksOf(plaintext, 4096), keyring()));
    const decrypted = await collect(decryptBackupStream(chunksOf(encrypted, 997), keyring()));

    expect(encrypted.length).toBeGreaterThan(plaintext.length);
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it("round-trips an empty object", async () => {
    const encrypted = await collect(
      encryptBackupStream(chunksOf(Buffer.alloc(0), 1024), keyring()),
    );
    const decrypted = await collect(decryptBackupStream(chunksOf(encrypted, 5), keyring()));

    expect(decrypted.length).toBe(0);
  });

  it("starts with the magic and the active key id, and never the plaintext", async () => {
    const plaintext = Buffer.from("a very recognizable secret");
    const encrypted = await collect(encryptBackupStream(chunksOf(plaintext, 1024), keyring()));

    expect(encrypted.subarray(0, 4).toString("ascii")).toBe("PBBK");
    expect(encrypted.toString("utf8")).toContain("k1");
    expect(encrypted.includes(plaintext)).toBe(false);
  });

  it("refuses a truncated object instead of returning partial plaintext", async () => {
    const encrypted = await collect(
      encryptBackupStream(chunksOf(randomBytes(10_000), 1024), keyring()),
    );
    const truncated = encrypted.subarray(0, encrypted.length - 20);

    await expect(collect(decryptBackupStream(chunksOf(truncated, 128), keyring()))).rejects.toThrow(
      BackupError,
    );
  });

  it("refuses a tampered record", async () => {
    const encrypted = await collect(
      encryptBackupStream(chunksOf(randomBytes(10_000), 1024), keyring()),
    );

    encrypted[encrypted.length - 40] = (encrypted[encrypted.length - 40] ?? 0) ^ 0xff;

    await expect(collect(decryptBackupStream(chunksOf(encrypted, 128), keyring()))).rejects.toThrow(
      BackupError,
    );
  });

  it("refuses a keyring that does not hold the envelope's key", async () => {
    const encrypted = await collect(
      encryptBackupStream(chunksOf(randomBytes(1024), 1024), keyring("k1", 1)),
    );
    const other = keyring("k2", 2);

    await expect(collect(decryptBackupStream(chunksOf(encrypted, 128), other))).rejects.toThrow(
      /does not hold/,
    );
  });

  it("refuses a stream that is not a backup at all", async () => {
    await expect(
      collect(decryptBackupStream(chunksOf(Buffer.from("not a backup"), 128), keyring())),
    ).rejects.toThrow(/magic/);
  });
});

describe("the sealed key envelope", () => {
  it("opens with the passphrase it was sealed with, and holds the keyring", () => {
    const source = keyring("k1", 7);
    const envelope = sealKeyEnvelope(source, "correct horse battery staple");
    const opened = openKeyEnvelope(envelope, "correct horse battery staple");

    expect(opened.activeKeyId).toBe("k1");
    expect(opened.keys.get("k1")?.equals(source.keys.get("k1") ?? Buffer.alloc(0))).toBe(true);
    expect(keyringKeyIds(opened)).toEqual(["k1"]);
  });

  it("never carries the key material in the clear", () => {
    const envelope = sealKeyEnvelope(keyring("k1", 9), "passphrase");

    expect(JSON.stringify(envelope)).not.toContain(
      keyring("k1", 9).keys.get("k1")?.toString("base64"),
    );
    expect(envelope.ciphertext).not.toBe("");
  });

  it("refuses a wrong passphrase, a downgraded KDF and a tampered ciphertext", () => {
    const envelope = sealKeyEnvelope(keyring(), "passphrase");

    expect(() => openKeyEnvelope(envelope, "not the passphrase")).toThrow(/did not open/);
    expect(() =>
      openKeyEnvelope({ ...envelope, kdf: { ...envelope.kdf, n: 2 } }, "passphrase"),
    ).toThrow(BackupError);
    expect(() =>
      openKeyEnvelope(
        { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -2)}aa` },
        "passphrase",
      ),
    ).toThrow(/did not open/);
  });

  it("refuses an empty passphrase at seal time", () => {
    expect(() => sealKeyEnvelope(keyring(), "")).toThrow(/passphrase is empty/);
  });
});

describe("the backup keyring from the environment", () => {
  it("parses the same id:base64key shape as the credential keyring", () => {
    const parsed = backupKeyringFromEnvironment({
      PORKBOT_BACKUP_KEYS: `k1:${Buffer.alloc(32, 3).toString("base64")}`,
      PORKBOT_BACKUP_ACTIVE_KEY: "k1",
    });

    expect(keyringKeyIds(parsed)).toEqual(["k1"]);
  });

  it("fails with a typed configuration error for every malformed shape", () => {
    const key = Buffer.alloc(32, 3).toString("base64");

    expect(() => backupKeyringFromEnvironment({})).toThrow(/PORKBOT_BACKUP_KEYS/);
    expect(() => backupKeyringFromEnvironment({ PORKBOT_BACKUP_KEYS: `k1:${key}` })).toThrow(
      /PORKBOT_BACKUP_ACTIVE_KEY/,
    );
    expect(() =>
      backupKeyringFromEnvironment({
        PORKBOT_BACKUP_KEYS: "not-a-pair",
        PORKBOT_BACKUP_ACTIVE_KEY: "k1",
      }),
    ).toThrow(/id:base64key/);
    expect(() =>
      backupKeyringFromEnvironment({
        PORKBOT_BACKUP_KEYS: `k1:${key}`,
        PORKBOT_BACKUP_ACTIVE_KEY: "k2",
      }),
    ).toThrow(/not usable/);
  });
});
