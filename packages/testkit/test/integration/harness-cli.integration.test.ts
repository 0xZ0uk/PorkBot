import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { QueryResultRow } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { containerExists, removeContainer } from "../../src/harness/docker.ts";
import { createSuiteDatabase } from "../../src/harness/postgres.ts";

/**
 * The CLI's acceptance criteria are per action, per process: `start`, `migrate`,
 * `snapshot` and `destroy` must each work as one command, because that is what
 * later slices script scenarios and canaries with. So this file runs the real
 * CLI as a child process and proves the state file carries the harness between
 * invocations.
 */

const cliPath = fileURLToPath(new URL("../../src/harness/cli.ts", import.meta.url));
const fixturesDirectory = fileURLToPath(new URL("../fixtures/migrations", import.meta.url));
const scratch = mkdtempSync(path.join(tmpdir(), "porkbot-harness-cli-"));
const stateFile = path.join(scratch, "harness.json");

let startedContainerId: string | undefined;

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(...args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        // The harness CLI's own state is enough; the attach/override variables
        // would make this file depend on the machine it runs on.
        env: { ...process.env, TESTKIT_DATABASE_URL: "", TESTKIT_POSTGRES_IMAGE: "" },
        timeout: 170_000,
        maxBuffer: 10 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const codeFromError = (error as { code?: unknown } | null)?.code;
        const code = error === null ? 0 : typeof codeFromError === "number" ? codeFromError : 1;

        resolve({ code, stdout, stderr });
      },
    );
  });
}

function parseJson<T>(result: CliResult): T {
  return JSON.parse(result.stdout) as T;
}

async function query<T extends QueryResultRow>(
  connectionString: string,
  sql: string,
): Promise<T[]> {
  const client = new Client({ connectionString });

  await client.connect();

  try {
    const { rows } = await client.query<T>(sql);

    return rows;
  } finally {
    await client.end();
  }
}

afterAll(async () => {
  if (startedContainerId !== undefined && (await containerExists(startedContainerId))) {
    await removeContainer(startedContainerId);
  }

  rmSync(scratch, { recursive: true, force: true });
});

describe("the harness CLI", () => {
  it("start boots a container and records the harness state", async () => {
    const result = await runCli(
      "start",
      "--state",
      stateFile,
      "--migrations",
      fixturesDirectory,
      "--json",
    );

    expect(result.code, result.stderr).toBe(0);

    const started = parseJson<{
      mode: string;
      containerId: string;
      serverMajor: number;
      templateDatabase: string;
      connectionString: string;
      stateFile: string;
    }>(result);

    startedContainerId = started.containerId;

    expect(started.mode).toBe("container");
    expect(started.serverMajor).toBe(18);
    expect(started.templateDatabase).toMatch(/^porkbot_template_/);
    expect(started.connectionString).toContain("postgres://");
    expect(new URL(started.connectionString).password).toBe("");
    expect(started.stateFile).toBe(stateFile);
    expect(existsSync(stateFile)).toBe(true);
    expect(await containerExists(started.containerId)).toBe(true);
  }, 120_000);

  it("snapshot before migrate fails with the reason", async () => {
    const result = await runCli("snapshot", "--state", stateFile, "--name", "early", "--json");

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not been migrated");
  }, 120_000);

  it("migrate applies the fixture migrations to the template", async () => {
    const result = await runCli("migrate", "--state", stateFile, "--json");

    expect(result.code, result.stderr).toBe(0);

    const migration = parseJson<{ applied: string[]; skipped: string[]; directoryExists: boolean }>(
      result,
    );

    expect(migration.directoryExists).toBe(true);
    expect(migration.applied).toEqual(["0001_widgets.sql", "0002_seed_widgets.sql"]);
    expect(migration.skipped).toEqual([]);
  }, 120_000);

  it("snapshot clones the template into isolated suite databases", async () => {
    // --show-credentials because this test connects with the string it reads
    // back; the default output redacts the password.
    const alphaResult = await runCli(
      "snapshot",
      "--state",
      stateFile,
      "--name",
      "alpha",
      "--show-credentials",
      "--json",
    );
    const betaResult = await runCli(
      "snapshot",
      "--state",
      stateFile,
      "--name",
      "beta",
      "--show-credentials",
      "--json",
    );

    expect(alphaResult.code, alphaResult.stderr).toBe(0);
    expect(betaResult.code, betaResult.stderr).toBe(0);

    const alpha = parseJson<{
      name: string;
      database: string;
      connectionString: string;
      snapshotMs: number;
    }>(alphaResult);
    const beta = parseJson<{ name: string; database: string; connectionString: string }>(
      betaResult,
    );

    expect(alpha.name).toBe("alpha");
    expect(beta.database).not.toBe(alpha.database);
    expect(alpha.snapshotMs).toBeGreaterThanOrEqual(0);

    await query(
      alpha.connectionString,
      "insert into widgets (id, label) values (500, 'alpha only')",
    );

    const alphaRows = await query<{ count: number }>(
      alpha.connectionString,
      "select count(*)::int as count from widgets",
    );
    const betaRows = await query<{ count: number }>(
      beta.connectionString,
      "select count(*)::int as count from widgets",
    );

    expect(alphaRows[0]?.count).toBe(2);
    expect(betaRows[0]?.count).toBe(1);
  }, 120_000);

  it("clones through the shared state file the CI job points suites at", async () => {
    const previous = process.env["TESTKIT_HARNESS_STATE"];

    process.env["TESTKIT_HARNESS_STATE"] = stateFile;

    try {
      const suite = await createSuiteDatabase({ suite: "shared_clone" });

      try {
        const rows = await query<{ count: number }>(
          suite.connectionString,
          "select count(*)::int as count from widgets",
        );

        expect(rows[0]?.count).toBe(1);
      } finally {
        await suite.destroy();
      }
    } finally {
      if (previous === undefined) {
        delete process.env["TESTKIT_HARNESS_STATE"];
      } else {
        process.env["TESTKIT_HARNESS_STATE"] = previous;
      }
    }
  }, 120_000);

  it("destroy drops the suites and the container and removes the state file", async () => {
    const result = await runCli("destroy", "--state", stateFile, "--json");

    expect(result.code, result.stderr).toBe(0);

    const destroyed = parseJson<{
      droppedSuites: string[];
      droppedTemplate: boolean;
      containerRemoved: boolean;
      containerId: string;
    }>(result);

    expect(destroyed.droppedSuites).toHaveLength(2);
    expect(
      destroyed.droppedSuites.every(
        (database) => database.includes("_alpha") || database.includes("_beta"),
      ),
    ).toBe(true);
    expect(destroyed.droppedTemplate).toBe(true);
    expect(destroyed.containerRemoved).toBe(true);
    expect(await containerExists(destroyed.containerId)).toBe(false);
    expect(existsSync(stateFile)).toBe(false);
    startedContainerId = undefined;
  }, 120_000);
});
