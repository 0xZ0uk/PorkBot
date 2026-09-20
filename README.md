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
pnpm dependencies:check # validate dependencies.json, manifests, lockfile and image digests
pnpm dependencies:diff  # print the lockfile delta against origin/main
pnpm env:check        # load every .env.schema and audit it against the code
pnpm stack:up         # build the local stack, start it, wait for every healthcheck
pnpm stack:logs       # follow the stack's logs
pnpm stack:status     # show the stack's services, states and ports
pnpm stack:down       # stop the stack; remove containers, network and volumes
pnpm deploy:setup     # render deploy/.env from the template, generating every secret
pnpm deploy:check     # validate deploy/.env without touching Docker
pnpm deploy:up        # setup if needed, validate, build, start and wait for the stack
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
  eslint-config/     internal: shared ESLint flat config
  typescript-config/ internal: shared tsconfig bases
```

Every package is private, ESM, `"type": "module"`, and exports built `dist` output
(`exports` maps `types` + `default`). Packages import each other with the `workspace:*`
protocol, so a package can only use what it declares.

## Local stack

`docker compose` (repository-root `compose.yaml`) brings up the whole product:
Postgres 18, `api`, `worker`, `backup`, `web`, `proxy` and `supervisor`, each
with a healthcheck. One command starts it and waits:

```sh
pnpm stack:up      # build, start, wait for every healthcheck
pnpm stack:logs    # follow the logs of every service
pnpm stack:status  # what is running, and on which ports
pnpm stack:down    # stop; remove containers, network and Postgres volume
```

`stack:up` returns only once every healthcheck passes, so whatever runs after it
can trust the stack; a service that never reports healthy fails the command and
prints the recent logs. `stack:down` removes the containers, the network and the
Postgres volume, so a shut down and a re-run leave nothing behind.

- **No key, no vendor, no egress.** The processes ship no provider endpoint or
  credential, and the only images pulled are Node, Postgres and the reverse
  proxy; provider calls are replaced by offline emulators as the adapter slices
  land (5.4, 6.9, 7.3). The stack runs offline.
- **Ports.** `web` on 3000, `api` on 3001, Postgres on 5432 and `proxy` on
  8080, all published on loopback only; `worker` and `supervisor` answer only
  inside the compose network. Override the published ports with
  `PORKBOT_WEB_PORT`, `PORKBOT_API_PORT`, `PORKBOT_POSTGRES_PORT`,
  `PORKBOT_REVERSE_PROXY_PORT`, and the health wait budget with
  `PORKBOT_STACK_WAIT_SECONDS`. The two database-role passwords default to local
  placeholders and are overridable with `PORKBOT_API_DB_PASSWORD` and
  `PORKBOT_WORKER_DB_PASSWORD`. The proxy serves the same `deploy/Caddyfile`
  the deployment runs, on a plain-HTTP loopback origin, so `stack:up` parses
  and healthchecks the shipped config; `http://localhost:8080` is one origin
  for the SPA, the API, the streams and `/healthz/stream`.
- **One socket, one owner.** The Docker socket is mounted into `supervisor`
  and nowhere else; `api` and `worker` reach computers through the supervisor
  with `PORKBOT_SUPERVISOR_URL` and `PORKBOT_SUPERVISOR_TOKEN`, both defaulting
  to local placeholders. The screen-capability signing key is
  `PORKBOT_SCREEN_TOKEN_SECRET`; a deployment that leaves it unset refuses
  screen access entirely.
- **A computer is offline, Docker or a cloud sandbox.** `supervisor` owns the
  provider choice and the generic computer settings: `PORKBOT_COMPUTER_PROVIDER`
  is `offline` by default, `docker` for real machines or `daytona` for the
  cloud; a bot may select any configured kind through its own
  `computerProvider` setting, and a kind this deployment did not configure is
  refused rather than silently replaced. `PORKBOT_COMPUTER_IMAGE` names the
  image a machine boots (required by either real provider),
  `PORKBOT_COMPUTER_SOCKET` is Docker's daemon socket,
  `PORKBOT_COMPUTER_ENDPOINT` / `PORKBOT_COMPUTER_TOKEN` (and optionally
  `PORKBOT_COMPUTER_TOOLBOX_URL`) are the cloud connection, and
  `PORKBOT_COMPUTER_CPUS` / `PORKBOT_COMPUTER_MEMORY_MB` /
  `PORKBOT_COMPUTER_DISK_MB` are one bot's share of the host floor under "A
  bot's computer". `PORKBOT_COMPUTER_IDLE_MS` (default fifteen minutes, zero
  disables) parks a machine no run is using; the home volume survives.
