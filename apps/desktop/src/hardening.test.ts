import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runEventChannel } from "./bridge.ts";
import {
  HARDENED_WEB_PREFERENCES,
  applyContentSecurityNonce,
  assertHardened,
  contentSecurityPolicyFor,
  createContentSecurityNonce,
  hardenWebPreferences,
  hardeningViolations,
} from "./hardening.ts";

/**
 * The hardening contract is only a contract if something fails when a window
 * relaxes it. This suite asserts the flag table, the policy and — at the end —
 * the shipped source itself: `main.ts` is the only file allowed to construct a
 * `BrowserWindow`, and the preload's channel literal and the main process's
 * channel constant must be the same string.
 */

const packageDir = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const sourceDir = path.join(packageDir, "src");
const repoRoot = path.resolve(packageDir, "..", "..");

function shippedSources(): string[] {
  return readdirSync(sourceDir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();
}

const preloadPath = "/porkbot/dist/preload.cjs";

describe("the window flag table", () => {
  it("turns isolation on and integration off", () => {
    expect(HARDENED_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(HARDENED_WEB_PREFERENCES.sandbox).toBe(true);
    expect(HARDENED_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.nodeIntegrationInWorker).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.nodeIntegrationInSubFrames).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.webSecurity).toBe(true);
    expect(HARDENED_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.experimentalFeatures).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.webviewTag).toBe(false);
    expect(HARDENED_WEB_PREFERENCES.navigateOnDragDrop).toBe(false);
  });

  it("builds preferences that carry the preload and nothing the caller chooses", () => {
    const preferences = hardenWebPreferences({ preload: preloadPath, backgroundThrottling: false });

    expect(preferences.preload).toBe(preloadPath);
    expect(preferences.contextIsolation).toBe(true);
    expect(preferences.sandbox).toBe(true);
    expect(hardeningViolations(preferences)).toEqual([]);
    expect(() => {
      assertHardened(preferences);
    }).not.toThrow();
  });

  it("names every relaxed flag and refuses the window", () => {
    const relaxed = {
      ...hardenWebPreferences({ preload: preloadPath, backgroundThrottling: false }),
      contextIsolation: false,
      nodeIntegration: true,
    };

    expect(hardeningViolations(relaxed)).toEqual(["contextIsolation", "nodeIntegration"]);
    expect(() => {
      assertHardened(relaxed);
    }).toThrow(/contextIsolation/);
  });

  it("refuses a window with no preload", () => {
    expect(hardeningViolations({ ...HARDENED_WEB_PREFERENCES, preload: "" })).toEqual(["preload"]);
  });
});

describe("the content security policy", () => {
  const fixture = [
    "<!doctype html><html><head>",
    "<style>body { color: inherit }</style>",
    "</head><body>",
    '<script>console.log("hydrate")</script>',
    '<script type="module" src="/assets/index-abc.js"></script>',
    "</body></html>",
  ].join("");

  it("mints a fresh, unguessable nonce per document", () => {
    const first = createContentSecurityNonce();
    const second = createContentSecurityNonce();

    expect(first).not.toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(20);
  });

  it("names only the nonce and the app's own origin in the script and style policy", () => {
    const policy = contentSecurityPolicyFor("test-nonce");

    expect(policy).toContain("script-src 'self' 'nonce-test-nonce'");
    expect(policy).toContain("style-src 'self' 'nonce-test-nonce'");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-inline");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("stamps the nonce on inline scripts and styles and leaves a bundle alone", () => {
    const stamped = applyContentSecurityNonce(fixture, "test-nonce");

    expect(stamped).toContain('<style nonce="test-nonce">');
    expect(stamped).toContain('<script nonce="test-nonce">console.log("hydrate")</script>');
    expect(stamped).toContain('<script type="module" src="/assets/index-abc.js"></script>');
    expect(stamped).not.toContain('src="/assets/index-abc.js" nonce=');
  });

  it("replaces a nonce a document already carried rather than doubling it", () => {
    const stamped = applyContentSecurityNonce('<script nonce="stale">x</script>', "fresh");

    expect(stamped).toBe('<script nonce="fresh">x</script>');
  });

  it("covers every inline script and style in the build the desktop packages", () => {
    const shellPath = path.join(repoRoot, "apps", "web", "dist", "client", "_shell.html");
    const shell = readFileSync(shellPath, "utf8");
    const stamped = applyContentSecurityNonce(shell, "build-nonce");

    const inlineTags = [...stamped.matchAll(/<script(?![^>]*\bsrc\s*=)[^>]*>/gi)].map(
      (match) => match[0],
    );
    const styleTags = [...stamped.matchAll(/<style[^>]*>/gi)].map((match) => match[0]);

    expect(
      inlineTags.length,
      "the shell must carry the inline scripts the policy covers",
    ).toBeGreaterThan(0);
    expect(styleTags.length, "the shell must carry the inlined token stylesheet").toBeGreaterThan(
      0,
    );

    for (const tag of [...inlineTags, ...styleTags]) {
      expect(tag, tag).toContain('nonce="build-nonce"');
    }

    // The shell's own hydration stream is the reason a hash policy cannot work:
    // its bytes contain a NUL the HTML parser rewrites, so the parser's text is
    // not the file's text and only a nonce matches what actually executes.
    expect(inlineTags.some((tag) => tag.includes("data-tsr-stream-part"))).toBe(true);
  });
});

describe("the shipped source", () => {
  const sources = shippedSources();

  it("constructs windows in main.ts only, from the hardened factory", () => {
    const constructors = sources.filter((name) =>
      readFileSync(path.join(sourceDir, name), "utf8").includes("new BrowserWindow("),
    );

    expect(constructors).toEqual(["main.ts"]);

    const main = readFileSync(path.join(sourceDir, "main.ts"), "utf8");

    expect(main).toContain("webPreferences: preferences");
    expect(main).toContain("hardenWebPreferences(");
    expect(main).toContain("assertHardened(preferences)");
  });

  it("names none of the hardening flags outside the table", () => {
    for (const name of sources) {
      if (name === "hardening.ts") {
        continue;
      }

      const source = readFileSync(path.join(sourceDir, name), "utf8");

      expect(source, `${name} must not set hardening flags itself`).not.toMatch(
        /\b(?:contextIsolation|nodeIntegration|sandbox|webSecurity)\s*:/,
      );
    }
  });

  it("keeps the preload's channel literal identical to the main process constant", () => {
    const preload = readFileSync(path.join(sourceDir, "preload.cts"), "utf8");

    expect(preload).toContain(`"${runEventChannel}"`);
  });

  it("does not disable the sandbox or open external content in a frame", () => {
    for (const name of sources) {
      const source = readFileSync(path.join(sourceDir, name), "utf8");

      expect(source, `${name} must not disable the sandbox`).not.toContain("sandbox: false");
      expect(source, `${name} must not enable node integration`).not.toContain(
        "nodeIntegration: true",
      );
      expect(source, `${name} must not allow insecure content`).not.toContain(
        "allowRunningInsecureContent: true",
      );
    }
  });
});
