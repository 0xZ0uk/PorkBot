# AGENTS.md

PorkBot is built by agents as much as by people. This file is the contract: the
rules below are the ones the code holds itself to, and every rule names the
mechanism that checks it. A rule with no check is a wish, so
`packages/eslint-config/test/agents-rules.test.mjs` fails when a rule loses its
`Checked by:` clause or cites a lint rule that no longer exists.

`README.md` describes what the workspace contains; this file is about how to
change it without breaking what the boundaries and the CI gate protect.

## Rules

### Module map

- **One map, fail-closed.** `packages/eslint-config/module-boundaries.js` is the
  single module map: it declares which workspace packages each package may
  import and which layer owns each restricted library. Adding an edge is a
  one-file, reviewable change, and a package missing from the map cannot import
  any workspace package. Checked by: lint (`no-restricted-imports`) and
  `packages/eslint-config/test/workspace.test.mjs`.
- **`@porkbot/core` is pure.** It imports no workspace package, no Node built-in
  outside tests, no framework and no database driver, and a test fails if it
  grows a runtime dependency. Checked by: lint (`no-restricted-imports` and the
  Node-built-in pattern) and `packages/eslint-config/test/boundaries.test.mjs`.
- **Vendor SDKs live in `@porkbot/adapters` only.** Every other package consumes
  interfaces from `@porkbot/adapter-kit`, and the orchestrator never names a
  vendor. Checked by: lint (`restrictedLibraries` in the module map).
- **`@porkbot/contracts` is the only source of transport types.** Input and
  output schemas live there and are consumed by the client through the router
  type; a hand-written duplicate at a boundary is a bug. Checked by: review.
- **Tests may import `@porkbot/testkit`; shipped code may not.** The map's
  `testImports` edge is enforced in both directions, so the harness is reachable
  from a spec and from `vitest.config.ts` but never from `src`. Checked by:
  lint, proven by `packages/eslint-config/fixtures/core-testkit-in-source.ts`.
- **Deep imports and inline type imports fail lint.** Import the package entry
  point rather than `@porkbot/*/src/**`, keep relative imports inside one
  package, and use a top-level `import type`. Checked by: lint
  (`@porkbot/*/**` pattern, `import-x/no-relative-packages` and
  `import-x/consistent-type-specifier-style`).

### Authorization

- **Every procedure goes through the gate.** `apps/api/src/gate.ts` is the only
  file in the API that calls `implement(...)`; routers register through the
  `authenticated` or `publicOnly` implementers it exports, so a procedure cannot
  be added on an un-authenticated path. Checked by: lint (`no-restricted-syntax`,
  proven by `packages/eslint-config/fixtures/api-raw-implement.ts`).
- **Authenticated by default; public is explicit.** A contract procedure is
  authenticated unless it is built with `publicProcedure`, every procedure
  carries an access marker, and the public paths are compared against the
  hand-written list in `packages/contracts/src/contract.ts`. Checked by: test
  (`packages/contracts/src/access.test.ts`) and review
  (`.github/pull_request_template.md`).
- **Handlers receive an actor, never a tenant id.** The procedure context
  carries the resolved `Actor` and actor-scoped repositories, a by-id fetch is
  the repository's scoped read, and no contract input names a space. Checked by:
  test (`apps/api/src/gate.test.ts`).
- **Every space-scoped row has a cross-space refusal.** The register in
  `packages/db/test/integration/authorization/matrix.ts` names each entity and
  the probes that exercise its real read and write seams; the spec beside it
  runs every probe against another space, asserts the shared `NOT_FOUND` with
  the foreign rows unchanged, and fails when a schema table is neither
  registered nor exempted with a reason. Checked by: test
  (`packages/db/test/integration/authorization/authorization-matrix.integration.test.ts`)
  and review.
- **One session read.** Sessions resolve to an `Actor` in `@porkbot/auth`, and
  the API calls that resolver in `apps/api/src/gate.ts` only. Checked by: test
  (`apps/api/src/gate.test.ts`).

### Effect services

- **Typed errors reach the boundary through one table.** A router throws a
  typed error and `apps/api/src/gate.ts` maps it with `mapError` from
  `@porkbot/effect`; no router inspects a raw error or a cause. The table is
  exhaustive over `TypedError`, an unmapped defect answers 500 from its default
  row, and the detailed value reaches only the API's redacted error line —
  never the client envelope. Checked by: test
  (`packages/effect/src/mapping.test.ts`, `apps/api/src/gate.test.ts`) and
  review.
