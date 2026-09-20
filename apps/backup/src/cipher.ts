import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { backupEnvelopeAad, BackupEnvelopeError, parseBackupKeyEnvelope } from "@porkbot/core";
import type { BackupKeyEnvelope } from "@porkbot/core";
import { createCredentialKeyring } from "@porkbot/db";
import type { CredentialKeyring } from "@porkbot/db";
import { BackupError } from "./errors.ts";

/**
 * The backup cipher (slice 12.3; PRD story 5).
 *
 * Two layers, deliberately independent of the credential store's material:
 *
 *   - **The object format** encrypts a stream in 64 KiB AES-256-GCM records.
 *     A fresh 16-byte salt per object derives a per-object data key from the
 *     keyring's master key with HKDF-SHA256, and a random 8-byte nonce prefix
 *     plus a 32-bit record counter makes every record's nonce unique. The
 *     record counter and a `final` flag are authenticated as additional data,
 *     so a truncated, reordered or spliced stream fails before a byte is
 *     returned — a partial restore is impossible by construction.
 *   - **The key envelope** seals the whole keyring under a key derived from the
 *     operator's passphrase with scrypt, so the one artifact that survives the
 *     deployment (the envelope file) is useless without a secret that is never
 *     stored. The envelope's KDF parameters, cipher and IV are authenticated,
 *     so a downgraded cost or a swapped IV fails before a key is derived.
 *
 * The master key never leaves this module as bytes; a failure to open a stream
 * is the typed `BackupError("cipher_failed")` with no detail that could echo
 * key material or plaintext, because errors are logged.
 *
 * A backup keyring is a `CredentialKeyring` from `@porkbot/db` — the same
 * validated `id:base64key` shape, parsed by the same constructor — but its
 * material comes from `PORKBOT_BACKUP_KEYS`, and its HKDF info string differs,
 * so a credential key and a backup key are not interchangeable even if an
 * operator reuses the bytes.
 */

const magic = Buffer.from("PBBK", "ascii");
const streamVersion = 1;
const saltBytes = 16;
const noncePrefixBytes = 8;
const counterBytes = 4;
const ivBytes = noncePrefixBytes + counterBytes;
const tagBytes = 16;
const chunkBytes = 64 * 1024;
const headerFixedBytes = magic.length + 1 + 1 + saltBytes + noncePrefixBytes;
const derivationInfo = "porkbot.backup.v1";

const envelopeScrypt = { n: 32_768, r: 8, p: 1, keyLength: 32 } as const;
const envelopeMaxmem = 64 * 1024 * 1024;

function keyIdPatternSafe(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,32}$/.test(id);
}

function cipherFailure(detail: string): BackupError {
  return new BackupError("cipher_failed", detail);
}

function dataKey(masterKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, salt, derivationInfo, 32));
}

function recordAad(header: Buffer, counter: number, final: boolean): Buffer {
  const trailer = Buffer.alloc(counterBytes + 1);

  trailer.writeUInt32BE(counter, 0);
  trailer.writeUInt8(final ? 1 : 0, counterBytes);

  return Buffer.concat([header, trailer]);
}

function nonceFor(prefix: Buffer, counter: number): Buffer {
  const nonce = Buffer.alloc(ivBytes);

  prefix.copy(nonce, 0);
  nonce.writeUInt32BE(counter, noncePrefixBytes);

  return nonce;
}

function encryptRecord(
  cipherKey: Buffer,
  header: Buffer,
  prefix: Buffer,
  counter: number,
  final: boolean,
  plaintext: Buffer,
): Buffer {
  const cipher = createCipheriv("aes-256-gcm", cipherKey, nonceFor(prefix, counter));

  cipher.setAAD(recordAad(header, counter, final));

  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const record = Buffer.alloc(4 + ciphertext.length + tagBytes);

  record.writeUInt32BE(ciphertext.length, 0);
  ciphertext.copy(record, 4);
  cipher.getAuthTag().copy(record, 4 + ciphertext.length);

  return record;
}

