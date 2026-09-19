import { CredentialStoreError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import {
  createCredentialKeyring,
  credentialEnvelopeKeyId,
  credentialKeyringFromEnvironment,
  decryptCredentialValue,
  encryptCredentialValue,
  maskCredentialValue,
} from "./credential-cipher.ts";

/**
 * The envelope on its own, with no database: what the cipher promises is that a
 * value round-trips, that every write is unique, that a ciphertext is bound to
 * its row, and that a keyring can hold more than one key so rotation never
 * strands a row. The store tests beside this one prove the SQL that picks the
 * rows; these prove the bytes.
 */

const secret = "sk-live-0123456789abcdef";
const base64Key = (fill: number): string => Buffer.alloc(32, fill).toString("base64");

const keyring = (activeKeyId: string, entries: readonly (readonly [string, number])[]) =>
  createCredentialKeyring({
    activeKeyId,
    keys: entries.map(([id, fill]) => ({ id, key: base64Key(fill) })),
  });

const binding = { spaceId: "space-1", name: "model-key" };

describe("the credential envelope", () => {
  it("round-trips a value and carries its key id", () => {
    const keys = keyring("k1", [["k1", 1]]);
    const envelope = encryptCredentialValue(keys, binding, secret);

    expect(envelope.startsWith("v1:k1:")).toBe(true);
    expect(credentialEnvelopeKeyId(envelope)).toBe("k1");
    expect(decryptCredentialValue(keys, binding, envelope)).toBe(secret);
  });

  it("never writes the value into the envelope", () => {
    const keys = keyring("k1", [["k1", 1]]);

    expect(encryptCredentialValue(keys, binding, secret)).not.toContain(secret);
  });

  it("derives a fresh salt and IV for every write", () => {
    const keys = keyring("k1", [["k1", 1]]);
    const first = encryptCredentialValue(keys, binding, secret);
    const second = encryptCredentialValue(keys, binding, secret);

    expect(first).not.toBe(second);
    expect(first.split(":")[2]).not.toBe(second.split(":")[2]);
  });

  it("binds a bot secret to its bot, so another bot's row cannot read it", () => {
    const keys = keyring("k1", [["k1", 1]]);
    const botBinding = { spaceId: "space-1", botId: "bot-1", name: "example_api" };
    const envelope = encryptCredentialValue(keys, botBinding, secret);

    expect(decryptCredentialValue(keys, botBinding, envelope)).toBe(secret);
    expect(() => decryptCredentialValue(keys, { ...botBinding, botId: "bot-2" }, envelope)).toThrow(
      CredentialStoreError,
    );
    expect(() =>
      decryptCredentialValue(keys, { spaceId: "space-1", name: "example_api" }, envelope),
    ).toThrow(CredentialStoreError);
  });

  it("keeps a space credential's AAD unchanged, so pre-bot-secret rows still decrypt", () => {
    const keys = keyring("k1", [["k1", 1]]);
    const envelope = encryptCredentialValue(keys, binding, secret);

    expect(decryptCredentialValue(keys, { spaceId: "space-1", name: "model-key" }, envelope)).toBe(
      secret,
    );
    expect(() =>
      decryptCredentialValue(
        keys,
        { spaceId: "space-1", botId: "bot-1", name: "model-key" },
        envelope,
      ),
    ).toThrow(CredentialStoreError);
  });

  it("refuses an envelope presented for another row", () => {
    const keys = keyring("k1", [["k1", 1]]);
    const envelope = encryptCredentialValue(keys, binding, secret);

    expect(() =>
      decryptCredentialValue(keys, { spaceId: "space-1", name: "other-key" }, envelope),
    ).toThrow(CredentialStoreError);

    expect(() =>
      decryptCredentialValue(keys, { spaceId: "space-2", name: "model-key" }, envelope),
    ).toThrow(CredentialStoreError);
  });

  it("names the row binding in the failure without echoing the value", () => {
    const keys = keyring("k1", [["k1", 1]]);
    const envelope = encryptCredentialValue(keys, binding, secret);
    const error = (() => {
      try {
        decryptCredentialValue(keys, { spaceId: "space-1", name: "other" }, envelope);
        return undefined;
      } catch (thrown) {
        return thrown;
      }
    })();

    expect(error).toBeInstanceOf(CredentialStoreError);
    expect((error as CredentialStoreError).reason).toBe("corrupt");
    expect(JSON.stringify(error)).not.toContain(secret);
    expect((error as Error).message).not.toContain(secret);
  });

  it("refuses a ciphertext whose bytes were changed", () => {
    const keys = keyring("k1", [["k1", 1]]);
    const parts = encryptCredentialValue(keys, binding, secret).split(":");
    const ciphertext = parts[5] ?? "";
    parts[5] = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;

    expect(() => decryptCredentialValue(keys, binding, parts.join(":"))).toThrow(
      CredentialStoreError,
    );
  });

  it("refuses a malformed envelope without echoing it", () => {
    const keys = keyring("k1", [["k1", 1]]);

    for (const envelope of ["", "not-an-envelope", "v2:k1:aaaa:bbbb:cccc:dddd", "v1:k1:aaaa"]) {
      const error = (() => {
        try {
          decryptCredentialValue(keys, binding, envelope);
          return undefined;
        } catch (thrown) {
          return thrown as CredentialStoreError;
        }
      })();

      expect(error?.reason, envelope).toBe("corrupt");
      expect(error?.message, envelope).not.toContain(envelope === "" ? "unmatchable" : envelope);
    }
  });
});

describe("a two-key keyring", () => {
  it("decrypts rows written under either key", () => {
    const before = keyring("k1", [["k1", 1]]);
    const envelope = encryptCredentialValue(before, binding, secret);
    const after = keyring("k2", [
      ["k1", 1],
      ["k2", 2],
    ]);

    expect(decryptCredentialValue(after, binding, envelope)).toBe(secret);
  });

  it("writes new rows under the active key", () => {
    const after = keyring("k2", [
      ["k1", 1],
      ["k2", 2],
    ]);

    expect(encryptCredentialValue(after, binding, secret).startsWith("v1:k2:")).toBe(true);
  });

  it("keeps decrypting a re-encrypted row after the old key is dropped", () => {
    const before = keyring("k1", [["k1", 1]]);
    const envelope = encryptCredentialValue(before, binding, secret);
    const after = keyring("k2", [
      ["k1", 1],
      ["k2", 2],
    ]);
    const rotated = encryptCredentialValue(
      after,
      binding,
      decryptCredentialValue(after, binding, envelope),
    );
    const nextDeployment = keyring("k2", [["k2", 2]]);

    expect(decryptCredentialValue(nextDeployment, binding, rotated)).toBe(secret);
  });

  it("answers unknown_key for a key the ring does not hold", () => {
    const envelope = encryptCredentialValue(keyring("k1", [["k1", 1]]), binding, secret);
    const error = (() => {
      try {
        decryptCredentialValue(keyring("k9", [["k9", 9]]), binding, envelope);
        return undefined;
      } catch (thrown) {
        return thrown as CredentialStoreError;
      }
    })();

    expect(error?.reason).toBe("unknown_key");
    expect(error?.keyId).toBe("k1");
    expect(error?.message).not.toContain(secret);
  });
});

describe("the keyring", () => {
  it("refuses ids that cannot live in an envelope", () => {
    for (const id of ["", "k:1", "k 1", "k".repeat(33)]) {
      expect(() => keyring(id, [[id, 1]])).toThrow(/credential key id/);
    }
  });

  it("refuses a key that is not 32 bytes and names no material", () => {
    const short = Buffer.alloc(16, 1).toString("base64");
    const error = (() => {
      try {
        createCredentialKeyring({ activeKeyId: "k1", keys: [{ id: "k1", key: short }] });
        return undefined;
      } catch (thrown) {
        return thrown as Error;
      }
    })();

    expect(error?.message).toContain("k1");
    expect(error?.message).not.toContain(short);
  });

  it("refuses duplicate ids, an empty ring and an active key outside it", () => {
    expect(() =>
      createCredentialKeyring({
        activeKeyId: "k1",
        keys: [
          { id: "k1", key: base64Key(1) },
          { id: "k1", key: base64Key(2) },
        ],
      }),
    ).toThrow(/appears twice/);

    expect(() => createCredentialKeyring({ activeKeyId: "k1", keys: [] })).toThrow(/holds no keys/);

    expect(() => keyring("k2", [["k1", 1]])).toThrow(/active credential key/);
  });

  it("parses a deployment's environment, trimming both variables", () => {
    const keys = credentialKeyringFromEnvironment({
      PORKBOT_CREDENTIAL_KEYS: ` k1:${base64Key(1)} , k2:${base64Key(2)} `,
      PORKBOT_CREDENTIAL_ACTIVE_KEY: " k2 ",
    });

    expect(keys.activeKeyId).toBe("k2");
    expect([...keys.keys.keys()]).toEqual(["k1", "k2"]);
  });

  it("fails closed when either variable is missing or malformed", () => {
    expect(() => credentialKeyringFromEnvironment({})).toThrow(/PORKBOT_CREDENTIAL_KEYS/);
    expect(() =>
      credentialKeyringFromEnvironment({ PORKBOT_CREDENTIAL_KEYS: `k1:${base64Key(1)}` }),
    ).toThrow(/PORKBOT_CREDENTIAL_ACTIVE_KEY/);
    expect(() =>
      credentialKeyringFromEnvironment({
        PORKBOT_CREDENTIAL_KEYS: "k1",
        PORKBOT_CREDENTIAL_ACTIVE_KEY: "k1",
      }),
    ).toThrow(/id:base64key/);
  });
});

describe("the mask", () => {
  it("shows a fixed marker and the last four characters, never the value", () => {
    const mask = maskCredentialValue(secret);

    expect(mask).toBe(`••••${secret.slice(-4)}`);
    expect(mask).not.toContain(secret);
    expect(secret).not.toContain(mask);
  });

  it("shows nothing but the marker for a value too short to partly hide", () => {
    expect(maskCredentialValue("short")).toBe("••••");
    expect(maskCredentialValue("")).toBe("••••");
  });
});
