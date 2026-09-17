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
export const workspacePackages = {
  "@porkbot/core": {
    role: "pure domain: rules, state machine, reducer, policies",
    imports: [],
  },
  "@porkbot/contracts": {
    role: "schemas and transport types",
    imports: ["@porkbot/core"],
  },
  "@porkbot/adapter-kit": {
    role: "provider interfaces only",
    imports: [],
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
  },
  "@porkbot/db": {
    role: "schema, migrations, actor-scoped repositories",
    imports: ["@porkbot/contracts", "@porkbot/core", "@porkbot/effect", "@porkbot/logging"],
  },
  "@porkbot/auth": {
    role: "authentication gate and actor resolution",
    imports: [
      "@porkbot/contracts",
      "@porkbot/core",
      "@porkbot/db",
      "@porkbot/effect",
      "@porkbot/logging",
    ],
  },
  "@porkbot/effect": {
    role: "shared layers, service tags, transport error mapping",
    imports: ["@porkbot/adapter-kit", "@porkbot/contracts", "@porkbot/core", "@porkbot/logging"],
  },
  "@porkbot/logging": {
    role: "JSON logs, levels, correlation ids, redaction",
    imports: [],
  },
  "@porkbot/testkit": {
    role: "emulators, harness, database-per-suite isolation",
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
  },
  "@porkbot/ui": {
    role: "design-system components",
    imports: ["@porkbot/tokens"],
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
      "@porkbot/logging",
    ],
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
      "@porkbot/logging",
    ],
  },
  "@porkbot/web": {
    role: "static SPA surface",
    imports: ["@porkbot/contracts", "@porkbot/core", "@porkbot/tokens", "@porkbot/ui"],
  },
  "@porkbot/desktop": {
    role: "Electron client of the same API",
    imports: ["@porkbot/contracts", "@porkbot/core", "@porkbot/tokens", "@porkbot/ui"],
  },
  "@porkbot/www": {
    role: "public landing and documentation site",
    imports: ["@porkbot/tokens", "@porkbot/ui"],
  },
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
    category: "web framework or transport library",
    owners: ["@porkbot/api"],
    names: ["hono", "@orpc"],
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
    category: "provider SDK",
    owners: ["@porkbot/adapters"],
    names: ["openai", "@anthropic-ai", "@e2b", "@daytonaio", "dockerode"],
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

const nodeBuiltInImport = {
  group: ["node:*"],
  message: "@porkbot/core is pure domain code: no I/O, no Node built-ins.",
};

function workspaceImportPaths(packageName, entry) {
  return Object.keys(workspacePackages)
    .filter((name) => name !== packageName && !entry.imports.includes(name))
    .map((name) => ({
      name,
      message:
        `"${name}" is outside the "${packageName}" boundary. ` +
        `Allowed workspace imports: ${entry.imports.length > 0 ? entry.imports.join(", ") : "none"}. ` +
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

function restrictedImportsOptions(packageName, { includeNodeBuiltIns = false } = {}) {
  const entry = workspacePackages[packageName];
  const patterns = [deepWorkspaceImport, ...libraryImportPatterns(packageName)];

  if (includeNodeBuiltIns) {
    patterns.push(nodeBuiltInImport);
  }

  return {
    paths: workspaceImportPaths(packageName, entry),
    patterns,
  };
}

/**
 * Builds the boundary config for one package. Returns an array so that packages
 * with production-only restrictions (core's ban on Node built-ins) can exempt
 * their test files without weakening the shipped source.
 */
export function boundaryConfigsFor(packageName) {
  if (!Object.hasOwn(workspacePackages, packageName)) {
    throw new Error(
      `Unknown workspace package "${packageName}". Register it in packages/eslint-config/module-boundaries.js before linting it.`,
    );
  }

  const configs = [
    {
      name: `porkbot/boundaries/${packageName}`,
      files: ["**/*.ts", "**/*.tsx"],
      rules: {
        "no-restricted-imports": [
          "error",
          restrictedImportsOptions(packageName, {
            includeNodeBuiltIns: packageName === "@porkbot/core",
          }),
        ],
      },
    },
  ];

  if (packageName === "@porkbot/core") {
    configs.push({
      name: `porkbot/boundaries/${packageName}/tests`,
      files: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts", "**/*.spec.tsx"],
      rules: {
        "no-restricted-imports": ["error", restrictedImportsOptions(packageName)],
      },
    });
  }

  return configs;
}
