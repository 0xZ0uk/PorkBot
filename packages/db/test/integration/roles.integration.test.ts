import { randomBytes } from "node:crypto";
import { connectToSuite, createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteClient, SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { apiRole, graphileWorkerSchema, setRolePasswords, workerRole } from "../../src/roles.ts";

/**
 * The two roles answered by the database, not by the migration's prose.
 *
 * The roles migration creates `porkbot_api` and `porkbot_worker` and grants
 * each process only its own work (PRD decision 7). This suite asks
 * `pg_catalog` what each role may do, then really connects as the role and
 * performs the operation, so a grant that drifts — or a role that silently
 * inherited the other's — fails here instead of at a deployment.
 *
 * The connections use Postgres' `role` setting in the startup packet, which the
 * harness's superuser may set; permissions are then checked as that role
 * (`is_superuser` is off), exactly as a login would be. The suite skips no
 * check when the harness is a container: roles are cluster-global, so they
 * exist in every clone the template produced.
 */

let suite: SuiteDatabase | undefined;
let administrator: SuiteClient | undefined;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_roles" });
  administrator = await connectToSuite(suite);
}, 180_000);

afterAll(async () => {
  await administrator?.end();
  await suite?.destroy();
});

function db(): SuiteClient {
  if (administrator === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return administrator;
}

/** A client whose session role is `role`, connected to the suite's database. */
async function connectAs(role: string): Promise<SuiteClient> {
  if (suite === undefined) {
    throw new Error("the suite was not created; the beforeAll hook failed first");
  }

  return connectToSuite(suite, { role });
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string }).code;
}

describe("a role-scoped session", () => {
  it("acts as the role, with the superuser attribute off", async () => {
    // The harness signs in as its own (superuser) user and sets the role in the
    // startup packet; Postgres then checks permissions as that role, so the
    // denial tests below are the role's answer, not the harness user's. This
    // asserts that property directly rather than assuming it.
    const api = await connectAs(apiRole);

    try {
      const { rows } = await api.query<{ current: string; isSuperuser: string }>(
        "select current_user as current, current_setting('is_superuser') as \"isSuperuser\"",
      );

      expect(rows[0]?.current).toBe(apiRole);
      expect(rows[0]?.isSuperuser).toBe("off");
    } finally {
      await api.end();
    }
  });
});

