import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { CredentialStoreError } from "@porkbot/effect";

/**
 * The credential envelope (slice 9.1, PRD decision 10; stories 14 and 15).
 *
 * A stored credential is AES-256-GCM ciphertext in one self-describing text
 * column, and this module is the only code that writes or reads it:
 *
 *   `v1:<key id>:<salt>:<iv>:<auth tag>:<ciphertext>`
 *
 *   - The **key id** is inside the envelope, so decryption is a keyring lookup
 *     rather than a guess: a second key can be introduced while rows written
 *     under the first still decrypt, and rotation is a re-encrypt rather than a
 *     migration.
 *   - The **salt** is fresh for every encryption. The 32-byte data key is
 *     derived from the keyring's master key and that salt with HKDF-SHA256, so
 *     two rows never share a data key even when the master key does, and the
 *     same value written twice yields two unrelated ciphertexts.
 *   - The **additional authenticated data** binds the ciphertext to the row it
 *     belongs to: the space and the name, JSON-encoded so no separator can be
 *     forged from a crafted name. Copying an envelope into another row — a
 *     different name, or the same name in another space — fails authentication
 *     before a byte is decrypted.
 *
 * A failure to parse, a key this keyring does not hold, and a failed
 * authentication all surface as the typed `CredentialStoreError`; none of them
 * carries the value or the ciphertext, because an error is serialized into logs
 * (PRD stack decision 10).
 */

const envelopeVersion = "v1";
const envelopeSeparator = ":";
const envelopePartCount = 6;
const keyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const keyBytes = 32;
const saltBytes = 16;
const ivBytes = 12;
const authTagBytes = 16;
const derivationInfo = "porkbot.credential.v1";

/**
 * The keys a deployment can decrypt with, and which one new writes use. Ids are
 * short labels an operator chooses (`k1`, `2026-09`); the material is the
 * 32-byte AES key, decoded once at boot so a malformed key fails startup rather
 * than the first credential read.
 */
export interface CredentialKeyring {
  readonly activeKeyId: string;
  readonly keys: ReadonlyMap<string, Buffer>;
}

export interface CredentialKeyringEntry {
  /** The id the envelope carries and `PORKBOT_CREDENTIAL_ACTIVE_KEY` names. */
  readonly id: string;
  /** The 32-byte key, base64 or base64url encoded. */
  readonly key: string;
}

export interface CredentialKeyringInput {
  readonly activeKeyId: string;
  readonly keys: Iterable<CredentialKeyringEntry>;
}

/** What a ciphertext is bound to, and the identity every row query uses. */
export interface CredentialBinding {
  readonly spaceId: string;
  readonly name: string;
}