- **Layer lifetimes are explicit.** A process-scoped service — a pool, an SDK
  client, configuration — is declared with `processTag` and only
  `processSingleton` may bless a boot-time layer, so a request-scoped
  repository cannot be baked into one. Anything data-touching is declared with
  `requestTag` and built with `requestScoped` inside the request or run scope,
  where its finalizer runs. Checked by: test
  (`packages/effect/src/lifetimes.test.ts`) and review.

### Provider neutrality

- **One interface per capability.** Declarations live in `@porkbot/adapter-kit`,
  implementations and offline emulators in `@porkbot/adapters`, and adding a
  provider is one adapter plus one registration line. An orchestration seam
  whose halves are Effect values — the duplex `RunSession` beside the service
  tags in `@porkbot/effect` — is declared where its Effect values and the core
  event vocabulary it carries can be named, since adapter-kit imports nothing
  outside its own modules. Checked by: lint (the provider SDK restriction) and
  review.
- **An interface with one implementation is a hypothesis.** Ship the second
  implementation or delete the interface; unused contracts are a liability, not
  a hedge. Every interface declared in `@porkbot/adapter-kit` names at least two
  planned implementations, each pinned to the roadmap slice that lands it, in
  `PROVIDER_INTERFACES` in `packages/adapter-kit/src/provider-plan.ts`, and each
  seam documents how its provider errors map onto the shared vocabulary.
  Checked by: `packages/adapter-kit/src/provider-plan.test.ts`.
- **Lifecycle code decides from the shared failure vocabulary.** A provider maps
  its own errors onto `ProviderFailure` (`gone`, `not_found`, `rate_limited`,
  `timed_out`, `auth_failed`) inside its adapter; retry, recovery, approval and
  state transitions branch on the kind. Inspecting a vendor error string or an
  SDK error class outside `@porkbot/adapters` is a review failure. Checked by:
  review and `packages/adapter-kit/src/provider-plan.test.ts`.
- **Every provider ships an offline emulator.** An adapter is tested against its
  emulator over the real wire protocol, with no network and no keys. Checked by:
  test (`@porkbot/adapters`) and review.
- **No provider- or model-specific environment variables.** Express the
  behaviour through the generic connection instead. Checked by: review.

### Data and migrations

- **Migrations are generated, reviewed and committed.** `pnpm db:generate` output
  is the migration; the unit suite regenerates from the schema into a scratch
  directory and fails when the committed set differs, and a hand-edit to
  generated SQL carries a `-- hand-edited:` comment saying why. Checked by: test
  (`packages/db/src/migrations/generate.test.ts`).
- **A destructive change is its own labelled migration.** Drops, truncates and
  column-type changes live in a `destructive_*` file with no additive
  statements beside them, so the change is one file a reviewer can reason
  about. Checked by: test (`packages/db/src/migrations/destructive.test.ts`).
- **Every table's primary key is a UUIDv7.** Tables take their id from
  `primaryKeyId()`, which defaults to Postgres 18's `uuidv7()`; a table that
  hand-rolls its key fails the schema suite. Checked by: test
  (`packages/db/src/schema/columns.test.ts`).
- **Every lookup foreign key is indexed.** An integration test reads
  `pg_catalog` for foreign keys whose referencing columns no index leads with
  and fails while it finds any, so the rule is a database answer rather than a
  convention. Checked by: test
  (`packages/db/test/integration/migrations.integration.test.ts`).
- **One module owns the memory rows.** `packages/db/src/memory-store.ts` is the
  only shipped code that reads or writes `memory_document` or `memory_revision`;
  the schema defines them and every other path goes through the `MemoryStore`
  seam in `@porkbot/effect`, so both are auditable in one place. Checked by:
  test (`packages/db/src/memory-store.call-sites.test.ts`).
- **One module owns the notification switches.** `packages/db/src/notification-store.ts`
  is the only shipped code that reads or writes `notification_preference`; the
  schema defines it and every other path goes through the
  `NotificationPreferences` and `NotificationRecipients` seams in
  `@porkbot/effect`, so the operator's own switches and the delivery path's
  space check are auditable in one place. Checked by: test
  (`packages/db/src/notification-store.call-sites.test.ts`).
