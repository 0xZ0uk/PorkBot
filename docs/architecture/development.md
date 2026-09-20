# Development

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

## Environment configuration

The operator-facing reference — every variable with its default and whether the
stack refuses to start without it — is
[`docs/environment.md`](../environment.md).

Every variable an entrypoint reads is declared in a `.env.schema` next to it
([varlock](https://varlock.dev), pinned in `dependencies.json`). The root
`.env.schema` owns the values more than one process uses; `apps/api`,
`apps/worker`, `apps/supervisor`, `apps/web`, `packages/db` (the migration
runner) and `packages/adapters` (the credential-proxy sidecar) each own theirs
and import the root for the shared keys. The schemas are the source of truth:
`varlock audit`, run by `pnpm env:check` and the required `env` CI tier, fails
when code reads a key the schema does not declare, or a schema declares a key
no code reads.

- **Local development.** The api, worker and supervisor `dev` scripts run
  through `varlock run`, as does web's built host (`pnpm --filter
@porkbot/web serve`), so environment files are resolved and validated before
  the process starts. Put local values in a git-ignored `.env.local` — the root
  one applies to every app, an app's own wins — and keep the sensitive ones
  encrypted, so they never sit in plaintext: write `DATABASE_URL=varlock(prompt)`,
  run `pnpm dev` once, and the encrypted form is written back. `varlock reveal
DATABASE_URL` prints a value, and `varlock encrypt --file .env.local`
  encrypts a file of plaintext values in place. The key is device-local: these
  files are not shared between machines and never committed. Vite's dev server
  reads no environment variables and is not wrapped. `varlock scan` checks the
  tracked tree for a resolved sensitive value that leaked into plaintext, so a
  secret caught by a schema is still caught when it is copied into a file.
- **Signing in locally.** `PORKBOT_AUTH_SECRET` and `PORKBOT_AUTH_ORIGIN` are
  all-or-nothing: with both set the API mounts Better Auth at `/api/auth/*` and
  resolves the session cookie the gate reads; with neither it boots fail-closed
  and every authenticated procedure answers its typed 401; with one it refuses
  to boot. They are declared in `apps/api/.env.schema`, so local values go in
  `apps/api/.env.local` — the root `.env.local` is for the values the root
  schema owns. The web dev server proxies the API's paths to port 3001
  (`apps/web/vite.config.ts`), so the SPA and the API share one origin and
  `PORKBOT_AUTH_ORIGIN` is that origin — `http://localhost:5173` for `pnpm dev`.
  Signup stays closed until the deployment's settings row opens it, so run
  `insert into deployment_settings (signups_enabled, admin_email) values (true,
'<the operator email>')` against the database — through the stack's Postgres
  (`docker compose exec postgres psql -U porkbot -d porkbot`) or any `psql`
  with `DATABASE_URL` — and the sign-up screen admits that email as the owner.
  Optional mail for reset and verification is the `PORKBOT_MAIL_ENDPOINT`,
  `PORKBOT_MAIL_FROM` and `PORKBOT_MAIL_KEY` trio, also all-or-nothing; unset,
  sign-in and sign-out still work and mail is refused as a typed
  configuration error.
- **CI.** `pnpm env:check` loads every schema with `APP_ENV=ci` and the
  committed `.env.ci` fixtures — obvious fakes, never secrets — because the
  tier must prove required items resolve without a deployment's environment.
  The tier deliberately does not use `APP_ENV=test`; Vite loads `.env.test`
  into every Vitest process, and CI fixtures have no business there.
- **Production.** The deployment injects real environment variables and varlock
  is not in the runtime image; it reads nothing there. The schema's job in
  production is to be the contract the variables must satisfy, and the `env`
  tier is what proves code and schema still agree.

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
- **Run liveness.** A worker job creates its run child logger at the job
  boundary, so execution, lease recovery, stall detection and notification
  lines carry both `runId` and `correlationId`. The run timeline and its
  stalled-run notification remain the operator's durable signal when a run
  stops making progress.
- **Redaction is wired in, not opt-in.** The logger redacts before it writes:
  fields named `key`, `token`, `secret` or `password` (and compounds such as
  `apiKey` or `X-Api-Key`, plus `authorization`, `cookie` and `credentials`)
  become `[redacted]`, sensitive query parameters are stripped from request
  paths, and every string is scrubbed of known shapes — `Bearer …`, `sk-…`,
  JWTs, connection strings with credentials, PEM private keys, `password=…`.
  Errors are serialized with their message, stack and cause redacted too. A
  string longer than 4 KiB is replaced whole with `[truncated]` rather than
  scanned: a validation error carries its input as the error's cause, and
  logging an unbounded caller-supplied value would make the scanner the target.
- **Opting out is review-visible.** Keeping one of those fields requires
  `unredacted(value)` at the exact call site. Grep for `unredacted(` to see
  every place a secret is deliberately allowed into a log.

`packages/logging` has no workspace imports and no dependencies; it is a leaf
like `packages/core`, so every package can log without a cycle.

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
  Workers heartbeat every minute and write a two-minute TTL: the extra minute is
  explicit grace for ordinary clock drift and a brief host suspend. Missing two
  heartbeats therefore makes the run reclaimable without letting a stale owner
  renew or publish another checkpoint.
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
