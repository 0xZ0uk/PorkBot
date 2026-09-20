# Environment reference (slice 12.7)

PRD stories 2, 4 and 9. The acceptance criteria this document supports:

- every environment variable an entrypoint or the deployment reads is documented
  with its default and whether the stack refuses to start without it;
- the deployment's one file, the process schemas and the local-stack overrides
  are distinguishable, so an operator edits the right layer;
- the names here are checked against the `.env.schema` files and the deployment
  template by the `docs` CI tier, so a renamed or removed variable fails that
  tier rather than a deployment.

The schemas are the source of truth for what a process may read. This document
is the operator-facing reading of them: grouped by the job the value does, not
by the file that declares it.

## How configuration is layered

- **`deploy/.env` is the deployment's only environment file.** `pnpm
deploy:setup` renders it from `deploy/porkbot.env.example` and generates every
  secret; Docker Compose reads it through `--env-file`. The compose file
  refuses a missing required value with `${NAME:?}`, so a hand-run `docker
compose` fails loudly too. The file is mode 0600 and git-ignored.
- **A `.env.schema` next to each entrypoint declares what that process reads**
  ([varlock](https://varlock.dev)). The root schema owns shared values;
  `apps/api`, `apps/worker`, `apps/backup`, `apps/supervisor`, `apps/web`,
  `apps/desktop`, `packages/db` and `packages/adapters` (the credential-proxy
  sidecar) each own theirs. `pnpm env:check` and the `env` CI tier audit both
  directions: a key the code reads but the schema does not declare fails by
  name, and so does a declared key no code reads.
- **The stack sets some process variables itself**, so the operator never puts
  them in `deploy/.env`. They are listed separately below.
- **Local development** uses git-ignored `.env.local` files through `varlock
run`; the README's "Environment configuration" section is the local path.

**Required** in the tables means the deployment refuses to start without a
value: either the compose file's `${NAME:?}` set or a process boot check. The
setup script generates every required secret, so a default install never
hand-writes one. **Optional** means there is a default, or unset is a working
state. A **Secret** is generated or operator-supplied material that must not
appear in a commit, a log or a support paste; see [the trust
boundary](security.md) for where each one lives.

## Service ports

Each process answers on its own `PORT`; the deployment never publishes these
directly. The proxy is the only public door, and `PORKBOT_API_PORT` /
`PORKBOT_WEB_PORT` only bind them to loopback for an operator's own curl.

| Service      | `PORT` default | Published by the stack                        |
| ------------ | -------------- | --------------------------------------------- |
| `web`        | 3000           | loopback `${PORKBOT_WEB_PORT}` (default 3000) |
| `api`        | 3001           | loopback `${PORKBOT_API_PORT}` (default 3001) |
| `worker`     | 3002           | not published                                 |
| `supervisor` | 3003           | not published                                 |
| `backup`     | 3004           | not published                                 |

The health paths are `/healthz` (legacy liveness alias), `/livez` and
`/readyz`; the API adds `/healthz/stream`, the streaming probe the reverse
proxy runbook uses.

## The deployment file

### Release identity

| Variable                | Required | Default                | Notes                                                                                                      |
| ----------------------- | -------- | ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `PORKBOT_IMAGE_TAG`     | required | the checkout's git SHA | Tags every built image; never `latest`. `--tag <git-sha>` overrides it.                                    |
| `PORKBOT_BIND_ADDRESS`  | optional | `127.0.0.1`            | Where the proxy binds 80 and 443. A host reachable from the internet sets `0.0.0.0` or its public address. |
| `PORKBOT_WEB_PORT`      | optional | `3000`                 | Loopback port for the web host.                                                                            |
| `PORKBOT_API_PORT`      | optional | `3001`                 | Loopback port for the API.                                                                                 |
| `LOG_LEVEL`             | optional | `info`                 | `debug`, `info`, `warn` or `error`; anything else refuses to boot.                                         |
| `PORKBOT_DOCKER_SOCKET` | optional | `/var/run/docker.sock` | The daemon socket the supervisor mounts. Rootless Docker or a non-standard daemon names its own path.      |

### Database

| Variable                     | Required | Default   | Notes                                                                                            |
| ---------------------------- | -------- | --------- | ------------------------------------------------------------------------------------------------ |
| `PORKBOT_POSTGRES_USER`      | optional | `porkbot` | The cluster's superuser. Changing it after first boot does not change the running roles.         |
| `PORKBOT_POSTGRES_DB`        | optional | `porkbot` | The database name.                                                                               |
| `PORKBOT_POSTGRES_PASSWORD`  | required | —         | Secret. The superuser's password; generated. Rotate with `ALTER ROLE` and then edit the file.    |
| `PORKBOT_API_DB_PASSWORD`    | required | —         | Secret. The api role's password; generated, applied by the `migrate` one-shot on every start.    |
| `PORKBOT_WORKER_DB_PASSWORD` | required | —         | Secret. The worker role's password; generated, applied by the `migrate` one-shot on every start. |

### Public origin and operator auth

| Variable                   | Required | Default                                    | Notes                                                                                                                                        |
| -------------------------- | -------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORKBOT_AUTH_ORIGIN`      | required | —                                          | The one public origin: the base for session cookies, reset links and the MCP OAuth callback. Absolute `https` with no port outside loopback. |
| `PORKBOT_WEB_ORIGIN`       | required | `PORKBOT_AUTH_ORIGIN`                      | The origin notification links point at.                                                                                                      |
| `PORKBOT_MCP_CALLBACK_URL` | optional | `<PORKBOT_AUTH_ORIGIN>/oauth/mcp/callback` | The MCP OAuth consent callback. Override only if the proxy rewrites that path.                                                               |
| `PORKBOT_AUTH_SECRET`      | required | —                                          | Secret. Signs sessions and tokens; generated. Rotating it signs every session out.                                                           |

