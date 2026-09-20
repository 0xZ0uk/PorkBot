import { randomUUID } from "node:crypto";
import { backupPostgresKey } from "@porkbot/core";
import { createCredentialKeyring } from "@porkbot/db";
import type { BackupLedger, BackupRunRecord, BackupStatus, SettleBackupRun } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createBackupArchive } from "./archive.ts";
import { createMemoryStorage } from "../test/memory-storage.ts";
import { BackupError } from "./errors.ts";
import type { PostgresTools } from "./postgres.ts";
import { performBackupRun } from "./run.ts";

/**
 * One run, end to end over fakes: a recording ledger, an in-memory storage for
 * both sides, and a `PostgresTools` whose dump is a byte string. The suite
 * proves the order and the settling — canary before dump, homes through the
 * storage seam, retention protecting the run it just wrote, a failure settling
 * the row with a closed code, and the drill following a successful backup with
 * the canary comparison that makes it meaningful.
 */

const logger = createLogger({ service: "backup-test", level: "error" });

interface RecordedLedger {
  readonly ledger: BackupLedger;
  readonly runs: BackupRunRecord[];
  readonly settled: readonly SettleBackupRun[];
  readonly drillSettled: readonly { readonly status: string; readonly errorCode?: string }[];
  readonly canaries: readonly string[];
  readonly drills: readonly string[];
  last(): BackupRunRecord | undefined;
}

function recordingLedger(): RecordedLedger {
  const runs: BackupRunRecord[] = [];
  const settled: SettleBackupRun[] = [];
  const drillSettled: { readonly status: string; readonly errorCode?: string }[] = [];
  const canaries: string[] = [];
  const drills: string[] = [];
  let current: BackupRunRecord | undefined;

  const make = (overrides: Partial<BackupRunRecord>): BackupRunRecord => ({
    id: randomUUID(),
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
    canaryToken: randomUUID(),
    postgresKey: null,
    postgresSize: null,
    postgresChecksum: null,
    homesCount: 0,
    homesBytes: 0,
    prunedObjects: 0,
    errorCode: null,
    drillStatus: null,
    drillStartedAt: null,
    drillFinishedAt: null,
    drillCanaryVerified: false,
    drillErrorCode: null,
    ...overrides,
  });

  const ledger: BackupLedger = {
    async beginRun(input) {
      current = make({ canaryToken: input.canaryToken });
      runs.push(current);

      return current;
    },
    async writeCanary(token) {
      canaries.push(token);
    },
    async settleRun(id, patch) {
      settled.push(patch);

      const next = make({
        id,
        status: patch.status,
        finishedAt: new Date(),
        postgresKey: patch.postgresKey ?? null,
        postgresSize: patch.postgresSize ?? null,
        postgresChecksum: patch.postgresChecksum ?? null,
        homesCount: patch.homesCount ?? 0,
        homesBytes: patch.homesBytes ?? 0,
        prunedObjects: patch.prunedObjects ?? 0,
        errorCode: patch.errorCode ?? null,
        drillStatus: current?.drillStatus ?? null,
      });

      current = next;

      return next;
    },
    async beginDrill(id) {
      drills.push(id);

      const next = make({ ...current, id, drillStatus: "running", drillStartedAt: new Date() });

      current = next;

      return next;
    },
    async settleDrill(id, patch) {
      drillSettled.push({
        status: patch.status,
        ...(patch.errorCode === undefined ? {} : { errorCode: patch.errorCode }),
      });

      const next = make({
        ...current,
        id,
        drillStatus: patch.status,
        drillFinishedAt: new Date(),
        drillCanaryVerified: patch.canaryVerified,
        drillErrorCode: patch.errorCode ?? null,
      });

      current = next;

      return next;
    },
  };

  return { ledger, runs, settled, drillSettled, canaries, drills, last: () => current };
}

