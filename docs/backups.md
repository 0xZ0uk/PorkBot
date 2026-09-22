# Nightly encrypted backups and a real restore drill (slice 12.3)

PRD story 5; audit P1 item 10. The acceptance criteria this document supports:

- backups run on schedule, are encrypted at rest, and fail loudly with an alert
  if they do not run;
- a restore into a scratch environment produces a working product with
  readable data, and the drill runs on schedule rather than by hand;
- the key envelope is backed up separately from the ciphertext, and a
  documented recovery path exists;
- remote-computer homes are handled per the storage seam's rules or explicitly
  declared not backed up;
- the retention policy is documented and enforced.

## What is backed up

| What                  | Where it comes from                                        | Where it goes                                             |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------------- |
| The Postgres database | `pg_dump --format=custom` over the owner connection        | `backups/postgres/<run id>.dump.enc`                      |
| Bot homes             | `computer-snapshots/` in the primary storage, via the seam | `backups/homes/<run id>/<source key>.enc`                 |
| The backup keyring    | `PORKBOT_BACKUP_KEYS`                                      | the sealed envelope on its own volume, under a passphrase |
| The backup ledger     | `backup_run` rows in the database it backs up              | restored with the database                                |

Homes are read through `StorageProvider`, never a filesystem path, and the
snapshot archives are the durable copy of a home: a Docker volume, a cloud
sandbox and the supervisor's delegate all reach the seam through the snapshot
path. `COMPUTER_HOME_SYNC` in `packages/adapter-kit/src/home-sync.ts` states
each provider's story; the offline emulator's home is process memory and is
explicitly not backed up, so a deployment on it has no home archive to copy.
A deployment that never runs the snapshot job has no home backup — the backup
job copies what the snapshot path wrote, it does not reach into a machine.

The database dump excludes `graphile_worker`: the queue is rebuilt by the
worker on boot, and restoring stale queue state is noise rather than recovery.

## The schedule

The nightly run is a UTC time (`PORKBOT_BACKUP_SCHEDULE_HOUR_UTC`,
`PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC`; default 03:00). The ledger's newest
attempt is the cursor: a host that was down for three days runs once after it
returns rather than replaying three nights, and another invocation minutes
after a run does nothing. `deploy:up` runs the one-shot once with that same due
check, so a fresh deployment has a backup before its first night.

`pnpm deploy:up` installs and enables a persistent per-user systemd timer and
enables lingering for that user. At the calendar time, systemd starts an
ephemeral Compose container and waits for it to exit. No backup process holds
memory between runs. `pnpm deploy:schedule` refreshes the timer after a schedule
change; `pnpm deploy:status` reports its loaded, enabled and active state and
next firing. The service's logs are in
`journalctl --user -u porkbot-backup.service`.

The container holds the database owner's connection — the only application
container that does — only for the run. It has no HTTP surface, Docker socket
or agent-facing path. A session-scoped Postgres advisory lock permits only one
owner, so an overlapping timer or operator command is refused instead of taking
two dumps, while a killed container releases the lane automatically. The job reads destination keys through the S3 adapter when
`PORKBOT_BACKUP_S3_*` is configured and writes to a local volume otherwise.

## Encryption at rest

Two layers, both in `apps/backup/src/cipher.ts`:

1. **The object format.** Every object is AES-256-GCM in 64 KiB records. A
   fresh salt per object derives a per-object data key from the keyring's
   master key with HKDF-SHA256; a random nonce prefix plus a record counter
   makes every nonce unique. The counter and a terminal-record flag are
   authenticated, so a truncated, reordered or spliced object fails before a
   byte of plaintext is trusted. The stored object is also hashed (SHA-256),
   and the drill verifies the hash as it streams the object back.
2. **The key envelope.** The whole keyring is sealed under a key derived from
   `PORKBOT_BACKUP_ENVELOPE_PASSPHRASE` with scrypt. The KDF cost, the cipher
   and the IV are authenticated, so a downgrade fails rather than deriving a
   weaker key.

The backup keyring is independent material from the credential keyring
(`PORKBOT_BACKUP_KEYS`, `PORKBOT_BACKUP_ACTIVE_KEY`), so a leaked credential
key does not open a backup. `pnpm deploy:setup` generates both keyrings and the
passphrase; no key is hand-invented.

## The key envelope and the recovery path

