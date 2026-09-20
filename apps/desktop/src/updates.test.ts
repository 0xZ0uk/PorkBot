import { createHash, generateKeyPairSync, sign as signPayload } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isNewerVersion,
  parseUpdateManifest,
  parseVersion,
  refusalMessage,
  signingPayload,
  verifyUpdateArtifact,
  verifyUpdateManifest,
} from "./updates.ts";
import type { UpdateManifest } from "./updates.ts";

/**
 * The signature fixtures are generated in the suite with a real Ed25519
 * keypair, so "verified" and "refused" are cryptographic answers rather than
 * the mock agreeing with itself.
 */

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const { privateKey: otherPrivateKey } = generateKeyPairSync("ed25519");

const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

function manifestWith(version = "1.4.0"): UpdateManifest {
  const unsigned = {
    version,
    url: `https://updates.example.com/PorkBot-${version}.AppImage`,
    sha512: createHash("sha512").update("the artifact bytes").digest("base64"),
  };

  return {
    ...unsigned,
    signature: signPayload(null, signingPayload(unsigned), privateKey).toString("base64"),
  };
}

describe("the update manifest", () => {
  it("reads a complete manifest", () => {
    const parsed = parseUpdateManifest(manifestWith());

    expect(parsed.ok).toBe(true);
  });

  it("refuses a manifest with no signature before it looks at anything else", () => {
    const unsigned: Record<string, unknown> = { ...manifestWith() };

    delete unsigned["signature"];

    const parsed = parseUpdateManifest(unsigned);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.refusal).toBe("unsigned");
      expect(parsed.message).toContain("not signed");
    }
  });

  it("refuses a manifest that is missing a field", () => {
    for (const raw of [null, "text", {}, { version: "1.0.0", url: "https://x", signature: "s" }]) {
      const parsed = parseUpdateManifest(raw);

      expect(parsed.ok, JSON.stringify(raw)).toBe(false);
    }
  });
});

describe("update verification", () => {
  it("accepts a manifest signed by the pinned key, as PEM or base64 DER", () => {
    for (const key of [publicKeyPem, publicKeyBase64]) {
      expect(verifyUpdateManifest(manifestWith(), key)).toMatchObject({ ok: true });
    }
  });

  it("refuses a signature made by any other key", () => {
    const manifest = {
      ...manifestWith(),
      signature: signPayload(null, signingPayload(manifestWith()), otherPrivateKey).toString(
        "base64",
      ),
    };
    const result = verifyUpdateManifest(manifest, publicKeyPem);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe("bad_signature");
    }
  });

  it("refuses a tampered payload: the version is the signed one or nothing", () => {
    const manifest = { ...manifestWith(), version: "9.9.9" };
    const result = verifyUpdateManifest(manifest, publicKeyPem);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal).toBe("bad_signature");
    }
  });

  it("refuses an empty signature and an unreadable key", () => {
    expect(verifyUpdateManifest({ ...manifestWith(), signature: "" }, publicKeyPem)).toMatchObject({
      ok: false,
      refusal: "bad_signature",
    });
    expect(verifyUpdateManifest(manifestWith(), "not a key")).toMatchObject({
      ok: false,
      refusal: "bad_public_key",
    });
  });

  it("refuses an artifact URL that is not HTTPS", () => {
    const result = verifyUpdateManifest(
      { ...manifestWith(), url: "http://updates.example.com/app.AppImage" },
      publicKeyPem,
    );

    expect(result).toMatchObject({ ok: false, refusal: "insecure_url" });
  });

  it("refuses bytes that do not match the signed digest", () => {
    const manifest = manifestWith();
    const tampered = Buffer.from("the artifact bytes and then some");

    expect(verifyUpdateArtifact(tampered, manifest)).toMatchObject({
      ok: false,
      refusal: "hash_mismatch",
    });
    expect(verifyUpdateArtifact(Buffer.from("the artifact bytes"), manifest)).toMatchObject({
      ok: true,
    });
  });

  it("refuses a digest that is not a SHA-512", () => {
    expect(
      verifyUpdateArtifact(Buffer.from("x"), { ...manifestWith(), sha512: "AAAA" }),
    ).toMatchObject({ ok: false, refusal: "malformed" });
  });

  it("has a sentence for every refusal", () => {
    for (const refusal of [
      "malformed",
      "insecure_url",
      "unsigned",
      "bad_public_key",
      "bad_signature",
      "hash_mismatch",
      "not_newer",
      "not_configured",
      "unreachable",
    ] as const) {
      expect(refusalMessage(refusal).length).toBeGreaterThan(0);
    }
  });
});

describe("version order", () => {
  it("reads major.minor.patch and ignores pre-release suffixes", () => {
    expect(parseVersion("1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2.3-rc.1")).toEqual([1, 2, 3]);
    expect(parseVersion("1.2")).toBeUndefined();
  });

  it("orders versions numerically, not lexically", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.2", "1.2.3")).toBeLessThan(0);
    expect(isNewerVersion("1.2.4", "1.2.3")).toBe(true);
    expect(isNewerVersion("1.2.3", "1.2.3")).toBe(false);
    expect(isNewerVersion("garbage", "1.2.3")).toBe(false);
  });
});
