import { defineConfig } from "@porkbot/eslint-config/base";

export default [
  ...defineConfig({ package: "@porkbot/desktop" }),
  {
    // The sandboxed preload is CommonJS by Electron's contract, so it must use
    // `require` where an ESM import would be a parse error at runtime. This is
    // the one file and the one rule (slice 11.6).
    name: "porkbot/desktop/sandboxed-preload",
    files: ["src/preload.cts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
];
