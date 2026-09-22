import { describe, expect, it } from "vitest";
import { themeBootstrapScript, themeStorageKey, themeStyleSheet } from "./theme.ts";
import { readFileSync } from "node:fs";

/**
 * The shell's half of the theme: the token bootstrap and the Tailwind entry.
 * The palette and the mode policy are the tokens package's and are measured
 * there; this suite proves the shell wires them into the first paint and into
 * `globals.css`, where the Tailwind theme reads them.
 */

const globals = readFileSync(new URL("./globals.css", import.meta.url), "utf8");

describe("the shell theme", () => {
  it("carries every mode's properties and the explicit override", () => {
    expect(themeStyleSheet).toContain(":root{color-scheme:light;");
    expect(themeStyleSheet).toContain("@media (prefers-color-scheme:dark)");
    expect(themeStyleSheet).toContain('[data-theme="light"]');
    expect(themeStyleSheet).toContain('[data-theme="dark"]');
    expect(themeStyleSheet).toContain("--pb-color-accent:");
  });

  it("emits the shadcn semantic variables alongside the palette", () => {
    for (const name of ["background", "foreground", "primary", "ring", "sidebar"]) {
      expect(themeStyleSheet).toContain(`--${name}:`);
    }
    expect(themeStyleSheet).toContain("--sidebar-accent:");
    expect(themeStyleSheet).toContain("--radius:");
  });

  it("maps those variables into the Tailwind theme rather than restating them", () => {
    expect(globals).toContain('@import "tailwindcss";');
    expect(globals).toContain("@theme inline {");
    for (const name of [
      "background",
      "foreground",
      "card",
      "primary",
      "muted-foreground",
      "border",
      "ring",
      "sidebar",
      "sidebar-accent",
    ]) {
      expect(globals).toContain(`--color-${name}: var(--${name});`);
    }
  });

  it("draws the document rules from the tokens, in the base layer", () => {
    expect(globals).toContain("@layer base {");
    expect(globals).toContain("background: var(--background);");
    expect(globals).toContain("font-family: var(--pb-font-sans);");
    expect(globals).toContain("font-size: var(--pb-type-body-size);");
    expect(globals).toContain("outline: 2px solid var(--ring);");
  });

  it("carries the register's component rules and their states", () => {
    expect(globals).toContain("font-family: var(--pb-font-sans);");
  });

  it("ships the pre-paint mode script with the key it reads", () => {
    expect(themeBootstrapScript).toContain(themeStorageKey);
    expect(themeBootstrapScript).toContain("dataset.theme");
  });
});
