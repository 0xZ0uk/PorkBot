# Operator runbook (slice 12.7)

PRD stories 4, 5 and 8; audit P1 item 9. The acceptance criteria this document
supports:

- runbooks cover a dead disk, a stuck run, a rotated key, a failed upgrade and a
  restore from backup;
- every procedure names the commands and the files it touches, and says what it
  does not fix;
- the schema-rollback limitation is stated where an operator will meet it.

Commands run from the checkout root. `deploy:exec` runs a command in a resident
service; `deploy:backup` starts the backup image as a one-shot.

## First look

```sh
pnpm deploy:status                     # each service's state, health and ports
pnpm deploy:logs                       # follow everything; deploy:logs <service> for one
curl -fsS https://bots.example.com/healthz
```

Every process answers `/livez` (can I answer?) and `/readyz` (can I receive
work?); `/healthz` is the legacy liveness alias. Log lines carry the run and
request they belong to as `correlationId`; a run's lines also carry `runId`.
Values named `key`, `token`, `secret` or `password` are redacted before write.

| Symptom                              | Start here                                                                                                      |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| A service is unhealthy or restarting | `pnpm deploy:logs <service>`; its `/readyz` names the dependency it cannot reach.                               |
| The origin does not answer           | `pnpm deploy:logs proxy`; [the reverse proxy runbook](reverse-proxy.md#runbook-when-streaming-does-not-stream). |
| No mail arrives                      | The `PORKBOT_MAIL_*` trio is configured, and the provider accepted the send: `pnpm deploy:logs api`.            |
| A backup alert                       | `pnpm deploy:backup -- status`; [the backup runbook](backups.md#failing-loudly).                                |
| A run will not move                  | "A run is stuck" below.                                                                                         |

## A run is stuck

A run's liveness is one assessment over its own row: `starting`, `thinking`,
`working`, `waiting`, `stopping` or `stuck`, plus how long since its last
progress and its last heartbeat. A run is `stuck` when it has made no progress
for three minutes (longer than any single tool's budget), and `waiting` on an
approval or `stopping` is not a hang. The thread console renders the state; the
`runs.get` procedure carries the same fields.

The worker's watchdog runs every minute. What it does depends on why the run
stopped:

1. **The worker is alive and the run is stalled.** The watchdog marks the stall
   once per episode and sends the run-liveness notification; the run itself is
   left to its owner. A steering message (just send one into the thread) reaches
   the live session and is often enough. The run may also recover on its own.
2. **The worker process died.** Its lease expires 120 seconds after the last
   heartbeat. The watchdog reclaims the run, moves the fence and either queues a
   resume from the run's checkpoint or fails it with an operator-safe sentence:
   `checkpoint_absent` reads "the worker stopped before the run stored a
   checkpoint", and `checkpoint_unreadable` says the checkpoint was not a
   session state object. Recovery is within roughly the lease TTL plus one
   watchdog pass. Restart the worker if it is not coming back:

   ```sh
   docker compose --project-name porkbot --file deploy/compose.yaml \
     --env-file deploy/.env restart worker
   ```

3. **A tool is wedged against the bot's computer.** Open the bot's Computer
   screen: **Stop** parks the machine, **Recover** asks the provider to bring an
   errored one back, **Reset** destroys it and boots a clean one. A command
   against a machine another run holds is refused as `rate_limited`, not
   queued indefinitely.
4. **The run must end now.** `runs.stop` in the contract is the durable stop
   request (`POST /runs/{runId}/stop`): the worker observes it, cancels the live
   session and settles the run as `cancelled`. The console does not expose a
   stop button in v1.0, so an operator's levers are steering and the lease
   watchdog; a run whose worker is gone settles as soon as the lease lapses.

After a reclaim, read the run's state and error in the thread. A resumed run
continues from its checkpoint; a failed one states why.

## A key is rotated

Two rules apply to every rotation below. Edit `deploy/.env`, then apply it with:

```sh
pnpm deploy:check
pnpm deploy:up
```

Never run `pnpm deploy:setup --force` to rotate one value: it re-generates
**every** generated secret, which re-keys the credential and backup keyrings
and strands stored credentials and existing backups. Replace the one line and
deploy.

### The credential keyring

New writes use `PORKBOT_CREDENTIAL_ACTIVE_KEY`; old rows stay readable while
their key remains in `PORKBOT_CREDENTIAL_KEYS`. To rotate writes:

1. Generate a key: `openssl rand -base64 32`.
2. Append `k2:<key>` to `PORKBOT_CREDENTIAL_KEYS` and set
   `PORKBOT_CREDENTIAL_ACTIVE_KEY=k2`, then `pnpm deploy:up`.
3. Keep `k1` in the list. Re-encrypting stored rows under `k2` is the store's
   `rotate` pass; v1.0 exposes it to the server's repositories but ships **no
   operator command** for it, so do not remove `k1` until that command lands.
   Removing a key early makes the rows it wrote unreadable.

### The backup keyring

1. Append `<new id>:<key>` to `PORKBOT_BACKUP_KEYS` and set
   `PORKBOT_BACKUP_ACTIVE_KEY` to the new id; `pnpm deploy:up`.
2. Keep the old entry until the retention window (`PORKBOT_BACKUP_RETENTION_DAYS`,
   default 30 days) has passed every object the old key wrote.
3. Rewrite the sealed envelope so it carries the new keyring — the next run does
   it, or on demand:

   ```sh
   pnpm deploy:backup -- envelope
   ```

To rotate only the envelope passphrase, set the new
`PORKBOT_BACKUP_ENVELOPE_PASSPHRASE` and run the same command; the objects'
keys are unchanged.

### The auth secret

Generate fresh random material (`openssl rand -hex 32`), replace
`PORKBOT_AUTH_SECRET` with it, and run `pnpm deploy:up`. Every session and
signed token issued under the old value is invalid, so every operator signs in
again. There is no rolling rotation: a deployment has one auth process, and the
secret changes with it.

### Database role passwords

Changing `PORKBOT_API_DB_PASSWORD` or `PORKBOT_WORKER_DB_PASSWORD` in the file
alone does not change the running roles. Rotate the role first, then the file:

```sh
pnpm deploy:exec -- postgres psql -U porkbot -d postgres \
  -c "alter role porkbot_api with password '<new-password>'"
# edit the matching value in deploy/.env
pnpm deploy:up        # the migrate one-shot re-applies both role passwords
```

The superuser password is the cluster's from first init: change it with
`alter role <user> with password ...`, then update
`PORKBOT_POSTGRES_PASSWORD`.

### Provider, mail and webhook keys

- **Model and provider credentials** are rows, not environment values: revoke
  and re-add the key on **Settings → Connections** (or replace the value at the
  same name), then probe the connection.
- **Mail** and **run-notification webhook** keys are read by name at use: edit
  `PORKBOT_MAIL_KEY` or `PORKBOT_NOTIFICATION_WEBHOOK_KEY` and `pnpm deploy:up`.
- **Bot secrets** rotate on the bot's **Settings → Secrets** screen: store the
  new value under the same name and origin, or **Forget** the old one first.
- **`PORKBOT_SUPERVISOR_TOKEN`** is read by both the API and the supervisor:
  replace it and `pnpm deploy:up`; running machines and leases are unaffected.

### The desktop update signing key

The release pipeline's Ed25519 key is a deployment secret, not a service value
([the release guide](release.md#one-time-key-setup)). To rotate it: generate a
new pair, update the `PORKBOT_DESKTOP_UPDATE_PRIVATE_KEY` secret and the
`PORKBOT_DESKTOP_UPDATE_PUBLIC_KEY` variable, and ship a build that pins the new
public key. An installed client verifies every update against the key it was
built with, so keep signing with the old key until clients have the new build;
otherwise updates are refused by design.

## An upgrade failed

`pnpm deploy:upgrade --tag <git-sha>` moves through four gates and stops at the
first one that fails. The messages name what is still running:

| Where it stopped         | Message says                                                                                                                                 | State                                                     | What to do                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Pull or candidate health | "The active release is still running; no migration or switch was attempted."                                                                 | Nothing changed.                                          | Read `pnpm deploy:logs <service>`, fix the release or the host, retry.                          |
| Migration                | "Migration for release `<tag>` failed; the active release `<current>` remains running and no switch was made."                               | The old release serves; some migrations may have applied. | Fix forward with a new tag, or `pnpm deploy:rollback` and check `drizzle.__drizzle_migrations`. |
| Post-migration health    | "Release `<tag>` failed its post-migration health-check; the active release `<current>` remains running, but the migration remains applied." | Old release serves, newer schema.                         | Same: fix forward, or roll back the image and verify the old image tolerates the newer schema.  |
| Switch                   | "The switch to `<tag>` failed; restoring active release `<current>`."                                                                        | The command attempts the restore itself.                  | Watch it finish. If it reports the restore failed, keep the deployment offline and investigate. |

Rollback is **not** a schema rollback:

```sh
pnpm deploy:status                                  # confirm the release state
cat deploy/.release-state                           # active=<tag>, previous=<tag>
pnpm deploy:rollback                                # redeploys previous; --tag names another
```

It redeploys the previous image against the newer schema and never reverses
migrations. The command prints that limitation every time. If the older image
cannot run against the newer schema, restore a database backup taken before the
upgrade into a new database and point the deployment at it — [the backup
runbook](backups.md#the-key-envelope-and-the-recovery-path) is the procedure.
A second rollback rolls forward to the release you just rolled back from,
because rollback records the tag it replaced as the new previous.

The release state lives beside the env file in `deploy/.release-state` (tags
only, no credentials). It is single-level history: keep the tag of any release
you may want again.

## The disk died

Everything durable is a Docker volume with a name:

| Volume              | Holds                                                          | Copied off-host by the nightly backup?                       |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------ |
| `postgres-data`     | The database cluster                                           | Yes, as `backups/postgres/<run id>.dump.enc`                 |
| `storage-data`      | Avatars, attachment bytes, `computer-snapshots/` home archives | Only the `computer-snapshots/` archives, as `backups/homes/` |
| `computer-archives` | Staging for home archives                                      | No; transient                                                |
| `backup-data`       | The encrypted backup objects when no S3 target is configured   | No; copy it, or configure S3                                 |
| `backup-envelope`   | The sealed key envelope                                        | Copy the file into a vault                                   |
| `caddy-data`        | Certificates and runtime config                                | No; obtained again on boot                                   |
| `caddy-config`      | Caddy runtime config                                           | No; obtained again on boot                                   |

Before a host is lost, the off-host copy should hold: `deploy/.env`, the
envelope (`PORKBOT_BACKUP_ENVELOPE_DIR/key-envelope.json`), the backup objects
(the S3 bucket, or a copy of the `backup-data` volume), and — if attachment and
avatar bytes matter — a host-level copy of `storage-data`, because the nightly
backup does not copy those bytes. `deploy/.release-state` is a convenience, not
a recovery requirement.

To recover onto a new host:

1. **Prepare the host** as in [the self-host guide](self-host.md#the-host):
   Docker, Node 24 with pnpm, git, DNS and ports. Meet the same floor.
2. **Restore the checkout and the environment file.** Put `deploy/.env` back
   (or render a fresh one and copy in the surviving secrets). If the env file is
   gone but the envelope and passphrase survive, set at least `DATABASE_URL`,
   `PORKBOT_STORAGE_DIR`, the backup destination (`PORKBOT_BACKUP_DIR` or the
   five `PORKBOT_BACKUP_S3_*` values) and
   `PORKBOT_BACKUP_ENVELOPE_PASSPHRASE`; the envelope is how the backup keyring
   is recovered. With S3 configured, the objects are already on the new host's
   side. If your off-host copy is a dump file rather than an S3 bucket, put it
   where the backup job reads objects from — for example with a temporary
   one-shot that mounts the recovery directory and copies the object into the
   `backup-data` volume — or restore that volume from its copy.
3. **Start the stack** (`pnpm deploy:check && pnpm deploy:up`). It comes up with
   an empty database, which is expected: the point is a running Postgres and a
   backup job that can open the destination and the envelope.
4. **Restore the database into a new database.**
   ```sh
   pnpm deploy:backup -- restore --latest --database porkbot_restored
   # or: --key backups/postgres/<run id>.dump.enc
   ```
   The command verifies the object, restores it, proves the canary and the
   domain tables read back, and prints a summary.
5. **Put it in place.** Stop the writers, rename the empty database away, rename
   the restored one into `porkbot`, and start the stack:
   ```sh
   docker compose --project-name porkbot --file deploy/compose.yaml \
     --env-file deploy/.env stop api worker
   pnpm deploy:exec -- postgres psql -U porkbot -d postgres \
     -c "alter database porkbot rename to porkbot_empty" \
     -c "alter database porkbot_restored rename to porkbot"
   pnpm deploy:up
   ```
6. **Re-check the product.** Sign in, open a thread, and run
   `pnpm deploy:backup -- status`. The next nightly run
   writes fresh objects; the drill proves the chain again.
7. **Bot homes.** If the storage root survived, snapshots restore from the
   Computer screen as usual. If it did not, the home archives under
   `backups/homes/` are encrypted objects with no operator command that replays
   them into a provider in v1.0; the supported recovery is a snapshot restore
   against an intact storage root. Attachment and avatar bytes outside the
   nightly backup have no recovery path beyond the host-level copy in step 1.

Caddy obtains certificates again on the next boot; nothing about the old host's
certificate state is needed.

## Restore from a backup

The short form, with the commands above; the full procedure, including how the
envelope and passphrase are kept apart, is [the backup
runbook](backups.md#the-key-envelope-and-the-recovery-path).

```sh
pnpm deploy:backup -- status      # what exists, and the envelope
pnpm deploy:backup -- restore --latest --database porkbot_restored
```

A restore always creates a new database and refuses an existing name, so it can
never overwrite live data. The restore drill does the same into a scratch
database on schedule; if the drill is failing, fix that before you need it.
