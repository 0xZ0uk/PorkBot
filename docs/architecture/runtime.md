# Runtime and jobs

## Run session seam

Steering and approval are writes into a live run, not reads of one, so the run
interface is duplex. `AgentRuntime` — declared in `packages/effect`, because both
halves are Effect values and the event vocabulary is `packages/core`'s
`RunEvent` — exposes a `RunSession` with an `events: Stream<RunEvent>` half and a
`commands: Mailbox<Steer | Stop | Approve | Deny>` half. The layer that provides
it is run-scoped (`requestTag` + `requestScoped`, PRD decision 27), so a session
cannot outlive its run, and it holds no database handle.

`LiveRuns` is the process's registry of live sessions: `dispatch` writes a
command into the run's mailbox, or answers the typed `RunGoneError` for a run
this process does not hold — never a hang, never a silent drop. Losing the fence
is interruption: `fenced` races the run against the worker's fence-loss signal,
so the whole run fiber tree stops, and the adapter cancels in-flight work and
reports a terminal `run.cancelled` instead of completing a tool call that would
commit after the lease moved.

The runtime emulator (`emulatorAgentRuntimeLayer`) in `packages/adapters` is the
offline implementation: deterministic scripts over mailboxes, no keys, no
network and no clock, driving the shipped seam end to end in that package's
suite. The Pi adapter (`piAgentRuntimeLayer`) is the second implementation: it
consumes Pi's async iterator of canonical events and exposes the same seam,
mapping every event through one explicit table (`PI_EVENT_MAPPING`) and refusing
an unknown event, field or nested update with a typed error. Its golden corpus
in `packages/adapters/src/pi-corpus` replays sessions recorded from the pinned Pi
version and asserts the reduced snapshot, and the suite refuses the corpus when
the pin moves without it being re-recorded. The orchestrator names no
implementation.

## Tool dispatch

The list the model sees and the code that runs a tool cannot drift: a tool is
one `ToolRegistration` — name, description, JSON Schema, a duration budget and
the handler — and `createToolDispatcher` in `packages/effect` generates the
model-facing metadata from the same values `execute` dispatches. An unknown
name is the typed `UnknownToolError` the runtime reports back to the model,
never a silent no-op.

Every call carries the model's durable `callId` as its non-null idempotency
key. The dispatcher claims it in a `ToolCallLedger` before the side effect and
settles it after, so a retry replays the stored outcome; an id already in
flight, or reused for a different request, is a typed conflict, and a call
without an id is refused before any effect. `packages/db` implements the ledger
over the `external_effect` unique index, so the claim is atomic in Postgres and
a retry after a worker restart still replays.

Before the handler runs, the dispatcher awaits the run's fenced heartbeat, and
it refuses a registration whose declared duration outlives the run lease TTL: a
side effect that can outlive its lease can commit under another owner. The
declared duration is also the hard budget — a handler that overruns it is
interrupted and reported as a failed call.

## Tool-call lifecycle

A tool call is visible from requested to completed or failed, with arguments,
result summary and timing, and the timeline survives a reload.
`createRunEventRecorder` in `packages/effect` is the one transform every
consumer runs a session's events through — the durable row, the live frame and
a replayed one — so all three are the same bytes. The recorder redacts
secret-shaped arguments with the logging helper, replaces a result past the
inline budget with a bounded preview plus a `resultArtifact` pointer to the
call's `external_effect` row, and stamps the settled call with its wall-clock
`durationMs`; the artifact is never dropped silently.

`RunEventSink` is the write half. `createRunEventSink` in `packages/db`
appends the recorded event to the `event` table in one scoped statement that
advances the thread's `next_event_seq` counter with the row, so
`(thread_id, seq)` stays contiguous and a reconnecting subscriber replays
exactly what the run emitted. Reducing the replayed stream equals reducing the
live one, and the ledger stores a redacted request, so a retry with the same
secret-shaped arguments still replays while the secret never reaches the
durable audit row. The unit suites prove the recorder over a manual clock and
the sink over a recording fake; the `packages/db` integration suite drives both
on Postgres, reads the rows back through the actor-scoped repository, and
resolves the artifact to the full result.

## Approval gates

