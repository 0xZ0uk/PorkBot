import { randomUUID } from "node:crypto";
import { Effect, Either } from "effect";
import { createFencedComputerCommands, LeaseLostError } from "@porkbot/effect";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
} from "@porkbot/adapter-kit";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import {
  COMPUTER_LEASE_TTL_SECONDS,
  createComputerLeaseStore,
  findExpiredComputerLeases,
  holdComputerLease,
  releaseComputerLease,
} from "../../src/computer-leases.ts";
import { createRepositories } from "../../src/repositories.ts";
import { RUN_LEASE_TTL_SECONDS } from "../../src/run-leases.ts";
import { createExternalEffectLedger } from "../../src/tool-call-ledger.ts";

/**
 * The computer lease against real Postgres (slice 7.4): the one-statement hold
 * that refuses a live foreign holder and takes over an expired one, the fence
 * that makes a reclaimed run's holder unable to renew, the watchdog's expired
 * scan, and the commit path a reclaim closes.
 *
 * The concurrency proof is two real connections racing the same upsert, not a
 * mock: the unique index on `bot_id` is the arbiter, exactly as the run lease's
 * CAS is. The command path composes the shipped guard with the shipped
 * `external_effect` ledger, so "a reclaimed run's in-flight command cannot
 * commit" is asserted on the durable rows a resume would read.
 */

let suite: SuiteDatabase | undefined;
let client: Client | undefined;
let user: UserActor;

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

async function requiredId(row: { readonly id: string } | undefined, what: string): Promise<string> {
  if (row === undefined) {
    throw new Error(`expected ${what} to insert and return its id`);
  }

  return row.id;
}

interface Fixture {
  readonly botId: string;
  readonly runId: string;
  readonly owner: string;
  readonly fence: number;
}

/**
 * A bot with one run claimed by `owner` at fence 1: the holder every probe
 * fences on. Each fixture gets its own bot unless one is named, so one case
 * cannot see another's lease row while a probe that needs two runs on one
 * machine can ask for the same bot.
 */
async function claimedRun(owner: string, existingBotId?: string): Promise<Fixture> {
  const repositories = createRepositories(user, db());
  const botId =
    existingBotId ??
    (
      await repositories.bots.create({
        name: `Computer lease bot ${randomUUID().slice(0, 8)}`,
        color: "fixture-color",
        spawnKey: randomUUID(),
      })
    ).id;
  const thread = await repositories.threads.createForBot(botId);
  const created = await repositories.runs.create({
    threadId: thread.id,
    clientNonce: randomUUID(),
    prompt: "hold the computer",
    blocks: [{ type: "text", text: "hold the computer" }],
  });
  const claimed = await createRepositories(system(owner), db()).runs.claim(
    created.run.id,
    0,
    owner,
  );

  if (claimed === undefined) {
    throw new Error("the fixture run was not claimable");
  }

  return { botId, runId: claimed.id, owner, fence: claimed.leaseFence };
}

function holder(fixture: Fixture) {
  return {
    botId: fixture.botId,
    runId: fixture.runId,
    owner: fixture.owner,
    fence: fixture.fence,
  };
}

async function expireLease(runId: string): Promise<void> {
  await db().query("update run set lease_expires_at = now() - interval '1 second' where id = $1", [
    runId,
  ]);
}

/** A provider whose one command parks until the test releases it. */
class BlockingProvider implements ComputerProvider {
  readonly requests: ComputerExecRequest[] = [];
  readonly entered: Promise<void>;
  #enteredResolve: () => void = () => {};
  #release: (() => void) | undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  constructor() {
    this.entered = new Promise((resolve) => {
      this.#enteredResolve = resolve;
    });
  }

  async ensure(): Promise<never> {
    throw new Error("not used");
  }

  async status(): Promise<never> {
    throw new Error("not used");
  }

  async stop(): Promise<never> {
    throw new Error("not used");
  }

  async list(): Promise<never> {
    throw new Error("not used");
  }

  async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
    this.requests.push(request);
    this.#enteredResolve();
    await this.#gate;

    return { exitCode: 0, stdout: "the command that ran\n", stderr: "" };
  }

  async snapshot(): Promise<never> {
    throw new Error("not used");
  }

  async restore(): Promise<never> {
    throw new Error("not used");
  }

  async destroy(): Promise<void> {}

  release(): void {
    this.#release?.();
  }
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_computer_leases" });
  client = await connect();

  const { rows: spaceRows } = await db().query<{ id: string }>(
    "insert into space (name) values ('computer leases') returning id",
  );
  const { rows: userRows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id',
    ["computer fixture", `${randomUUID()}@example.test`],
  );
  const spaceId = await requiredId(spaceRows[0], "space");
  const userId = await requiredId(userRows[0], "user");
  await db().query("insert into space_member (space_id, user_id, role) values ($1, $2, 'owner')", [
    spaceId,
    userId,
  ]);
  user = { kind: "user", spaceId, userId, role: "owner" };
}, 180_000);

