import type { BackupAlertKind, BackupRunStatus } from "@porkbot/core";
import type { DatabaseHandle } from "./database.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The backup ledger's one module (slice 12.3; PRD story 5).
 *
 * Three deployment-scoped tables — `backup_run`, `backup_canary` and
 * `backup_alert` — and this is the only shipped code that names them, the same
 * rule the memory, credential, bot-secret, MCP and stored-file stores follow.
 * The tables have no `space_id` and no actor: a backup covers the whole
 * database and the whole storage root, so there is no scope to narrow. The
 * factory therefore splits by *capability* rather than by actor:
 *
 *   - `createBackupLedger` is the writer half the backup process uses over the
 *     database owner's connection: open a run, rewrite the canary, settle the
 *     run and the drill it performed, prune nothing itself. It never reads a
 *     domain table; pg_dump does that.
 *   - `createBackupStatusReader` is the read half the worker's watchdog uses
 *     over its own restricted role: the newest run, the newest success, the
 *     newest drill, and the episode claim. It can never write a run, and the
 *     worker holds no dump credential.
 *
 * `backup_run` is append-mostly: a row is inserted `running` and updated once
 * when it settles, so a process that dies mid-dump leaves the open row the
 * watchdog reads as evidence. `backup_alert` is an upsert keyed by alert kind:
 * the update only fires when the episode differs, so `claimAlert` returns true
 * exactly once per episode even under concurrent watchdogs.
 */

export interface BackupRunRecord {
  readonly id: string;
  readonly status: BackupRunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
  readonly canaryToken: string;
  readonly postgresKey: string | null;
  readonly postgresSize: number | null;
  readonly postgresChecksum: string | null;
  readonly homesCount: number;
  readonly homesBytes: number;
  readonly prunedObjects: number;
  readonly errorCode: string | null;
  readonly drillStatus: BackupRunStatus | null;
  readonly drillStartedAt: Date | null;
  readonly drillFinishedAt: Date | null;
  readonly drillCanaryVerified: boolean;
  readonly drillErrorCode: string | null;
}

/**
 * The driver hands `bigint` columns back as strings; the record promises
 * numbers, so every read passes through here rather than letting the declared
 * type lie about what the caller receives.
 */
interface BackupRunRow extends Omit<BackupRunRecord, "postgresSize" | "homesBytes"> {
  readonly postgresSize: string | number | null;
  readonly homesBytes: string | number;
}

function toRecord(row: BackupRunRow): BackupRunRecord {
  return {
    ...row,
    postgresSize: row.postgresSize === null ? null : Number(row.postgresSize),
    homesBytes: Number(row.homesBytes),
  };
}

const runColumns =
  'id, status::text as status, started_at as "startedAt", finished_at as "finishedAt", ' +
  'canary_token as "canaryToken", postgres_key as "postgresKey", ' +
  'postgres_size as "postgresSize", postgres_checksum as "postgresChecksum", ' +
  'homes_count as "homesCount", homes_bytes as "homesBytes", ' +
  'pruned_objects as "prunedObjects", error_code as "errorCode", ' +
  'drill_status::text as "drillStatus", drill_started_at as "drillStartedAt", ' +
  'drill_finished_at as "drillFinishedAt", drill_canary_verified as "drillCanaryVerified", ' +
  'drill_error_code as "drillErrorCode"';

export interface BeginBackupRun {
  /** The token the run writes to the canary before the dump is taken. */
  readonly canaryToken: string;
}

export interface SettleBackupRun {
  readonly status: "succeeded" | "failed";
  readonly postgresKey?: string | undefined;
  readonly postgresSize?: number | undefined;
  readonly postgresChecksum?: string | undefined;
  readonly homesCount?: number | undefined;
  readonly homesBytes?: number | undefined;
  readonly prunedObjects?: number | undefined;
  readonly errorCode?: string | undefined;
}

export interface SettleBackupDrill {
  readonly status: "succeeded" | "failed";
  readonly canaryVerified: boolean;
  readonly errorCode?: string | undefined;
}

/**
 * What the backup process may do to the ledger. Every method is a single
 * statement: a run's state is one row, and a partial update would only be a
 * second way to describe the same attempt.
 */
