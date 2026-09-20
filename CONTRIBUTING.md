# Contributing to PorkBot

Thanks for taking the time to contribute. PorkBot is a self-hosted product, and
the bar for a change is the same as the bar for the product: it works from a
clean checkout, it is covered by the tier that owns it, and the rules in
[AGENTS.md](AGENTS.md) still hold.

## Before you start

- **Read [AGENTS.md](AGENTS.md).** It is the contract this repository holds
  itself to — the module map, provider neutrality, secret handling, the UI rules
  and the pull-request requirements. Every rule names the check that enforces
  it, so a rule you break fails a test or a lint rather than a review.
- **Open an issue first for anything larger than a fix.** The backlog is
  organised as slices; a change that does not fit one is easier to agree on
  before it is written.
- **Report vulnerabilities privately.** See [SECURITY.md](SECURITY.md); never
  open a public issue for one.
- **Follow the [Code of Conduct](CODE_OF_CONDUCT.md).**

## Setting up

Node 24 and pnpm 10 are the pinned toolchain (`.nvmrc`, `package.json`):

```sh
corepack enable
pnpm install
pnpm build          # every later command reuses this output
```

## Running the checks

Run the tiers that cover your change before you open a pull request; the CI
tiers are the same commands.

| Command                 | What it proves                                                   |
| ----------------------- | ---------------------------------------------------------------- |
| `pnpm format:check`     | Prettier formatting                                              |
| `pnpm lint`             | ESLint, including the module-boundary rules                      |
| `pnpm typecheck`        | TypeScript in every package                                      |
| `pnpm test:coverage`    | Unit tests with coverage                                         |
| `pnpm test:integration` | Tests against a real Postgres (`pnpm stack:up` provides one)     |
| `pnpm test:e2e`         | Browser flows against the built output and offline emulators     |
| `pnpm posture:check`    | The public-posture audit: files, history, secrets, personal data |

`pnpm test:integration`, `pnpm test:e2e` and `pnpm stack:*` need Docker. Every
provider has an offline emulator, so no test needs an API key or network access.

## Opening a pull request

- Work in an isolated worktree branched from `origin/main`; one task per branch,
  never on `main`.
- Fill in [.github/pull_request_template.md](.github/pull_request_template.md):
  Why, What, Dependencies, How tested. Describe outcomes in words; do not paste
  tool output, logs or screenshots of a terminal.
- **Never commit a secret or personal data.** No `.env` files, keys, tokens,
  real hostnames, account ids or email addresses — in the diff, the commit
  messages or the pull request. Use obvious placeholders
  (`example.test`, `owner@example.invalid`). Inspect `git status` and the staged
  diff before you commit.
- **A new dependency needs a reason.** Versions are pinned in
  `dependencies.json`; name every added, removed or upgraded dependency in the
  pull request's Dependencies section and say why it is needed.
- Keep the pull request focused. A reviewer should be able to name the one thing
  it changes.

## Tests

- A bug fix comes with the test that fails without it.
- A new provider ships with its offline emulator (AGENTS.md, provider
  neutrality).
- Tier policy, timeouts, retries and the quarantine ledger live in
  `packages/testkit`; use them rather than a local copy.
- An integration test that needs the database clones a suite from the harness
  template (`pnpm testkit:start`, `pnpm testkit:migrate`), so it is fast enough
  to run beside its unit tests.

## License

By contributing you agree that your contribution is licensed under the
[MIT License](LICENSE).
