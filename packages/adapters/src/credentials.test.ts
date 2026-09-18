import { describe, expect, it } from "vitest";
import { createEnvironmentCredentialStore, createMemoryCredentialStore } from "./credentials.ts";

describe("the memory credential store", () => {
  it("resolves what was seeded and nothing else", async () => {
    const store = createMemoryCredentialStore([["mail-key", "key-1"]]);

    await expect(store.resolve("mail-key")).resolves.toBe("key-1");
    await expect(store.resolve("another-key")).resolves.toBeUndefined();
  });

  it("reflects a set value on the next resolution, so rotation is visible", async () => {
    const store = createMemoryCredentialStore();

    await expect(store.resolve("mail-key")).resolves.toBeUndefined();

    store.set("mail-key", "key-2");
    await expect(store.resolve("mail-key")).resolves.toBe("key-2");

    store.set("mail-key", "key-3");
    await expect(store.resolve("mail-key")).resolves.toBe("key-3");
  });

  it("deletes a value and reports whether it existed", async () => {
    const store = createMemoryCredentialStore([["mail-key", "key-1"]]);

    expect(store.delete("mail-key")).toBe(true);
    expect(store.delete("mail-key")).toBe(false);
    await expect(store.resolve("mail-key")).resolves.toBeUndefined();
  });
});

describe("the environment credential store", () => {
  it("resolves a variable by the name the operator chose", async () => {
    const store = createEnvironmentCredentialStore({ MAIL_API_KEY: "key-1" });

    await expect(store.resolve("MAIL_API_KEY")).resolves.toBe("key-1");
    await expect(store.resolve("UNSET_VARIABLE")).resolves.toBeUndefined();
  });

  it("treats an empty or blank variable as absent, so an empty key cannot authenticate", async () => {
    const store = createEnvironmentCredentialStore({ EMPTY: "", BLANK: "   " });

    await expect(store.resolve("EMPTY")).resolves.toBeUndefined();
    await expect(store.resolve("BLANK")).resolves.toBeUndefined();
  });

  it("trims surrounding whitespace a shell export can hide", async () => {
    const store = createEnvironmentCredentialStore({ PADDED: "  key-1  " });

    await expect(store.resolve("PADDED")).resolves.toBe("key-1");
  });
});