export interface BackupStreamKey {
  readonly keyring: CredentialKeyring;
}

/**
 * Encrypts one object's bytes. The generator pulls from `source` with
 * backpressure: at most one plaintext chunk is buffered at a time, so a
 * multi-gigabyte dump never has to fit in memory.
 */
export async function* encryptBackupStream(
  source: AsyncIterable<Uint8Array>,
  keyring: CredentialKeyring,
): AsyncGenerator<Uint8Array> {
  const masterKey = keyring.keys.get(keyring.activeKeyId);

  if (masterKey === undefined || !keyIdPatternSafe(keyring.activeKeyId)) {
    throw cipherFailure("the active backup key is not in the keyring");
  }

  const salt = randomBytes(saltBytes);
  const prefix = randomBytes(noncePrefixBytes);
  const keyId = Buffer.from(keyring.activeKeyId, "utf8");
  const header = Buffer.concat([
    magic,
    Buffer.from([streamVersion, keyId.length]),
    keyId,
    salt,
    prefix,
  ]);
  const cipherKey = dataKey(masterKey, salt);

  yield header;

  const buffered = Buffer.alloc(chunkBytes);
  let bufferedBytes = 0;
  let counter = 0;

  for await (const chunk of source) {
    let offset = 0;
    const bytes = Buffer.from(chunk);

    while (offset < bytes.length) {
      const copied = Math.min(chunkBytes - bufferedBytes, bytes.length - offset);

      bytes.copy(buffered, bufferedBytes, offset, offset + copied);
      bufferedBytes += copied;
      offset += copied;

      if (bufferedBytes === chunkBytes) {
        yield encryptRecord(cipherKey, header, prefix, counter, false, buffered);
        counter += 1;
        bufferedBytes = 0;
      }
    }
  }

  if (bufferedBytes > 0) {
    yield encryptRecord(
      cipherKey,
      header,
      prefix,
      counter,
      false,
      buffered.subarray(0, bufferedBytes),
    );
    counter += 1;
  }

  // The terminal record authenticates "this is the whole object": a stream cut
  // short is missing it, and a reader refuses to finish without it.
  yield encryptRecord(cipherKey, header, prefix, counter, true, Buffer.alloc(0));
}

/**
 * Decrypts one object's bytes, refusing anything but a complete stream: a
 * truncated object, a reordered record, a tampered tag and a wrong key all
 * raise the same typed failure before the caller sees plaintext.
 */
