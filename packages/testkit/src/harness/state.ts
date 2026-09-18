import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The harness state file is what makes each CLI action a separate command.
 * `start` boots a container and records where it is; `migrate`, `snapshot` and
 * `destroy` read that record instead of needing one long-lived process. It is
 * written under `.testkit/` (gitignored) with mode 0600, because it holds the
 * throwaway container's superuser password — a test credential, but still a
 * credential, and state files that hold one should not be world-readable.
 */

export const harnessStateVersion = 1;

export const harnessStateRelativePath = path.join(".testkit", "harness.json");

export interface HarnessSuiteRecord {
  readonly name: string;
  readonly database: string;
  readonly createdAt: string;
  readonly snapshotMs: number;
}

export interface HarnessTimings {
  /** Time the `docker run` command itself took. */
  readonly containerStartMs: number;
  /** Time from the container existing to a successful query against it. */
  readonly postgresReadyMs: number;
  /** Time the last `migrate` took to apply SQL to the template. */
  readonly migrateMs: number;
}

export interface HarnessState {
  readonly version: typeof harnessStateVersion;
  readonly runId: string;
  readonly mode: "container" | "external";
  readonly image: string;
  readonly containerId: string | null;
  readonly containerName: string | null;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly ssl: boolean;
  readonly maintenanceDatabase: string;
  readonly templateDatabase: string;
  /** The migrations directory `start` was given, so later commands default to it. */
  readonly migrationsDirectory: string;
  readonly serverMajor: number;
  readonly migrated: boolean;
  readonly migrations: readonly string[];
  readonly suites: readonly HarnessSuiteRecord[];
  readonly timings: HarnessTimings;
}

/**
 * Resolves a state file the same way from anywhere: relative paths are relative
 * to the repository root, not to whatever package directory a command happens
 * to run from. The default is the gitignored `<repo-root>/.testkit/harness.json`.
 */
export function harnessStatePath(repoRoot: string, file?: string): string {
  return path.resolve(repoRoot, file ?? harnessStateRelativePath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];

  if (typeof value !== "string" || value === "") {
    throw new Error(`${where} is missing a non-empty "${key}".`);
  }

  return value;
}

function requireNumber(record: Record<string, unknown>, key: string, where: string): number {
  const value = record[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${where} is missing a numeric "${key}".`);
  }

  return value;
}

function requireBoolean(record: Record<string, unknown>, key: string, where: string): boolean {
  const value = record[key];

  if (typeof value !== "boolean") {
    throw new Error(`${where} is missing a boolean "${key}".`);
  }

  return value;
}

function requireStringArray(
  record: Record<string, unknown>,
  key: string,
  where: string,
): readonly string[] {
  const value = record[key];

  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${where} is missing a string array "${key}".`);
  }

  return value as readonly string[];
}

function parseSuiteRecord(value: unknown, where: string): HarnessSuiteRecord {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object.`);
  }

  return {
    name: requireString(value, "name", where),
    database: requireString(value, "database", where),
    createdAt: requireString(value, "createdAt", where),
    snapshotMs: requireNumber(value, "snapshotMs", where),
  };
}

function parseTimings(value: unknown, where: string): HarnessTimings {
  if (!isRecord(value)) {
    throw new Error(`${where} must be an object.`);
  }

  return {
    containerStartMs: requireNumber(value, "containerStartMs", where),
    postgresReadyMs: requireNumber(value, "postgresReadyMs", where),
    migrateMs: requireNumber(value, "migrateMs", where),
  };
}

/**
 * Structural validation only, and deliberately strict: a state file that is
 * four structural mistakes deep should fail here with the field named, not as a
 * `pg` error three commands later.
 */
export function parseHarnessState(value: unknown): HarnessState {
  if (!isRecord(value)) {
    throw new Error("The harness state file must contain a JSON object.");
  }

  if (value["version"] !== harnessStateVersion) {
    throw new Error(
      `The harness state file is version ${JSON.stringify(value["version"])}, but this testkit reads ` +
        `version ${harnessStateVersion}. Run destroy (or delete the file) and start again.`,
    );
  }

  const mode = value["mode"];

  if (mode !== "container" && mode !== "external") {
    throw new Error(
      `The harness state file has mode ${JSON.stringify(mode)}; expected container or external.`,
    );
  }

  const rawContainerId = value["containerId"];
  const rawContainerName = value["containerName"];

  if (rawContainerId !== null && typeof rawContainerId !== "string") {
    throw new Error(
      'The harness state file has a "containerId" that is neither a string nor null.',
    );
  }

  if (rawContainerName !== null && typeof rawContainerName !== "string") {
    throw new Error(
      'The harness state file has a "containerName" that is neither a string nor null.',
    );
  }

  const rawSuites = value["suites"];

  if (!Array.isArray(rawSuites)) {
    throw new Error('The harness state file is missing the "suites" array.');
  }

  return {
    version: harnessStateVersion,
    runId: requireString(value, "runId", "The harness state"),
    mode,
    image: requireString(value, "image", "The harness state"),
    containerId: rawContainerId,
    containerName: rawContainerName,
    host: requireString(value, "host", "The harness state"),
    port: requireNumber(value, "port", "The harness state"),
    user: requireString(value, "user", "The harness state"),
    password: requireString(value, "password", "The harness state"),
    ssl: requireBoolean(value, "ssl", "The harness state"),
    maintenanceDatabase: requireString(value, "maintenanceDatabase", "The harness state"),
    templateDatabase: requireString(value, "templateDatabase", "The harness state"),
    migrationsDirectory: requireString(value, "migrationsDirectory", "The harness state"),
    serverMajor: requireNumber(value, "serverMajor", "The harness state"),
    migrated: requireBoolean(value, "migrated", "The harness state"),
    migrations: requireStringArray(value, "migrations", "The harness state"),
    suites: rawSuites.map((suite, index) =>
      parseSuiteRecord(suite, `The harness state's suites[${index}]`),
    ),
    timings: parseTimings(value["timings"], 'The harness state\'s "timings"'),
  };
}

export function readHarnessState(file: string): HarnessState {
  const raw = readFileSync(file, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`, { cause: error });
  }

  return parseHarnessState(parsed);
}

/** Atomic write: readers never observe a half-written state file. */
export function writeHarnessState(file: string, state: HarnessState): void {
  mkdirSync(path.dirname(file), { recursive: true });

  const temporary = `${file}.${process.pid}.tmp`;

  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, file);
}

export function removeHarnessState(file: string): void {
  rmSync(file, { force: true });
}