interface FakePostgres extends PostgresTools {
  readonly created: readonly string[];
  readonly dropped: readonly string[];
  readonly restored: readonly string[];
}

function fakePostgres(
  options: {
    readonly dumpBytes?: Buffer;
    readonly failDump?: boolean;
    /** What the restored database holds; defaults to the run's own canary. */
    readonly canary?: () => string | null;
  } = {},
): FakePostgres {
  const created: string[] = [];
  const dropped: string[] = [];
  const restored: string[] = [];
  const fake: FakePostgres = {
    created,
    dropped,
    restored,
    async dump(_connectionString, consume) {
      if (options.failDump === true) {
        throw new BackupError("dump_failed", "the dump refused");
      }

      return consume(
        (async function* body() {
          yield options.dumpBytes ?? Buffer.from("fake dump bytes");
        })(),
      );
    },
    async restore(connectionString) {
      restored.push(connectionString);
    },
    async query<Row>(_connectionString: string, text: string): Promise<readonly Row[]> {
      if (text.includes("backup_canary")) {
        const token = options.canary?.() ?? null;

        return (token === null ? [] : [{ token }]) as unknown as readonly Row[];
      }

      if (text.includes("information_schema")) {
        return [{ tables: 42 }] as unknown as readonly Row[];
      }

      if (text.includes("from space")) {
        return [{ spaces: 1 }] as unknown as readonly Row[];
      }

      return [] as unknown as readonly Row[];
    },
    async createDatabase(_connectionString, name) {
      created.push(name);
    },
    async dropDatabase(_connectionString, name) {
      dropped.push(name);
    },
  };

  return fake;
}

function emptyStatus(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    lastRun: undefined,
    lastSuccess: undefined,
    lastDrill: undefined,
    lastDrillRun: undefined,
    ...overrides,
  };
}

function dependencies(overrides: {
  readonly ledger: BackupLedger;
  readonly destination?: ReturnType<typeof createMemoryStorage>;
  readonly homes?: ReturnType<typeof createMemoryStorage>;
  readonly postgres?: FakePostgres;
  readonly canary?: () => string | null;
  readonly drillIntervalDays?: number;
}) {
  const destination = overrides.destination ?? createMemoryStorage();
  const homes = overrides.homes ?? createMemoryStorage();
  const postgres = overrides.postgres ?? fakePostgres();
  const canary = overrides.canary ?? (() => null);

  return {
    postgres,
    destination,
    homes,
    dependencies: {
      ledger: overrides.ledger,
      archive: createBackupArchive({
        storage: destination,
        keyring: createCredentialKeyring({
          activeKeyId: "k1",
          keys: [{ id: "k1", key: Buffer.alloc(32, 1).toString("base64") }],
        }),
      }),
      homes,
      postgres,
      connectionString: "postgres://user:pass@localhost:5432/porkbot",
      readCanary: {
        read: async () => canary(),
      },
      logger,
      retentionDays: 30,
      drillIntervalDays: overrides.drillIntervalDays ?? 30,
      now: () => new Date("2026-09-20T03:00:00.000Z"),
    },
  };
}

