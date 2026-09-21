/**
 * The UI colour rule from AGENTS.md: a surface draws from the semantic tokens in
 * `@porkbot/tokens`, never from a colour literal. A hardcoded hex survives
 * review often enough that the rule is worth a lint rule rather than a
 * convention, and `test/ui-colors.test.mjs` proves it still fires.
 *
 * `@porkbot/tokens` is deliberately not a surface package: it is where the
 * literal colours are defined, so the rule would only flag the one file they
 * belong in. The selectors are assembled with the register's markup rule in
 * `ui-register.js`, which is the single config a surface gets; this module is
 * the colour half.
 */

export const uiSurfacePackages = [
  "@porkbot/ui",
  "@porkbot/web",
  "@porkbot/desktop",
  "@porkbot/www",
];

const hexColor = /#[0-9a-fA-F]{3,8}\b/;
const functionalColor = /\b(?:rgb|rgba|hsl|hsla|oklch|oklab)\(/;

export function uiColorSelectors(packageName) {
  const message =
    `Hardcoded colour in "${packageName}": import the semantic tokens from ` +
    `"@porkbot/tokens" instead. AGENTS.md (UI) makes this a lint rule so a theme ` +
    "change stays one file.";

  return [
    { selector: `Literal[value=/${hexColor.source}/]`, message },
    { selector: `Literal[value=/${functionalColor.source}/]`, message },
    { selector: `TemplateElement[value.raw=/${hexColor.source}/]`, message },
  ];
}
