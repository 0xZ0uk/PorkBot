# Computer providers (slice 12.7)

PRD stories 2 and 9; decision 32. The acceptance criteria this document
supports:

- an operator can choose a computer kind, configure it from the environment
  file, and size it against the documented host floor;
- per-bot selection, the unconfigured-kind refusal and the snapshot path are
  stated without reading the source;
- what each provider keeps across a stop, a reset and a host loss is explicit,
  including what the offline emulator does not keep.

A bot's computer is one interface — `ComputerProvider` — with three shipped
implementations. The supervisor owns lifecycle and is the only process that
constructs a provider and the only one that holds the Docker socket. The API
and worker dial the supervisor; a sandbox reaches neither another bot's machine
nor a service on the host. The design record is the README's "A bot's
computer" section.

## The three kinds

| Kind      | What a machine is                                 | What it needs                                         | Home durability                                                        |
| --------- | ------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `offline` | an in-process emulator per computer id            | nothing                                               | process memory only; **not backed up, not a security boundary**        |
| `docker`  | one container per bot on its own internal network | a machine image; Docker Engine on the host            | a named Docker volume, kept across stop and reset                      |
| `daytona` | one cloud sandbox per bot                         | a machine image, the control-plane endpoint and token | the sandbox filesystem across stop; a deleted sandbox needs a snapshot |

The kinds are not tiers: `offline` runs the same tool path with no daemon and no
network, which is what makes a laptop install work. It is _not_ isolation — the
machine is a data structure in the supervisor process — so a deployment with
untrusted input uses `docker` or `daytona`.

## Choosing the kind

- **The deployment default** is `PORKBOT_COMPUTER_PROVIDER` in `deploy/.env`
  (`offline`, `docker` or `daytona`). A kind named there that the deployment has
  not configured fails at supervisor boot rather than silently degrading.
  `deploy:check` refuses a `docker` or `daytona` default with no
  `PORKBOT_COMPUTER_IMAGE`, and a `daytona` default with no endpoint and token.
- **A bot can select any configured kind** on its Computer screen under "Where
  this bot's computer runs"; "Deployment default" follows the setting above. A
  bot set to a kind this deployment does not configure shows the refusal and
  asks for another choice; the API refuses it with the shared `not_found`
  rather than silently replacing the provider.
- **`computers.providers` and `computers.status`** report readiness per kind, so
  the screen can say whether a choice will start before it is saved.

## Configuring Docker

```sh
PORKBOT_COMPUTER_PROVIDER=docker
PORKBOT_COMPUTER_IMAGE=<the machine image>
```

