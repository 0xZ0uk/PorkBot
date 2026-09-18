import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "pg";
import type { ClientConfig } from "pg";
import { findRepoRoot } from "../paths.ts";
import {
  registerContainerCleanup,
  removeContainer,
  requireDocker,
  startPostgresContainer,
} from "./docker.ts";
import { applyMigrations } from "./migrations.ts";
import type { MigrationReport } from "./migrations.ts";
import {
  harnessStatePath,
  readHarnessState,
  removeHarnessState,
  writeHarnessState,
  harnessStateVersion,
} from "./state.ts";
import type { HarnessState, HarnessSuiteRecord, HarnessTimings } from "./state.ts";

/**
 * Postgres-per-suite isolation, in one place.
 *
 * A harness is one Postgres container (or one attached server) plus one
 * template database that has the application's migrations applied. A suite is a
 * database cloned from that template with `CREATE DATABASE ... TEMPLATE`, which
 * is a file-level copy on the server: it is how two suites running in parallel
 * get the same schema without seeing each other's rows, and it is why a suite
 * costs a clone rather than a container boot.
 *
 * The container is the production major. Production runs Postgres 18, and a
 * version assertion is not a comment: `waitForPostgres` reads
 * `server_version_num` and `assertProductionMajor` fails the boot if the server
 * is anything else, so a wrong image is a red tier rather than a subtly
 * different database.
 *
 * Nothing here decides how a test framework reports; vitest suites call
 * `createSuiteDatabase` or `startPostgresHarness`, and the CLI in this directory
 * drives the same API across separate process invocations.
 */

/** Production runs Postgres 18 (PRD stack decision 11). One number, one place. */
export const productionPostgresMajor = 18;

export const postgresImage = `postgres:${productionPostgresMajor}`;

export const harnessUser = "porkbot";
export const harnessPassword = "porkbot";
export const harnessMaintenanceDatabase = "postgres";

/** Where slice 2.1 puts the Drizzle migrations this harness will apply. */
export const defaultMigrationsDirectory = path.join("packages", "db", "migrations");

export interface PostgresTarget {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
  readonly ssl: boolean | undefined;
}

export interface PostgresHarnessOptions {
  readonly repoRoot?: string;
  readonly migrationsDir?: string;
  readonly image?: string;
  /** Attach to an existing server instead of booting a container (`TESTKIT_DATABASE_URL`). */
  readonly attachTo?: string;
  /** Persist the harness so later CLI invocations can resume it. */
  readonly stateFile?: string;
  /** Receives human-readable progress lines. Defaults to silence. */
  readonly report?: (line: string) => void;
  readonly readyTimeoutMs?: number;
}

export interface SuiteDatabase {
  readonly name: string;
  readonly database: string;
  readonly connectionString: string;
  readonly snapshotMs: number;
  destroy(): Promise<void>;
}

export interface SuiteDatabaseOptions extends PostgresHarnessOptions {
  readonly suite?: string;
}

export interface HarnessStopReport {
  readonly droppedSuites: readonly string[];
  readonly droppedTemplate: boolean;
  readonly containerRemoved: boolean;
  readonly containerId: string | null;
}

export interface StopOptions {
  readonly keepContainer?: boolean;
  readonly removeStateFile?: boolean;
}

interface ReadyServer {
  readonly serverMajor: number;
  readonly version: string;
}

function randomId(): string {
  return randomBytes(4).toString("hex");
}

function sanitizeSuffix(name: string): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return cleaned === "" ? "suite" : cleaned.slice(0, 48);
}

/** A suite name is user-facing; the database name is derived and Postgres-safe. */
export function sanitizeSuiteName(name: string): string {
  return sanitizeSuffix(name);
}

export function databaseNameForSuite(runId: string, suiteName: string): string {
  return `suite_${runId}_${sanitizeSuffix(suiteName)}`.slice(0, 63);
}

export function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function assertProductionMajor(serverMajor: number, source: string): void {
  if (serverMajor !== productionPostgresMajor) {
    throw new Error(
      `${source} runs Postgres ${serverMajor}, but production runs ${productionPostgresMajor}. ` +
        `The harness must exercise the same major as production; use postgres:${productionPostgresMajor} ` +
        "(or set TESTKIT_POSTGRES_IMAGE to an image of that major).",
    );
  }
}

/**
 * Parses an attached server's URL without ever echoing it: the URL carries a
 * password, and error messages must not leak it into CI logs.
 */