Approval is durable pending state, not a live socket (PRD decision 13). A gated
tool call has a durable `callId`, and `createApprovalGate` in `packages/effect`
records a row for it before the run waits: the gate opens (or reopens, on the
original deadline) the `approval` row, and `waitFor` polls it until an operator
decision or the deadline settles it. Polling is the wake-up on purpose — a
decision taken in another process is visible on the next read, so there is no
signal to lose and the interval is a latency knob, not a correctness one.

The deadline is the store's, not the waiter's. `resolveTimeout` is a guarded
compare-and-set on `status = 'pending'` with `expires_at <= now()` as the
server's clock, so a timeout can never fire early; when it wins, the run answers
the typed `GateTimeoutError`, which is a deny — never a crash and never a hang.
A store that cannot record the gate fails closed with `ApprovalStoreError`
instead of running a tool behind an approval nobody can see.

Decisions are durable too. `packages/db` implements the seam over the `approval`
table keyed by `(run_id, call_id)`, with `createApprovalStore` split by actor:
a job opens gates and settles deadlines, an operator votes and reads the
timeline, and the grants in `0008_approval_grants.sql` are column-level so a job
cannot vote in a user's name and the API cannot move a deadline. A vote and a
timeout are both compare-and-sets, so concurrent approve/deny resolves exactly
once and the loser answers from the stored row. The resolution check makes the
audit structural: an approved or denied row always carries the deciding user and
the instant, and a `timed_out` row carries the instant with no user at all.

The wire vocabulary carries the gate to the client: `approval.requested` names
the call and its deadline, `approval.resolved` carries `approved`, `denied` or
`timed_out`, and the shared reducer attaches the gate to the tool call it
belongs to — so the same event list always renders the same gate. A reloading
client reads the durable rows through `listForRun` and replays the recorded
stream from the `event` table, so the gate it sees is the one the run recorded,
not the one a connection happened to hold.

## Fenced runs, reclaim and resume

A run is executed inside `withRunFence` in `packages/effect`: it heartbeats on
the shared interval, and the first beat that cannot be renewed — a typed
`LeaseLostError`, or any failure at all, because work that cannot be renewed
cannot be committed — completes a fence-loss signal that interrupts the run's
whole fiber tree. The adapter inside cancels and reports; it never finishes a
tool call and commits a side effect the next owner already owns. The worker's
execution harness (`apps/worker/src/run-execution.ts`) wraps that fence around
the run's work and settles the run and its attempt in one fenced statement:
`completed` on success, `failed` with the work's message on failure, and on a
lost lease no run write at all — only the best-effort closing of its own attempt
as `abandoned`.

Recovery is a reclaim, never a restart. A `run.watchdog` job scheduled every
minute scans `findExpiredLeases` — the one deliberate cross-space read in the
database package, addressing only — re-reads each candidate through a
`SystemActor` for its space, and reclaims it with the same CAS every other
reclaimer uses, so two watchdogs produce one winner. The reclaim is one
statement that moves the fence, closes the superseded attempt as `abandoned`
with the reason, and settles every tool-call row the old owner left `pending` or
`running` as `failed` with the same reason. A run whose stored checkpoint carries
session state is handed off to a fresh `run.execute` delivery, which adopts the
live lease by the exact `(fence, owner)` pair the watchdog held; a run that
stopped before its first checkpoint is failed with a typed reason
(`checkpoint_absent`, `checkpoint_unreadable`) from `@porkbot/core`'s
`decideReclaim`, never silently restarted. The resume therefore sees
`resumed: true`, its checkpoint, and replayed tool-call outcomes instead of a
second side effect.

The same pass sweeps the computer lease (slice 7.4). `findExpiredComputerLeases`
is the second deliberate cross-space read, and each expired row is deleted
through the `SystemActor` its space names, so a machine whose holder stopped
renewing — a crashed worker, a run whose fence moved, a holder that stopped
between commands — is free for the next run instead of blocked until someone
notices. The sweep runs on every pass, including one that finds no expired run
lease, because a stale computer is stale on its own.

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
`RunExecutor` seam in 6.2; the routine tick (8.4) enqueues `run.execute` for a
scheduled slot, and the message path (6.5) creates its run `queued` through the
same run-creation command. Delivering message-triggered runs to the queue is a
producer step the run-runtime slices add beside the API's own database role,
which today cannot write the worker's queue schema.

