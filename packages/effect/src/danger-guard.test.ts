import { Effect, Fiber, TestClock, TestContext } from "effect";
import { parseEgressAllowlist } from "@porkbot/core";
import type { DangerousActionClass } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import { ApprovalStoreError, NotFoundError } from "./errors.ts";
import type { ApprovalRecord, ApprovalStore } from "./approval-gate.ts";
import { actionRefusalResult, createDangerousActionGuard } from "./danger-guard.ts";
import type { ActionAuthorization } from "./danger-guard.ts";
import type { ToolCall } from "./tool-dispatcher.ts";

/**
 * The guard's contract in behaviour: every class in the danger register opens
 * the run's durable approval gate when its arguments match, a benign action in
 * the same class never does, an operator decision recorded anywhere resolves
 * the wait, and a deadline the operator missed denies rather than hangs.
 *
 * The store is in memory and the clock is Effect's `TestClock`, so the policy
 * is proven without a network or a wall clock; the row's durability under real
 * concurrency is `@porkbot/db`'s integration suite. The class register itself
 * is pinned in `@porkbot/core`; this suite proves the gate fires from it.
 */

const runId = "run-1";
const callId = "call-1";
const timeoutMs = 30_000;
const pollIntervalMs = 1_000;
const home = "/home/agent";

interface MemoryApprovals {
  readonly store: ApprovalStore;
  readonly rows: Map<string, ApprovalRecord>;
  readonly opened: { readonly tool: string; readonly arguments: unknown }[];
  readonly failOpen: { current: Error | undefined };
}

function memoryApprovals(): MemoryApprovals {
  const rows = new Map<string, ApprovalRecord>();
  const opened: { tool: string; arguments: unknown }[] = [];
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
        arguments: request.arguments,
        status: "pending",
        expiresAt: request.expiresAt,
        decidedBy: null,
        decidedAt: null,
        reason: null,
      };
      rows.set(request.callId, record);
      opened.push({ tool: request.tool, arguments: request.arguments });
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

function guardFor(
  approvals: MemoryApprovals,
  options: { hosts?: readonly string[]; store?: boolean } = {},
) {
  return createDangerousActionGuard({
    ...(options.store === false ? {} : { store: approvals.store }),
    home,
    allowlist: parseEgressAllowlist(options.hosts ?? ["example.com"]),
    timeoutMs,
    pollIntervalMs,
  });
}

function call(tool: string, arguments_: unknown, id: string = callId): ToolCall {
  return { runId, callId: id, tool, arguments: arguments_ };
}

function run<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));
}

async function authorized(
  approvals: MemoryApprovals,
  tool: string,
  arguments_: unknown,
  declared: readonly DangerousActionClass[],
  options: { hosts?: readonly string[]; store?: boolean } = {},
): Promise<ActionAuthorization> {
  const guard = guardFor(approvals, options);

  return run(guard.authorize({ call: call(tool, arguments_), declared }));
}

function denialReason(authorization: ActionAuthorization): unknown {
  return authorization.status === "denied" ? authorization.reason : undefined;
}

describe("a call the policy does not flag", () => {
  it("proceeds without opening a gate", async () => {
    const approvals = memoryApprovals();
    const outcome = await authorized(approvals, "file_read", { path: "notes/todo.md" }, [
      "credential_access",
    ]);

    expect(outcome).toEqual({ status: "allowed" });
    expect(approvals.rows.size).toBe(0);
  });

  it("leaves an allowlisted destination alone", async () => {
    const approvals = memoryApprovals();
    const outcome = await authorized(approvals, "web_fetch", { url: "https://example.com/page" }, [
      "egress_unlisted",
    ]);

    expect(outcome).toEqual({ status: "allowed" });
    expect(approvals.rows.size).toBe(0);
  });

  it("leaves an inside-home write alone", async () => {
    const approvals = memoryApprovals();
    const outcome = await authorized(approvals, "file_write", { path: "notes/todo.md" }, [
      "credential_access",
      "write_outside_home",
    ]);

    expect(outcome).toEqual({ status: "allowed" });
    expect(approvals.rows.size).toBe(0);
  });
});

