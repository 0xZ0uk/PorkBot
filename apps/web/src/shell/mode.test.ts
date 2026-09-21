import { themeStorageKey } from "@porkbot/tokens";
import { describe, expect, it } from "vitest";
import { applyMode, modeLabel, modes, readChoice, readMode, resolveMode } from "./mode.ts";

/**
 * The shell's mode choice: System, Light, Dark. The stored key is the choice —
 * including System, which leaves `data-theme` unset so the media query decides
 * — and the next first paint reads the same key. These cases pin the choice to
 * the paint, because "the control persists and wins" is the slice's point.
 */

describe("the shell's mode control", () => {
  it("resolves System to the system preference and keeps an explicit choice", () => {
    expect(resolveMode("system", true)).toBe("dark");
    expect(resolveMode("system", false)).toBe("light");
    expect(resolveMode("dark", false)).toBe("dark");
    expect(resolveMode("light", true)).toBe("light");
  });

  it("reads an explicit attribute as the choice and its absence as System", () => {
    expect(readChoice({ dataset: { theme: "dark" } })).toBe("dark");
    expect(readChoice({ dataset: { theme: "light" } })).toBe("light");
    expect(readChoice({ dataset: {} })).toBe("system");
    expect(readChoice({ dataset: { theme: "sepia" } })).toBe("system");
  });

  it("prefers an explicit choice over the system preference", () => {
    expect(readMode({ dataset: { theme: "dark" } }, false)).toBe("dark");
    expect(readMode({ dataset: { theme: "light" } }, true)).toBe("light");
    expect(readMode({ dataset: {} }, true)).toBe("dark");
    expect(readMode({ dataset: {} }, false)).toBe("light");
  });

  it("names every choice", () => {
    expect(modes.map(modeLabel)).toEqual(["System", "Light", "Dark"]);
  });

  it("writes an explicit choice to the document and the stored key", () => {
    const written: [string, string][] = [];
    const root = { dataset: {} as { theme?: string } };

    applyMode(root, { setItem: (key, value) => written.push([key, value]) }, "dark");
    expect(root.dataset.theme).toBe("dark");
    expect(written).toEqual([[themeStorageKey, "dark"]]);

    applyMode(root, { setItem: (key, value) => written.push([key, value]) }, "light");
    expect(root.dataset.theme).toBe("light");
    expect(written).toEqual([
      [themeStorageKey, "dark"],
      [themeStorageKey, "light"],
    ]);
  });

  it("stores System and clears the attribute, so the media query decides again", () => {
    const written: [string, string][] = [];
    const root = { dataset: { theme: "dark" } as { theme?: string } };

    applyMode(root, { setItem: (key, value) => written.push([key, value]) }, "system");

    expect(root.dataset.theme).toBeUndefined();
    expect(written).toEqual([[themeStorageKey, "system"]]);
  });

  it("applies the choice even when the stored write refuses", () => {
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

    expect(() => {
      applyMode(
        root,
        {
          setItem: () => {
            throw new Error("blocked");
          },
        },
        "system",
      );
    }).not.toThrow();
    expect(root.dataset.theme).toBeUndefined();
  });
});
