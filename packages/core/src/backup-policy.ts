/**
 * Backup schedule, retention and alert decisions (slice 12.3; PRD story 5).
 *
 * Nightly encrypted backups have three decisions that must not live in a shell
 * script: when a run is due, what a retention policy deletes, and when a
 * missing or failed backup is worth waking an operator. All three are pure
 * here — the clock arrives as a `Date` — so the answers are testable at an
 * exact instant and the process that executes them only executes them.
 *
 * The schedule is a wall-clock time in UTC. A nightly backup is a daily
 * cadence, so the rule is simply "the first scheduled instant strictly after
 * the last attempt": a process that was down for three days runs once on boot
 * rather than three times, and a run that started late is not scheduled again
 * for the same night. The ledger's newest attempt is the only cursor; there is
 * no separate `next_run_at` to drift from it.
 *
 * The restore drill is monthly. A drill without a successful backup has
 * nothing to restore, so the first backup arms it; from then on it is due when
 * the interval has elapsed since the last successful drill, measured from the
 * backup that armed it when no drill has run yet.
 *
 * Alerts are episodes, not events: an alert is identified by the fact it is
 * about (the failed run's start, the last success a gap follows, the drill
 * that failed), and the durable claim in the worker's ledger is what keeps one
 * episode to one message. `decideBackupAlerts` answers what is alert-worthy
 * now; whether it was already announced is the store's answer, not this
 * module's.
 *
 * The key envelope's shape is here too. The envelope is the only thing that
 * survives the loss of `PORKBOT_BACKUP_KEYS`, and parsing it is pure; deriving
 * the sealing key from the operator's passphrase is `@porkbot/backup`'s, where
 * `node:crypto` lives.
 */

/** The closed run/drill status vocabulary; the database enum is built from it. */
export const BACKUP_RUN_STATUSES = ["running", "succeeded", "failed"] as const;

export type BackupRunStatus = (typeof BACKUP_RUN_STATUSES)[number];

/** The closed alert vocabulary; the database enum is built from it. */
export const BACKUP_ALERT_KINDS = [
  /** No successful backup within the staleness tolerance. */
  "backup.missed",
  /** The newest run failed. */
  "backup.failed",
  /** The newest run is still `running` long past any plausible duration. */
  "backup.stalled",
  /** No successful restore drill within the drill tolerance. */
  "drill.missed",
  /** The newest drill failed: the backup did not restore into readable data. */
  "drill.failed",
] as const;

export type BackupAlertKind = (typeof BACKUP_ALERT_KINDS)[number];

/** The storage-key prefix every encrypted backup object lives under. */
export const BACKUP_OBJECT_PREFIX = "backups";

/** Where one run's Postgres dump lives; the run id is the whole address. */
export function backupPostgresKey(runId: string): string {
  return `${BACKUP_OBJECT_PREFIX}/postgres/${runId}.dump.enc`;
}

/** Where one source object's encrypted copy lives under a run's prefix. */
export function backupHomesKey(runId: string, sourceKey: string): string {
  return `${BACKUP_OBJECT_PREFIX}/homes/${runId}/${sourceKey}.enc`;
}

/** The run id a backup object key names, or undefined when it names none. */
export function backupRunIdFromKey(key: string): string | undefined {
  const match = /^backups\/(?:postgres|homes)\/([0-9a-f-]{36})(?:\.|\/|$)/.exec(key);

  return match?.[1];
}

/** A nightly time of day, in UTC. */
export interface NightlyBackupSchedule {
  readonly hourUtc: number;
  readonly minuteUtc: number;
}

/** 03:00 UTC: after the operator's day in every inhabited timezone. */
export const DEFAULT_BACKUP_SCHEDULE: NightlyBackupSchedule = Object.freeze({
  hourUtc: 3,
  minuteUtc: 0,
});

function assertSchedule(schedule: NightlyBackupSchedule): void {
  if (
    !Number.isInteger(schedule.hourUtc) ||
    schedule.hourUtc < 0 ||
    schedule.hourUtc > 23 ||
    !Number.isInteger(schedule.minuteUtc) ||
    schedule.minuteUtc < 0 ||
    schedule.minuteUtc > 59
  ) {
    throw new RangeError(
      `a backup schedule must be a whole hour 0-23 and minute 0-59, received ` +
        `${String(schedule.hourUtc)}:${String(schedule.minuteUtc)}`,
    );
  }
}

function assertInstant(instant: Date, label: string): number {
  const milliseconds = instant.getTime();

  if (Number.isNaN(milliseconds)) {
    throw new RangeError(`${label} must be a valid date`);
  }

  return milliseconds;
}

