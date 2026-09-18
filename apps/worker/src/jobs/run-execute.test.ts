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
 * whether the executor is called. A fake client stands in for the connection
 * the runner checks out, so "the decision came from the row" is observable: the
 * tests change the row between deliveries and watch the executor's calls.
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

interface FakeClient {
  readonly calls: ReadonlyArray<{ readonly text: string; readonly values: readonly unknown[] }>;
  readonly database: Queryable;
}

function fakeClient(row: RunRecord | undefined): FakeClient {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];

  return {
    calls,
    database: {
      async query<Row>(text: string, values: readonly unknown[] = []) {
        calls.push({ text, values });

        return { rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] };
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
    },
    recorded,
  };
}

describe("the run-execute payload", () => {
  it("accepts the three addressing fields", () => {
    expect(parseRunExecutePayload({ runId: "run-1", fence: 2, spaceId: "space-1" })).toEqual({
      runId: "run-1",
      fence: 2,
      spaceId: "space-1",
    });
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

  it("trims accidental whitespace rather than addressing a differently spelled row", () => {
    expect(parseRunExecutePayload({ runId: " run-1 ", fence: 0, spaceId: " space-1 " })).toEqual({
      runId: "run-1",
      fence: 0,
      spaceId: "space-1",
    });
  });
});

describe("the run-execute handler", () => {
  it("hands a fence-matched run to the executor inside the payload's space", async () => {
    const run = runRecord();
    const client = fakeClient(run);
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
    expect(client.calls[0]?.values).toEqual(["run-1", "space-1"]);
  });

  it("exits without side effects when the row fence moved on", async () => {
    const client = fakeClient(runRecord({ leaseFence: 4 }));
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
    const client = fakeClient(undefined);
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

        return { rows: [row] as unknown as readonly Row[] };
      },
    };
    const { context, recorded } = contextFor(client);
    const job = runExecuteJob(async (execution) => {
      recorded.executions.push(execution);
      // What slice 6.2's claim does: the first delivery takes the row's fence.
      row = runRecord({ leaseFence: 1 });
    });

    await job.handle({ runId: "run-1", fence: 0, spaceId: "space-1" }, context);
    await job.handle({ runId: "run-1", fence: 0, spaceId: "space-1" }, context);

    expect(recorded.executions).toHaveLength(1);
    // The duplicate's statements are reads: the handler never writes, so a
    // redelivery cannot duplicate work on its own.
    expect(calls).toHaveLength(2);
    expect(calls.every((text) => text.trimStart().startsWith("select"))).toBe(true);
  });

  it("is registered under a run-execute identifier", () => {
    const job = runExecuteJob(async () => undefined);

    expect(job.identifier).toBe(runExecuteIdentifier);
  });
});
