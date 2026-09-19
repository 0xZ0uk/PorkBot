import { Effect, Either, Fiber, TestClock, TestContext } from "effect";
import { createThreadSnapshot, reduceRunEvents, RUN_EVENT_SCHEMA_VERSION } from "@porkbot/core";
import type { ApprovalDecision, RunEvent } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import {
  ApprovalStoreError,
  GateTimeoutError,
  InvalidToolCallError,
  NotFoundError,
} from "./errors.ts";
import { createApprovalGate } from "./approval-gate.ts";
import type {
  ApprovalDecisions,
  ApprovalGateOptions,
  ApprovalGateShape,
  ApprovalRecord,
  ApprovalStore,
} from "./approval-gate.ts";

/**
 * The durable gate in behaviour: an unanswered gate times out to a typed deny,
 * an operator decision recorded anywhere resolves the wait, a restarted gate
 * reopens the same pending row on the original deadline, concurrent votes
 * resolve exactly once, and a store that cannot record the gate fails closed
 * instead of running the tool.
 *
 * Everything here runs on Effect's `TestClock` — no wall clock, no sleeps — and
 * the store is in memory. What durability and exactly-once add under real
 * concurrency is proven against Postgres in `@porkbot/db`'s integration suite,
 * which runs this same gate over the `approval` rows.
 */

const runId = "run-1";
const threadId = "thread-1";
const callId = "call-1";
const timeoutMs = 30_000;
const pollIntervalMs = 1_000;

const gateOptions = {
  timeoutMs,
  pollIntervalMs,
} as const;

interface MemoryApprovals {
  readonly store: ApprovalStore;
  readonly decisions: ApprovalDecisions;
  readonly rows: Map<string, ApprovalRecord>;
  readonly calls: { open: number; find: number; timeOut: number; decide: number };
  /** Thrown by the next call of that kind; cleared once thrown. */
  readonly fail: {
    open: Error | undefined;
    find: Error | undefined;
    timeOut: Error | undefined;
  };
  /** Turns a timeout resolution into a no-op for this many calls, as a slow server clock would. */
  holdTimeOut: number;
}

function key(call: string): string {
  return `${runId}/${call}`;
}

function memoryApprovals(userId = "user-1"): MemoryApprovals {
  const memory = {
    rows: new Map<string, ApprovalRecord>(),
    calls: { open: 0, find: 0, timeOut: 0, decide: 0 },
    fail: {
      open: undefined as Error | undefined,
      find: undefined as Error | undefined,
      timeOut: undefined as Error | undefined,
    },
    holdTimeOut: 0,
  };

  const store: ApprovalStore = {
    async open(request) {
      memory.calls.open += 1;

      if (memory.fail.open !== undefined) {
        const error = memory.fail.open;
        memory.fail.open = undefined;
        throw error;
      }

      const existing = memory.rows.get(key(request.callId));
      if (existing !== undefined) {
        return existing;
      }

      const record: ApprovalRecord = {
        id: `approval-${memory.rows.size + 1}`,
        runId: request.runId,
        callId: request.callId,
        tool: request.tool,
        arguments: request.arguments,
        status: "pending",
        expiresAt: request.expiresAt,
        decidedBy: null,
        decidedAt: null,
        reason: null,
      };
      memory.rows.set(key(request.callId), record);
      return record;
    },

    async find(_runId, callId) {
      memory.calls.find += 1;

      if (memory.fail.find !== undefined) {
        const error = memory.fail.find;
        memory.fail.find = undefined;
        throw error;
      }

      return memory.rows.get(key(callId));
    },

    async resolveTimeout(_runId, callId) {
      memory.calls.timeOut += 1;

      if (memory.fail.timeOut !== undefined) {
        const error = memory.fail.timeOut;
        memory.fail.timeOut = undefined;
        throw error;
      }

      const existing = memory.rows.get(key(callId));
      if (existing === undefined) {
        throw new NotFoundError("approval", callId);
      }

      if (existing.status !== "pending") {
        return existing;
      }

      if (memory.holdTimeOut > 0) {
        memory.holdTimeOut -= 1;
        return existing;
      }

      const timedOut: ApprovalRecord = {
        ...existing,
        status: "timed_out",
        decidedAt: new Date(),
      };
      memory.rows.set(key(callId), timedOut);
      return timedOut;
    },
  };

  const decisions: ApprovalDecisions = {
    async decide(input) {
      memory.calls.decide += 1;

      const existing = memory.rows.get(key(input.callId));
      if (existing === undefined) {
        throw new NotFoundError("approval", input.callId);
      }

      if (existing.status !== "pending") {
        return { record: existing, applied: false };
      }

      const record: ApprovalRecord = {
        ...existing,
        status: input.vote === "approve" ? "approved" : "denied",
        decidedBy: userId,
        decidedAt: new Date(),
        reason: input.reason ?? null,
      };
      memory.rows.set(key(input.callId), record);
      return { record, applied: true };
    },

    async listForRun() {
      return [...memory.rows.values()].filter((record) => record.runId === runId);
    },

    async list() {
      return [...memory.rows.values()].map((record) => ({
        ...record,
        botId: "bot-1",
        threadId: "thread-1",
      }));
    },
  };

  return Object.assign(memory, { store, decisions });
}

