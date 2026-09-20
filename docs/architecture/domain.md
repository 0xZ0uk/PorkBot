# The domain

## Bots, sections and avatars

Slice 6.4 is the bot CRUD surface: `bots.list`, `get`, `create`, `update`,
`archive`, `restore` and `delete`, the avatar operations `bots.setAvatar`,
`bots.avatar` and `bots.clearAvatar`, and the section operations
`sections.list`, `create`, `update` and `delete`. Every one is an authenticated
contract procedure; the handler receives an actor-scoped repository, and the
input names a bot or a section, never a space.

- **Archiving is a reversible scope.** `archived_at` is a nullable instant and
  `bots.list` defaults to `active`; `archived` is the restore screen's scope and
  `all` asks for both. Archiving twice keeps the first instant, restoring clears
  it, and neither touches the bot's threads.
- **Deleting has one documented rule.** The row delete cascades to the bot's
  threads, tasks, runs and steering messages in a single statement; the avatar
  object is deleted through the storage seam, object first so a storage refusal
  leaves the bot intact and retryable; and the computer and home directory are
  deliberately retained until epic E7 owns their lifecycle. A deleted section,
  by contrast, never deletes bots — `bot.section_id` is `set null`, so they
  survive unfiled.
- **A create is idempotent on its spawn key.** `(space_id, spawn_key)` is a NOT
  NULL unique index and the insert replays the existing row, so a resubmitted
  create is one bot, not two.
- **A section is resolved inside the statement that writes it.** The create
  selects its section under the actor's space _and user_ — matching the
  schema's `(space, user, name)` unique index — and the update carries the same
  guard, so another user's section is a typed not-found with nothing written
  instead of an assignment the foreign key would happily accept.
- **Avatars live in one storage path.** The row keeps only a storage key,
  `avatars/<space>/<bot>`, and `apps/api/src/services/bots.ts` is the only code
  that turns it into bytes. Upload, read, clear and delete all call the same
  `StorageProvider` from `@porkbot/adapter-kit`, and the upload is bounded in
  the contract (512 KiB) before anything decodes. The API boots on the local
  provider (slice 7.7) rooted at the required `PORKBOT_STORAGE_DIR`, a named
  volume in the local stack; a deployment on the S3-compatible provider answers
  the same way because the key is the only thing the row carries.

## Threads and messages

Slice 6.5 is the conversation surface: `threads.create`, `threads.list`,
`threads.messages`, `threads.send` and `threads.clear`, every one authenticated
and every one naming a bot, a thread or a message, never a space. A thread
belongs to one bot; its transcript is the ordered `message` rows, and the run
events that stream to a subscriber are the durable `event` rows the resumable
stream already replays.

- **A send is idempotent on the client nonce.** `threads.send` takes the text
  and a non-empty `clientNonce`; `decideMessageSend` in `@porkbot/core` reads
  the nonce's earlier message and the thread's live run and returns what to do.
  A message that starts a run goes through `createRunAndTask` — the same single
  run-creation command the routine scheduler uses — and the run's
  `(space_id, client_nonce)` index replays the first result when two
  submissions race, so a retried send is one message and one run. The same
  nonce with different text is the typed `CONFLICT`, and a nonce already spent
  on another thread is refused by the send service rather than replayed, since
  the run's key is scoped to the space while a send's is scoped to its thread.
- **A send into a live run steers it.** When the thread has a non-terminal run,
  the message is written with its `steering_message` delivery row bound to that
  run in one transaction; no second run is created. Delivering and claiming
  that row is slice 6.7's half. `packages/db/src/messages.ts` is the one module
  that inserts a message row — the run-creation command, the steering command
  and the worker's assistant-message command all allocate their sequence and
  insert through it — which a call-site suite enforces.
- **Persistence never waits for a subscriber.** The user message commits with
  its run; an assistant message is appended through the message store by the
  run that produced it, with a nonce derived from the run so a retried append
  is a replay; and every run event is appended to the `event` table by
  `RunEventSink` as it is produced. A subscription replays those rows, so a
  closed tab costs the live frames, never the transcript.
- **Lists are keyset-paginated.** `threads.list` orders by
  `(updated_at desc, id desc)` and carries the ordering key of its last row as
  a typed cursor; `threads.messages` orders by the thread's contiguous `seq`
  and carries the next `afterSeq`. The service asks for one row past the page
  to decide whether a next page exists, so a "no more rows" answer is exact
  rather than inferred from a full page.