/** The first scheduled instant strictly after `after`. */
export function nextBackupAt(after: Date, schedule: NightlyBackupSchedule): Date {
  assertSchedule(schedule);
  const afterMs = assertInstant(after, "the backup cursor");

  const day = new Date(afterMs);
  const candidate = Date.UTC(
    day.getUTCFullYear(),
    day.getUTCMonth(),
    day.getUTCDate(),
    schedule.hourUtc,
    schedule.minuteUtc,
  );

  return new Date(candidate > afterMs ? candidate : candidate + 24 * 60 * 60 * 1000);
}

/**
 * Whether a nightly run is due. No attempt yet is due immediately: a fresh
 * deployment's first backup should not wait up to a day for the clock, and a
 * ledger that has never been written is exactly the state a first run is for.
 */
export function isBackupDue(
  now: Date,
  lastAttemptAt: Date | null,
  schedule: NightlyBackupSchedule = DEFAULT_BACKUP_SCHEDULE,
): boolean {
  const nowMs = assertInstant(now, "the backup clock");

  if (lastAttemptAt === null) {
    return true;
  }

  return nowMs >= nextBackupAt(lastAttemptAt, schedule).getTime();
}

export interface DrillDueInput {
  readonly now: Date;
  /** The newest successful drill, or null when none has ever run. */
  readonly lastDrillAt: Date | null;
  /** The newest successful backup; a drill with nothing to restore is not due. */
  readonly lastBackupAt: Date | null;
  /** Days between drills. Defaults to 30. */
  readonly intervalDays?: number;
}

/**
 * Whether the monthly restore drill is due. The first successful backup arms
 * it immediately — a deployment should learn on day one that its backup
 * restores, not a month later — and a drill that has never succeeded keeps the
 * drill due on every run rather than postponing the next attempt by a whole
 * interval. Once a drill has succeeded, the interval is measured from it.
 */
export function isDrillDue(input: DrillDueInput): boolean {
  const intervalDays = input.intervalDays ?? 30;

  if (!Number.isInteger(intervalDays) || intervalDays < 1) {
    throw new RangeError(`the drill interval must be a positive whole number of days`);
  }

  if (input.lastBackupAt === null) {
    return false;
  }

  if (input.lastDrillAt === null) {
    return true;
  }

  const lastDrillMs = assertInstant(input.lastDrillAt, "the last drill");
  const nowMs = assertInstant(input.now, "the drill clock");

  return nowMs - lastDrillMs >= intervalDays * 24 * 60 * 60 * 1000;
}

/** The listing fields retention needs; a `StorageObject` satisfies it. */
export interface BackupObjectAge {
  readonly key: string;
  /** ISO 8601, as the storage seam reports it. */
  readonly lastModified: string;
}

export interface RetentionInput {
  readonly now: Date;
  /** How many days a backup object stays readable. */
  readonly retentionDays: number;
  /**
   * Keys that are never deleted regardless of age: the newest successful
   * run's objects. A retention policy that can empty the backup set is not a
   * policy, it is a countdown.
   */
  readonly protect?: readonly string[];
}

/**
 * The keys a retention pass deletes, in listing order. An object older than
 * the window goes; the protected set stays even when it is older, so the
 * deployment always keeps at least the newest successful backup. A malformed
 * `lastModified` is a bug in the listing rather than a policy question and
 * raises instead of guessing an age.
 */
export function selectExpiredBackupKeys(
  objects: readonly BackupObjectAge[],
  input: RetentionInput,
): readonly string[] {
  if (!Number.isInteger(input.retentionDays) || input.retentionDays < 1) {
    throw new RangeError("the retention window must be a positive whole number of days");
  }

  const nowMs = assertInstant(input.now, "the retention clock");
  const cutoffMs = nowMs - input.retentionDays * 24 * 60 * 60 * 1000;
  const protectedKeys = new Set(input.protect ?? []);
  const expired: string[] = [];

  for (const object of objects) {
    const modifiedMs = Date.parse(object.lastModified);

    if (Number.isNaN(modifiedMs)) {
      throw new RangeError(
        `the listing reported an unparseable lastModified for "${object.key}": ${object.lastModified}`,
      );
    }

    if (modifiedMs < cutoffMs && !protectedKeys.has(object.key)) {
      expired.push(object.key);
    }
  }

  return expired;
}

