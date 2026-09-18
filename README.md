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
pnpm test:e2e         # end-to-end tests (the only tier that retries)
pnpm quarantine:check # validate quarantine.json: owners, reasons, expiries
pnpm testkit:start    # boot the harness Postgres container, record its state
pnpm testkit:migrate  # apply SQL migrations to the harness template database
pnpm testkit:snapshot # clone the template into a fresh suite database
pnpm testkit:destroy  # drop the suites and template, remove the container
pnpm testkit:benchmark # measure start, migrate and per-suite clone cost
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
  testkit/      tier presets, quarantine ledger, flake reporter, Postgres-per-suite harness CLI
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
- `imports` is what shipped source may depend on; `testImports` is the same claim
  for test files and test configs. That is how `@porkbot/testkit` — the tier
  presets, the quarantine ledger and the flake reporter — is reachable from a spec
  and from `vitest.config.ts` while staying unreachable from production code.
  Both edges are enforced, in opposite directions, by the same map.
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
- `quarantine` — `quarantine.json` is valid and nothing in it has expired
- `unit` — unit tests with coverage
- `integration` — the tests that need a real Postgres, which the testkit harness boots
- `e2e` — whole-process tests against the built output
- `gate` — green only when every tier above is green

`format`, `lint` and `build` run in parallel. `typecheck`, `unit`, `e2e` and
`integration` wait for `build` so they restore the turbo cache it populated
rather than rebuilding the workspace. Every tier asserts the Node major instead
of assuming it, and the toolchain lives in `.github/actions/setup` so a bump
cannot land in some tiers and not others.

The `integration` job declares no service: the testkit harness boots
`postgres:18`, the production major, itself. A tier that runs against the wrong
database proves nothing, and a tier that skips itself when the runtime is
missing is worse than no tier, so a missing Docker daemon (and no
`TESTKIT_DATABASE_URL`) fails the suite rather than skipping it.

The e2e tier carries the placeholder spec later slices replace. The job exists
now so the wiring is proven on its own rather than introduced alongside new
tests. It is the only tier that retries.

### Postgres-per-suite harness

`packages/testkit` boots one Postgres of the production major per run and
migrates a template database from the SQL files in `packages/db/migrations`
(slice 2.1 adds the first application migrations). Each suite asks for a
database cloned from that template with `CREATE DATABASE ... TEMPLATE`, so two
suites running in parallel have the same schema and cannot see each other's
rows:

```ts
import { createSuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";

const suite = await createSuiteDatabase({ suite: "my_suite" });
const client = new Client({ connectionString: suite.connectionString });
// ... the suite's own rows, in the suite's own database ...
await client.end();
await suite.destroy();
```

A file that needs several databases in one run calls `startPostgresHarness()`
instead; it returns the same handles plus `migrate()`, `createSuite()` and
`stop()`. The runtime is the `docker` binary itself — no client library and no
reaper image, so the only thing pulled is Postgres. The container gets an
ephemeral loopback port and is removed with `docker rm -f -v` on destroy. A
harness a test process owns also removes it on process exit and on
`SIGINT`/`SIGTERM`; a harness the CLI started outlives the process and is
recorded in `.testkit/harness.json`, which is what later commands — and a human
after a hard kill — use to find it. `docker rm -f $(docker ps -aq --filter
label=porkbot.testkit=1)` sweeps anything a hard kill left behind.

The CLI is the same actions as separate commands, which is what later slices
script scenarios and canaries with:

```sh
pnpm testkit:start          # boot the container, create the template database
pnpm testkit:migrate        # apply packages/db/migrations to the template
pnpm testkit:snapshot       # clone the template; prints the suite's URL
pnpm testkit:destroy        # drop the suites and template, remove the container
pnpm testkit:benchmark      # measure the costs below, then destroy
```

Printed connection strings are redacted by default — `--show-credentials` opts
into the password, which the state file (mode 0600) already holds — and a failed
`docker` command redacts `--env` values whose names look like secrets, so that
neither CI logs nor error messages carry a credential.

`TESTKIT_DATABASE_URL` attaches to an existing server of the production major
instead of booting a container (the role needs `CREATEDB`), and
`TESTKIT_HARNESS_STATE` points a suite at a run-level harness the CLI started:
that is how CI pays for the container and the migration once per run while every
suite still gets a fresh clone. `TESTKIT_POSTGRES_IMAGE` overrides the image,
but the server major is asserted, not trusted.

**Measured startup cost** (2026-09-18, `pnpm testkit:benchmark`, Docker 29 on
Linux, warm image): container start ~0.5 s, Postgres ready ~1.6 s, a two-file
migration ~10 ms, per-suite clone ~55-130 ms (median ~60 ms), destroy ~1.7 s.
The first run on a machine without the image adds the pull; CI pre-pulls it. The
integration tier measures the same phases on every CI run and writes them into
the job summary. The number that shapes the design is the clone: a suite costs a
clone, not a container, so one harness is started per run and every suite,
scenario or canary clones from it.

