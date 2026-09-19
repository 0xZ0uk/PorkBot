import { ROUTINE_MISS_GRACE_MS } from "@porkbot/core";
import type {
  DueRoutine,
  QueuedRoutineRun,
  Queryable,
  RoutineRecord,
  RunRecord,
} from "@porkbot/db";
import { createLogger } from "@porkbot/logging";
import { parseCronItems } from "graphile-worker";
import { describe, expect, it } from "vitest";
import { JobPayloadError } from "../job-registry.ts";
import type { JobContext } from "../job-registry.ts";
import { routineSchedule } from "../worker.ts";
import {
  parseRoutineTickPayload,
  routineTickIdentifier,
  routineTickJob,
} from "./routine-schedule.ts";
import { runExecuteIdentifier } from "./run-execute.ts";

/**
 * The routine tick's contract, without a queue: the cross-space scan, the pure
 * decision on the database's clock, the two settle paths through the same
 * run-creation command the message path uses, the enqueue that hands the run
 * to the existing executor, and the reconciliation of a delivery that never
 * landed. A fake client answers each statement by name, so every write path is
 * observable and the decision is the only moving part.
 */

const slot = new Date("2026-01-01T09:00:00.000Z");

function dueRoutine(overrides: Partial<DueRoutine> = {}): DueRoutine {
  return {
    id: "routine-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    instruction: "summarise the inbox",
    cron: "0 9 * * *",
    timezone: "UTC",
    nextRunAt: slot,
    now: slot,
    ...overrides,
  };
}

function routineRecord(overrides: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: "routine-1",
    spaceId: "space-1",
    botId: "bot-1",
    userId: "user-1",
    threadId: "thread-1",
    instruction: "summarise the inbox",
    cron: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    nextRunAt: slot,
    deletedAt: null,
    createdAt: slot,
    updatedAt: slot,
    ...overrides,
  };
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    userId: "user-1",
    status: "queued",
    trigger: "routine",
    error: null,
    errorCode: null,
    leaseOwner: null,
    leaseFence: 0,
    leaseExpiresAt: null,
    stopRequestedAt: null,
    checkpoint: {},
    clientNonce: `routine:routine-1:${slot.getTime()}`,
    sourceMessageId: null,
    startedAt: null,
    completedAt: null,
    createdAt: slot,
    updatedAt: slot,
    ...overrides,
  };
}

interface FakeWorld {
  readonly due: readonly DueRoutine[];
  readonly routine: RoutineRecord | undefined;
  readonly occurrence: { readonly id: string } | undefined;
  readonly queued: readonly QueuedRoutineRun[];
  /** Routine ids whose locked settle throws, for the failure-isolation test. */
  readonly failures: ReadonlySet<string>;
  readonly calls: Array<{ readonly text: string; readonly values: readonly unknown[] }>;
  readonly enqueued: Array<{
    readonly identifier: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly jobKey?: string;
    readonly jobKeyMode?: string;
  }>;
  readonly lines: Record<string, unknown>[];
}

function world(options: {
  readonly due?: readonly DueRoutine[];
  readonly routine?: RoutineRecord | undefined;
  readonly occurrence?: { readonly id: string } | undefined;
  readonly queued?: readonly QueuedRoutineRun[];
  readonly failures?: readonly string[];
}): FakeWorld {
  return {
    due: options.due ?? [],
    routine: options.routine,
    occurrence: options.occurrence,
    queued: options.queued ?? [],
    failures: new Set(options.failures ?? []),
    calls: [],
    enqueued: [],
    lines: [],
  };
}

