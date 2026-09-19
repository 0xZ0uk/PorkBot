export const moduleInfo = {
  name: "@porkbot/db",
  summary: "Drizzle schema, migrations and actor-scoped repositories. Tenant isolation lives here.",
} as const;

// The schema: every table, enum and the conventions they share. Identity and
// tenancy tables landed first (slice 2.2) and the runs tables follow (slice
// 2.3); `pnpm db:generate` diffs whatever `src/schema/index.ts` exports, so
// adding a table is adding one export there, and repositories read the same
// definitions the migration was generated from. This is the only entry point
// other packages may import.
export * from "./schema/index.ts";

// The connected handle and the one deployment-level read. `openDatabase` is how
// a consumer outside this package gets a drizzle instance without naming
// `pg`/`drizzle-orm`; `readDeploymentSettings` is the pre-auth read the signup
// gate needs, and it is deliberately not actor-scoped because no actor exists
// before registration.
export { openDatabase, queryable } from "./database.ts";
export type { DatabaseHandle, PostgresDatabase } from "./database.ts";
export { readDeploymentSettings } from "./deployment-settings.ts";

// The signup bootstrap: the pre-actor write that turns a registration into the
// operator's space and a membership in it, idempotently. It takes a user id and
// a role, never a space id, and returns the `UserActor` the membership resolves
// to — which is the scope `createRepositories` is built from.
export { bootstrapSignup, defaultSpaceName } from "./bootstrap.ts";
export type { BootstrapInput, BootstrapResult } from "./bootstrap.ts";

// The pre-actor read on the other side of the gate: a session's user id to the
// membership it holds. It takes a user id, never a space id, and returns
// `null` for a user with no membership, which the gate answers as 401 (slice
// 3.2). Nothing else resolves an actor from a session.
export { resolveBoundActor, resolveUserActor } from "./membership.ts";
export type { BoundActorInput, ResolveActorInput } from "./membership.ts";

// The ingress ledgers (slice 4.5): the pre-actor paths the unauthenticated
// webhook and OAuth-callback surfaces use. A delivery id is deduped under a
// NOT NULL unique key with a TTL the recorder sweeps, and an OAuth state is
// bound to the initiating actor and space and consumed exactly once. The raw
// state is never stored; only its hash is.
export {
  createIngressStore,
  hashOAuthState,
  oauthStateTtlSeconds,
  webhookDeliveryTtlSeconds,
} from "./ingress.ts";
export type {
  DeliveryLedger,
  IngressStore,
  IssueOAuthStateInput,
  OAuthStateBinding,
  OAuthStateStore,
  RecordWebhookDeliveryInput,
  ReleaseWebhookDeliveryInput,
} from "./ingress.ts";

// Applying migrations, exported so the API, the worker and scripts share one
// implementation with the `db:migrate` command rather than each shelling out.
export {
  countAppliedMigrations,
  formatMigrationReport,
  migrationsSchema,
  migrationsTable,
} from "./migrate.ts";
export type { MigrationRunOptions, MigrationRunReport } from "./migrate.ts";
export { runMigrations } from "./run-migrations.ts";

// The two service roles and their credentials. The migration
// (`0004_database_roles.sql`) creates the roles and owns their grants; this
// module is how the deployment supplies their passwords without committing
// one, and the names the worker's integration suite signs in with.
export {
  apiRole,
  apiRolePasswordEnvVar,
  graphileWorkerSchema,
  readRolePasswords,
  setRolePasswords,
  workerRole,
  workerRolePasswordEnvVar,
} from "./roles.ts";
export type { RolePasswords } from "./roles.ts";