describe("each dangerous class", () => {
  const classes: readonly {
    readonly name: string;
    readonly tool: string;
    readonly arguments: unknown;
    readonly declared: readonly DangerousActionClass[];
  }[] = [
    {
      name: "credential_access",
      tool: "file_read",
      arguments: { path: ".ssh/id_rsa" },
      declared: ["credential_access"],
    },
    {
      name: "credential_request",
      tool: "request_secret",
      arguments: { name: "example_api" },
      declared: ["credential_request"],
    },
    {
      name: "write_outside_home",
      tool: "file_write",
      arguments: { path: "/etc/hosts" },
      declared: ["credential_access", "write_outside_home"],
    },
    {
      name: "egress_unlisted",
      tool: "web_fetch",
      arguments: { url: "https://other.test/page" },
      declared: ["egress_unlisted"],
    },
    {
      name: "send",
      tool: "mcp_slack_send_message",
      arguments: { channel: "#general", text: "hi" },
      declared: ["send"],
    },
    {
      name: "delete",
      tool: "mcp_linear_delete_issue",
      arguments: { id: "issue-1" },
      declared: ["delete"],
    },
  ];

  for (const entry of classes) {
    it(`opens the gate for ${entry.name} and resolves the operator's approval`, async () => {
      const approvals = memoryApprovals();
      approvals.rows.set(callId, {
        id: "approval-seeded",
        runId,
        callId,
        tool: entry.tool,
        arguments: entry.arguments,
        status: "pending",
        expiresAt: new Date(timeoutMs),
        decidedBy: null,
        decidedAt: null,
        reason: null,
      });
      decide(approvals, "approved");

      const outcome = await authorized(approvals, entry.tool, entry.arguments, entry.declared);

      expect(outcome.status).toBe("approved");
      if (outcome.status === "approved") {
        expect(outcome.action.class).toBe(entry.name);
        expect(outcome.approval.decidedBy).toBe("operator-1");
      }
    });

    it(`records the call's arguments when the gate opens for ${entry.name}`, async () => {
      const approvals = memoryApprovals();
      const outcome = await run(
        Effect.gen(function* () {
          const guard = guardFor(approvals);
          const fiber = yield* Effect.fork(
            guard.authorize({ call: call(entry.tool, entry.arguments), declared: entry.declared }),
          );
          yield* Effect.yieldNow();
          yield* TestClock.adjust(timeoutMs + pollIntervalMs);
          return yield* Fiber.join(fiber);
        }),
      );

      expect(outcome.status).toBe("denied");
      expect(denialReason(outcome)).toBe("approval_timed_out");
      expect(approvals.opened).toEqual([{ tool: entry.tool, arguments: entry.arguments }]);
      expect(approvals.rows.get(callId)?.status).toBe("timed_out");
    });

    it(`answers an operator denial for ${entry.name} with the row and the reason`, async () => {
      const approvals = memoryApprovals();
      approvals.rows.set(callId, {
        id: "approval-seeded",
        runId,
        callId,
        tool: entry.tool,
        arguments: entry.arguments,
        status: "pending",
        expiresAt: new Date(timeoutMs),
        decidedBy: null,
        decidedAt: null,
        reason: null,
      });
      decide(approvals, "denied", "not this one");

      const outcome = await authorized(approvals, entry.tool, entry.arguments, entry.declared);

      expect(outcome.status).toBe("denied");
      if (outcome.status === "denied") {
        expect(outcome.reason).toBe("operator_denied");
        expect(outcome.action.class).toBe(entry.name);
        expect(outcome.approval?.reason).toBe("not this one");
      }

      const refusal = actionRefusalResult(
        outcome as Extract<ActionAuthorization, { status: "denied" }>,
      ) as Record<string, unknown>;
      expect(refusal).toMatchObject({
        ok: false,
        reason: "approval_denied",
        class: entry.name,
        operatorReason: "not this one",
      });
    });
  }
});

describe("a refused destination", () => {
  it("refuses a URL that cannot be attributed, without opening a gate", async () => {
    const approvals = memoryApprovals();
    const outcome = await authorized(approvals, "web_fetch", { url: "not a url" }, [
      "egress_unlisted",
    ]);

    expect(outcome).toEqual({ status: "refused", reason: "invalid_url" });
    expect(approvals.rows.size).toBe(0);
    expect(
      actionRefusalResult(outcome as Extract<ActionAuthorization, { status: "refused" }>),
    ).toEqual({ ok: false, reason: "invalid_url", message: "the URL is not a valid destination" });
  });

  it("fails closed with no gate to ask", async () => {
    const approvals = memoryApprovals();
    const outcome = await authorized(
      approvals,
      "file_read",
      { path: ".ssh/id_rsa" },
      ["credential_access"],
      { store: false },
    );

    expect(outcome).toMatchObject({
      status: "refused",
      reason: "approval_unavailable",
      action: { class: "credential_access" },
    });
    expect(approvals.rows.size).toBe(0);
    expect(
      actionRefusalResult(outcome as Extract<ActionAuthorization, { status: "refused" }>),
    ).toMatchObject({ ok: false, reason: "approval_unavailable", class: "credential_access" });
  });
});

describe("a redacted decision record", () => {
  it("stores the arguments with a secret-shaped field redacted", async () => {
    const approvals = memoryApprovals();

    await run(
      Effect.gen(function* () {
        const guard = guardFor(approvals);
        const fiber = yield* Effect.fork(
          guard.authorize({
            call: call("mcp_slack_send_message", { channel: "#general", token: "xoxb-secret" }),
            declared: ["send"],
          }),
        );
        yield* Effect.yieldNow();
        yield* TestClock.adjust(timeoutMs + pollIntervalMs);
        yield* Fiber.join(fiber);
      }),
    );

    expect(approvals.opened).toEqual([
      { tool: "mcp_slack_send_message", arguments: { channel: "#general", token: "[redacted]" } },
    ]);
    expect(approvals.rows.get(callId)?.arguments).toEqual({
      channel: "#general",
      token: "[redacted]",
    });
  });
});

describe("the gate's failure channel", () => {
  it("fails closed when the gate cannot be recorded", async () => {
    const approvals = memoryApprovals();
    approvals.failOpen.current = new Error("connection refused");
    const guard = guardFor(approvals);

    const exit = await run(
      guard
        .authorize({
          call: call("file_read", { path: ".ssh/id_rsa" }),
          declared: ["credential_access"],
        })
        .pipe(Effect.either),
    );

    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect(exit.left).toBeInstanceOf(ApprovalStoreError);
    }
    expect(approvals.rows.size).toBe(0);
  });
});

describe("the home a resolution uses", () => {
  it("does not flag an absolute path under a configured home", async () => {
    const approvals = memoryApprovals();
    const guard = createDangerousActionGuard({
      store: approvals.store,
      home: "/srv/bots/ada",
      allowlist: parseEgressAllowlist([]),
      timeoutMs,
      pollIntervalMs,
    });

    const outcome = await run(
      guard.authorize({
        call: call("file_write", { path: "/srv/bots/ada/notes/todo.md" }),
        declared: ["credential_access", "write_outside_home"],
      }),
    );

    expect(outcome).toEqual({ status: "allowed" });
    expect(approvals.rows.size).toBe(0);
  });
});
