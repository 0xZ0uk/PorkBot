import type { ExpiredLease, Queryable, RunRecord } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { parseCronItems } from "graphile-worker";
import { JobPayloadError } from "../job-registry.ts";
import type { JobContext } from "../job-registry.ts";
import { leaseWatchdogSchedule } from "../worker.ts";
import {
  leaseWatchdogIdentifier,
  leaseWatchdogJob,
  parseLeaseWatchdogPayload,
} from "./lease-watchdog.ts";
import { runExecuteIdentifier } from "./run-execute.ts";

/**
 * The watchdog's contract, without a queue: one global scan, a scoped re-read,
 * the same fenced reclaim every reclaimer uses (without an attempt of its own),
 * and then resume-by-handoff or fail-with-reason. A fake client answers each
 * statement by the row the statement was about, so the write paths are
 * observable and the decision is the only moving part.
 */

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    userId: "user-1",
    status: "running",
    trigger: "message",
    error: null,
    errorCode: null,
    leaseOwner: "dead-worker",
    leaseFence: 3,
    leaseExpiresAt: new Date(0),
    checkpoint: { step: 2 },
    clientNonce: "nonce-1",
    sourceMessageId: null,
    startedAt: new Date(0),
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

interface FakeWorld {
  readonly expired: readonly ExpiredLease[];
  readonly runs: Map<string, RunRecord>;
  readonly reclaimed: Map<string, RunRecord | undefined>;
  readonly updates: Array<{
    readonly runId: string;
    readonly values: readonly unknown[];
    readonly patch: Readonly<Record<string, unknown>>;
  }>;
  readonly enqueued: Array<{
    readonly identifier: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly jobKey?: string;
    readonly jobKeyMode?: string;
  }>;
  readonly lines: Record<string, unknown>[];
}

