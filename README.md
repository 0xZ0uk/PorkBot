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
pnpm test:coverage    # unit tests with coverage: the tier CI actually runs
pnpm test:integration # tests that need a real Postgres
pnpm test:e2e         # end-to-end tests
pnpm dev              # run the always-on processes (api, worker)
pnpm format           # rewrite files with Prettier
pnpm format:check     # verify formatting (CI runs this)
```

`pnpm typecheck`, `pnpm test`, `pnpm test:coverage` and `pnpm test:integration`
build the workspace dependencies they need first, so a clean checkout only needs
`pnpm install` followed by any single command.

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

## CI

`.github/workflows/ci.yml` runs one job per tier, so a red tier is a red check
with a name instead of a step index buried in one long log.

- `format` — `prettier --check`
- `lint` — ESLint, including the module-boundary rules
- `typecheck` — `tsc --noEmit` everywhere
- `build` — `tsc` emit, the artifact the later tiers and every deploy consume
- `unit` — unit tests with coverage
- `integration` — the tests that need a real Postgres
- `e2e` — whole-process tests against the built output
- `gate` — green only when every tier above is green

`format`, `lint` and `build` run in parallel. `typecheck`, `unit`, `e2e` and
`integration` wait for `build` so they restore the turbo cache it populated
rather than rebuilding the workspace. Every tier asserts the Node major instead
of assuming it, and the toolchain lives in `.github/actions/setup` so a bump
cannot land in some tiers and not others.

The `integration` job starts `postgres:18`, the production major, and the suite
asserts the server major rather than trusting the image tag. A tier that runs
against the wrong database proves nothing, and a tier that skips itself when the
service is missing is worse than no tier, so an unset `DATABASE_URL` fails the
suite rather than skipping it. Locally:

```sh
docker run --rm -p 5432:5432 -e POSTGRES_USER=porkbot \
  -e POSTGRES_PASSWORD=porkbot -e POSTGRES_DB=porkbot postgres:18
DATABASE_URL=postgres://porkbot:porkbot@127.0.0.1:5432/porkbot pnpm test:integration
```

The e2e tier carries the placeholder spec later slices replace. The job exists
now so the wiring is proven on its own rather than introduced alongside new
tests.

### Coverage

Coverage is measured by the unit tier. Thresholds live in a package's own
`vitest.config.ts`, and only packages whose correctness is decided by their own
code are gated:

- `packages/core` and `packages/db` fail the tier below 90% statements, branches,
  functions and lines.
- Every other package reports coverage into the pull request summary without
  gating, so a placeholder app cannot block a merge on a number nobody has
  decided yet.

`packages/typescript-config` is the one package whose coverage step runs without
instrumentation: its source is JSON configuration, which V8 coverage cannot
measure. That override is a Package Configuration in
`packages/typescript-config/turbo.json`.

### Caching and wall time

Turbo's cache directory (`.turbo/cache`) is persisted with `actions/cache` under
a key derived from the lockfile, so a run reuses the build, typecheck, lint and
test output an earlier run already produced. `.nvmrc` is a global dependency, so
bumping Node invalidates every cached task instead of silently reusing output
produced by the old major.

`test:integration` is explicitly never cached: a cached pass would not have
touched a database, which is the only thing that tier is for.

A turbo **remote** cache needs no workflow edit: set the `TURBO_TOKEN` repository
secret and the `TURBO_TEAM` repository variable, then uncomment the two lines at
the top of `.github/workflows/ci.yml`.

### Required checks

`scripts/setup-branch-protection.sh` applies the tier job names as required
status checks on `main`, so a red tier blocks the merge button rather than
relying on the reviewer noticing. It refuses to run when a name it expects is no
longer a job in the workflow, which is what stops a job rename from silently
leaving merges unguarded:

```sh
scripts/setup-branch-protection.sh --dry-run   # print the payload
scripts/setup-branch-protection.sh             # apply
```

> **Not applied yet.** GitHub refuses branch protection and rulesets on private
> repositories below the Pro plan (`HTTP 403: Upgrade to GitHub Pro or make this
repository public to enable this feature`), and this repository is private on a
> free plan. Until the repository is public or the account is on Pro, no tier is
> enforced by GitHub: a red pull request is blocked by convention (and, from
> slice 1.7, by the pr-watch skill) rather than by the platform. Making the
> repository public is enough, and applying the rule is then one command.

## Status

This is slice 1.3 of epic E1 (M0 — Foundation). The workspace, build, typecheck, lint and
test wiring are real and the CI gate runs them as separate blocking tiers. `apps/web`,
`apps/desktop` and `apps/www` are placeholders that the
M10 surface slices replace with the real clients; `apps/api` currently serves a single
`/healthz` endpoint and `apps/worker` is an idle process, both replaced by slices 6.1 and
later.

The workspace compiles with TypeScript 7; typescript-eslint refuses to run against it, so
`@porkbot/eslint-config` depends on the TypeScript 6 API for lint tooling only. Remove that
pin once typescript-eslint supports TypeScript 7.
