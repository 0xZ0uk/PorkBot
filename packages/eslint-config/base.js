import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";
import turboPlugin from "eslint-plugin-turbo";
import globals from "globals";
import tseslint from "typescript-eslint";
import { boundaryConfigsFor } from "./module-boundaries.js";

const sourceFiles = ["**/*.ts", "**/*.tsx"];
const allFiles = [...sourceFiles, "**/*.js", "**/*.mjs", "**/*.cjs"];

// typescript-eslint's configs are not file-scoped. Scoping them to the
// TypeScript sources keeps the parser and the TS rule set off plain JS, where
// the `js.configs.recommended` equivalents apply instead.
const typescriptConfigs = tseslint.configs.strict.map((config) =>
  config.files === undefined ? { ...config, files: sourceFiles } : config,
);

/**
 * Builds the flat config for one workspace package. The package name selects
 * the boundary rules from the module map, so every package's eslint.config.js
 * is one call and cannot silently opt out.
 *
 * typescript-eslint runs against the TypeScript 6 API, which is the last
 * compiler version that exposes one: the workspace compiler is TypeScript 7
 * and @typescript-eslint refuses to run against it.
 */
export function defineConfig({ package: packageName }) {
  return [
    {
      name: "porkbot/ignores",
      ignores: ["dist/**", "coverage/**", ".turbo/**", "node_modules/**"],
    },
    js.configs.recommended,
    ...typescriptConfigs,
    {
      name: "porkbot/language-options",
      files: allFiles,
      languageOptions: {
        globals: {
          ...globals.node,
        },
      },
      plugins: {
        "import-x": importX,
        turbo: turboPlugin,
      },
      rules: {
        "turbo/no-undeclared-env-vars": "warn",
        "import-x/consistent-type-specifier-style": ["error", "prefer-top-level"],
        "import-x/no-relative-packages": "error",
      },
    },
    {
      name: "porkbot/typescript-imports",
      files: sourceFiles,
      rules: {
        "@typescript-eslint/consistent-type-imports": [
          "error",
          { prefer: "type-imports", fixStyle: "separate-type-imports" },
        ],
      },
    },
    ...boundaryConfigsFor(packageName),
    eslintConfigPrettier,
  ];
}