- **One module owns the encrypted credential rows.** `packages/db/src/encrypted-credential-store.ts`
  is the only shipped code that reads or writes `encrypted_credential`; the
  schema defines it and every other path goes through the `Credentials` seam in
  `@porkbot/effect`, so the ciphertext, its key id and the rotation pass are
  auditable in one place. Checked by: test
  (`packages/db/src/encrypted-credential-store.call-sites.test.ts`).
- **One module owns the bot secret rows.** `packages/db/src/bot-secret-store.ts`
  is the only shipped code that reads or writes `bot_secret`; the schema defines
  it and every other path goes through the `BotSecrets`, `BotSecretRequests` and
  `BotSecretResolver` seams in `@porkbot/effect`, so the ciphertext, its
  destination binding, the forget and the rotation pass are auditable in one
  place, and the run's half has no method that returns a value. Checked by: test
  (`packages/db/src/bot-secret-store.call-sites.test.ts`).
- **One module owns the MCP server rows.** `packages/db/src/mcp-store.ts` is the
  only shipped code that reads or writes `mcp_server`, `mcp_server_tool` or
  `bot_mcp_server`; the schema defines them and every other path goes through
  the `McpServers` and `McpRunServers` seams in `@porkbot/effect`, so install,
  discovery caching and the per-bot grants are auditable in one place.
  Checked by: test (`packages/db/src/mcp-store.call-sites.test.ts`).
- **One module owns the stored-file rows.** `packages/db/src/file-store.ts` is
  the only shipped code that reads or writes `message_attachment` or
  `run_artifact`; the schema defines them and every other path goes through the
  `FileStore` and `RunFileStore` seams, so an upload, a download, the
  materialization of a message's attachments and a tool's artifact record are
  auditable in one place. Checked by: test
  (`packages/db/src/file-store.call-sites.test.ts`).
- **One module owns the backup ledger.** `packages/db/src/backup-store.ts` is the
  only shipped code that reads or writes `backup_run`, `backup_canary` or
  `backup_alert`; the schema defines them and every other path goes through the
  ledger and status-reader factories, so a run's records, the drill's canary and
  the alert episodes are auditable in one place. Checked by: test
  (`packages/db/src/backup-store.call-sites.test.ts`).
- **One module owns run creation.** `packages/db/src/run-creation.ts` holds
  every run-creation command — message-triggered, routine-triggered and the
  operator's test run — and no other shipped code inserts a `task` or a `run`,
  so the scheduler is a producer that enqueues `run.execute` and never a second
  executor. Checked by: test
  (`packages/db/src/run-creation.call-sites.test.ts`) and review.
- **Compaction never touches the memory lane.** A compaction reads memory
  through the `MemoryReader` seam, carries the documents through by reference,
  and runs `assertMemoryPreserved` before the model is asked for a summary, so a
  compacted conversation can drop messages but never a durable document. Checked by:
  test (`packages/core/src/compaction-policy.test.ts`,
  `packages/adapters/src/two-lane-context.test.ts`) and review.

### Configuration

- **Every environment variable is declared in the schema that owns it.** Shared
  values live in the root `.env.schema`, a package's own values in its
  `.env.schema`, and the `env` CI tier runs `varlock audit` so a key the code
  reads but the schema does not declare — or a declared key no code reads —
  fails by name. Secret values come from the deployment environment or a
  device-local encrypted `.env.local`, never from a committed file. Checked by:
  the `env` CI tier (`scripts/env-check.mjs`) and review.

### Documentation

- **The operator docs are checked, not trusted.** Every `PORKBOT_*` or
  `TESTKIT_*` name in the repository's markdown (the root files and
  `docs/**/*.md`) is declared in a `.env.schema`, in
  `deploy/porkbot.env.example` or in the check's override and runtime
  registers; every schema and template variable appears in `docs/environment.md`
  with a default and a required/optional answer; and every relative link,
  backticked `docs/*.md` reference and heading anchor resolves. Checked by: the
  `docs` CI tier (`packages/testkit/src/docs/cli.ts`) and
  `packages/testkit/test/docs.test.ts`.

### Secrets and public-safe text