function decodeKeyMaterial(id: string, encoded: string): Buffer {
  const normalized = encoded.trim().replace(/-/g, "+").replace(/_/g, "/");
  const key = Buffer.from(normalized, "base64");

  if (key.length !== keyBytes) {
    throw new Error(
      `credential key "${id}" must decode to ${keyBytes} bytes; it decoded to ${key.length}. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }

  return key;
}

/**
 * Validates and freezes a keyring: every id must be usable inside the envelope,
 * every key must be exactly 32 bytes, and the active id must name a key in the
 * ring. A duplicate id is refused rather than silently last-wins, because the
 * envelope would then name a key whose meaning depends on parse order.
 */
export function createCredentialKeyring(input: CredentialKeyringInput): CredentialKeyring {
  const keys = new Map<string, Buffer>();

  for (const entry of input.keys) {
    if (!keyIdPattern.test(entry.id)) {
      throw new Error(
        `credential key id ${JSON.stringify(entry.id)} must match ${keyIdPattern.source}`,
      );
    }

    if (keys.has(entry.id)) {
      throw new Error(`credential key id "${entry.id}" appears twice in the keyring`);
    }

    keys.set(entry.id, decodeKeyMaterial(entry.id, entry.key));
  }

  if (keys.size === 0) {
    throw new Error("the credential keyring holds no keys");
  }

  if (!keys.has(input.activeKeyId)) {
    throw new Error(
      `the active credential key "${input.activeKeyId}" is not in the keyring; ` +
        `it holds ${[...keys.keys()].join(", ")}`,
    );
  }

  return { activeKeyId: input.activeKeyId, keys };
}

/**
 * The deployment's keyring from the environment. Both variables are required
 * together and fail startup when unset: a process that boots without them would
 * only discover its credentials are unreadable on the first request.
 *
 * `PORKBOT_CREDENTIAL_KEYS` is a comma-separated `id:base64key` list and
 * `PORKBOT_CREDENTIAL_ACTIVE_KEY` names the one new writes use. Rotation is:
 * add the new key, restart with it active, run the store's `rotate`, then drop
 * the old key and restart again.
 */
export function credentialKeyringFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): CredentialKeyring {
  const encodedKeys = env["PORKBOT_CREDENTIAL_KEYS"]?.trim();
  const activeKeyId = env["PORKBOT_CREDENTIAL_ACTIVE_KEY"]?.trim();

  if (encodedKeys === undefined || encodedKeys.length === 0) {
    throw new Error("PORKBOT_CREDENTIAL_KEYS is not set; the credential store cannot be unlocked");
  }

  if (activeKeyId === undefined || activeKeyId.length === 0) {
    throw new Error("PORKBOT_CREDENTIAL_ACTIVE_KEY is not set; no key may write new credentials");
  }

  const entries = encodedKeys.split(",").map((entry): CredentialKeyringEntry => {
    const separator = entry.indexOf(envelopeSeparator);
    const id = separator === -1 ? entry.trim() : entry.slice(0, separator).trim();
    const key = separator === -1 ? "" : entry.slice(separator + 1).trim();

    if (id.length === 0 || key.length === 0 || key.includes(envelopeSeparator)) {
      throw new Error(
        "PORKBOT_CREDENTIAL_KEYS must be a comma-separated list of id:base64key entries",
      );
    }

    return { id, key };
  });

  return createCredentialKeyring({ activeKeyId, keys: entries });
}

function deriveKey(masterKey: Buffer, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", masterKey, salt, derivationInfo, keyBytes));
}

function credentialAad(binding: CredentialBinding): Buffer {
  // JSON, not a delimiter: a name containing the delimiter would otherwise let
  // one row's ciphertext authenticate as another's.
  return Buffer.from(JSON.stringify([derivationInfo, binding.spaceId, binding.name]), "utf8");
}

interface ParsedEnvelope {
  readonly keyId: string;
  readonly salt: Buffer;
  readonly iv: Buffer;
  readonly authTag: Buffer;
  readonly ciphertext: Buffer;
}

function parseEnvelope(envelope: string): ParsedEnvelope {
  const parts = envelope.split(envelopeSeparator);

  if (parts.length !== envelopePartCount || parts[0] !== envelopeVersion) {
    throw new CredentialStoreError("corrupt");
  }

  const [, keyId = "", salt = "", iv = "", authTag = "", ciphertext = ""] = parts;
  const parsed = {
    keyId,
    salt: Buffer.from(salt, "base64url"),
    iv: Buffer.from(iv, "base64url"),
    authTag: Buffer.from(authTag, "base64url"),
    ciphertext: Buffer.from(ciphertext, "base64url"),
  };

  if (
    !keyIdPattern.test(keyId) ||
    parsed.salt.length !== saltBytes ||
    parsed.iv.length !== ivBytes ||
    parsed.authTag.length !== authTagBytes
  ) {
    throw new CredentialStoreError("corrupt");
  }

  return parsed;
}

/** The key id an envelope names; the row is unreadable without that key. */
export function credentialEnvelopeKeyId(envelope: string): string {
  return parseEnvelope(envelope).keyId;
}

/**
 * Encrypts one value under the active key. A fresh salt and a fresh IV make
 * every call's output unique, so re-encrypting an unchanged value is a real
 * rotation and not a no-op the ciphertext would reveal.
 */
export function encryptCredentialValue(
  keyring: CredentialKeyring,
  binding: CredentialBinding,
  value: string,
): string {
  const masterKey = keyring.keys.get(keyring.activeKeyId);

  if (masterKey === undefined) {
    throw new CredentialStoreError("unknown_key", keyring.activeKeyId);
  }

  const salt = randomBytes(saltBytes);
  const iv = randomBytes(ivBytes);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterKey, salt), iv);

  cipher.setAAD(credentialAad(binding));

  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    envelopeVersion,
    keyring.activeKeyId,
    salt.toString("base64url"),
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(envelopeSeparator);
}

/**
 * Decrypts one envelope against the row it is bound to. A key the ring does not
 * hold is `unknown_key`; a malformed envelope, a wrong binding or a tampered
 * ciphertext is `corrupt`. The underlying crypto error is swallowed rather than
 * attached, because its text can echo the bytes it failed on.
 */
export function decryptCredentialValue(
  keyring: CredentialKeyring,
  binding: CredentialBinding,
  envelope: string,
): string {
  const parsed = parseEnvelope(envelope);
  const masterKey = keyring.keys.get(parsed.keyId);

  if (masterKey === undefined) {
    throw new CredentialStoreError("unknown_key", parsed.keyId);
  }

  const decipher = createDecipheriv("aes-256-gcm", deriveKey(masterKey, parsed.salt), parsed.iv);

  decipher.setAAD(credentialAad(binding));
  decipher.setAuthTag(parsed.authTag);

  try {
    return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new CredentialStoreError("corrupt");
  }
}

/**
 * The only shape a value takes on its way out of the store: a fixed marker and
 * the last four characters, and nothing at all for a value too short to hide a
 * meaningful part. The mask is display-only — it is never stored and never
 * authenticated.
 */
export function maskCredentialValue(value: string): string {
  return value.length >= 8 ? `••••${value.slice(-4)}` : "••••";
}
