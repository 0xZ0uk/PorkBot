# Computers

## A bot's computer

[`docs/computers.md`](../computers.md) is the operator's guide: choosing and
configuring a provider, sizing it against the host floor, and snapshots.

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
with the same guarantee. Ceilings are per bot: CPU, memory, an independent and
smaller swap bound, the process count, and a write-layer disk quota that only
applies with `PORKBOT_COMPUTER_DISK_QUOTA=storage-opt` on a daemon whose
storage driver answers it. The defaults are one bot's capacity share; the
[measured deployment floor](operations-floor.md) records what the complete
stack and a stated bot count actually used. Raise the ceilings only after
raising the host.
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
releases the lease as part of settling, and [the watchdog pass](runtime.md#fenced-runs-reclaim-and-resume) also
deletes whatever expired rows a crash left behind. `packages/db` owns the
`computer_lease` rows behind the `ComputerLeaseStore` seam, and its integration
suite races two real connections against the unique `bot_id` index, drives the
reclaim through the live guard and ledger, and shows the watchdog scan finding
and clearing an expired row.