- **Never commit a secret.** No `.env` files, keys, tokens, private URLs or real
  personal data; use fake placeholders, never force-add an ignored file, and
  inspect `git status` and the staged diff before committing. Checked by: review
  (`.gitignore` supplies the backstop).
- **Secret material never reaches a log, an error, a list response or a
  sandbox.** The redaction helper is wired into request and error logging rather
  than left unused, and logging `key`, `token`, `secret` or `password` fields
  needs an explicit opt-in that a reviewer can see. Checked by: test
  (`@porkbot/logging` redaction suite,
  `packages/db/src/encrypted-credential-store.test.ts`,
  `apps/api/src/routers/credentials.test.ts`) and review.
- **A notification carries three fields and nothing else.** A provider request
  body is built from an allowlist of the title, the body and the link — never
  spread from the caller's object — so a credential or a raw tool argument
  cannot ride along to a third party, and the notification conformance suite
  proves a smuggled field never reaches a destination. Checked by: test
  (`packages/adapters/src/notification-emulator.test.ts`,
  `packages/adapters/src/http-notification.test.ts`) and review.
- **Public-safe prose.** Commits, PR descriptions, issues and review replies
  must not identify a person, machine, account or key: no local paths,
  usernames, hostnames, emails, tenant ids or key ids. Describe test results in
  words, never as pasted tool output. Checked by: review.

### Public posture

- **A public-launch promise is a file with a check.** `LICENSE` and the root
  manifest agree on MIT, `CONTRIBUTING.md`, `SECURITY.md` and
  `CODE_OF_CONDUCT.md` exist with their required content, the bug and feature
  issue forms render, and the pull-request template keeps its Why, What,
  Dependencies and How tested sections. Checked by: the `posture` CI tier
  (`packages/testkit/src/posture/files.ts`) and
  `packages/testkit/test/posture.test.ts`.
- **The published history carries no secret and no personal data.** Every
  reachable commit identity, commit message and text blob is scanned for
  provider-shaped secrets, addresses outside the reserved example domains and
  personal home paths; a finding is a red `posture` check. Checked by: the
  `posture` CI tier (`packages/testkit/src/posture/history.ts`) and
  `packages/testkit/test/posture.test.ts`.
- **A fixture that must look like a credential is assembled at run time.** The
  redaction and SigV4 suites build the token, key and PEM shapes from parts, so
  no committed blob matches a provider pattern; the `posture` audit, GitHub's
  secret scanning and push protection all see nothing to flag, and the test
  still exercises the real shape. Checked by: the `posture` CI tier and
  `packages/logging/src/redact.test.ts`.
- **The GitHub-side switches are scripted, not remembered.**
  `scripts/setup-branch-protection.sh` applies the tier names as required
  checks, `scripts/setup-repo-security.sh` enables secret scanning, push
  protection and private vulnerability reporting, and
  `scripts/verify-push-protection.sh` passes only when GitHub refuses a pushed
  canary. Checked by: `scripts/verify-push-protection.sh` and review.

### Network egress

- **Every fetch of a user-supplied URL goes through `@porkbot/effect`'s
  URL-safety module.** An MCP server, an OpenAPI document, a model endpoint and
  a web fetch all call `safeFetch`, which enforces HTTPS, refuses embedded
  credentials, and checks the address on the connection rather than on the
  string, so a hostname that rebinds from public to private is refused on the
  socket. Checked by: test
  (`packages/effect/src/url-safety.call-sites.test.ts`) and review.
- **The blocked ranges are one list.** Private, loopback, link-local, metadata,
  multicast and reserved ranges live in `BLOCKED_ADDRESS_RULES`; a second place
  that decides "private" is the bug the list exists to prevent. Checked by: test
  (`packages/effect/src/url-safety.test.ts`) and review.

### Untrusted content

- **Ingested content is labelled at the boundary.** A module that receives a
  web page, a file, an email body or a tool result calls
  `labelUntrustedContent` from `@porkbot/core` before anything downstream sees
  it; the path must be one of `INGESTION_PATHS`, and a new path joins that
  register with its boundary rule and its fixtures before it can carry a label.
  Checked by: test (`packages/core/src/ingestion.call-sites.test.ts`,
  `packages/adapters/src/ingestion-fixtures.test.ts`).
