/**
 * The module map from the PRD (stack decision 15 and the module map section),
 * encoded as lint rules.
 *
 * Every package's eslint.config.js calls `defineConfig` with its own package
 * name; the boundary rules below are generated from this file. The map is
 * deliberately fail-closed: a package that is not registered here cannot import
 * another workspace package, and `workspace.test.mjs` fails when a workspace
 * package is missing from the map. Adding an import edge is therefore a
 * reviewable change to exactly one file.
 */

// Workspace packages and the workspace packages each one may import.
//
// `imports` is the production edge set: what the package ships may depend on.
// `testImports` is the same claim for test files and test configs, which is what
// keeps `@porkbot/testkit` (the test harness) out of shipped code while still
// letting every package's vitest config call the shared tier presets. Both are
// enforced: the production rule does not apply to test paths, and the test rule
// does not apply to anything else.
import { typescriptSourceFiles } from "./source-files.js";

export const workspacePackages = {
  "@porkbot/core": {
    role: "pure domain: rules, state machine, reducer, policies",
    imports: [],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/contracts": {
    role: "schemas and transport types",
    imports: ["@porkbot/core"],
    // The model-connections suite pins the probe's failure enum to the
    // provider vocabulary in @porkbot/adapter-kit, so the transport cannot
    // drift from the classification lifecycle code branches on. Test-only:
    // shipped contract code still names no adapter.
    testImports: ["@porkbot/testkit", "@porkbot/adapter-kit"],
  },
  "@porkbot/adapter-kit": {
    role: "provider interfaces only",
    imports: [],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/adapters": {
    role: "provider implementations and offline emulators",
    imports: [
      "@porkbot/adapter-kit",
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/effect",
      "@porkbot/logging",
    ],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/db": {
    role: "schema, migrations, actor-scoped repositories",
    imports: [
      "@porkbot/adapter-kit",
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/effect",
      "@porkbot/logging",
    ],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/auth": {
    role: "authentication gate and actor resolution",
    imports: [
      "@porkbot/adapter-kit",
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/db",
      "@porkbot/effect",
      "@porkbot/logging",
    ],
    // The auth integration suite drives reset and verification mail through the
    // shipped offline emulator (slice 3.5), with no key and no network. The
    // edge is test-only: shipped auth code still names adapter-kit alone.
    testImports: ["@porkbot/testkit", "@porkbot/adapters"],
  },
  "@porkbot/effect": {
    role: "shared layers, service tags, transport error mapping",
    imports: ["@porkbot/adapter-kit", "@porkbot/contracts", "@porkbot/core", "@porkbot/logging"],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/logging": {
    role: "JSON logs, levels, correlation ids, redaction",
    imports: [],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/health": {
    role: "health endpoints for always-on processes",
    imports: [],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/testkit": {
    role: "test policy (tier presets, quarantine ledger, dependency pins, flake reporter), emulators, harness",
    imports: [
      "@porkbot/adapter-kit",
      "@porkbot/adapters",
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/db",
      "@porkbot/logging",
    ],
  },
  "@porkbot/tokens": {
    role: "design tokens",
    imports: [],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/ui": {
    role: "design-system components",
    imports: ["@porkbot/tokens"],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/api": {
    role: "HTTP and streaming surface",
    imports: [
      "@porkbot/adapter-kit",
      "@porkbot/adapters",
      "@porkbot/auth",
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/db",
      "@porkbot/effect",
      "@porkbot/health",
      "@porkbot/logging",
    ],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/worker": {
    role: "durable jobs and the run executor",
    imports: [
      "@porkbot/adapter-kit",
      "@porkbot/adapters",
      "@porkbot/auth",
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/db",
      "@porkbot/effect",
      "@porkbot/health",
      "@porkbot/logging",
    ],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/supervisor": {
    role: "the Docker socket holder and owner of computer lifecycle",
    imports: [
      "@porkbot/adapter-kit",
      "@porkbot/adapters",
      "@porkbot/auth",
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/db",
      "@porkbot/effect",
      "@porkbot/health",
      "@porkbot/logging",
    ],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/web": {
    role: "static SPA surface",
    imports: [
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/health",
      "@porkbot/logging",
      "@porkbot/tokens",
      "@porkbot/ui",
    ],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/desktop": {
    role: "Electron client of the same API",
    // The desktop packages the web build's `dist/client` and serves it through
    // the same static handler the web image runs, so "one client build, one
    // host contract" is an import rather than a copy (slice 11.6).
    imports: [
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/tokens",
      "@porkbot/ui",
      "@porkbot/web",
    ],
    testImports: ["@porkbot/testkit"],
  },
  "@porkbot/www": {
    role: "public landing and documentation site",
    imports: ["@porkbot/tokens", "@porkbot/ui"],
    testImports: ["@porkbot/testkit"],
  },
  // Internal config packages are leaves: they configure the toolchain for the
  // packages that import them, so an edge back into the workspace would be a
  // cycle. That includes test configs: their own vitest configs repeat the unit
  // tier's numbers, and packages/testkit/test/tier-policy.test.ts fails if those
  // numbers drift.
  "@porkbot/eslint-config": {
    role: "internal lint tooling",
    imports: [],
  },
  "@porkbot/typescript-config": {
    role: "internal tsconfig bases",
    imports: [],
  },
};