The worker connects with its own database role. `packages/db/migrations/0004_database_roles.sql`
creates `porkbot_api` and `porkbot_worker` and grants each only its own work:
the API writes the application schema and cannot read the queue, and the worker
reads the run state it executes, creates the run one scheduled routine slot
produced (8.4) and owns the `graphile_worker` schema. `packages/db/test/integration/roles.integration.test.ts`
asks the database for that division and then really performs both denied
operations, and `apps/worker/test/integration/worker.integration.test.ts`
delivers real jobs through a real queue. `pnpm db:migrate` creates the roles and
sets their passwords from `PORKBOT_API_DB_PASSWORD` and
`PORKBOT_WORKER_DB_PASSWORD`; the local stack's `migrate` service runs the same
command before the api and the worker start.

## Routines

A routine is a first-class row (PRD decision 22, slice 8.4): an owner, a bot, an
instruction, an IANA timezone and a five-field cron expression, plus the
`next_run_at` instant the scheduler is waiting on.
`packages/db/src/schema/routines.ts` defines it beside `routine_occurrence`, the
ledger of settled slots: an occurrence with a `run_id` is a fire whose outcome
is the run's own status, and an occurrence with a null `run_id` is a missed
schedule. That shape is what makes a missed slot a row a client can render
instead of an inference from a gap in timestamps, and it keeps one authority —
the run — for how a fire ended.

The grammar and the DST rules live in `@porkbot/core`'s `routine-schedule.ts`,
which is pure and clock-injected. `nextRoutineFire` treats the wall clock as the
schedule's clock in the routine's zone: a nonexistent spring-forward time fires
once at the transition instant, an ambiguous fall-back time fires once on its
first occurrence, and the day-of-month and day-of-week fields combine with OR.
`decideRoutineDue` is the scheduler's rule: a slot up to five minutes late still
runs, and a slot older than that is recorded missed with the schedule jumping to
the next future fire — a downtime is visible, never replayed as a burst.

`apps/worker/src/jobs/routine-schedule.ts` is the minute tick. It scans due rows
across spaces (address-only, like the lease watchdog), derives a `SystemActor`
for each row's space, and settles at most one slot: a fire calls the same
run-creation command the message path uses and enqueues `run.execute`, so a
scheduled run is an ordinary run under the same lease, heartbeat and watchdog; a
miss writes the ledger row and advances the cursor. Both commands lock the
routine row and dedupe the slot on `(routine_id, scheduled_for)`, and the run's
client nonce is derived from the same pair, so a retried tick is answered by the
row. Every tick also re-addresses routine runs that sat queued and unowned past
the dispatch grace, so an enqueue that died with the process cannot strand a
scheduled run silently.

Disabling stops future runs because the scan and the locked re-read both filter
`enabled`; deleting is a tombstone (`deleted_at`), so the routine's thread, runs
and ledger survive while every operator read treats it as gone. The worker's
role gains exactly what the scheduler needs in
`packages/db/migrations/0012_routine_grants.sql`: SELECT on `routine` and UPDATE
on its cursor columns only — a job cannot rewrite an instruction or a cron
expression — plus INSERT on the ledger, `task` and `run`.

The operator's half of the same rows is the routines contract (slice 8.5):
`routines.list`, `routines.create`, `routines.update`, `routines.remove`,
`routines.preview`, `routines.testRun` and `routines.outcomes`.
`preview` answers the next fire times from the database's clock before a row
exists, so a schedule mistake is visible in the editor rather than after a
saved routine; `testRun` fires the instruction once outside the schedule — an
ordinary queued run in the routine's thread, deduped by the caller's nonce,
with no occurrence and no cursor move — and `outcomes` is the ledger with each
slot's result and its run link. A malformed cron, an unknown IANA zone and an
unreachable expression are the typed `InvalidRoutineScheduleError`, which the
API boundary maps to the contract's `BAD_REQUEST` rather than a 500. The
routine editor screen itself waits for the console surfaces (slice 11.2), which
land on the web shell's routing and session.