export interface BackupLedger {
  /** Opens a run. The row is `running` until `settleRun` says otherwise. */
  beginRun(input: BeginBackupRun): Promise<BackupRunRecord>;
  /** Rewrites the single canary row with this run's token. */
  writeCanary(token: string): Promise<void>;
  settleRun(id: string, patch: SettleBackupRun): Promise<BackupRunRecord>;
  /** Opens the drill half of a settled run. */
  beginDrill(id: string): Promise<BackupRunRecord>;
  settleDrill(id: string, patch: SettleBackupDrill): Promise<BackupRunRecord>;
}

export interface BackupStatus {
  /** The newest run by start time, whatever its status. */
  readonly lastRun: BackupRunRecord | undefined;
  /** The newest successful run by finish time. */
  readonly lastSuccess: BackupRunRecord | undefined;
  /** The newest successful drill by finish time, across runs. */
  readonly lastDrill: BackupRunRecord | undefined;
  /** The newest drill by start time, whatever its status. */
  readonly lastDrillRun: BackupRunRecord | undefined;
}

/** What the worker's watchdog may do: read the ledger and claim one episode. */
export interface BackupStatusReader {
  status(): Promise<BackupStatus>;
  /**
   * True only for the caller that moved this kind's episode. A repeated call
   * for the same episode is false, so one fact is announced once.
   */
  claimAlert(kind: BackupAlertKind, episode: string): Promise<boolean>;
}

/** A second invocation tried to enter the deployment-wide backup lane. */
export class BackupRunOverlapError extends Error {
  constructor() {
    super("another backup run is already in progress");
    this.name = "BackupRunOverlapError";
  }
}

/**
 * Owns the deployment-wide backup lane for one callback.
 *
 * A session advisory lock is a better fit than a permanent `running`-row
 * uniqueness rule: it rejects a concurrent host timer or operator command,
 * but Postgres releases it automatically if a container is killed. The
 * callback receives repositories bound to the same checked-out connection so
 * the lock cannot accidentally live on a different pool session.
 */
export async function withBackupRunLock<Value>(
  handle: DatabaseHandle,
  run: (access: {
    readonly ledger: BackupLedger;
    readonly reader: BackupStatusReader;
  }) => Promise<Value>,
): Promise<Value> {
  const connection = await handle.database.$client.connect();
  let acquired = false;

  try {
    const { rows } = await connection.query<{ readonly acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext('porkbot.backup.run')) as acquired",
    );
    acquired = rows[0]?.acquired === true;

    if (!acquired) {
      throw new BackupRunOverlapError();
    }

    return await run({
      ledger: createBackupLedger(connection),
      reader: createBackupStatusReader(connection),
    });
  } finally {
    try {
      if (acquired) {
        await connection.query("select pg_advisory_unlock(hashtext('porkbot.backup.run'))");
      }
    } finally {
      connection.release();
    }
  }
}

async function readRun(
  database: Queryable,
  statement: string,
  values: readonly unknown[],
): Promise<BackupRunRecord | undefined> {
  const { rows } = await database.query<BackupRunRow>(statement, values);
  const row = rows[0];

  return row === undefined ? undefined : toRecord(row);
}

