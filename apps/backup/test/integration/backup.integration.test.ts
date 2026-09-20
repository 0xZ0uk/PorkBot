import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalStorageProvider } from "@porkbot/adapters";
import { connectToSuite, createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { afterAll, describe, expect, it } from "vitest";

/**
 * The real backup and the real restore drill (slice 12.3 acceptance).
 *
 * The unit suites fake the dump; this one runs the shipped `porkbot/backup`
 * image against a migrated suite database cloned from the testkit template, so
 * the bytes that move are real `pg_dump` output, the cipher is the shipped
 * cipher, and the restore is a real `pg_restore` into a scratch database on the
 * same server. It proves what only the real tools can:
 *
 *   - the nightly run stores an encrypted object that does not contain its own
 *     plaintext (no `CREATE TABLE`, no canary token in the bytes);
 *   - the scheduled drill restores the object into a scratch database, drops
 *     it, and records the canary verdict;
 *   - retention deletes an object older than the window while keeping the run
 *     it just wrote;
 *   - the recovery path opens the sealed key envelope with its passphrase when
 *     the environment keyring is absent, and the restored database is readable.
 *
 * The image is built by `pnpm stack:up`, the same way the supervisor's
 * integration suites get theirs; a developer without a stack is told to build
 * one rather than handed a passing test that ran nothing.
 */

const image = "porkbot/backup:local";
const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const key = Buffer.alloc(32, 0x44).toString("base64");
const passphrase = "integration-envelope-passphrase";

interface DockerResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function dockerOrThrow(args: readonly string[], timeoutMs = 120_000): string {
  const result = execFileSync("docker", [...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });

  return result;
}

function imageExists(): boolean {
  try {
    dockerOrThrow(["image", "inspect", image, "--format", "{{.Id}}"]);
    return true;
  } catch {
    return false;
  }
}

/** The same suite database, addressed at a database the restore created. */
function atDatabase(suite: SuiteDatabase, database: string): SuiteDatabase {
  const url = new URL(suite.connectionString);

  url.pathname = `/${encodeURIComponent(database)}`;

  return { ...suite, database, connectionString: url.toString() };
}

function runBackupCli(
  workspace: { readonly storage: string; readonly backups: string; readonly envelope: string },
  connectionString: string,
  command: readonly string[],
  options: { readonly withKeys?: boolean } = {},
): DockerResult {
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  const args = [
    "run",
    "--rm",
    "--network",
    "host",
    "--user",
    `${String(uid)}:${String(gid)}`,
    "--env",
    `DATABASE_URL=${connectionString}`,
    "--env",
    "PORKBOT_STORAGE_DIR=/var/lib/porkbot/storage",
    "--env",
    "PORKBOT_BACKUP_DIR=/var/lib/porkbot/backups",
    "--env",
    "PORKBOT_BACKUP_ENVELOPE_DIR=/var/lib/porkbot/backup-envelope",
    "--env",
    `PORKBOT_BACKUP_ENVELOPE_PASSPHRASE=${passphrase}`,
    "--env",
    `PORKBOT_BACKUP_KEYS=${options.withKeys === false ? "" : `k1:${key}`}`,
    "--env",
    "PORKBOT_BACKUP_ACTIVE_KEY=k1",
    "--volume",
    `${workspace.storage}:/var/lib/porkbot/storage:ro`,
    "--volume",
    `${workspace.backups}:/var/lib/porkbot/backups`,
    "--volume",
    `${workspace.envelope}:/var/lib/porkbot/backup-envelope`,
    image,
    "node",
    "dist/cli.js",
    ...command,
  ];

  try {
    const stdout = dockerOrThrow(args);

    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };

    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? String(error),
    };
  }
}

