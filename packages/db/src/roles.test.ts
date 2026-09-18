import { describe, expect, it } from "vitest";
import {
  apiRole,
  apiRolePasswordEnvVar,
  readRolePasswords,
  setRolePasswords,
  workerRolePasswordEnvVar,
} from "./roles.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The role module's two halves: reading a deployment's credential variables
 * without treating blank as a password, and sending the two `ALTER ROLE`
 * statements through Postgres' own `format('%L')` so the password is quoted
 * there and never assembled here.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface RecordingDatabase {
  readonly calls: readonly QueryCall[];
  readonly database: Queryable;
}

function recordingDatabase(options: { readonly formatResult?: string } = {}): RecordingDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    database: {
      async query<Row>(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });

        const rows: unknown[] =
          options.formatResult === undefined ? [] : [{ statement: options.formatResult }];

        return { rows: rows as readonly Row[] };
      },
    },
  };
}

describe("reading role passwords", () => {
  it("reads both variables", () => {
    expect(
      readRolePasswords({
        [apiRolePasswordEnvVar]: "api-secret",
        [workerRolePasswordEnvVar]: "worker-secret",
      }),
    ).toEqual({ api: "api-secret", worker: "worker-secret" });
  });

  it("treats a blank or whitespace value as not set", () => {
    expect(
      readRolePasswords({
        [apiRolePasswordEnvVar]: "   ",
        [workerRolePasswordEnvVar]: "",
      }),
    ).toEqual({});
  });

  it("leaves a role out when its variable is absent", () => {
    expect(readRolePasswords({ [apiRolePasswordEnvVar]: "api-secret" })).toEqual({
      api: "api-secret",
    });
  });
});

describe("setting role passwords", () => {
  it("asks Postgres to quote the password and runs the statement it returns", async () => {
    const { calls, database } = recordingDatabase({
      formatResult: "alter role x with password 'y'",
    });

    await setRolePasswords(database, { api: "api-secret" });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.text).toContain("format(");
    expect(calls[0]?.values).toEqual([apiRole, "api-secret"]);
    expect(calls[1]?.text).toBe("alter role x with password 'y'");
  });

  it("only touches the roles the deployment named", async () => {
    const { calls, database } = recordingDatabase({
      formatResult: "alter role x with password 'y'",
    });

    await setRolePasswords(database, { api: "api-secret" });

    const addressedRoles = calls
      .map((call) => call.values[0])
      .filter((value): value is string => typeof value === "string");

    expect(addressedRoles).toEqual([apiRole]);
  });

  it("sets no password at all when the deployment supplied none", async () => {
    const { calls, database } = recordingDatabase();

    await setRolePasswords(database, {});

    expect(calls).toEqual([]);
  });

  it("fails loudly when Postgres returned no statement", async () => {
    const { database } = recordingDatabase();

    await expect(setRolePasswords(database, { api: "api-secret" })).rejects.toThrow(/no statement/);
  });
});
