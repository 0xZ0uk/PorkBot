import { spawn } from "node:child_process";
import { once } from "node:events";
import { openDatabase, queryable } from "@porkbot/db";
import { BackupError } from "./errors.ts";

/**
 * The Postgres side of a backup: the `pg_dump`/`pg_restore` pair and the few
 * administrative statements the drill needs (slice 12.3).
 *
 * The client binaries are the server's own major — the backup image copies
 * them from the pinned Postgres image, so a dump is never written by a client
 * that refuses the server's version — and they run as child processes rather
 * than in-process, because `pg_dump`'s custom format is the format `pg_restore`
 * reads, and re-implementing it would be a second, worse backup tool.
 *
 * Credentials never enter an argument list: the connection URL is split into
 * `--host/--port/--username/--dbname` and the password travels in the child's
 * `PGPASSWORD` environment, so it cannot appear in `ps` output. Diagnostics
 * are the exit code and a bounded tail of stderr with the password redacted,
 * because an error message is something the operator reads and a log uploads.
 *
 * The streamed forms are the point: `dump` hands the child's stdout to a
 * consumer as it arrives, and `restore` writes a source into the child's stdin,
 * so neither a multi-gigabyte dump nor its restore is buffered in memory. The
 * administrative statements go through `@porkbot/db`'s handle, so the driver
 * stays in the package that owns it.
 */

interface ParsedConnection {
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password: string;
  readonly database: string;
  readonly sslmode: string | undefined;
}

export interface PostgresTools {
  /**
   * Runs `pg_dump` and hands its stdout to `consume`; the returned value is
   * the consumer's. A non-zero exit raises `dump_failed` after the consumer
   * has seen the stream end, so a truncated dump is never accepted.
   */
  dump<Result>(
    connectionString: string,
    consume: (dump: AsyncIterable<Uint8Array>) => Promise<Result>,
  ): Promise<Result>;
  /** Runs `pg_restore` with `source` on its stdin. */
  restore(connectionString: string, source: AsyncIterable<Uint8Array>): Promise<void>;
  /** One query on a connection, for the canary and the readability probes. */
  query<Row>(
    connectionString: string,
    text: string,
    values?: readonly unknown[],
  ): Promise<readonly Row[]>;
  /** `create database <name>`; the name is quoted, never interpolated. */
  createDatabase(connectionString: string, name: string): Promise<void>;
  /** `drop database <name> with (force)`; idempotent. */
  dropDatabase(connectionString: string, name: string): Promise<void>;
}

const maximumDiagnosticBytes = 64 * 1024;

function parseConnection(connectionString: string): ParsedConnection {
  let url: URL;

  try {
    url = new URL(connectionString);
  } catch (error) {
    throw new BackupError("internal_error", "DATABASE_URL is not a URL", { cause: error });
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new BackupError(
      "internal_error",
      `DATABASE_URL must use the postgres:// scheme, found "${url.protocol}"`,
    );
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  if (database === "") {
    throw new BackupError("internal_error", "DATABASE_URL names no database");
  }

  return {
    host: url.hostname,
    port: url.port === "" ? 5432 : Number(url.port),
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
    sslmode: url.searchParams.get("sslmode") ?? undefined,
  };
}

function childEnvironment(connection: ParsedConnection): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PGPASSWORD: connection.password,
    ...(connection.sslmode === undefined ? {} : { PGSSLMODE: connection.sslmode }),
  };
}

function connectionArguments(connection: ParsedConnection): string[] {
  return [
    "--host",
    connection.host,
    "--port",
    String(connection.port),
    "--username",
    connection.username,
    "--dbname",
    connection.database,
    "--no-password",
  ];
}

/** Collects a bounded stderr tail, with the password redacted if it appears. */
function diagnosticCollector(connection: ParsedConnection): {
  readonly write: (chunk: Buffer) => void;
  readonly text: () => string;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;

  return {
    write(chunk: Buffer): void {
      if (bytes >= maximumDiagnosticBytes) {
        return;
      }

      const slice = chunk.subarray(0, maximumDiagnosticBytes - bytes);

      chunks.push(slice);
      bytes += slice.byteLength;
    },
    text(): string {
      const raw = Buffer.concat(chunks).toString("utf8").trim();

      return connection.password === "" ? raw : raw.split(connection.password).join("***");
    },
  };
}

function quotedIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

type QueryFunction = <Row>(text: string, values?: readonly unknown[]) => Promise<readonly Row[]>;

export function createPostgresTools(): PostgresTools {
  async function withDatabase<Result>(
    connectionString: string,
    work: (query: QueryFunction) => Promise<Result>,
  ): Promise<Result> {
    // The budget's `backupTools` pool (slice 14.6): the one connection an
    // administrative statement needs, released before the next one.
    const handle = openDatabase(connectionString, "backupTools");
    const database = queryable(handle);

    try {
      return await work(async <Row>(text: string, values?: readonly unknown[]) => {
        const result = await database.query<Row>(text, values);

        return result.rows;
      });
    } finally {
      await handle.close();
    }
  }

  return {
    async dump(connectionString, consume) {
      const connection = parseConnection(connectionString);
      const diagnostics = diagnosticCollector(connection);
      const child = spawn(
        "pg_dump",
        [
          ...connectionArguments(connection),
          "--format=custom",
          "--no-owner",
          "--no-acl",
          // The queue is Graphile's own schema and is rebuilt by the worker on
          // boot; restoring stale queue state would be noise, not recovery.
          "--exclude-schema=graphile_worker",
        ],
        { env: childEnvironment(connection), stdio: ["ignore", "pipe", "pipe"] },
      );

      child.stderr.on("data", (chunk: Buffer) => diagnostics.write(chunk));

      const exited = new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code: number | null) => resolve(code ?? -1));
      });

      const body = (async function* streamed() {
        for await (const chunk of child.stdout) {
          yield chunk as Buffer;
        }
      })();

      try {
        const result = await consume(body);
        const code = await exited;

        if (code !== 0) {
          throw new BackupError("dump_failed", `pg_dump exited with status ${code}`, {
            cause: new Error(diagnostics.text()),
          });
        }

        return result;
      } catch (error) {
        child.kill("SIGTERM");
        await exited.catch(() => undefined);

        throw error;
      }
    },

    async restore(connectionString, source) {
      const connection = parseConnection(connectionString);
      const diagnostics = diagnosticCollector(connection);
      const child = spawn(
        "pg_restore",
        [
          ...connectionArguments(connection),
          "--no-owner",
          "--no-acl",
          "--exit-on-error",
          "--single-transaction",
        ],
        { env: childEnvironment(connection), stdio: ["pipe", "ignore", "pipe"] },
      );

      child.stderr.on("data", (chunk: Buffer) => diagnostics.write(chunk));
      // A child that exits before its stdin is drained makes the next write
      // fail with EPIPE; the exit code is the real answer, so the write error
      // is not allowed to become an unhandled event.
      child.stdin.on("error", () => undefined);

      const exited = new Promise<number>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code: number | null) => resolve(code ?? -1));
      });

      try {
        for await (const chunk of source) {
          if (!child.stdin.write(Buffer.from(chunk))) {
            await once(child.stdin, "drain");
          }
        }

        child.stdin.end();
      } catch (error) {
        child.stdin.destroy();
        child.kill("SIGTERM");
        await exited.catch(() => undefined);

        throw error;
      }

      const code = await exited;

      if (code !== 0) {
        throw new BackupError("restore_failed", `pg_restore exited with status ${code}`, {
          cause: new Error(diagnostics.text()),
        });
      }
    },

    query(connectionString, text, values) {
      return withDatabase(connectionString, (query) => query(text, values));
    },

    async createDatabase(connectionString, name) {
      await withDatabase(connectionString, (query) =>
        query(`create database ${quotedIdentifier(name)}`),
      );
    },

    async dropDatabase(connectionString, name) {
      await withDatabase(connectionString, (query) =>
        query(`drop database if exists ${quotedIdentifier(name)} with (force)`),
      );
    },
  };
}

/**
 * A scratch database name for one drill. The prefix is fixed so a crashed
 * drill's leftovers are recognizable, and the suffix is random so two drills
 * on one server never collide.
 */
export function scratchDatabaseName(suffix: string): string {
  return `porkbot_restore_drill_${suffix}`;
}

/** The same server, addressed at another database. */
export function databaseUrl(connectionString: string, database: string): string {
  const url = new URL(connectionString);

  url.pathname = `/${encodeURIComponent(database)}`;

  return url.toString();
}