// External libraries with a single owning layer. Every package that is not an
// owner is forbidden from importing them. `effect` is intentionally absent: the
// orchestration layer is used by api, worker, adapters and effect itself.
export const restrictedLibraries = [
  {
    category: "web framework",
    owners: ["@porkbot/api"],
    names: ["hono", "@hono/node-server"],
  },
  {
    // The contract and client half of oRPC: defining procedures and calling
    // them. It belongs with @porkbot/contracts, which is the single source of
    // transport truth, so a client package imports the contract rather than a
    // transport library (PRD decisions 14 and 15).
    category: "oRPC contract and client library",
    owners: ["@porkbot/contracts"],
    names: ["@orpc/contract", "@orpc/client"],
  },
  {
    // The server half: implementing the contract, matching requests, and
    // generating the OpenAPI document. It belongs to the HTTP surface.
    category: "oRPC server and OpenAPI library",
    owners: ["@porkbot/api"],
    names: ["@orpc/server", "@orpc/openapi", "@orpc/zod"],
  },
  {
    category: "React UI library",
    owners: ["@porkbot/ui", "@porkbot/web", "@porkbot/desktop", "@porkbot/www"],
    names: ["react", "react-dom"],
  },
  {
    category: "database driver or ORM",
    owners: ["@porkbot/db", "@porkbot/testkit"],
    names: ["drizzle-orm", "drizzle-kit", "pg", "postgres"],
  },
  {
    category: "durable job runner",
    owners: ["@porkbot/worker"],
    names: ["graphile-worker"],
  },
  {
    category: "desktop shell",
    owners: ["@porkbot/desktop"],
    names: ["electron"],
  },
  {
    category: "authentication library",
    owners: ["@porkbot/auth"],
    names: ["better-auth"],
  },
  {
    category: "provider SDK",
    owners: ["@porkbot/adapters"],
    names: [
      "openai",
      "@anthropic-ai",
      "@e2b",
      "@daytonaio",
      "dockerode",
      // Pi owns the agent loop; it is adapted at the RunSession seam in
      // @porkbot/adapters and named nowhere else (PRD decision 13).
      "@earendil-works",
    ],
  },
  {
    category: "container test harness",
    owners: ["@porkbot/testkit"],
    names: ["testcontainers"],
  },
];

const deepWorkspaceImport = {
  group: ["@porkbot/*/**"],
  message:
    "Deep imports into a workspace package are forbidden; import the package entry point instead.",
};

// Test files and test configs, in one place: these paths are governed by
// `testImports` instead of `imports`, so a package can use the test harness
// without the harness becoming importable from shipped source.
const testFilePatterns = [
  "**/*.test.ts",
  "**/*.test.tsx",
  "**/*.spec.ts",
  "**/*.spec.tsx",
  "**/test/**/*.ts",
  "**/test/**/*.tsx",
  "vitest*.config.ts",
];

export { testFilePatterns };

const nodeBuiltInImport = {
  group: ["node:*"],
  message: "@porkbot/core is pure domain code: no I/O, no Node built-ins.",
};

function workspaceImportPaths(packageName, entry, allowedImports = entry.imports) {
  return Object.keys(workspacePackages)
    .filter((name) => name !== packageName && !allowedImports.includes(name))
    .map((name) => ({
      name,
      message:
        `"${name}" is outside the "${packageName}" boundary. ` +
        `Allowed workspace imports: ${allowedImports.length > 0 ? allowedImports.join(", ") : "none"}. ` +
        "Update the module map in packages/eslint-config/module-boundaries.js if this edge is intended.",
    }));
}

function libraryImportPatterns(packageName) {
  const patterns = [];

  for (const { category, owners, names } of restrictedLibraries) {
    if (owners.includes(packageName)) {
      continue;
    }

    for (const name of names) {
      patterns.push({
        group: [name, `${name}/*`],
        message: `"${name}" is a ${category} owned by ${owners.join(", ")}; "${packageName}" must not import it.`,
      });
    }
  }

  return patterns;
}

function restrictedImportsOptions(
  packageName,
  { includeNodeBuiltIns = false, extraImports = [] } = {},
) {
  const entry = workspacePackages[packageName];
  const patterns = [deepWorkspaceImport, ...libraryImportPatterns(packageName)];

  if (includeNodeBuiltIns) {
    patterns.push(nodeBuiltInImport);
  }

  return {
    paths: workspaceImportPaths(packageName, entry, [...entry.imports, ...extraImports]),
    patterns,
  };
}

/**
 * Builds the boundary config for one package: the production rule, and the
 * test-file rule that swaps `imports` for `imports + testImports`. Splitting them
 * is what makes a test-only edge mean something — the production rule ignores
 * test paths entirely, and the test rule uses the wider edge set, so
 * `@porkbot/testkit` is reachable from a spec and from `vitest.config.ts` but not
 * from the code the package ships.
 */
export function boundaryConfigsFor(packageName) {
  if (!Object.hasOwn(workspacePackages, packageName)) {
    throw new Error(
      `Unknown workspace package "${packageName}". Register it in packages/eslint-config/module-boundaries.js before linting it.`,
    );
  }

  const entry = workspacePackages[packageName];
  const configs = [
    {
      name: `porkbot/boundaries/${packageName}`,
      files: typescriptSourceFiles,
      ignores: testFilePatterns,
      rules: {
        "no-restricted-imports": [
          "error",
          restrictedImportsOptions(packageName, {
            includeNodeBuiltIns: packageName === "@porkbot/core",
          }),
        ],
      },
    },
    {
      name: `porkbot/boundaries/${packageName}/tests`,
      files: testFilePatterns,
      rules: {
        "no-restricted-imports": [
          "error",
          restrictedImportsOptions(packageName, {
            extraImports: entry.testImports ?? [],
          }),
        ],
      },
    },
  ];

  return configs;
}
