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

  it("may update run leases, settle attempts and create a scheduled run, but not create a bot", async () => {
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
      // Slice 8.4 makes the worker the producer of routine-triggered runs, so
      // the same insert the API performs is granted to the scheduler; the
      // boundary that stays is that it cannot author the bot a run belongs to.
      await expect(
        worker.query(
          "insert into run (space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce) " +
            "select space_id, bot_id, thread_id, task_id, user_id, status, trigger, client_nonce from run where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        worker.query(
          "insert into task (space_id, bot_id, thread_id, user_id, prompt, status) " +
            "select space_id, bot_id, thread_id, user_id, prompt, status from task where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        worker.query(
          "insert into bot (space_id, user_id, name, color, spawn_key) " +
            "select space_id, user_id, name, color, spawn_key from bot where false",
        ),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
    } finally {
      await worker.end();
    }
  });

  it("may hold, renew and release a bot's computer lease, and the API may not", async () => {
    // Slice 7.4: the lease is run state the executing job writes. The API has
    // no seam for it at all, so the operator's role is refused every statement.
    const worker = await connectAs(workerRole);
    const api = await connectAs(apiRole);

    try {
      await expect(
        worker.query(
          "insert into computer_lease (space_id, bot_id, run_id, owner, fence, expires_at) " +
            "select space_id, id, id, 'role-probe', 1, now() from run where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        worker.query(
          "update computer_lease set expires_at = now() + interval '1 minute' where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        worker.query("select owner, fence, expires_at from computer_lease where false"),
      ).resolves.toBeDefined();
      await expect(worker.query("delete from computer_lease where false")).resolves.toBeDefined();

      await expect(
        api.query("select owner, fence, expires_at from computer_lease where false"),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await expect(api.query("delete from computer_lease where false")).rejects.toSatisfy(
        (error: unknown) => errorCode(error) === "42501",
      );
    } finally {
      await worker.end();
      await api.end();
    }
  });

  it("may advance a routine's cursor and write its ledger, but not rewrite its schedule", async () => {
    const worker = await connectAs(workerRole);

    try {
      await expect(
        worker.query("update routine set next_run_at = now(), updated_at = now() where false"),
      ).resolves.toBeDefined();
      await expect(
        worker.query(
          "insert into routine_occurrence (routine_id, scheduled_for) " +
            "select id, now() from routine where false",
        ),
      ).resolves.toBeDefined();
      await expect(
        worker.query("update routine set cron = '0 0 * * *' where false"),
      ).rejects.toSatisfy((error: unknown) => errorCode(error) === "42501");
      await expect(
        worker.query("update routine set enabled = false where false"),
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
      worker_inserts_task: boolean;
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
      worker_reads_routine: boolean;
      worker_updates_routine_cursor: boolean;
      worker_updates_routine_schedule: boolean;
      worker_inserts_occurrence: boolean;
      api_inserts_routine: boolean;
      api_reads_occurrence: boolean;
      api_deletes_credential: boolean;
      worker_deletes_credential: boolean;
      api_inserts_bot_secret: boolean;
      api_reads_bot_secret: boolean;
      worker_reads_bot_secret: boolean;
      worker_updates_bot_secret: boolean;
      worker_deletes_bot_secret: boolean;
      api_reads_jobs: boolean;
      worker_creates_jobs: boolean;
      api_creates_schemas: boolean;
      worker_creates_schemas: boolean;
      worker_reads_backup_run: boolean;
      worker_claims_backup_alert: boolean;
      api_reads_backup_run: boolean;
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
        "has_table_privilege($2, 'public.task', 'INSERT') as worker_inserts_task, " +
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
        "has_table_privilege($2, 'public.routine', 'SELECT') as worker_reads_routine, " +
        "has_column_privilege($2, 'public.routine', 'next_run_at', 'UPDATE') " +
        "as worker_updates_routine_cursor, " +
        "has_column_privilege($2, 'public.routine', 'cron', 'UPDATE') " +
        "as worker_updates_routine_schedule, " +
        "has_table_privilege($2, 'public.routine_occurrence', 'INSERT') as worker_inserts_occurrence, " +
        "has_table_privilege($1, 'public.routine', 'INSERT') as api_inserts_routine, " +
        "has_table_privilege($1, 'public.routine_occurrence', 'SELECT') as api_reads_occurrence, " +
        "has_table_privilege($1, 'public.encrypted_credential', 'DELETE') as api_deletes_credential, " +
        "has_table_privilege($2, 'public.encrypted_credential', 'DELETE') as worker_deletes_credential, " +
        "has_table_privilege($1, 'public.bot_secret', 'INSERT') as api_inserts_bot_secret, " +
        "has_table_privilege($1, 'public.bot_secret', 'SELECT') as api_reads_bot_secret, " +
        "has_table_privilege($2, 'public.bot_secret', 'SELECT') as worker_reads_bot_secret, " +
        "has_table_privilege($2, 'public.bot_secret', 'UPDATE') as worker_updates_bot_secret, " +
        "has_table_privilege($2, 'public.bot_secret', 'DELETE') as worker_deletes_bot_secret, " +
        "has_table_privilege($2, 'public.computer_lease', 'SELECT') as worker_reads_computer_lease, " +
        "has_table_privilege($2, 'public.computer_lease', 'INSERT') as worker_inserts_computer_lease, " +
        "has_table_privilege($2, 'public.computer_lease', 'UPDATE') as worker_updates_computer_lease, " +
        "has_table_privilege($2, 'public.computer_lease', 'DELETE') as worker_deletes_computer_lease, " +
        "has_table_privilege($1, 'public.computer_lease', 'SELECT') as api_reads_computer_lease, " +
        `has_schema_privilege($1, '${graphileWorkerSchema}', 'USAGE') as api_reads_jobs, ` +
        `has_schema_privilege($2, '${graphileWorkerSchema}', 'CREATE') as worker_creates_jobs, ` +
        "has_database_privilege($1, current_database(), 'CREATE') as api_creates_schemas, " +
        "has_database_privilege($2, current_database(), 'CREATE') as worker_creates_schemas, " +
        // The backup ledger is deployment-scoped: the worker's watchdog reads
        // the runs and claims alert episodes, and the API role sees nothing.
        "has_table_privilege($2, 'public.backup_run', 'SELECT') as worker_reads_backup_run, " +
        "has_table_privilege($2, 'public.backup_alert', 'INSERT') as worker_claims_backup_alert, " +
        "has_table_privilege($1, 'public.backup_run', 'SELECT') as api_reads_backup_run",
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
      worker_inserts_run: true,
      worker_inserts_task: true,
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
      worker_reads_routine: true,
      worker_updates_routine_cursor: true,
      worker_updates_routine_schedule: false,
      worker_inserts_occurrence: true,
      worker_reads_computer_lease: true,
      worker_inserts_computer_lease: true,
      worker_updates_computer_lease: true,
      worker_deletes_computer_lease: true,
      api_reads_computer_lease: false,
      api_inserts_routine: true,
      api_reads_occurrence: true,
      // The revoke's privilege (granted with the MCP uninstall, migration
      // 0019) belongs to the operator's API; a job resolves one named
      // credential and can never enumerate or revoke the store.
      api_deletes_credential: true,
      worker_deletes_credential: false,
      // The operator stores and reads bot secrets; the run resolves one name
      // and clears its envelope with a forget. Neither role deletes rows — a
      // bot's cascade does that as the table's owner — and a job resolves only
      // a name it already holds.
      api_inserts_bot_secret: true,
      api_reads_bot_secret: true,
      worker_reads_bot_secret: true,
      worker_updates_bot_secret: true,
      worker_deletes_bot_secret: false,
      worker_reads_backup_run: true,
      worker_claims_backup_alert: true,
      api_reads_backup_run: false,
      api_reads_jobs: false,
      worker_creates_jobs: true,
      api_creates_schemas: false,
      worker_creates_schemas: true,
    });
  });
});
