import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { BACKUP_ALERT_KINDS, BACKUP_RUN_STATUSES } from "@porkbot/core";
import { primaryKeyId, timestamps } from "./columns.ts";

/**
 * The backup ledger (slice 12.3; PRD story 5).
 *
 * Three deployment-scoped tables, and none of them carries a `space_id`: a
 * backup covers the whole database and the whole storage root, so there is no
 * actor whose scope could narrow it. That is also why they are exempted with a
 * reason in the authorization matrix rather than given a cross-space probe —
 * there is no space predicate to probe.
 *
 *   - `backup_run` is one row per nightly attempt: the canary it wrote, the
 *     object it produced, what retention pruned, and the restore drill it ran.
 *     The row is written `running` first and settled in place, so a process
 *     that dies mid-backup leaves the evidence the worker's watchdog reads.
 *   - `backup_canary` is the single row every backup rewrites. Its token is
 *     copied into the run and into the dump, and the drill compares the token
 *     it reads back out of the restored scratch database with the one the run
 *     recorded — proof the restore produced the data that was backed up, not
 *     merely a schema that parsed.
 *   - `backup_alert` is the worker's episode claim: one row per alert kind,
 *     naming the episode already announced. A new failure is a new episode and
 *     announces again; the same episode never does.
 *
 * The status enum is built from `@porkbot/core`'s vocabulary, so the ledger,
 * the policy and the alert decision cannot drift about what "succeeded" means.
 */

export const backupStatus = pgEnum("backup_status", BACKUP_RUN_STATUSES);

export const backupAlertKind = pgEnum("backup_alert_kind", BACKUP_ALERT_KINDS);

export const backupRun = pgTable(
  "backup_run",
  {
    id: primaryKeyId(),
    status: backupStatus("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** The token this run wrote to `backup_canary` before the dump. */
    canaryToken: uuid("canary_token").notNull(),
    /** The dump's object key, size and checksum, once it is stored. */
    postgresKey: text("postgres_key"),
    postgresSize: bigint("postgres_size", { mode: "number" }),
    postgresChecksum: text("postgres_checksum"),
    /** How many home snapshots were copied, and how many bytes they were. */
    homesCount: integer("homes_count").notNull().default(0),
    homesBytes: bigint("homes_bytes", { mode: "number" }).notNull().default(0),
    /** How many objects the retention pass deleted after this run. */
    prunedObjects: integer("pruned_objects").notNull().default(0),
    /** A closed reason code; free text never reaches a notification. */
    errorCode: text("error_code"),
    /** The drill that followed this run's backup, if one was due. */
    drillStatus: backupStatus("drill_status"),
    drillStartedAt: timestamp("drill_started_at", { withTimezone: true }),
    drillFinishedAt: timestamp("drill_finished_at", { withTimezone: true }),
    drillCanaryVerified: boolean("drill_canary_verified").notNull().default(false),
    drillErrorCode: text("drill_error_code"),
    ...timestamps(),
  },
  (table) => [
    index("backup_run_started_at_idx").on(table.startedAt),
    // A settled row has a finish and a running one does not; the two columns
    // cannot disagree about whether the run is over.
    check(
      "backup_run_settled_check",
      sql`(${table.status} = 'running') = (${table.finishedAt} is null)`,
    ),
    check(
      "backup_run_error_code_check",
      sql`${table.errorCode} is null or ${table.status} = 'failed'`,
    ),
    check(
      "backup_run_postgres_size_check",
      sql`${table.postgresSize} is null or ${table.postgresSize} >= 0`,
    ),
    check("backup_run_homes_check", sql`${table.homesCount} >= 0 and ${table.homesBytes} >= 0`),
    check("backup_run_pruned_check", sql`${table.prunedObjects} >= 0`),
    // The drill's columns move together: a status has a start, a settled
    // status has a finish, and only a verified restore may claim the canary.
    check(
      "backup_run_drill_started_check",
      sql`(${table.drillStatus} is null) = (${table.drillStartedAt} is null)`,
    ),
    check(
      "backup_run_drill_settled_check",
      sql`${table.drillStatus} is null or (${table.drillStatus} = 'running') = (${table.drillFinishedAt} is null)`,
    ),
    check(
      "backup_run_drill_canary_check",
      sql`not ${table.drillCanaryVerified} or ${table.drillStatus} = 'succeeded'`,
    ),
    check(
      "backup_run_drill_error_code_check",
      sql`${table.drillErrorCode} is null or ${table.drillStatus} = 'failed'`,
    ),
  ],
);

export const backupCanary = pgTable(
  "backup_canary",
  {
    id: primaryKeyId(),
    /** The token the newest backup wrote; the drill proves this survives. */
    token: uuid("token").notNull(),
    writtenAt: timestamp("written_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * The one-row guard: a unique NOT NULL boolean with a `true` default means
     * a second insert without an explicit value conflicts instead of quietly
     * creating a second canary row the drill might read the wrong token from.
     */
    singleton: boolean("singleton").notNull().default(true),
    ...timestamps(),
  },
  (table) => [
    uniqueIndex("backup_canary_singleton_idx").on(table.singleton),
    check("backup_canary_singleton_check", sql`${table.singleton}`),
  ],
);

export const backupAlert = pgTable(
  "backup_alert",
  {
    id: primaryKeyId(),
    kind: backupAlertKind("kind").notNull(),
    /** The episode already announced for this kind; a new one re-announces. */
    episode: text("episode").notNull(),
    alertedAt: timestamp("alerted_at", { withTimezone: true }).notNull().defaultNow(),
    ...timestamps(),
  },
  (table) => [uniqueIndex("backup_alert_kind_idx").on(table.kind)],
);
