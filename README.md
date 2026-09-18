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
pnpm stack:up         # build the stack, start it, wait for every healthcheck
pnpm stack:logs       # follow the stack's logs
pnpm stack:status     # show the stack's services, states and ports
pnpm stack:down       # stop the stack; remove containers, network and volumes
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
  supervisor/  Docker socket owner: placeholder until slice 7.1
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
Postgres 18, `api`, `worker`, `web` and `supervisor`, each with a healthcheck.
One command starts it and waits:

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
  credential, and the only images pulled are Node and Postgres; provider calls
  are replaced by offline emulators as the adapter slices land (5.4, 6.9, 7.3).
  The stack runs offline.
- **Ports.** `web` on 3000, `api` on 3001, Postgres on 5432, all published on
  loopback only; `worker` and `supervisor` answer only inside the compose
  network. Override the published ports with `PORKBOT_WEB_PORT`,
  `PORKBOT_API_PORT`, `PORKBOT_POSTGRES_PORT`, and the health wait budget with
  `PORKBOT_STACK_WAIT_SECONDS`. The two database-role passwords default to local
  placeholders and are overridable with `PORKBOT_API_DB_PASSWORD` and
  `PORKBOT_WORKER_DB_PASSWORD`.
- **CI runs the same command.** The integration tier starts the stack with
  `pnpm stack:up`, attaches the testkit harness to the stack's Postgres instead
  of booting its own container, runs the integration suites against it, and
  removes the stack with `if: always()`. There is no CI-only compose file or
  boot script.
- **One migrate, then the always-on processes.** The `migrate` one-shot applies
  the committed journal, creates the two service roles and sets their passwords;
  `api` and `worker` wait on `service_completed_successfully` and then connect as
  their own roles. The five processes are the point — the api serves the
  contract's procedures, the worker runs the queue, the supervisor is idle — and
  story 44 is one command that starts the real topology: a later slice replaces a
  process's body, never its place in the stack.

Each service image builds from the root `Dockerfile`; the shared build stage
installs and builds the workspace once and `pnpm deploy`s each app into its own
runtime image. Every process answers `/healthz` — `packages/health` is the
shared route, `apps/api` keeps its own because its listener also logs requests.

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
credentials, computers, the model runtime, memory, notifications, realtime
fanout, storage and web access — plus the shared failure vocabulary (`gone`,
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
- **Redaction is wired in, not opt-in.** The logger redacts before it writes:
  fields named `key`, `token`, `secret` or `password` (and compounds such as
  `apiKey` or `X-Api-Key`, plus `authorization`, `cookie` and `credentials`)
  become `[redacted]`, sensitive query parameters are stripped from request
  paths, and every string is scrubbed of known shapes — `Bearer …`, `sk-…`,
  JWTs, connection strings with credentials, PEM private keys, `password=…`.
  Errors are serialized with their message, stack and cause redacted too.
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

`apps/api` mounts the implemented router on Hono at `/rpc`, keeps `/healthz` as
the process probe, and owns the request boundary: every response gets a
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
| Inbound webhooks (slice 4.5)   | client address       | 120     | `PORKBOT_LIMIT_WEBHOOK_PER_MINUTE`       |
| RPC request body               | —                    | 1 MiB   | `PORKBOT_LIMIT_MAX_BODY_BYTES`           |
| Webhook request body           | —                    | 256 KiB | `PORKBOT_LIMIT_MAX_WEBHOOK_BODY_BYTES`   |
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
  re-resolve the session and the membership.
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
fake repositories, and the process' fail-closed default answers "no session" so
every authenticated procedure is a typed 401 until the operator auth
configuration (secret, public origin, mail and the API's connection checkout)
is wired in a later slice.

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
`RunExecutor` seam in 6.2, and nothing enqueues `run.execute` before run creation
wires the producer in 6.5.

The worker connects with its own database role. `packages/db/migrations/0004_database_roles.sql`
creates `porkbot_api` and `porkbot_worker` and grants each only its own work:
the API writes the application schema and cannot read the queue, and the worker
reads the run state it executes and owns the `graphile_worker` schema while
writing no domain row. `packages/db/test/integration/roles.integration.test.ts`
asks the database for that division and then really performs both denied
operations, and `apps/worker/test/integration/worker.integration.test.ts`
delivers real jobs through a real queue. `pnpm db:migrate` creates the roles and
sets their passwords from `PORKBOT_API_DB_PASSWORD` and
`PORKBOT_WORKER_DB_PASSWORD`; the local stack's `migrate` service runs the same
command before the api and the worker start.

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

This is slice 3.2 of epic E3 (M2 — Auth, Ownership & Authority), landing on top
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
their typed 401 today, and the web shell slice consumes the real flow. The
authorization matrix over actors, spaces and resources is slice 3.3.

The transport's limits land with slice 4.4: `apps/api/src/limits.ts` is the one
register, installer and accounting for request budgets, body caps and
per-actor stream slots; the gate answers the contract's typed `RATE_LIMITED`
with a `Retry-After` header; and a test walks the contract tree and the route
list, so a new procedure or route cannot ship silently unlimited. The webhook
family's budget and body cap are installed and tested now, with the ingress
route itself landing in slice 4.5.

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

Under it, M0 is in place: one command, `pnpm stack:up`, starts the whole local
stack — Postgres 18, the migrate one-shot, api, worker, web and supervisor — and
waits for every healthcheck, and the same command is what CI's integration tier
runs; the testkit harness attaches to the stack's Postgres for the suite clones,
so integration tests run against the production major. The structured logger,
Postgres-per-suite isolation, the dependency pin register and the CI gate are
unchanged. `apps/web`, `apps/desktop` and `apps/www` are placeholders that the
M10 surface slices replace with the real clients; `apps/api` serves `/healthz`
and the contract's procedures behind the auth gate, `apps/worker` boots Graphile
Worker over the job registry, re-reads each run through the job's `SystemActor`
and checks its fence under the worker's own database role (slice 6.1), and
`apps/supervisor` is a placeholder for the Docker socket owner, replaced by
slice 7.1.

The workspace compiles with TypeScript 7; typescript-eslint refuses to run against it, so
`@porkbot/eslint-config` depends on the TypeScript 6 API for lint tooling only. Remove that
pin once typescript-eslint supports TypeScript 7.
