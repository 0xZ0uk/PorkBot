import { describe, expect, it } from "vitest";
import { setupPage } from "./setup-page.ts";

/**
 * The first-run page is the one surface outside the web build, so it proves the
 * same things the shell does: the tokens' two modes, the explicit override and
 * the pre-paint script. The proxy suite proves the page is served with the
 * shell's content security policy.
 */

describe("the desktop setup page", () => {
  it("still asks for the server address", () => {
    expect(setupPage).toContain("Connect PorkBot");
    expect(setupPage).toContain('id="origin"');
  });

  it("draws the theme from the tokens in both modes", () => {
    expect(setupPage).toContain(":root{color-scheme:light;");
    expect(setupPage).toContain("@media (prefers-color-scheme:dark)");
    expect(setupPage).toContain('[data-theme="dark"]');
    expect(setupPage).toContain("--pb-color-accent:");
  });

  it("applies a stored mode choice before the page paints", () => {
    expect(setupPage).toContain("dataset.theme");
    expect(setupPage).toContain("porkbot.theme");
  });

  it("spaces the page from the scale rather than literals", () => {
    expect(setupPage).toContain("padding: var(--pb-space-sm)");
    expect(setupPage).toContain("gap: var(--pb-space-sm)");
    expect(setupPage).not.toMatch(/(?:padding|gap|margin):[^;]*\b0?\.\d+rem/);
  });
});