function fakeContext(world: FakeWorld): JobContext {
  const client: Queryable = {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      if (text.includes('select id as "runId"')) {
        return { rows: world.expired as unknown as readonly Row[] };
      }

      if (text.startsWith("with claimed as")) {
        const candidate = values[0] as string;
        const row = world.reclaimed.get(candidate);
        return { rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] };
      }

      if (text.startsWith("with updated as")) {
        world.updates.push({
          runId: String(values[3] ?? ""),
          values,
          patch: Object.fromEntries(
            [...text.matchAll(/(\w+) = \$(\d+)/g)].map((match) => [
              String(match[1]),
              values[Number(match[2]) - 1],
            ]),
          ),
        });
        const updated = world.runs.get(`${String(values[4])}:${String(values[3])}`);
        return { rows: (updated === undefined ? [] : [updated]) as unknown as readonly Row[] };
      }

      const key = `${String(values[1])}:${String(values[0])}`;
      const row = world.runs.get(key);

      return { rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] };
    },
  };

  return {
    jobId: "watchdog-job",
    attempt: 1,
    logger: createLogger({
      service: "@porkbot/worker",
      write: (line) => world.lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    withPgClient: (work) => work(client),
    enqueue: async (identifier, payload, options) => {
      world.enqueued.push({
        identifier,
        payload,
        ...(options?.jobKey === undefined ? {} : { jobKey: options.jobKey }),
        ...(options?.jobKeyMode === undefined ? {} : { jobKeyMode: options.jobKeyMode }),
      });
    },
  };
}

function world(options: {
  readonly expired?: readonly ExpiredLease[];
  readonly run?: RunRecord | undefined;
  readonly reclaimed?: RunRecord | undefined;
}): FakeWorld {
  const candidate = {
    runId: "run-1",
    spaceId: "space-1",
    leaseFence: 3,
    leaseExpiresAt: new Date(0),
  };
  const runs = new Map<string, RunRecord>();

  if (options.run !== undefined) {
    runs.set(`${candidate.spaceId}:${candidate.runId}`, options.run);
  }

  return {
    expired: options.expired ?? [candidate],
    runs,
    reclaimed: new Map([[candidate.runId, options.reclaimed]]),
    updates: [],
    enqueued: [],
    lines: [],
  };
}

describe("the lease watchdog payload", () => {
  it("takes an empty payload and tolerates Graphile's cron marker", () => {
    expect(parseLeaseWatchdogPayload({})).toEqual({});
    expect(parseLeaseWatchdogPayload({ _cron: { ts: "2026-09-18T00:00:00Z" } })).toEqual({});
  });

  it("refuses a payload that carries work", () => {
    expect(() => parseLeaseWatchdogPayload({ runId: "run-1" })).toThrow(/carries "runId"/);
    expect(() => parseLeaseWatchdogPayload(null)).toThrow(JobPayloadError);
  });

  it("is registered under a watchdog identifier", () => {
    expect(leaseWatchdogJob().identifier).toBe(leaseWatchdogIdentifier);
  });

  it("is scheduled every minute under the registered identifier", () => {
    expect(leaseWatchdogSchedule).toMatchObject({
      task: leaseWatchdogIdentifier,
      match: "* * * * *",
    });

    // Graphile's crontab parser rejects the dotted identifier, so the schedule
    // must survive the programmatic parser the worker hands the runner.
    const [parsed] = parseCronItems([leaseWatchdogSchedule]);
    expect(parsed?.task).toBe(leaseWatchdogIdentifier);
  });
});

describe("the lease watchdog pass", () => {
  it("queues a handoff resume for a reclaimed run with a checkpoint", async () => {
    const run = runRecord();
    const reclaimed = runRecord({ leaseOwner: "watchdog-job", leaseFence: 4 });
    const fake = world({ run, reclaimed });
    const context = fakeContext(fake);

    await leaseWatchdogJob().handle({}, context);

    expect(fake.enqueued).toEqual([
      {
        identifier: runExecuteIdentifier,
        payload: { runId: "run-1", spaceId: "space-1", fence: 4, owner: "watchdog-job" },
        jobKey: `${runExecuteIdentifier}:run-1`,
        jobKeyMode: "replace",
      },
    ]);
    expect(fake.lines.at(-2)).toMatchObject({
      msg: "lease watchdog reclaimed an expired lease and queued the resume",
      fence: 4,
    });
    expect(fake.lines.at(-1)).toMatchObject({
      msg: "lease watchdog pass complete",
      scanned: 1,
      resumed: 1,
      failed: 0,
    });
  });

  it("fails a reclaimed run with nothing to resume and never enqueues it", async () => {
    const run = runRecord({ checkpoint: {} });
    const reclaimed = runRecord({ checkpoint: {}, leaseOwner: "watchdog-job", leaseFence: 4 });
    const fake = world({ run, reclaimed });
    const context = fakeContext(fake);

    await leaseWatchdogJob().handle({}, context);

    expect(fake.enqueued).toEqual([]);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).toMatchObject({ runId: "run-1" });
    expect(fake.updates[0]?.patch["status"]).toBe("failed");
    expect(fake.updates[0]?.patch["error_code"]).toBe("checkpoint_absent");
    expect(fake.updates[0]?.patch["error"]).toContain("checkpoint");
    expect(fake.lines.at(-2)).toMatchObject({
      msg: "lease watchdog failed a reclaimed run with nothing to resume",
      reason: "checkpoint_absent",
    });
    expect(fake.lines.at(-1)).toMatchObject({ scanned: 1, resumed: 0, failed: 1 });
  });

  it("writes nothing when another reclaimer won the lease race", async () => {
    const run = runRecord();
    const fake = world({ run, reclaimed: undefined });
    const context = fakeContext(fake);

    await leaseWatchdogJob().handle({}, context);

    expect(fake.enqueued).toEqual([]);
    expect(fake.lines.at(-2)).toMatchObject({
      msg: "lease watchdog skipped a run another reclaimer owns",
    });
    expect(fake.lines.at(-1)).toMatchObject({ scanned: 1, resumed: 0, failed: 0 });
  });

  it("skips a candidate that heartbeated or finished between the scan and the read", async () => {
    const run = runRecord({ leaseExpiresAt: new Date(Date.now() + 60_000) });
    const fake = world({ run, reclaimed: undefined });
    const context = fakeContext(fake);

    await leaseWatchdogJob().handle({}, context);

    expect(fake.enqueued).toEqual([]);
    expect(fake.lines.at(-1)).toMatchObject({ scanned: 1, resumed: 0, failed: 0 });
  });

  it("skips a candidate whose run is not in the candidate's space", async () => {
    const fake = world({ run: undefined });
    const context = fakeContext(fake);

    await leaseWatchdogJob().handle({}, context);

    expect(
      fake.lines.some(
        (line) => line["msg"] === "lease watchdog skipped a run outside the candidate's space",
      ),
    ).toBe(true);
  });

  it("reports an empty pass without touching anything", async () => {
    const fake = world({ expired: [] });
    const context = fakeContext(fake);

    await leaseWatchdogJob().handle({}, context);

    expect(fake.lines.at(-1)).toMatchObject({ msg: "lease watchdog pass found no expired lease" });
  });

  it("reads the batch limit from its options", () => {
    expect(leaseWatchdogJob({ batchLimit: 1 }).identifier).toBe(leaseWatchdogIdentifier);
  });
});
