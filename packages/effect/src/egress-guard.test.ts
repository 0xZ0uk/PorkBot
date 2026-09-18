import { Effect, Fiber, TestClock, TestContext } from "effect";
import { parseEgressAllowlist } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import { createApprovalGate } from "./approval-gate.ts";
import type { ApprovalRecord, ApprovalStore } from "./approval-gate.ts";
import { createEgressGuard } from "./egress-guard.ts";
import { ApprovalStoreError, NotFoundError } from "./errors.ts";

/**
 * The guard's contract in behaviour: an allowlisted host proceeds without ever
 * touching the approval store, an unknown host records a durable row before the
 * request exists and waits on it, an operator decision resolves the wait, and a
 * deadline the operator missed denies instead of hanging. The store is in
 * memory and the clock is Effect's `TestClock`, so the suite proves the policy
 * without a network or a wall clock; the row's durability under real
 * concurrency is `@porkbot/db`'s integration suite.
 */

const runId = "run-1";
const callId = "call-1";
const tool = "web_fetch";
const timeoutMs = 30_000;
const pollIntervalMs = 1_000;

interface MemoryApprovals {
  readonly store: ApprovalStore;
  readonly rows: Map<string, ApprovalRecord>;
  readonly opened: string[];
  readonly failOpen: { current: Error | undefined };
}

function memoryApprovals(): MemoryApprovals {
  const rows = new Map<string, ApprovalRecord>();
  const opened: string[] = [];
  const failOpen = { current: undefined as Error | undefined };

  const store: ApprovalStore = {
    async open(request) {
      if (failOpen.current !== undefined) {
        const error = failOpen.current;
        failOpen.current = undefined;
        throw error;
      }

      const existing = rows.get(request.callId);

      if (existing !== undefined) {
        return existing;
      }

      const record: ApprovalRecord = {
        id: `approval-${rows.size + 1}`,
        runId: request.runId,
        callId: request.callId,
        tool: request.tool,
        status: "pending",
        expiresAt: request.expiresAt,
        decidedBy: null,
        decidedAt: null,
        reason: null,
      };
      rows.set(request.callId, record);
      opened.push(request.tool);
      return record;
    },

    async find(_runId, id) {
      return rows.get(id);
    },

    async resolveTimeout(_runId, id) {
      const existing = rows.get(id);

      if (existing === undefined) {
        throw new NotFoundError("approval", id);
      }

      const timedOut: ApprovalRecord = {
        ...existing,
        status: "timed_out",
        decidedAt: new Date(0),
      };
      rows.set(id, timedOut);
      return timedOut;
    },
  };

  return { store, rows, opened, failOpen };
}

function pendingRecord(): ApprovalRecord {
  return {
    id: "approval-seeded",
    runId,
    callId,
    tool,
    status: "pending",
    expiresAt: new Date(timeoutMs),
    decidedBy: null,
    decidedAt: null,
    reason: null,
  };
}

function decide(
  approvals: MemoryApprovals,
  vote: "approved" | "denied",
  reason: string | null = null,
): void {
  const existing = approvals.rows.get(callId);

  if (existing === undefined) {
    throw new Error("no pending row to decide");
  }

  approvals.rows.set(callId, {
    ...existing,
    status: vote,
    decidedBy: "operator-1",
    decidedAt: new Date(0),
    reason,
  });
}

function guardFor(approvals: MemoryApprovals, hosts: readonly string[] = ["example.com"]) {
  return createEgressGuard({
    allowlist: parseEgressAllowlist(hosts),
    gate: createApprovalGate({ runId, store: approvals.store, timeoutMs, pollIntervalMs }),
  });
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));
}

describe("an allowlisted destination", () => {
  it("proceeds without opening a gate", async () => {
    const approvals = memoryApprovals();
    const guard = guardFor(approvals);

    const outcome = await run(guard.authorize({ callId, tool, url: "https://example.com/page" }));

    expect(outcome).toEqual({ status: "allowed", host: "example.com" });
    expect(approvals.opened).toEqual([]);
    expect(approvals.rows.size).toBe(0);
  });

  it("refuses a destination without a host before asking anyone", async () => {
    const approvals = memoryApprovals();
    const guard = guardFor(approvals);

    const outcome = await run(guard.authorize({ callId, tool, url: "not a url" }));

    expect(outcome).toEqual({ status: "denied", reason: "invalid_url", host: null });
    expect(approvals.opened).toEqual([]);
  });
});

describe("a destination outside the allowlist", () => {
  it("resolves with the operator's approval and the settled row", async () => {
    const approvals = memoryApprovals();
    const guard = guardFor(approvals);
    approvals.rows.set(callId, pendingRecord());
    decide(approvals, "approved");

    const outcome = await run(guard.authorize({ callId, tool, url: "https://other.test/page" }));

    expect(outcome.status).toBe("approved");
    if (outcome.status === "approved") {
      expect(outcome.host).toBe("other.test");
      expect(outcome.approval.decidedBy).toBe("operator-1");
      expect(outcome.approval.status).toBe("approved");
    }
    expect(approvals.opened).toEqual([]);
  });

  it("answers an operator denial with the row and the reason", async () => {
    const approvals = memoryApprovals();
    const guard = guardFor(approvals);
    approvals.rows.set(callId, pendingRecord());
    decide(approvals, "denied", "not this host");

    const outcome = await run(guard.authorize({ callId, tool, url: "https://other.test/page" }));

    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reason).toBe("operator_denied");
      expect(outcome.host).toBe("other.test");
      expect(outcome.approval?.reason).toBe("not this host");
    }
    expect(approvals.rows.get(callId)?.status).toBe("denied");
  });

  it("records the row for the call, then denies when the deadline passes", async () => {
    const approvals = memoryApprovals();
    const guard = guardFor(approvals, []);

    const outcome = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          guard.authorize({ callId, tool, url: "https://other.test/page" }),
        );
        yield* Effect.yieldNow();
        yield* TestClock.adjust(timeoutMs + pollIntervalMs);

        return yield* Fiber.join(fiber);
      }),
    );

    expect(outcome.status).toBe("denied");
    if (outcome.status === "denied") {
      expect(outcome.reason).toBe("approval_timed_out");
      expect(outcome.host).toBe("other.test");
      expect(outcome.approval).toBeUndefined();
    }

    const row = approvals.rows.get(callId);
    expect(row?.status).toBe("timed_out");
    expect(row?.runId).toBe(runId);
    expect(row?.tool).toBe(tool);
  });

  it("fails closed when the gate cannot be recorded", async () => {
    const approvals = memoryApprovals();
    const guard = guardFor(approvals, []);
    approvals.failOpen.current = new Error("connection refused");

    const exit = await run(
      guard.authorize({ callId, tool, url: "https://other.test/page" }).pipe(Effect.either),
    );

    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(exit.left).toBeInstanceOf(ApprovalStoreError);
    }
    expect(approvals.rows.size).toBe(0);
  });
});