function gateOf(
  approvals: MemoryApprovals,
  overrides: Partial<Pick<ApprovalGateOptions, "timeoutMs" | "pollIntervalMs">> = {},
): ApprovalGateShape {
  return createApprovalGate({
    runId,
    store: approvals.store,
    ...gateOptions,
    ...overrides,
  });
}

/** Runs an Effect program with a controllable clock. */
function withTestClock<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));
}

async function waitOutcome(
  gate: ApprovalGateShape,
  record: ApprovalRecord,
  advanceMs: number,
): Promise<Either.Either<ApprovalRecord, unknown>> {
  return withTestClock(
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(gate.waitFor(record).pipe(Effect.either));
      yield* Effect.yieldNow();
      yield* TestClock.adjust(advanceMs);
      return yield* Fiber.join(fiber);
    }),
  );
}

describe("a gate nobody answers", () => {
  it("resolves to a typed deny after the deadline, never a hang", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);

    const exit = await withTestClock(
      Effect.gen(function* () {
        const record = yield* gate.open({ callId, tool: "shell", arguments: {} });
        const fiber = yield* Effect.fork(gate.waitFor(record).pipe(Effect.either));
        yield* Effect.yieldNow();
        yield* TestClock.adjust(timeoutMs + pollIntervalMs);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(Either.isLeft(exit)).toBe(true);
    if (Either.isLeft(exit)) {
      expect(exit.left).toBeInstanceOf(GateTimeoutError);
      if (exit.left instanceof GateTimeoutError) {
        expect(exit.left.callId).toBe(callId);
      }
    }

    const row = approvals.rows.get(key(callId));
    expect(row?.status).toBe("timed_out");
    expect(row?.decidedAt).not.toBeNull();
    expect(row?.decidedBy).toBeNull();
  });

  it("keeps waiting while the store still considers the gate due in the future", async () => {
    const approvals = memoryApprovals();
    approvals.holdTimeOut = 2;
    const gate = gateOf(approvals);

    const outcome = await waitOutcome(
      gate,
      await withTestClock(gate.open({ callId, tool: "shell", arguments: {} })),
      timeoutMs + 3 * pollIntervalMs,
    );

    expect(Either.isLeft(outcome)).toBe(true);
    expect(approvals.calls.timeOut).toBeGreaterThanOrEqual(3);
    expect(approvals.rows.get(key(callId))?.status).toBe("timed_out");
  });

  it("answers an already timed-out row with the typed error without waiting", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);
    const record = await withTestClock(gate.open({ callId, tool: "shell", arguments: {} }));
    await approvals.store.resolveTimeout(runId, callId);

    const outcome = await waitOutcome(gate, record, 0);

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(GateTimeoutError);
    }
    expect(approvals.calls.find).toBe(1);
  });
});