describe("the API role", () => {
  it("may write the domain the HTTP surface owns", async () => {
    const api = await connectAs(apiRole);

    try {
      const { rows } = await api.query<{ name: string }>(
        "insert into space (name) values ($1) returning name",
        ["role probe"],
      );

      expect(rows[0]?.name).toBe("role probe");
    } finally {
      await api.end();
    }
  });

  it("may not read the job queue's schema", async () => {
    const api = await connectAs(apiRole);

    try {
      await expect(
        api.query(`select count(*) from ${graphileWorkerSchema}.jobs`),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
    } finally {
      await api.end();
    }
  });

  it("may record the operator's vote, but not move a gate's deadline", async () => {
    const api = await connectAs(apiRole);

    try {
      await expect(
        api.query(
          "update approval set status = 'approved', decided_by_user_id = gen_random_uuid(), " +
            "decided_at = now(), reason = null, updated_at = now() where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        api.query("update approval set expires_at = now() where false"),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
    } finally {
      await api.end();
    }
  });
});

describe("the worker role", () => {
  it("may read the run state it re-reads before acting", async () => {
    const worker = await connectAs(workerRole);

    try {
      const { rows } = await worker.query<{ count: number }>(
        "select count(*)::int as count from run",
      );

      expect(rows[0]?.count).toBe(0);
    } finally {
      await worker.end();
    }
  });

  it("may update run leases, settle attempts and reconcile effects, but not create runs", async () => {
    const worker = await connectAs(workerRole);

    try {
      await expect(
        worker.query("update run set updated_at = now() where false"),
      ).resolves.toBeDefined();
      await expect(
        worker.query(
          "insert into attempt (run_id, fence, status) select id, 1, 'running' from run where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        worker.query("update attempt set error = 'reclaimed' where false"),
      ).resolves.toBeDefined();
      await expect(
        worker.query("update external_effect set status = 'failed' where false"),
      ).resolves.toBeDefined();
      await expect(
        worker.query(
          "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
            "select space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce from run where false",
        ),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
    } finally {
      await worker.end();
    }
  });

  it("may open a gate and time it out, but not vote in the operator's name", async () => {
    const worker = await connectAs(workerRole);

    try {
      await expect(
        worker.query(
          "insert into approval (space_id, run_id, call_id, tool, status, expires_at) " +
            "select space_id, id, 'call-role-probe', 'shell', 'pending', now() + interval '10 minutes' " +
            "from run where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        worker.query(
          "update approval set status = 'timed_out', decided_at = now(), updated_at = now() where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        worker.query("update approval set decided_by_user_id = null where false"),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
    } finally {
      await worker.end();
    }
  });
});

describe("setting a role's password", () => {
  it("writes a credential the role can really authenticate with", async () => {
    // The same statement `pnpm db:migrate` applies on a deployment, against the
    // real server: the password is quoted by Postgres' `format('%L')`, not
    // assembled in JavaScript, and the role the command addressed can log in.
    // The password is generated per run, never printed, and the role's previous
    // verifier is restored afterwards, so the suite leaves the cluster as it
    // found it even when another process (the stack's worker) is using the role.
    const password = randomBytes(16).toString("hex");

    if (suite === undefined) {
      throw new Error("the suite was not created; the beforeAll hook failed first");
    }

    const { rows: before } = await db().query<{ verifier: string | null }>(
      "select rolpassword as verifier from pg_authid where rolname = $1",
      [workerRole],
    );
    const originalVerifier = before[0]?.verifier ?? null;

    await setRolePasswords(db(), { worker: password });

    const url = new URL(suite.connectionString);
    url.username = workerRole;
    url.password = password;

    const worker = new Client({ connectionString: url.toString() });

    try {
      await worker.connect();
      const { rows } = await worker.query<{ current: string }>("select current_user as current");

      expect(rows[0]?.current).toBe(workerRole);
    } finally {
      await worker.end().catch(() => undefined);
      await restoreWorkerPassword(originalVerifier);
    }
  });
});

/**
 * Puts the worker role's verifier back the way it was found: `NULL` when the
 * role had no password, otherwise the exact SCRAM/MD5 verifier Postgres stored,
 * re-applied through the same server-side quoting the command under test uses.
 */
async function restoreWorkerPassword(verifier: string | null): Promise<void> {
  if (verifier === null) {
    await db().query(`alter role ${workerRole} password null`);
    return;
  }

  const { rows } = await db().query<{ statement: string }>(
    "select format('alter role %I password %L', $1::text, $2::text) as statement",
    [workerRole, verifier],
  );
  const statement = rows[0]?.statement;

  if (statement === undefined) {
    throw new Error("format() produced no statement to restore the role's password");
  }

  await db().query(statement);
}

describe("the catalog's answer", () => {
  it("separates the two roles table by table", async () => {
    const { rows } = await db().query<{
      api_inserts_bot: boolean;
      worker_inserts_bot: boolean;
      worker_updates_run: boolean;
      worker_inserts_attempt: boolean;
      worker_reads_attempt: boolean;
      worker_updates_attempt: boolean;
      worker_updates_effects: boolean;
      worker_inserts_run: boolean;
      worker_reads_users: boolean;
      worker_inserts_approval: boolean;
      worker_reads_approval: boolean;
      worker_writes_approval_timeout: boolean;
      worker_writes_approval_vote: boolean;
      api_reads_approval: boolean;
      api_writes_approval_vote: boolean;
      api_writes_approval_deadline: boolean;
      api_inserts_approval: boolean;
      worker_deletes_approval: boolean;
      api_reads_jobs: boolean;
      worker_creates_jobs: boolean;
      api_creates_schemas: boolean;
      worker_creates_schemas: boolean;
    }>(
      "select " +
        "has_table_privilege($1, 'public.bot', 'INSERT') as api_inserts_bot, " +
        "has_table_privilege($2, 'public.bot', 'INSERT') as worker_inserts_bot, " +
        "has_table_privilege($2, 'public.run', 'UPDATE') as worker_updates_run, " +
        "has_table_privilege($2, 'public.attempt', 'INSERT') as worker_inserts_attempt, " +
        "has_table_privilege($2, 'public.attempt', 'SELECT') as worker_reads_attempt, " +
        "has_table_privilege($2, 'public.attempt', 'UPDATE') as worker_updates_attempt, " +
        "has_table_privilege($2, 'public.external_effect', 'UPDATE') as worker_updates_effects, " +
        "has_table_privilege($2, 'public.run', 'INSERT') as worker_inserts_run, " +
        "has_table_privilege($2, 'public.\"user\"', 'SELECT') as worker_reads_users, " +
        "has_table_privilege($2, 'public.approval', 'INSERT') as worker_inserts_approval, " +
        "has_table_privilege($2, 'public.approval', 'SELECT') as worker_reads_approval, " +
        "has_column_privilege($2, 'public.approval', 'decided_at', 'UPDATE') " +
        "as worker_writes_approval_timeout, " +
        "has_column_privilege($2, 'public.approval', 'decided_by_user_id', 'UPDATE') " +
        "as worker_writes_approval_vote, " +
        "has_table_privilege($1, 'public.approval', 'SELECT') as api_reads_approval, " +
        "has_column_privilege($1, 'public.approval', 'decided_by_user_id', 'UPDATE') " +
        "as api_writes_approval_vote, " +
        "has_column_privilege($1, 'public.approval', 'expires_at', 'UPDATE') " +
        "as api_writes_approval_deadline, " +
        "has_table_privilege($1, 'public.approval', 'INSERT') as api_inserts_approval, " +
        "has_table_privilege($2, 'public.approval', 'DELETE') as worker_deletes_approval, " +
        `has_schema_privilege($1, '${graphileWorkerSchema}', 'USAGE') as api_reads_jobs, ` +
        `has_schema_privilege($2, '${graphileWorkerSchema}', 'CREATE') as worker_creates_jobs, ` +
        "has_database_privilege($1, current_database(), 'CREATE') as api_creates_schemas, " +
        "has_database_privilege($2, current_database(), 'CREATE') as worker_creates_schemas",
      [apiRole, workerRole],
    );

    expect(rows[0]).toEqual({
      api_inserts_bot: true,
      worker_inserts_bot: false,
      worker_updates_run: true,
      worker_inserts_attempt: true,
      worker_reads_attempt: true,
      worker_updates_attempt: true,
      worker_updates_effects: true,
      worker_inserts_run: false,
      worker_reads_users: false,
      worker_inserts_approval: true,
      worker_reads_approval: true,
      worker_writes_approval_timeout: true,
      worker_writes_approval_vote: false,
      api_reads_approval: true,
      api_writes_approval_vote: true,
      api_writes_approval_deadline: false,
      api_inserts_approval: false,
      worker_deletes_approval: false,
      api_reads_jobs: false,
      worker_creates_jobs: true,
      api_creates_schemas: false,
      worker_creates_schemas: true,
    });
  });
});