export function parseConnectionString(connectionString: string): PostgresTarget {
  let url: URL;

  try {
    url = new URL(connectionString);
  } catch (error) {
    throw new Error(`TESTKIT_DATABASE_URL is not a URL: ${(error as Error).message}`, {
      cause: error,
    });
  }

  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(
      `TESTKIT_DATABASE_URL must use the postgres:// scheme, found "${url.protocol}".`,
    );
  }

  const rawHost = url.hostname;
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const port = url.port === "" ? 5432 : Number(url.port);

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`TESTKIT_DATABASE_URL carries port "${url.port}", which is not usable.`);
  }

  const sslmode = url.searchParams.get("sslmode");
  const ssl =
    sslmode === null
      ? url.searchParams.get("ssl") === "true"
        ? true
        : undefined
      : sslmode !== "disable";

  return {
    host,
    port,
    user: decodeURIComponent(url.username) || harnessUser,
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")) || harnessMaintenanceDatabase,
    ssl,
  };
}

function clientConfig(target: PostgresTarget): ClientConfig {
  return {
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database,
    ...(target.ssl === undefined ? {} : { ssl: target.ssl }),
    connectionTimeoutMillis: 10_000,
  };
}

async function waitForPostgres(target: PostgresTarget, timeoutMs: number): Promise<ReadyServer> {
  const deadline = Date.now() + timeoutMs;

  for (let attempt = 0; ; attempt += 1) {
    try {
      const client = new Client(clientConfig(target));

      await client.connect();

      try {
        const { rows } = await client.query<{ server_version_num: string; version: string }>(
          "select current_setting('server_version_num') as server_version_num, version() as version",
        );
        const row = rows[0];
        const serverVersion = Number(row?.server_version_num ?? "");

        if (row === undefined || !Number.isInteger(serverVersion)) {
          throw new Error("Postgres answered without a server version.");
        }

        return { serverMajor: Math.floor(serverVersion / 10_000), version: row.version };
      } finally {
        await client.end();
      }
    } catch (error) {
      if (Date.now() >= deadline) {
        throw new Error(
          `Postgres at ${target.host}:${target.port} did not become ready within ${timeoutMs} ms: ` +
            `${(error as Error).message}`,
          { cause: error },
        );
      }

      await delay(Math.min(100 * 2 ** Math.min(attempt, 5), 2_000));
    }
  }
}

async function createDatabase(target: PostgresTarget, database: string): Promise<void> {
  const client = new Client(clientConfig(target));

  await client.connect();

  try {
    await client.query(`create database ${quoteIdentifier(database)}`);
  } finally {
    await client.end();
  }
}

export function formatMilliseconds(milliseconds: number): string {
  return `${Math.round(milliseconds)} ms`;
}

export class PostgresHarness {
  private state: HarnessState;
  private readonly migrationsDir: string;
  private readonly configuredStateFile: string | undefined;
  private readonly report: (line: string) => void;
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private containerRemoved = false;

  private constructor(
    state: HarnessState,
    options: {
      migrationsDir: string;
      stateFile: string | undefined;
      report: (line: string) => void;
    },
  ) {
    this.state = state;
    this.migrationsDir = options.migrationsDir;
    this.configuredStateFile = options.stateFile;
    this.report = options.report;
  }