describe("an operator decision", () => {
  it("resolves the wait with the record the store holds, including who and when", async () => {
    const approvals = memoryApprovals("operator-1");
    const gate = gateOf(approvals);

    const record = await withTestClock(gate.open({ callId, tool: "shell", arguments: {} }));
    const outcome = await withTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(gate.waitFor(record).pipe(Effect.either));
        yield* Effect.yieldNow();

        const vote = yield* Effect.promise(() =>
          approvals.decisions.decide({ runId, callId, vote: "deny", reason: "too risky" }),
        );
        expect(vote.applied).toBe(true);

        yield* TestClock.adjust(pollIntervalMs);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(Either.isRight(outcome)).toBe(true);
    if (Either.isRight(outcome)) {
      expect(outcome.right.status).toBe("denied");
      expect(outcome.right.decidedBy).toBe("operator-1");
      expect(outcome.right.decidedAt).not.toBeNull();
      expect(outcome.right.reason).toBe("too risky");
    }
  });

  it("answers immediately when the decision predates the wait", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);
    const record = await withTestClock(gate.open({ callId, tool: "shell", arguments: {} }));
    await approvals.decisions.decide({ runId, callId, vote: "approve" });

    const outcome = await waitOutcome(gate, record, 0);

    expect(Either.isRight(outcome)).toBe(true);
    if (Either.isRight(outcome)) {
      expect(outcome.right.status).toBe("approved");
    }
  });

  it("keeps an operator decision that landed before the deadline", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);
    const record = await withTestClock(gate.open({ callId, tool: "shell", arguments: {} }));
    const vote = await approvals.decisions.decide({ runId, callId, vote: "deny", reason: "no" });
    expect(vote.applied).toBe(true);

    const outcome = await waitOutcome(gate, record, timeoutMs + pollIntervalMs);

    expect(Either.isRight(outcome)).toBe(true);
    if (Either.isRight(outcome)) {
      expect(outcome.right.status).toBe("denied");
    }
    expect(approvals.calls.timeOut).toBe(0);
  });

  it("does not let a late vote change a timeout that already won", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);
    const record = await withTestClock(gate.open({ callId, tool: "shell", arguments: {} }));
    const outcome = await waitOutcome(gate, record, timeoutMs + pollIntervalMs);
    expect(Either.isLeft(outcome)).toBe(true);

    const late = await approvals.decisions.decide({ runId, callId, vote: "approve" });
    expect(late.applied).toBe(false);
    expect(late.record.status).toBe("timed_out");
    expect(late.record.decidedBy).toBeNull();
  });
});

describe("a restarted gate", () => {
  it("reopens the same pending row and waits on the original deadline", async () => {
    const approvals = memoryApprovals();
    const first = gateOf(approvals);
    const opened = await withTestClock(first.open({ callId, tool: "shell", arguments: {} }));

    // A restart is a new gate over the same durable rows.
    const restarted = gateOf(approvals, { timeoutMs: 5 });
    const reopened = await withTestClock(restarted.open({ callId, tool: "shell", arguments: {} }));

    expect(reopened.id).toBe(opened.id);
    expect(reopened.expiresAt).toEqual(opened.expiresAt);

    const outcome = await waitOutcome(restarted, reopened, timeoutMs + pollIntervalMs);
    expect(Either.isLeft(outcome)).toBe(true);
    expect(approvals.rows.get(key(callId))?.status).toBe("timed_out");
  });

  it("does not rewrite a decision taken while the run was gone", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);
    await withTestClock(gate.open({ callId, tool: "shell", arguments: {} }));
    await approvals.decisions.decide({ runId, callId, vote: "approve" });

    const restarted = gateOf(approvals);
    const reopened = await withTestClock(restarted.open({ callId, tool: "shell", arguments: {} }));
    const outcome = await waitOutcome(restarted, reopened, 0);

    expect(reopened.status).toBe("approved");
    expect(Either.isRight(outcome)).toBe(true);
    if (Either.isRight(outcome)) {
      expect(outcome.right.decidedBy).toBe("user-1");
    }
  });
});

describe("a store that cannot hold the gate", () => {
  it("fails closed with the typed store error instead of running the tool", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);

    approvals.fail.open = new Error("database is down");
    const outcome = await withTestClock(
      gate.open({ callId, tool: "shell", arguments: {} }).pipe(Effect.either),
    );

    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(ApprovalStoreError);
      if (outcome.left instanceof ApprovalStoreError) {
        expect(outcome.left.operation).toBe("open");
      }
    }
  });

  it("keeps the scoped not-found typed", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);
    approvals.fail.open = new NotFoundError("run", runId);

    const outcome = await withTestClock(
      gate.open({ callId, tool: "shell", arguments: {} }).pipe(Effect.either),
    );
    expect(Either.isLeft(outcome)).toBe(true);
    if (Either.isLeft(outcome)) {
      expect(outcome.left).toBeInstanceOf(NotFoundError);
    }
  });

  it("fails a wait whose read or timeout resolution breaks", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);
    const record = await withTestClock(gate.open({ callId, tool: "shell", arguments: {} }));

    approvals.fail.find = new Error("read failed");
    const readOutcome = await withTestClock(gate.waitFor(record).pipe(Effect.either));
    expect(Either.isLeft(readOutcome)).toBe(true);
    if (Either.isLeft(readOutcome)) {
      expect(readOutcome.left).toBeInstanceOf(ApprovalStoreError);
      if (readOutcome.left instanceof ApprovalStoreError) {
        expect(readOutcome.left.operation).toBe("read");
      }
    }

    approvals.fail.timeOut = new Error("write failed");
    const timedOut = await withTestClock(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(gate.waitFor(record).pipe(Effect.either));
        yield* Effect.yieldNow();
        yield* TestClock.adjust(timeoutMs + pollIntervalMs);
        return yield* Fiber.join(fiber);
      }),
    );
    expect(Either.isLeft(timedOut)).toBe(true);
    if (Either.isLeft(timedOut)) {
      expect(timedOut.left).toBeInstanceOf(ApprovalStoreError);
      if (timedOut.left instanceof ApprovalStoreError) {
        expect(timedOut.left.operation).toBe("time_out");
      }
    }
  });
});

