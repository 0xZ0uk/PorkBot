/**
 * The UI colour rule from AGENTS.md: a surface draws from the semantic tokens in
 * `@porkbot/tokens`, never from a colour literal. A hardcoded hex survives
 * review often enough that the rule is worth a lint rule rather than a
 * convention, and `test/ui-colors.test.mjs` proves it still fires.
 *
 * `@porkbot/tokens` is deliberately not a surface package: it is where the
 * literal colours are defined, so the rule would only flag the one file they
 * belong in.
 */

export const uiSurfacePackages = [
  "@porkbot/ui",
  "@porkbot/web",
  "@porkbot/desktop",
  "@porkbot/www",
];

const hexColor = /#[0-9a-fA-F]{3,8}\b/;
const functionalColor = /\b(?:rgb|rgba|hsl|hsla)\(/;

function colorSelectors(packageName) {
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

/**
 * Returns the colour rule for a UI surface, or nothing for a package the rule
 * does not govern. Kept beside the module map so a new surface is registered in
 * a reviewable list rather than inheriting the rule by accident.
 */
export function uiColorConfigsFor(packageName) {
  if (!uiSurfacePackages.includes(packageName)) {
    return [];
  }

  return [
    {
      name: `porkbot/ui-colors/${packageName}`,
      files: ["**/*.ts", "**/*.tsx"],
      rules: {
        "no-restricted-syntax": ["error", ...colorSelectors(packageName)],
      },
    },
  ];
}
