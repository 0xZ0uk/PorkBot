import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BackupKeyEnvelope } from "@porkbot/core";
import type { CredentialKeyring } from "@porkbot/db";
import { openKeyEnvelope, sealKeyEnvelope } from "./cipher.ts";
import { BackupError } from "./errors.ts";

/**
 * The sealed key envelope on disk (slice 12.3; PRD story 5).
 *
 * This file is the recovery artifact: the keyring, encrypted under a key
 * derived from the operator's passphrase, written somewhere other than the
 * backup destination. The passphrase is never stored, so the file is safe to
 * copy into a password manager or an offline vault — which the operator is
 * told to do, because a key that exists only on the host the backup protects
 * is not a key that survives losing the host.
 *
 * The write is atomic (a temporary file in the same directory, renamed over
 * the target) and mode 0600, so a reader never sees a half-written envelope
 * and another user cannot read one. The envelope is rewritten on every run, so
 * the file always seals the keyring the deployment is actually writing under.
 */

export async function writeKeyEnvelope(
  envelopePath: string,
  keyring: CredentialKeyring,
  passphrase: string,
): Promise<BackupKeyEnvelope> {
  const envelope = sealKeyEnvelope(keyring, passphrase);
  const directory = path.dirname(envelopePath);
  const temporary = path.join(directory, `.${path.basename(envelopePath)}.${process.pid}.tmp`);

  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporary, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, envelopePath);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }

  return envelope;
}

/** Reads the envelope file; a missing file is the caller's to interpret. */
export async function readKeyEnvelopeFile(envelopePath: string): Promise<unknown> {
  let text: string;

  try {
    text = await readFile(envelopePath, "utf8");
  } catch (error) {
    throw new BackupError("envelope_failed", `could not read the key envelope at ${envelopePath}`, {
      cause: error,
    });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new BackupError("envelope_failed", `the key envelope at ${envelopePath} is not JSON`, {
      cause: error,
    });
  }
}

/** Opens the envelope file with the operator's passphrase. */
export async function keyringFromEnvelopeFile(
  envelopePath: string,
  passphrase: string,
): Promise<CredentialKeyring> {
  return openKeyEnvelope(await readKeyEnvelopeFile(envelopePath), passphrase);
}