describe("a backup run", () => {
  it("writes the canary first, stores the dump and copies the homes", async () => {
    const ledger = recordingLedger();
    const homes = createMemoryStorage({
      initial: {
        "computer-snapshots/aa/bb.tar": "home bytes",
        "bots/other/notes.txt": "not a home",
      },
    });
    const { dependencies: deps, destination } = dependencies({ ledger: ledger.ledger, homes });

    const settled = await performBackupRun(deps, emptyStatus());

    expect(settled.status).toBe("succeeded");
    expect(ledger.canaries).toEqual([ledger.runs[0]?.canaryToken]);
    expect(settled.postgresKey).toBe(backupPostgresKey(settled.id));
    expect(settled.postgresSize).toBeGreaterThan(0);
    expect(settled.homesCount).toBe(1);
    expect([...destination.objects.keys()].some((key) => key.startsWith("backups/homes/"))).toBe(
      true,
    );
    expect(ledger.settled).toHaveLength(1);
    expect(ledger.settled[0]?.errorCode).toBeUndefined();
  });

  it("prunes objects older than the window and protects the run it just wrote", async () => {
    const ledger = recordingLedger();
    const destination = createMemoryStorage({
      initial: {
        "backups/postgres/old.dump.enc": "old",
        "backups/homes/old/computer-snapshots/x.tar.enc": "old",
      },
      lastModified: "2020-01-01T00:00:00.000Z",
    });
    const { dependencies: deps } = dependencies({ ledger: ledger.ledger, destination });

    const settled = await performBackupRun(deps, emptyStatus());

    expect(settled.prunedObjects).toBe(2);
    expect([...destination.objects.keys()].sort()).toEqual([backupPostgresKey(settled.id)]);
  });

  it("settles the row failed with a closed code when the dump refuses", async () => {
    const ledger = recordingLedger();
    const postgres = fakePostgres({ failDump: true });
    const { dependencies: deps } = dependencies({ ledger: ledger.ledger, postgres });

    const settled = await performBackupRun(deps, emptyStatus());

    expect(settled.status).toBe("failed");
    expect(settled.errorCode).toBe("dump_failed");
    expect(ledger.drills).toEqual([]);
  });

  it("runs the drill after the first successful backup and verifies the canary", async () => {
    const ledger = recordingLedger();
    const postgres = fakePostgres();
    const { dependencies: deps } = dependencies({
      ledger: ledger.ledger,
      postgres,
      canary: () => ledger.last()?.canaryToken ?? null,
    });

    const settled = await performBackupRun(deps, emptyStatus());

    expect(ledger.drills).toEqual([settled.id]);
    expect(postgres.created).toHaveLength(1);
    expect(postgres.dropped).toEqual(postgres.created);
    expect(postgres.restored[0]).toContain(postgres.created[0] ?? "");
    expect(ledger.drillSettled).toEqual([{ status: "succeeded" }]);
  });

  it("records a drill that restored the wrong data as a failed drill", async () => {
    const ledger = recordingLedger();
    const postgres = fakePostgres();
    const { dependencies: deps } = dependencies({
      ledger: ledger.ledger,
      postgres,
      canary: () => "11111111-1111-1111-1111-111111111111",
    });

    const settled = await performBackupRun(deps, emptyStatus());

    expect(settled.status).toBe("succeeded");
    expect(ledger.drillSettled).toEqual([{ status: "failed", errorCode: "canary_mismatch" }]);
    expect(postgres.dropped).toEqual(postgres.created);
  });

  it("skips the drill when one succeeded inside the interval", async () => {
    const ledger = recordingLedger();
    const postgres = fakePostgres();
    const { dependencies: deps } = dependencies({
      ledger: ledger.ledger,
      postgres,
      canary: () => ledger.last()?.canaryToken ?? null,
    });
    const previousRun: BackupRunRecord = {
      id: "previous",
      status: "succeeded",
      startedAt: new Date("2026-09-19T03:00:00.000Z"),
      finishedAt: new Date("2026-09-19T03:04:00.000Z"),
      canaryToken: randomUUID(),
      postgresKey: null,
      postgresSize: null,
      postgresChecksum: null,
      homesCount: 0,
      homesBytes: 0,
      prunedObjects: 0,
      errorCode: null,
      drillStatus: "succeeded",
      drillStartedAt: new Date("2026-09-19T03:05:00.000Z"),
      drillFinishedAt: new Date("2026-09-19T03:06:00.000Z"),
      drillCanaryVerified: true,
      drillErrorCode: null,
    };
    const previous = emptyStatus({ lastSuccess: previousRun, lastDrill: previousRun });

    await performBackupRun(deps, previous);

    expect(ledger.drills).toEqual([]);
  });
});