export async function* decryptBackupStream(
  source: AsyncIterable<Uint8Array>,
  keyring: CredentialKeyring,
): AsyncGenerator<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  let finished = false;

  async function take(length: number): Promise<Buffer> {
    while (pending.length < length) {
      const next = await iterator.next();

      if (next.done === true) {
        throw cipherFailure("the backup object ends before the stream is complete");
      }

      pending = Buffer.concat([pending, Buffer.from(next.value)]);
    }

    const taken = Buffer.from(pending.subarray(0, length));

    pending = pending.subarray(length);

    return taken;
  }

  const headerStart = await take(headerFixedBytes - noncePrefixBytes - saltBytes);

  if (!headerStart.subarray(0, magic.length).equals(magic)) {
    throw cipherFailure("the backup object does not start with the backup magic");
  }

  if (headerStart.readUInt8(magic.length) !== streamVersion) {
    throw cipherFailure("the backup object carries a stream version this code does not know");
  }

  const keyIdLength = headerStart.readUInt8(magic.length + 1);

  if (keyIdLength === 0 || keyIdLength > 32) {
    throw cipherFailure("the backup object names no usable key");
  }

  const keyIdBytes = await take(keyIdLength);
  const keyId = keyIdBytes.toString("utf8");

  if (!keyIdPatternSafe(keyId)) {
    throw cipherFailure("the backup object names a key id that is not usable");
  }

  const masterKey = keyring.keys.get(keyId);

  if (masterKey === undefined) {
    throw new BackupError(
      "cipher_failed",
      `the backup object was written under key "${keyId}", which this keyring does not hold`,
    );
  }

  const salt = await take(saltBytes);
  const prefix = await take(noncePrefixBytes);
  const header = Buffer.concat([headerStart, keyIdBytes, salt, prefix]);
  const cipherKey = dataKey(masterKey, salt);

  try {
    for (let counter = 0; ; counter += 1) {
      const lengthBytes = await take(4);
      const length = lengthBytes.readUInt32BE(0);

      if (length > chunkBytes) {
        throw cipherFailure("a backup record declares more bytes than one record can hold");
      }

      const body = await take(length + tagBytes);
      const ciphertext = body.subarray(0, length);
      const tag = body.subarray(length);
      const decipher = createDecipheriv("aes-256-gcm", cipherKey, nonceFor(prefix, counter));

      decipher.setAAD(recordAad(header, counter, length === 0));
      decipher.setAuthTag(tag);

      let plaintext: Buffer;

      try {
        plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      } catch {
        throw cipherFailure("a backup record did not authenticate");
      }

      if (length === 0) {
        // Drain the source: trailing bytes are a malformed object, and the
        // source's own end-of-stream check (the stored checksum) runs here, so
        // a reader never accepts an object it did not finish verifying.
        for (;;) {
          const next = await iterator.next();

          if (next.done === true) {
            break;
          }

          pending = Buffer.concat([pending, Buffer.from(next.value)]);
        }

        finished = true;

        if (pending.length > 0) {
          throw cipherFailure("the backup object carries bytes after its final record");
        }

        return;
      }

      yield plaintext;
    }
  } finally {
    if (!finished) {
      await iterator.return?.().catch(() => undefined);
    }
  }
}

/**
 * The backup keyring from the environment, under its own variable names. It is
 * the same validated shape as the credential keyring — `id:base64key` entries,
 * a 32-byte key each, an active id that names one — parsed by the same
 * constructor so a malformed key fails boot rather than the first read.
 */
export function backupKeyringFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): CredentialKeyring {
  const encodedKeys = env["PORKBOT_BACKUP_KEYS"]?.trim();
  const activeKeyId = env["PORKBOT_BACKUP_ACTIVE_KEY"]?.trim();

  if (encodedKeys === undefined || encodedKeys.length === 0) {
    throw new BackupError(
      "config_invalid",
      "PORKBOT_BACKUP_KEYS is not set; the backup keyring cannot be unlocked",
    );
  }

  if (activeKeyId === undefined || activeKeyId.length === 0) {
    throw new BackupError(
      "config_invalid",
      "PORKBOT_BACKUP_ACTIVE_KEY is not set; no key may write new backups",
    );
  }

  const keys = encodedKeys.split(",").map((entry) => {
    const separator = entry.indexOf(":");
    const id = separator === -1 ? entry.trim() : entry.slice(0, separator).trim();
    const key = separator === -1 ? "" : entry.slice(separator + 1).trim();

    if (id.length === 0 || key.length === 0 || key.includes(":")) {
      throw new BackupError(
        "config_invalid",
        "PORKBOT_BACKUP_KEYS must be a comma-separated list of id:base64key entries",
      );
    }

    return { id, key };
  });

  try {
    return createCredentialKeyring({ activeKeyId, keys });
  } catch (error) {
    throw new BackupError("config_invalid", "the backup keyring is not usable", { cause: error });
  }
}

interface EnvelopePlaintext {
  readonly activeKeyId: string;
  readonly keys: readonly { readonly id: string; readonly key: string }[];
}

/**
 * Seals the keyring under the operator's passphrase. The envelope names the
 * KDF cost, the cipher and the IV in authenticated text, so a reader can
 * refuse a downgrade rather than derive a weaker key and call the failure
 * "wrong passphrase".
 */