- **External content is data, never instruction.** `composeRunPrompt` renders
  ingested content in the prompt's `data` channel under the data notice, a tool
  result carries its label to the model, and the web tools' own descriptions
  say the content is untrusted. Checked by: test
  (`packages/core/src/ingestion.test.ts`, `packages/core/src/run-context.test.ts`,
  `packages/effect/src/web-tools.test.ts`).
- **Egress is allowlisted per run and gated.** `decideEgress` in `@porkbot/core`
  decides allowed, needs-approval or refused on the host alone; a tool opens the
  run's durable approval gate for any host outside the list before a request is
  made. Checked by: test (`packages/core/src/egress-policy.test.ts`,
  `packages/effect/src/danger-guard.test.ts`) and review.
- **"Dangerous" is one register, and the gate fires from it.**
  `DANGEROUS_ACTION_CLASSES` in `packages/core/src/dangerous-actions.ts` is the
  whole definition — credential-store access, a request to use a stored bot
  secret, a write outside the bot's home, egress to a host outside the run's
  allowlist, and any send or delete — and a tool whose target the arguments name
  consults it before it acts, opening the run's durable approval gate for a
  flagged call and refusing one when no gate is configured. `shell` is
  deliberately outside the register: a command string names no single class, and
  the sandbox is its boundary. Checked by: test
  (`packages/core/src/dangerous-actions.test.ts`,
  `packages/effect/src/danger-guard.test.ts`) and review.
- **Hostile fixtures ship with the path they attack.** The injection fixtures
  for E10.4 live in `packages/adapters/src/ingestion-fixtures.ts`, one per
  registered path, with a marker a pass must never observe. Checked by: test
  (`packages/adapters/src/ingestion-fixtures.test.ts`).

### Transport limits

- **Every route is limited, and an unknown one is not unlimited.** The policy
  register and the accounting in `apps/api/src/limits.ts` are the only place a
  request budget, a body cap or a stream slot is decided; a path the register
  does not name draws the anonymous budget, and a test walks the contract tree
  and the route list so a new procedure or route fails until it is covered.
  Checked by: test (`apps/api/src/limits-surface.test.ts`) and review.
- **A refusal is typed and retryable.** An RPC caller sees the contract's
  `RATE_LIMITED` with `retryAfterSeconds` and a `Retry-After` header, never an
  opaque 500 or an unlimited retry loop. Checked by: test
  (`apps/api/src/limits-surface.test.ts`) and review.
- **A body cap rejects before parsing, and a stream holds a slot until it
  closes.** An oversized payload is refused from its length or while streaming,
  and every `text/event-stream` response holds a per-principal slot that a
  close, an error or a client disconnect releases. Checked by: test
  (`apps/api/src/limits-surface.test.ts`) and review.

### Streaming

- **A subscription resumes from a signed cursor, never a guess.** Every SSE
  frame's id is an HMAC-signed position bound to the actor, the space and the
  thread; `Last-Event-ID` is the only resume channel; a malformed, forged or
  foreign cursor is the contract's typed `BAD_REQUEST`, and a cursor that names
  another thread or space is refused rather than replayed. Checked by: test
  (`apps/api/src/stream.test.ts`, `apps/api/src/cursors.test.ts`) and review.
- **Access is re-resolved on every subscribe, resume and frame.** The gate reads
  the session per request; the subscription service re-resolves the thread on
  every subscribe and resume and re-reads the membership before every frame,
  all inside the actor's scope, so a revoked membership cannot resume a live
  stream — it ends one that is already open before another event is delivered.
  Checked by: test (`apps/api/src/stream.test.ts`) and review.
- **Durable events are the stream; a fanout signal is only a wake-up.** A
  subscriber replays `seq > cursor` from the actor-scoped repository after
  every signal, so a lost signal costs latency and a duplicate costs a query —
  never a missed or repeated event. Checked by: test
  (`apps/api/src/stream.test.ts`, `packages/adapters/src/realtime.test.ts`) and
  review.

### UI

- **Colours come from `@porkbot/tokens`.** No hardcoded hex, `rgb()`, `hsl()`
  or `oklch()` colour in a surface; use the semantic tokens so a theme change
  stays one file.
  Checked by: lint (`no-restricted-syntax` colour selector, proven by
  `packages/eslint-config/fixtures/ui-hardcoded-color.ts`).
