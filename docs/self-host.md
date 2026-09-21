# Self-host PorkBot on one host (slice 12.7)

PRD story 2; decision 32. The acceptance criteria this document supports:

- a reader who has never seen the repository can install from this guide and the
  README alone, without a maintainer's help;
- the host floor, the ports, the disk budget and the one environment file are
  stated before anything is started;
- the first sign-in, the first model connection, the first bot and the first run
  are walked end to end;
- every command named here exists in the README's entry points, and every value
  is described in the environment reference.

This is the task-oriented path. The [architecture record](architecture/index.md)
describes why the pieces exist; this document says what to type. Commands run
from the checkout root unless a step says otherwise.

## What you are installing

One host runs the whole product as a Compose stack. There are no external
services to provision: Postgres, the reverse proxy and every process are
containers on the same machine.

| Service      | What it does                                                        | Reachable from          |
| ------------ | ------------------------------------------------------------------- | ----------------------- |
| `postgres`   | The database (Postgres 18; its image is pinned by digest)           | the stack network only  |
| `migrate`    | One-shot: applies the committed migrations, sets the role passwords | nothing; exits          |
| `api`        | The RPC and file surface, the auth gate, the streams                | the proxy, loopback     |
| `worker`     | The job queue, run execution, notifications                         | the stack network only  |
| `backup`     | The nightly encrypted backup and its restore drill                  | the stack network only  |
| `web`        | The static SPA host                                                 | the proxy, loopback     |
| `proxy`      | Caddy: TLS, one origin for the SPA and the API                      | the public ports 80/443 |
| `supervisor` | Computer lifecycle; the only holder of the Docker socket            | the stack network only  |