export function createBackupLedger(database: Queryable): BackupLedger {
  async function updateRun(id: string, patch: SettleBackupRun): Promise<BackupRunRecord> {
    const values: unknown[] = [];
    const assignments: string[] = ["updated_at = now()", "finished_at = now()"];

    const set = (column: string, value: unknown): void => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    set("status", patch.status);

    if (patch.postgresKey !== undefined) {
      set("postgres_key", patch.postgresKey);
    }

    if (patch.postgresSize !== undefined) {
      set("postgres_size", patch.postgresSize);
    }

    if (patch.postgresChecksum !== undefined) {
      set("postgres_checksum", patch.postgresChecksum);
    }

    if (patch.homesCount !== undefined) {
      set("homes_count", patch.homesCount);
    }

    if (patch.homesBytes !== undefined) {
      set("homes_bytes", patch.homesBytes);
    }

    if (patch.prunedObjects !== undefined) {
      set("pruned_objects", patch.prunedObjects);
    }

    set("error_code", patch.errorCode ?? null);

    values.push(id);
    const { rows } = await database.query<BackupRunRow>(
      `update backup_run set ${assignments.join(", ")} where id = $${values.length} ` +
        `returning ${runColumns}`,
      values,
    );
    const row = rows[0];

    if (row === undefined) {
      throw new Error(`the backup run ${id} disappeared before it could be settled`);
    }

    return toRecord(row);
  }

  return {
    async beginRun(input: BeginBackupRun): Promise<BackupRunRecord> {
      const { rows } = await database.query<BackupRunRow>(
        `insert into backup_run (canary_token) values ($1::uuid) returning ${runColumns}`,
        [input.canaryToken],
      );
      const row = rows[0];

      if (row === undefined) {
        throw new Error("the backup run insert returned no row");
      }

      return toRecord(row);
    },

    async writeCanary(token: string): Promise<void> {
      // An upsert on the singleton index, not a delete-then-insert: the two
      // statements of a data-modifying CTE see the same snapshot, so the
      // insert could conflict with the row the delete had not yet removed.
      await database.query(
        "insert into backup_canary (token) values ($1::uuid) " +
          "on conflict (singleton) do update set token = excluded.token, " +
          "written_at = now(), updated_at = now()",
        [token],
      );
    },

    settleRun: updateRun,

    async beginDrill(id: string): Promise<BackupRunRecord> {
      const { rows } = await database.query<BackupRunRow>(
        "update backup_run set drill_status = 'running', drill_started_at = now(), " +
          "drill_canary_verified = false, updated_at = now() " +
          `where id = $1 and status = 'succeeded' returning ${runColumns}`,
        [id],
      );
      const row = rows[0];

      if (row === undefined) {
        throw new Error(`the backup run ${id} is not a succeeded run, so it has nothing to drill`);
      }

      return toRecord(row);
    },

    async settleDrill(id: string, patch: SettleBackupDrill): Promise<BackupRunRecord> {
      const { rows } = await database.query<BackupRunRow>(
        "update backup_run set drill_status = $2::backup_status, drill_finished_at = now(), " +
          "drill_canary_verified = $3, drill_error_code = $4, updated_at = now() " +
          `where id = $1 and drill_status = 'running' returning ${runColumns}`,
        [id, patch.status, patch.canaryVerified, patch.errorCode ?? null],
      );
      const row = rows[0];

      if (row === undefined) {
        throw new Error(`the backup drill for run ${id} is not running`);
      }

      return toRecord(row);
    },
  };
}

/**
 * The canary token a database holds, or `null` when it holds no row. The drill
 * calls this against the restored scratch database — the canary it compares is
 * read back out of the restore, not out of the ledger — and the store is the
 * one module that names the table, so the read lives here beside the rest.
 */
export async function readCanaryToken(database: Queryable): Promise<string | null> {
  const { rows } = await database.query<{ readonly token: string }>(
    "select token::text as token from backup_canary order by written_at desc limit 1",
  );

  return rows[0]?.token ?? null;
}

export function createBackupStatusReader(database: Queryable): BackupStatusReader {
  return {
    async status(): Promise<BackupStatus> {
      const lastRun = await readRun(
        database,
        `select ${runColumns} from backup_run order by started_at desc, id desc limit 1`,
        [],
      );
      const lastSuccess = await readRun(
        database,
        `select ${runColumns} from backup_run where status = 'succeeded' ` +
          "order by finished_at desc, id desc limit 1",
        [],
      );
      const lastDrill = await readRun(
        database,
        `select ${runColumns} from backup_run where drill_status = 'succeeded' ` +
          "order by drill_finished_at desc, id desc limit 1",
        [],
      );
      const lastDrillRun = await readRun(
        database,
        `select ${runColumns} from backup_run where drill_status is not null ` +
          "order by drill_started_at desc, id desc limit 1",
        [],
      );

      return { lastRun, lastSuccess, lastDrill, lastDrillRun };
    },

    async claimAlert(kind: BackupAlertKind, episode: string): Promise<boolean> {
      const { rows } = await database.query<{ readonly id: string }>(
        "insert into backup_alert (kind, episode) values ($1::backup_alert_kind, $2) " +
          "on conflict (kind) do update set episode = excluded.episode, alerted_at = now(), " +
          "updated_at = now() " +
          "where backup_alert.episode is distinct from excluded.episode " +
          "returning id",
        [kind, episode],
      );

      return rows[0] !== undefined;
    },
  };
}
