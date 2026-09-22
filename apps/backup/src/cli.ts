import { existsSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { BACKUP_OBJECT_PREFIX, isBackupDue } from "@porkbot/core";
import { createBackupStatusReader, openDatabase, queryable, withBackupRunLock } from "@porkbot/db";
import type { CredentialKeyring } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { createBackupArchive } from "./archive.ts";
import { backupKeyringFromEnvironment, keyringKeyIds } from "./cipher.ts";
import { loadBackupKeys, loadBackupPaths } from "./config.ts";
import type { BackupPaths } from "./config.ts";
import { restoreBackupInto } from "./drill.ts";
import { keyringFromEnvelopeFile, writeKeyEnvelope } from "./envelope.ts";
import { BackupError, backupErrorDetail, classifyBackupError } from "./errors.ts";
import { readBackupEnvironment } from "./environment.ts";
import { createPostgresTools } from "./postgres.ts";
import { latestPostgresObject, performBackupRun } from "./run.ts";

/**
 * The backup job's operator surface (slice 12.3).
 *
 * Four commands, and each answers a question the acceptance criteria name:
 *
 *   - `run` takes a backup now (the schedule is the loop's; an operator
 *     asking is the force), optionally taking the drill too when one is due.
 *   - `status` reports the ledger, the destination's object counts and the
 *     envelope's location, so "is this deployment backed up?" is one command.
 *   - `restore` is the recovery path: it opens the sealed envelope when the
 *     environment keyring is gone, restores a named object (or the newest) into
 *     a database the operator names, and proves the result is readable.
 *   - `envelope` rewrites the sealed key envelope and prints where it is; the
 *     file is what an operator copies off the host.
 *
 * Output that a script reads is JSON on stdout; log lines go to stderr through
 * the shared logger. No command prints key material or a passphrase.
 */

const logger = createLogger({
  service: "@porkbot/backup",
  // The command's stdout is a machine-readable result; diagnostics belong on
  // stderr so callers can safely pipe the result into a parser.
  write: (line) => process.stderr.write(line),
});

const usage = `Usage: porkbot-backup <command> [options]

Commands:
  run        Take a backup now; add --if-due to respect the nightly schedule or
             --force-drill to run the restore drill even when it is not due.
  status     Print the ledger, the destination's object counts and the envelope.
  restore    Restore a backup into a new database: --latest or --key <object key>,
             --database <name>, and optionally --envelope <path> when the
             environment keyring is unavailable.
  envelope   Rewrite the sealed key envelope and print its path.
`;

function usageError(message: string): never {
  process.stderr.write(`${message}\n\n${usage}`);
  process.exit(2);
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      key: { type: "string" },
      latest: { type: "boolean" },
      database: { type: "string" },
      envelope: { type: "string" },
      "if-due": { type: "boolean" },
      "force-drill": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  const command = positionals[0];

  if (values.help === true || command === undefined) {
    process.stdout.write(usage);

    return command === undefined && values.help !== true ? 2 : 0;
  }

  const environment = readBackupEnvironment();
  const paths = loadBackupPaths(environment, logger);
  // The budget's `backup` pool (slice 14.6): the ledger handle the process
  // holds for the command's lifetime.
  const handle = openDatabase(paths.connectionString, "backup");
  const database = queryable(handle);

  try {
    switch (command) {
      case "run": {
        const keys = loadBackupKeys(environment);
        const archive = createBackupArchive({ storage: paths.destination, keyring: keys.keyring });
        return await withBackupRunLock(handle, async ({ ledger, reader }) => {
          const previous = await reader.status();

          if (
            values["if-due"] === true &&
            !isBackupDue(new Date(), previous.lastRun?.startedAt ?? null, paths.schedule)
          ) {
            process.stdout.write(`${JSON.stringify({ status: "skipped" })}\n`);

            return 0;
          }

          const settled = await performBackupRun(
            {
              ledger,
              archive,
              homes: paths.homes,
              postgres: createPostgresTools(),
              connectionString: paths.connectionString,
              logger,
              retentionDays: paths.retentionDays,
              drillIntervalDays: paths.drillIntervalDays,
              forceDrill: values["force-drill"] === true,
              now: () => new Date(),
            },
            previous,
          );

          await writeKeyEnvelope(paths.envelopePath, keys.keyring, keys.envelopePassphrase);
          process.stdout.write(`${JSON.stringify(settled)}\n`);

          return settled.status === "succeeded" ? 0 : 1;
        });
      }

      case "status": {
        const reader = createBackupStatusReader(database);
        const archive = createBackupArchive({
          storage: paths.destination,
          keyring: backupKeyringFromEnvironmentOrPlaceholder(environment),
        });
        const status = await reader.status();
        const postgresObjects = await archive.list(`${BACKUP_OBJECT_PREFIX}/postgres/`);
        const homeObjects = await archive.list(`${BACKUP_OBJECT_PREFIX}/homes/`);
        const report = {
          lastRun: status.lastRun ?? null,
          lastSuccess: status.lastSuccess ?? null,
          lastDrill: status.lastDrill ?? null,
          objects: {
            postgres: postgresObjects.length,
            homes: homeObjects.length,
            bytes: [...postgresObjects, ...homeObjects].reduce(
              (total, object) => total + object.size,
              0,
            ),
          },
          envelope: {
            path: paths.envelopePath,
            present: existsSync(paths.envelopePath),
          },
          destination: {
            kind: (environment.PORKBOT_BACKUP_S3_ENDPOINT ?? "").trim() === "" ? "local" : "s3",
            ...((environment.PORKBOT_BACKUP_S3_ENDPOINT ?? "").trim() === ""
              ? { root: paths.backupDirectory }
              : {}),
          },
        };

        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

        return 0;
      }

      case "restore": {
        const databaseName = values.database;

        if (databaseName === undefined || databaseName.trim() === "") {
          usageError("restore needs --database <name>");
        }

        const archive = createBackupArchive({
          storage: paths.destination,
          keyring: await resolveKeyringAsync(paths, values.envelope, environment),
        });
        const objectKey =
          values.key ??
          (values.latest === true ? (await latestPostgresObject(archive))?.key : undefined);

        if (objectKey === undefined) {
          usageError(
            "restore needs --key <object key> or --latest, and a backup object must exist",
          );
        }

        const outcome = await restoreBackupInto(
          {
            postgres: createPostgresTools(),
            archive,
            connectionString: paths.connectionString,
            logger,
          },
          { objectKey, database: databaseName },
        );

        process.stdout.write(`${JSON.stringify({ database: databaseName, ...outcome })}\n`);

        return 0;
      }

      case "envelope": {
        const keys = loadBackupKeys(environment);

        await writeKeyEnvelope(paths.envelopePath, keys.keyring, keys.envelopePassphrase);
        process.stdout.write(
          `${JSON.stringify({
            path: paths.envelopePath,
            keyIds: keyringKeyIds(keys.keyring),
          })}\n`,
        );

        return 0;
      }

      default:
        usageError(`unknown command "${command}"`);
    }
  } finally {
    await handle.close();
  }
}

/** The archive needs a keyring even to list; a placeholder is never used to decrypt. */
function backupKeyringFromEnvironmentOrPlaceholder(
  env: Readonly<Record<string, string | undefined>>,
): CredentialKeyring {
  try {
    return backupKeyringFromEnvironment(env);
  } catch {
    // `list` never touches the keyring; a placeholder keeps `status` usable on
    // a host whose keyring lives only in the sealed envelope.
    return { activeKeyId: "unavailable", keys: new Map([["unavailable", Buffer.alloc(32)]]) };
  }
}

async function resolveKeyringAsync(
  paths: BackupPaths,
  envelopePath: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CredentialKeyring> {
  if ((env["PORKBOT_BACKUP_KEYS"] ?? "").trim() !== "") {
    return backupKeyringFromEnvironment(env);
  }

  const passphrase = (env["PORKBOT_BACKUP_ENVELOPE_PASSPHRASE"] ?? "").trim();

  if (passphrase === "") {
    throw new BackupError(
      "config_invalid",
      "set PORKBOT_BACKUP_KEYS, or PORKBOT_BACKUP_ENVELOPE_PASSPHRASE to open the sealed envelope",
    );
  }

  return keyringFromEnvelopeFile(envelopePath ?? paths.envelopePath, passphrase);
}

try {
  process.exitCode = await main();
} catch (error) {
  logger.error("the backup command failed", {
    code: classifyBackupError(error),
    detail: backupErrorDetail(error),
  });
  process.exitCode = 1;
}
