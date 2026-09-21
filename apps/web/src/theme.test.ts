import { describe, expect, it } from "vitest";
import { themeBootstrapScript, themeStorageKey, themeStyleSheet } from "./theme.ts";

/**
 * The shell's half of the theme: the tokens' mode-aware properties plus the
 * document rules. The palette and the mode policy are the tokens package's and
 * are measured there; this suite proves the shell wires them into the sheet and
 * the first paint.
 */

describe("the shell theme", () => {
  it("carries every mode's properties and the explicit override", () => {
    expect(themeStyleSheet).toContain(":root{color-scheme:light;");
    expect(themeStyleSheet).toContain("@media (prefers-color-scheme:dark)");
    expect(themeStyleSheet).toContain('[data-theme="light"]');
    expect(themeStyleSheet).toContain('[data-theme="dark"]');
    expect(themeStyleSheet).toContain("--pb-color-accent:");
  });

  it("draws the document rules from the tokens", () => {
    expect(themeStyleSheet).toContain("background:var(--pb-color-background)");
    expect(themeStyleSheet).toContain("font-size:var(--pb-type-body-size)");
    expect(themeStyleSheet).toContain("line-height:var(--pb-type-body-line-height)");
    expect(themeStyleSheet).toContain("outline:2px solid var(--pb-color-accent)");
  });

  it("carries the register's component rules and their states", () => {
    expect(themeStyleSheet).toContain(".pb-button{");
    expect(themeStyleSheet).toContain(".pb-input,.pb-textarea,.pb-select{");
    expect(themeStyleSheet).toContain(".pb-button:focus-visible");
  });

  it("ships the pre-paint mode script with the key it reads", () => {
    expect(themeBootstrapScript).toContain(themeStorageKey);
    expect(themeBootstrapScript).toContain("dataset.theme");
  });
});
