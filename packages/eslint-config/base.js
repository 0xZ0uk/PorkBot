import babelParser from "@babel/eslint-parser";
import js from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier";
import turboPlugin from "eslint-plugin-turbo";
import globals from "globals";

const typescriptRules = {
  "turbo/no-undeclared-env-vars": "warn",
  "constructor-super": "off",
  "getter-return": "off",
  "no-class-assign": "off",
  "no-const-assign": "off",
  "no-dupe-args": "off",
  "no-dupe-class-members": "off",
  "no-dupe-keys": "off",
  "no-func-assign": "off",
  "no-import-assign": "off",
  "no-new-native-nonconstructor": "off",
  "no-new-symbol": "off",
  "no-obj-calls": "off",
  "no-redeclare": "off",
  "no-setter-return": "off",
  "no-this-before-super": "off",
  "no-undef": "off",
  "no-unreachable": "off",
  "no-unsafe-negation": "off",
  "no-unused-vars": "off",
};

function typescriptLanguageOptions(parserPlugins = []) {
  return {
    parser: babelParser,
    parserOptions: {
      requireConfigFile: false,
      babelOptions: {
        presets: ["@babel/preset-typescript"],
        ...(parserPlugins.length > 0 ? { parserOpts: { plugins: parserPlugins } } : {}),
      },
    },
    globals: {
      ...globals.node,
    },
  };
}

export default [
  {
    ignores: ["dist/**", "coverage/**", ".turbo/**", "node_modules/**"],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: typescriptLanguageOptions(),
    plugins: {
      turbo: turboPlugin,
    },
    rules: typescriptRules,
  },
  {
    files: ["**/*.tsx"],
    languageOptions: typescriptLanguageOptions(["jsx"]),
    plugins: {
      turbo: turboPlugin,
    },
    rules: typescriptRules,
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  eslintConfigPrettier,
];
