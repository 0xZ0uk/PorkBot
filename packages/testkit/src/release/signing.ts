/**
 * The release half of the signed-update contract (slice 11.7).
 *
 * The app's update check (`apps/desktop/src/updates.ts`) refuses an update
 * unless its `update.json` is signed with the pinned Ed25519 key and the
 * artifact's bytes hash to the signed SHA-512. This module produces exactly
 * that manifest — the canonical payload is the three fields joined by newlines,
 * version, URL and digest, in that order — so the release and the app are two
 * implementations of one contract rather than two opinions. The desktop's own
 * suite imports `updateSigningPayload` from here and fails when the two
 * spellings drift.
 *
 * The private key is a release secret. It is read from the environment (or a
 * file path chosen by the operator) and never logged, never written into an
 * artifact, and never committed.
 */

import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

export interface ReleaseUpdateManifest {
  readonly version: string;
  readonly url: string;
  /** Base64 SHA-512 of the artifact's bytes. */
  readonly sha512: string;
  /** Base64 Ed25519 signature over `updateSigningPayload(manifest)`. */
  readonly signature: string;
}

export type ManifestResult =
  | { readonly ok: true; readonly manifest: ReleaseUpdateManifest }
  | { readonly ok: false; readonly message: string };

/** The bytes a release signs and the app verifies: version, URL and digest. */
export function updateSigningPayload(
  manifest: Pick<ReleaseUpdateManifest, "version" | "url" | "sha512">,
): Buffer {
  return Buffer.from([manifest.version, manifest.url, manifest.sha512].join("\n"), "utf8");
}

function readPrivateKey(pem: string): ReturnType<typeof createPrivateKey> {
  return createPrivateKey(pem);
}

function readPublicKey(pinned: string): ReturnType<typeof createPublicKey> {
  if (pinned.includes("BEGIN")) {
    return createPublicKey(pinned);
  }

  return createPublicKey({ key: Buffer.from(pinned, "base64"), format: "der", type: "spki" });
}

/** The public half of a release key, PEM-encoded, for the app's pinned value. */
export function publicKeyPem(privateKeyPem: string): string {
  return createPublicKey(readPrivateKey(privateKeyPem))
    .export({ type: "spki", format: "pem" })
    .toString();
}

export function signReleaseManifest(input: {
  readonly version: string;
  readonly url: string;
  readonly sha512: string;
  readonly privateKeyPem: string;
}): ManifestResult {
  if (!input.url.startsWith("https://")) {
    return { ok: false, message: `the artifact URL must be HTTPS, got "${input.url}".` };
  }

  let signature: Buffer;

  try {
    signature = sign(null, updateSigningPayload(input), readPrivateKey(input.privateKeyPem));
  } catch (error) {
    return {
      ok: false,
      message: `the release key could not sign the manifest: ${(error as Error).message}`,
    };
  }

  return {
    ok: true,
    manifest: {
      version: input.version,
      url: input.url,
      sha512: input.sha512,
      signature: signature.toString("base64"),
    },
  };
}

export function parseReleaseManifest(raw: unknown): ManifestResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "the update manifest is not an object." };
  }

  const record = raw as Record<string, unknown>;
  const fields: Record<keyof Omit<ReleaseUpdateManifest, "signature">, string> = {
    version: "",
    url: "",
    sha512: "",
  };

  for (const name of Object.keys(fields) as (keyof typeof fields)[]) {
    const value = record[name];

    if (typeof value !== "string" || value.length === 0) {
      return { ok: false, message: `the update manifest has no ${name}.` };
    }

    fields[name] = value;
  }

  const signature = record["signature"];

  if (typeof signature !== "string" || signature.length === 0) {
    return { ok: false, message: "the update manifest is not signed." };
  }

  return { ok: true, manifest: { ...fields, signature } };
}

/** Whether a manifest verifies against the pinned key and its digest is base64. */
export function verifyReleaseManifest(
  manifest: ReleaseUpdateManifest,
  pinnedPublicKey: string,
): ManifestResult {
  if (!manifest.url.startsWith("https://")) {
    return { ok: false, message: "the artifact URL must be HTTPS." };
  }

  const expected = Buffer.from(manifest.sha512, "base64");

  if (expected.length !== 64) {
    return { ok: false, message: "the signed digest is not a base64 SHA-512." };
  }

  let key: ReturnType<typeof createPublicKey>;

  try {
    key = readPublicKey(pinnedPublicKey);
  } catch {
    return { ok: false, message: "the pinned public key could not be read." };
  }

  const signature = Buffer.from(manifest.signature, "base64");

  if (signature.length === 0 || !verify(null, updateSigningPayload(manifest), key, signature)) {
    return { ok: false, message: "the update signature does not verify against the public key." };
  }

  return { ok: true, manifest };
}