afterAll(async () => {
  await client?.end();
  await suite?.destroy();
});

describe("the computer lease TTL", () => {
  it("never outlives the run lease it is fenced on", () => {
    expect(COMPUTER_LEASE_TTL_SECONDS).toBeLessThanOrEqual(RUN_LEASE_TTL_SECONDS);
  });
});

describe("holding a computer", () => {
  it("gives a live run the machine and renews its own binding", async () => {
    const fixture = await claimedRun("worker-a");
    const actor = system("worker-a");

    const first = await holdComputerLease(actor, db(), holder(fixture));
    expect(first.status).toBe("held");

    const renewed = await holdComputerLease(actor, db(), holder(fixture));
    expect(renewed.status).toBe("held");

    const { rows } = await db().query<{ count: number; expiresAt: Date }>(
      'select count(*)::int as count, max(expires_at) as "expiresAt" from computer_lease ' +
        "where bot_id = $1",
      [fixture.botId],
    );
    expect(rows[0]?.count).toBe(1);
    expect(rows[0]?.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("refuses a live foreign holder with the moment the machine frees", async () => {
    const first = await claimedRun("worker-a");
    const second = await claimedRun("worker-b", first.botId);

    await holdComputerLease(system("worker-a"), db(), holder(first));

    const refused = await holdComputerLease(system("worker-b"), db(), holder(second));

    expect(refused.status).toBe("busy");
    if (refused.status === "busy") {
      expect(refused.expiresAt.getTime()).toBeGreaterThan(Date.now());
    }
  });

  it("lets exactly one of two racing runs take a free machine", async () => {
    const repositories = createRepositories(user, db());
    const bot = await repositories.bots.create({
      name: `Racing computer bot ${randomUUID().slice(0, 8)}`,
      color: "fixture-color",
      spawnKey: randomUUID(),
    });
    const runs = await Promise.all(
      ["worker-a", "worker-b"].map(async (owner) => {
        const thread = await repositories.threads.createForBot(bot.id);
        const created = await repositories.runs.create({
          threadId: thread.id,
          clientNonce: randomUUID(),
          prompt: "race the computer",
          blocks: [{ type: "text", text: "race the computer" }],
        });

        return await createRepositories(system(owner), db()).runs.claim(created.run.id, 0, owner);
      }),
    );
    const [first, second] = runs;
    if (first === undefined || second === undefined) {
      throw new Error("expected two claimed runs");
    }

    const contenders = await Promise.all([connect(), connect()]);

    try {
      const [left, right] = contenders;
      if (left === undefined || right === undefined) {
        throw new Error("expected two lease contenders");
      }

      const acquisitions = await Promise.all([
        holdComputerLease(system("worker-a"), left, {
          botId: bot.id,
          runId: first.id,
          owner: first.leaseOwner ?? "",
          fence: first.leaseFence,
        }),
        holdComputerLease(system("worker-b"), right, {
          botId: bot.id,
          runId: second.id,
          owner: second.leaseOwner ?? "",
          fence: second.leaseFence,
        }),
      ]);

      expect(acquisitions.filter((acquisition) => acquisition.status === "held")).toHaveLength(1);
      expect(acquisitions.filter((acquisition) => acquisition.status === "busy")).toHaveLength(1);
    } finally {
      await Promise.all(contenders.map((contender) => contender.end()));
    }
  });

  it("takes over an expired lease and refuses the stale holder's renewal", async () => {
    const stale = await claimedRun("worker-a");
    const incumbent = await claimedRun("worker-b", stale.botId);

    await holdComputerLease(system("worker-a"), db(), holder(stale));
    // Expire the stale row directly: the holder's own renewal would fail anyway
    // once its run lease lapses, but the takeover path is what this asserts.
    await db().query(
      "update computer_lease set expires_at = now() - interval '1 second' where bot_id = $1",
      [stale.botId],
    );

    const taken = await holdComputerLease(system("worker-b"), db(), holder(incumbent));
    expect(taken.status).toBe("held");

    // The stale holder's run is still live, so the refusal is the classified
    // "someone else has it" rather than a lost run: it can back off and ask
    // again after `expiresAt`.
    const staleRenewal = await holdComputerLease(system("worker-a"), db(), holder(stale));
    expect(staleRenewal.status).toBe("busy");
  });

  it("surfaces a reclaimed run's holder as run_lost, not a renewal", async () => {
    const fixture = await claimedRun("worker-a");
    const actor = system("worker-a");

    expect((await holdComputerLease(actor, db(), holder(fixture))).status).toBe("held");

    await expireLease(fixture.runId);
    const reclaimed = await createRepositories(system("watchdog-job"), db()).runs.reclaim(
      fixture.runId,
      fixture.fence,
      "worker-c",
      { reason: "fixture reclaim" },
    );
    expect(reclaimed?.leaseFence).toBe(fixture.fence + 1);

    const lost = await holdComputerLease(actor, db(), holder(fixture));
    expect(lost.status).toBe("run_lost");
  });

  it("releases exactly the binding it is given", async () => {
    const fixture = await claimedRun("worker-a");

    await holdComputerLease(system("worker-a"), db(), holder(fixture));

    const cleared = await releaseComputerLease(system("worker-a"), db(), holder(fixture));
    expect(cleared).toBe(true);

    const { rows } = await db().query<{ count: number }>(
      "select count(*)::int as count from computer_lease where bot_id = $1",
      [fixture.botId],
    );
    expect(rows[0]?.count).toBe(0);
  });
});

describe("the watchdog's expired-lease sweep", () => {
  it("finds an expired lease and stops finding it once released", async () => {
    const fixture = await claimedRun("worker-a");

    // A zero-second TTL is already expired the instant it is written, which is
    // the state a crashed holder leaves behind.
    const expired = await holdComputerLease(system("worker-a"), db(), holder(fixture), 0);
    expect(expired.status).toBe("held");

    const found = await findExpiredComputerLeases(db(), 50);
    expect(found.some((lease) => lease.botId === fixture.botId)).toBe(true);

    const released = await releaseComputerLease(system("worker-a"), db(), holder(fixture));
    expect(released).toBe(true);

    const after = await findExpiredComputerLeases(db(), 50);
    expect(after.some((lease) => lease.botId === fixture.botId)).toBe(false);
  });
});

describe("a reclaimed run's in-flight computer command", () => {
  it("cannot commit its result", async () => {
    const fixture = await claimedRun("worker-a");
    const provider = new BlockingProvider();
    const ledger = createExternalEffectLedger(system("worker-a"), db());
    const commands = createFencedComputerCommands({
      provider,
      ledger,
      leases: createComputerLeaseStore(system("worker-a"), db()),
      lease: holder(fixture),
      runLeaseTtlSeconds: RUN_LEASE_TTL_SECONDS,
      computerLeaseTtlSeconds: COMPUTER_LEASE_TTL_SECONDS,
    });

    const executing = Effect.runPromise(
      commands
        .exec({
          computer: { computerId: fixture.botId, botId: fixture.botId },
          runId: fixture.runId,
          callId: "call-shell",
          tool: "shell",
          command: "printf 'the command that ran\\n'",
          timeoutMs: 30_000,
        })
        .pipe(Effect.either),
    );

    await provider.entered;

    // The run is reclaimed while its command is still in the sandbox: the
    // reclaim moves the fence and settles the command's claim as failed.
    await expireLease(fixture.runId);
    const reclaimed = await createRepositories(system("watchdog-job"), db()).runs.reclaim(
      fixture.runId,
      fixture.fence,
      "worker-c",
      { reason: "fixture reclaim" },
    );
    expect(reclaimed).toBeDefined();

    provider.release();
    const outcome = await executing;

    expect(Either.isLeft(outcome)).toBe(true);
    expect(outcome.left).toBeInstanceOf(LeaseLostError);

    // The durable rows agree: no command row is completed, and the claim the
    // reclaim settled carries the reclaim's reason.
    const { rows } = await db().query<{ status: string; result: unknown }>(
      "select status::text as status, result from external_effect where run_id = $1",
      [fixture.runId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).not.toBe("completed");
    expect(JSON.stringify(rows[0]?.result)).toContain("fixture reclaim");
  });

  it("replays a retried command from the durable ledger instead of repeating it", async () => {
    const fixture = await claimedRun("worker-a");
    const provider = new BlockingProvider();
    provider.release();
    const ledger = createExternalEffectLedger(system("worker-a"), db());
    const commands = createFencedComputerCommands({
      provider,
      ledger,
      leases: createComputerLeaseStore(system("worker-a"), db()),
      lease: holder(fixture),
      runLeaseTtlSeconds: RUN_LEASE_TTL_SECONDS,
      computerLeaseTtlSeconds: COMPUTER_LEASE_TTL_SECONDS,
    });

    const request = {
      computer: { computerId: fixture.botId, botId: fixture.botId },
      runId: fixture.runId,
      callId: "call-shell",
      tool: "shell",
      command: "printf 'once\\n'",
      timeoutMs: 30_000,
    };

    const first = await Effect.runPromise(commands.exec(request));
    const second = await Effect.runPromise(commands.exec(request));

    expect(second).toEqual(first);
    expect(provider.requests).toHaveLength(1);
  });
});
