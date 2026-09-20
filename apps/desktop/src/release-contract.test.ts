import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { publicKeyPem, signReleaseManifest, updateSigningPayload } from "@porkbot/testkit";
import { parseUpdateManifest, signingPayload, verifyUpdateManifest } from "./updates.ts";

/**
 * The release pipeline and the app are two implementations of one update
 * contract: `packages/testkit/src/release/signing.ts` produces the manifest and
 * this app refuses anything that does not verify. The suite is deliberately
 * cross-package — the release's canonical bytes and the app's are compared here
 * and nowhere else — because a drift between them would ship an update the app
 * silently refuses, which is indistinguishable from "no update" in the field.
 */

const artifactDigest = createHash("sha512").update("a packaged app").digest("base64");

function generatedKey(): { privateKeyPem: string; publicKeyValue: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  return {
    privateKeyPem,
    // The release helper writes the pinned value; the app's export is the same
    // key in the same PEM spelling.
    publicKeyValue: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function signedManifest(): {
  version: string;
  url: string;
  sha512: string;
  signature: string;
} {
  const { privateKeyPem } = generatedKey();
  const signed = signReleaseManifest({
    version: "0.2.0",
    url: "https://github.com/example/porkbot/releases/download/desktop-v0.2.0/PorkBot-0.2.0-linux-x64-abcdefabcdef.tar.gz",
    sha512: artifactDigest,
    privateKeyPem,
  });

  if (!signed.ok) {
    throw new Error(signed.message);
  }

  return signed.manifest;
}

describe("the release's signed update manifest", () => {
  it("uses the exact bytes the app recomputes", () => {
    const manifest = signedManifest();

    expect(updateSigningPayload(manifest).equals(signingPayload(manifest))).toBe(true);
  });

  it("is accepted by the app's parse and verify against the pinned key", () => {
    const { privateKeyPem, publicKeyValue } = generatedKey();
    const signed = signReleaseManifest({
      version: "0.2.0",
      url: "https://example.com/PorkBot-0.2.0-linux-x64-abcdefabcdef.tar.gz",
      sha512: artifactDigest,
      privateKeyPem,
    });

    expect(signed.ok).toBe(true);

    if (!signed.ok) {
      return;
    }

    const parsed = parseUpdateManifest(signed.manifest);

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    expect(verifyUpdateManifest(parsed.manifest, publicKeyPem(privateKeyPem)).ok).toBe(true);
    expect(verifyUpdateManifest(parsed.manifest, publicKeyValue).ok).toBe(true);
  });

  it("is refused by the app when the signed digest was changed after signing", () => {
    const { privateKeyPem, publicKeyValue } = generatedKey();
    const signed = signReleaseManifest({
      version: "0.2.0",
      url: "https://example.com/PorkBot-0.2.0-linux-x64-abcdefabcdef.tar.gz",
      sha512: artifactDigest,
      privateKeyPem,
    });

    expect(signed.ok).toBe(true);

    if (!signed.ok) {
      return;
    }

    const parsed = parseUpdateManifest({
      ...signed.manifest,
      sha512: createHash("sha512").update("something else").digest("base64"),
    });

    expect(parsed.ok).toBe(true);

    if (!parsed.ok) {
      return;
    }

    expect(verifyUpdateManifest(parsed.manifest, publicKeyValue)).toMatchObject({
      ok: false,
      refusal: "bad_signature",
    });
  });

  it("is refused when the signature was made by a different key", () => {
    const signer = generatedKey();
    const other = generatedKey();
    const signed = signReleaseManifest({
      version: "0.2.0",
      url: "https://example.com/PorkBot-0.2.0-linux-x64-abcdefabcdef.tar.gz",
      sha512: artifactDigest,
      privateKeyPem: signer.privateKeyPem,
    });

    expect(signed.ok).toBe(true);

    if (!signed.ok) {
      return;
    }

    expect(verifyUpdateManifest(signed.manifest, other.publicKeyValue)).toMatchObject({
      ok: false,
      refusal: "bad_signature",
    });
  });

  it("tells an unsigned manifest apart from a malformed one", () => {
    expect(parseUpdateManifest({ ...signedManifest(), signature: undefined })).toMatchObject({
      ok: false,
      refusal: "unsigned",
    });
  });
});