- **A screen composes the register.** `packages/eslint-config/ui-register.js`
  names the markup each primitive in `@porkbot/ui` owns — the `button`, `input`,
  `select` and `textarea` elements, the `card` and `field` chrome classes, and
  the register's own `pb-` class namespace — and a surface may write none of it.
  A screen that hand-rolls a primitive fails lint, and the register's component
  names are tied to the package's exports so the map cannot drift from the
  package. Checked by: lint (`no-restricted-syntax`, proven by
  `packages/eslint-config/fixtures/ui-hand-rolled-button.tsx`,
  `packages/eslint-config/fixtures/ui-hand-rolled-field.tsx`,
  `packages/eslint-config/fixtures/ui-hand-rolled-card.tsx` and
  `packages/eslint-config/fixtures/ui-register-namespace.tsx`) and
  `packages/eslint-config/test/ui-register.test.mjs`.
- **Reuse the design system before writing chrome.** Prefer an existing
  `@porkbot/ui` component and a shared primitive over a local copy. Checked by:
  review.
- **Frontends express intent; the backend owns orchestration.** Authorization,
  validation, retries, recovery, provider translation and state transitions stay
  server-side, and the client renders state and sends intent. Checked by:
  review and the module map.
- **Keep UI and copy minimal.** Ask what can be removed, prefer progressive
  disclosure over persistent explanation or status chrome, and quote any new
  user-facing copy in the PR with why it is necessary. Checked by: review.

### Desktop

- **The desktop window is hardened once, and the source is checked.** Every
  window is built through `hardenWebPreferences` and asserted by `assertHardened`
  in `apps/desktop/src/hardening.ts`; the flags, the nonce-based content
  security policy, the single-function preload bridge and the preload channel
  literal are asserted by a test that walks the shipped tree, so a window that
  relaxes a flag fails CI rather than review. Checked by: test
  (`apps/desktop/src/hardening.test.ts`).
- **An update is verified before it is written.** The feed's manifest must carry
  a signature that verifies against the pinned key and the artifact's bytes must
  hash to the signed digest; `apps/desktop/src/update-controller.ts` is the only
  code that fetches or stages an update, and a build with no feed configured
  checks nothing. Checked by: test
  (`apps/desktop/src/update-controller.test.ts`, `apps/desktop/src/updates.test.ts`).
- **The desktop re-implements no screen.** It packages `apps/web/dist/client`,
  serves it through `@porkbot/web`'s static handler beside the API proxy, and
  the renderer forwards run lifecycle frames it already reduced rather than
  parsing the stream a second time. Checked by: review and
  `apps/desktop/src/proxy.test.ts`.

### Releases

- **An artifact names its version, platform and commit, and its digest is
  signed.** `packages/testkit/src/release/cli.ts` is the whole pipeline; the
  name carries the commit, `build-manifest.json` records the full commit and
  every digest, and `sign` writes the Ed25519 manifest the app trusts. Checked by:
  test (`packages/testkit/test/release-artifact.test.ts`,
  `packages/testkit/test/release-signing.test.ts`) and review.
- **The release and the app agree on the bytes that are signed.** The canonical
  payload is one contract with two implementations, and the desktop's suite
  signs with the release helper and verifies through the app's own code, so a
  drift fails CI rather than shipping an update every client refuses. Checked by:
  test (`apps/desktop/src/release-contract.test.ts`).
- **A release is built and published from CI, and never overwritten.**
  `.github/workflows/release.yml` packages every platform, verifies its own
  signatures, and refuses a tag or release that already exists; the `desktop`
  CI tier runs the same packaging and smoke path on every pull request, so the
  pipeline is proven before it is trusted. Checked by: the `desktop` CI tier
  (`packages/testkit/src/release/cli.ts`) and review.

### Dependencies

- **Version choices live in `dependencies.json`.** The register is the only
  place a pinned version or image digest is chosen, and every entry states why
  it is pinned, so adding a pin is a one-file, reviewable change. Checked by:
  the `dependencies` CI tier and `packages/testkit/test/dependencies.test.ts`.
- **A pinned dependency is exact, declared and resolved.** A pinned package is
  declared in exactly the version the register names and the lockfile resolves
  that version with an integrity hash; drift in any of the three fails.
  Checked by: test (`packages/testkit/test/dependencies.test.ts`).
