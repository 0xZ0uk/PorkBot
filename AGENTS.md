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
- **One session read.** Sessions resolve to an `Actor` in `@porkbot/auth`, and
  the API calls that resolver in `apps/api/src/gate.ts` only. Checked by: test
  (`apps/api/src/gate.test.ts`).

### Provider neutrality

- **One interface per capability.** Declarations live in `@porkbot/adapter-kit`,
  implementations and offline emulators in `@porkbot/adapters`, and adding a
  provider is one adapter plus one registration line. Checked by: lint (the
  provider SDK restriction) and review.
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

### Secrets and public-safe text

- **Never commit a secret.** No `.env` files, keys, tokens, private URLs or real
  personal data; use fake placeholders, never force-add an ignored file, and
  inspect `git status` and the staged diff before committing. Checked by: review
  (`.gitignore` supplies the backstop).
- **Secret material never reaches a log, an error, a list response or a
  sandbox.** The redaction helper is wired into request and error logging rather
  than left unused, and logging `key`, `token`, `secret` or `password` fields
  needs an explicit opt-in that a reviewer can see. Checked by: test
  (`@porkbot/logging` redaction suite) and review.
- **Public-safe prose.** Commits, PR descriptions, issues and review replies
  must not identify a person, machine, account or key: no local paths,
  usernames, hostnames, emails, tenant ids or key ids. Describe test results in
  words, never as pasted tool output. Checked by: review.

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

### UI

- **Colours come from `@porkbot/tokens`.** No hardcoded hex, `rgb()` or `hsl()`
  colour in a surface; use the semantic tokens so a theme change stays one file.
  Checked by: lint (`no-restricted-syntax` colour selector, proven by
  `packages/eslint-config/fixtures/ui-hardcoded-color.ts`).
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
