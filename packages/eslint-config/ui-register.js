/**
 * The component register rule from AGENTS.md (UI): a surface composes the
 * primitives in `@porkbot/ui`, and hand-rolling the markup a primitive owns
 * (its element or its chrome class) is a lint failure. It is the same shape as
 * the module map — one register in one file, a fixture per entry proving the
 * rule fires, and a test tying the register's component names to the package's
 * exports — so bypassing the design system is visible in CI rather than in
 * review.
 *
 * `registeredMarkup` is the whole definition. An element entry owns a JSX
 * element; a class-name entry owns a class token in a `className` literal or
 * template; `registerClassPrefix` owns the register's own `pb-` namespace, so
 * a surface cannot spell a primitive's class instead of importing it. The rule
 * reads JSX, which is every screen a React surface ships; the desktop's
 * pre-app connect page is a plain HTML string with no component to import and
 * is deliberately outside it.
 *
 * The rule is assembled here together with the colour selectors because a
 * surface shows `no-restricted-syntax` one rule: two config objects setting it
 * would silently replace one another, which is the failure mode this module
 * exists to avoid.
 */

import { testFilePatterns } from "./module-boundaries.js";
import { typescriptSourceFiles } from "./source-files.js";
import { uiColorSelectors, uiSurfacePackages } from "./ui-colors.js";

/** The register's own class namespace; a surface must never write one. */
export const registerClassPrefix = "pb-";

/**
 * The markup each primitive owns. `components` names the imports a surface
 * should use; `ui-register.test.mjs` fails when one of them is not exported by
 * `@porkbot/ui`, so the register cannot drift from the package.
 */
export const registeredMarkup = [
  { kind: "element", name: "button", components: ["Button", "IconButton"] },
  { kind: "element", name: "input", components: ["Input"] },
  { kind: "element", name: "select", components: ["Select"] },
  { kind: "element", name: "textarea", components: ["Textarea"] },
  { kind: "class-name", name: "card", components: ["Card"] },
  { kind: "class-name", name: "field", components: ["Field"] },
  { kind: "class-name", name: "field-error", components: ["Field"] },
];

function importHint(subject, components, packageName) {
  return (
    `Hand-rolled ${subject} in "${packageName}": import ${components.join(" or ")} ` +
    'from "@porkbot/ui" instead. AGENTS.md (UI) makes the register the only chrome.'
  );
}

/** The class-token regex: a whole token, not a suffix of another class. */
function classTokenPattern(name) {
  return `(?:^|\\s)${name}(?:\\s|$)`;
}

function classAttributeSelectors(name, components, packageName) {
  const message = importHint(`"${name}" markup`, components, packageName);
  const pattern = classTokenPattern(name);

  return [
    {
      selector: `JSXAttribute[name.name="className"] Literal[value=/${pattern}/]`,
      message,
    },
    {
      selector: `JSXAttribute[name.name="className"] TemplateElement[value.raw=/${pattern}/]`,
      message,
    },
  ];
}

export function registerSelectors(packageName) {
  const selectors = [];

  for (const entry of registeredMarkup) {
    if (entry.kind === "element") {
      selectors.push({
        selector: `JSXOpeningElement[name.name="${entry.name}"]`,
        message: importHint(`<${entry.name}>`, entry.components, packageName),
      });
    } else {
      selectors.push(...classAttributeSelectors(entry.name, entry.components, packageName));
    }
  }

  const namespaceMessage =
    `The register's "${registerClassPrefix}" class namespace in "${packageName}": ` +
    'import the component from "@porkbot/ui" instead of writing the class. ' +
    "AGENTS.md (UI) makes the register the only chrome.";

  selectors.push(
    {
      selector: `JSXAttribute[name.name="className"] Literal[value=/(?:^|\\s)${registerClassPrefix}/]`,
      message: namespaceMessage,
    },
    {
      selector: `JSXAttribute[name.name="className"] TemplateElement[value.raw=/(?:^|\\s)${registerClassPrefix}/]`,
      message: namespaceMessage,
    },
  );

  return selectors;
}

/**
 * The one config a UI surface gets: the colour rule plus, for every surface but
 * the register itself, the register rule.
 */
export function uiSurfaceConfigsFor(packageName) {
  if (!uiSurfacePackages.includes(packageName)) {
    return [];
  }

  const register = packageName === "@porkbot/ui" ? [] : registerSelectors(packageName);

  return [
    {
      name: `porkbot/ui-rules/${packageName}`,
      files: typescriptSourceFiles,
      ignores: testFilePatterns,
      rules: {
        "no-restricted-syntax": ["error", ...uiColorSelectors(packageName), ...register],
      },
    },
  ];
}