  /**
   * Boots a container (or attaches to `TESTKIT_DATABASE_URL`) and creates the
   * empty template database. Migrations are a separate action, so the CLI's
   * `start` and `migrate` are separate commands.
   */
  static async boot(options: PostgresHarnessOptions = {}): Promise<PostgresHarness> {
    const repoRoot = options.repoRoot ?? findRepoRoot();
    const report = options.report ?? ((): void => {});
    const readyTimeoutMs = options.readyTimeoutMs ?? 90_000;
    const migrationsDir = path.resolve(
      options.migrationsDir ?? path.join(repoRoot, defaultMigrationsDirectory),
    );
    const stateFile =
      options.stateFile === undefined ? undefined : harnessStatePath(repoRoot, options.stateFile);
    const attachTo = options.attachTo ?? process.env["TESTKIT_DATABASE_URL"];
    const runId = randomId();
    const templateDatabase = `porkbot_template_${runId}`;
    let state: HarnessState;

    if (attachTo !== undefined && attachTo.trim() !== "") {
      const target = parseConnectionString(attachTo);
      const readyStarted = Date.now();
      const ready = await waitForPostgres(target, readyTimeoutMs);

      assertProductionMajor(ready.serverMajor, "The attached Postgres");
      await createDatabase(target, templateDatabase);

      state = {
        version: harnessStateVersion,
        runId,
        mode: "external",
        image: options.image ?? "(attached)",
        containerId: null,
        containerName: null,
        host: target.host,
        port: target.port,
        user: target.user,
        password: target.password,
        ssl: target.ssl ?? false,
        maintenanceDatabase: target.database,
        templateDatabase,
        migrationsDirectory: migrationsDir,
        serverMajor: ready.serverMajor,
        migrated: false,
        migrations: [],
        suites: [],
        timings: {
          containerStartMs: 0,
          postgresReadyMs: Date.now() - readyStarted,
          migrateMs: 0,
        },
      };
    } else {
      await requireDocker();

      const image =
        (options.image ?? process.env["TESTKIT_POSTGRES_IMAGE"] ?? "").trim() || postgresImage;
      const containerStarted = Date.now();
      const container = await startPostgresContainer({
        name: `porkbot-testkit-postgres-${runId}`,
        image,
        user: harnessUser,
        password: harnessPassword,
        database: harnessMaintenanceDatabase,
      });
      const containerStartMs = Date.now() - containerStarted;
      const target: PostgresTarget = {
        host: container.host,
        port: container.port,
        user: harnessUser,
        password: harnessPassword,
        database: harnessMaintenanceDatabase,
        ssl: false,
      };

      // A process-owned harness cleans up after itself on exit; a CLI harness
      // (one with a state file) must outlive this process and is removed by the
      // explicit `destroy` command instead.
      if (stateFile === undefined) {
        registerContainerCleanup(container.id);
      }

      try {
        const readyStarted = Date.now();
        const ready = await waitForPostgres(target, readyTimeoutMs);

        assertProductionMajor(ready.serverMajor, `The harness container (${image})`);
        await createDatabase(target, templateDatabase);

        state = {
          version: harnessStateVersion,
          runId,
          mode: "container",
          image,
          containerId: container.id,
          containerName: container.name,
          host: target.host,
          port: target.port,
          user: target.user,
          password: target.password,
          ssl: false,
          maintenanceDatabase: target.database,
          templateDatabase,
          migrationsDirectory: migrationsDir,
          serverMajor: ready.serverMajor,
          migrated: false,
          migrations: [],
          suites: [],
          timings: {
            containerStartMs,
            postgresReadyMs: Date.now() - readyStarted,
            migrateMs: 0,
          },
        };
      } catch (error) {
        await removeContainer(container.id).catch(() => {});
        throw error;
      }
    }

    const harness = new PostgresHarness(state, {
      migrationsDir,
      stateFile,
      report,
    });

    if (stateFile !== undefined) {
      harness.persist();
    }

    return harness;
  }

  /** Resumes a harness started by another process through its state file. */
  static async resume(
    stateFile: string,
    options: Omit<PostgresHarnessOptions, "stateFile" | "attachTo"> = {},
  ): Promise<PostgresHarness> {
    const state = readHarnessState(stateFile);
    const migrationsDir = path.resolve(options.migrationsDir ?? state.migrationsDirectory);

    return new PostgresHarness(state, {
      migrationsDir,
      stateFile,
      report: options.report ?? ((): void => {}),
    });
  }

  get runId(): string {
    return this.state.runId;
  }

  get mode(): HarnessState["mode"] {
    return this.state.mode;
  }

  get templateDatabase(): string {
    return this.state.templateDatabase;
  }

  get serverMajor(): number {
    return this.state.serverMajor;
  }

  get image(): string {
    return this.state.image;
  }

  get migrated(): boolean {
    return this.state.migrated;
  }

  get timings(): HarnessTimings {
    return this.state.timings;
  }

  get stateFile(): string | undefined {
    return this.configuredStateFile;
  }

  stateSnapshot(): HarnessState {
    return this.state;
  }

  /**
   * The password is omitted by default, because connection strings are printed
   * and pasted into logs; `includePassword: true` is for an in-process client
   * that is about to connect, not for output. The state file (mode 0600) and
   * the CLI's `--show-credentials` flag are the explicit ways to read it back.
   */
  connectionString(
    database: string = this.state.maintenanceDatabase,
    options: { readonly includePassword?: boolean } = {},
  ): string {
    const url = new URL("postgres://localhost");

    url.username = this.state.user;
    url.password = options.includePassword === true ? this.state.password : "";
    url.hostname = this.state.host;
    url.port = String(this.state.port);
    url.pathname = `/${encodeURIComponent(database)}`;

    if (this.state.ssl) {
      url.searchParams.set("sslmode", "require");
    }

    return url.toString();
  }