The envelope is written to `PORKBOT_BACKUP_ENVELOPE_DIR` (default
`/var/lib/porkbot/backup-envelope`, its own volume in both compose files) after
every run. It is a different location from the backup
destination on purpose: a bucket that holds both the ciphertext and the key
that opens it is not encrypted at rest in any useful sense.

**Copy the envelope off the host.** The file is safe to keep in a password
manager or an offline vault — it is useless without the passphrase, which is
never stored. On a fresh host:

1. restore the stack's env file (or at least `DATABASE_URL`,
   `PORKBOT_STORAGE_DIR`, `PORKBOT_BACKUP_DIR`/`PORKBOT_BACKUP_S3_*` and
   `PORKBOT_BACKUP_ENVELOPE_PASSPHRASE`) and put the envelope back at
   `PORKBOT_BACKUP_ENVELOPE_DIR/key-envelope.json`;
2. start Postgres and run the migrations (`pnpm db:migrate` or the `migrate`
   service) so the roles exist;
3. `pnpm deploy:backup -- restore --latest --database porkbot_restored` — or
   `--key backups/postgres/<run id>.dump.enc` for a
   specific backup. The command creates the database, restores the dump,
   proves a canary row and the domain tables read back, and prints a summary.
4. Point the API and the worker at the restored database, or rename it into
   place, and start the stack.

Without the passphrase the envelope does not open; without the envelope the
keyring lives only in the environment. Keep both. `pnpm deploy:backup -- status`
names the envelope path, whether it is present, and
the last run, success and drill.

## The restore drill

A drill is due with the first successful backup and then every
`PORKBOT_BACKUP_DRILL_INTERVAL_DAYS` (default 30). It restores the latest
successful dump into a scratch database on the same server, reads the canary
token back out and compares it with the token the run recorded — proof that the
restore produced the data that was backed up, not merely a schema that parsed —
then drops the scratch database on every path including failure. A failed drill
is recorded on the run's `drill_status`/`drill_error_code` and is due again on
the next run.

The drill needs `CREATE DATABASE` on the server, which the owner connection has.
A deployment that gives the backup process a narrower role must grant it
`CREATEDB` and read access to every table `pg_dump` walks.

## Retention

`PORKBOT_BACKUP_RETENTION_DAYS` (default 30) is enforced after every successful
backup: objects under `backups/` older than the window are deleted, and the run
that just wrote its objects is protected, so the newest successful backup is
never deleted however old it is. The policy is the same for the Postgres dumps
and the home copies. A rotation of the backup keyring keeps the old key in
`PORKBOT_BACKUP_KEYS` until the retention window has passed every object that
key wrote.

## Failing loudly

The backup job settles every run in `backup_run` with a closed `error_code`
and logs it. The worker's `backup.watchdog` job (every five minutes) reads the
deployment-scoped ledger and alerts through the notification provider when:

- the newest run failed, or has been `running` far past any plausible duration;
- no backup has succeeded within the staleness window (36 hours by default), or
  none has ever succeeded;
- a drill failed, or no drill has succeeded within the drill window (45 days).

Each alert is claimed once per episode in `backup_alert`, so one fact is one
message even if two workers deliver the job. With no notification webhook
configured the alert goes to the offline emulator and the error-level log line
is the loud part; a configured webhook pages the operator.

## Where the pieces live

| Concern                        | Module                                                                 |
| ------------------------------ | ---------------------------------------------------------------------- |
| Schedule, retention, alerts    | `packages/core/src/backup-policy.ts`                                   |
| Host timer                     | `packages/testkit/src/deployment/commands.ts`                          |
| Stream cipher and envelope     | `apps/backup/src/cipher.ts`                                            |
| Encrypted objects over storage | `apps/backup/src/archive.ts`                                           |
| `pg_dump`/`pg_restore`         | `apps/backup/src/postgres.ts`                                          |
| One run and its drill          | `apps/backup/src/run.ts`, `apps/backup/src/drill.ts`                   |
| The ledger (one owner)         | `packages/db/src/backup-store.ts`, `packages/db/src/schema/backups.ts` |
| The alert watchdog             | `apps/worker/src/jobs/backup-watchdog.ts`                              |
| The operator's commands        | `apps/backup/src/cli.ts`                                               |
| The real drill proof           | `apps/backup/test/integration/backup.integration.test.ts`              |
