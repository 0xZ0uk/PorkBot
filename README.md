# PorkBot

PorkBot is a self-hosted, single-operator AI teammate platform. This repository is the
pnpm 10 + Turborepo + Node 24 workspace the whole product is built in: the module map,
the boundary rules that keep the domain pure, the test harnesses and the CI gate. Nothing
product-facing ships until those are in place.

## Requirements

- Node 24 (`.nvmrc`, `engines.node`, `devEngines.runtime`)
- pnpm 10 (`packageManager`, `engines.pnpm`, `devEngines.packageManager`)

Corepack is the easiest way to get the pinned pnpm:

```sh
corepack enable
```

## Entry points

```sh
pnpm install          # install the workspace
pnpm build            # build every app and package (tsc, dist output)
pnpm typecheck        # typecheck every app and package
pnpm lint             # lint every app and package
pnpm test             # unit tests
pnpm test:e2e         # end-to-end tests
pnpm dev              # run the always-on processes (api, worker)
pnpm format           # rewrite files with Prettier
pnpm format:check     # verify formatting (CI runs this)
```

`pnpm typecheck` and `pnpm test` build the workspace dependencies they need first, so a
clean checkout only needs `pnpm install` followed by any single command.

## Layout

```
apps/
  api/       HTTP and streaming surface over the domain
  worker/    always-on background worker, durable jobs
  web/       static SPA surface
  desktop/   Electron client of the same API
  www/       public landing and documentation site
packages/
  core/         pure domain: rules, state machine, reducer, policies
  db/           Drizzle schema, migrations, actor-scoped repositories
  contracts/    schemas and transport types
  adapter-kit/  provider interfaces only
  adapters/     provider implementations and offline emulators
  auth/         the authentication gate and actor resolution
  effect/       Effect layers, service tags, transport error mapping
  ui/           design-system components
  tokens/       design tokens
  logging/      JSON logs, levels, correlation ids, redaction
  testkit/      emulators, harness CLI, database-per-suite isolation
  eslint-config/     internal: shared ESLint flat config
  typescript-config/ internal: shared tsconfig bases
```

Every package is private, ESM, `"type": "module"`, and exports built `dist` output
(`exports` maps `types` + `default`). Packages import each other with the `workspace:*`
protocol, so a package can only use what it declares.

## Boundaries

Boundaries are lint rules, not conventions. `packages/eslint-config/module-boundaries.js`
is the module map: each workspace package declares which workspace packages it may import,
and each restricted library declares the packages that own it. Every `eslint.config.js`
builds its rules from that map, so an import edge is added in one reviewable place. A
package that is not in the map cannot import any workspace package.

- `packages/core` is pure: no workspace imports, no Node built-ins outside tests, no
  framework, no database driver, no vendor SDK. A test in that package also fails if a
  runtime dependency is added.
- Provider SDKs live only in `packages/adapters`. Everything else consumes
  `packages/adapter-kit` interfaces.
- `packages/contracts` is the only source of transport types.
- Deep imports (`@porkbot/*/src/**`), relative imports that cross a package boundary, and
  inline `type` specifiers fail lint; type-only imports are top-level `import type`.
- The rules are proven, not just configured: deliberate violations live in
  `packages/eslint-config/fixtures/` and are linted by that package's tests, so a rule
  that stops firing fails CI.

`packages/typescript-config` holds the strict bases (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `verbatimModuleSyntax`, ...); a test fails if a package
config weakens one of them.

Formatting has one answer: `pnpm format` rewrites the repo with Prettier, `pnpm
format:check` verifies it, and CI runs the check.

## Status

This is slice 1.2 of epic E1 (M0 — Foundation). The workspace, build, typecheck, lint and
test wiring are real. `apps/web`, `apps/desktop` and `apps/www` are placeholders that the
M10 surface slices replace with the real clients; `apps/api` currently serves a single
`/healthz` endpoint and `apps/worker` is an idle process, both replaced by slices 6.1 and
later.

The workspace compiles with TypeScript 7; typescript-eslint refuses to run against it, so
`@porkbot/eslint-config` depends on the TypeScript 6 API for lint tooling only. Remove that
pin once typescript-eslint supports TypeScript 7.
