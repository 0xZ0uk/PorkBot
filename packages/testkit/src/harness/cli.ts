#!/usr/bin/env node
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { findRepoRoot } from "../paths.ts";
import { PostgresHarness, formatMilliseconds } from "./postgres.ts";
import type { PostgresHarnessOptions } from "./postgres.ts";
import { harnessStatePath } from "./state.ts";

/**
 * The harness CLI: one command per action, each of them a separate process.
 *
 *   start      boot Postgres (a container by default) and create the template
 *   migrate    apply SQL migrations to the template database
 *   snapshot   clone the migrated template into a fresh suite database
 *   destroy    drop the suites and the template, then remove the container
 *   benchmark  measure start, migrate and per-suite clone cost, then destroy
 *
 * `start` records what it booted in `.testkit/harness.json`; the later commands
 * read it, which is what makes later slices able to script a scenario or a
 * canary as a sequence of commands instead of one long opaque program.
 *
 * The same actions are the public API (`PostgresHarness`), so a vitest suite
 * does not shell out; it calls the functions this CLI calls.
 */

interface CliOptions {
  repoRoot?: string;
  state?: string;
  migrations?: string;
  name?: string;
  suites?: string;
  image?: string;
}

interface ParsedArguments {
  readonly command: string;
  readonly options: CliOptions;
  readonly json: boolean;
  readonly help: boolean;
  readonly showCredentials: boolean;
}

function usage(): string {
  return [
    "Usage: testkit <command> [options]",
    "",
    "Commands:",
    "  start      Boot Postgres and create the template database.",
    "  migrate    Apply SQL migrations to the template database.",
    "  snapshot   Clone the migrated template into a fresh suite database.",
    "  destroy    Drop every suite and the template, then remove the container.",
    "  benchmark  Measure start, migrate and per-suite clone cost, then destroy.",
    "  help       This text.",
    "",
    "Options:",
    "  --state <path>       Harness state file, relative to the repo root (default: .testkit/harness.json).",
    "  --repo-root <path>   Repository root (default: found by walking up for pnpm-workspace.yaml).",
    "  --migrations <dir>   Migration directory (default: <repo-root>/packages/db/migrations).",
    "  --name <suite>       Suite name for snapshot (default: generated).",
    "  --suites <count>     Suite count for benchmark (default: 3).",
    "  --image <image>      Postgres image for start (default: postgres:18).",
    "  --show-credentials   Print connection strings with the password; they are redacted by default.",
    "  --json               Machine-readable output; progress lines go to stderr.",
    "  --help               This text.",
    "",
    "Environment:",
    "  TESTKIT_DATABASE_URL  Attach to an existing Postgres instead of booting a container.",
    "  TESTKIT_POSTGRES_IMAGE  Override the Postgres image (must be the production major).",
    "  TESTKIT_HARNESS_STATE   State file suites read to clone the shared template.",
  ].join("\n");
}

function valueAfter(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];

  if (value === undefined) {
    throw new Error(`${flag} needs a value.`);
  }

  return value;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positional: string[] = [];
  let json = false;
  let help = false;
  let showCredentials = false;
  const options: CliOptions = {};

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    switch (argument) {
      case "--state":
        options.state = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--repo-root":
        options.repoRoot = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--migrations":
        options.migrations = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--name":
        options.name = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--suites":
        options.suites = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--image":
        options.image = valueAfter(argv, index, argument);
        index += 1;
        break;
      case "--show-credentials":
        showCredentials = true;
        break;
      case "--json":
        json = true;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (argument !== undefined) {
          positional.push(argument);
        }
    }
  }

  return { command: positional[0] ?? "help", options, json, help, showCredentials };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function appendToJobSummary(markdown: string): void {
  const summaryFile = process.env["GITHUB_STEP_SUMMARY"];

  if (summaryFile !== undefined && summaryFile !== "") {
    appendFileSync(summaryFile, `${markdown}\n`);
  }
}

function benchmarkCount(raw: string | undefined): number {
  if (raw === undefined) {
    return 3;
  }

  const count = Number(raw);

  if (!Number.isInteger(count) || count < 1 || count > 50) {
    throw new Error(`--suites must be an integer between 1 and 50, found "${raw}".`);
  }

  return count;
}

