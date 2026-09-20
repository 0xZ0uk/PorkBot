/**
 * The file globs every rule in this package is scoped to.
 *
 * TypeScript in this workspace is not all `.ts`: the desktop's sandboxed
 * preload is a CommonJS `.cts` file (slice 11.6), so the parser, the type-aware
 * rules and the boundary rules have to see it. Keeping the list here means a
 * new extension is one edit rather than four lists that drift.
 */

export const typescriptSourceFiles = ["**/*.ts", "**/*.tsx", "**/*.cts", "**/*.mts"];

export const allSourceFiles = [...typescriptSourceFiles, "**/*.js", "**/*.mjs", "**/*.cjs"];