### Transactional mail

All three or none. Unset, sign-in and sign-out still work and reset and
verification mail is refused with a typed configuration error rather than
delivering nothing quietly.

| Variable                | Required | Default | Notes                                            |
| ----------------------- | -------- | ------- | ------------------------------------------------ |
| `PORKBOT_MAIL_ENDPOINT` | optional | —       | The provider's API endpoint.                     |
| `PORKBOT_MAIL_FROM`     | optional | —       | The sender the provider may send as.             |
| `PORKBOT_MAIL_KEY`      | optional | —       | Secret. The provider key, read by name per send. |

### Supervisor and computers

| Variable                          | Required | Default   | Notes                                                                                                                                        |
| --------------------------------- | -------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORKBOT_SUPERVISOR_TOKEN`        | required | —         | Secret. The bearer the API presents to the supervisor; generated. Unset refuses every call.                                                  |
| `PORKBOT_SCREEN_TOKEN_SECRET`     | required | —         | Secret. Signs short-lived screen capabilities; generated. v1.0 ships no screen surface, so the path stays closed.                            |
| `PORKBOT_COMPUTER_PROVIDER`       | required | `offline` | `offline`, `docker` or `daytona`. A bot may select any kind the deployment configured; a kind named here but not configured refuses to boot. |
| `PORKBOT_COMPUTER_IMAGE`          | optional | —         | The machine image a real provider boots. Required when the provider is not `offline`.                                                        |
| `PORKBOT_COMPUTER_ENDPOINT`       | optional | —         | The cloud control-plane URL. Required with an image when the provider is `daytona`.                                                          |
| `PORKBOT_COMPUTER_TOKEN`          | optional | —         | Secret. The cloud control-plane token; required with the endpoint.                                                                           |
| `PORKBOT_COMPUTER_TOOLBOX_URL`    | optional | —         | The cloud toolbox URL; only when the provider's default is wrong.                                                                            |
| `PORKBOT_COMPUTER_PROXY_IMAGE`    | optional | —         | The credential-proxy sidecar image. All three proxy values or none.                                                                          |
| `PORKBOT_PROXY_TOKEN_SECRET`      | optional | —         | Secret. Signs proxy capabilities; required with the proxy image. Generated by `deploy:setup --proxy-image ... --egress-network ...`.         |
| `PORKBOT_COMPUTER_EGRESS_NETWORK` | optional | —         | The egress network the sidecar joins. All three proxy values or none.                                                                        |
| `PORKBOT_COMPUTER_CPUS`           | optional | `1`       | One bot's CPU share. A positive decimal.                                                                                                     |
| `PORKBOT_COMPUTER_MEMORY_MB`      | optional | `2048`    | One bot's memory ceiling in MB.                                                                                                              |
| `PORKBOT_COMPUTER_DISK_MB`        | optional | `10240`   | One bot's disk budget in MB.                                                                                                                 |
| `PORKBOT_COMPUTER_IDLE_MS`        | optional | `900000`  | How long a machine may go without a command before it is parked; `0` disables the sweep. The home survives a park.                           |

The remaining computer settings have process defaults and rarely need an edit:
[process variables the stack sets](#process-variables-the-stack-sets).

### Backups

| Variable                              | Required | Default     | Notes                                                                                                            |
| ------------------------------------- | -------- | ----------- | ---------------------------------------------------------------------------------------------------------------- |
| `PORKBOT_BACKUP_KEYS`                 | required | —           | Secret. The backup keyring: `id:base64key` entries; generated. Independent material from the credential keyring. |
| `PORKBOT_BACKUP_ACTIVE_KEY`           | required | `k1`        | The key id new writes use.                                                                                       |
| `PORKBOT_BACKUP_ENVELOPE_PASSPHRASE`  | required | —           | Secret. Seals the key envelope; generated and never stored. Losing it with the env keyring loses the backups.    |
| `PORKBOT_BACKUP_SCHEDULE_HOUR_UTC`    | optional | `3`         | The nightly run's UTC hour.                                                                                      |
| `PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC`  | optional | `0`         | The nightly run's UTC minute.                                                                                    |
| `PORKBOT_BACKUP_RETENTION_DAYS`       | optional | `30`        | How long an object stays readable; the newest successful run is always kept.                                     |
| `PORKBOT_BACKUP_DRILL_INTERVAL_DAYS`  | optional | `30`        | Days between restore drills.                                                                                     |
| `PORKBOT_BACKUP_S3_ENDPOINT`          | optional | —           | The S3-compatible endpoint. All five `PORKBOT_BACKUP_S3_*` values or none.                                       |
| `PORKBOT_BACKUP_S3_BUCKET`            | optional | —           | The bucket.                                                                                                      |
| `PORKBOT_BACKUP_S3_REGION`            | optional | `us-east-1` | The region.                                                                                                      |
| `PORKBOT_BACKUP_S3_ACCESS_KEY_ID`     | optional | —           | Secret. The access key id, resolved by name through the environment credential store.                            |
| `PORKBOT_BACKUP_S3_SECRET_ACCESS_KEY` | optional | —           | Secret. The secret access key.                                                                                   |

### Run notifications

| Variable                           | Required | Default | Notes                                                                                            |
| ---------------------------------- | -------- | ------- | ------------------------------------------------------------------------------------------------ |
| `PORKBOT_NOTIFICATION_WEBHOOK_URL` | optional | —       | The HTTPS webhook run-liveness notifications are delivered to. Unset keeps the offline emulator. |
| `PORKBOT_NOTIFICATION_WEBHOOK_KEY` | optional | —       | Secret. The webhook credential, read by name; required with the URL.                             |

### Credential store

| Variable                        | Required | Default | Notes                                                                                                     |
| ------------------------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `PORKBOT_CREDENTIAL_KEYS`       | required | —       | Secret. The AES-256 keyring that encrypts stored provider credentials: `id:base64key` entries; generated. |
| `PORKBOT_CREDENTIAL_ACTIVE_KEY` | required | `k1`    | The key id new writes use; treated as sensitive alongside the keyring it names.                           |

The rotation recipes for both keyrings are in [the operator
runbook](runbook.md#a-key-is-rotated).

## Process variables the stack sets

These are declared in a schema and read by a process, but the deployment fills
them: compose assembles `DATABASE_URL` from the database values, points the API
at the supervisor, and mounts `/var/lib/porkbot/*` for the storage roots. Set
them by hand only when running a process outside the stack.

| Variable                                 | Required | Default                                | Notes                                                                                                          |
| ---------------------------------------- | -------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `APP_ENV`                                | optional | `development`                          | The varlock environment flag; `production` in a deployment.                                                    |
| `DATABASE_URL`                           | required | —                                      | Secret. The connection string; the api, worker and migration runner refuse to start without it.                |
| `PORKBOT_STORAGE_DIR`                    | optional | `/var/lib/porkbot/storage`             | The storage seam's root: avatars, attachments, computer snapshot archives.                                     |
| `PORKBOT_SUPERVISOR_URL`                 | optional | `http://supervisor:3003`               | The API's door to the supervisor. Both unset means computer procedures answer the typed `SERVICE_UNAVAILABLE`. |
| `PORKBOT_WEB_ROOT`                       | optional | `dist/client` next to the host process | The directory the static host serves.                                                                          |
| `PORKBOT_BACKUP_DIR`                     | optional | `/var/lib/porkbot/backups`             | Where encrypted backup objects live when the target is local; ignored with S3 configured.                      |
| `PORKBOT_BACKUP_ENVELOPE_DIR`            | optional | `/var/lib/porkbot/backup-envelope`     | Where the sealed key envelope is written; deliberately not under the backup destination.                       |
| `PORKBOT_BACKUP_TICK_MS`                 | optional | `60000`                                | How often the backup scheduler looks for a due run.                                                            |
| `PORKBOT_COMPUTER_SOCKET`                | optional | `/var/run/docker.sock`                 | The Docker daemon's socket for the Docker provider.                                                            |
| `PORKBOT_COMPUTER_HOME`                  | optional | the provider's own (`/home/agent`)     | The machine user's home inside the image.                                                                      |
| `PORKBOT_COMPUTER_ARCHIVE_DIR`           | optional | `/var/lib/porkbot/computer-archives`   | Where home archives are staged between a machine and the snapshot store.                                       |
| `PORKBOT_COMPUTER_PIDS`                  | optional | `512`                                  | The process-count ceiling per machine.                                                                         |
| `PORKBOT_COMPUTER_TMPFS_MB`              | optional | `256`                                  | The tmpfs ceiling per machine.                                                                                 |
| `PORKBOT_COMPUTER_PULL`                  | optional | `missing`                              | `missing`, `always` or `never`: when the Docker provider pulls the machine image.                              |
| `PORKBOT_COMPUTER_DISK_QUOTA`            | optional | `none`                                 | `none` or `storage-opt`: enforce `PORKBOT_COMPUTER_DISK_MB` with the daemon's storage driver.                  |
| `PORKBOT_LIMIT_AUTHENTICATED_PER_MINUTE` | optional | `300`                                  | Authenticated request budget per minute.                                                                       |
| `PORKBOT_LIMIT_ANONYMOUS_PER_MINUTE`     | optional | `60`                                   | Anonymous request budget.                                                                                      |
| `PORKBOT_LIMIT_WEBHOOK_PER_MINUTE`       | optional | `120`                                  | Webhook ingress budget.                                                                                        |
| `PORKBOT_LIMIT_UPLOAD_PER_MINUTE`        | optional | `60`                                   | Upload budget.                                                                                                 |
| `PORKBOT_LIMIT_PROBE_PER_MINUTE`         | optional | `600`                                  | Health and streaming-probe budget.                                                                             |
| `PORKBOT_LIMIT_MAX_STREAMS_PER_ACTOR`    | optional | `4`                                    | Concurrent `text/event-stream` slots per actor.                                                                |
| `PORKBOT_LIMIT_MAX_BODY_BYTES`           | optional | `1048576`                              | JSON body cap; rejected before parsing.                                                                        |
| `PORKBOT_LIMIT_MAX_WEBHOOK_BODY_BYTES`   | optional | `262144`                               | Webhook body cap.                                                                                              |
| `PORKBOT_LIMIT_MAX_UPLOAD_BYTES`         | optional | `8388608`                              | Attachment cap, mirroring `MAX_ATTACHMENT_BYTES` in `@porkbot/core`.                                           |
| `PORKBOT_DESKTOP_UPDATE_FEED`            | optional | —                                      | HTTPS base URL the desktop release publishes `update.json` under. Unset, the app reports no feed.              |
| `PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY`      | optional | —                                      | The Ed25519 public key update manifests must be signed with; pinned by the app.                                |

## Local stack overrides

`pnpm stack:up` runs the development stack from the repository-root
`compose.yaml`; changing these never touches the deployment.

| Variable                     | Required | Default   | Notes                                                    |
| ---------------------------- | -------- | --------- | -------------------------------------------------------- |
| `PORKBOT_STACK_PROJECT`      | optional | `porkbot` | The Compose project name for the local stack.            |
| `PORKBOT_STACK_WAIT_SECONDS` | optional | `300`     | The health-wait budget for `stack:up`.                   |
| `PORKBOT_POSTGRES_PORT`      | optional | `5432`    | The local Postgres port.                                 |
| `PORKBOT_REVERSE_PROXY_PORT` | optional | `8080`    | The local proxy port; the local stack serves plain HTTP. |

## Test, deployment and release overrides

| Variable                             | Required | Default                     | Notes                                                                                                                            |
| ------------------------------------ | -------- | --------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `PORKBOT_DEPLOY_PROJECT`             | optional | `porkbot`                   | The Compose project name for the deployment commands; tests use a second project so a smoke stack can run beside the local one.  |
| `PORKBOT_DEPLOY_WAIT_SECONDS`        | optional | `300`                       | The health-wait budget for `deploy:up`, `deploy:upgrade` and `deploy:rollback`; `--wait-timeout` overrides it.                   |
| `TESTKIT_DATABASE_URL`               | optional | —                           | Attaches the testkit harness to an existing Postgres instead of booting a container. The test tiers set it in CI.                |
| `TESTKIT_HARNESS_STATE`              | optional | `.testkit/harness.json`     | The state file suites read to clone the shared migrated template.                                                                |
| `TESTKIT_POSTGRES_IMAGE`             | optional | the pinned production major | Overrides the harness Postgres image; it must be the production major.                                                           |
| `PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY` | optional | —                           | Secret. The Ed25519 private key a desktop release signs with; a GitHub Actions secret, read by the release CLI. Never committed. |

## Values a computer's sandbox receives

The computer provider injects these into the credential-proxy sidecar when the
proxy is configured; they are not deployment settings. The sidecar's
`PORKBOT_PROXY_TOKEN_SECRET` is the supervisor value listed above.

| Variable                    | Required | Default   | Notes                                                        |
| --------------------------- | -------- | --------- | ------------------------------------------------------------ |
| `PORKBOT_PROXY_COMPUTER_ID` | required | —         | Binds the sidecar to one machine.                            |
| `PORKBOT_PROXY_BOT_ID`      | required | —         | Binds the sidecar to one bot.                                |
| `PORKBOT_PROXY_GRANT_DIR`   | required | —         | Where the supervisor writes the run's grant.                 |
| `PORKBOT_PROXY_HOST`        | optional | `0.0.0.0` | The sidecar's listener address inside the machine's network. |
| `PORKBOT_PROXY_PORT`        | optional | `8321`    | The sidecar's listener port.                                 |

Three more names exist inside a running sandbox and are not configuration at
all: `PORKBOT_PROXY_URL` and `PORKBOT_PROXY_TOKEN`, the proxy's address and the
per-command capability, are set by the sidecar for the command's environment;
`PORKBOT_WEBHOOK_SECRET_<SOURCE>` is a webhook source's signing secret resolved
through the environment credential store, where the suffix is the operator's
source name.

## Where the schemas live

| File                            | Owns                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `.env.schema`                   | `APP_ENV`, `DATABASE_URL`, `LOG_LEVEL`, `PORKBOT_STORAGE_DIR`, `PORKBOT_SUPERVISOR_URL`, `PORKBOT_SUPERVISOR_TOKEN` |
| `apps/api/.env.schema`          | `PORT`, auth, mail, the MCP callback, the credential keyring, the limits                                            |
| `apps/worker/.env.schema`       | `PORT`, the notification webhook, `PORKBOT_WEB_ORIGIN`                                                              |
| `apps/backup/.env.schema`       | `PORT`, the backup schedule, keyring, envelope and S3 target                                                        |
| `apps/supervisor/.env.schema`   | `PORT`, the supervisor token, the computer settings                                                                 |
| `apps/web/.env.schema`          | `PORT`, `PORKBOT_WEB_ROOT`                                                                                          |
| `apps/desktop/.env.schema`      | the update feed and pinned public key                                                                               |
| `packages/db/.env.schema`       | the two service-role passwords                                                                                      |
| `packages/adapters/.env.schema` | the credential-proxy sidecar's injected values                                                                      |

`deploy/porkbot.env.example` is the deployment template, and the `docs` CI tier
compares this document against the schemas and the template in both directions.