describe("the nightly backup and the restore drill", () => {
  let suite: SuiteDatabase | undefined;
  let workspace: { storage: string; backups: string; envelope: string } | undefined;

  afterAll(async () => {
    if (workspace !== undefined) {
      rmSync(workspace.storage, { recursive: true, force: true });
      rmSync(workspace.backups, { recursive: true, force: true });
      rmSync(workspace.envelope, { recursive: true, force: true });
    }

    await suite?.destroy();
  });

  it("runs against the shipped image and a migrated suite database", async () => {
    expect(
      imageExists(),
      `the ${image} image is not built; run pnpm stack:up before the integration tier`,
    ).toBe(true);

    suite = await createSuiteDatabase({ suite: `backup_${suffix}` });

    const root = mkdtempSync(path.join(os.tmpdir(), "porkbot-backup-"));
    workspace = {
      storage: path.join(root, "storage"),
      backups: path.join(root, "backups"),
      envelope: path.join(root, "envelope"),
    };

    for (const directory of Object.values(workspace)) {
      mkdirSync(directory, { recursive: true });
    }

    // A home snapshot the run must copy, written through the storage seam so
    // it is the same object shape the snapshot store produces.
    const storage = new LocalStorageProvider({ root: workspace.storage });

    await storage.put({
      key: "computer-snapshots/aa/bb.tar",
      contentType: "application/x-tar",
      body: (async function* one() {
        yield Buffer.from("a bot home in the clear");
      })(),
    });

    // An expired object the retention pass must delete, in the destination's
    // own format, with its mtime moved into the past.
    const destination = new LocalStorageProvider({ root: workspace.backups });
    const expired = path.join(workspace.backups, "backups", "postgres", "old.dump.enc");

    await destination.put({
      key: "backups/postgres/old.dump.enc",
      body: (async function* one() {
        yield Buffer.from("an expired backup");
      })(),
    });
    utimesSync(expired, new Date("2020-01-01T00:00:00Z"), new Date("2020-01-01T00:00:00Z"));

    const run = runBackupCli(workspace, suite.connectionString, ["run"]);

    expect(run.status, run.stderr).toBe(0);

    const settled = JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "{}") as {
      readonly id: string;
      readonly status: string;
      readonly postgresKey: string;
      readonly drillStatus: string;
      readonly drillCanaryVerified: boolean;
      readonly homesCount: number;
      readonly prunedObjects: number;
      readonly canaryToken: string;
    };

    expect(settled.status).toBe("succeeded");
    expect(settled.drillStatus).toBe("succeeded");
    expect(settled.drillCanaryVerified).toBe(true);
    expect(settled.homesCount).toBe(1);
    expect(settled.prunedObjects).toBe(1);

    // Encrypted at rest: the object exists, is not the plaintext, and carries
    // neither a schema keyword nor the canary token.
    const objectPath = path.join(workspace.backups, settled.postgresKey);
    const ciphertext = readFileSync(objectPath);

    expect(statSync(objectPath).size).toBeGreaterThan(0);
    expect(ciphertext.includes(Buffer.from("CREATE TABLE"))).toBe(false);
    expect(ciphertext.includes(Buffer.from(settled.canaryToken))).toBe(false);
    expect(ciphertext.includes(Buffer.from("a bot home in the clear"))).toBe(false);

    // Retention kept the run it wrote and deleted the expired object.
    expect(statSync(expired, { throwIfNoEntry: false })).toBeUndefined();

    // The homes copy is an encrypted object under the run's prefix.
    const homesRoot = path.join(workspace.backups, "backups", "homes");
    const homesObjects = readFileSync(
      path.join(homesRoot, settled.id, "computer-snapshots", "aa", "bb.tar.enc"),
    );

    expect(homesObjects.includes(Buffer.from("a bot home in the clear"))).toBe(false);

    // The sealed envelope exists on its own volume and is not the keyring.
    const envelopePath = path.join(workspace.envelope, "key-envelope.json");
    const envelope = readFileSync(envelopePath, "utf8");

    expect(envelope).toContain("scrypt");
    expect(envelope).not.toContain(key);

    // The drill's scratch database is gone: only the suite's own database and
    // the template remain under the run prefix.
    const reader = await connectToSuite(suite);

    try {
      const { rows } = await reader.query<{ readonly count: string }>(
        "select count(*)::text as count from pg_database where datname like 'porkbot_restore_drill_%'",
      );

      expect(rows[0]?.count).toBe("0");

      const { rows: canary } = await reader.query<{ readonly canaryToken: string }>(
        'select canary_token as "canaryToken" from backup_run order by started_at desc limit 1',
      );

      expect(canary[0]?.canaryToken).toBe(settled.canaryToken);
    } finally {
      await reader.end();
    }
  }, 180_000);

  it("recovers from the sealed envelope when the environment keyring is gone", async () => {
    if (suite === undefined || workspace === undefined) {
      throw new Error("the suite database or workspace was not created");
    }

    const database = `porkbot_it_restore_${suffix}`;
    const restore = runBackupCli(
      workspace,
      suite.connectionString,
      ["restore", "--latest", "--database", database],
      { withKeys: false },
    );

    expect(restore.status, restore.stderr).toBe(0);

    const outcome = JSON.parse(restore.stdout.trim().split("\n").at(-1) ?? "{}") as {
      readonly database: string;
      readonly canaryToken: string | null;
      readonly tables: number;
    };

    expect(outcome.database).toBe(database);
    expect(outcome.canaryToken).not.toBeNull();
    expect(outcome.tables).toBeGreaterThan(0);

    // The restored database is readable, not merely created.
    const restored = await connectToSuite(atDatabase(suite, database));

    try {
      const { rows } = await restored.query<{ readonly count: string }>(
        "select count(*)::text as count from backup_canary",
      );

      expect(rows[0]?.count).toBe("1");
    } finally {
      await restored.end();
    }

    // Clean up the database this test created, as the operator would.
    const reader = await connectToSuite(suite);

    try {
      await reader.query(`drop database if exists "${database}" with (force)`);
    } finally {
      await reader.end();
    }
  }, 180_000);
});
