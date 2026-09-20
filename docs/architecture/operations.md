# Operations

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
  revoked when the run ends and expires at the run's lease end regardless.
  [`docs/credential-proxy.md`](../credential-proxy.md) describes the boundary
  and what the deferred screen-takeover work inherits from it.
- **Backups are local and encrypted by default.** `backup` reads the snapshot
  archives through the storage seam (`storage-data`, read-only), writes
  AES-256-GCM objects to the `backup-data` volume and the sealed key envelope
  to `backup-envelope`, and runs the restore drill into a scratch database on
  the stack's Postgres. The local keyring and passphrase are placeholders like
  the database passwords; a deployment generates real ones and configures
  `PORKBOT_BACKUP_S3_*` for off-site storage. [`docs/backups.md`](../backups.md) is the runbook,
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
reverse-proxy runbook uses ([`docs/reverse-proxy.md`](../reverse-proxy.md)).

## Single-host deployment

The task-oriented walkthrough — host preparation, the first sign-in, the first
model connection and the first run — is
[`docs/self-host.md`](../self-host.md); this section is the design record.

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
  [`docs/reverse-proxy.md`](../reverse-proxy.md) is the contract and the runbook for when it does not.
  A proxy that cannot reach the API answers unhealthy, and Caddy keeps its
  certificates in the `caddy-data` volume across restarts.
- **Resource floors and per-bot sizing.** The host floor is 4 vCPU / 8 GB for
  the stack, plus roughly 2 GB and 50 GB+ of disk per bot, with 50 GB+ more for
  images (PRD decision 32; ["A bot's computer"](computers.md#a-bots-computer)). The stack's ceilings fit
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
  is the recovery path ([`docs/backups.md`](../backups.md)). `pnpm deploy:upgrade --tag <git-sha>`
  is the one-command release path; it records the prior tag in the adjacent
  ignored release state so `pnpm deploy:rollback` can redeploy it. Rollback is
  not a schema rollback: it runs the previous image against the newer schema
  and never attempts to reverse migrations. If the older image is incompatible
  with that schema, restore a compatible database backup separately before
  retrying, and the operator runbooks are in
  [`docs/runbook.md`](../runbook.md).

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
[`docs/backups.md`](../backups.md).

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

## Live-provider canaries

`packages/canary` (slice 12.6, PRD testing decisions) is the one check that
leaves the emulators. `.github/workflows/canary.yml` runs it nightly — and on
dispatch — against a supervisor started with the provider under test: a real
Docker daemon on the runner, and the real cloud provider when its repository
variables and secret are configured. Each run drives the supervisor's HTTP
surface, so the canary proves the boundary a self-hoster runs rather than an
in-process adapter. The same runner is exercised against real Docker on every
pull request by the integration tier, and against the offline emulator in the
unit tier.

- **Boot, run, tool call, teardown — verified.** The runner sweeps leftovers,
  boots a machine with a fresh run id, writes a token through a command, reads
  it back the way a tool call does, destroys the machine, and asserts the
  provider reports it gone and no longer lists it. Teardown runs on every path,
  including a failed step and a run past its ceiling.
- **The cloud canary has a stated budget.** A billable kind does not run until
  `PORKBOT_CANARY_BUDGET_USD` and `PORKBOT_CANARY_USD_PER_MINUTE` are set; the
  per-run ceiling is the month divided across 31 nights, the run is aborted
  past it, and the estimated spend is recorded. A missing budget is a visible
  skip, not a silent pass.
- **A failure notifies and has an owner.** The failure goes through the E8
  notification provider with the run URL as the link to logs, and the job opens
  or comments on an issue assigned to `PORKBOT_CANARY_OWNER`. The workflow is
  not a required check, so a provider outage never blocks a merge.
- **Orphans are swept.** Every run lists the provider's machines and destroys
  the ones carrying the canary bot id, before it runs and again in an
  `if: always()` workflow step. A canary machine has no user behind it, so the
  sweep can never touch a bot's computer.

The budget arithmetic, the step-by-step contract and the operator commands are
in `docs/canaries.md`.