Locally the tier needs Docker and the image; CI pre-pulls it:

```sh
docker pull postgres:18
pnpm test:integration
```

### Flake management

Every package's `vitest.config.ts` is one call to a tier preset from
`packages/testkit`: `unit()`, `integration()` or `e2e()`. The preset decides the
timeouts, the retry policy, coverage, and which tests the ledger skips, so "unit
tests never retry" is a property of the tier rather than a line somebody has to
remember to keep in fourteen config files. `packages/testkit/test/tier-policy.test.ts`
loads each package's real config and fails if one of them hand-rolls its own
numbers.

- **Retries are e2e-only.** The e2e tier retries a transient failure twice;
  unit and integration tests never retry, because a retry in an in-process test
  hides a bug instead of a race.
- **Retries are reported, never silent.** A shared reporter annotates every
  retried test on the pull request (`::warning file=…`) and writes a flake table
  into the job summary, including the tests the ledger skipped and why. "No test
  was retried in this run" is printed in words, so silence always means zero.
- **Every test has a timeout.** Each tier sets `testTimeout`, `hookTimeout` and
  `teardownTimeout`, the test steps have their own budgets, and every job has
  one, so a hanging test fails on a clock instead of blocking a runner.
- **`allowOnly: false` everywhere.** A stray `.only` fails the run rather than
  quietly reducing the suite to one test.

#### The quarantine ledger

`quarantine.json` at the repository root is the only place a test is allowed not
to run. Each entry names the test, an owner, a reason, an expiry and the issue
tracking the fix:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "flake-0001",
      "tier": "e2e",
      "file": "apps/api/test/e2e/health.e2e.test.ts",
      "test": "starts, serves /healthz over HTTP and stops on SIGTERM",
      "owner": "@Z0uk",
      "reason": "the port is not always free on the shared runner",
      "issue": "https://github.com/0xZ0uk/PorkBot/issues/19",
      "quarantinedOn": "2026-09-17",
      "expires": "2026-10-17"
    }
  ]
}
```

A quarantined test is skipped by a pattern the tier preset derives from the
ledger, so it shows up as `skipped` in the run instead of disappearing from it.
The ledger fails CI — in the `quarantine` tier, and again when a tier preset
refuses to load — when:

- an entry has expired (the expiry date is inclusive; the check runs daily);
- an entry is more than 90 days out, so quarantine stays a deadline;
- the test it names no longer exists, or the title is ambiguous in that file;
- an owner, reason, expiry or tracking issue is missing or malformed;
- the file has moved, or two entries describe the same test.

`pnpm quarantine:check` runs the same validation locally and prints the table.

### Coverage

### Coverage

Coverage is measured by the unit tier. Thresholds live in a package's own
`vitest.config.ts`, and only packages whose correctness is decided by their own
code are gated:

- `packages/core` and `packages/db` fail the tier below 90% statements, branches,
  functions and lines (the numbers are passed to the unit preset, and the guard
  test pins them).
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

> **Deliberately not applied — an accepted trade-off, not an oversight.** This
> repository is private on GitHub's free plan, where GitHub refuses branch
> protection _and_ rulesets outright (`HTTP 403: Upgrade to GitHub Pro or make
this repository public to enable this feature`). The decision for now is to
> stay private on the free plan, so a red pull request is blocked by convention
> and by the reviewer — and, from slice 1.7, by the pr-watch skill — rather than
> by the platform.
>
> The script above is therefore the unexercised half of this slice: written,
> dry-run verified and drift-guarded. Applying it later is one command, and
> making the repository public is enough to make that command work.

## Status

This is slice 1.5 of epic E1 (M0 — Foundation): integration tests now run against
a real Postgres 18 that the testkit harness boots itself — one container per run,
a migrated template database, and a clone per suite — with a harness CLI for
scripted scenarios and canaries. The CI gate still carries the flake policy from
slice 1.4 (e2e-only retries with the retry counts reported, timeouts on every
tier, a quarantine ledger whose entries expire on a date CI enforces), and the
workspace, build, typecheck, lint and test wiring remain real blocking tiers.
`apps/web`, `apps/desktop` and `apps/www` are placeholders that the M10 surface
slices replace with the real clients; `apps/api` currently serves a single
`/healthz` endpoint and `apps/worker` is an idle process, both replaced by slices
6.1 and later.

The workspace compiles with TypeScript 7; typescript-eslint refuses to run against it, so
`@porkbot/eslint-config` depends on the TypeScript 6 API for lint tooling only. Remove that
pin once typescript-eslint supports TypeScript 7.