- **Container images are pinned by digest.** Every `FROM` in a Dockerfile,
  `image:` in Compose and `docker pull` in a workflow names a digest registered
  in `dependencies.json`; `:latest` is rejected even with a digest. Checked by:
  the `dependencies` CI tier and the test above.
- **Lockfile changes are surfaced on the pull request.** The `dependencies` job
  writes the lockfile delta against the base branch to the job summary, so a
  dependency change is reviewed as a diff instead of discovered in a blob.
  Checked by: `.github/workflows/ci.yml` (the `dependencies` job).
- **A dependency is added with a reason.** Every added, removed or upgraded
  dependency is named in the pull request's Dependencies section with why it is
  needed. Checked by: review and `.github/pull_request_template.md`.

### Deployment

- **One env file, generated secrets.** `deploy/.env` is the deployment's only
  environment file; `pnpm deploy:setup` renders it from
  `deploy/porkbot.env.example` and generates every secret from the register in
  `packages/testkit/src/deployment/secrets.ts`, so no key is hand-invented, and
  re-running setup keeps a live deployment's existing values instead of
  re-keying it. Checked by: test
  (`packages/testkit/test/deployment.test.ts`) and review.
- **The template, the required set and the compose file are one fact.** Every
  value `deploy/compose.yaml` refuses to default (`${NAME:?}`) has a generated
  or operator plan in the register and a sentinel in the template, and every
  value in the template is referenced by the compose file; a pulled image in
  the deployment names a digest registered in `dependencies.json`. Checked by:
  test (`packages/testkit/test/deployment.test.ts`) and the `dependencies` CI
  tier.
- **The stack's ceilings plus one bot fit the documented floor.** The
  per-service CPU and memory limits and the per-bot settings stay inside the
  README's single-host floor (4 vCPU / 8 GB, with the memory term scaling by
  the bots active at once and the disk term by every configured bot); raising
  either is a host change a reviewer can see. Checked by: test
  (`packages/testkit/test/deployment.test.ts`) and review.
- **The backup target and its key envelope are separate.** The sealed envelope
  defaults to its own directory and its own volume, never a path under the
  backup destination, so the ciphertext and the key that opens it do not share
  a store. Checked by: test (`apps/backup/src/config.test.ts`) and review.
- **A destructive command says so.** `pnpm deploy:down` keeps the volumes
  unless `--volumes` is passed, and `--volumes` announces what it deletes
  before it deletes it. Checked by: test
  (`packages/testkit/test/deployment.test.ts`).

### Canaries

- **The canary claims only its own machines.** A sweep selects machines whose
  bot id is the canary's, so it can never destroy a user's computer, and a
  run's teardown is verified (`gone` and absent from `list`) rather than
  assumed. Checked by: test (`packages/canary/src/canary-runner.test.ts`) and
  review.
- **A billable canary runs only inside a stated budget.** A billable provider
  kind does not run until a monthly budget and a per-minute rate are stated;
  the per-run ceiling is the month divided across the nightly runs, a run past
  it is aborted and torn down, and a missing budget is a visible skip rather
  than a default. Checked by: test (`packages/canary/src/canary-policy.test.ts`)
  and review.

### Pull requests

- **Why, What, How tested — in words.** Use
  `.github/pull_request_template.md`; describe outcomes and evidence rather than
  pasting tool output. Checked by: review and the completion gate below.
- **One task per branch, never on `main`.** Build in an isolated worktree
  branched from `origin/main`; never reuse another task's branch or worktree.
  Checked by: review.
- **Stay with the PR until CI and review bots on the head SHA are terminal.**
  Follow `.agents/skills/pr-watch/SKILL.md`; a passing check is not a finished
  review, and a verdict is only good for the commit it was taken on. Checked by:
  the skill's completion gate.
- **Never rerun a failing job before the failure is shown unrelated.** The
  helper refuses the rerun unless the job proves an infrastructure failure or a
  recorded base-revision reproduction is attached. Checked by:
  `packages/testkit/src/pr-watch/cli.ts` (`--rerun`) and its tests.
- **Never merge with a pending review or an unresolved finding.** Ask the helper
  first: `--merge-check` refuses anything but green. Checked by:
  `packages/testkit/src/pr-watch/cli.ts` (`--merge-check`) and its tests.
