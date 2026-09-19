import { randomUUID } from "node:crypto";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "../../src/actor.ts";
import { createRepositories } from "../../src/repositories.ts";
import { findStalledRuns } from "../../src/run-liveness.ts";

/**
 * Run liveness against Postgres (slice 6.10, PRD decision 33): a heartbeat
 * renews the lease and stamps the worker's progress in one statement, a beat
 * that saw nothing leaves the progress instant exactly where it was, and the
 * stall scan and episode marker agree with the clock the database itself uses.
 *
 * The injected stall is the acceptance criterion's: a run whose progress is set
 * past the threshold is found and marked once; a run inside it is left alone.
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

function system(jobId: string): SystemActor {
  return { kind: "system", spaceId: user.spaceId, jobId };
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: "db_run_liveness" });
  client = new Client({ connectionString: suite.connectionString });
  await client.connect();

  const { rows: spaceRows } = await db().query<{ id: string }>(
    "insert into space (name) values ('run liveness') returning id",
  );
  const { rows: userRows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id',
    ["liveness fixture", `${randomUUID()}@example.test`],
  );
  const spaceId = spaceRows[0]?.id;
  const userId = userRows[0]?.id;

  if (spaceId === undefined || userId === undefined) {
    throw new Error("the liveness fixture rows did not insert");
  }

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

/** A claimed run of its own, so each case's heartbeat history is isolated. */
async function claimedRun(
  owner = "worker-a",
): Promise<{ readonly runId: string; readonly fence: number }> {
  const userRepositories = createRepositories(user, db());
  const bot = await userRepositories.bots.create({
    name: `Liveness ${randomUUID()}`,
    color: "fixture-color",
    spawnKey: randomUUID(),
  });
  const thread = await userRepositories.threads.createForBot(bot.id);
  const created = await userRepositories.runs.create({
    threadId: thread.id,
    clientNonce: randomUUID(),
    prompt: "keep making progress",
    blocks: [{ type: "text", text: "keep making progress" }],
  });
  const claimed = await createRepositories(system(`job-${owner}`), db()).runs.claim(
    created.run.id,
    0,
    owner,
  );

  if (claimed === undefined) {
    throw new Error("a fresh run fixture lost its claim");
  }

  return { runId: created.run.id, fence: claimed.leaseFence };
}

async function staleProgress(runId: string, seconds: number): Promise<void> {
  await db().query(
    `update run set last_progress_at = now() - make_interval(secs => $2) where id = $1`,
    [runId, seconds],
  );
}

describe("the heartbeat's liveness stamp", () => {
  it("records progress, the step and a fresh heartbeat on a beat that saw an event", async () => {
    const { runId, fence } = await claimedRun();
    const repositories = createRepositories(system("worker-a"), db());

    const beat = await repositories.runs.heartbeat(
      runId,
      { owner: "worker-a", fence },
      { progressed: true, idleSeconds: 5, step: { kind: "working", tool: "shell" } },
    );

    expect(beat.currentStep).toBe("working");
    expect(beat.currentStepTool).toBe("shell");
    expect(beat.stalledAt).toBeNull();
    expect(beat.lastProgressAt).not.toBeNull();

    const { rows } = await db().query<{ readonly lag: number }>(
      `select extract(epoch from (now() - last_progress_at))::int as lag from run where id = $1`,
      [runId],
    );
    expect(rows[0]?.lag).toBeGreaterThanOrEqual(4);
    expect(rows[0]?.lag).toBeLessThanOrEqual(6);
  });

  it("leaves the progress instant where it was when the beat saw nothing", async () => {
    const { runId, fence } = await claimedRun();
    const repositories = createRepositories(system("worker-a"), db());
    await staleProgress(runId, 40);
    const before = await repositories.runs.findById(runId);

    const beat = await repositories.runs.heartbeat(
      runId,
      { owner: "worker-a", fence },
      { progressed: false, idleSeconds: 45, step: { kind: "thinking", tool: null } },
    );

    expect(beat.lastProgressAt?.getTime()).toBe(before.lastProgressAt?.getTime());
    expect(beat.lastHeartbeatAt?.getTime()).toBeGreaterThan(before.lastHeartbeatAt?.getTime() ?? 0);
  });

  it("gives a row claimed before liveness existed a baseline on its first beat", async () => {
    const { runId, fence } = await claimedRun();
    const repositories = createRepositories(system("worker-a"), db());
    await db().query(
      "update run set last_progress_at = null, last_heartbeat_at = null where id = $1",
      [runId],
    );

    const beat = await repositories.runs.heartbeat(
      runId,
      { owner: "worker-a", fence },
      { progressed: false, idleSeconds: 999, step: { kind: "thinking", tool: null } },
    );

    expect(beat.lastProgressAt).not.toBeNull();
    const { rows } = await db().query<{ readonly lag: number }>(
      "select extract(epoch from (now() - last_progress_at))::int as lag from run where id = $1",
      [runId],
    );
    expect(rows[0]?.lag).toBeLessThanOrEqual(2);
  });

  it("clears a recorded stall episode on the first beat that reports progress", async () => {
    const { runId, fence } = await claimedRun();
    const repositories = createRepositories(system("worker-a"), db());
    await db().query("update run set stalled_at = now() where id = $1", [runId]);

    const beat = await repositories.runs.heartbeat(
      runId,
      { owner: "worker-a", fence },
      { progressed: true, idleSeconds: 1, step: { kind: "thinking", tool: null } },
    );

    expect(beat.stalledAt).toBeNull();
  });

  it("clears the step and the stall marker when the run settles terminal", async () => {
    const { runId, fence } = await claimedRun();
    const repositories = createRepositories(system("worker-a"), db());
    await db().query("update run set stalled_at = now() where id = $1", [runId]);

    const settled = await repositories.runs.update(
      runId,
      { owner: "worker-a", fence },
      { status: "completed", completed: true, attempt: "completed", release: true },
    );

    expect(settled).toMatchObject({
      status: "completed",
      currentStep: null,
      currentStepTool: null,
      stalledAt: null,
    });
  });
});