- **Clearing is an explicit, bounded act.** `threads.clear` deletes the
  thread's messages and events and resets both sequence counters in one
  transaction; the thread row, its runs and the bot's memory documents survive.
  "What did it learn" is not the transcript, and clearing a conversation never
  clears it.

## Files, attachments and artifacts

Slice 7.6 is the file surface (stories 32 and 33). One storage seam holds the
bytes, one module holds the rows that name them, and two routes move them:
`POST /threads/{threadId}/attachments` uploads a file for a message, and
`GET /files/{fileId}` downloads a stored file. Neither is an RPC procedure:
the body is the point, so the upload streams into the storage seam without
ever becoming JSON, and the download streams the object back. Both read the
session exactly once through the gate, and a file id in another space is the
shared `NOT_FOUND` before a byte is read.

- **An upload is bounded and streamable.** The `upload` family in the limits
  register carries the attachment cap (8 MiB by default,
  `PORKBOT_LIMIT_MAX_UPLOAD_BYTES`), checked from `Content-Length` or while the
  body streams, so an oversized upload is refused before it is buffered. The
  service writes the object first and the row second: a refusal after the
  write — a thread outside the actor's space — deletes the object again on a
  best-effort basis, and the failure window can only leave an unreferenced
  object, never a row whose bytes are missing.
- **A send carries attachments by id.** `threads.send` takes `attachmentIds`
  (capped at `MAX_ATTACHMENTS_PER_MESSAGE`) and resolves each through the
  actor-scoped store as an attachment on that thread; the message's jsonb
  blocks gain a `file` kind beside `text`, and the task prompt names each
  file's deterministic home-relative path (`attachments/<id>/<name>`) so the
  model can read it with `file_read`. The send's replay comparison includes
  the attachment set: the same nonce with a different set is a typed conflict,
  not a replay.
- **The worker materializes before the run.** `materializeRunAttachments` in
  `@porkbot/worker` reads the run's source message, resolves its file blocks,
  and streams each object into the computer through the same fenced command
  runner the tools use — 16 KiB parts written as overwrites, one assembly, one
  cleanup — so memory stays bounded and a retried materialization rewrites the
  same parts. The offline run suite proves the whole path: bytes seeded in an
  in-memory storage seam are read back by `file_read` from the emulated home.
- **A file a tool writes outlives the run.** `createComputerTools` accepts an
  `ArtifactRecorder`; every successful `file_write` records its bytes through
  the storage seam and the run's file store, and the tool result carries the
  download pointer (`{ id, filename, sizeBytes, downloadPath }`). The
  `run_artifact` row is unique on `(run_id, call_id)` and the storage key is
  deterministic in the same pair, so a retried recording lands on the first row
  and the first object. The console links the file from the tool-call timeline,
  and the link resolves after the run settles and after a reload because it
  addresses the row, never the machine's filesystem.
- **File paths are confined to the home.** `confineToHome` in `@porkbot/core`
  resolves `file_read`, `file_write` and `file_list` arguments — absolute or
  relative — against the computer's home and refuses anything that leaves it,
  before a command is built, so `../etc/passwd` never reaches the machine. The
  refusal is the tool result's typed reason (`outside_home`); a symlink
  planted inside the home is the machine's isolation boundary, which the shell
  tool already crosses. Origins are `home:/<relative-path>`, the convention the
  E10 ingestion fixtures use, and file bytes are still labelled
  `UntrustedContent` at the tool boundary.
- **Two tables, one owner.** `message_attachment` and `run_artifact` are read
  and written only by `packages/db/src/file-store.ts` — the operator's half
  uploads and resolves downloads, the run's half materializes and records —
  and `file-store.call-sites.test.ts` fails when another shipped module names
  either table. Both are space-scoped like every row, and the authorization
  matrix registers each with probes over the real seams.

## Memory

Durable memory is the other lane of the two-lane context policy (PRD decision
21; stories 23 and 24). A bot's memory is a set of documents — facts,
preferences and decisions — each with an append-only revision history, so a
wrong memory is correctable and every change is attributable. The rows are
`memory_document` and `memory_revision` in
`packages/db/src/schema/memory.ts`; the document row is the live state and the
revision rows are the audit trail, written together in one CTE statement by
`packages/db/src/memory-store.ts`, the single module that names either table.

The write rules live in `@porkbot/core`'s `memory-rules.ts` and the actor
factory decides which half of them a caller can reach. An operator
(`MemoryDocuments`) reads live and tombstoned documents, reads the whole
history, writes deliberately with itself as author, and restores a recorded
revision — `decideMemoryRestore` reapplies a revision, including the tombstone
a deletion left, as the document's next revision, so a deletion is reversible
without restarting the document's identity. An agent (`MemoryProposals`) reads
what recall needs and proposes a create or a rewrite recorded as
`agent_proposed` with the bot as author; it can never delete or restore, so a
durable fact is only lost by a deliberate operator act. Document ids are minted
once and never reused.

