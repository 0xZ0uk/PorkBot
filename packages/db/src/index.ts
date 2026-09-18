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
export { openDatabase } from "./database.ts";
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
export { resolveUserActor } from "./membership.ts";
export type { ResolveActorInput } from "./membership.ts";

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
  BotPatch,
  BotReader,
  BotWriter,
  EventReader,
  NewBot,
  Repositories,
  RunReader,
  SystemRunWriter,
  RunWriter,
  SystemRepositories,
  ThreadReader,
  ThreadWriter,
  UserRepositories,
} from "./repositories.ts";
export type { CreatedRunAndTask, NewRunAndTask } from "./run-creation.ts";
export {
  RUN_HEARTBEAT_GRACE_SECONDS,
  RUN_HEARTBEAT_INTERVAL_SECONDS,
  RUN_LEASE_TTL_SECONDS,
} from "./run-leases.ts";
export type { FencedRunPatch, RunLease } from "./run-leases.ts";
export type {
  BotRecord,
  EventRecord,
  MessageRecord,
  MessageRole,
  RunRecord,
  TaskRecord,
  TaskStatus,
  ThreadRecord,
} from "./records.ts";
