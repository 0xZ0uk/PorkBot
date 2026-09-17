import { describe, expect, it } from "vitest";
import { colors, moduleInfo, radius, space } from "./index.ts";

describe("@porkbot/tokens", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe("@porkbot/tokens");
  });

  it("exposes colour, spacing and radius scales", () => {
    expect(colors.accent).toMatch(/^#/);
    expect(Object.keys(space).length).toBeGreaterThan(0);
    expect(radius.md).toBeTruthy();
  });
});