- **Credentials never enter a sandbox.** Model and provider keys stay
  server-side; a run's tools reach an upstream through a per-computer
  credential proxy that injects the credential on its own leg. The sandbox
  carries only a short-lived capability — the proxy's address and a signed
  token bound to one run and one computer — so a confused or compromised agent
  has nothing to exfiltrate. A Docker deployment configures the sidecar with
  `PORKBOT_COMPUTER_PROXY_IMAGE` (the image carrying the proxy entrypoint),
  `PORKBOT_PROXY_TOKEN_SECRET` (the capability-signing key, on the worker and
  the sidecars alike) and `PORKBOT_COMPUTER_EGRESS_NETWORK` (the deployment's
  egress network, the sidecar's second leg); the three are all-or-nothing, and
  unset means no proxy runs. Grants are written only by the supervisor, through
  the daemon's archive API, onto the sidecar's own layer — no bind, no shared
  volume, removed with the sidecar when the machine parks; a run's grant is
  revoked when the run ends and expires at the run's lease end regardless. `docs/credential-proxy.md` describes the boundary and what the
  deferred screen-takeover work inherits from it.
- **Backups are local and encrypted by default.** `backup` reads the snapshot
  archives through the storage seam (`storage-data`, read-only), writes
  AES-256-GCM objects to the `backup-data` volume and the sealed key envelope
  to `backup-envelope`, and runs the restore drill into a scratch database on
  the stack's Postgres. The local keyring and passphrase are placeholders like
  the database passwords; a deployment generates real ones and configures
  `PORKBOT_BACKUP_S3_*` for off-site storage. `docs/backups.md` is the runbook,
  including the recovery path from the envelope.
- **CI runs the same command.** The integration tier starts the stack with
  `pnpm stack:up`, attaches the testkit harness to the stack's Postgres instead
  of booting its own container, runs the integration suites against it, and
  removes the stack with `if: always()`. There is no CI-only compose file or
  boot script.
- **One migrate, then the always-on processes.** The `migrate` one-shot applies
  the committed journal, creates the two service roles and sets their passwords;
  `api` and `worker` wait on `service_completed_successfully` and then connect as
  their own roles. The six processes are the point — the api serves the
  contract's procedures, the worker runs the queue, the supervisor owns computer
  lifecycle, the backup process owns the encrypted nightly backup and its
  drill — and story 44 is one command that starts the real topology: a later
  slice replaces a process's body, never its place in the stack.

Each service image builds from the root `Dockerfile`; the shared build stage
installs and builds the workspace once and `pnpm deploy`s each app into its own
runtime image. Every process answers `/livez` and `/readyz`: liveness means the
process can answer, while readiness includes the dependency checks needed to
receive work. `/healthz` remains as a legacy liveness alias, and
`packages/health` is the shared implementation; `apps/api` keeps its own
request-aware surface and adds `/healthz/stream`, the timed probe the
reverse-proxy runbook uses (`docs/reverse-proxy.md`).

## Single-host deployment

`deploy/compose.yaml` is the production shape of the local stack: the same
Postgres 18, one-shot `migrate`, `api`, `worker`, `web`, `proxy` and
`supervisor`, with none of a developer's defaults left in it. Every secret and
every operator choice is read through `${NAME:?}`, so Compose itself refuses a
stack whose environment is incomplete, and every process exposes `/livez` plus
`/readyz`, which is the dependency-aware probe the container healthcheck asks.
On a host that has never run it:

```sh
pnpm install
pnpm deploy:up --origin https://bots.example.com
```

`deploy:up` renders the env file when it is missing, validates it, builds the
app images from the root `Dockerfile`, starts the stack, waits on compose's
`--wait` until every readiness healthcheck passes, and prints each service's state,
health and ports. A service that never becomes healthy fails the command,
prints the per-service state and the recent logs, and leaves nothing half-up.
`--tag <tag>` names the release the images are tagged with; the default is the
checkout's git SHA, so nothing is tagged `:latest`. An upgrade keeps the active
stack serving while it pulls the target images, starts disposable candidate
containers without published ports, and waits for their healthchecks. It then
runs the target release's migration image against the live database, checks the
candidates again, and only then switches the four application services. A
failed candidate check or migration removes those candidates and leaves the
active release running; a failed switch attempts to restore it.

- **The one env file.** `deploy/.env` is the single file (mode 0600,
  git-ignored). `pnpm deploy:setup` renders it from the committed
  `deploy/porkbot.env.example`, which documents every key, and generates every
  secret: the Postgres superuser password and the two service-role passwords;
  `PORKBOT_AUTH_SECRET`, `PORKBOT_SUPERVISOR_TOKEN` and
  `PORKBOT_SCREEN_TOKEN_SECRET`; the AES-256 `PORKBOT_CREDENTIAL_KEYS` keyring
  and its active id; and the credential-proxy capability token when the proxy
  is enabled. No key is hand-invented and no secret is printed by the command.
  `setup` is idempotent — a re-run keeps every existing value and fills only
  what is missing or blank — so enabling the credential proxy is
  `pnpm deploy:setup --proxy-image <ref> --egress-network <name>`. `--force`
  regenerates the generated secrets, which rotates credentials, and says what
  that breaks for a running cluster. The remaining values are the operator's:
  the public origin (required), the optional mail and run-notification
  webhooks, and the computer provider and its per-bot sizing.
- **Check without Docker.** `pnpm deploy:check` validates the env file on its
  own; `--compose` also makes Docker Compose interpolate the stack definition
  against it. The integration tier runs the CLI that way against the committed
  definition, so a typo in the production compose file fails CI by name.
- **What fails loudly.** A missing required value fails at Compose's
  interpolation (`${NAME:?}`) before a container is created, whether the stack
  is started by the command or by hand. `deploy:check` refuses the local
  stack's placeholders, a secret shorter than 24 characters, a secret reused
  across roles, a database password that is not URL-safe for its connection
  string, a keyring key that is not 32 bytes or whose active id is missing, an
  unresolved template sentinel, an origin that is not an absolute https origin
  outside loopback or that names a port the proxy does not publish, an image
  tag of `latest`, a partial mail/proxy/webhook configuration, and a real
  computer provider without the settings it boots from. The processes keep
  their own boot checks on top: the API refuses a partial auth pair or a
  missing storage root, the logger refuses an unknown level, and the supervisor
  refuses a computer provider it cannot construct.
- **The one public origin.** `proxy` runs the pinned Caddy image with the
  committed `deploy/Caddyfile`: it terminates HTTPS for the origin `deploy:up`
  was given, serves the SPA from `web`, the API and its streams from `api`, and
  is the only service that publishes a public port (`80` and `443` on
  `PORKBOT_BIND_ADDRESS`). The API and web ports stay on loopback. The config
  disables response buffering on the API path and caps client reads and idle
  connections, so a token stream crosses it frame by frame;
  `docs/reverse-proxy.md` is the contract and the runbook for when it does not.
  A proxy that cannot reach the API answers unhealthy, and Caddy keeps its
  certificates in the `caddy-data` volume across restarts.
- **Resource floors and per-bot sizing.** The host floor is 4 vCPU / 8 GB for
  the stack, plus roughly 2 GB and 50 GB+ of disk per bot, with 50 GB+ more for
  images (PRD decision 32; "A bot's computer" above). The stack's ceilings fit
  inside the base with headroom for the OS, the Docker daemon and the bots:

  | service            | CPU ceiling | memory ceiling |
  | ------------------ | ----------- | -------------- |
  | postgres           | 1.0         | 2 GB           |
  | migrate (one-shot) | 0.1         | 512 MB         |
  | api                | 0.7         | 1 GB           |
  | worker             | 0.45        | 1 GB           |
  | backup             | 0.25        | 256 MB         |
  | web                | 0.2         | 256 MB         |
  | proxy              | 0.1         | 128 MB         |
  | supervisor         | 0.2         | 384 MB         |

  Summed, the stack's ceilings are 3.0 vCPU and about 5.5 GB, so the base host
  runs the stack and one bot at its default `PORKBOT_COMPUTER_CPUS` (1) and
  `PORKBOT_COMPUTER_MEMORY_MB` (2048) with roughly 0.5 GB of memory left for
  the OS and the Docker daemon. Each additional bot adds its own ~2 GB and
  `PORKBOT_COMPUTER_DISK_MB` (10240), so the floor for N bots is
  4 vCPU / (8 + 2N) GB and (50 + 50N) GB+ of disk. Raise the ceilings in
  `deploy/compose.yaml` only after raising the host; the per-bot settings live
  in the env file and are re-read at supervisor boot.

- **Operating it.** `pnpm deploy:status` prints each service's state, health
  and published ports; `pnpm deploy:logs` follows the logs;
  `pnpm deploy:exec -- postgres psql -U porkbot` runs a command in a running
  service; `pnpm deploy:down` stops and removes the containers and network
  while keeping the volumes, and `pnpm deploy:down --volumes` also deletes
  Postgres data, bot storage, computer archives, the backup destination and
  envelope, and the proxy's certificates after saying so; the certificates are
  obtained again on the next boot. The proxy publishes
  `PORKBOT_BIND_ADDRESS:80` and `:443` — set it to `0.0.0.0` (or the host's
  public address) on a host reachable from the internet, and point DNS at the
  host before `deploy:up` so Caddy can obtain a certificate. Postgres is never
  published and the API and web answer on loopback only; `deploy:exec` is the
  way in. `deploy:exec -- backup node dist/cli.js status` reports the backup
  ledger and the envelope, and
  `deploy:exec -- backup node dist/cli.js restore --latest --database <name>`
  is the recovery path (`docs/backups.md`). `pnpm deploy:upgrade --tag <git-sha>`
  is the one-command release path; it records the prior tag in the adjacent
  ignored release state so `pnpm deploy:rollback` can redeploy it. Rollback is
  not a schema rollback: it runs the previous image against the newer schema
  and never attempts to reverse migrations. If the older image is incompatible
  with that schema, restore a compatible database backup separately before
  retrying, and the operator runbooks are 12.7.

## Desktop releases

`apps/desktop` ships as one artifact per platform, and a release is a tag, a
GitHub Release that is never overwritten, and a signed `update-<platform>-<arch>.json`
whose digest names the artifact's exact bytes. The `desktop` CI tier runs the
same pipeline on every pull request — package for linux-x64, sign with a
throwaway key, verify, then start the packaged app under Xvfb against a real
API process on loopback until the sign-in screen renders — and the `Release`
workflow does it for real from a manual dispatch. No step needs a maintainer's
machine. The full runbook is in [`docs/release.md`](docs/release.md).

```sh
pnpm release:bump patch           # in a pull request: 0.0.0 -> 0.0.1
pnpm desktop:package -- --targets linux-x64 --out .release
pnpm desktop:smoke -- --app .release/PorkBot-linux-x64/PorkBot \
  --server-url http://127.0.0.1:3001
```

(The `--` before a script's flags keeps pnpm from reading them as its own;
`pnpm release:bump patch` needs none because the bump keyword is positional.)

- **One command per step.** `packages/testkit/src/release/cli.ts` is the whole
  pipeline: `bump` writes the version, `package` stages the production
  dependency closure and the web client with @electron/packager, `sign` signs
  each artifact's SHA-512 into the manifest the app verifies, `verify` re-hashes
  every artifact and checks every signature against the pinned public key, and
  `smoke` drives the packaged app's own first-run flow through the Chrome
  DevTools Protocol. The artifact name carries the version, the platform and
  the git commit (`PorkBot-0.2.0-linux-x64-3f9c2a1b0d4e.tar.gz`), and
  `build-manifest.json` records the full commit, the Electron version and every
  digest.
- **The key is a deployment secret.** `PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY` (a
  GitHub Actions secret) signs; the public half is the value the app pins as
  `PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY`. The workflow refuses to publish without
  them, and the desktop's own suite fails if the release's canonical signing
  bytes and the app's verified bytes drift apart.
- **OS code signing is the operator's.** The Ed25519 manifest is the trust
  boundary the app enforces; Apple notarization and Windows Authenticode are
  deployment certificates the project does not hold, so the macOS and Windows
  artifacts are unsigned by the OS and a downloading operator decides whether
  to trust the publisher. Linux artifacts run as extracted.

## Environment configuration

Every variable an entrypoint reads is declared in a `.env.schema` next to it
([varlock](https://varlock.dev), pinned in `dependencies.json`). The root
`.env.schema` owns the values more than one process uses; `apps/api`,
`apps/worker`, `apps/supervisor`, `apps/web`, `packages/db` (the migration
runner) and `packages/adapters` (the credential-proxy sidecar) each own theirs
and import the root for the shared keys. The schemas are the source of truth:
`varlock audit`, run by `pnpm env:check` and the required `env` CI tier, fails
when code reads a key the schema does not declare, or a schema declares a key
no code reads.

- **Local development.** The api, worker and supervisor `dev` scripts run
  through `varlock run`, as does web's built host (`pnpm --filter
@porkbot/web serve`), so environment files are resolved and validated before
  the process starts. Put local values in a git-ignored `.env.local` — the root
  one applies to every app, an app's own wins — and keep the sensitive ones
  encrypted, so they never sit in plaintext: write `DATABASE_URL=varlock(prompt)`,
  run `pnpm dev` once, and the encrypted form is written back. `varlock reveal
DATABASE_URL` prints a value, and `varlock encrypt --file .env.local`
  encrypts a file of plaintext values in place. The key is device-local: these
  files are not shared between machines and never committed. Vite's dev server
  reads no environment variables and is not wrapped. `varlock scan` checks the
  tracked tree for a resolved sensitive value that leaked into plaintext, so a
  secret caught by a schema is still caught when it is copied into a file.
- **Signing in locally.** `PORKBOT_AUTH_SECRET` and `PORKBOT_AUTH_ORIGIN` are
  all-or-nothing: with both set the API mounts Better Auth at `/api/auth/*` and
  resolves the session cookie the gate reads; with neither it boots fail-closed
  and every authenticated procedure answers its typed 401; with one it refuses
  to boot. They are declared in `apps/api/.env.schema`, so local values go in
  `apps/api/.env.local` — the root `.env.local` is for the values the root
  schema owns. The web dev server proxies the API's paths to port 3001
  (`apps/web/vite.config.ts`), so the SPA and the API share one origin and
  `PORKBOT_AUTH_ORIGIN` is that origin — `http://localhost:5173` for `pnpm dev`.
  Signup stays closed until the deployment's settings row opens it, so run
  `insert into deployment_settings (signups_enabled, admin_email) values (true,
'<the operator email>')` against the database — through the stack's Postgres
  (`docker compose exec postgres psql -U porkbot -d porkbot`) or any `psql`
  with `DATABASE_URL` — and the sign-up screen admits that email as the owner.
  Optional mail for reset and verification is the `PORKBOT_MAIL_ENDPOINT`,
  `PORKBOT_MAIL_FROM` and `PORKBOT_MAIL_KEY` trio, also all-or-nothing; unset,
  sign-in and sign-out still work and mail is refused as a typed
  configuration error.
- **CI.** `pnpm env:check` loads every schema with `APP_ENV=ci` and the
  committed `.env.ci` fixtures — obvious fakes, never secrets — because the
  tier must prove required items resolve without a deployment's environment.
  The tier deliberately does not use `APP_ENV=test`; Vite loads `.env.test`
  into every Vitest process, and CI fixtures have no business there.
- **Production.** The deployment injects real environment variables and varlock
  is not in the runtime image; it reads nothing there. The schema's job in
  production is to be the contract the variables must satisfy, and the `env`
  tier is what proves code and schema still agree.

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

## Provider seams

`packages/adapter-kit` declares one interface per external capability — mail,
credentials, computers, the model runtime, memory, MCP servers, notifications,
realtime fanout, storage and web access — plus the shared failure vocabulary (`gone`,
`not_found`, `rate_limited`, `timed_out`, `auth_failed`) that every adapter
translates its own errors into. It ships no implementation and imports no vendor
SDK; implementations and their offline emulators live in `packages/adapters`,
and lifecycle code branches on the failure kind rather than on a provider's
error string.

Every declared interface names at least two planned implementations, each pinned
to the roadmap slice that lands it, in `PROVIDER_INTERFACES` in
`packages/adapter-kit/src/provider-plan.ts`, and carries a failure mapping that
documents every kind in the vocabulary. `provider-plan.test.ts` fails when a
declared interface is missing from the register or the shapes list, carries
fewer than two implementations, or leaves a failure kind undocumented, so "an
interface with one implementation is a hypothesis" is a check rather than a
convention.

## Run session seam

Steering and approval are writes into a live run, not reads of one, so the run
interface is duplex. `AgentRuntime` — declared in `packages/effect`, because both
halves are Effect values and the event vocabulary is `packages/core`'s
`RunEvent` — exposes a `RunSession` with an `events: Stream<RunEvent>` half and a
`commands: Mailbox<Steer | Stop | Approve | Deny>` half. The layer that provides
it is run-scoped (`requestTag` + `requestScoped`, PRD decision 27), so a session
cannot outlive its run, and it holds no database handle.

`LiveRuns` is the process's registry of live sessions: `dispatch` writes a
command into the run's mailbox, or answers the typed `RunGoneError` for a run
this process does not hold — never a hang, never a silent drop. Losing the fence
is interruption: `fenced` races the run against the worker's fence-loss signal,
so the whole run fiber tree stops, and the adapter cancels in-flight work and
reports a terminal `run.cancelled` instead of completing a tool call that would
commit after the lease moved.

The runtime emulator (`emulatorAgentRuntimeLayer`) in `packages/adapters` is the
offline implementation: deterministic scripts over mailboxes, no keys, no
network and no clock, driving the shipped seam end to end in that package's
suite. The Pi adapter (`piAgentRuntimeLayer`) is the second implementation: it
consumes Pi's async iterator of canonical events and exposes the same seam,
mapping every event through one explicit table (`PI_EVENT_MAPPING`) and refusing
an unknown event, field or nested update with a typed error. Its golden corpus
in `packages/adapters/src/pi-corpus` replays sessions recorded from the pinned Pi
version and asserts the reduced snapshot, and the suite refuses the corpus when
the pin moves without it being re-recorded. The orchestrator names no
implementation.

## Tool dispatch

The list the model sees and the code that runs a tool cannot drift: a tool is
one `ToolRegistration` — name, description, JSON Schema, a duration budget and
the handler — and `createToolDispatcher` in `packages/effect` generates the
model-facing metadata from the same values `execute` dispatches. An unknown
name is the typed `UnknownToolError` the runtime reports back to the model,
never a silent no-op.

Every call carries the model's durable `callId` as its non-null idempotency
key. The dispatcher claims it in a `ToolCallLedger` before the side effect and
settles it after, so a retry replays the stored outcome; an id already in
flight, or reused for a different request, is a typed conflict, and a call
without an id is refused before any effect. `packages/db` implements the ledger
over the `external_effect` unique index, so the claim is atomic in Postgres and
a retry after a worker restart still replays.

Before the handler runs, the dispatcher awaits the run's fenced heartbeat, and
it refuses a registration whose declared duration outlives the run lease TTL: a
side effect that can outlive its lease can commit under another owner. The
declared duration is also the hard budget — a handler that overruns it is
interrupted and reported as a failed call.

## Tool-call lifecycle

A tool call is visible from requested to completed or failed, with arguments,
result summary and timing, and the timeline survives a reload.
`createRunEventRecorder` in `packages/effect` is the one transform every
consumer runs a session's events through — the durable row, the live frame and
a replayed one — so all three are the same bytes. The recorder redacts
secret-shaped arguments with the logging helper, replaces a result past the
inline budget with a bounded preview plus a `resultArtifact` pointer to the
call's `external_effect` row, and stamps the settled call with its wall-clock
`durationMs`; the artifact is never dropped silently.

`RunEventSink` is the write half. `createRunEventSink` in `packages/db`
appends the recorded event to the `event` table in one scoped statement that
advances the thread's `next_event_seq` counter with the row, so
`(thread_id, seq)` stays contiguous and a reconnecting subscriber replays
exactly what the run emitted. Reducing the replayed stream equals reducing the
live one, and the ledger stores a redacted request, so a retry with the same
secret-shaped arguments still replays while the secret never reaches the
durable audit row. The unit suites prove the recorder over a manual clock and
the sink over a recording fake; the `packages/db` integration suite drives both
on Postgres, reads the rows back through the actor-scoped repository, and
resolves the artifact to the full result.

## A bot's computer

A run's machine is one interface away from any provider: `ComputerProvider` in
`packages/adapter-kit` declares `ensure`, `status`, `stop`, `list`, `exec`,
`snapshot`, `restore` and `destroy`, with the v1.1 screen path reserved as the
optional `frames()` and `input()`. `ComputerEmulator` (slice 6.9) is the offline
implementation: every computer is an in-process machine with its own
filesystem, a bounded POSIX-shaped shell and a scripted browser, reached only
through `exec` exactly as a container is. State persists across commands and is
isolated per `computerId`; nothing touches the host's filesystem; a snapshot is
a deep copy that restores into a destroyed machine; `frames()` renders the
current screen as deterministic SVG and `input()` changes what the next frame
shows. `packages/adapters/src/computer-conformance.ts` is the suite every
provider is held to — idempotent `ensure`, idempotent `stop`, `list`,
`gone` answers, timeout classification, persistence across commands, isolation
between computers, snapshot and restore, the reserved path and the browser
protocol — and the Docker provider registers it against a real container while
the cloud provider registers the same suite against its offline API emulator.

The supervisor owns lifecycle (slice 7.1). `apps/supervisor` is the only
process that will hold the Docker socket and the only one that constructs a
computer provider; the API holds `createSupervisorComputerProvider` today —
from `packages/adapters`, an authenticated client for the supervisor's internal
surface (`server.ts`) — and the worker reaches a computer through the same
client once its run path needs one. Boot, stop, reset and recover are
compositions inside the supervisor, reconciliation on boot adopts whatever a
crashed process left behind, and every machine gets its own internal Docker
network with an isolated gateway (`planComputerNetwork` in `packages/core`), so
a computer reaches neither another bot's machine nor a service on the host.
Screen access is gated by a short-lived capability token bound to one computer
and one actor even though the stream behind it is v1.1 work. The operator's
reach is `computers.status`, `boot`, `stop`, `reset` and `recover` in the
contract, scoped by bot id.

The real local machine is `createDockerComputerProvider` (slice 7.2). It is
constructed only inside the supervisor, speaks the Docker Engine API over the
mounted socket — no SDK, no CLI — and gives every bot one container on its own
internal network, its home on a named volume. Boot is bounded and reported: a
machine that does not become ready inside the boot budget fails as the shared
vocabulary's `timed_out`, and every daemon refusal is translated by
`docker-errors.ts` alone — `gone`, `not_found`, `rate_limited`, `timed_out`,
`auth_failed` — so lifecycle code reads no Docker status and no Docker message.
`stop` parks the container, `destroy` removes it and keeps the home volume, so
the supervisor's reset rebuilds a clean machine with the agent's files intact,
and the idle sweep parks anything no run has used for `PORKBOT_COMPUTER_IDLE_MS`
with the same guarantee. Ceilings are per bot: CPU, memory (swap pinned to the
same ceiling), the process count, and a write-layer disk quota that only
applies with `PORKBOT_COMPUTER_DISK_QUOTA=storage-opt` on a daemon whose
storage driver answers it. The defaults are one bot's share of the documented
floor — a host of 4 vCPU and 8 GB plus roughly 2 GB and 50 GB+ of disk per bot,
with 50 GB+ more for images — and the README setting the floors is the
deployment contract, so raise the ceilings only after raising the host.
Snapshots stream the home through the archive API into a staging file that the
shared snapshot store writes through the storage seam (slice 7.5). The image
contract is a POSIX shell
and the coreutils `timeout` the command budget is enforced with. The offline
suite drives the provider through a fake Engine API on a unix socket, and the
supervisor's integration tier runs the shared conformance suite against a real
container, asserts the ceilings on the daemon's own inspect output, and shows
that an idle stop and a reset both keep the home.

The second real machine is `createDaytonaComputerProvider` (slice 7.3), the
cloud implementation of the same seam. It is chosen over E2B and Box because
Daytona's control plane and sandbox toolbox are plain REST + JSON with a
published OpenAPI document, so the adapter and its offline emulator speak the
real wire without a generated Connect/gRPC client and a self-hoster can run the
same API. One sandbox per bot, labelled `porkbot.*`, created from the
deployment's image with the per-bot CPU, memory and disk ceilings; `stop` parks
it (Daytona keeps a stopped sandbox's filesystem), `start` resumes it,
`recover` brings an errored sandbox back, and `remove` deletes it, so the
home's durability is the snapshot path — `tar` in the sandbox and the archive
through the toolbox download/upload into a staging file, then through the
shared snapshot store into the storage seam and restored before the machine
runs again. `daytona-errors.ts` is the one module
allowed to read a Daytona status or message, and the decision it shares with
Docker — is the machine gone, is a named thing missing — lives once in
`computer-failure.ts`.

The two real providers are two runtimes under one lifecycle. `ensure`, `stop`,
bounded readiness, `gone` answers, scoped snapshot keys and idempotent destroy
are composed once in `computer-runtime.ts` over the primitives only a provider
can answer (find, list, create, start, stop, remove, ready, exec, readHome,
writeHome); the Docker and Daytona modules supply those primitives and their
classifiers, and the shared conformance suite runs the same cases against both
— the Docker provider against a real container in the integration tier, the
Daytona provider against its offline API emulator in the unit tier, and both
through the supervisor's transport. The supervisor holds a registry of the
kinds its deployment configured; each per-bot `computerProvider` setting routes
that bot's calls, `list` re-tags every machine with the provider that holds it,
and an unconfigured kind is refused with the shared `not_found`. The reserved
`frames()`/`input()` path stays in the interface: neither v1.0 real provider
implements it, and the offline emulator exercises the path so the v1.1 surface
stays alive.

Snapshot and restore (slice 7.5, PRD story 30) is one store over the storage
seam. `createComputerSnapshotStore` in `packages/adapters` is the only place a
home archive meets storage: `write` stages the archive the provider produced
under `computer-snapshots/<scope>/<id>.tar` — the scope hashes the computer's
bot and id, so a snapshot cannot be pointed at another machine — and records
its size and SHA-256; `read` fetches the object, verifies both before a byte
reaches a machine, and refuses a missing, truncated or altered archive as the
shared `not_found`. A restore that fails validation leaves the existing
computer exactly as it was, which is what makes "a corrupted snapshot never
half-boots a computer" a property rather than a hope, and the same store is
tested over local storage and over the S3-compatible provider's emulator
because it knows only `StorageProvider`. What a snapshot captures is the agent
home — files, not processes: running commands, open sessions and network
connections are not in the archive, and a restore brings the files back into a
fresh machine.

The operator's half is space-scoped. Each capture is recorded in
`computer_snapshot` (the API's migration `0029`, grants `0030`), and
`computers.snapshot`, `computers.snapshots` and `computers.restore` resolve
that row through the actor-scoped repository before the supervisor is dialed —
a snapshot from another space, or from another bot in the same space, is the
typed `NOT_FOUND`, and the contract names a row, never a storage key. The
supervisor builds one storage seam from `PORKBOT_STORAGE_DIR` and stages
archives under `PORKBOT_COMPUTER_ARCHIVE_DIR`; a real provider configured
without a storage root fails at supervisor boot rather than capturing an
archive it cannot keep.

The model reaches that machine through `createComputerTools` in
`packages/effect`: `shell`, `file_read`, `file_write`, `file_list` and
`browser` are registrations over the fenced command runner, which is
`ComputerProvider.exec` under the run's computer lease. The computer is bound at
construction, never chosen by a tool argument; every command carries the run's
declared budget as its hard `timeoutMs`; file writes travel base64-encoded so no
shell metacharacter is interpreted; and file bytes, shell stdout and browser page
text leave as `UntrustedContent` (paths `file_read` and `computer_output`)
before they can reach a prompt. The browser helper protocol is one `browser`
command with a JSON argument returning a JSON page record, which is what a real
provider's image must ship to pass the same suite. The file tools are confined
to the home (`confineToHome`, slice 7.6), and a file the model writes is
recorded as a downloadable artifact when the run is given an
`ArtifactRecorder`.

The first full run executes real tools (slice 6.9). The shipped offline runtime
now takes a `ToolDispatcher` and executes its tool steps through the same
ledger, budget and failure machinery a Pi-backed run uses, so a run composed
from the emulated computer, the computer tools and the offline session
completes with real file, shell and browser effects — no key, no network and no
Docker. `apps/worker/src/offline-run.test.ts` drives that path under the
worker's execution harness and observes the run settle completed with the
written file read back and the page text labelled.

A run's commands are fenced like its writes (slice 7.4). `createFencedComputerCommands`
in `packages/effect` holds the bot's computer for the run's own
`(runId, owner, fence)` on a durable `computer_lease` row, then holds it again
after the provider answers and only then records the command's outcome against
the tool call's durable id. A reclaim moves the fence, so the second hold
matches nothing and the command fails with the typed `LeaseLostError` — the
transport's `CONFLICT` — instead of committing a result under an owner that no
longer exists; a retried command with the same call id replays the recorded
outcome, and a machine held live by another run is the classified
`rate_limited` rather than a provider timeout. The computer lease's TTL is
asserted at that guard never to outlive the run lease's, so a stale holder's
command dies within the window the run lease already allows; a run that settles
releases the lease as part of settling, and the watchdog pass below also
deletes whatever expired rows a crash left behind. `packages/db` owns the
`computer_lease` rows behind the `ComputerLeaseStore` seam, and its integration
suite races two real connections against the unique `bot_id` index, drives the
reclaim through the live guard and ledger, and shows the watchdog scan finding
and clearing an expired row.

## Approval gates

Approval is durable pending state, not a live socket (PRD decision 13). A gated
tool call has a durable `callId`, and `createApprovalGate` in `packages/effect`
records a row for it before the run waits: the gate opens (or reopens, on the
original deadline) the `approval` row, and `waitFor` polls it until an operator
decision or the deadline settles it. Polling is the wake-up on purpose — a
decision taken in another process is visible on the next read, so there is no
signal to lose and the interval is a latency knob, not a correctness one.

The deadline is the store's, not the waiter's. `resolveTimeout` is a guarded
compare-and-set on `status = 'pending'` with `expires_at <= now()` as the
server's clock, so a timeout can never fire early; when it wins, the run answers
the typed `GateTimeoutError`, which is a deny — never a crash and never a hang.
A store that cannot record the gate fails closed with `ApprovalStoreError`
instead of running a tool behind an approval nobody can see.

Decisions are durable too. `packages/db` implements the seam over the `approval`
table keyed by `(run_id, call_id)`, with `createApprovalStore` split by actor:
a job opens gates and settles deadlines, an operator votes and reads the
timeline, and the grants in `0008_approval_grants.sql` are column-level so a job
cannot vote in a user's name and the API cannot move a deadline. A vote and a
timeout are both compare-and-sets, so concurrent approve/deny resolves exactly
once and the loser answers from the stored row. The resolution check makes the
audit structural: an approved or denied row always carries the deciding user and
the instant, and a `timed_out` row carries the instant with no user at all.

The wire vocabulary carries the gate to the client: `approval.requested` names
the call and its deadline, `approval.resolved` carries `approved`, `denied` or
`timed_out`, and the shared reducer attaches the gate to the tool call it
belongs to — so the same event list always renders the same gate. A reloading
client reads the durable rows through `listForRun` and replays the recorded
stream from the `event` table, so the gate it sees is the one the run recorded,
not the one a connection happened to hold.

## Fenced runs, reclaim and resume

A run is executed inside `withRunFence` in `packages/effect`: it heartbeats on
the shared interval, and the first beat that cannot be renewed — a typed
`LeaseLostError`, or any failure at all, because work that cannot be renewed
cannot be committed — completes a fence-loss signal that interrupts the run's
whole fiber tree. The adapter inside cancels and reports; it never finishes a
tool call and commits a side effect the next owner already owns. The worker's
execution harness (`apps/worker/src/run-execution.ts`) wraps that fence around
the run's work and settles the run and its attempt in one fenced statement:
`completed` on success, `failed` with the work's message on failure, and on a
lost lease no run write at all — only the best-effort closing of its own attempt
as `abandoned`.

Recovery is a reclaim, never a restart. A `run.watchdog` job scheduled every
minute scans `findExpiredLeases` — the one deliberate cross-space read in the
database package, addressing only — re-reads each candidate through a
`SystemActor` for its space, and reclaims it with the same CAS every other
reclaimer uses, so two watchdogs produce one winner. The reclaim is one
statement that moves the fence, closes the superseded attempt as `abandoned`
with the reason, and settles every tool-call row the old owner left `pending` or
`running` as `failed` with the same reason. A run whose stored checkpoint carries
session state is handed off to a fresh `run.execute` delivery, which adopts the
live lease by the exact `(fence, owner)` pair the watchdog held; a run that
stopped before its first checkpoint is failed with a typed reason
(`checkpoint_absent`, `checkpoint_unreadable`) from `@porkbot/core`'s
`decideReclaim`, never silently restarted. The resume therefore sees
`resumed: true`, its checkpoint, and replayed tool-call outcomes instead of a
second side effect.

The same pass sweeps the computer lease (slice 7.4). `findExpiredComputerLeases`
is the second deliberate cross-space read, and each expired row is deleted
through the `SystemActor` its space names, so a machine whose holder stopped
renewing — a crashed worker, a run whose fence moved, a holder that stopped
between commands — is free for the next run instead of blocked until someone
notices. The sweep runs on every pass, including one that finds no expired run
lease, because a stale computer is stale on its own.

## Dependencies

`dependencies.json` at the repository root is the pin register: every package
pinned to an exact version and every container image pinned to a `@sha256:`
digest, each with the reason it is pinned. `.npmrc` sets `save-exact=true`, so
`pnpm add` writes exact versions by default.

Three things have to agree, and `pnpm dependencies:check` — the `dependencies`
CI tier, which reads files and runs before any install — fails when they do not:

- the register says one exact version for a pinned package;
- the workspace manifest that declares it writes exactly that version;
- `pnpm-lock.yaml` resolves exactly that version, and every resolved package
  carries the `integrity` hash its tarball was fetched under.

Every image reference a build reads — `FROM` in a Dockerfile, `image:` in a
Compose file, `docker pull` in a workflow — must name a digest registered in
`dependencies.json`, and the testkit harness's Postgres image is cross-checked
the same way. `pnpm dependencies:diff`, and the CI job on every pull request,
writes the lockfile delta against the base branch to the job summary, so a
dependency change is reviewed as a diff. Adding a dependency states the reason
in the pull request's Dependencies section.

## Logging

`packages/logging` is the only writer of logs. Every line is one JSON object:
`level`, `timestamp`, `msg`, and — when a request or a run is in scope —
`correlationId`, plus the context and fields the call site passes.

```ts
const logger = createLogger({ service: "@porkbot/api" });
const request = logger.child({ requestId: "req-1" });
const run = logger.child({ runId: "run-9" });

request.info("connected", { botId }); // one JSON line
request.request({ method, path, status, durationMs }); // level follows status
run.error("run failed", { error }); // error serialized + redacted
```

- **Level.** `LOG_LEVEL` selects `debug`, `info`, `warn` or `error`; unset or
  blank means `info`, and an unknown value fails startup rather than silently
  logging at the wrong level. `LOG_LEVEL` is a turbo global env, so changing it
  invalidates cached tasks instead of reusing output written at another level.
- **Correlation.** `child({ requestId })` and `child({ runId })` fold the id
  into `correlationId` on every line, so one request or run can be followed
  across the process. The API generates a request id per request (honouring an
  incoming `x-request-id`), echoes it in the response, and logs the finished
  request at a level derived from the status: 5xx error, 4xx warn, otherwise
  info.
- **Run liveness.** A worker job creates its run child logger at the job
  boundary, so execution, lease recovery, stall detection and notification
  lines carry both `runId` and `correlationId`. The run timeline and its
  stalled-run notification remain the operator's durable signal when a run
  stops making progress.
- **Redaction is wired in, not opt-in.** The logger redacts before it writes:
  fields named `key`, `token`, `secret` or `password` (and compounds such as
  `apiKey` or `X-Api-Key`, plus `authorization`, `cookie` and `credentials`)
  become `[redacted]`, sensitive query parameters are stripped from request
  paths, and every string is scrubbed of known shapes — `Bearer …`, `sk-…`,
  JWTs, connection strings with credentials, PEM private keys, `password=…`.
  Errors are serialized with their message, stack and cause redacted too. A
  string longer than 4 KiB is replaced whole with `[truncated]` rather than
  scanned: a validation error carries its input as the error's cause, and
  logging an unbounded caller-supplied value would make the scanner the target.
- **Opting out is review-visible.** Keeping one of those fields requires
  `unredacted(value)` at the exact call site. Grep for `unredacted(` to see
  every place a secret is deliberately allowed into a log.

`packages/logging` has no workspace imports and no dependencies; it is a leaf
like `packages/core`, so every package can log without a cycle.

## Transport

`packages/contracts` is the single source of transport truth (PRD decisions 14
and 15). Every procedure's input, output and typed errors live there as Zod
schemas composed with oRPC's contract builder; `appContract` is the tree the API
implements, and `AppClient` is derived from it — adding a procedure is an edit
to `contract.ts`, the server fails to compile until it implements the new
procedure, and no client-side type is written or updated by hand.

```ts
// packages/contracts/src/contract.ts — the contract tree
export const appContract = {
  deployment: { status: deploymentStatusContract },
  account: { me: accountMeContract },
  bots: { get: botsGetContract },
};

// packages/contracts/src/client.ts — the derived client
export type AppClient = ContractRouterClient<AppContract>;
export function createApiClient(options: { url: string | URL }): AppClient;
```

`apps/api` mounts the implemented router on Hono at `/rpc`, exposes `/livez`
for process liveness and `/readyz` for its database dependency (while keeping
`/healthz` as a legacy alias), and owns the request boundary: every response gets a
correlation id and a redacted request line, and a defect is logged redacted and
answered as a 500. Routers live in `apps/api/src/routers/`, delegate to the
services `main.ts` injects, and stay one screen each; contract schemas are the
only validation layer, so a handler sees parsed input and returns the declared
output — an output that violates its schema is rejected before it reaches the
wire.

```ts
// apps/api/src/routers/deployment.ts — one screen, no business logic
const status = publicOnly.deployment.status.handler(async ({ errors }) => {
  const result = await service.status();
  if (result.kind === "misconfigured") throw errors.SERVICE_UNAVAILABLE();
  return { signups: result.kind };
});
```

The OpenAPI document is generated from that same `appContract` object with
`createOpenApiDocument()`, and a test asserts the procedure's path, method,
operation id, success response and typed error in it. The transport libraries
are pinned in `dependencies.json` and owned by exactly one package in the module
map: `@orpc/contract` and `@orpc/client` belong to `@porkbot/contracts`, and
Hono, `@hono/node-server`, `@orpc/server`, `@orpc/openapi` and `@orpc/zod`
belong to `@porkbot/api`.

The API process reads `DATABASE_URL` and exits when it is missing. The local
stack supplies it in `compose.yaml`; unit tests inject a service, and the e2e
spec starts the process with a placeholder URL it never dials.

## Rate limits, body caps and connection caps

`apps/api/src/limits.ts` is the one place limits live (PRD decision 9). The
reference implementation had no rate limiting anywhere; the failure this module
is built against is a route added later that is silently unlimited, so it is
three single places:

- **One register.** `routeRules(rpcPath)` names every route family — the health
  probe, the whole `/rpc` surface, and the webhook family a later slice mounts —
  and the budget each draws from. A path the register does not know still draws
  the anonymous budget rather than none.
- **One installer.** `installLimits` registers the middleware before any route;
  the gate spends the RPC budget after it has resolved an actor, the middleware
  spends the rest, and both use the same accounting object.
- **One answer.** An RPC refusal is the contract's typed `RATE_LIMITED` with
  `{ retryAfterSeconds }` in its `data` and a `Retry-After` header; an HTTP
  surface gets a `429` JSON body and the same header. A refused stream gets the
  RPC error envelope when it is on the `/rpc` path.

What is limited, per minute unless noted:

| Surface                        | Key                  | Default | Variable                                 |
| ------------------------------ | -------------------- | ------- | ---------------------------------------- |
| Authenticated RPC              | actor (`space:user`) | 300     | `PORKBOT_LIMIT_AUTHENTICATED_PER_MINUTE` |
| Public RPC and unmatched paths | client address       | 60      | `PORKBOT_LIMIT_ANONYMOUS_PER_MINUTE`     |
| Health probe                   | client address       | 600     | `PORKBOT_LIMIT_PROBE_PER_MINUTE`         |
| Inbound webhooks               | client address       | 120     | `PORKBOT_LIMIT_WEBHOOK_PER_MINUTE`       |
| Attachment uploads             | client address       | 60      | `PORKBOT_LIMIT_UPLOAD_PER_MINUTE`        |
| RPC request body               | —                    | 1 MiB   | `PORKBOT_LIMIT_MAX_BODY_BYTES`           |
| Webhook request body           | —                    | 256 KiB | `PORKBOT_LIMIT_MAX_WEBHOOK_BODY_BYTES`   |
| Attachment upload body         | —                    | 8 MiB   | `PORKBOT_LIMIT_MAX_UPLOAD_BYTES`         |
| Open streams per actor         | actor                | 4       | `PORKBOT_LIMIT_MAX_STREAMS_PER_ACTOR`    |

An unset or blank variable takes the default; a value that is not a positive
integer fails startup rather than silently guarding with a number nobody chose.
Body caps are checked from `Content-Length` or while the body streams, so an
oversized payload is refused before it is parsed or buffered past the cap. Any
`text/event-stream` response holds a per-principal slot until it closes, errors
or the client disconnects, so one actor cannot exhaust the connection slots
another actor needs — the SSE slice inherits that without asking for it.

The anonymous budgets are keyed by the connection's remote address, never by
`X-Forwarded-For`; a process behind a proxy passes its own `clientKey` through
`createApiServer` instead of trusting a header. Limits are in process memory:
v1.0 is a single host with one API process, so a shared store would be a
dependency the topology does not need. A test walks the contract tree and fails
when a procedure has no limit, and another walks the installed routes and fails
when a route has no rule.

## Resumable streams

`threads.events` is the per-thread subscription (slice 4.3, PRD decisions 14
and 18; story 19). The durable `event` rows are the stream; the realtime fanout
is only a wake-up:

- **One subscription per thread.** The contract is `GET
/threads/{threadId}/events` with an `eventIterator` output, so the derived
  client types the frames as `RunEvent` and both web and desktop feed the same
  reducer in `packages/core`. The transport is SSE with oRPC's keep-alive
  comments.
- **The cursor is a signed position.** Every frame's SSE `id` is an
  HMAC-signed `{ actor, space, thread, seq }` minted by
  `apps/api/src/cursors.ts`; a reconnecting client sends it back as
  `Last-Event-ID`, which oRPC hands the handler as `lastEventId`. The id is
  transport metadata: `getEventMeta(event)?.id` on the client.
- **A refused cursor is typed.** A malformed, forged or foreign cursor is the
  contract's typed `BAD_REQUEST` before any frame is sent; a thread outside the
  actor's space, or one whose membership was revoked between connect and
  resume, is the same `NOT_FOUND` as a missing row. Subscribe and resume both
  re-resolve the session and the membership, and the replay loop re-reads the
  membership before every frame, so a revoked membership ends a subscription
  that is already open before another event is delivered — the client's
  reconnect is then refused with the typed `NOT_FOUND`.
- **Reconnection backs off the core way.** `subscribeThreadEvents` in
  `@porkbot/contracts` (built on `backoffDelayMs` from `@porkbot/core`) resumes
  from the last received id on a network error or 5xx/429 and rethrows a typed
  4xx rather than retrying it forever.
- **A lost signal costs a query.** The subscription subscribes to the fanout,
  re-reads `seq > cursor` from the actor-scoped repository after every wake-up,
  and re-reads after the initial replay, so a dropped signal is latency and a
  duplicate is a no-op. `InProcessRealtimeFanout` ships in `@porkbot/adapters`;
  the cross-process Postgres `LISTEN`/`NOTIFY` implementation lands in slice
  6.1 behind the same interface.

The stream holds a per-actor connection slot like any other `text/event-stream`
response (slice 4.4), and closing the connection ends the subscription, never
the run (PRD decision 25).

## Auth gate

PRD decision 7 makes authorization structure rather than discipline, and slice
3.2 is the structure: `apps/api/src/gate.ts` is the single auth gate.
`openProcedureContext()` reads the session once through `createActorResolver` in
`@porkbot/auth` (session cookie to user id, `resolveUserActor` in
`packages/db` to the membership row), and builds the actor-scoped repositories
that are the only data access a handler can reach. The context carries an
`Actor` and repositories; no contract input names a space, and a by-id read is
the repository's scoped read, so a row in another space and a row that does not
exist are the same typed `NOT_FOUND`.

Two implementers hang off one contract, so access is decided at registration:

- `authenticated` is the default. Its middleware answers the procedure's own
  typed `UNAUTHORIZED` when there is no actor and hands the handler a context
  whose `actor` and `repositories` are non-null.
- `publicOnly` is the deliberate exception and fails closed unless the contract
  marks the procedure with `publicProcedure`.

```ts
// packages/contracts/src/account.ts — an authenticated procedure
export const accountMeContract = authenticatedProcedure.route({ ... }).output( ... );

// apps/api/src/routers/account.ts — registered through the gate
const me = authenticated.account.me.handler(({ context }) => ({ ...context.actor }));
```

`packages/contracts/src/contract.ts` lists every public procedure in
`publicProcedures`, and `access.test.ts` fails when the list and the contract
drift or an authenticated procedure forgets its 401. In the API, `implement(...)`
is called only in `gate.ts`; `packages/eslint-config/auth-gate.js` fails lint for
a router that registers procedures itself, and the PR checklist asks a reviewer
to account for every public procedure. Public procedures today are exactly
`deployment.status`.

The gate's dependencies are injected: tests compose a fake session resolver and
fake repositories, and the process builds the real ones in
`apps/api/src/operator-auth.ts` from `PORKBOT_AUTH_SECRET` and
`PORKBOT_AUTH_ORIGIN` — Better Auth's handler for the mount, `createActorResolver`
for the session read, and `bootstrapSignup` for the membership a registration
gets. With those variables absent the fail-closed default stands and every
authenticated procedure is a typed 401; the composition and its signup half are
driven against a real Postgres in `apps/api/test/integration`.

## Bots, sections and avatars

Slice 6.4 is the bot CRUD surface: `bots.list`, `get`, `create`, `update`,
`archive`, `restore` and `delete`, the avatar operations `bots.setAvatar`,
`bots.avatar` and `bots.clearAvatar`, and the section operations
`sections.list`, `create`, `update` and `delete`. Every one is an authenticated
contract procedure; the handler receives an actor-scoped repository, and the
input names a bot or a section, never a space.

- **Archiving is a reversible scope.** `archived_at` is a nullable instant and
  `bots.list` defaults to `active`; `archived` is the restore screen's scope and
  `all` asks for both. Archiving twice keeps the first instant, restoring clears
  it, and neither touches the bot's threads.
- **Deleting has one documented rule.** The row delete cascades to the bot's
  threads, tasks, runs and steering messages in a single statement; the avatar
  object is deleted through the storage seam, object first so a storage refusal
  leaves the bot intact and retryable; and the computer and home directory are
  deliberately retained until epic E7 owns their lifecycle. A deleted section,
  by contrast, never deletes bots — `bot.section_id` is `set null`, so they
  survive unfiled.
- **A create is idempotent on its spawn key.** `(space_id, spawn_key)` is a NOT
  NULL unique index and the insert replays the existing row, so a resubmitted
  create is one bot, not two.
- **A section is resolved inside the statement that writes it.** The create
  selects its section under the actor's space _and user_ — matching the
  schema's `(space, user, name)` unique index — and the update carries the same
  guard, so another user's section is a typed not-found with nothing written
  instead of an assignment the foreign key would happily accept.
- **Avatars live in one storage path.** The row keeps only a storage key,
  `avatars/<space>/<bot>`, and `apps/api/src/services/bots.ts` is the only code
  that turns it into bytes. Upload, read, clear and delete all call the same
  `StorageProvider` from `@porkbot/adapter-kit`, and the upload is bounded in
  the contract (512 KiB) before anything decodes. The API boots on the local
  provider (slice 7.7) rooted at the required `PORKBOT_STORAGE_DIR`, a named
  volume in the local stack; a deployment on the S3-compatible provider answers
  the same way because the key is the only thing the row carries.

## Threads and messages

Slice 6.5 is the conversation surface: `threads.create`, `threads.list`,
`threads.messages`, `threads.send` and `threads.clear`, every one authenticated
and every one naming a bot, a thread or a message, never a space. A thread
belongs to one bot; its transcript is the ordered `message` rows, and the run
events that stream to a subscriber are the durable `event` rows the resumable
stream already replays.

- **A send is idempotent on the client nonce.** `threads.send` takes the text
  and a non-empty `clientNonce`; `decideMessageSend` in `@porkbot/core` reads
  the nonce's earlier message and the thread's live run and returns what to do.
  A message that starts a run goes through `createRunAndTask` — the same single
  run-creation command the routine scheduler uses — and the run's
  `(space_id, client_nonce)` index replays the first result when two
  submissions race, so a retried send is one message and one run. The same
  nonce with different text is the typed `CONFLICT`, and a nonce already spent
  on another thread is refused by the send service rather than replayed, since
  the run's key is scoped to the space while a send's is scoped to its thread.
- **A send into a live run steers it.** When the thread has a non-terminal run,
  the message is written with its `steering_message` delivery row bound to that
  run in one transaction; no second run is created. Delivering and claiming
  that row is slice 6.7's half. `packages/db/src/messages.ts` is the one module
  that inserts a message row — the run-creation command, the steering command
  and the worker's assistant-message command all allocate their sequence and
  insert through it — which a call-site suite enforces.
- **Persistence never waits for a subscriber.** The user message commits with
  its run; an assistant message is appended through the message store by the
  run that produced it, with a nonce derived from the run so a retried append
  is a replay; and every run event is appended to the `event` table by
  `RunEventSink` as it is produced. A subscription replays those rows, so a
  closed tab costs the live frames, never the transcript.
- **Lists are keyset-paginated.** `threads.list` orders by
  `(updated_at desc, id desc)` and carries the ordering key of its last row as
  a typed cursor; `threads.messages` orders by the thread's contiguous `seq`
  and carries the next `afterSeq`. The service asks for one row past the page
  to decide whether a next page exists, so a "no more rows" answer is exact
  rather than inferred from a full page.
- **Clearing is an explicit, bounded act.** `threads.clear` deletes the
  thread's messages and events and resets both sequence counters in one
  transaction; the thread row, its runs and the bot's memory documents survive.
  "What did it learn" is not the transcript, and clearing a conversation never
  clears it.

## Files, attachments and artifacts

Slice 7.6 is the file surface (stories 32 and 33). One storage seam holds the
bytes, one module holds the rows that name them, and two routes move them:
`POST /threads/{threadId}/attachments` uploads a file for a message, and
`GET /files/{fileId}` downloads a stored file. Neither is an RPC procedure:
the body is the point, so the upload streams into the storage seam without
ever becoming JSON, and the download streams the object back. Both read the
session exactly once through the gate, and a file id in another space is the
shared `NOT_FOUND` before a byte is read.

- **An upload is bounded and streamable.** The `upload` family in the limits
  register carries the attachment cap (8 MiB by default,
  `PORKBOT_LIMIT_MAX_UPLOAD_BYTES`), checked from `Content-Length` or while the
  body streams, so an oversized upload is refused before it is buffered. The
  service writes the object first and the row second: a refusal after the
  write — a thread outside the actor's space — deletes the object again on a
  best-effort basis, and the failure window can only leave an unreferenced
  object, never a row whose bytes are missing.
- **A send carries attachments by id.** `threads.send` takes `attachmentIds`
  (capped at `MAX_ATTACHMENTS_PER_MESSAGE`) and resolves each through the
  actor-scoped store as an attachment on that thread; the message's jsonb
  blocks gain a `file` kind beside `text`, and the task prompt names each
  file's deterministic home-relative path (`attachments/<id>/<name>`) so the
  model can read it with `file_read`. The send's replay comparison includes
  the attachment set: the same nonce with a different set is a typed conflict,
  not a replay.
- **The worker materializes before the run.** `materializeRunAttachments` in
  `@porkbot/worker` reads the run's source message, resolves its file blocks,
  and streams each object into the computer through the same fenced command
  runner the tools use — 16 KiB parts written as overwrites, one assembly, one
  cleanup — so memory stays bounded and a retried materialization rewrites the
  same parts. The offline run suite proves the whole path: bytes seeded in an
  in-memory storage seam are read back by `file_read` from the emulated home.
- **A file a tool writes outlives the run.** `createComputerTools` accepts an
  `ArtifactRecorder`; every successful `file_write` records its bytes through
  the storage seam and the run's file store, and the tool result carries the
  download pointer (`{ id, filename, sizeBytes, downloadPath }`). The
  `run_artifact` row is unique on `(run_id, call_id)` and the storage key is
  deterministic in the same pair, so a retried recording lands on the first row
  and the first object. The console links the file from the tool-call timeline,
  and the link resolves after the run settles and after a reload because it
  addresses the row, never the machine's filesystem.
- **File paths are confined to the home.** `confineToHome` in `@porkbot/core`
  resolves `file_read`, `file_write` and `file_list` arguments — absolute or
  relative — against the computer's home and refuses anything that leaves it,
  before a command is built, so `../etc/passwd` never reaches the machine. The
  refusal is the tool result's typed reason (`outside_home`); a symlink
  planted inside the home is the machine's isolation boundary, which the shell
  tool already crosses. Origins are `home:/<relative-path>`, the convention the
  E10 ingestion fixtures use, and file bytes are still labelled
  `UntrustedContent` at the tool boundary.
- **Two tables, one owner.** `message_attachment` and `run_artifact` are read
  and written only by `packages/db/src/file-store.ts` — the operator's half
  uploads and resolves downloads, the run's half materializes and records —
  and `file-store.call-sites.test.ts` fails when another shipped module names
  either table. Both are space-scoped like every row, and the authorization
  matrix registers each with probes over the real seams.

## Webhook ingress

`POST /webhooks/<source>` (slice 4.5, PRD decision 24) is the deployment's only
unauthenticated write surface. It is declared as the `webhook` family in the
limits register, so it draws its own request budget and body cap; it never reads
a session and never fabricates an actor, and a handler receives provider data
only. Everything security-relevant happens in one order:

1. **The source is named correctly, known and has a secret.** A source is
   lowercase letters, digits and interior dashes, and a name outside that shape
   is refused like an unregistered one. An unregistered source or one with no
   configured secret is refused before anything else, and the answer is a flat
   401 that does not say which check failed.
2. **The signature is verified over the raw bytes, before anything parses
   them.** The ingress never decodes or parses the body at all: the handler
   receives the exact bytes the provider signed. The scheme is
   `X-Porkbot-Signature: t=<unix seconds>,v1=<hex>` where the digest is
   HMAC-SHA256 over `<t>.<raw body>`, and `X-Porkbot-Delivery` carries the
   provider's delivery id. A signature older or newer than five minutes is
   refused even when the digest is correct, and the digest comparison is
   timing-safe and tolerates a signature of any length without crashing.
3. **The delivery id is deduped.** `webhook_delivery` has a NOT NULL unique key
   over `(source, delivery_id)` and an `expires_at` a day out; every recording
   first sweeps the rows past their expiry, so the table is bounded by the
   window rather than by a scheduler. A replay inside the window is a 200 no-op
   that dispatches nothing, and two concurrent deliveries race at the index.
4. **The handler runs.** A handler failure releases the delivery row and answers
   500, so the next redelivery is dispatched instead of being deduped into a
   silent loss. A duplicate that arrives while the failing attempt is still
   running is acknowledged as a replay and is not itself dispatched; the
   provider's retry after the release is. That is what pairs with "handlers are
   idempotent by construction": at most one dispatch per delivery id while the
   row stands, and a handler that is safe to run again.

A source's signing secret is resolved through the generic `CredentialStore`
seam. With the environment store the variable is
`PORKBOT_WEBHOOK_SECRET_<SOURCE>` — derived from the operator's source name, so
no provider-specific variable exists in code. A source is registered by adding a
handler and a secret; `main.ts` currently registers none, so the route answers
401 until the connection slices own one.

The OAuth-callback half of the same surface is the `oauth_state` table: an OAuth
`state` is bound at issue time to the `UserActor` that started the flow, stored
only as its SHA-256, and consumed by one atomic
`update ... where consumed_at is null and expires_at > now()`. The first
callback wins, a replay matches no row, and an expired state cannot be consumed.
The MCP OAuth flow (slice 9.5) is the first issuer: it puts the server id in the
state's prefix and a fresh nonce after it, so a state can only complete the
server it was started for.

## MCP servers

An MCP server is installed by URL (`mcpServers.create`), discovered, granted to
bots (`mcpServers.grant`) and revoked (`mcpServers.revoke`). The seam in
`@porkbot/adapter-kit` speaks the streamable-HTTP JSON-RPC transport with OAuth
metadata and token endpoints; `McpServerEmulator` is the scripted offline server
the install, discovery and run paths are exercised against, and
`createHttpMcpServerProvider` is the real one, dialing through the URL-safety
module so a non-HTTPS URL or a private address is refused before a request is
made.

- **Installing persists before it dials.** The URL passes `assertAllowedUrl`
  first, the server row is created, the OAuth client credential is encrypted
  through the credential seam, and only then is the consent URL built. A
  discovery failure records an operator-readable status and answers the shared
  vocabulary's `SERVICE_UNAVAILABLE`; a second install of the same name is the
  typed `CONFLICT`.
- **OAuth is one-time and bound.** `servers.create` issues the state from the
  actor; the callback (`GET /oauth/mcp/callback`, no session) consumes it
  exactly once, re-resolves the initiating membership and refuses a replay, a
  foreign server or a membership that is gone with the typed `BAD_REQUEST`. The
  tokens are stored encrypted under the server's credential name and are never
  returned, echoed or listed — the contract's output schemas have no field for
  one.
- **A grant is per bot, and a revoke lands mid-run.** The run path builds its
  MCP registrations from the servers `listGrantedForBot` reports, and the tool
  layer re-reads `isGranted` before every call, so a revoke stops the next call
  of an open run rather than the next run. Tools are namespaced
  `mcp_<server>_<tool>` so two servers cannot shadow each other or a built-in,
  and every result is labelled `mcp_output` untrusted at the boundary.

The callback's absolute URL is `PORKBOT_MCP_CALLBACK_URL`; unset, the API falls
back to `http://localhost:<port>/oauth/mcp/callback` and logs a warning, because
a provider may refuse an http redirect and a local default is not a public
origin.

## Worker and jobs

`apps/worker` is the always-on background process: Graphile Worker over the job
registry in `apps/worker/src/job-registry.ts`. PRD decision 17 splits two
authorities, and the split is the design:

- **Graphile's job locking answers "which worker picks up the job".** A job is
  delivered to one runner at a time, retries are the queue's, and a crashed
  worker's lock expires.
- **The run row's fence answers "who owns the run".** A `run.execute` payload
  carries the run id, the job's space and a fence — never the work — and the
  handler re-reads the run through a `SystemActor` for that space before
  anything acts. A payload whose fence no longer matches the row exits without
  side effects, and a duplicate delivery after the fence moved is the same
  no-op: the handler issues only its scoped read, the fence's writer (6.2's
  claim, deduped by the attempt table's unique `(run_id, fence)`) carries the
  idempotency key for the side effect, so a redelivery is answered by the row
  rather than by delivery bookkeeping.

The registry is also where "payloads never carry the work" is enforced: each
job's parser accepts only its addressing fields, so a producer that tries to
smuggle a prompt or a tool call into a job is refused at delivery. Slice 6.1
ends at the fence check — the claim, heartbeat and execution arrive through the
`RunExecutor` seam in 6.2; the routine tick (8.4) enqueues `run.execute` for a
scheduled slot, and the message path (6.5) creates its run `queued` through the
same run-creation command. Delivering message-triggered runs to the queue is a
producer step the run-runtime slices add beside the API's own database role,
which today cannot write the worker's queue schema.

The worker connects with its own database role. `packages/db/migrations/0004_database_roles.sql`
creates `porkbot_api` and `porkbot_worker` and grants each only its own work:
the API writes the application schema and cannot read the queue, and the worker
reads the run state it executes, creates the run one scheduled routine slot
produced (8.4) and owns the `graphile_worker` schema. `packages/db/test/integration/roles.integration.test.ts`
asks the database for that division and then really performs both denied
operations, and `apps/worker/test/integration/worker.integration.test.ts`
delivers real jobs through a real queue. `pnpm db:migrate` creates the roles and
sets their passwords from `PORKBOT_API_DB_PASSWORD` and
`PORKBOT_WORKER_DB_PASSWORD`; the local stack's `migrate` service runs the same
command before the api and the worker start.

## Routines

A routine is a first-class row (PRD decision 22, slice 8.4): an owner, a bot, an
instruction, an IANA timezone and a five-field cron expression, plus the
`next_run_at` instant the scheduler is waiting on.
`packages/db/src/schema/routines.ts` defines it beside `routine_occurrence`, the
ledger of settled slots: an occurrence with a `run_id` is a fire whose outcome
is the run's own status, and an occurrence with a null `run_id` is a missed
schedule. That shape is what makes a missed slot a row a client can render
instead of an inference from a gap in timestamps, and it keeps one authority —
the run — for how a fire ended.

The grammar and the DST rules live in `@porkbot/core`'s `routine-schedule.ts`,
which is pure and clock-injected. `nextRoutineFire` treats the wall clock as the
schedule's clock in the routine's zone: a nonexistent spring-forward time fires
once at the transition instant, an ambiguous fall-back time fires once on its
first occurrence, and the day-of-month and day-of-week fields combine with OR.
`decideRoutineDue` is the scheduler's rule: a slot up to five minutes late still
runs, and a slot older than that is recorded missed with the schedule jumping to
the next future fire — a downtime is visible, never replayed as a burst.

`apps/worker/src/jobs/routine-schedule.ts` is the minute tick. It scans due rows
across spaces (address-only, like the lease watchdog), derives a `SystemActor`
for each row's space, and settles at most one slot: a fire calls the same
run-creation command the message path uses and enqueues `run.execute`, so a
scheduled run is an ordinary run under the same lease, heartbeat and watchdog; a
miss writes the ledger row and advances the cursor. Both commands lock the
routine row and dedupe the slot on `(routine_id, scheduled_for)`, and the run's
client nonce is derived from the same pair, so a retried tick is answered by the
row. Every tick also re-addresses routine runs that sat queued and unowned past
the dispatch grace, so an enqueue that died with the process cannot strand a
scheduled run silently.

Disabling stops future runs because the scan and the locked re-read both filter
`enabled`; deleting is a tombstone (`deleted_at`), so the routine's thread, runs
and ledger survive while every operator read treats it as gone. The worker's
role gains exactly what the scheduler needs in
`packages/db/migrations/0012_routine_grants.sql`: SELECT on `routine` and UPDATE
on its cursor columns only — a job cannot rewrite an instruction or a cron
expression — plus INSERT on the ledger, `task` and `run`.

The operator's half of the same rows is the routines contract (slice 8.5):
`routines.list`, `routines.create`, `routines.update`, `routines.remove`,
`routines.preview`, `routines.testRun` and `routines.outcomes`.
`preview` answers the next fire times from the database's clock before a row
exists, so a schedule mistake is visible in the editor rather than after a
saved routine; `testRun` fires the instruction once outside the schedule — an
ordinary queued run in the routine's thread, deduped by the caller's nonce,
with no occurrence and no cursor move — and `outcomes` is the ledger with each
slot's result and its run link. A malformed cron, an unknown IANA zone and an
unreachable expression are the typed `InvalidRoutineScheduleError`, which the
API boundary maps to the contract's `BAD_REQUEST` rather than a 500. The
routine editor screen itself waits for the console surfaces (slice 11.2), which
land on the web shell's routing and session.

## Memory

Durable memory is the other lane of the two-lane context policy (PRD decision
21; stories 23 and 24). A bot's memory is a set of documents — facts,
preferences and decisions — each with an append-only revision history, so a
wrong memory is correctable and every change is attributable. The rows are
`memory_document` and `memory_revision` in
`packages/db/src/schema/memory.ts`; the document row is the live state and the
revision rows are the audit trail, written together in one CTE statement by
`packages/db/src/memory-store.ts`, the single module that names either table.

The write rules live in `@porkbot/core`'s `memory-rules.ts` and the actor
factory decides which half of them a caller can reach. An operator
(`MemoryDocuments`) reads live and tombstoned documents, reads the whole
history, writes deliberately with itself as author, and restores a recorded
revision — `decideMemoryRestore` reapplies a revision, including the tombstone
a deletion left, as the document's next revision, so a deletion is reversible
without restarting the document's identity. An agent (`MemoryProposals`) reads
what recall needs and proposes a create or a rewrite recorded as
`agent_proposed` with the bot as author; it can never delete or restore, so a
durable fact is only lost by a deliberate operator act. Document ids are minted
once and never reused.

The agent's tools are `remember`, `recall` and `forget`
(`packages/effect/src/memory-tools.ts`): recall searches the provider index
within `RecallLimits`, remember proposes a create or a rewrite, and forget asks
for a deletion the rules refuse and records as a call in the timeline. The run's
prompt reads the same documents through `MemoryReader` and composes them in the
data channel, and compaction carries them through by reference and asserts them
preserved, so shortening a conversation never touches the memory lane.

The operator's surface is the memory contract (slice 8.3): `memory.list`
(live by default, tombstones under the `deleted` scope), `memory.revisions`
(whole history with who, why and when), and `memory.update`, `memory.remove`
and `memory.restore`, which answer the store's decision as a union — an
effective change with its revision, `no_change`, or the typed rule a refusal
broke. `apps/web/src/memory.ts` is the screen's controller and
`apps/web/src/screens/memory.tsx` renders it: documents with their kind and
revision, corrections in place, a folded view for long content, and a history
panel whose restore button reapplies any revision. A correction is a durable
write, so it takes effect immediately — no restart and no run.

## Notifications

The notification seam (slice 8.6, PRD decision 33; story 35) is declared in
`packages/adapter-kit` and shipped twice in `packages/adapters`: the
`NotificationEmulator`, whose mailbox tests read, and
`createHttpNotificationProvider`, an HTTPS webhook reached by URL and credential
name like every other seam. Both run the conformance suite in
`notification-conformance.ts`, including the rule that a delivery carries the
title, the body and an optional link and nothing else: the request body is built
from that allowlist rather than spread from the caller, so a credential or a raw
tool argument cannot ride along to a third party even if one was in the payload.

What is worth interrupting for lives in `@porkbot/core`: a closed vocabulary of
`run.completed`, `run.failed`, `run.needs_approval` and `run.stalled`, and the
quiet default is off for every one of them. `notification_preference` stores one
opt-in switch per `(space, operator, kind)` — no row is the quiet default — and
`packages/db/src/notification-store.ts` is the one module that names the rows:
an operator reads and writes its own switches, while a job asks one recipient's
eligibility through a `space_member` join, so a user outside the space is
suppressed rather than notified.

`createNotificationDelivery` in `@porkbot/effect` is the one path from an event
to a provider call: it checks eligibility first, then retries `rate_limited` and
`timed_out` with core's bounded backoff, surfaces `auth_failed` and `not_found`
without retrying, and returns a `delivered`, `suppressed` or `undelivered`
outcome — an undelivered notification is an error log and an outcome the caller
holds, never a silent drop. The operator surface ships with it:
`notifications.preferences` and `notifications.setPreference` are authenticated
procedures that read and flip the actor's own switches.

The run-liveness producers ship with slice 8.7.
`apps/worker/src/run-notifications.ts` is the one producer: a run that finished,
a run that failed, a run whose worker timed out and had nothing to resume, and a
run the watchdog found stuck all compose one message there and hand it to the
same delivery path. The stuck case reuses the E6 assessment
(`assessRunLiveness`) rather than a second heuristic, and its sentence names the
silence and the last step without carrying a tool argument. Every message links
to the run's timeline: the thread console, addressed down to the run itself
(`/threads/{threadId}?run={runId}`).

Duplicate suppression is durable, not incidental. A settled run claims its one
terminal notification in the run row's `notified_at` before anything is sent, so
a retried job or a producer racing the watchdog finds the claim taken and sends
nothing; a `cancelled` run is the operator's own act and never claims one. A
stall claims per episode through the `stalled_at` marker the watchdog already
writes, so a run that recovers and stalls again is announced again while one
long stall is announced once. The claim is taken before the preference is read,
so a quiet operator cannot leave the run unclaimed for a later producer to
re-announce.

The worker composes the provider in `main.ts`: the emulator is the default, so
the product notifies with nothing configured, and a deployment that sets
`PORKBOT_NOTIFICATION_WEBHOOK_URL` gets the HTTPS provider, with its key read
through the generic environment credential store under
`PORKBOT_NOTIFICATION_WEBHOOK_KEY`. `PORKBOT_WEB_ORIGIN` is the absolute web
origin links are built from; unset, it falls back to loopback with a warning,
because a link the operator cannot open is worth saying out loud.

## Backups and restore drills

`apps/backup` (slice 12.3, PRD story 5) is the deployment's backup process: a
sixth always-on service that holds the database owner's connection and nothing
else. It runs under `pnpm stack:up` and `pnpm deploy:up`; it deliberately has
no `pnpm dev` entry, because it refuses to boot without a keyring and a
destination and a developer's `pnpm dev` should not inherit that requirement. Every night it writes a canary row, streams `pg_dump` output through the
AES-256-GCM archive into the storage seam, copies every `computer-snapshots/`
archive the same way, prunes what the retention window has passed, and then
restores the dump it just wrote into a scratch database and compares the canary
it reads back. The schedule, the retention window and the drill interval live in
`@porkbot/core`'s `backup-policy.ts` and are re-stated with the recovery path in
`docs/backups.md`.

- **Encrypted at rest, two layers.** Objects are chunked AES-256-GCM with an
  authenticated terminal record, so a truncated or reordered object fails
  before its plaintext is trusted; the keyring itself is sealed under the
  operator's passphrase into an envelope written to a separate volume. The
  backup keyring is independent material from the credential keyring.
- **The key envelope is the recovery artifact.** It is useless without the
  passphrase, which is never stored, so the operator can keep it in a password
  manager; `restore --latest --database <name>` opens it when the environment
  keyring is gone, restores, and proves the data reads back.
- **Homes go through the seam.** The snapshot archives are the durable copy of
  every computer's home — Docker volume, cloud sandbox or the supervisor's
  delegate — and `COMPUTER_HOME_SYNC` states each provider's story; the offline
  emulator's home is explicitly not backed up.
- **Failure is loud.** Every run settles in `backup_run` with a closed
  `error_code`; the worker's five-minute watchdog alerts on a failed or stalled
  run, a success gap past 36 hours, or a drill that failed or has not run
  within 45 days, once per episode.
- **One module owns the ledger.** `packages/db/src/backup-store.ts` is the only
  shipped code that names `backup_run`, `backup_canary` or `backup_alert`, and
  `backup-store.call-sites.test.ts` proves it.

## URL safety

Every fetch of a user-supplied URL — an MCP server, an OpenAPI document, a model
endpoint, a web page — goes through `@porkbot/effect`'s `safeFetch` (PRD decision
23). It enforces HTTPS, refuses embedded credentials, and blocks private,
loopback, link-local, metadata, multicast and reserved addresses.

The rules are one list, `BLOCKED_ADDRESS_RULES`, and the check that matters runs
as the socket's DNS lookup rather than as a pre-flight string check: every
connection resolves and checks again, so a hostname that answers with a public
address for one look and a private one for the next is refused on the socket.
An IP-literal host never reaches the resolver, so `assertAllowedUrl` checks it
where it is parsed. A refused fetch throws a typed `BlockedUrlError` — never a
raw network failure — and a test in `packages/effect` walks the shipped fetch
call sites, so a new one cannot bypass the module.

## Untrusted content

The product's core risk is an agent reading the web, a file, an email or a tool
result that carries instructions. `packages/core/src/ingestion.ts` is the one
vocabulary for that boundary: `INGESTION_PATHS` lists the ways content enters
(web fetch, file read, email, MCP output, computer output), and the module that received the
content calls `labelUntrustedContent` with its path, its origin and the text,
producing an `UntrustedContent` whose `label` is the literal `"untrusted"`. An
unregistered path, a blank origin or a non-string payload throws, so content is
never labelled by assumption. `composeRunPrompt` renders every ingested value as
a `data`-channel section under its provenance line, and the composer wraps that
channel in the data notice — a directive inside a page is reference material the
model is told not to obey, never an instruction.

The machine's half of that boundary lands with slice 6.9: `file_read` labels
the bytes a file tool returns with the path it asked for, and `computer_output`
labels shell stdout, directory listings and browser page text with the machine
or the page they came from. The shell is deliberately on the register too,
because a shell can read a file the dedicated tool would have labelled and the
trust boundary must not depend on which tool the model chose.

The web path ships end to end (slice 10.1). `WebAccessEmulator` is the
deterministic scripted web the product runs on with nothing configured, and
`createHttpWebAccessProvider` dials every page through the URL-safety module's
`safeFetch` by default, reads the body under a byte budget and classifies
refusals with the shared failure vocabulary; both run one conformance suite. The
model's tools are `createWebTools` in `@porkbot/effect`: `web_fetch` asks the
run's egress guard first and returns the page labelled untrusted with its final
URL, and `web_search` returns labelled titles and snippets with the query's
limit clamped.

Egress is allowlisted per run. `parseEgressAllowlist` accepts hosts and
`*.domain` wildcards and refuses a scheme, a port, a path or a credential; an
empty list is fail-closed. `decideEgress` answers allowed, needs-approval or
refused on the host alone — the blocked address ranges stay in the URL-safety
module's one list — and `createEgressGuard` turns needs-approval into a durable
row in the run's approval gate: an allowlisted host proceeds with no write, any
other destination records the pending request before a packet is sent, and an
operator decision or the deadline settles it, a timeout denying rather than
hanging.

The adversarial fixtures for the injection-resistance suite (slice 10.4) live in
`packages/adapters/src/ingestion-fixtures.ts`, one per registered path, each
carrying the marker a pass must never observe. A call-site suite in
`packages/core/src/ingestion.call-sites.test.ts` walks the shipped tree and fails
a module that touches a registered boundary without labelling, and the fixtures
suite fails a registered path with no fixture, so a new ingestion surface cannot
slip past either check.

## Web shell

`apps/web` is the product's client: TanStack Start in static SPA mode
(`spa.enabled` in `vite.config.ts`), so the build prerenders one `_shell.html`
and the router boots from it. `pnpm build` emits `dist/client` — HTML, JS and
CSS — and no SSR process is required at run time. The same directory is what
the `web` image serves and what the Electron wrapper packages (slice 11.6), so
there is one client build and no fork. The app's own server
(`apps/web/src/host.ts`) is a file server with the SPA contract: an existing
file is streamed with its content type, an extension-less path with no file
answers the shell and lets the router resolve it, a missing asset stays a 404,
`/livez` answers process liveness, `/readyz` checks that the shell exists, and a
path that escapes the root is refused rather than answered with the shell.

Auth has three states, not two. `createSessionController` resolves the session
through `account.me` — the contract's first authenticated procedure — and the
`bootstrapping`, `signed-out`, `signed-in` and `unavailable` states are what the
route guards branch on, so a session read that failed shows a "can't reach the
server" screen with one retry instead of a sign-in form that cannot work. The
credential exchange posts to Better Auth's routes under `/api/auth` (slice 12.1
mounts the handler), the session cookie stays `HttpOnly` and JavaScript never
reads it, and `deployment.status` decides whether sign-in offers registration.

Colour and type come from `@porkbot/tokens`: `theme.ts` turns the semantic
tokens into `--pb-*` custom properties inlined into the shell's first paint, and
the surfaces and stylesheet name only those properties. The lint rule in
`@porkbot/eslint-config` fails a hardcoded colour in `@porkbot/web`, so a theme
change stays one file. The screens are labelled and keyboard-reachable: labels
bind to inputs, the refusal is a `role="alert"` that takes focus, and a skip
link leads to the focused `#main`. The e2e tier builds the artifact, serves it
with the static host and asserts the shell's asset references exist, the
bootstrapping state is in the prerendered HTML, and an unknown route is
rewritten rather than 404ed (`static-build.e2e.test.ts`), mounts the thread
console over a real HTTP connection to a scripted oRPC/SSE server to prove the
resume path (`thread-console.e2e.test.ts`), mounts the memory screen over a
scripted memory API to prove a correction survives a reload
(`memory.e2e.test.ts`), and mounts the connections screen over a scripted
connections API to prove a create, a revoke and a probe through the real wire
(`connections.e2e.test.ts`).

## Thread console

Slice 6.6 is the product's first real screen: `apps/web/src/console.ts` is the
console's state machine, `use-console.ts` is its React binding, and
`routes/_app/threads.$threadId.tsx` is its route. The console owns one thread's
subscription, folds every frame through the reducer in `packages/core`, and
publishes one state the screen renders — the reducer is the only interpretation
of the stream and the screen is a pure function of the state.

- **Tokens render as they stream.** A `token.delta` extends the assistant
  message in place; the client never waits for `run.completed`.
- **Reload is a replay, not a client-held cursor.** A reload starts a fresh
  snapshot at seq 0; the durable rows are the stream, so the server replays
  every event and the reducer rebuilds the snapshot the wire would have
  produced. The signed cursor still resumes a dropped socket inside one
  connection, where `subscribeThreadEvents` owns the backoff.
- **Connection state is visible without noise.** `subscribeThreadEvents`
  reports `connecting`, `live`, `reconnecting` and `resumed`; the screen shows
  one polite status line for the phases that are not plainly live, and no
  chrome while frames are flowing.
- **The transcript is the order, the reducer is the content.**
  `threads.messages` carries the user turns and the message sequence — the send
  that started a run is a row, not a run event — and each message renders the
  reducer's text for its id, so a partial assistant message and its closed text
  are the same element. The transcript is read once per console start, walking
  the contract's forward pages to the newest turn (bounded at ten pages), so a
  run-starting message written in another tab arrives on the next mount while a
  steering message arrives as an event.
- **A refusal is a state with a retry.** A typed `NOT_FOUND` says the thread is
  not available; any other failure says the stream could not be read; either
  offers one retry that restarts from zero.

The home screen is the smallest entry point that makes the console reachable —
the actor's bots, their recent threads and a New thread button — and the bot
editor and sections (slice 11.2) replace it.

The e2e tier mounts the console in a DOM over a real HTTP connection to a
scripted oRPC/SSE server and proves the resume-path criteria: tokens before
completion, a reload replaying to the same snapshot, and a dropped connection
reconnecting from its signed cursor with `Reconnecting…` becoming `Resumed`.

## Migrations

`packages/db` owns the schema and the migration workflow. Postgres 18 is the
production major (PRD stack decision 16), and the testkit harness boots the
same major, so a migration is exercised on the server it will run on.

```sh
pnpm db:generate   # diff src/schema against migrations/meta, write the SQL
pnpm db:migrate    # apply migrations/meta/_journal.json to $DATABASE_URL
```

`packages/db/migrations` is drizzle-kit output and is committed like source;
`pnpm db:migrate` reads the journal, applies what the ledger
(`drizzle.__drizzle_migrations`) does not have yet, records it in the same
transaction, and is safe to run twice — the second run applies nothing.

The rules are checks, not conventions:

- **Generated output is the migration.** The unit tier copies the committed
  migrations to a scratch directory, runs `drizzle-kit generate` against the
  current schema and requires the trees to match, so a schema change that was
  not generated and committed fails. Hand-editing generated SQL is the exception
  and needs a `-- hand-edited:` comment saying why, which review sees.
- **A destructive change is its own labelled migration.** A file containing
  `DROP TABLE`, `DROP COLUMN`, `TRUNCATE`, a column type change or similar must
  be named `destructive_*` and must not also contain additive statements; the
  migration suite fails otherwise, so a destructive change is a file a reviewer
  can reason about and an operator can apply deliberately.
- **Primary keys are UUIDv7.** Every table's id comes from `primaryKeyId()`,
  which defaults to Postgres 18's `uuidv7()`, and the schema suite checks every
  exported table follows it.
- **Every lookup foreign key is indexed.** An integration test reads
  `pg_catalog` for foreign keys whose referencing columns are not the leading
  columns of an index — Postgres does not index them for you — and fails while
  it finds any. A fixture proves the check can fail before it is trusted.
- **Statuses are Postgres enums, built from the domain.** Run, task, attempt and
  effect status are enums, and the run-status enum comes from `RUN_STATUSES` in
  `@porkbot/core`, so the database and the transition map cannot drift. A set
  that is expected to grow — the run trigger — is text with a check constraint
  instead, never an enum.
- **Idempotency keys are NOT NULL and scoped.** `bot.spawn_key`,
  `message.client_nonce`, `run.client_nonce` and
  `external_effect.idempotency_key` sit in unique indexes over NOT NULL
  columns, so a resubmission collides at the database instead of racing a
  read-then-write, and no NULL can make the constraint vacuous. The schema suite
  fails any unique index that covers a nullable column, and the integration
  suite proves the database rejects the duplicate and the NULL.
- **The run lease is fence-guarded and the checkpoint is never NULL.**
  `run.lease_fence` is a NOT NULL integer defaulting to zero, so reclaim can
  increment it monotonically and a stale owner's write matches no row;
  `run.checkpoint` is NOT NULL jsonb defaulting to `{}`, so "resume from
  checkpoint" and "start from scratch" cannot be confused.
  Workers heartbeat every minute and write a two-minute TTL: the extra minute is
  explicit grace for ordinary clock drift and a brief host suspend. Missing two
  heartbeats therefore makes the run reclaimable without letting a stale owner
  renew or publish another checkpoint.
- **Foreign keys never dangle.** Every foreign key resolves to the id of a table
  in this schema; where the runs domain needed an optional link — a bot without
  a section, a user message before its run exists — the column is nullable and
  the key is `on delete set null`, so deleting the target clears the link
  instead of leaving a reference to nothing. The integration suite proves the
  cascade and the clear against a real server.

The baseline migration is deliberately empty: slice 2.1 landed the workflow
before any domain table. `0001_identity_and_tenancy.sql` added the identity and
tenancy tables and `0002_runs_domain.sql` the runs domain — bots, sections,
threads, messages, events, tasks, runs, attempts, steering messages and external
effects — whose `space_id`/`user_id` columns are foreign keys into `space` and
`user`. `0003_space_bootstrap.sql` added the one-owner index and
`0004_database_roles.sql` is a `--custom` migration: the two service roles are
cluster identity and privilege, which drizzle-kit does not model, so it carries
the `-- hand-edited:` marker and the grant table rather than a schema diff. It
creates no credential: `pnpm db:migrate` reads
`PORKBOT_API_DB_PASSWORD`/`PORKBOT_WORKER_DB_PASSWORD` and applies them with
`ALTER ROLE ... PASSWORD` after the journal, so the reviewed SQL never contains
a password. The testkit harness reapplies the template's database-level ACLs
after `CREATE DATABASE ... TEMPLATE`, which does not copy them, so every suite
runs with the privileges the migration granted rather than quietly weaker ones.

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
- `unit` — unit tests with coverage
- `integration` — the tests that need a real Postgres, against the local stack the job starts
- `e2e` — whole-process tests against the built output
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

The e2e tier carries the placeholder spec later slices replace. The job exists
now so the wiring is proven on its own rather than introduced alongside new
tests. It is the only tier that retries.

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

This is slice 3.3 of epic E3 (M2 — Auth, Ownership & Authority), landing on top
of slice 4.1's transport. `apps/api/src/gate.ts` is the single auth gate: one
session read per request, resolved through `createActorResolver` in
`@porkbot/auth` and `resolveUserActor` in `packages/db` into the actor-scoped
repositories a handler may use. Every procedure is authenticated by default;
`publicProcedure` in `packages/contracts` marks the exception, the public paths
are listed in `publicProcedures`, and both the contracts suite and an
`apps/api` test fail when the marking, the list and the registration path drift.
The lint rule in `packages/eslint-config/auth-gate.js` fails a router that calls
`implement(...)` itself. The first authenticated procedures ship with it:
`account.me` reports the resolved actor, and `bots.get` demonstrates the by-id
read that a cross-space id answers as `NOT_FOUND`.

The gate's session read is wired into the API process as an injected dependency
and is fail-closed until operator auth configuration (secret, public origin,
mail and the API's connection checkout) lands; authenticated procedures answer
their typed 401 today, and the web shell slice consumes the real flow.

The authorization matrix over actors, spaces and resources lands with slice
3.3. `packages/db/test/integration/authorization/matrix.ts` registers every
space-scoped entity with the probes that exercise its real read and write
seams — repositories, the memory and notification stores, approval gates, the
tool-call ledger, the run-event sink and the routine scheduler — and the spec
beside it runs each probe against another space, asserting the shared
`NOT_FOUND` with the foreign rows unchanged. A coverage test walks the Drizzle
schema, so a table that is neither registered nor exempted with a reason fails
the tier. The transport surfaces are pinned beside their code: a revoked
membership ends an open SSE stream (`apps/api/src/stream.test.ts`), a webhook
handler is handed provider data and no actor (`apps/api/src/webhooks.test.ts`),
and a job whose payload names another space changes no run, task or attempt row
(`apps/worker/test/integration/worker.integration.test.ts`).

The transport's limits land with slice 4.4: `apps/api/src/limits.ts` is the one
register, installer and accounting for request budgets, body caps and
per-actor stream slots; the gate answers the contract's typed `RATE_LIMITED`
with a `Retry-After` header; and a test walks the contract tree and the route
list, so a new procedure or route cannot ship silently unlimited.

The verified webhook ingress lands with slice 4.5: `POST /webhooks/<source>` is
declared as the `webhook` family in the same register, `apps/api/src/webhooks.ts`
verifies the signature in `@porkbot/effect` over the raw bytes before anything
parses them, and `webhook_delivery` in `packages/db` dedupes on
`(source, delivery_id)` with a TTL the recorder sweeps. The one-time OAuth state
store lands with it, so the MCP OAuth callback (slice 9.5) inherits a
replay-proof binding instead of inventing one.

The subscription transport lands with slice 4.3: `threads.events` streams a
thread's persisted run events as SSE, each frame's `id` an HMAC-signed cursor
bound to the actor, the space and the thread. A reconnecting client sends
`Last-Event-ID` and receives exactly the events after its cursor; a forged or
foreign cursor is the contract's typed `BAD_REQUEST`; subscribe and resume both
re-resolve the session and the thread's membership. The durable rows are the
stream and the realtime fanout is a wake-up, so a lost signal is latency rather
than a lost event, and `subscribeThreadEvents` in `@porkbot/contracts` reconnects
on the core backoff policy.

Below the transport, the earlier slices are in place: `packages/db` owns the
Drizzle migration workflow and the runs-domain schema — bots, sections, threads,
messages, events, tasks, runs, attempts, steering messages and external effects,
with typed statuses, NOT NULL idempotency keys and the lease/fence and
checkpoint columns reclaim depends on — and `packages/core` owns the run state
machine as one transition map over `queued`, `running`, `waiting_approval`,
`completed`, `failed` and `cancelled`, where an illegal transition returns a
typed `IllegalTransition`, and the event reducer that folds run events into a
thread snapshot.

`pnpm db:generate` diffs `src/schema` against the committed snapshots and
`pnpm db:migrate` applies the journal to `$DATABASE_URL` through drizzle's
ledger, safe to run twice; the baseline migration is deliberately empty,
`0001_identity_and_tenancy.sql` added the identity and tenancy tables from slice
2.2 and `0002_runs_domain.sql` the runs domain. The rules are checked: the
migration suite regenerates and compares the committed output, labels and
separates destructive migrations, the schema suite pins every primary key to
`uuidv7()` through `primaryKeyId()`, keeps every unique index on non-null
columns and every foreign key from dangling, and an integration test reads
`pg_catalog` to fail on a lookup foreign key no index leads with.

The first client lands with slice 11.1: `apps/web` is a TanStack Start SPA —
`pnpm build` prerenders `_shell.html` and emits `dist/client`, a static
directory no SSR process is needed to serve, and the same artifact the Electron
wrapper will package (slice 11.6). The shell ships routing with the
`bootstrapping`, `signed-out`, `signed-in` and `unavailable` states, a sign-in
and a registration screen on the contract's `deployment.status` for
availability, the semantic tokens from `@porkbot/tokens` inlined into the first
paint, and the static host the `web` image runs. The artifact is proven in the
e2e tier: the built shell's asset references resolve, the bootstrapping state is
in the prerendered HTML, an unknown route is rewritten to the shell and a
missing asset stays a 404.

Under it, M0 is in place: one command, `pnpm stack:up`, starts the whole local
stack — Postgres 18, the migrate one-shot, api, worker, backup, web, the
reverse proxy and supervisor — and waits for every healthcheck, and the same
command is what CI's integration tier runs; the testkit harness attaches to the
stack's Postgres for the suite clones, so integration tests run against the
production major. The structured logger,
Postgres-per-suite isolation, the dependency pin register and the CI gate are
unchanged. `apps/desktop` is the connect-only Electron shell (slice 11.6) and
`apps/www` is still a placeholder the remaining M10 surface slices replace with
the real client; `apps/api` serves `/livez` and `/readyz`
and the contract's procedures behind the auth gate, `apps/worker` boots Graphile
Worker over the job registry, re-reads each run through the job's `SystemActor`
and checks its fence under the worker's own database role (slice 6.1), and
`apps/supervisor` owns the Docker socket and computer lifecycle behind its
authenticated internal surface (slice 7.1).

The computer emulator and the first run whose tools execute land with slice
6.9. `ComputerEmulator` implements the whole `ComputerProvider` seam —
filesystem, bounded shell, scripted browser, snapshots and the reserved
`frames()`/`input()` path — behind one conformance suite the Docker provider
now registers against a real container; `createComputerTools` turns `exec` into
the model's `shell`, `file_read`, `file_write`, `file_list` and `browser` tools
with their content labelled at the ingestion boundary; and the offline runtime
executes tool steps through the dispatcher, so a full run does real work with no
key, network or daemon. The live model launch that fills the worker's work seam
waits on the stream bridge from Pi's agent loop to the model runtime.

The supervisor boundary lands with slice 7.1, and the Docker provider with slice
7.2. `apps/supervisor` is the only compose service the Docker socket is mounted
into, and it is the only process that constructs a computer provider: boot,
stop, reset and recover are compositions inside its lifecycle service,
reconciliation on boot adopts what a crashed process left behind, an idle sweep
parks a machine no run is using, and its internal HTTP surface is authenticated
with a process credential the API presents through
`createSupervisorComputerProvider`. The provider it constructs is the offline
emulator by default and, when the deployment names an image,
`createDockerComputerProvider` — the Engine API client over the socket, one
container per bot on its own internal network with an isolated gateway and its
home on a named volume, every per-bot ceiling applied at create, and every
daemon refusal classified in one module. The integration tier runs the shared
conformance suite against a real container, builds those networks and drives
real containers to show that one bot's machine reaches neither another bot's
machine nor a host service, asserts the ceilings on the daemon's own inspect
output, and inspects the running stack to prove the API container has no socket.
The reserved screen paths are already gated by a short-lived capability token
scoped to one computer and one actor; the stream behind them is v1.1 work.

The second computer provider lands with slice 7.3. `createDaytonaComputerProvider`
is the cloud runtime over the same lifecycle: REST + JSON to the control plane
and the sandbox toolbox, `start`/`stop`/`recover` over the sandbox states,
`tar` through the toolbox for snapshot and restore, every refusal classified by
`daytona-errors.ts` through the shared decision in `computer-failure.ts`, and
no `frames()`/`input()` implementation. The supervisor's provider configuration
becomes a registry of the kinds the deployment configured (offline always,
Docker when an image is named, the cloud when endpoint, key and image are), and
each bot's `computerProvider` setting selects one; a bot with no selection runs
on the deployment's default. `@porkbot/adapters`' `daytona-engine-emulator.ts`
serves the real wire on loopback, so the unit tier runs the shared conformance
suite against the cloud provider with no network and no key.

The model runtime adapter lands with slice 9.2. `createOpenAiCompatibleModelRuntime`
in `@porkbot/adapters` is the real OpenAI-compatible provider — a hosted
provider or a self-hosted endpoint, by URL and stored credential name — which
resolves the key through `CredentialStore` on every call, dials through the
URL-safety module, and classifies every refusal onto the shared vocabulary.
Its probe asks the endpoint for its models and then verifies streaming with a
real streaming request, so "streaming unsupported" is a result rather than a
guess, and a refusal the probe can classify comes back as data the settings
surface can render. The wire client is the same one the offline emulator's
provider half drives, so what is tested offline is what ships. Connections are
stored per space in `model_connection` (label, base URL, credential name,
default model, one default per space), a bot selects its own connection and
model, `resolveForBot` applies bot-over-space-default, and `credentials.store`
is the write half of the encrypted store whose list can only answer masks.

The connections settings surface lands with slice 9.3. `credentials.remove`
revokes a stored credential by name, and a probe stamps the connection's
`lastUsedAt`, so the list can say when a request last left for an endpoint
instead of implying a stored hope. The web surface at `/settings/connections`
reads each connection as its label, endpoint host, credential name and derived
mask, last use and the probe's own answer, including "streaming unsupported"; it
creates one by storing the key through `credentials.store` and naming it with
`modelConnections.create`, revokes a key behind a confirmation that names the
connections and bots it breaks, and distinguishes the server's one space
default from a bot's own connection. The e2e tier drives create, revoke, probe
and the default swap against a scripted API over a real socket, and the screen
is captured under `docs/screenshots/`.

The settings area lands with slice 11.5. `/settings` is the directory: models,
MCP servers, secrets, notifications, usage and account, one line each, every
entry a route the index test walks so an added surface without a link fails the
suite. Models stays the connections surface at `/settings/connections`; the
other five are new. `/settings/mcp` installs a server by URL, shows the status
discovery reported — `pending_authorization` beside the consent link, never a
success it did not observe — lists its tools, grants it per bot, and confirms an
uninstall with how many tools and bots it takes down. `/settings/secrets` reads
one bot's secrets as names, destinations and statuses, stores a value and
forgets one behind a confirmation that says the value is cleared immediately.
`/settings/notifications` renders the switches with the quiet defaults the store
answers. `/settings/usage` fans out over the active bots and re-reads every bot
when the window changes, under the sentence that the figures are recorded and
displayed only; the per-bot report is the same component the bot route renders.
`/settings/account` reads the new authenticated `account.ownership`, which pairs
the actor's role with the deployment's configured admin address or `null` when
none was configured. The e2e tier drives a switch flip, a window change, a
forget, an install and an uninstall against a scripted API over a real socket,
and the index is captured under `docs/screenshots/`.

Choosing where a bot runs lands with slice 9.4. `computers.providers` is the
deployment's own answer — every kind its supervisor configured, each asked to
prove itself by the one readiness check every `ComputerProvider` now answers
without creating a machine (`ping` for Docker, a sandbox list for the cloud,
nothing for the emulator) — and a provider that cannot answer is shown as
unavailable with the classified reason, never as a stored hope. The check runs
again inside `bots.create` and `bots.update`: a write that names a provider the
deployment did not configure, or one whose readiness check refuses, is the
contract's typed `SERVICE_UNAVAILABLE` before the row exists, so an operator
learns at the choice rather than at the bot's first run. The web surface at
`/bots/$botId/computer` reads the bot's selection as one of two states — a
named kind, or "follow the deployment default" — and a switch is a
confirmation that says what does not move: the home lives on one provider's
machine and an archive lives in the space's storage, so the panel offers the
snapshot path (capture first, then restore into the machine on the new kind)
and the snapshots section makes the restore the second half of it. The e2e tier
drives the read, the switch and the capture-switch-restore path against a
scripted API over a real socket, and the screen is captured under
`docs/screenshots/`.

The computer screen lands with slice 11.4. `/bots/$botId/computer` is now the
operator's whole view of a machine: its state and the supervisor's four
lifecycle verbs, a terminal that runs one command at a time and renders its
exit code, stdout and stderr, a file view that lists the bot's home and reads
one file from it, the provider choice from slice 9.4, and the snapshot pair
that moves files across a provider change. `computers.terminal`,
`computers.files` and `computers.file` are new procedures over the same
supervisor `exec` seam the model's `shell` and `file_*` tools use: the bot is
resolved in the actor's space before the supervisor is dialed, and the file
view is confined to the home — an outside read is a dangerous class, so the
browser refuses it with the contract's typed `BAD_REQUEST` while the terminal
stays the operator's way to the rest of the machine. Reset warns that the
machine and its home are destroyed and keeps the snapshots that can bring the
files back, and a stopped machine disables the terminal and file view rather
than letting a command answer a supervisor refusal. Screen watch and takeover
stay deferred (story 28): the `frames()`/`input()` seam and the
capability-gated supervisor paths are documented where they are declared, and
no screen surface ships. The controller, screen and e2e tiers cover the read,
the lifecycle verbs, the terminal, the file walk and the reload; the e2e drives
a scripted API over a real socket and the screen is captured under
`docs/screenshots/`.

The thread console lands with slice 6.6: `threads.events` streams into the
console controller, which folds each frame through the core reducer and renders
the transcript, the tokens as they arrive, and one connection-status line; a
reload replays the durable events from zero and reconstructs the same snapshot,
while a dropped connection resumes from the signed cursor with no duplicate and
no gap. The transport reports its phases (`connecting`, `live`, `reconnecting`,
`resumed`) through `subscribeThreadEvents`, so the screen renders the state the
reconnect loop owns. The home screen lists bots and their threads as the
console's entry point until the bot editor (slice 11.2) replaces it, and the
e2e tier drives the resume path through a real socket against a scripted
oRPC/SSE server.

The desktop shell lands with slice 11.6: `apps/desktop` is a connect-only
Electron app that packages the same `dist/client` the web image serves and
dials the operator's server. The window cannot load the SPA from one origin and
call the API on another — the session cookie is `HttpOnly` and scoped to the
server, and the API is built for one origin — so the main process runs a
loopback host that mounts `@porkbot/web`'s own static handler and forwards
`/rpc`, `/rpc/*` and `/api/*` to the configured deployment, streaming in both
directions so SSE arrives frame by frame and rewriting `Set-Cookie` onto the
loopback origin. The renderer sees one same-origin app and re-implements no
screen; the console it already runs forwards each run lifecycle frame across
the preload bridge, which is what the tray's in-flight count and the native
completion and failure notifications read. Hardening is a table, not an
intention: `HARDENED_WEB_PREFERENCES` is the only source of window flags,
`assertHardened` refuses a relaxed window, navigation allows the app's origin,
opens `https:` links in the system browser and refuses a foreign frame,
permissions are denied except clipboard and fullscreen, and the proxy stamps a
fresh nonce onto every inline script and style it serves — hashes cannot cover
the shell's hydration stream, whose bytes the HTML parser rewrites — and names
that nonce in a policy that never says `'unsafe-inline'`. Updates are verified
before they are written: the release signs `version`, `url` and `sha512` with
an Ed25519 key the app pins, `update-controller.ts` refuses an unsigned,
mis-signed, tampered, non-HTTPS or older manifest and stages nothing until the
artifact's bytes hash to the signed digest, and a build with no feed configured
checks nothing. The "run here" topology stays deferred (issue #180, PRD open
question 1): the app runs no supervisor, computer or worker, and
`docs/desktop.md` states it. The unit tier covers the hardening call sites, the
proxy over real HTTP, the update refusals and the tray; the screens are
captured under `docs/screenshots/`.

The single-host deployment lands with slice 12.1. `deploy/compose.yaml` is the
production shape of the stack — the same six services, every secret read
through Compose's `${NAME:?}` instead of a local default, app images tagged
with the release's git SHA, and CPU and memory ceilings per service — and
`packages/testkit/src/deployment` is the CLI behind `pnpm deploy:setup`,
`deploy:check`, `deploy:up` and the lifecycle commands. `setup` renders the
committed `deploy/porkbot.env.example` into `deploy/.env` with a generated
secret for every entry in one register, idempotently, so enabling the
credential proxy later does not re-key the database; `check` validates the file
(the placeholders, weak or reused secrets, the keyring, the origins, the image
tag, the all-or-nothing families, the provider's own settings) without Docker;
`up` renders when needed, validates, builds as its own step so the health
budget covers the services, waits on every healthcheck and reports readiness
per service, and `down` keeps the volumes unless asked. The test suite pins the
template, the compose file and the required set to each other, and the
integration tier validates the definition with a throwaway rendered env. The
README's "Single-host deployment" section carries the floors and the arithmetic
against the compose ceilings. The local stack, its command and the CI
integration tier are otherwise unchanged.

The workspace compiles with TypeScript 7; typescript-eslint refuses to run against it, so
`@porkbot/eslint-config` depends on the TypeScript 6 API for lint tooling only. Remove that
pin once typescript-eslint supports TypeScript 7.