  async migrate(options: { migrationsDir?: string } = {}): Promise<MigrationReport> {
    const directory = options.migrationsDir ?? this.migrationsDir;
    const started = Date.now();
    const report = await this.withClient(this.state.templateDatabase, (client) =>
      applyMigrations(client, directory),
    );
    const migrateMs = Date.now() - started;

    await this.queue(async () => {
      this.state = {
        ...this.state,
        migrated: true,
        migrations: [...report.files],
        timings: { ...this.state.timings, migrateMs },
      };
      this.persist();
    });

    if (!report.directoryExists) {
      this.report(
        `no migrations directory at ${directory}; the template has the migration ledger only`,
      );
    } else if (report.applied.length === 0) {
      this.report(
        `template ${this.state.templateDatabase} is up to date (${report.files.length} migration(s), none new) ` +
          `in ${formatMilliseconds(migrateMs)}`,
      );
    } else {
      this.report(
        `applied ${report.applied.length} migration(s) to ${this.state.templateDatabase} in ` +
          `${formatMilliseconds(migrateMs)}`,
      );
    }

    return report;
  }

  /**
   * Clones the migrated template into a database this suite owns. Parallel
   * calls are safe: cloning reads the template's files with no session attached
   * to it, and each clone gets its own database name.
   */
  async createSuite(name?: string): Promise<SuiteDatabase> {
    if (!this.state.migrated) {
      throw new Error(
        "The template database has not been migrated, so a clone would not have the schema. " +
          "Run migrate (pnpm testkit:migrate) before snapshotting a suite.",
      );
    }

    const suiteName = sanitizeSuiteName(name ?? `suite_${randomId()}`);
    const database = databaseNameForSuite(this.state.runId, suiteName);
    const started = Date.now();

    try {
      await this.withClient(this.state.maintenanceDatabase, (client) =>
        client.query(
          `create database ${quoteIdentifier(database)} template ${quoteIdentifier(this.state.templateDatabase)}`,
        ),
      );
    } catch (error) {
      if ((error as { code?: string }).code === "42P04") {
        throw new Error(
          `Suite "${suiteName}" already exists (database ${database}). Destroy it first, or pick another name.`,
          { cause: error },
        );
      }

      throw error;
    }

    const snapshotMs = Date.now() - started;
    const record: HarnessSuiteRecord = {
      name: suiteName,
      database,
      createdAt: new Date().toISOString(),
      snapshotMs,
    };

    // Cloning is safe in parallel, but recording the result is a
    // read-modify-write on one `suites` array, so it goes through the queue.
    await this.queue(async () => {
      this.state = { ...this.state, suites: [...this.state.suites, record] };
      this.persist();
    });
    this.report(
      `cloned ${this.state.templateDatabase} -> ${database} in ${formatMilliseconds(snapshotMs)}`,
    );

    return this.suiteHandle(record);
  }

  /** Drops one suite database. Returns false when it did not exist. */
  async destroySuite(name: string): Promise<boolean> {
    const suiteName = sanitizeSuiteName(name);
    const record = this.state.suites.find((suite) => suite.name === suiteName);
    const database = record?.database ?? databaseNameForSuite(this.state.runId, suiteName);
    const existed = await this.databaseExists(database);

    await this.withClient(this.state.maintenanceDatabase, (client) =>
      client.query(`drop database if exists ${quoteIdentifier(database)} with (force)`),
    );

    await this.queue(async () => {
      this.state = {
        ...this.state,
        suites: this.state.suites.filter((suite) => suite.name !== suiteName),
      };
      this.persist();
    });

    return existed;
  }

  /**
   * The deterministic teardown. Suite databases are dropped by run prefix
   * rather than by what the state file happens to list, so a suite created by a
   * process that died before writing state is still destroyed. Removing the
   * container takes its anonymous volume with it.
   */
  async stop(options: StopOptions = {}): Promise<HarnessStopReport> {
    if (this.stopped) {
      return {
        droppedSuites: [],
        droppedTemplate: false,
        containerRemoved: this.containerRemoved,
        containerId: this.state.containerId,
      };
    }

    const droppedSuites: string[] = [];
    let droppedTemplate = false;

    try {
      const { rows } = await this.withClient(this.state.maintenanceDatabase, (client) =>
        client.query<{ datname: string }>(
          "select datname from pg_database where datname like $1 order by datname",
          [`suite_${this.state.runId}_%`],
        ),
      );

      for (const row of rows) {
        await this.withClient(this.state.maintenanceDatabase, (client) =>
          client.query(`drop database if exists ${quoteIdentifier(row.datname)} with (force)`),
        );
        droppedSuites.push(row.datname);
      }

      await this.withClient(this.state.maintenanceDatabase, (client) =>
        client.query(
          `drop database if exists ${quoteIdentifier(this.state.templateDatabase)} with (force)`,
        ),
      );
      droppedTemplate = true;
    } catch (error) {
      // In container mode the server is about to be removed anyway, so an
      // unreachable server is not a cleanup failure; the container removal
      // destroys the same data. An attached server must answer, because its
      // databases are the only thing cleanup can touch.
      if (this.state.mode !== "container") {
        throw error;
      }

      this.report(
        `could not drop databases before removing the container (${(error as Error).message}); ` +
          "the container removal destroys them",
      );
    }

    let containerRemoved = false;

    if (this.state.containerId !== null && options.keepContainer !== true) {
      await removeContainer(this.state.containerId);
      containerRemoved = true;
    }

    if (this.configuredStateFile !== undefined && options.removeStateFile === true) {
      removeHarnessState(this.configuredStateFile);
    }

    this.state = { ...this.state, suites: [] };
    this.stopped = true;
    this.containerRemoved = containerRemoved;

    return {
      droppedSuites,
      droppedTemplate,
      containerRemoved,
      containerId: this.state.containerId,
    };
  }