// The actor and the repository factory: how data access is scoped. Nothing
// else in this package takes a space or user id as an argument — the scope is
// the actor a repository was built from, and the typed not-found it throws is
// the shared one from `@porkbot/effect` so the transport mapping can name it.
// `runs.create` is the single run-creation command (slice 2.10), while a system
// actor receives only fence-guarded lease and execution writes. The commands
// stay unexported so the actor-bound repository is the only way in.
export type { Actor, SpaceMemberRole, SystemActor, UserActor } from "./actor.ts";
// The one-connection seam repositories are built on. A consumer outside this
// package (the worker's job context) hands a checked-out connection to
// `createRepositories` through this type rather than naming `pg`.
export type { Queryable } from "./queryable.ts";
export { createRepositories } from "./repositories.ts";
export type {
  BotListScope,
  BotPatch,
  BotReader,
  BotSectionPatch,
  BotWriter,
  EventReader,
  MembershipReader,
  ModelConnectionPatch,
  ModelConnectionReader,
  ModelConnectionRecord,
  ModelConnectionWriter,
  ModelSelection,
  ModelSelectionReader,
  NewBot,
  NewBotSection,
  NewModelConnection,
  Repositories,
  RunReader,
  SectionReader,
  SectionWriter,
  SystemRunWriter,
  RunWriter,
  SystemRepositories,
  ThreadPage,
  ThreadReader,
  ThreadWriter,
  UserRepositories,
} from "./repositories.ts";
export { routineRunNonce, routineTestRunNonce } from "./run-creation.ts";
export type {
  CreatedRoutineRun,
  CreatedRunAndTask,
  NewRoutineRun,
  NewRoutineTestRun,
  NewRunAndTask,
} from "./run-creation.ts";

// The message store (slice 6.5): the transcript reads the thread surface pages
// through, the operator's steering command, and the worker's assistant-message
// command. It owns the sequence allocation and the insert every message writer
// shares, including the run-creation command. Its commands are built by
// `createRepositories` from an actor; the two primitives below are exported for
// the run-creation command, which writes its user message in its own
// transaction.
export {
  allocateMessageSeq,
  claimSteeringMessages,
  clearThread,
  createAssistantMessageStore,
  createSteeringMessageStore,
  insertMessage,
  readMessages,
} from "./messages.ts";
export type {
  AssistantMessageWriter,
  MessagePage,
  MessageReader,
  NewAssistantMessage,
  NewMessage,
  NewSteeringMessage,
  SteeringMessageWriter,
} from "./messages.ts";

// The durable half of routines (slice 8.4, PRD decision 22): the schedule
// rows, the occurrence ledger that makes a missed schedule a visible row, and
// the operator's CRUD beside the scheduler's two commands. The factory splits
// by actor exactly as `createRepositories` does; the cross-space scheduler
// scans take no actor and are documented exceptions, like `findExpiredLeases`.
export {
  createRoutineStore,
  findQueuedRoutineRuns,
  listDueRoutines,
  ROUTINE_DISPATCH_GRACE_SECONDS,
  ROUTINE_OUTCOME_DEFAULT_LIMIT,
  ROUTINE_PREVIEW_DEFAULT_COUNT,
  ROUTINE_PREVIEW_MAX_COUNT,
  ROUTINE_SCHEDULER_BATCH_LIMIT,
} from "./routines.ts";
export type {
  DueRoutine,
  MissedRoutineOccurrence,
  NewRoutine,
  QueuedRoutineRun,
  RoutinePatch,
  RoutineReader,
  RoutineScheduler,
  RoutineWriter,
} from "./routines.ts";
export {
  expiredLeaseReason,
  findExpiredLeases,
  RUN_HEARTBEAT_GRACE_SECONDS,
  RUN_HEARTBEAT_INTERVAL_SECONDS,
  RUN_LEASE_TTL_SECONDS,
  RUN_WATCHDOG_BATCH_LIMIT,
} from "./run-leases.ts";
export type { ExpiredLease, FencedRunPatch, ReclaimOptions, RunLease } from "./run-leases.ts";
export type {
  AttemptStatus,
  BotRecord,
  BotSectionRecord,
  EventRecord,
  MessageRecord,
  MessageRole,
  RoutineOccurrenceRecord,
  RoutineOutcomeRecord,
  RoutineOutcomeStatus,
  RoutineRecord,
  RunRecord,
  TaskRecord,
  TaskStatus,
  ThreadRecord,
} from "./records.ts";

// The durable half of tool dispatch (slice 5.5, PRD decision 26): the
// `external_effect` ledger keyed by `(run_id, idempotency_key)` — the call's
// durable `callId` — that makes a retried tool call a replay instead of a
// second side effect. It is built from a `SystemActor` and binds the actor's
// space into every statement, exactly like the repositories; the seam it
// implements is declared in `@porkbot/effect`.
export { createExternalEffectLedger } from "./tool-call-ledger.ts";

