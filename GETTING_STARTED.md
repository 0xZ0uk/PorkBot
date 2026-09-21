# Getting started

The path from a clean checkout to a running app you can change. `README.md` says what the
workspace contains; the [docs](docs/self-host.md) say what to install on a host; this page
is the one a newcomer needs first.

There are three ways to run PorkBot, in increasing order of realism:

| Path                          | Command                                   | What you get                                                                          |
| ----------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------- |
| **A. Development loop**       | `pnpm dev`                                | The real processes with hot reload, on your machine, against a Dockerised Postgres.   |
| **B. Local stack**            | `pnpm stack:up`                           | The whole product in containers, the topology a deployment uses, on `localhost:8080`. |
| **C. Single-host deployment** | `pnpm deploy:setup` then `pnpm deploy:up` | A real deployment with generated secrets at one origin ([guide](docs/self-host.md)).  |

Use **A** to change the product, **B** to click through what a deployment runs, and **C**
for a host you reach over the network.

## Before you start

- **Node 24.21.0** — `.nvmrc` pins it and `package.json` refuses another major
  (`devEngines.runtime.onFail`). With nvm: `nvm install 24.21.0 && nvm use 24.21.0`.
- **pnpm 10** — `corepack enable` installs the pinned `packageManager`; `pnpm --version`
  answers `10.34.4`.
- **Docker Engine with Compose v2** — `docker version` and `docker compose version` must
  both answer. The development loop needs it for Postgres; the integration and e2e tiers
  and the `stack:*` commands need it too. No provider key and no network egress are needed
  to run the stack.
- **git**, and a checkout you can write to.

Expect a few GB of disk for the workspace's dependencies, the build output and the
Postgres volume.

```sh
git clone https://github.com/0xZ0uk/PorkBot.git porkbot
cd porkbot
corepack enable
pnpm install     # the workspace, once
pnpm build       # 20 tasks; every later command reuses this output
```

`pnpm install` reports that it ignored the build scripts of a few dependencies. That is
pnpm 10's default policy and the install is complete; if a later `pnpm lint` complains
about a missing native resolver, run `pnpm approve-builds` and allow the package it names.

## A. The development loop

### 1. Postgres and the schema

`pnpm dev` runs the app processes on your host, but they read a migrated database. Start
only Postgres and the one-shot migration from the repository's own `compose.yaml`, so the
ports the app processes need stay free:

```sh
PORKBOT_POSTGRES_PORT=5432 docker compose -f compose.yaml up -d --build postgres migrate
```

The `migrate` service builds its image, applies the committed migrations, sets the two
service roles' passwords and exits; `docker compose -f compose.yaml ps` shows
`postgres healthy` and `migrate exited (0)`. The defaults are user `porkbot`, password
`porkbot-local` and database `porkbot`. If another Postgres already owns 5432, pass a
different `PORKBOT_POSTGRES_PORT` and use it in `DATABASE_URL` below. This is safe to
re-run; `docker compose -f compose.yaml down -v` removes the containers and the volume
when you want to start from nothing.

### 2. Local configuration