export function sealKeyEnvelope(keyring: CredentialKeyring, passphrase: string): BackupKeyEnvelope {
  if (passphrase.length === 0) {
    throw new BackupError("envelope_failed", "the envelope passphrase is empty");
  }

  const salt = randomBytes(saltBytes);
  const iv = randomBytes(12);
  const header: BackupKeyEnvelope = {
    version: "v1",
    kdf: {
      name: "scrypt",
      salt: salt.toString("base64url"),
      n: envelopeScrypt.n,
      r: envelopeScrypt.r,
      p: envelopeScrypt.p,
      keyLength: envelopeScrypt.keyLength,
    },
    cipher: "aes-256-gcm",
    iv: iv.toString("base64url"),
    authTag: "",
    ciphertext: "",
  };
  const plaintext: EnvelopePlaintext = {
    activeKeyId: keyring.activeKeyId,
    keys: [...keyring.keys].map(([id, key]) => ({ id, key: key.toString("base64") })),
  };
  const sealingKey = scryptSync(passphrase, salt, envelopeScrypt.keyLength, {
    N: envelopeScrypt.n,
    r: envelopeScrypt.r,
    p: envelopeScrypt.p,
    maxmem: envelopeMaxmem,
  });
  const cipher = createCipheriv("aes-256-gcm", sealingKey, iv);

  cipher.setAAD(Buffer.from(backupEnvelopeAad(header), "utf8"));

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(plaintext), "utf8"),
    cipher.final(),
  ]);

  return {
    ...header,
    authTag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

/** Opens a sealed envelope with the operator's passphrase. */
export function openKeyEnvelope(value: unknown, passphrase: string): CredentialKeyring {
  let envelope: BackupKeyEnvelope;

  try {
    envelope = parseBackupKeyEnvelope(value);
  } catch (error) {
    if (error instanceof BackupEnvelopeError) {
      throw new BackupError("envelope_failed", error.message, { cause: error });
    }

    throw error;
  }

  const salt = Buffer.from(envelope.kdf.salt, "base64url");
  const iv = Buffer.from(envelope.iv, "base64url");

  if (salt.length !== saltBytes || iv.length !== 12) {
    throw new BackupError("envelope_failed", "the envelope's salt or IV is the wrong size");
  }

  const sealingKey = scryptSync(passphrase, salt, envelope.kdf.keyLength, {
    N: envelope.kdf.n,
    r: envelope.kdf.r,
    p: envelope.kdf.p,
    maxmem: envelopeMaxmem,
  });
  const decipher = createDecipheriv("aes-256-gcm", sealingKey, iv);

  decipher.setAAD(Buffer.from(backupEnvelopeAad(envelope), "utf8"));
  decipher.setAuthTag(Buffer.from(envelope.authTag, "base64url"));

  let plaintext: string;

  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new BackupError("envelope_failed", "the envelope did not open with this passphrase");
  }

  let parsed: EnvelopePlaintext;

  try {
    parsed = JSON.parse(plaintext) as EnvelopePlaintext;
  } catch {
    throw new BackupError("envelope_failed", "the envelope's plaintext is not JSON");
  }

  if (typeof parsed.activeKeyId !== "string" || !Array.isArray(parsed.keys)) {
    throw new BackupError("envelope_failed", "the envelope's plaintext is not a keyring");
  }

  try {
    return createCredentialKeyring({
      activeKeyId: parsed.activeKeyId,
      keys: parsed.keys.map((entry) => ({ id: entry.id, key: entry.key })),
    });
  } catch (error) {
    throw new BackupError("envelope_failed", "the envelope's keyring is not usable", {
      cause: error,
    });
  }
}

/** The key ids a keyring holds, active first; never the material. */
export function keyringKeyIds(keyring: CredentialKeyring): readonly string[] {
  return [
    keyring.activeKeyId,
    ...[...keyring.keys.keys()].filter((id) => id !== keyring.activeKeyId),
  ];
}