function summarize(values: readonly number[]): {
  readonly min: number;
  readonly median: number;
  readonly mean: number;
  readonly max: number;
} {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? (sorted[middle] ?? 0)
        : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
  const mean =
    sorted.length === 0 ? 0 : sorted.reduce((sum, value) => sum + value, 0) / sorted.length;

  return { min: sorted[0] ?? 0, median, mean, max: sorted[sorted.length - 1] ?? 0 };
}

function startSummary(
  harness: PostgresHarness,
  stateFile: string,
  showCredentials: boolean,
): string {
  const total = harness.timings.containerStartMs + harness.timings.postgresReadyMs;

  return [
    `Started Postgres ${harness.serverMajor} in ${formatMilliseconds(total)} ` +
      `(${harness.mode === "container" ? harness.image : "attached server"}).`,
    `Template: ${harness.templateDatabase}`,
    `Connection: ${harness.connectionString(undefined, { includePassword: showCredentials })}` +
      (showCredentials ? "" : " (password redacted; --show-credentials prints it)"),
    `State: ${stateFile}`,
  ].join("\n");
}

export async function run(argv: readonly string[]): Promise<number> {
  const { command, options, json, help, showCredentials } = parseArguments(argv);

  if (help || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const commands = ["start", "migrate", "snapshot", "destroy", "benchmark"];

  if (!commands.includes(command)) {
    process.stderr.write(`Unknown command "${command}".\n\n${usage()}\n`);
    return 2;
  }

  const log = (line: string): void => {
    (json ? process.stderr : process.stdout).write(`${line}\n`);
  };

  try {
    const repoRoot = options.repoRoot ?? findRepoRoot(process.cwd());
    const stateFile = harnessStatePath(repoRoot, options.state);
    const harnessOptions: PostgresHarnessOptions = {
      repoRoot,
      report: log,
      ...(options.migrations === undefined ? {} : { migrationsDir: options.migrations }),
      ...(options.image === undefined ? {} : { image: options.image }),
    };

    if (command === "start") {
      if (existsSync(stateFile)) {
        throw new Error(
          `A harness state file already exists at ${stateFile}. Run destroy first, or pass --state ` +
            "to start an independent harness.",
        );
      }

      const harness = await PostgresHarness.boot({ ...harnessOptions, stateFile });
      const state = harness.stateSnapshot();

      if (json) {
        printJson({
          command,
          runId: harness.runId,
          mode: harness.mode,
          image: harness.image,
          containerId: state.containerId,
          containerName: state.containerName,
          host: state.host,
          port: state.port,
          serverMajor: harness.serverMajor,
          templateDatabase: harness.templateDatabase,
          connectionString: harness.connectionString(undefined, {
            includePassword: showCredentials,
          }),
          stateFile,
          timings: harness.timings,
        });
      } else {
        process.stdout.write(`${startSummary(harness, stateFile, showCredentials)}\n`);
      }

      return 0;
    }

    // Every action except start and benchmark reads a harness someone started.
    if (command !== "benchmark" && !existsSync(stateFile)) {
      throw new Error(
        `No harness state at ${stateFile}. Run start first. If a container is left over from a crash, ` +
          "remove it with: docker rm -f $(docker ps -aq --filter label=porkbot.testkit=1)",
      );
    }

    if (command === "migrate") {
      const harness = await PostgresHarness.resume(stateFile, harnessOptions);
      const migration = await harness.migrate();

      if (json) {
        printJson({ command, ...migration });
      } else if (migration.applied.length > 0) {
        process.stdout.write(
          `Applied ${migration.applied.length} migration(s) to ${harness.templateDatabase}: ` +
            `${migration.applied.join(", ")}\n`,
        );
      } else if (migration.directoryExists) {
        process.stdout.write(
          `${harness.templateDatabase} is up to date: ${migration.skipped.length} migration(s) already applied.\n`,
        );
      }

      return 0;
    }

    if (command === "snapshot") {
      const harness = await PostgresHarness.resume(stateFile, harnessOptions);
      const suite = await harness.createSuite(options.name);
      const connectionString = harness.connectionString(suite.database, {
        includePassword: showCredentials,
      });

      if (json) {
        printJson({
          command,
          name: suite.name,
          database: suite.database,
          connectionString,
          snapshotMs: suite.snapshotMs,
        });
      } else {
        process.stdout.write(
          `Suite ${suite.name} cloned as ${suite.database} in ${formatMilliseconds(suite.snapshotMs)}.\n` +
            `Connection: ${connectionString}` +
            (showCredentials ? "\n" : " (password redacted; --show-credentials prints it)\n"),
        );
      }

      return 0;
    }

    if (command === "destroy") {
      const harness = await PostgresHarness.resume(stateFile, harnessOptions);
      const result = await harness.stop({ removeStateFile: true });

      if (json) {
        printJson({ command, stateFile, ...result });
      } else {
        process.stdout.write(
          `Dropped ${result.droppedSuites.length} suite database(s), ` +
            `${result.droppedTemplate ? "the template" : "no template"}, and ` +
            `${result.containerRemoved ? "the container" : "no container"}.\n` +
            `State file ${stateFile} removed.\n`,
        );
      }

      return 0;
    }

    if (existsSync(stateFile)) {
      throw new Error(`benchmark needs to start its own harness, but ${stateFile} already exists.`);
    }

    const count = benchmarkCount(options.suites);
    const harness = await PostgresHarness.boot({ ...harnessOptions, stateFile });
    const migration = await harness.migrate();
    const clones: { name: string; snapshotMs: number }[] = [];

    for (let index = 0; index < count; index += 1) {
      const suite = await harness.createSuite(`bench_${index + 1}`);

      clones.push({ name: suite.name, snapshotMs: suite.snapshotMs });
    }

    const destroyStarted = Date.now();

    await harness.stop({ removeStateFile: true });

    const destroyMs = Date.now() - destroyStarted;
    const perSuite = summarize(clones.map((clone) => clone.snapshotMs));

    if (json) {
      printJson({
        command,
        startup: harness.timings,
        migrations: migration.applied.length,
        clones,
        destroyMs,
        perSuite,
      });
    } else {
      const lines = [
        "| phase | ms |",
        "| --- | --- |",
        `| container start | ${Math.round(harness.timings.containerStartMs)} |`,
        `| postgres ready | ${Math.round(harness.timings.postgresReadyMs)} |`,
        `| migrate (${migration.applied.length} file(s)) | ${Math.round(harness.timings.migrateMs)} |`,
        ...clones.map((clone) => `| clone ${clone.name} | ${Math.round(clone.snapshotMs)} |`),
        `| destroy | ${Math.round(destroyMs)} |`,
      ];

      process.stdout.write(`${lines.join("\n")}\n`);
      process.stdout.write(
        `Per-suite clone: min ${formatMilliseconds(perSuite.min)}, median ` +
          `${formatMilliseconds(perSuite.median)}, mean ${formatMilliseconds(perSuite.mean)}, ` +
          `max ${formatMilliseconds(perSuite.max)} (${clones.length} suite(s)).\n`,
      );
      appendToJobSummary(
        [
          "### Testkit Postgres harness startup cost",
          "",
          `| phase | ms |`,
          `| --- | --- |`,
          `| container start | ${Math.round(harness.timings.containerStartMs)} |`,
          `| postgres ready | ${Math.round(harness.timings.postgresReadyMs)} |`,
          `| migrate | ${Math.round(harness.timings.migrateMs)} |`,
          `| per-suite clone (median) | ${Math.round(perSuite.median)} |`,
          `| destroy | ${Math.round(destroyMs)} |`,
          "",
        ].join("\n"),
      );
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (process.env["GITHUB_ACTIONS"] === "true") {
      process.stdout.write(`::error title=testkit harness::${message}\n`);
    }

    process.stderr.write(`${message}\n`);

    return 1;
  }
}

const invoked = process.argv[1];

if (invoked !== undefined && import.meta.url === pathToFileURL(path.resolve(invoked)).href) {
  process.exitCode = await run(process.argv.slice(2));
}