The agent's tools are `remember`, `recall` and `forget`
(`packages/effect/src/memory-tools.ts`): recall searches the provider index
within `RecallLimits`, remember proposes a create or a rewrite, and forget asks
for a deletion the rules refuse and records as a call in the timeline. The run's
prompt reads the same documents through `MemoryReader` and composes them in the
data channel, and compaction carries them through by reference and asserts them
preserved, so shortening a conversation never touches the memory lane.

The operator's surface is the memory contract (slice 8.3): `memory.list`
(live by default, tombstones under the `deleted` scope), `memory.revisions`
(whole history with who, why and when), and `memory.update`, `memory.remove`
and `memory.restore`, which answer the store's decision as a union — an
effective change with its revision, `no_change`, or the typed rule a refusal
broke. `apps/web/src/memory.ts` is the screen's controller and
`apps/web/src/screens/memory.tsx` renders it: documents with their kind and
revision, corrections in place, a folded view for long content, and a history
panel whose restore button reapplies any revision. A correction is a durable
write, so it takes effect immediately — no restart and no run.

## Notifications

The notification seam (slice 8.6, PRD decision 33; story 35) is declared in
`packages/adapter-kit` and shipped twice in `packages/adapters`: the
`NotificationEmulator`, whose mailbox tests read, and
`createHttpNotificationProvider`, an HTTPS webhook reached by URL and credential
name like every other seam. Both run the conformance suite in
`notification-conformance.ts`, including the rule that a delivery carries the
title, the body and an optional link and nothing else: the request body is built
from that allowlist rather than spread from the caller, so a credential or a raw
tool argument cannot ride along to a third party even if one was in the payload.

What is worth interrupting for lives in `@porkbot/core`: a closed vocabulary of
`run.completed`, `run.failed`, `run.needs_approval` and `run.stalled`, and the
quiet default is off for every one of them. `notification_preference` stores one
opt-in switch per `(space, operator, kind)` — no row is the quiet default — and
`packages/db/src/notification-store.ts` is the one module that names the rows:
an operator reads and writes its own switches, while a job asks one recipient's
eligibility through a `space_member` join, so a user outside the space is
suppressed rather than notified.

`createNotificationDelivery` in `@porkbot/effect` is the one path from an event
to a provider call: it checks eligibility first, then retries `rate_limited` and
`timed_out` with core's bounded backoff, surfaces `auth_failed` and `not_found`
without retrying, and returns a `delivered`, `suppressed` or `undelivered`
outcome — an undelivered notification is an error log and an outcome the caller
holds, never a silent drop. The operator surface ships with it:
`notifications.preferences` and `notifications.setPreference` are authenticated
procedures that read and flip the actor's own switches.

The run-liveness producers ship with slice 8.7.
`apps/worker/src/run-notifications.ts` is the one producer: a run that finished,
a run that failed, a run whose worker timed out and had nothing to resume, and a
run the watchdog found stuck all compose one message there and hand it to the
same delivery path. The stuck case reuses the E6 assessment
(`assessRunLiveness`) rather than a second heuristic, and its sentence names the
silence and the last step without carrying a tool argument. Every message links
to the run's timeline: the thread console, addressed down to the run itself
(`/threads/{threadId}?run={runId}`).

Duplicate suppression is durable, not incidental. A settled run claims its one
terminal notification in the run row's `notified_at` before anything is sent, so
a retried job or a producer racing the watchdog finds the claim taken and sends
nothing; a `cancelled` run is the operator's own act and never claims one. A
stall claims per episode through the `stalled_at` marker the watchdog already
writes, so a run that recovers and stalls again is announced again while one
long stall is announced once. The claim is taken before the preference is read,
so a quiet operator cannot leave the run unclaimed for a later producer to
re-announce.

The worker composes the provider in `main.ts`: the emulator is the default, so
the product notifies with nothing configured, and a deployment that sets
`PORKBOT_NOTIFICATION_WEBHOOK_URL` gets the HTTPS provider, with its key read
through the generic environment credential store under
`PORKBOT_NOTIFICATION_WEBHOOK_KEY`. `PORKBOT_WEB_ORIGIN` is the absolute web
origin links are built from; unset, it falls back to loopback with a warning,
because a link the operator cannot open is worth saying out loud.
