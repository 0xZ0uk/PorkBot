import { describe, expect, it } from "vitest";
import { moduleInfo } from "./index.ts";
import { themeBootstrapScript, themeStyleSheet } from "./theme.ts";

describe("@porkbot/www", () => {
  it("identifies the package it ships as", () => {
    expect(moduleInfo.name).toBe("@porkbot/www");
  });

  it("carries the token bootstrap and the Tailwind entry", () => {
    expect(themeBootstrapScript).toContain("localStorage");
    expect(themeStyleSheet).toContain(":root{color-scheme:light;");
    expect(themeStyleSheet).toContain("--pb-color-accent:");
  });
});
