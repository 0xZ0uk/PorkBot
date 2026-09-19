import type { Queryable, RunRecord } from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { JobPayloadError } from "../job-registry.ts";
import type { JobContext } from "../job-registry.ts";
import { parseRunExecutePayload, runExecuteJob, runExecuteIdentifier } from "./run-execute.ts";
import type { RunExecution } from "./run-execute.ts";

/**
 * The handler's contract, without a queue: the payload is addressing only, the
 * run is re-read inside the payload's space, and the row's fence decides
 * whether and how the executor is called. A fake client stands in for the
 * connection the runner checks out and answers each acquisition statement by
 * its guard, so "the decision came from the row" is observable: the tests
 * change the row and the guards between deliveries and watch the executor's
 * calls.
 */

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    userId: "user-1",
    status: "queued",
    trigger: "message",
    error: null,
    errorCode: null,
    leaseOwner: null,
    leaseFence: 0,
    leaseExpiresAt: null,
    stopRequestedAt: null,
    checkpoint: {},
    clientNonce: "nonce-1",
    sourceMessageId: null,
    startedAt: null,
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

interface FakeClientOptions {
  /** What the scoped read returns; undefined is a run outside the actor's space. */
  readonly row: RunRecord | undefined;
  /** What the claim CAS returns; undefined means it matched no row. */
  readonly claim?: RunRecord;
  /** What the adopt CAS returns; undefined means either guard failed. */
  readonly adopt?: RunRecord;
  /** What the reclaim CAS returns; undefined means the lease has not expired. */
  readonly reclaim?: RunRecord;
}

interface FakeClient {
  readonly calls: ReadonlyArray<{ readonly text: string; readonly values: readonly unknown[] }>;
  readonly database: Queryable;
}

function fakeClient(options: FakeClientOptions): FakeClient {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];

  return {
    calls,
    database: {
      async query<Row>(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });

        const result = ((): readonly unknown[] => {
          if (text.startsWith("with updated as")) {
            return [options.row];
          }

          if (text.startsWith("with claimed as")) {
            if (text.includes("and status = 'queued' and lease_owner is null")) {
              return options.claim === undefined ? [] : [options.claim];
            }

            if (text.includes("lease_owner = $6")) {
              return options.adopt === undefined ? [] : [options.adopt];
            }

            return options.reclaim === undefined ? [] : [options.reclaim];
          }

          return options.row === undefined ? [] : [options.row];
        })();

        return { rows: result as unknown as readonly Row[] };
      },
    },
  };
}

interface Recorded {
  readonly executions: RunExecution[];
  readonly lines: Record<string, unknown>[];
}

function contextFor(
  client: Queryable,
  jobId = "job-1",
): { context: JobContext; recorded: Recorded } {
  const recorded: Recorded = { executions: [], lines: [] };

  return {
    context: {
      jobId,
      attempt: 1,
      logger: createLogger({
        service: "@porkbot/worker",
        write: (line) => recorded.lines.push(JSON.parse(line) as Record<string, unknown>),
      }),
      withPgClient: (work) => work(client),
      enqueue: async () => undefined,
    },
    recorded,
  };
}

describe("the run-execute payload", () => {
  it("accepts the three addressing fields and an optional handoff owner", () => {
    expect(parseRunExecutePayload({ runId: "run-1", fence: 2, spaceId: "space-1" })).toEqual({
      runId: "run-1",
      fence: 2,
      spaceId: "space-1",
    });
    expect(
      parseRunExecutePayload({
        runId: "run-1",
        fence: 2,
        spaceId: "space-1",
        owner: "watchdog-job",
      }),
    ).toEqual({ runId: "run-1", fence: 2, spaceId: "space-1", owner: "watchdog-job" });
  });

  it("refuses a payload that carries work", () => {
    expect(() =>
      parseRunExecutePayload({
        runId: "run-1",
        fence: 0,
        spaceId: "space-1",
        prompt: "do the thing",
      }),
    ).toThrow(/carries "prompt"/);
  });

  it("refuses a missing, blank or negative address", () => {
    expect(() => parseRunExecutePayload({ fence: 0, spaceId: "space-1" })).toThrow(JobPayloadError);
    expect(() => parseRunExecutePayload({ runId: " ", fence: 0, spaceId: "space-1" })).toThrow(
      JobPayloadError,
    );
    expect(() => parseRunExecutePayload({ runId: "run-1", fence: -1, spaceId: "space-1" })).toThrow(
      JobPayloadError,
    );
    expect(() => parseRunExecutePayload(null)).toThrow(JobPayloadError);
  });

  it("refuses a blank handoff owner rather than adopting from nobody", () => {
    expect(() =>
      parseRunExecutePayload({ runId: "run-1", fence: 0, spaceId: "space-1", owner: " " }),
    ).toThrow(JobPayloadError);
  });

  it("trims accidental whitespace rather than addressing a differently spelled row", () => {
    expect(parseRunExecutePayload({ runId: " run-1 ", fence: 0, spaceId: " space-1 " })).toEqual({
      runId: "run-1",
      fence: 0,
      spaceId: "space-1",
    });
  });
});