Local values live in git-ignored `.env.local` files, resolved by
[varlock](https://varlock.dev) before each process starts. The file that **declares** a
value is the file that must hold it: an app's own `.env.local` wins over the root one, and
an app whose schema declares a name itself does not read it from the root file. The
declaring schemas are listed in
[the environment reference](docs/environment.md); the three files a development loop
needs are:

`.env.local`, at the repository root (the shared values):

```sh
APP_ENV=development
DATABASE_URL=postgres://porkbot:porkbot-local@127.0.0.1:5432/porkbot
PORKBOT_STORAGE_DIR=.local/storage
PORKBOT_SUPERVISOR_URL=http://127.0.0.1:3003
PORKBOT_SUPERVISOR_TOKEN=local-development-supervisor-token
```

`apps/api/.env.local` (auth and the credential keyring):

```sh
PORKBOT_AUTH_SECRET=<hex of 32 random bytes: openssl rand -hex 32>
PORKBOT_AUTH_ORIGIN=http://localhost:5173
PORKBOT_CREDENTIAL_KEYS=devkey1:<base64 of 32 random bytes: openssl rand -base64 32>
PORKBOT_CREDENTIAL_ACTIVE_KEY=devkey1
```

`apps/supervisor/.env.local` (its schema owns the process credential):

```sh
PORKBOT_SUPERVISOR_TOKEN=local-development-supervisor-token
PORKBOT_SCREEN_TOKEN_SECRET=local-development-screen-secret
```

Create the storage root once, because the api refuses to start without it:

```sh
mkdir -p .local/storage
```

Two details are worth knowing before they cost an afternoon:

- **The credential key id needs three characters or more locally.** A deployment generates
  the id as `k1`, and the schema marks `PORKBOT_CREDENTIAL_ACTIVE_KEY` as sensitive;
  varlock refuses a sensitive value that short, so the api never boots during `pnpm dev`.
  Any longer id works, as long as `PORKBOT_CREDENTIAL_KEYS` writes under the same one.
  Production is unaffected: varlock does not run there.
- **The supervisor's token belongs in `apps/supervisor/.env.local`.** Its schema declares
  that name itself, so a copy in the root file does not reach the process: the supervisor
  boots, answers `503` on `/readyz` and logs that its lifecycle surface will refuse every
  call. The api reads the same name from the root file because its schema imports it, so
  the value must be identical in both.

`PORKBOT_AUTH_SECRET` and `PORKBOT_AUTH_ORIGIN` are all-or-nothing: with both set the api
mounts Better Auth and resolves the session cookie; with neither it boots fail-closed and
every authenticated procedure answers its typed 401; with one it refuses to boot. Mail is
optional (`PORKBOT_MAIL_ENDPOINT`, `PORKBOT_MAIL_FROM` and `PORKBOT_MAIL_KEY`, all three or
none): unset, sign-in and sign-out still work and reset and verification mail is refused
with a typed configuration error instead of delivering nothing quietly.

To keep a real secret out of a plaintext file, write `DATABASE_URL=varlock(prompt)` and run
`pnpm dev` once: the encrypted form is written back, and `varlock reveal DATABASE_URL`
prints it. `varlock scan` checks the tracked tree for a value that leaked into plaintext.
[The development record](docs/architecture/development.md) has the rest.

### 3. Run it

```sh
pnpm dev
```

Turbo builds the workspace dependencies, then runs the always-on processes:

| Process           | Port | What it is                                                                     |
| ----------------- | ---- | ------------------------------------------------------------------------------ |
| `apps/api`        | 3001 | The RPC and streaming surface, the auth gate, `/healthz`, `/livez`, `/readyz`. |
| `apps/worker`     | 3002 | The durable job queue and run execution.                                       |
| `apps/supervisor` | 3003 | Computer lifecycle; the default provider is the offline emulator.              |
| `apps/web`        | 5173 | The Vite dev server — **this is the app**, at `http://localhost:5173`.         |

`apps/backup`, `apps/desktop` and `apps/www` have no `dev` script. The desktop shell runs
with `pnpm --filter @porkbot/desktop start` after `pnpm build`, since it packages the same
client build the web image serves.

The Vite server proxies the API's paths to port 3001, so the SPA and the API share one
origin in development exactly as they do behind the deployment's proxy — which is why
`PORKBOT_AUTH_ORIGIN` names the dev server's own origin and why a port Vite picks on its
own has to be named there too. A quick check that everything is up:

```sh
curl -s localhost:3001/healthz
curl -o /dev/null -w '%{http_code}\n' localhost:3003/readyz   # 200
```

### 4. The first sign-in

Signups are closed on a fresh database until one row opens them, and only the configured
admin email is ever granted ownership; a registration from anyone else is a member. Insert
that row through the stack's Postgres:

```sh
docker compose -f compose.yaml exec postgres psql -U porkbot -d porkbot -c \
  "insert into deployment_settings (signups_enabled, admin_email) values (true, 'operator@example.invalid')"
```

Open `http://localhost:5173/sign-up` and create the account with **that** email: it becomes
the space owner. Email verification is not required to sign in. Close the door again once
you are in:

```sh
docker compose -f compose.yaml exec postgres psql -U porkbot -d porkbot -c \
  "update deployment_settings set signups_enabled = false"
```

### 5. Make a bot answer

A run needs a model, and a fresh install ships no endpoint and no key: add one under
**Settings → Connections** with a label, the provider's OpenAI-compatible base URL, a
credential name, the API key and optionally a default model. The key is encrypted with
`PORKBOT_CREDENTIAL_KEYS` before it is stored and is never shown again.

The endpoint must be reachable over HTTPS. Private, loopback and link-local addresses are
refused by the URL-safety list, so a stub model server on your own machine cannot be
dialled by a run; the offline emulators exist for the test tiers, not for the running
product. Everything else works with no key and no network: computers default to the
in-process emulator, notifications default to the offline emulator, and mail is optional.

### 6. Change something

- **A screen** lives in `apps/web/src/routes` and `apps/web/src/screens`; the dev server
  reloads as you save. Colours come from `@porkbot/tokens` and controls from `@porkbot/ui`
  — lint fails a hardcoded colour in a surface and a screen that hand-rolls a primitive.
- **A package** is built with `pnpm --filter <name> build`, or by re-running `pnpm dev`; the
  api, worker and supervisor run under `node --watch` and restart themselves.
- **A schema change** starts in `packages/db/src/schema`: `pnpm db:generate` writes the
  migration you review and commit, and `pnpm db:migrate` applies it. Generated output is the
  migration; a schema change without its generated file fails the unit tier.
- **A provider** is one implementation in `@porkbot/adapters` behind an interface from
  `@porkbot/adapter-kit`, plus its offline emulator. The import edges are lint rules in
  `packages/eslint-config/module-boundaries.js`, not conventions.

### 7. Run the checks

The CI tiers are the same commands, so run the ones that cover your change before you open
a pull request:

```sh
pnpm format:check && pnpm lint && pnpm typecheck && pnpm build
pnpm test              # unit tests
pnpm test:coverage     # the unit tier CI runs
pnpm test:integration  # needs a real Postgres; see below
pnpm test:e2e          # browser flows; the only tier that retries
pnpm quarantine:check && pnpm dependencies:check && pnpm env:check && pnpm docs:check
```

`pnpm testkit:start` and `pnpm testkit:migrate` boot the harness Postgres for the
integration suites, and `TESTKIT_DATABASE_URL` attaches a suite to a Postgres you already
have. The provider emulators mean no test needs a key or network access.

## B. The local stack

```sh
pnpm stack:up       # build every image, start the stack, wait for every healthcheck
pnpm stack:status   # services, states, ports
pnpm stack:logs     # follow the logs
pnpm stack:down     # stop it; containers, network and volumes are removed
```

Caddy serves the SPA, the API and the streams on one origin at `http://localhost:8080` —
the same `deploy/Caddyfile` a deployment ships. This path builds images from source, so it
is the wrong loop for changing a screen, and the local stack does not configure the
credential keyring, so stored model credentials are locked there. Use the development loop
for anything that touches a credential.

## C. A deployment

[docs/self-host.md](docs/self-host.md) is the runbook: one Linux host with Docker, the
documented floor, one environment file with generated secrets, one sign-in, one bot. The
short version:

```sh
pnpm deploy:setup --origin https://bots.example.com
pnpm deploy:check
pnpm deploy:up
```

`pnpm deploy:upgrade --tag <git-sha>` and `pnpm deploy:rollback` are the day-two commands,
and [the operator runbook](docs/runbook.md) covers a dead disk, a stuck run, a rotated key
and a failed upgrade.

## When it will not start

| Symptom                                                                      | Cause and fix                                                                                                                                   |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `Configuration is currently invalid`, naming `PORKBOT_CREDENTIAL_ACTIVE_KEY` | The key id is shorter than three characters. Use a longer one that matches the keyring's entry.                                                 |
| The supervisor logs that its token is not set and `/readyz` answers 503      | The token is missing from `apps/supervisor/.env.local`, or it differs from the api's.                                                           |
| `DATABASE_URL is not set`, or the api exits immediately                      | The root `.env.local` is missing, or a process was started directly instead of through its package's `dev` script (which runs varlock).         |
| A port is already in use                                                     | `PORKBOT_POSTGRES_PORT`, `PORKBOT_API_PORT`, `PORKBOT_WEB_PORT` and `PORKBOT_REVERSE_PROXY_PORT` move the local ports.                          |
| The sign-up page says registration is closed                                 | The `deployment_settings` row is missing, or more than one exists.                                                                              |
| A connection stores but a run cannot use it                                  | The credential was stored under a different keyring than the one the process holds; a rotated keyring must keep the old entry to read old rows. |
| `Unsupported engine` during install                                          | Node is not 24.x. Switch versions and re-run.                                                                                                   |

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) is what a pull request needs and
[AGENTS.md](AGENTS.md) is the contract the code holds itself to — one task per branch
branched from `main`, the pull-request template filled in with outcomes in words, a reason
for every dependency, and no secret, real hostname or personal address anywhere in a diff,
a commit message or a pull request.
