# Testing

## CI

`.github/workflows/ci.yml` runs one job per tier, so a red tier is a red check
with a name instead of a step index buried in one long log.

- `format` — `prettier --check`
- `lint` — ESLint, including the module-boundary rules
- `typecheck` — `tsc --noEmit` everywhere
- `build` — `tsc` emit, the artifact the later tiers and every deploy consume
- `quarantine` — `quarantine.json` is valid and nothing in it has expired
- `dependencies` — the pin register, manifests, lockfile integrity and image digests agree
- `env` — every `.env.schema` loads under the CI fixtures and every audit is in sync
- `posture` — the license, contributing, security and template files hold, and no published commit carries a secret or personal data
- `docs` — every link resolves and the environment reference matches the schemas and the template
- `unit` — unit tests with coverage
- `integration` — the tests that need a real Postgres, against the local stack the job starts
- `e2e` — real-browser release flows against the built output and offline emulators
- `gate` — green only when every tier above is green

`format`, `lint` and `build` run in parallel. `typecheck`, `unit`, `e2e` and
`integration` wait for `build` so they restore the turbo cache it populated
rather than rebuilding the workspace. Every tier asserts the Node major instead
of assuming it, and the toolchain lives in `.github/actions/setup` so a bump
cannot land in some tiers and not others.

The `integration` job declares no service: it starts the local stack with
`pnpm stack:up`, the same command a developer runs, and the testkit harness
then attaches to that stack's Postgres — the production major — instead of
booting its own container. The stack's Postgres image is pinned by digest in
`dependencies.json`, so the tier and production run the image that was proven.
A tier that runs against the wrong database proves nothing, and a tier that
skips itself when the runtime is missing is worse than no tier, so a missing
Docker daemon (and no `TESTKIT_DATABASE_URL`) fails the suite rather than
skipping it.

The e2e tier starts the testkit's Postgres harness, serves the built SPA beside
the real API server, and drives the release flow in Chrome through Playwright.
The fixture covers authentication, bot and routine creation, memory correction,
computer lifecycle and terminal use, a tool call with durable approval, live
steering and stop, then reload replay. Mail, model and computer seams use the
offline emulators, and the browser fixture refuses non-loopback requests. The
job uploads traces and screenshots on every result; when a pull request changes
`apps/web`, `packages/ui` or `packages/tokens`, it requires the browser screenshot
and publishes a sticky artifact link on the pull request. It is the only tier
that retries.

### Postgres-per-suite harness

`packages/testkit` boots one Postgres of the production major per run and
migrates a template database from the SQL files in `packages/db/migrations` —
the drizzle journal, applied in filename order. Each suite asks for a
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
docker pull postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280
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

The payload requires the pull request itself, dismisses stale reviews, requires
conversation resolution, and forbids force pushes and deletions; a directly
pushed commit cannot reach `main` once the script has run. The review count is
zero by design: this is a single-operator repository, so requiring one approval
would mean nobody can merge their own branch, and the review that matters — the
bots on the head SHA, and the pr-watch merge check — is enforced by the pull
request rather than by a count.

The GitHub-side settings that are not a file are applied by
`scripts/setup-branch-protection.sh` together with
`scripts/setup-repo-security.sh`, which turns on secret scanning, push
protection and private vulnerability reporting, and
`scripts/verify-push-protection.sh`, which pushes a canary built to be detected
and passes only when GitHub refuses it:

```sh
scripts/setup-branch-protection.sh --dry-run   # print the payload
scripts/setup-branch-protection.sh             # apply
scripts/setup-repo-security.sh                 # secret scanning and private reporting
scripts/verify-push-protection.sh              # prove push protection blocks a canary
```

The `posture` tier is the file-side half: it reads `LICENSE`, `CONTRIBUTING.md`,
`SECURITY.md`, `CODE_OF_CONDUCT.md` and the templates, and it walks every
reachable commit and blob for provider-shaped secrets and personal data.
Findings never quote the matched value, because this tier's output is public.