// The durable half of the run's event stream (slice 5.6): `createRunEventSink`
// appends the recorder's events to the `event` table in one scoped statement,
// advancing the thread's sequence counter with the row. Subscriptions replay
// these rows; this is what makes a tool-call timeline survive a reload. The
// seam it implements is declared in `@porkbot/effect`.
export { createRunEventSink } from "./run-event-sink.ts";

// The durable half of the approval gate (slice 5.7, PRD decision 13): the
// `approval` rows keyed by `(run_id, call_id)`, opened by a job and voted on by
// an operator. The factory splits by actor exactly as `createRepositories`
// does — a job opens gates and settles deadlines, a user votes and reads the
// timeline — and every statement binds the actor's space. The seams it
// implements (`ApprovalStore`, `ApprovalDecisions`) are declared in
// `@porkbot/effect`.
export { createApprovalStore } from "./approval-store.ts";

// The durable half of memory (slice 8.1, PRD decision 21): the live document
// rows and their revision history. This module is the only one in the package
// — and, by the call-site suite beside it, in the shipped source — that names
// the memory tables, so reads and writes are auditable in one place. The
// factory splits by actor: an operator writes deliberately and reads the
// history, an agent proposes create-or-rewrite and can never delete. The seams
// it implements (`MemoryDocuments`, `MemoryProposals`) are declared in
// `@porkbot/effect`.
export { createMemoryStore } from "./memory-store.ts";

// The durable half of notification preferences (slice 8.6, PRD decision 33;
// stories 35): the per-operator switches behind the settings surface and the
// delivery path. This module is the only one in the package — and, by the
// call-site suite beside it, in the shipped source — that names the preference
// table. The factory splits by actor: an operator reads and writes their own
// switches, while a job answers one recipient's eligibility through a
// `space_member` join, so a notification cannot cross a space. The seams it
// implements (`NotificationPreferences`, `NotificationRecipients`) are declared
// in `@porkbot/effect`, and `createRepositories` exposes the matching half on
// each actor's repository set.
export { createNotificationStore } from "./notification-store.ts";

// The encrypted credential store (slice 9.1, PRD decision 10; stories 14 and
// 15): AES-256-GCM envelopes in the encrypted credential rows, each bound to
// its `(space, name)` identity and carrying its key id, so a second key can be
// introduced before a rotation pass and both decrypt while it runs. This module
// and `credential-cipher.ts` are the only shipped code that names the rows, and
// `createEncryptedCredentialStore` is the only way in or out. The factory splits
// by actor: an operator lists masked summaries, writes and rotates through the
// actor's space, while a job resolves one name and cannot enumerate. The seam
// it implements (`Credentials`, which extends adapter-kit's `CredentialStore`)
// is declared in `@porkbot/effect`; `createRepositories` exposes the matching
// half on each actor's repository set and takes the keyring in its options.
export { createEncryptedCredentialStore } from "./encrypted-credential-store.ts";

// The durable half of MCP servers (slice 9.5, PRD story 38): the installed
// server rows, the tool list discovery cached and the per-bot grants. This
// module is the only one in the package — and, by the call-site suite beside
// it, in the shipped source — that names the three tables. The factory splits
// by actor: an operator installs, refreshes, removes and grants, while a job
// reads the servers a bot was granted and re-checks one grant before a call.
// The seams it implements (`McpServers`, `McpRunServers`) are declared in
// `@porkbot/effect`, and `createRepositories` exposes the matching half on each
// actor's repository set.
export { createMcpStore } from "./mcp-store.ts";

// The envelope itself: the versioned ciphertext format, the deployment keyring
// and the mask a list response shows. They are exported for the composition
// root, which parses `PORKBOT_CREDENTIAL_KEYS` once at boot, and for the tests
// that prove a moved ciphertext fails and a rotation re-encrypts.
export {
  createCredentialKeyring,
  credentialEnvelopeKeyId,
  credentialKeyringFromEnvironment,
  decryptCredentialValue,
  encryptCredentialValue,
  maskCredentialValue,
} from "./credential-cipher.ts";
export type {
  CredentialBinding,
  CredentialKeyring,
  CredentialKeyringEntry,
  CredentialKeyringInput,
} from "./credential-cipher.ts";