describe("the stall scan and its episode marker", () => {
  it("finds a live, silent run past the threshold and marks it exactly once", async () => {
    const { runId, fence } = await claimedRun();
    await staleProgress(runId, 400);

    const stalled = await findStalledRuns(db(), 180, 50);
    expect(stalled.map((candidate) => candidate.runId)).toContain(runId);

    const repositories = createRepositories(system("watchdog"), db());
    const marked = await repositories.runs.markStalled(runId, 180);

    expect(marked).toMatchObject({ id: runId, leaseFence: fence });
    expect(marked?.stalledAt).not.toBeNull();

    // The episode is recorded, so a second detector — or the next minute's
    // pass — writes nothing for the same silence.
    expect(await repositories.runs.markStalled(runId, 180)).toBeUndefined();
  });

  it("leaves a run inside the threshold, a parked run and an expired lease alone", async () => {
    const inside = await claimedRun();
    await staleProgress(inside.runId, 30);

    const stopping = await claimedRun();
    await staleProgress(stopping.runId, 400);
    await db().query("update run set stop_requested_at = now() where id = $1", [stopping.runId]);

    const waiting = await claimedRun();
    await staleProgress(waiting.runId, 400);
    await db().query("update run set status = 'waiting_approval' where id = $1", [waiting.runId]);

    const unclaimedByWorker = await claimedRun();
    await staleProgress(unclaimedByWorker.runId, 400);
    await db().query(
      "update run set lease_expires_at = now() - interval '1 second' where id = $1",
      [unclaimedByWorker.runId],
    );

    // A row claimed before the liveness columns existed has no baseline; its
    // age is not evidence of a stall.
    const legacy = await claimedRun();
    await db().query("update run set last_progress_at = null where id = $1", [legacy.runId]);

    const found = (await findStalledRuns(db(), 180, 50)).map((candidate) => candidate.runId);

    expect(found).not.toContain(inside.runId);
    expect(found).not.toContain(stopping.runId);
    expect(found).not.toContain(waiting.runId);
    expect(found).not.toContain(unclaimedByWorker.runId);
    expect(found).not.toContain(legacy.runId);
  });

  it("does not mark a run whose approval is waiting", async () => {
    const { runId } = await claimedRun();
    await staleProgress(runId, 400);
    await db().query(
      "update run set current_step = 'waiting', current_step_tool = 'shell' where id = $1",
      [runId],
    );

    expect(
      await createRepositories(system("watchdog"), db()).runs.markStalled(runId, 180),
    ).toBeUndefined();
  });
});