Then `pnpm deploy:check` and `pnpm deploy:up` (see [the self-host
guide](self-host.md#choosing-what-to-turn-on)).

- **The image contract** is small and load-bearing: a POSIX shell, the coreutils
  `timeout` the command budget uses, and the browser helper protocol — one
  `browser` command taking a JSON argument and returning a JSON page record. An
  image missing any of these fails the shared conformance suite.
- **Isolation.** Every machine gets its own internal Docker network with an
  isolated gateway (`planComputerNetwork`); a container reaches neither another
  bot's machine nor host services. The Docker socket is mounted into the
  supervisor only, and the provider speaks the Engine API — no CLI, no SDK.
- **Sizing.** `PORKBOT_COMPUTER_CPUS` (default `1`),
  `PORKBOT_COMPUTER_MEMORY_MB` (default `2048`) and
  `PORKBOT_COMPUTER_DISK_MB` (default `10240`) are one bot's share of the host
  floor. Memory swap is pinned to the same ceiling; the process count is
  `PORKBOT_COMPUTER_PIDS` (default `512`). A disk quota is enforced only with
  `PORKBOT_COMPUTER_DISK_QUOTA=storage-opt`, which requires a daemon storage
  driver that answers it.
- **Pull policy** is `PORKBOT_COMPUTER_PULL` (`missing`, `always` or `never`).
  Keep `missing` in production so a restart does not depend on the registry.
- **Idle sweep.** A machine no run has used for `PORKBOT_COMPUTER_IDLE_MS`
  (default fifteen minutes; `0` disables) is parked: the container stops and the
  home volume stays. The next run boots it again.
- **Non-standard daemon.** `PORKBOT_DOCKER_SOCKET` names the socket the
  supervisor mounts; rootless Docker needs its own path.

## Configuring Daytona

```sh
PORKBOT_COMPUTER_PROVIDER=daytona
PORKBOT_COMPUTER_IMAGE=<the machine image>
PORKBOT_COMPUTER_ENDPOINT=https://app.daytona.example/api
PORKBOT_COMPUTER_TOKEN=<the API token>
```

`PORKBOT_COMPUTER_TOOLBOX_URL` is optional and only needed when the
control-plane response does not name the toolbox. The endpoint and token are
secret material: they live in `deploy/.env`, never in an image or a log. A
sandbox is created from the deployment's image with the same per-bot CPU,
memory and disk ceilings; `stop` parks it and its filesystem stays, `recover`
brings an errored sandbox back, and a removed sandbox is rebuilt empty — the
home's durable copy is the snapshot path below.

## Lifecycle and snapshots

The Computer screen's machine panel has four verbs:

- **Start** boots the machine (or creates it on first use). The first run of a
  bot creates its machine.
- **Stop** parks it. The home stays: a Docker volume, a Daytona filesystem, or
  the emulator's memory for the process lifetime.
- **Recover** asks the provider to bring a machine it reports as errored back.
- **Reset** destroys the machine and boots a clean one, after a confirmation.
  What survives follows the provider: the Docker provider keeps the named home
  volume and the next boot reuses it; a Daytona sandbox is deleted, so bring
  files across with a snapshot first; the offline emulator loses its home. Take
  a snapshot first when the files matter — the confirmation is the conservative
  sentence, and snapshots are always kept.

Snapshots are the operator's backup for a machine's home, separate from the
nightly database backup:

- **Take a snapshot** captures the home — files, not processes: running
  commands, open sessions and network connections are not in the archive — into
  the snapshot store under `computer-snapshots/<scope>/<id>.tar`, with its size
  and SHA-256 recorded.
- **Restore** fetches the archive through the store, verifies both before a
  byte reaches the machine, and replaces the machine's home. A corrupted
  snapshot leaves the existing machine exactly as it was.
- **Moving a bot between providers** is snapshot → switch → restore: capture on
  the current provider, switch the bot's choice, start the machine on the new
  provider, restore the snapshot. A switch never moves a home or applies a
  snapshot by itself, and the confirmation says so.
- **Where snapshots live.** `PORKBOT_STORAGE_DIR` is the storage root for
  archives; a real provider configured without a storage root fails at
  supervisor boot rather than capturing an archive it cannot keep. The nightly
  backup copies `computer-snapshots/` into the encrypted backup; the offline
  emulator's home is explicitly not backed up. [The backup
  runbook](backups.md) is the recovery path.

## When a machine will not start

| What you see                                 | What to do                                                                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| The provider reads unavailable               | Check `PORKBOT_COMPUTER_IMAGE` (and for Daytona the endpoint/token) in `deploy/.env`; a partial configuration fails boot.       |
| A bot's provider is refused as unconfigured  | The deployment does not run that kind. Choose a configured one, or configure it and restart the supervisor.                     |
| Boot fails as `timed_out`                    | The host is short of the floor, the image is missing, or the daemon cannot pull it. `pnpm deploy:logs supervisor`.              |
| The machine reads `gone`                     | The provider no longer holds it. Fix the provider, then Start; restore a snapshot if files are needed.                          |
| A command answers `rate_limited`             | Another run holds the machine's lease. Wait for that run; a stale lease is cleared by the lease watchdog within the run window. |
| A sandbox refused a request as `auth_failed` | The endpoint token is wrong or expired; rotate it in `deploy/.env`, then `pnpm deploy:up`.                                      |

## Where the pieces live

| Concern                         | Module                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| The seam every provider answers | `packages/adapter-kit` (`ComputerProvider`)                                             |
| Offline emulator                | `packages/adapters/src/computer-emulator.ts`                                            |
| Docker provider                 | `packages/adapters/src/docker-computer.ts`                                              |
| Daytona provider                | `packages/adapters/src/daytona-computer.ts`                                             |
| Shared lifecycle composition    | `packages/adapters/src/computer-runtime.ts`                                             |
| Supervisor registry and verbs   | `apps/supervisor/src/computer-provider.ts`, `apps/supervisor/src/computer-lifecycle.ts` |
| The network plan                | `packages/core` (`planComputerNetwork`)                                                 |
| Home archives and the store     | `packages/adapters/src/computer-snapshot-store.ts`                                      |
| The conformance suite           | `packages/adapters/src/computer-conformance.ts`                                         |
| Credentials on a machine        | [the credential proxy contract](credential-proxy.md)                                    |
