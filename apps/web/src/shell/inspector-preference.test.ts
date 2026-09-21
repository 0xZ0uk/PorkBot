import { describe, expect, it } from "vitest";
import {
  inspectorPreferenceKey,
  readInspectorOpen,
  writeInspectorOpen,
} from "./inspector-preference.ts";

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map(Object.entries(initial));

  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

describe("the inspector preference", () => {
  it("is open until the operator closes it", () => {
    expect(readInspectorOpen(memoryStorage())).toBe(true);
    expect(readInspectorOpen(memoryStorage({ [inspectorPreferenceKey]: "open" }))).toBe(true);
    expect(readInspectorOpen(memoryStorage({ [inspectorPreferenceKey]: "closed" }))).toBe(false);
  });

  it("round-trips a choice", () => {
    const storage = memoryStorage();

    writeInspectorOpen(storage, false);
    expect(readInspectorOpen(storage)).toBe(false);

    writeInspectorOpen(storage, true);
    expect(readInspectorOpen(storage)).toBe(true);
  });

  it("keeps the default when there is no storage or it refuses", () => {
    const refusing: Pick<Storage, "getItem" | "setItem"> = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readInspectorOpen(undefined)).toBe(true);
    expect(readInspectorOpen(refusing)).toBe(true);
    expect(() => {
      writeInspectorOpen(refusing, false);
    }).not.toThrow();
    expect(() => {
      writeInspectorOpen(undefined, false);
    }).not.toThrow();
  });
});
