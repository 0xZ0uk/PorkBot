import { describe, expect, it } from "vitest";
import {
  colors,
  cssCustomProperties,
  font,
  moduleInfo,
  palette,
  radius,
  space,
  srgbPrimary,
} from "./index.ts";

describe("@porkbot/tokens", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe("@porkbot/tokens");
  });

  it("declares the same colour slots in both modes", () => {
    expect(Object.keys(palette.light)).toEqual(Object.keys(palette.dark));
  });

  it("exposes colour, spacing and radius scales", () => {
    expect(palette.light.primary).toMatch(/^oklch\(/);
    expect(Object.keys(space).length).toBeGreaterThan(0);
    expect(radius.md).toBeTruthy();
    expect(font.mono).toContain("JetBrains Mono");
  });

  it("turns a camelCase slot into its custom property name", () => {
    expect(cssCustomProperties("color", { cardForeground: "red", chart1: "blue" })).toBe(
      "--pb-color-card-foreground:red;--pb-color-chart-1:blue;",
    );
  });

  it("points every runtime colour at the property the palette declares", () => {
    expect(Object.keys(colors)).toEqual(Object.keys(palette.light));
    expect(colors.cardForeground).toBe("var(--pb-color-card-foreground)");
    expect(colors.chart1).toBe("var(--pb-color-chart-1)");
  });

  it("keeps the sRGB brand literal on the primary's own hue", () => {
    expect(srgbPrimary).toBe("#3b82f6");
  });
});