  private suiteHandle(record: HarnessSuiteRecord): SuiteDatabase {
    return {
      name: record.name,
      database: record.database,
      connectionString: this.connectionString(record.database, { includePassword: true }),
      snapshotMs: record.snapshotMs,
      destroy: async (): Promise<void> => {
        await this.destroySuite(record.name);
      },
    };
  }

  private async databaseExists(database: string): Promise<boolean> {
    const { rows } = await this.withClient(this.state.maintenanceDatabase, (client) =>
      client.query<{ present: boolean }>(
        "select exists(select 1 from pg_database where datname = $1) as present",
        [database],
      ),
    );

    return rows[0]?.present === true;
  }

  private async withClient<T>(
    database: string,
    operation: (client: Client) => Promise<T>,
  ): Promise<T> {
    const client = new Client(clientConfig(this.target(database)));

    await client.connect();

    try {
      return await operation(client);
    } finally {
      await client.end();
    }
  }

  private target(database: string): PostgresTarget {
    return {
      host: this.state.host,
      port: this.state.port,
      user: this.state.user,
      password: this.state.password,
      database,
      ssl: this.state.ssl,
    };
  }

  /**
   * Serializes state mutations. Parallel `createSuite` calls clone different
   * databases without contending (cloning attaches no session to the
   * template), but each records its result with a read-modify-write on the one
   * `suites` array; without this queue the second writer would drop the first
   * record.
   */
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);

    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  private persist(): void {
    const stateFile = this.configuredStateFile;

    if (stateFile !== undefined) {
      writeHarnessState(stateFile, this.state);
    }
  }
}

/**
 * Boots a harness and migrates its template in one call — what an in-process
 * suite fixture wants. The CLI keeps `start` and `migrate` separate because
 * they are separate actions there.
 */
export async function startPostgresHarness(
  options: PostgresHarnessOptions = {},
): Promise<PostgresHarness> {
  const harness = await PostgresHarness.boot(options);

  await harness.migrate();

  return harness;
}

/**
 * The one call a suite makes. With TESTKIT_HARNESS_STATE pointing at a harness
 * started by the CLI, the suite gets a cheap clone and leaves the shared
 * container alone; without it, the suite owns a container and `destroy()` tears
 * everything down. This is what lets CI start the harness once per run while a
 * local suite remains self-contained.
 */
export async function createSuiteDatabase(
  options: SuiteDatabaseOptions = {},
): Promise<SuiteDatabase> {
  const stateFile = options.stateFile ?? process.env["TESTKIT_HARNESS_STATE"];

  if (stateFile !== undefined && stateFile.trim() !== "") {
    // The CLI records the harness at the repository root, while a package's
    // test task runs with the package as its cwd, so a relative state path is
    // resolved from the repository root rather than from the caller.
    const resolvedStateFile = path.isAbsolute(stateFile)
      ? stateFile
      : path.resolve(options.repoRoot ?? findRepoRoot(), stateFile);

    if (!existsSync(resolvedStateFile)) {
      throw new Error(
        `TESTKIT_HARNESS_STATE points at ${resolvedStateFile}, which does not exist. Start the harness ` +
          "first (pnpm testkit:start && pnpm testkit:migrate), or unset the variable to boot a private one.",
      );
    }

    const harness = await PostgresHarness.resume(resolvedStateFile, {
      ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }),
      ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
      ...(options.report === undefined ? {} : { report: options.report }),
    });

    return harness.createSuite(options.suite);
  }

  const harness = await startPostgresHarness(options);
  const suite = await harness.createSuite(options.suite);

  return {
    ...suite,
    destroy: async (): Promise<void> => {
      await suite.destroy();
      await harness.stop({ removeStateFile: true });
    },
  };
}
