import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  parseReleaseManifest,
  publicKeyPem,
  signReleaseManifest,
  updateSigningPayload,
  verifyReleaseManifest,
} from "../src/release/signing.ts";

/** A throwaway key per test: signing is offline and needs no fixture. */
function keyPair(): { privateKeyPem: string; publicKeyPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");

  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function digest(message: string): string {
  return createHash("sha512").update(message).digest("base64");
}

describe("the signed update manifest", () => {
  it("signs the three fields joined by newlines, in order", () => {
    expect(
      updateSigningPayload({
        version: "0.2.0",
        url: "https://example.com/PorkBot-0.2.0.tar.gz",
        sha512: "digest",
      }).toString("utf8"),
    ).toBe("0.2.0\nhttps://example.com/PorkBot-0.2.0.tar.gz\ndigest");
  });

  it("verifies a manifest it produced against the public half", () => {
    const keys = keyPair();
    const signed = signReleaseManifest({
      version: "0.2.0",
      url: "https://example.com/PorkBot-0.2.0-linux-x64-abcdefabcdef.tar.gz",
      sha512: digest("artifact"),
      privateKeyPem: keys.privateKeyPem,
    });

    expect(signed.ok).toBe(true);

    if (!signed.ok) {
      return;
    }

    expect(verifyReleaseManifest(signed.manifest, keys.publicKeyPem).ok).toBe(true);
    expect(publicKeyPem(keys.privateKeyPem)).toBe(keys.publicKeyPem);
  });

  it("refuses to sign a manifest whose artifact URL is not HTTPS", () => {
    const keys = keyPair();
    const signed = signReleaseManifest({
      version: "0.2.0",
      url: "http://example.com/PorkBot.tar.gz",
      sha512: digest("artifact"),
      privateKeyPem: keys.privateKeyPem,
    });

    expect(signed.ok).toBe(false);
  });

  it("refuses a tampered digest, a foreign key and a malformed manifest", () => {
    const release = keyPair();
    const other = keyPair();
    const signed = signReleaseManifest({
      version: "0.2.0",
      url: "https://example.com/PorkBot.tar.gz",
      sha512: digest("artifact"),
      privateKeyPem: release.privateKeyPem,
    });

    expect(signed.ok).toBe(true);

    if (!signed.ok) {
      return;
    }

    const tampered = { ...signed.manifest, sha512: digest("something else") };

    expect(verifyReleaseManifest(tampered, release.publicKeyPem).ok).toBe(false);
    expect(verifyReleaseManifest(signed.manifest, other.publicKeyPem).ok).toBe(false);
    expect(parseReleaseManifest({ ...signed.manifest, signature: undefined }).ok).toBe(false);
    expect(parseReleaseManifest({ version: "0.2.0" }).ok).toBe(false);
  });
});