`api` and `worker` never see the Docker socket or a provider credential: they
reach computers through the supervisor's authenticated surface. The reverse
proxy is the only service that publishes a port; the [single-host deployment
record](architecture/operations.md#single-host-deployment) is the design record
and [the reverse proxy contract](reverse-proxy.md) is the contract it keeps.

## The host

The supported shape is one Linux host with Docker Engine and the Compose v2
plugin. Size a deployment from the committed [measured floor table](architecture/operations-floor.md),
which separates idle usage from workload peaks and records the bot count and
host shape it measured. The [single-host deployment
record](architecture/operations.md#single-host-deployment) keeps the Compose
ceilings and per-bot limits as the invariant; the per-bot settings are
`PORKBOT_COMPUTER_CPUS`, `PORKBOT_COMPUTER_MEMORY_MB` and
`PORKBOT_COMPUTER_DISK_MB`.

On the host you need:

- **Docker Engine with Compose v2** — `docker version` and
  `docker compose version` must both answer. `deploy:up` checks before it
  touches anything.
- **Node 24 and pnpm 10** — the deployment commands run from the checkout, not
  from an image. `corepack enable` gets the pinned pnpm.
- **git** — the image tag defaults to the checkout's commit, and upgrades name a
  commit.
- **DNS and ports** — point an `A`/`AAAA` record at the host and allow inbound
  `80` and `443`. Caddy obtains the certificate through an ACME challenge on
  those ports.

The public origin must be an absolute `https` origin with **no port**:
`deploy:check` refuses `https://bots.example.com:8443`, because the proxy
publishes 80 and 443 and cannot serve a certificate for another port. `http` is
accepted only for a loopback origin, which is what the local stack uses.

## Install

```sh
git clone https://github.com/0xZ0uk/PorkBot.git porkbot
cd porkbot
corepack enable
pnpm install
```

Render the deployment's one environment file. This generates every secret — the
database passwords, the auth secret, both encryption keyrings, the backup
envelope passphrase and the supervisor token — so no key is hand-invented. The
file is written to `deploy/.env` with mode 0600 and is git-ignored:

```sh
pnpm deploy:setup --origin https://bots.example.com
```

Review `deploy/.env` before the first boot. The generated secrets need no
edits; what an operator may want to add is optional and grouped in the file:
mail, the notification webhook, a real computer provider, off-site backup
storage and the credential proxy. [The environment
reference](environment.md) documents every key with its default and whether the
stack refuses to start without it.

Then validate, and bring the stack up:

```sh
pnpm deploy:check    # validates the file without touching Docker
pnpm deploy:up       # builds, starts and waits for every healthcheck
```

`deploy:up` builds the app images from the checkout, starts the stack, and
waits on Compose's `--wait` until every readiness probe passes. A service that
never becomes healthy fails the command, prints the per-service state and the
recent logs, and leaves nothing half-up. When it returns, the status table names
the origin and the loopback ports:

```sh
pnpm deploy:status   # each service's state, health and published ports
pnpm deploy:logs     # follow the logs
```

To replace the measured record after changing the host, images or deployment
limits, configure `PORKBOT_COMPUTER_IMAGE` so both provider paths are available
and run:

```sh
pnpm deploy:measure
```

The command deliberately stops and cold-boots the live stack without rebuilding
its images. It runs a migration, N offline and N Docker-provider computers both
idle and working, a forced backup with its restore drill, and a default one-hour
idle window. It writes the reviewed Markdown table to
`docs/architecture/operations-floor.md` and raw JSON samples to the ignored
measurement artifact directory; use `--idle-seconds` to shorten a CI run.

## The first sign-in

Signup is closed on a fresh deployment until one row opens it. Insert it through
the stack's Postgres — this is the one raw SQL step in the install, and it is
deliberate: no procedure creates an owner from nothing. The defaults are shown;
substitute `PORKBOT_POSTGRES_USER` and `PORKBOT_POSTGRES_DB` if you changed
them.

```sh
pnpm deploy:exec -- postgres psql -U porkbot -d porkbot -c \
  "insert into deployment_settings (signups_enabled, admin_email)
   values (true, 'operator@example.com')"
```

Open `https://bots.example.com` and choose **Create account** with that email:
the first account becomes the space owner. The sign-up link is offered only
while the deployment reports signups open. Once you are in, close the door
again:

```sh
pnpm deploy:exec -- postgres psql -U porkbot -d porkbot -c \
  "update deployment_settings set signups_enabled = false"
```

Email verification is not required to sign in. Without the optional mail trio
(`PORKBOT_MAIL_ENDPOINT`, `PORKBOT_MAIL_FROM`, `PORKBOT_MAIL_KEY`), reset and
verification mail is refused with a typed configuration error instead of
delivering nothing quietly; sign-in, sign-out and the product work.

## The first model connection

A run needs a model. A fresh deployment ships no endpoint and no key, so the
first connection is the operator's own provider, added in the UI:

1. Open **Settings → Connections** and choose **New connection**.
2. Fill **Label**, **Base URL** (the provider's OpenAI-compatible base, for
   example `https://models.example.invalid/v1`), **Credential name** (the
   stored key's name; `model-key` is the default), **API key**, and optionally
   **Default model**. The key is encrypted before it is stored and is never
   shown again.
3. Choose **Connect**, then **Test** on the connection's card. The probe reports
   the endpoint's own answer: a classified refusal is named as the kind it is
   (`Endpoint unreachable`, `Key refused`, ...), not smoothed into a checkmark.
4. Choose **Make default** unless you set per-bot connections later. A bot
   follows the space default until its editor names another connection.

## The first bot and the first run

1. From **Home**, create a bot: **Name**, optional **Title**, **Description**,
   **Colour**, what it should do under **Instructions**, a **Group** if you use
   sections, and a **Provider** only if you configured more than one computer
   kind (the default is the deployment's).
2. Open the bot and start a thread. Send a message. The send creates the run;
   the bot's machine is created the first time it runs. With the default
   `offline` provider the machine is the in-process emulator — no daemon, no
   network, and its home is not durable — which is enough to see the product
   work end to end.
3. Watch the run in the thread console: the timeline is durable, so a reload
   does not lose it. A run that stops making progress shows as `Stuck` with its
   heartbeat; [the operator runbook](runbook.md) is what to do about it.

Tool calls that touch the credential store, a request to use a stored bot
secret, a write outside the bot's home, egress outside the run's allowlist, or
any send or delete open the run's durable approval gate. The approvals screen
is where the operator answers. External content — web pages, files, tool
results — is labelled as untrusted data before it reaches the model.

## Choosing what to turn on

Every option below is a `deploy/.env` edit, then the same two commands:

```sh
pnpm deploy:check
pnpm deploy:up
```

`pnpm deploy:setup` is only needed when you want it to generate or re-render a
value (for example the credential proxy's token); it keeps existing values
unless `--force` is passed.

- **Transactional mail.** Set the `PORKBOT_MAIL_*` trio (all three or none).
- **Run notifications.** Set `PORKBOT_NOTIFICATION_WEBHOOK_URL` and its key;
  unset keeps the offline emulator, which records deliveries and sends nothing.
- **Real computers.** Choose `docker` or `daytona`, set
  `PORKBOT_COMPUTER_IMAGE`, and for Daytona the endpoint and token. The
  [computer provider guide](computers.md) covers sizing, snapshots and moving a
  bot's home between providers.
- **Off-site backups.** Set the five `PORKBOT_BACKUP_S3_*` values (all five or
  none). Backups are encrypted either way; [the backup
  runbook](backups.md) covers the destination and the recovery path.
- **The credential proxy.** Run
  `pnpm deploy:setup --proxy-image <ref> --egress-network <name>` (both flags
  together) to give Docker computers a sidecar that holds run credentials on the
  sandbox's behalf; [the credential proxy contract](credential-proxy.md) is the
  boundary.
- **The proxy and TLS.** The shipped Caddy config needs no editing;
  [the reverse proxy contract](reverse-proxy.md) is the runbook for certificates
  and streaming.

## Day two

```sh
pnpm deploy:status
pnpm deploy:logs
pnpm deploy:exec -- <service> <command>     # run a command in a running service
pnpm deploy:exec -- postgres psql -U porkbot -d porkbot
pnpm deploy:exec -- backup node dist/cli.js status
```

- **Upgrades.** `pnpm deploy:upgrade --tag <git-sha>` pulls the target release,
  health-checks disposable candidates, applies its migrations, then switches.
  `pnpm deploy:rollback` redeploys the previous release. Rollback is not a
  schema rollback; [the upgrade runbook](runbook.md#an-upgrade-failed) states
  what that means in practice.
- **Backups.** The backup process runs nightly, writes encrypted objects to its
  volume or to S3, and drills a restore every 30 days. Copy the sealed key
  envelope off the host and keep the passphrase in a vault; [the backup
  runbook](backups.md#the-key-envelope-and-the-recovery-path) is the recovery
  path when the host is gone.
- **Incidents.** A dead disk, a stuck run, a key rotation or a failed upgrade:
  [the operator runbook](runbook.md).
- **Security.** What a bot can reach, where credentials live and what this
  deployment does not protect: [the trust boundary](security.md).

To stop the stack, `pnpm deploy:down` keeps every volume. Passing `--volumes`
deletes Postgres data, bot storage, computer archives, the backup destination
and envelope, and the proxy's certificates, after saying so. To uninstall
completely, pass `--volumes` and remove the checkout.
