import { themeStorageKey } from "@porkbot/tokens";
import { describe, expect, it } from "vitest";
import { applyMode, readMode, toggled } from "./mode.ts";

describe("the shell's mode control", () => {
  it("prefers an explicit choice over the system preference", () => {
    expect(readMode({ dataset: { theme: "dark" } }, false)).toBe("dark");
    expect(readMode({ dataset: { theme: "light" } }, true)).toBe("light");
  });

  it("falls back to the system preference and then light", () => {
    expect(readMode({ dataset: {} }, true)).toBe("dark");
    expect(readMode({ dataset: {} }, false)).toBe("light");
    expect(readMode({ dataset: { theme: "sepia" } }, false)).toBe("light");
  });

  it("toggles between the two modes", () => {
    expect(toggled("dark")).toBe("light");
    expect(toggled("light")).toBe("dark");
  });

  it("writes the choice to the document and the stored key", () => {
    const written: [string, string][] = [];
    const root = { dataset: {} as { theme?: string } };

    applyMode(root, { setItem: (key, value) => written.push([key, value]) }, "dark");

    expect(root.dataset.theme).toBe("dark");
    expect(written).toEqual([[themeStorageKey, "dark"]]);
  });

  it("applies the mode even when the stored write refuses", () => {
    const root = { dataset: {} as { theme?: string } };

    expect(() => {
      applyMode(
        root,
        {
          setItem: () => {
            throw new Error("blocked");
          },
        },
        "light",
      );
    }).not.toThrow();
    expect(root.dataset.theme).toBe("light");
  });
});