function fakeContext(state: FakeWorld): JobContext {
  const client: Queryable = {
    async query<Row>(text: string, values: readonly unknown[] = []) {
      state.calls.push({ text, values });

      if (text.includes("from routine where enabled")) {
        return { rows: state.due as unknown as readonly Row[] };
      }

      if (text.includes("for update")) {
        const routineId = String(values[0] ?? "");

        if (state.failures.has(routineId)) {
          throw new Error(`the "${routineId}" settle was made to fail`);
        }

        const rows = state.routine === undefined ? [] : [{ id: state.routine.id }];
        return { rows: rows as unknown as readonly Row[] };
      }

      if (text.includes("insert into task")) {
        return { rows: [{ id: "task-1" }] as unknown as readonly Row[] };
      }

      if (text.includes("insert into routine_occurrence")) {
        const rows = state.occurrence === undefined ? [] : [{ id: state.occurrence.id }];
        return { rows: rows as unknown as readonly Row[] };
      }

      if (text.includes("insert into run")) {
        return { rows: [runRecord()] as unknown as readonly Row[] };
      }

      if (text.includes("from run where trigger = 'routine'")) {
        return { rows: state.queued as unknown as readonly Row[] };
      }

      if (text.includes("update routine set next_run_at")) {
        const rows = state.routine === undefined ? [] : [{ id: state.routine.id }];
        return { rows: rows as unknown as readonly Row[] };
      }

      return { rows: [] as unknown as readonly Row[] };
    },
  };

  return {
    jobId: "routine-tick-job",
    attempt: 1,
    logger: createLogger({
      service: "@porkbot/worker",
      write: (line) => state.lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    withPgClient: (work) => work(client),
    enqueue: async (identifier, payload, options) => {
      state.enqueued.push({
        identifier,
        payload,
        ...(options?.jobKey === undefined ? {} : { jobKey: options.jobKey }),
        ...(options?.jobKeyMode === undefined ? {} : { jobKeyMode: options.jobKeyMode }),
      });
    },
  };
}

describe("the routine tick payload and schedule", () => {
  it("takes an empty payload and tolerates Graphile's cron marker", () => {
    expect(parseRoutineTickPayload({})).toEqual({});
    expect(parseRoutineTickPayload({ _cron: { ts: "2026-09-18T00:00:00Z" } })).toEqual({});
  });

  it("refuses a payload that carries work", () => {
    expect(() => parseRoutineTickPayload({ routineId: "routine-1" })).toThrow(
      /carries "routineId"/,
    );
    expect(() => parseRoutineTickPayload(null)).toThrow(JobPayloadError);
  });

  it("is registered under the scheduler's identifier and parsed by Graphile every minute", () => {
    expect(routineTickJob().identifier).toBe(routineTickIdentifier);
    expect(routineSchedule).toMatchObject({
      task: routineTickIdentifier,
      match: "* * * * *",
    });

    const [parsed] = parseCronItems([routineSchedule]);
    expect(parsed?.task).toBe(routineTickIdentifier);
  });
});

describe("the routine tick pass", () => {
  it("fires a due slot into an ordinary run and hands it to the existing executor", async () => {
    const state = world({
      due: [dueRoutine()],
      routine: routineRecord(),
      occurrence: { id: "occ-1" },
    });
    const context = fakeContext(state);

    await routineTickJob().handle({}, context);

    expect(state.enqueued).toEqual([
      {
        identifier: runExecuteIdentifier,
        payload: { runId: "run-1", fence: 0, spaceId: "space-1" },
        jobKey: `${runExecuteIdentifier}:run-1`,
        jobKeyMode: "replace",
      },
    ]);

    const runInsert = state.calls.find((call) => call.text.includes("insert into run"));
    expect(runInsert?.text).toContain("'routine'");
    expect(runInsert?.values).toContain("space-1");

    const advance = state.calls.find((call) =>
      call.text.includes("update routine set next_run_at"),
    );
    expect(advance?.values).toContainEqual(new Date("2026-01-02T09:00:00.000Z"));

    expect(state.lines.at(-2)).toMatchObject({
      msg: "routine fired",
      correlationId: "run-1",
      scheduledFor: "2026-01-01T09:00:00.000Z",
    });
    expect(state.lines.at(-1)).toMatchObject({
      msg: "routine tick complete",
      scanned: 1,
      fired: 1,
      missed: 0,
      skipped: 0,
      invalid: 0,
      dispatched: 0,
    });
  });

  it("records a slot past the grace as missed and never creates a run", async () => {
    const state = world({
      due: [dueRoutine({ now: new Date(slot.getTime() + ROUTINE_MISS_GRACE_MS + 1) })],
      routine: routineRecord(),
      occurrence: { id: "occ-1" },
    });
    const context = fakeContext(state);

    await routineTickJob().handle({}, context);

    expect(state.calls.some((call) => call.text.includes("insert into task"))).toBe(false);
    expect(state.calls.some((call) => call.text.includes("insert into run"))).toBe(false);
    expect(state.enqueued).toEqual([]);

    const occurrenceInsert = state.calls.find((call) =>
      call.text.includes("insert into routine_occurrence"),
    );
    expect(occurrenceInsert?.values).toEqual(["routine-1", slot]);
    expect(state.lines.at(-2)).toMatchObject({ msg: /routine slot missed/ });
    expect(state.lines.at(-1)).toMatchObject({ scanned: 1, fired: 0, missed: 1 });
  });

  it("skips a slot another pass settled first, writing nothing", async () => {
    const state = world({ due: [dueRoutine()], routine: routineRecord(), occurrence: undefined });
    const context = fakeContext(state);

    await routineTickJob().handle({}, context);

    expect(state.calls.some((call) => call.text.includes("insert into task"))).toBe(false);
    expect(state.enqueued).toEqual([]);
    expect(state.lines.at(-1)).toMatchObject({ scanned: 1, fired: 0, skipped: 1 });
  });

  it("skips a schedule row it cannot resolve instead of retrying forever", async () => {
    const state = world({
      due: [dueRoutine({ cron: "0 0 31 2 *" })],
      routine: routineRecord({ cron: "0 0 31 2 *" }),
      occurrence: { id: "occ-1" },
    });
    const context = fakeContext(state);

    await routineTickJob().handle({}, context);

    expect(state.enqueued).toEqual([]);
    expect(state.calls.some((call) => call.text.includes("for update"))).toBe(false);
    expect(state.lines.at(-2)).toMatchObject({ msg: /cannot resolve/ });
    expect(state.lines.at(-1)).toMatchObject({ scanned: 1, invalid: 1 });
  });

  it("keeps settling the rest of the pass when one slot fails", async () => {
    const state = world({
      due: [dueRoutine({ id: "routine-1" }), dueRoutine({ id: "routine-2" })],
      routine: routineRecord({ id: "routine-2" }),
      occurrence: { id: "occ-1" },
      failures: ["routine-1"],
    });
    const context = fakeContext(state);

    await routineTickJob().handle({}, context);

    expect(state.enqueued).toHaveLength(1);
    expect(state.lines).toContainEqual(
      expect.objectContaining({
        msg: "routine slot failed to settle",
        routineId: "routine-1",
      }),
    );
    expect(state.lines.at(-1)).toMatchObject({ scanned: 2, fired: 1, failed: 1 });
  });

  it("re-addresses a routine run whose delivery never landed", async () => {
    const state = world({
      queued: [{ runId: "run-stranded", spaceId: "space-2", fence: 0 }],
    });
    const context = fakeContext(state);

    await routineTickJob().handle({}, context);

    expect(state.enqueued).toEqual([
      {
        identifier: runExecuteIdentifier,
        payload: { runId: "run-stranded", fence: 0, spaceId: "space-2" },
        jobKey: `${runExecuteIdentifier}:run-stranded`,
        jobKeyMode: "replace",
      },
    ]);
    expect(state.lines.at(-2)).toMatchObject({ msg: /re-addressed a stranded run/ });
    expect(state.lines.at(-1)).toMatchObject({ dispatched: 1 });
  });

  it("reads the batch limit from its options and reports an empty pass", async () => {
    const state = world({});
    const context = fakeContext(state);

    await routineTickJob({ batchLimit: 3 }).handle({}, context);

    const scan = state.calls.find((call) => call.text.includes("from routine where enabled"));
    expect(scan?.values).toEqual([3]);

    const queuedScan = state.calls.find((call) => call.text.includes("from run where trigger"));
    expect(queuedScan?.values[0]).toBe(3);

    expect(state.lines.at(-1)).toMatchObject({ scanned: 0, dispatched: 0 });
  });
});