describe("the gate's construction and the votes on it", () => {
  it("refuses a blank call id or tool before any write", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);

    for (const input of [
      { callId: "  ", tool: "shell", arguments: {} },
      { callId, tool: "", arguments: {} },
    ]) {
      const outcome = await withTestClock(gate.open(input).pipe(Effect.either));
      expect(Either.isLeft(outcome)).toBe(true);
      if (Either.isLeft(outcome)) {
        expect(outcome.left).toBeInstanceOf(InvalidToolCallError);
      }
    }

    expect(approvals.calls.open).toBe(0);
  });

  it("records the call's arguments with a secret-shaped field redacted", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);

    await withTestClock(
      gate.open({
        callId,
        tool: "file_write",
        arguments: { path: ".env", token: "sk-live-value" },
      }),
    );

    expect(approvals.rows.get(key(callId))?.arguments).toEqual({
      path: ".env",
      token: "[redacted]",
    });
  });

  it("refuses a non-positive timeout or poll interval", () => {
    const approvals = memoryApprovals();

    expect(() => gateOf(approvals, { timeoutMs: 0 })).toThrow(RangeError);
    expect(() => gateOf(approvals, { timeoutMs: -1 })).toThrow(RangeError);
    expect(() => gateOf(approvals, { timeoutMs: 1.5 })).toThrow(RangeError);
    expect(() => gateOf(approvals, { pollIntervalMs: 0 })).toThrow(RangeError);
  });

  it("applies exactly one of many concurrent votes", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);
    await withTestClock(gate.open({ callId, tool: "shell", arguments: {} }));

    const votes = await Promise.all(
      Array.from({ length: 8 }, (_value, index) =>
        approvals.decisions.decide({
          runId,
          callId,
          vote: index % 2 === 0 ? "approve" : "deny",
        }),
      ),
    );

    expect(votes.filter((vote) => vote.applied)).toHaveLength(1);
    const final = approvals.rows.get(key(callId));
    expect(final?.status === "approved" || final?.status === "denied").toBe(true);
    expect(new Set(votes.map((vote) => vote.record.status)).size).toBe(1);
    expect(new Set(votes.map((vote) => vote.record.decidedBy))).toEqual(new Set(["user-1"]));
  });
});

describe("the stream a client reduces", () => {
  it("renders a timed-out gate as a timed-out approval and a failed call", async () => {
    const approvals = memoryApprovals();
    const gate = gateOf(approvals);

    const events = await withTestClock(
      Effect.gen(function* () {
        const record = yield* gate.open({ callId, tool: "shell", arguments: {} });
        const frame = (seq: number) =>
          ({
            schemaVersion: RUN_EVENT_SCHEMA_VERSION,
            seq,
            threadId,
            runId,
          }) as const;
        const events: RunEvent[] = [
          { ...frame(1), type: "run.started" },
          { ...frame(2), type: "tool.requested", callId, tool: "shell", arguments: {} },
          {
            ...frame(3),
            type: "approval.requested",
            callId,
            expiresAt: record.expiresAt.toISOString(),
          },
        ];

        const fiber = yield* Effect.fork(gate.waitFor(record).pipe(Effect.either));
        yield* Effect.yieldNow();
        yield* TestClock.adjust(timeoutMs + pollIntervalMs);
        const outcome = yield* Fiber.join(fiber);

        const decision: ApprovalDecision =
          Either.isLeft(outcome) && outcome.left instanceof GateTimeoutError
            ? "timed_out"
            : "approved";

        events.push({ ...frame(4), type: "approval.resolved", callId, decision });
        events.push({
          ...frame(5),
          type: "tool.failed",
          callId,
          error: "the approval gate timed out",
        });

        return events;
      }),
    );

    const reduced = reduceRunEvents(createThreadSnapshot(threadId), events);
    expect(reduced.ok).toBe(true);

    if (reduced.ok) {
      const run = reduced.snapshot.runs[0];
      expect(run?.status).toBe("running");
      expect(run?.toolCalls[0]).toMatchObject({
        status: "failed",
        approval: { status: "timed_out" },
      });
    }
  });
});
