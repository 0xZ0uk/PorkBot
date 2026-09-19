import { randomUUID } from "node:crypto";
import { LeaseLostError } from "@porkbot/effect";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";
import { createExternalEffectLedger } from "../../src/tool-call-ledger.ts";

let suite: SuiteDatabase | undefined;
let client: Client | undefined;
let user: UserActor;
let botId: string;
let runId: string;

function db(): Client {
  if (client === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return client;
}

async function connect(): Promise<Client> {
  if (suite === undefined) {
    throw new Error("the suite's database was not created; the beforeAll hook failed first");
  }

  const connection = new Client({ connectionString: suite.connectionString });
  await connection.connect();
  return connection;
}

function system(jobId: string): SystemActor {
  return { kind: "system", spaceId: user.spaceId, jobId };
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_run_leases" });
  client = await connect();

  const { rows: spaceRows } = await db().query<{ id: string }>(
    "insert into space (name) values ('run leases') returning id",
  );
  const { rows: userRows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id',
    ["lease fixture", `${randomUUID()}@example.test`],
  );
  const spaceId = requiredId(spaceRows[0], "space");
  const userId = requiredId(userRows[0], "user");
  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, 'owner')", [
    spaceId,
    userId,
  ]);
  user = { kind: "user", spaceId, userId, role: "owner" };

  const repositories = createRepositories(user, db());
  const bot = await repositories.bots.create({
    name: "Lease bot",
    color: "fixture-color",
    spawnKey: randomUUID(),
  });
  botId = bot.id;
  const thread = await repositories.threads.createForBot(bot.id);
  runId = (
    await repositories.runs.create({
      threadId: thread.id,
      clientNonce: randomUUID(),
      prompt: "hold the lease",
      blocks: [{ type: "text", text: "hold the lease" }],
    })
  ).run.id;
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

function requiredId(row: { readonly id: string } | undefined, what: string): string {
  if (row === undefined) {
    throw new Error(`expected ${what} to insert and return its id`);
  }

  return row.id;
}

describe("run lease compare-and-swap", () => {
  it("gives exactly one owner to workers racing on the same fence", async () => {
    const contenders = await Promise.all([connect(), connect()]);

    try {
      const [first, second] = contenders;
      if (first === undefined || second === undefined) {
        throw new Error("expected two lease contenders");
      }

      const claims = await Promise.all([
        createRepositories(system("job-a"), first).runs.claim(runId, 0, "worker-a"),
        createRepositories(system("job-b"), second).runs.claim(runId, 0, "worker-b"),
      ]);
      const winners = claims.filter((claim) => claim !== undefined);

      expect(winners).toHaveLength(1);
      expect(winners[0]).toMatchObject({ status: "running", leaseFence: 1 });
      expect(["worker-a", "worker-b"]).toContain(winners[0]?.leaseOwner);

      const { rows } = await db().query<{ count: number }>(
        "select count(*)::int as count from attempt where run_id = $1 and fence = 1",
        [runId],
      );
      expect(rows[0]?.count).toBe(1);
    } finally {
      await Promise.all(contenders.map((contender) => contender.end()));
    }
  });

  it("does not let a stale owner renew or overwrite the reclaimer's work", async () => {
    const before = await createRepositories(system("reader"), db()).runs.findById(runId);
    const oldOwner = before.leaseOwner;
    if (oldOwner === null) {
      throw new Error("the preceding claim did not leave an owner");
    }

    await db().query(
      "update run set lease_expires_at = now() - interval '1 second' where id = $1",
      [runId],
    );

    const newRepositories = createRepositories(system("job-c"), db());
    const reclaimed = await newRepositories.runs.reclaim(runId, 1, "worker-c");
    expect(reclaimed).toMatchObject({ leaseOwner: "worker-c", leaseFence: 2 });

    await newRepositories.runs.update(
      runId,
      { owner: "worker-c", fence: 2 },
      { checkpoint: { owner: "worker-c" } },
    );

    const staleRepositories = createRepositories(system("stale-job"), db());
    const staleLease = { owner: oldOwner, fence: 1 };
    await expect(staleRepositories.runs.heartbeat(runId, staleLease)).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      staleRepositories.runs.update(runId, staleLease, { checkpoint: { owner: oldOwner } }),
    ).rejects.toBeInstanceOf(LeaseLostError);

    expect(await newRepositories.runs.findById(runId)).toMatchObject({
      leaseOwner: "worker-c",
      leaseFence: 2,
      checkpoint: { owner: "worker-c" },
    });
  });

  it("cannot reclaim before expiry or write after the run becomes terminal", async () => {
    const repositories = createRepositories(system("job-d"), db());
    const before = await repositories.runs.findById(runId);
    const owner = before.leaseOwner;
    if (owner === null) {
      throw new Error("the run fixture has no current owner");
    }

    expect(await repositories.runs.reclaim(runId, before.leaseFence, "worker-d")).toBeUndefined();

    const lease = { owner, fence: before.leaseFence };
    await repositories.runs.update(runId, lease, { status: "completed", completed: true });
    await expect(
      repositories.runs.update(runId, lease, { checkpoint: { tooLate: true } }),
    ).rejects.toBeInstanceOf(LeaseLostError);
  });

  it("settles a cancelled run's calls in flight and releases its lease", async () => {
    const userRepositories = createRepositories(user, db());
    const thread = await userRepositories.threads.createForBot(botId);
    const created = await userRepositories.runs.create({
      threadId: thread.id,
      clientNonce: randomUUID(),
      prompt: "run a tool that will be interrupted",
      blocks: [{ type: "text", text: "run a tool that will be interrupted" }],
    });

    const actor = system("job-e");
    const workerRepositories = createRepositories(actor, db());
    const claimed = await workerRepositories.runs.claim(created.run.id, 0, "worker-e");
    if (claimed === undefined) {
      throw new Error("the cancellation fixture's claim lost its race");
    }

    const ledger = createExternalEffectLedger(actor, db());
    await ledger.begin({
      runId: created.run.id,
      callId: "call-1",
      tool: "shell",
      arguments: { command: "sleep 3600" },
    });

    const settled = await workerRepositories.runs.update(
      created.run.id,
      { owner: "worker-e", fence: claimed.leaseFence },
      {
        status: "cancelled",
        completed: true,
        attempt: "cancelled",
        release: true,
        settleInFlight: "the run was cancelled before this tool call settled",
      },
    );

    expect(settled).toMatchObject({ status: "cancelled", leaseOwner: null, leaseExpiresAt: null });

    const { rows } = await db().query<{ readonly status: string; readonly result: unknown }>(
      "select status::text as status, result from external_effect " +
        "where run_id = $1 and idempotency_key = 'call-1'",
      [created.run.id],
    );

    expect(rows).toEqual([
      {
        status: "failed",
        result: { error: "the run was cancelled before this tool call settled" },
      },
    ]);
  });
});
