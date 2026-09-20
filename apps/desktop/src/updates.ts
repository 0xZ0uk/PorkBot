/**
 * The signed-update contract (slice 11.6).
 *
 * The issue asks for auto-update that is signed and verifiable and refuses an
 * unsigned update. So verification is the product here, not a flag on a
 * downloader: the release publishes an `update.json` whose version, artifact
 * URL and SHA-512 are signed with an Ed25519 key the app pins, and this module
 * refuses a manifest with no signature, a signature that does not verify, an
 * artifact whose bytes do not hash to the signed digest, a version that is not
 * newer, or a non-HTTPS artifact. `update-controller.ts` performs the I/O and
 * calls these before anything is written or applied, and the tests drive an
 * unsigned, a tampered and a valid manifest through the same door.
 *
 * The canonical payload is deliberately boring — the three fields joined by
 * newlines in this order — so a release script in any language can sign it and
 * the app can recompute it byte for byte.
 */

import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";

export interface UpdateManifest {
  readonly version: string;
  readonly url: string;
  /** Base64 SHA-512 of the artifact bytes. */
  readonly sha512: string;
  /** Base64 Ed25519 signature over `signingPayload(manifest)`. */
  readonly signature: string;
}

export type UpdateRefusal =
  | "malformed"
  | "insecure_url"
  | "unsigned"
  | "bad_public_key"
  | "bad_signature"
  | "hash_mismatch"
  | "not_newer"
  | "not_configured"
  | "unreachable";

export type UpdateManifestResult =
  | { readonly ok: true; readonly manifest: UpdateManifest }
  | { readonly ok: false; readonly refusal: UpdateRefusal; readonly message: string };

const refusalMessages: Readonly<Record<UpdateRefusal, string>> = {
  malformed: "The update manifest could not be read.",
  insecure_url: "The update artifact must be downloaded over HTTPS.",
  unsigned: "The update manifest is not signed; refusing it.",
  bad_public_key: "The pinned update public key could not be read.",
  bad_signature: "The update signature does not verify against the pinned key.",
  hash_mismatch: "The downloaded update does not match the signed digest.",
  not_newer: "The offered version is not newer than the installed one.",
  not_configured: "This build has no signed update feed configured.",
  unreachable: "The update feed could not be reached.",
};

export function refusalMessage(refusal: UpdateRefusal): string {
  return refusalMessages[refusal];
}

function refuse(refusal: UpdateRefusal): UpdateManifestResult {
  return { ok: false, refusal, message: refusalMessages[refusal] };
}

function stringField(record: Record<string, unknown>, name: string): string | undefined {
  const value = record[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Reads an `update.json`; an absent signature is `unsigned`, not malformed. */
export function parseUpdateManifest(raw: unknown): UpdateManifestResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return refuse("malformed");
  }

  const record = raw as Record<string, unknown>;
  const version = stringField(record, "version");
  const url = stringField(record, "url");
  const sha512 = stringField(record, "sha512");

  if (version === undefined || url === undefined || sha512 === undefined) {
    return refuse("malformed");
  }

  if (record["signature"] === undefined || record["signature"] === null) {
    return refuse("unsigned");
  }

  const signature = stringField(record, "signature");

  if (signature === undefined) {
    return refuse("unsigned");
  }

  return { ok: true, manifest: { version, url, sha512, signature } };
}

/** The bytes a release signs: version, URL and digest, newline-separated. */
export function signingPayload(
  manifest: Pick<UpdateManifest, "version" | "url" | "sha512">,
): Buffer {
  return Buffer.from([manifest.version, manifest.url, manifest.sha512].join("\n"), "utf8");
}

function publicKeyFrom(pinned: string): ReturnType<typeof createPublicKey> | undefined {
  try {
    if (pinned.includes("BEGIN")) {
      return createPublicKey(pinned);
    }

    return createPublicKey({
      key: Buffer.from(pinned, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    return undefined;
  }
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Whether the manifest's signature verifies against the pinned key and its
 * artifact URL is HTTPS. Order matters for the refusal: an unsigned manifest is
 * refused before its key is even read.
 */
export function verifyUpdateManifest(
  manifest: UpdateManifest,
  pinnedPublicKey: string,
): UpdateManifestResult {
  if (!isHttps(manifest.url)) {
    return refuse("insecure_url");
  }

  const key = publicKeyFrom(pinnedPublicKey);

  if (key === undefined) {
    return refuse("bad_public_key");
  }

  const signature = Buffer.from(manifest.signature, "base64");

  if (signature.length === 0) {
    return refuse("bad_signature");
  }

  const valid = verifySignature(null, signingPayload(manifest), key, signature);

  return valid ? { ok: true, manifest } : refuse("bad_signature");
}

/** Whether the artifact's bytes hash to the digest the manifest signed. */
export function verifyUpdateArtifact(
  bytes: Uint8Array,
  manifest: UpdateManifest,
): UpdateManifestResult {
  const expected = Buffer.from(manifest.sha512, "base64");

  if (expected.length !== 64) {
    return refuse("malformed");
  }

  const actual = createHash("sha512").update(bytes).digest();

  return timingSafeEqual(actual, expected) ? { ok: true, manifest } : refuse("hash_mismatch");
}

/** Parses `major.minor.patch`, ignoring any pre-release or build suffix. */
export function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim());

  if (match === null) {
    return undefined;
  }

  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Positive when `candidate` is newer than `current`; zero when equal. */
export function compareVersions(candidate: string, current: string): number | undefined {
  const left = parseVersion(candidate);
  const right = parseVersion(current);

  if (left === undefined || right === undefined) {
    return undefined;
  }

  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);

    if (difference !== 0) {
      return difference;
    }
  }

  return 0;
}

/** Whether a verified manifest should replace the running version. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const comparison = compareVersions(candidate, current);

  return comparison !== undefined && comparison > 0;
}
