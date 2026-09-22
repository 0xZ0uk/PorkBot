# Status

The slice-by-slice record of what landed. [Architecture](architecture/index.md)
is the standing design; this page is the history.

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
stack — Postgres 18, the migrate and backup one-shots, api, worker, web, the
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
key, network or daemon.

The live model launch lands with slice 6.11. The worker's work seam is no
longer a stub: `apps/worker/src/live-run.ts` resolves the run's bot, its
thread's conversation, the bot's model connection and its memory lane through
the job's repositories, composes the system prompt with `composeRunPrompt`, and
drives the live agent loop behind the shipped `RunSession` seam. The
conversation a new run continues is rebuilt from the durable event stream by
the same reducer the console uses (`apps/worker/src/run-conversation.ts`), so
the assistant turns the operator read are the turns the next prompt carries;
the operator's steering rows and stop mark reach the live session through the
command pump; and every event the session emits is recorded once, through the
shared recorder, into the `event` sink the SSE subscription replays. The bridge
in `@porkbot/adapters` turns Pi's agent loop onto `ModelRuntimeProvider` — one
`StreamFn` over the operator's own connection and credential — so no vendor
type crosses the seam, and the message ids an event carries are read as
`(run, message)` by the reducer, so a second run in a thread cannot fold its
answer into the first. The offline suite drives the whole path over the
loopback model wire with no key and no network: a message, a streamed reply, a
steer, a stop, and the settlement each produces.

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
instead of implying a stored hope. The web surface's models and connections
section reads each connection as its label, endpoint host, credential name and derived
mask, last use and the probe's own answer, including "streaming unsupported"; it
creates one by storing the key through `credentials.store` and naming it with
`modelConnections.create`, revokes a key behind a confirmation that names the
connections and bots it breaks, and distinguishes the server's one space
default from a bot's own connection. The e2e tier drives create, revoke, probe
and the default swap against a scripted API over a real socket, and the screen
is captured under `docs/screenshots/`.

The settings area lands with slice 11.5, and slice 13.13 turns its index of six
link cards into one surface. `/settings` is the panel: models and connections,
MCP servers, secrets, notifications, usage and account, each section rendered
inline with its current values — no section needs a click to say what it holds —
under a sticky section nav whose every link resolves to a section the panel
renders. The mode control sits in the panel's head as an explicit System, Light
or Dark choice, and the rail footer's menu offers the same three; both write the
same stored key, so the choice persists and wins over the system preference on
the next first paint, and System is a real choice that puts the media query back
in charge. Models and connections creates a connection by storing the key
through `credentials.store` and naming it with `modelConnections.create`,
revokes a key behind a confirmation that names the connections and bots it
breaks, replaces a stored key behind a rotate confirmation, and distinguishes
the server's one space default from a bot's own connection. MCP servers installs
a server by URL, shows the status discovery reported — `pending_authorization`
beside the consent link, never a success it did not observe — lists its tools,
grants it per bot, and confirms an uninstall with how many tools and bots it
takes down. Secrets reads one bot's rows as names, destinations and statuses,
stores a value — confirming a store over a stored name as the rotate it is — and
forgets one behind a confirmation that says the value is cleared immediately.
Notifications renders the switches with the quiet defaults the store answers.
Usage fans out over the active bots and re-reads every bot when the window
changes, under the sentence that the figures are recorded and displayed only;
the per-bot report is the same component the bot route renders. Account reads
the new authenticated `account.ownership`, which pairs the actor's role with
the deployment's configured admin address or `null` when none was configured.
The e2e tier drives a switch flip, a window change, a forget, an install and an
uninstall against a scripted API over a real socket, and the panel and each of
its six sections are captured under `docs/screenshots/` in both modes.

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
[`docs/desktop.md`](desktop.md) states it. The unit tier covers the hardening call sites, the
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
[single-host deployment record](architecture/operations.md#single-host-deployment) carries the floors and the arithmetic
against the compose ceilings. The local stack, its command and the CI
integration tier are otherwise unchanged.

The workspace compiles with TypeScript 7; typescript-eslint refuses to run against it, so
`@porkbot/eslint-config` depends on the TypeScript 6 API for lint tooling only. Remove that
pin once typescript-eslint supports TypeScript 7.
