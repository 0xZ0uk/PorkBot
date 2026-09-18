import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parsePublishedPort, redactArguments } from "../src/harness/docker.ts";
import { listMigrations } from "../src/harness/migrations.ts";
import {
  assertProductionMajor,
  databaseNameForSuite,
  harnessUser,
  parseConnectionString,
  productionPostgresMajor,
  quoteIdentifier,
  sanitizeSuiteName,
} from "../src/harness/postgres.ts";
import {
  harnessStatePath,
  harnessStateVersion,
  parseHarnessState,
  readHarnessState,
  writeHarnessState,
} from "../src/harness/state.ts";
import type { HarnessState } from "../src/harness/state.ts";

/**
 * The parts of the harness that can be proven without a container: file
 * discovery, URL and identifier derivation, port parsing and the state file.
 * The container half is proven for real in test/integration, because a mock of
 * Docker would only prove the mock.
 */

const scratch = mkdtempSync(path.join(tmpdir(), "porkbot-harness-unit-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("migration files", () => {
  it("are applied in filename order and nothing else is", () => {
    const directory = path.join(scratch, "ordered");

    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "0002_second.sql"), "select 2;\n");
    writeFileSync(path.join(directory, "0001_first.sql"), "select 1;\n");
    writeFileSync(path.join(directory, "notes.txt"), "not a migration");

    expect(listMigrations(directory).map((file) => file.name)).toEqual([
      "0001_first.sql",
      "0002_second.sql",
    ]);
    expect(listMigrations(directory)[0]?.sql).toBe("select 1;\n");
  });

  it("are empty for a directory that does not exist", () => {
    expect(listMigrations(path.join(scratch, "absent"))).toEqual([]);
  });
});

describe("the attached-server URL", () => {
  it("reads host, port, decoded credentials and database", () => {
    const target = parseConnectionString("postgres://user:p%40ss@127.0.0.1:5433/porkbot");

    expect(target.host).toBe("127.0.0.1");
    expect(target.port).toBe(5433);
    expect(target.user).toBe("user");
    expect(target.password).toBe("p@ss");
    expect(target.database).toBe("porkbot");
    expect(target.ssl).toBeUndefined();
  });

  it("falls back to the maintenance database and the default port", () => {
    const target = parseConnectionString("postgresql://localhost");

    expect(target.host).toBe("localhost");
    expect(target.port).toBe(5432);
    expect(target.database).toBe("postgres");
    expect(target.user).toBe(harnessUser);
  });

  it("carries sslmode through", () => {
    expect(parseConnectionString("postgres://u:p@h/db?sslmode=require").ssl).toBe(true);
    expect(parseConnectionString("postgres://u:p@h/db?sslmode=disable").ssl).toBe(false);
    expect(parseConnectionString("postgres://u:p@h/db").ssl).toBeUndefined();
  });

  it("refuses a URL that is not Postgres", () => {
    expect(() => parseConnectionString("mysql://localhost/porkbot")).toThrow(/postgres:\/\//);
  });
});

describe("derived identifiers", () => {
  it("quotes identifiers", () => {
    expect(quoteIdentifier("suite_name")).toBe('"suite_name"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it("turns any suite name into a Postgres-safe suffix", () => {
    expect(sanitizeSuiteName("My Suite #1")).toBe("my_suite_1");
    expect(sanitizeSuiteName("...")).toBe("suite");
  });

  it("caps the database name at Postgres's identifier limit", () => {
    const name = databaseNameForSuite("deadbeef", "x".repeat(120));

    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith("suite_deadbeef_")).toBe(true);
  });
});

describe("the production major assertion", () => {
  it("accepts the production major and refuses anything else", () => {
    expect(() => assertProductionMajor(productionPostgresMajor, "The test server")).not.toThrow();
    expect(() => assertProductionMajor(productionPostgresMajor + 1, "The test server")).toThrow(
      /production runs/,
    );
  });
});

describe("docker port output", () => {
  it("parses IPv4 and IPv6 mappings", () => {
    expect(parsePublishedPort("127.0.0.1:49153\n")).toEqual({ host: "127.0.0.1", port: 49153 });
    expect(parsePublishedPort("[::1]:49153\n")).toEqual({ host: "::1", port: 49153 });
  });

  it("refuses output with no usable mapping", () => {
    expect(() => parsePublishedPort("\n")).toThrow(/no mapping/);
    expect(() => parsePublishedPort("127.0.0.1:not-a-port")).toThrow(/no usable port/);
  });
});

describe("docker command failure messages", () => {
  it("redact secret-looking --env values and leave the rest readable", () => {
    expect(
      redactArguments([
        "run",
        "--env",
        "POSTGRES_PASSWORD=porkbot",
        "--env",
        "POSTGRES_USER=porkbot",
        "--publish",
        "127.0.0.1::5432",
      ]),
    ).toEqual([
      "run",
      "--env",
      "POSTGRES_PASSWORD=***",
      "--env",
      "POSTGRES_USER=porkbot",
      "--publish",
      "127.0.0.1::5432",
    ]);
  });

  it("leaves an --env argument without a value alone", () => {
    expect(redactArguments(["--env", "PORKBOT_API_KEY"])).toEqual(["--env", "PORKBOT_API_KEY"]);
  });
});

describe("the harness state file", () => {
  function fixture(): HarnessState {
    return {
      version: harnessStateVersion,
      runId: "deadbeef",
      mode: "container",
      image: "postgres:18",
      containerId: "0123456789ab",
      containerName: "porkbot-testkit-postgres-deadbeef",
      host: "127.0.0.1",
      port: 49153,
      user: "porkbot",
      password: "porkbot",
      ssl: false,
      maintenanceDatabase: "postgres",
      templateDatabase: "porkbot_template_deadbeef",
      migrationsDirectory: "/repo/packages/db/migrations",
      serverMajor: 18,
      migrated: true,
      migrations: ["0001_widgets.sql"],
      suites: [
        {
          name: "alpha",
          database: "suite_deadbeef_alpha",
          createdAt: "2026-09-18T00:00:00.000Z",
          snapshotMs: 41,
        },
      ],
      timings: { containerStartMs: 1800, postgresReadyMs: 700, migrateMs: 12 },
    };
  }

  it("round-trips and keeps the test password private", () => {
    const file = path.join(scratch, "state", "harness.json");

    writeHarnessState(file, fixture());

    expect(readHarnessState(file)).toEqual(fixture());
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("refuses a version it does not understand", () => {
    expect(() => parseHarnessState({ ...fixture(), version: 99 } as unknown)).toThrow(/version 99/);
  });

  it("names the field when the shape is wrong", () => {
    expect(() => parseHarnessState({ ...fixture(), port: "not a number" } as unknown)).toThrow(
      /"port"/,
    );
  });

  it("resolves a relative path from the repository root, not the caller", () => {
    expect(harnessStatePath("/repo", ".testkit/harness.json")).toBe("/repo/.testkit/harness.json");
    expect(harnessStatePath("/repo")).toBe("/repo/.testkit/harness.json");
    expect(harnessStatePath("/repo", "/tmp/elsewhere.json")).toBe("/tmp/elsewhere.json");
  });
});
