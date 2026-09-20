# Scheduled live-provider canaries and topology runs (slice 12.6)

PRD testing decisions: "live-provider checks are scheduled, not manual". The
acceptance criteria this document supports:

- a nightly canary exercises boot → run → tool call → teardown on real Docker
  and the real cloud provider;
- failures notify through the E8 notification path with a link to logs;
- a canary failure does not block merges but is visible and has an owner;
- the cloud canary has a stated budget and tears down everything it creates;
- orphaned resources are detected and cleaned up automatically.

The canary is the one check that leaves the emulators. Every other tier proves
the product with no daemon, no key and no network; this one boots a real
machine on the provider a self-hoster runs, executes a real command on it, and
destroys it — on a schedule, so nobody has to remember to dispatch it.

## What runs

`packages/canary` is the runner and the CLI. The nightly workflow
(`.github/workflows/canary.yml`) runs the same CLI against a supervisor started
from source with the provider under test:

| Job               | Provider                  | Where it comes from                                      |
| ----------------- | ------------------------- | -------------------------------------------------------- |
| `canary (docker)` | Real Docker on the runner | the node image digest in `dependencies.json`             |
| `canary (cloud)`  | The real cloud provider   | `PORKBOT_CANARY_CLOUD_*` repository variables and secret |

Each run drives the supervisor's HTTP surface — the process self-hosters run —
with the client half of the provider seam (`createSupervisorComputerProvider`),
so the canary proves the deployed boundary and not only an in-process adapter.
A **topology run** is the same canary across the deployment's provider
topology: one run per configured kind. The CLI accepts `--kind` repeatedly to
run several kinds in one invocation.

## The steps

One run reports every step with its duration, and a report is JSON on stdout
and in the file `--report` names:

1. **sweep** — list what the provider still holds and destroy every machine
   carrying the canary bot id. A machine the canary bot owns has no user behind
   it, so this is the whole definition of "orphaned" the sweep needs.
2. **boot** — `ensure` a machine with a fresh run id and assert it reports
   `running`.
3. **run** — execute a command that writes the run's token into the machine's
   home (`/home/agent` by default; `--workdir` overrides).
4. **tool_call** — execute the read-back command the `file_read`/`shell` tools
   transport, and compare the bytes. This is the tool-call round trip over the
   same seam the fenced command runner uses.
5. **teardown** — `destroy`, then assert `status` is `gone` and the provider no
   longer lists the machine. `teardownVerified` is the report's own claim, not
   an assumption.

Teardown runs on every path, including a failed step and a run that outlives
its ceiling. A failure is a report and a notification, never a thrown stack:
the report carries the step, the shared failure vocabulary's kind (`gone`,
`not_found`, `rate_limited`, `timed_out`, `auth_failed`) and the estimated
spend.

## Running it

Against any deployment's supervisor, with the same generic connection the API
uses:

```sh
PORKBOT_SUPERVISOR_URL=http://localhost:3003 \
PORKBOT_SUPERVISOR_TOKEN=... \
  pnpm canary:run --kind docker

# One topology run across every configured kind, with the failure notification:
PORKBOT_NOTIFICATION_WEBHOOK_URL=https://... \
PORKBOT_NOTIFICATION_WEBHOOK_KEY=... \
  pnpm canary:run --kind docker --kind daytona --notify-on-failure --logs-url https://...
```

`pnpm canary:sweep` destroys every canary machine the supervisor still holds;
`pnpm canary:notify --title ... --body ... --url ...` delivers one operator
notification through the E8 provider. The nightly workflow runs the sweep in an
`if: always()` step, so a night that crashed before teardown costs the next
night one cleanup instead of a growing bill.

## The cloud budget

A billable kind does not run until an operator states both numbers, and the
per-run ceiling is derived from them:

```
per-run ceiling = monthly budget / (rate per minute × 31 nights)
```

The CLI refuses a run whose derived ceiling is below a plausible one
(`budget_not_stated`, `rate_not_stated` or `budget_too_small` — reported as a
`skipped` run, not a failure), and it aborts a run that outlives its ceiling.
31 nights at the ceiling can therefore never spend more than the stated month.
The report records the estimated spend (`wall time × rate`), and the workflow
summary prints it.

Set `PORKBOT_CANARY_BUDGET_USD` and `PORKBOT_CANARY_USD_PER_MINUTE` as
repository variables to fund the cloud canary. Until then the cloud job prints
a skip warning and the Docker canary still runs. A skipped cloud canary is a
statement that the budget is missing, not a silent pass.

## Failures, visibility and ownership

The nightly workflow is not a required status check and has no gate job: a
provider outage is an operational fact, not a reason to block a merge. It is
visible two ways:

- the E8 notification path carries the failure — title, one paragraph and the
  run URL as the link to logs — when
  `PORKBOT_CANARY_WEBHOOK_URL`/`PORKBOT_CANARY_WEBHOOK_KEY` secrets are set;
  unset, the offline emulator holds the delivery and the CLI logs the failure
  at error level;
- the job opens or comments on an issue titled
  `Nightly live-provider canary failed: <job>`, assigned to
  `PORKBOT_CANARY_OWNER` (the repository owner by default).

The issue is the owner's queue; the run URL in it is the log. The job summary
carries the full JSON report, so the failing step and the shared failure kind
are readable without opening a log.

## What "orphaned" means

The provider seam's enumerable resource is a machine, and the sweep's claim is
the canary bot id, so a canary night cannot touch a user's machine. Destroying
a Docker machine also removes its per-computer isolation network, so a night of
canaries cannot exhaust the daemon's subnet pools — the destroy path is where
that leak lived, and it is fixed there rather than papered over by a sweep. A
Docker home volume is deliberately not swept: `destroy` keeps it by design (the
durable lane behind `stop`/`ensure`, `reset` and the backup snapshots), and the
backup retention policy owns what happens to it. A cloud sandbox is the
machine, so the sweep removes everything the cloud canary created.

## Where the pieces live

| Concern                                      | Module                                                        |
| -------------------------------------------- | ------------------------------------------------------------- |
| Budget, machine identity, sweep selection    | `packages/canary/src/policy.ts`                               |
| The run, teardown verification, notification | `packages/canary/src/runner.ts`                               |
| The E8 delivery target                       | `packages/canary/src/notify.ts`                               |
| The CLI (`run`, `sweep`, `notify`)           | `packages/canary/src/cli.ts`                                  |
| The nightly schedule and the owner issue     | `.github/workflows/canary.yml`                                |
| Real-Docker proof on every pull request      | `packages/canary/test/integration/canary.integration.test.ts` |