describe("the run-execute handler", () => {
  it("hands a fence-matched fresh run to the executor inside the payload's space", async () => {
    const run = runRecord();
    const claimed = runRecord({ status: "running", leaseOwner: "job-1", leaseFence: 1 });
    const client = fakeClient({ row: run, claim: claimed });
    const { context, recorded } = contextFor(client.database);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle({ runId: "run-1", fence: 0, spaceId: "space-1" }, context);

    expect(recorded.executions).toHaveLength(1);
    expect(recorded.executions[0]?.actor).toEqual({
      kind: "system",
      jobId: "job-1",
      spaceId: "space-1",
    });
    expect(recorded.executions[0]?.run.id).toBe("run-1");
    expect(recorded.executions[0]?.resumed).toBe(false);
    expect(client.calls[0]?.values).toEqual(["run-1", "space-1"]);
    expect(client.calls[1]?.values).toEqual(["run-1", "space-1", 0, "job-1", 120]);
  });

  it("adopts the handoff a watchdog names and resumes from the checkpoint", async () => {
    const run = runRecord({
      status: "running",
      leaseOwner: "watchdog-job",
      leaseFence: 1,
      leaseExpiresAt: new Date(120_000),
      checkpoint: { step: 3 },
    });
    const adopted = runRecord({
      status: "running",
      leaseOwner: "job-1",
      leaseFence: 2,
      checkpoint: { step: 3 },
    });
    const client = fakeClient({ row: run, adopt: adopted });
    const { context, recorded } = contextFor(client.database);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle(
      { runId: "run-1", fence: 1, spaceId: "space-1", owner: "watchdog-job" },
      context,
    );

    expect(recorded.executions).toHaveLength(1);
    expect(recorded.executions[0]?.resumed).toBe(true);
    expect(recorded.executions[0]?.run.checkpoint).toEqual({ step: 3 });
    const adopt = client.calls.find((call) => call.text.includes("lease_owner = $6"));
    expect(adopt?.values).toEqual(["run-1", "space-1", 1, "job-1", 120, "watchdog-job"]);
  });

  it("reclaims an expired lease and resumes from the checkpoint", async () => {
    const run = runRecord({
      status: "running",
      leaseOwner: "dead-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(0),
      checkpoint: { step: 9 },
    });
    const reclaimed = runRecord({
      status: "running",
      leaseOwner: "job-1",
      leaseFence: 5,
      checkpoint: { step: 9 },
    });
    const client = fakeClient({ row: run, reclaim: reclaimed });
    const { context, recorded } = contextFor(client.database);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle({ runId: "run-1", fence: 4, spaceId: "space-1" }, context);

    expect(recorded.executions).toHaveLength(1);
    expect(recorded.executions[0]?.resumed).toBe(true);
    const reclaim = client.calls.find((call) => call.text.includes("lease_expires_at <= now()"));
    expect(reclaim?.values.slice(0, 6)).toEqual([
      "run-1",
      "space-1",
      4,
      "job-1",
      120,
      expect.stringContaining("the previous owner's lease expired at"),
    ]);
  });

  it("falls back to reclaiming when a handoff's lease has already expired", async () => {
    const run = runRecord({
      status: "running",
      leaseOwner: "watchdog-job",
      leaseFence: 2,
      leaseExpiresAt: new Date(0),
      checkpoint: { step: 5 },
    });
    const reclaimed = runRecord({
      status: "running",
      leaseOwner: "job-1",
      leaseFence: 3,
      checkpoint: { step: 5 },
    });
    const client = fakeClient({ row: run, reclaim: reclaimed });
    const { context, recorded } = contextFor(client.database);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle(
      { runId: "run-1", fence: 2, spaceId: "space-1", owner: "watchdog-job" },
      context,
    );

    expect(recorded.executions).toHaveLength(1);
    expect(recorded.executions[0]?.resumed).toBe(true);
    expect(client.calls.some((call) => call.text.includes("lease_owner = $6"))).toBe(true);
    expect(client.calls.some((call) => call.text.includes("lease_expires_at <= now()"))).toBe(true);
  });

  it("fails a reclaimed run that has no checkpoint, with the typed reason, and never executes it", async () => {
    const run = runRecord({
      status: "running",
      leaseOwner: "dead-worker",
      leaseFence: 4,
      leaseExpiresAt: new Date(0),
      checkpoint: {},
    });
    const reclaimed = runRecord({
      status: "running",
      leaseOwner: "job-1",
      leaseFence: 5,
      checkpoint: {},
    });
    const client = fakeClient({ row: run, reclaim: reclaimed });
    const { context, recorded } = contextFor(client.database);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle({ runId: "run-1", fence: 4, spaceId: "space-1" }, context);

    expect(recorded.executions).toEqual([]);
    expect(recorded.lines.at(-1)).toMatchObject({
      msg: "run failed: there was nothing to resume",
      reason: "checkpoint_absent",
    });

    const failure = client.calls.find((call) => call.text.startsWith("with updated as"));
    expect(failure?.text).toContain("status = $1::run_status");
    expect(failure?.text).toContain("error_code = $3");
    expect(failure?.text).toContain("settled as (");
    expect(failure?.values).toContain("failed");
    expect(failure?.values).toContain("checkpoint_absent");
    expect(failure?.values).toContain("failed");
  });

  it("exits without side effects when the row fence moved on", async () => {
    const client = fakeClient({ row: runRecord({ leaseFence: 4 }) });
    const { context, recorded } = contextFor(client.database);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle({ runId: "run-1", fence: 3, spaceId: "space-1" }, context);

    expect(recorded.executions).toEqual([]);
    expect(recorded.lines.at(-1)).toMatchObject({ msg: "run job skipped: the row fence moved on" });
    // A skipped delivery writes nothing: the only statement is the scoped read.
    expect(client.calls).toEqual([
      { text: expect.stringContaining("from run where id ="), values: ["run-1", "space-1"] },
    ]);
  });

  it("exits when the run is not in the job's space", async () => {
    const client = fakeClient({ row: undefined });
    const { context, recorded } = contextFor(client.database);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle({ runId: "run-elsewhere", fence: 0, spaceId: "space-1" }, context);

    expect(recorded.executions).toEqual([]);
    expect(client.calls[0]?.values).toEqual(["run-elsewhere", "space-1"]);
  });

  it("treats a duplicate delivery as a no-op once the fence has moved", async () => {
    const calls: string[] = [];
    let row = runRecord();
    const client: Queryable = {
      async query<Row>(text: string) {
        calls.push(text);

        if (text.startsWith("with claimed as")) {
          row = runRecord({ status: "running", leaseOwner: "job-1", leaseFence: 1 });
        }

        return { rows: [row] as unknown as readonly Row[] };
      },
    };
    const { context, recorded } = contextFor(client);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle({ runId: "run-1", fence: 0, spaceId: "space-1" }, context);
    await job.handle({ runId: "run-1", fence: 0, spaceId: "space-1" }, context);

    expect(recorded.executions).toHaveLength(1);
    expect(calls).toHaveLength(3);
    expect(calls[0]?.trimStart().startsWith("select")).toBe(true);
    expect(calls[1]?.trimStart().startsWith("with claimed as")).toBe(true);
    expect(calls[2]?.trimStart().startsWith("select")).toBe(true);
  });

  it("exits when the run's fence matches but no acquisition guard does", async () => {
    const run = runRecord({
      status: "running",
      leaseOwner: "live-worker",
      leaseFence: 2,
      leaseExpiresAt: new Date(120_000),
    });
    const client = fakeClient({ row: run });
    const { context, recorded } = contextFor(client.database);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
    });

    await job.handle({ runId: "run-1", fence: 2, spaceId: "space-1" }, context);

    expect(recorded.executions).toEqual([]);
    expect(recorded.lines.at(-1)).toMatchObject({
      msg: "run job skipped: another worker owns the run",
    });
  });

  it("is registered under a run-execute identifier", () => {
    const job = runExecuteJob(async () => undefined);

    expect(job.identifier).toBe(runExecuteIdentifier);
  });
});
