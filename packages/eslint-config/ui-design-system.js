/**
 * The design-system rules from AGENTS.md (UI): a surface composes the
 * primitives in `@porkbot/ui` and styles them through the Tailwind theme, and
 * `@shadcn/lint` is what turns that into a check rather than a wish.
 *
 * The two bespoke blocks this replaces — `ui-register.js` (hand-rolled markup)
 * and `ui-colors.js` (hardcoded colour) — each grew its own selector table and
 * its own fixtures. This module registers one plugin and names the six rules
 * AGENTS.md points at, so the error a surface gets names the fix: a restyling
 * class is answered with the variant to use, an unknown class with the class
 * Tailwind would generate.
 *
 * The rules are scoped to the four UI surfaces, turned off inside the register
 * (which styles its own internals) and turned off in test files, which assert
 * on markup rather than ship it. Everything not yet on the new stack is named
 * in `preSweepPaths`, and issue #283 deletes that override as it sweeps.
 */

import { plugin as shadcn } from "@shadcn/lint";
import { testFilePatterns } from "./module-boundaries.js";
import { typescriptSourceFiles } from "./source-files.js";

export const uiSurfacePackages = [
  "@porkbot/ui",
  "@porkbot/web",
  "@porkbot/desktop",
  "@porkbot/www",
];

/** Every rule this module registers, so a caller can turn the set off as one. */
export const shadcnRuleIds = [
  "shadcn/no-restyle",
  "shadcn/no-raw-colors",
  "shadcn/no-arbitrary-values",
  "shadcn/no-inline-styles",
  "shadcn/no-unknown-classes",
  "shadcn/require-static-classes",
];

/**
 * The surfaces that still carry their pre-migration class strings. The screen
 * sweep (issue #283) converts them to Tailwind utilities composed with the
 * register and deletes this list; until then their custom classes and inline
 * widths are the old stack's chrome, not a new restyle.
 */
export const preSweepPaths = [
  // The globs are relative to whichever root ESLint runs from: the repo root
  // (the fixture tests) or the package directory (its `lint` script).
  "**/src/screens/**",
  "**/settings-sections.tsx",
];

export function uiSurfaceConfigsFor(packageName) {
  if (!uiSurfacePackages.includes(packageName)) {
    return [];
  }

  return [
    {
      name: "porkbot/ui-design-system",
      files: typescriptSourceFiles,
      languageOptions: {
        parserOptions: { ecmaFeatures: { jsx: true } },
      },
      plugins: { shadcn },
      settings: {
        shadcn: {
          ui: "@porkbot/ui",
          componentImports: ["^@porkbot/ui$"],
          note: "AGENTS.md (UI): compose @porkbot/ui and style with the theme's classes.",
        },
      },
      rules: {
        // Appearance lives in a variant or in the theme; a caller may still
        // place a component, which is what `layout` allows.
        "shadcn/no-restyle": ["error", { allow: ["layout"] }],
        "shadcn/no-raw-colors": "error",
        "shadcn/no-arbitrary-values": "error",
        // Width and height are a size the caller chooses — a skeleton bar's
        // length, a usage bar's fill — and no class token carries them.
        "shadcn/no-inline-styles": ["error", { allow: ["width", "height", "maxHeight"] }],
        // `pb-*` is the register's own class namespace, declared in
        // `packages/ui/src/style-sheet.ts` rather than by Tailwind. Slice 2
        // rebuilds the register on Tailwind classes and drops this entry.
        "shadcn/no-unknown-classes": ["error", { allow: ["pb-*"] }],
        "shadcn/require-static-classes": "error",
      },
    },
    {
      name: "porkbot/ui-design-system/register",
      // The register styles its own internals: its variants are the class
      // strings these rules would otherwise ask a surface to stop writing.
      files: ["packages/ui/src/**", "src/**"],
      rules: {
        "shadcn/no-restyle": "off",
        "shadcn/no-arbitrary-values": "off",
        "shadcn/require-static-classes": "off",
      },
    },
    {
      name: "porkbot/ui-design-system/pre-sweep",
      // Issue #283 sweeps these screens and deletes this override. The rules
      // it relaxes are the ones a hand-rolled class string trips; the colour
      // and arbitrary-value rules stay on here.
      files: preSweepPaths,
      rules: {
        "shadcn/no-restyle": "off",
        "shadcn/no-inline-styles": "off",
        "shadcn/no-unknown-classes": "off",
        "shadcn/require-static-classes": "off",
      },
    },
    {
      name: "porkbot/ui-design-system/first-paint",
      // The shell inlines the token sheet so the first paint is already in the
      // right mode, and the desktop's proxy stamps the nonce
      // `apps/desktop/src/hardening.test.ts` asserts. `no-inline-styles` treats
      // every `<style>` as a leak, including this one.
      files: ["**/routes/__root.tsx"],
      rules: { "shadcn/no-inline-styles": "off" },
    },
    {
      name: "porkbot/ui-design-system/tests",
      files: testFilePatterns,
      rules: Object.fromEntries(shadcnRuleIds.map((ruleId) => [ruleId, "off"])),
    },
  ];
}
