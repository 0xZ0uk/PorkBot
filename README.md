<p align="center">
  <img src="docs/brand/porkbot-mascot.png" alt="PorkBot's mascot: a pink pig's head with two capsule eyes" width="180">
</p>

# PorkBot

PorkBot is a self-hosted, single-operator AI teammate platform. This repository is the
pnpm 10 + Turborepo + Node 24 workspace the whole product is built in: the module map,
the boundary rules that keep the domain pure, the test harnesses and the CI gate. Nothing
product-facing ships until those are in place.

## Requirements

- Node 24 (`.nvmrc`, `engines.node`, `devEngines.runtime`)
- pnpm 10 (`packageManager`, `engines.pnpm`, `devEngines.packageManager`)
- A self-hosted deployment sized from the [measured floor table](docs/architecture/operations-floor.md),
  whose memory term scales with the bots active at once and whose disk term
  scales with every configured bot, with the Compose ceilings and per-bot
  limits kept as the separate deployment
  invariant in [`docs/architecture/operations.md`](docs/architecture/operations.md#single-host-deployment);
  [the sizing terms](docs/computers.md#configuring-docker) say which is which,
  and that per-bot disk is a write-layer budget enforced only where the
  daemon's storage driver answers it.

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
pnpm dependencies:check # validate dependencies.json, manifests, lockfile and image digests
pnpm dependencies:diff  # print the lockfile delta against origin/main
pnpm docs:check       # check doc links and the environment reference against the schemas
pnpm env:check        # load every .env.schema and audit it against the code
pnpm posture:check    # audit the posture files and the published history for leaks
pnpm canary:run       # run the live-provider canary against a supervisor (real Docker or cloud)
pnpm canary:sweep     # destroy every canary machine a crashed run left behind
pnpm canary:notify    # deliver one operator notification through the E8 provider
pnpm stack:up         # build the local stack, start it, wait for every healthcheck
pnpm stack:logs       # follow the stack's logs
pnpm stack:status     # show the stack's services, states and ports
pnpm stack:down       # stop the stack; remove containers, network and volumes
pnpm deploy:setup     # render deploy/.env from the template, generating every secret
pnpm deploy:check     # validate deploy/.env (reads the daemon's storage driver for the disk verdict)
pnpm deploy:up        # setup if needed, validate, build, start and wait for the stack
pnpm deploy:measure   # cold-boot the live stack, run the workload, write the floor table
pnpm deploy:upgrade --tag <git-sha>  # pull, preflight, migrate and switch to a release
pnpm deploy:rollback  # redeploy the last release against the current schema
pnpm deploy:status    # show the deployment's services, states and ports
pnpm deploy:logs      # follow the deployment's logs
pnpm deploy:exec      # run a command in a running service
pnpm deploy:down      # stop the deployment (volumes kept unless --volumes)
pnpm release:bump     # write the next desktop version into apps/desktop/package.json
pnpm desktop:package  # package the desktop app for each target platform
pnpm desktop:smoke    # start a packaged app and walk its first-run flow
pnpm release:notes    # print release notes generated from the git log
pnpm testkit:start    # boot the harness Postgres container, record its state
pnpm testkit:migrate  # apply SQL migrations to the harness template database
pnpm testkit:snapshot # clone the template into a fresh suite database
pnpm testkit:destroy  # drop the suites and template, remove the container
pnpm testkit:benchmark # measure start, migrate and per-suite clone cost
pnpm db:generate      # diff the schema, write a migration a reviewer can read
pnpm db:migrate       # apply the migrations to $DATABASE_URL; safe to run twice
pnpm dev              # run the always-on processes (api, worker, web, supervisor)
pnpm format           # rewrite files with Prettier
pnpm format:check     # verify formatting (CI runs this)
```

`pnpm typecheck`, `pnpm test`, `pnpm test:coverage` and `pnpm test:integration`
build the workspace dependencies they need first, so a clean checkout only needs
`pnpm install` followed by any single command.

## Documentation

The docs, checked for staleness by the `docs` CI tier:

| Document                                                                         | What it is for                                                          |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [`docs/self-host.md`](docs/self-host.md)                                         | Install and run a single-host deployment, first sign-in to first run    |
| [`docs/environment.md`](docs/environment.md)                                     | Every environment variable, with its default and whether it is required |
| [`docs/runbook.md`](docs/runbook.md)                                             | Dead disk, stuck run, rotated key, failed upgrade, restore              |
| [`docs/backups.md`](docs/backups.md)                                             | The backup job, its timer, envelope and recovery path                   |
| [`docs/computers.md`](docs/computers.md)                                         | Choosing and configuring a computer provider, sizing and snapshots      |
| [`docs/architecture/operations-floor.md`](docs/architecture/operations-floor.md) | The measured deployment floor and workload record                       |
| [`docs/security.md`](docs/security.md)                                           | The trust boundary and the non-goals                                    |
| [`docs/reverse-proxy.md`](docs/reverse-proxy.md)                                 | The one-origin contract and the streaming runbook                       |
| [`docs/credential-proxy.md`](docs/credential-proxy.md)                           | Why credentials never enter a sandbox                                   |
| [`docs/bot-secrets.md`](docs/bot-secrets.md)                                     | The bot-secret flow and its trust posture                               |
| [`docs/desktop.md`](docs/desktop.md)                                             | The desktop shell: hardening, tray, signed updates                      |
| [`docs/release.md`](docs/release.md)                                             | Building, signing and publishing desktop artifacts                      |
| [`docs/architecture/index.md`](docs/architecture/index.md)                       | Why the product is built this way: the design record, in reading order  |
| [`docs/status.md`](docs/status.md)                                               | What ships today and what is deferred                                   |

## Layout

```
apps/
  api/         HTTP and streaming surface over the domain
  worker/      always-on background worker, durable jobs
  supervisor/  Docker socket owner and the only owner of computer lifecycle
  backup/      nightly encrypted backups and the scheduled restore drill
  web/         static SPA surface
  desktop/     Electron client of the same API
  www/         public landing and documentation site
packages/
  core/         pure domain: rules, state machine, reducer, policies
  db/           Drizzle schema, migrations, actor-scoped repositories
  contracts/    schemas and transport types
  adapter-kit/  provider interfaces, failure vocabulary, two-implementations plan
  adapters/     provider implementations and offline emulators
  auth/         the authentication gate and actor resolution
  effect/       Effect layers, service tags, transport error mapping
  ui/           design-system components
  tokens/       design tokens
  logging/      JSON logs, levels, correlation ids, redaction
  health/       health endpoints for always-on processes
  testkit/      tier presets, quarantine ledger, flake reporter, Postgres-per-suite harness CLI
  canary/       scheduled live-provider canary: budget, run, teardown, orphan sweep
  eslint-config/     internal: shared ESLint flat config
  typescript-config/ internal: shared tsconfig bases
```

Every package is private, ESM, `"type": "module"`, and exports built `dist` output
(`exports` maps `types` + `default`). Packages import each other with the `workspace:*`
protocol, so a package can only use what it declares.

## License and participation

PorkBot is released under the [MIT License](LICENSE). By contributing you agree
that your contribution is licensed under the same terms.

- [CONTRIBUTING.md](CONTRIBUTING.md) — the toolchain, the checks every change
  runs, and what a pull request needs.
- [SECURITY.md](SECURITY.md) — how to report a vulnerability privately.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — the behaviour expected in every
  space this project touches.
- [AGENTS.md](AGENTS.md) — the rules the code itself holds to.

The `posture` CI tier keeps these honest: it fails when one of the files is
missing, when `LICENSE` and the manifest disagree, or when a published commit
carries a provider-shaped secret, a personal email identity or a personal home
path. `scripts/setup-repo-security.sh` and `scripts/verify-push-protection.sh`
cover the settings and the enforcement that live on GitHub rather than in a
file.