/** One run, as the alert decision reads it. */
export interface BackupAlertRun {
  readonly status: BackupRunStatus;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface BackupAlertInput {
  readonly now: Date;
  /** The newest run by start time, or null when the ledger is empty. */
  readonly lastRun: BackupAlertRun | null;
  /** The newest successful run's finish, or null when none has succeeded. */
  readonly lastSuccessAt: Date | null;
  /** The newest successful drill's finish, or null when none has succeeded. */
  readonly lastDrillAt: Date | null;
  /** The newest drill by start time, or null when none has run. */
  readonly lastDrillRun: BackupAlertRun | null;
  /** How long a backup may go without a success. Defaults to 36 hours. */
  readonly stalenessMs?: number;
  /** How long a drill may go without a success. Defaults to 45 days. */
  readonly drillStalenessMs?: number;
  /** How long a `running` row may stay open before it is a stalled run. */
  readonly runTimeoutMs?: number;
}

export interface BackupAlert {
  readonly kind: BackupAlertKind;
  /**
   * The durable identity of the fact being announced: the same episode never
   * alerts twice, and a new failure or a new gap is a new episode.
   */
  readonly episode: string;
}

const DEFAULT_STALENESS_MS = 36 * 60 * 60 * 1000;
const DEFAULT_DRILL_STALENESS_MS = 45 * 24 * 60 * 60 * 1000;
const DEFAULT_RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive number of milliseconds`);
  }

  return value;
}

function openRunAlert(
  run: BackupAlertRun | null,
  kind: BackupAlertKind,
  nowMs: number,
  timeoutMs: number,
): BackupAlert | undefined {
  if (run === null || run.status !== "running") {
    return undefined;
  }

  if (nowMs - assertInstant(run.startedAt, "the run's start") <= timeoutMs) {
    return undefined;
  }

  return { kind, episode: run.startedAt.toISOString() };
}

/**
 * What is alert-worthy at this instant. The list is ordered by severity: a
 * failure or a stall outranks a missed window (the operator has more specific
 * news than "nothing succeeded"), and a drill finding outranks a missed drill.
 * A run that is merely late is not an alert until the tolerance is crossed,
 * and a `running` row inside its timeout is not a stall.
 */
export function decideBackupAlerts(input: BackupAlertInput): readonly BackupAlert[] {
  const nowMs = assertInstant(input.now, "the alert clock");
  const stalenessMs = positive(input.stalenessMs ?? DEFAULT_STALENESS_MS, "the staleness window");
  const drillStalenessMs = positive(
    input.drillStalenessMs ?? DEFAULT_DRILL_STALENESS_MS,
    "the drill staleness window",
  );
  const runTimeoutMs = positive(input.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, "the run timeout");

  const alerts: BackupAlert[] = [];

  if (input.lastRun?.status === "failed") {
    alerts.push({ kind: "backup.failed", episode: input.lastRun.startedAt.toISOString() });
  } else {
    const stalled = openRunAlert(input.lastRun, "backup.stalled", nowMs, runTimeoutMs);

    if (stalled !== undefined) {
      alerts.push(stalled);
    }
  }

  const lastSuccessMs =
    input.lastSuccessAt === null ? null : assertInstant(input.lastSuccessAt, "the last success");

  // "Never succeeded" is an episode of its own: a deployment whose backup has
  // never run is exactly what the watchdog exists to notice, and the episode
  // changes the moment a success lands.
  if (lastSuccessMs === null) {
    alerts.push({ kind: "backup.missed", episode: "never" });
  } else if (nowMs - lastSuccessMs > stalenessMs) {
    alerts.push({ kind: "backup.missed", episode: input.lastSuccessAt?.toISOString() ?? "never" });
  }

  const lastDrillMs =
    input.lastDrillAt === null ? null : assertInstant(input.lastDrillAt, "the last drill");

  if (input.lastDrillRun?.status === "failed") {
    alerts.push({ kind: "drill.failed", episode: input.lastDrillRun.startedAt.toISOString() });
  } else {
    const stalled = openRunAlert(input.lastDrillRun, "drill.failed", nowMs, runTimeoutMs);

    if (stalled !== undefined) {
      alerts.push(stalled);
    }
  }

  if (lastDrillMs === null && lastSuccessMs !== null) {
    // The drill is armed by the first backup; it is "missed" only once the
    // window since that arming has elapsed.
    if (nowMs - lastSuccessMs > drillStalenessMs) {
      alerts.push({
        kind: "drill.missed",
        episode: input.lastSuccessAt?.toISOString() ?? "never",
      });
    }
  } else if (lastDrillMs !== null && nowMs - lastDrillMs > drillStalenessMs) {
    alerts.push({ kind: "drill.missed", episode: input.lastDrillAt?.toISOString() ?? "never" });
  }

  return alerts;
}

/**
 * The sealed key envelope: the backup keyring, encrypted under a key derived
 * from the operator's passphrase, written somewhere other than the backup
 * destination. Its shape is a closed vocabulary because it is the artifact a
 * recovery reads after the deployment that wrote it is gone; a parser that
 * guesses would be guessing with the only copy.
 */
export const BACKUP_ENVELOPE_VERSION = "v1";

export interface BackupEnvelopeKdf {
  readonly name: "scrypt";
  /** Base64url salt. */
  readonly salt: string;
  /** CPU/memory cost; the pair with `r`/`p` is authenticated, never downgraded. */
  readonly n: number;
  readonly r: number;
  readonly p: number;
  /** Derived key length in bytes. */
  readonly keyLength: number;
}

export interface BackupKeyEnvelope {
  readonly version: typeof BACKUP_ENVELOPE_VERSION;
  readonly kdf: BackupEnvelopeKdf;
  readonly cipher: "aes-256-gcm";
  /** Base64url. */
  readonly iv: string;
  /** Base64url. */
  readonly authTag: string;
  /** Base64url: the encrypted keyring JSON. */
  readonly ciphertext: string;
}

export class BackupEnvelopeError extends Error {
  constructor(detail: string) {
    super(`the backup key envelope is invalid: ${detail}`);
    this.name = "BackupEnvelopeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function base64url(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new BackupEnvelopeError(`${field} must be non-empty base64url`);
  }

  return value;
}

/** Validates an envelope read from disk or a vault, field by field. */
export function parseBackupKeyEnvelope(value: unknown): BackupKeyEnvelope {
  if (!isRecord(value)) {
    throw new BackupEnvelopeError("it must be a JSON object");
  }

  if (value["version"] !== BACKUP_ENVELOPE_VERSION) {
    throw new BackupEnvelopeError(
      `version must be "${BACKUP_ENVELOPE_VERSION}", received ${JSON.stringify(value["version"])}`,
    );
  }

  const kdf = value["kdf"];

  if (!isRecord(kdf)) {
    throw new BackupEnvelopeError("kdf must be an object");
  }

  if (kdf["name"] !== "scrypt") {
    throw new BackupEnvelopeError(
      `kdf.name must be "scrypt", received ${JSON.stringify(kdf["name"])}`,
    );
  }

  const n = kdf["n"];
  const r = kdf["r"];
  const p = kdf["p"];
  const keyLength = kdf["keyLength"];

  for (const [field, candidate] of [
    ["n", n],
    ["r", r],
    ["p", p],
    ["keyLength", keyLength],
  ] as const) {
    if (!Number.isInteger(candidate) || (candidate as number) < 1) {
      throw new BackupEnvelopeError(`kdf.${field} must be a positive whole number`);
    }
  }

  if (keyLength !== 32) {
    throw new BackupEnvelopeError("kdf.keyLength must be 32; the cipher is AES-256-GCM");
  }

  if (value["cipher"] !== "aes-256-gcm") {
    throw new BackupEnvelopeError(
      `cipher must be "aes-256-gcm", received ${JSON.stringify(value["cipher"])}`,
    );
  }

  return {
    version: BACKUP_ENVELOPE_VERSION,
    kdf: {
      name: "scrypt",
      salt: base64url(kdf["salt"], "kdf.salt"),
      n: n as number,
      r: r as number,
      p: p as number,
      keyLength: 32,
    },
    cipher: "aes-256-gcm",
    iv: base64url(value["iv"], "iv"),
    authTag: base64url(value["authTag"], "authTag"),
    ciphertext: base64url(value["ciphertext"], "ciphertext"),
  };
}

/**
 * The text the envelope's authentication covers: everything except the
 * ciphertext, so a tampered KDF cost or a swapped IV fails before a key is
 * derived. JSON with a fixed field order, so the writer and the reader agree
 * on the exact bytes without a delimiter that a field could forge.
 */
export function backupEnvelopeAad(envelope: BackupKeyEnvelope): string {
  return JSON.stringify({
    version: envelope.version,
    kdf: {
      name: envelope.kdf.name,
      salt: envelope.kdf.salt,
      n: envelope.kdf.n,
      r: envelope.kdf.r,
      p: envelope.kdf.p,
      keyLength: envelope.kdf.keyLength,
    },
    cipher: envelope.cipher,
    iv: envelope.iv,
  });
}
