import { NotFoundError } from "@porkbot/effect";
import type { ApprovalHistoryRecord, ApprovalRecord } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { createApprovalStore } from "./approval-store.ts";

/**
 * The approval store without a server: a recording fake stands in for the pg
 * client, so these tests prove the module's own contract — every statement
 * binds the actor's space, the open is an insert with a conflict clause rather
 * than a read-then-write, the timeout and the vote are guarded compare-and-sets
 * that only match a `pending` row in their window, and the loser of a race
 * answers from the stored row. Whether two racing compare-and-sets really
 * produce one winner is not provable here; the integration suite runs the same
 * calls against Postgres.
 */

interface QueryCall {
  readonly text: string;
  readonly values: readonly unknown[];
}

interface FakeDatabase extends Queryable {
  readonly calls: readonly QueryCall[];
}

function fakeDatabase(respond: (call: QueryCall) => readonly unknown[] = () => []): FakeDatabase {
  const calls: QueryCall[] = [];

  return {
    calls,
    async query<Row>(
      text: string,
      values: readonly unknown[] = [],
    ): Promise<{ readonly rows: readonly Row[] }> {
      const call = { text, values };
      calls.push(call);

      return { rows: respond(call) as readonly Row[] };
    },
  };
}

const worker: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };
const operator: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const expiresAt = new Date("2026-09-18T12:00:00.000Z");

function record(overrides: Partial<ApprovalRecord> = {}): ApprovalRecord {
  return {
    id: "approval-1",
    runId: "run-1",
    callId: "call-1",
    tool: "shell",
    arguments: {},
    status: "pending",
    expiresAt,
    decidedBy: null,
    decidedAt: null,
    reason: null,
    ...overrides,
  };
}

function historyRecord(overrides: Partial<ApprovalHistoryRecord> = {}): ApprovalHistoryRecord {
  return {
    ...record(),
    botId: "bot-1",
    threadId: "thread-1",
    ...overrides,
  };
}

const inserted = (calls: readonly QueryCall[]): QueryCall | undefined =>
  calls.find(({ text }) => text.startsWith("insert into approval"));

const updates = (calls: readonly QueryCall[]): readonly QueryCall[] =>
  calls.filter(({ text }) => text.startsWith("update approval"));

describe("opening a gate", () => {
  it("inserts a pending row scoped to the run's space, with the call id as the key", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("insert into approval") ? [record()] : [],
    );
    const store = createApprovalStore(worker, database);

    const opened = await store.open({
      runId: "run-1",
      callId: "call-1",
      tool: "shell",
      arguments: { command: "cat .env" },
      expiresAt,
    });

    expect(opened).toEqual(record());
    const insert = inserted(database.calls);
    expect(insert?.text).toContain("on conflict (run_id, call_id) do nothing");
    expect(insert?.text).toContain("from run r where r.id = $2 and r.space_id = $1");
    expect(insert?.values).toEqual([
      "space-1",
      "run-1",
      "call-1",
      "shell",
      JSON.stringify({ command: "cat .env" }),
      expiresAt.toISOString(),
    ]);
  });

  it("reopens the stored row when the gate already exists, on the original deadline", async () => {
    const stored = record({ status: "approved", decidedBy: "user-1", decidedAt: new Date() });
    const database = fakeDatabase(({ text }) =>
      text.startsWith("insert into approval") ? [] : [stored],
    );
    const store = createApprovalStore(worker, database);

    const reopened = await store.open({
      runId: "run-1",
      callId: "call-1",
      // The stored row wins: the call id identifies the gate, so a different
      // tool, payload or deadline on a reopen is the stored gate's.
      tool: "web",
      arguments: { url: "https://example.com" },
      expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    });

    expect(reopened).toEqual(stored);
    expect(reopened.tool).toBe("shell");
    expect(database.calls[1]?.values).toEqual(["space-1", "run-1", "call-1"]);
  });

  it("throws the shared not-found when neither the run nor the gate is in the actor's space", async () => {
    const database = fakeDatabase();
    const store = createApprovalStore(worker, database);

    await expect(
      store.open({ runId: "run-1", callId: "call-1", tool: "shell", arguments: {}, expiresAt }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reads a gate inside the actor's space and answers undefined for one outside it", async () => {
    const database = fakeDatabase(({ text }) => (text.startsWith("select") ? [record()] : []));
    const store = createApprovalStore(worker, database);

    expect(await store.find("run-1", "call-1")).toEqual(record());
    expect(database.calls[0]?.values).toEqual(["space-1", "run-1", "call-1"]);
    expect(await store.find("run-1", "call-2")).toEqual(record());
  });
});

describe("timing a gate out", () => {
  it("compare-and-sets only a pending row whose deadline has passed", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("update approval") ? [record({ status: "timed_out" })] : [],
    );
    const store = createApprovalStore(worker, database);

    const settled = await store.resolveTimeout("run-1", "call-1");

    expect(settled.status).toBe("timed_out");
    const [update] = updates(database.calls);
    expect(update?.text).toContain("status = 'pending'::approval_status");
    expect(update?.text).toContain("expires_at <= now()");
    expect(update?.values).toEqual(["space-1", "run-1", "call-1"]);
  });

  it("answers with the operator's decision when it won the race", async () => {
    const decided = record({ status: "denied", decidedBy: "user-1", decidedAt: new Date() });
    const database = fakeDatabase(({ text }) =>
      text.startsWith("update approval") ? [] : [decided],
    );
    const store = createApprovalStore(worker, database);

    expect(await store.resolveTimeout("run-1", "call-1")).toEqual(decided);
  });

  it("reports the same pending row when the server clock is not there yet", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("update approval") ? [] : [record()],
    );
    const store = createApprovalStore(worker, database);

    expect(await store.resolveTimeout("run-1", "call-1")).toEqual(record());
  });

  it("throws the shared not-found for a gate outside the actor's space", async () => {
    const store = createApprovalStore(worker, fakeDatabase());

    await expect(store.resolveTimeout("run-1", "call-1")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("voting on a gate", () => {
  it("records who and when on an approved row, and never a reason", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("update approval") ? [record({ status: "approved" })] : [],
    );
    const store = createApprovalStore(operator, database);

    const result = await store.decide({
      runId: "run-1",
      callId: "call-1",
      vote: "approve",
      reason: "should be ignored",
    });

    expect(result.applied).toBe(true);
    const [update] = updates(database.calls);
    expect(update?.text).toContain("decided_by_user_id = $5");
    expect(update?.text).toContain("decided_at = now()");
    expect(update?.text).toContain("status = 'pending'::approval_status and expires_at > now()");
    expect(update?.values).toEqual(["space-1", "run-1", "call-1", "approved", "user-1", null]);
  });

  it("records the operator's deny reason", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("update approval") ? [record({ status: "denied" })] : [],
    );
    const store = createApprovalStore(operator, database);

    await store.decide({ runId: "run-1", callId: "call-1", vote: "deny", reason: "too risky" });

    expect(updates(database.calls)[0]?.values).toEqual([
      "space-1",
      "run-1",
      "call-1",
      "denied",
      "user-1",
      "too risky",
    ]);
  });

  it("treats a blank deny reason as the absence of one", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("update approval") ? [record({ status: "denied" })] : [],
    );
    const store = createApprovalStore(operator, database);

    await store.decide({ runId: "run-1", callId: "call-1", vote: "deny", reason: "" });

    expect(updates(database.calls)[0]?.values[5]).toBeNull();
  });

  it("observes the winning vote without a second update", async () => {
    const decided = record({
      status: "approved",
      decidedBy: "user-2",
      decidedAt: new Date(),
    });
    const database = fakeDatabase(({ text }) =>
      text.startsWith("update approval") ? [] : [decided],
    );
    const store = createApprovalStore(operator, database);

    const result = await store.decide({ runId: "run-1", callId: "call-1", vote: "deny" });

    expect(result).toEqual({ record: decided, applied: false });
    expect(updates(database.calls)).toHaveLength(1);
  });

  it("settles an expired pending row as a timeout instead of approving it", async () => {
    const database = fakeDatabase(({ text }) => {
      if (text.startsWith("update approval") && text.includes("'timed_out'")) {
        return [record({ status: "timed_out" })];
      }

      if (text.startsWith("update approval")) {
        return [];
      }

      return [record()];
    });
    const store = createApprovalStore(operator, database);

    const result = await store.decide({ runId: "run-1", callId: "call-1", vote: "approve" });

    expect(result).toEqual({ record: record({ status: "timed_out" }), applied: false });
    expect(updates(database.calls)).toHaveLength(2);
    expect(updates(database.calls)[1]?.text).toContain("expires_at <= now()");
  });

  it("throws the shared not-found for a gate outside the actor's space", async () => {
    const store = createApprovalStore(operator, fakeDatabase());

    await expect(
      store.decide({ runId: "run-1", callId: "call-1", vote: "approve" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("lists a run's gates inside the actor's space, oldest first", async () => {
    const database = fakeDatabase(({ text }) => (text.startsWith("select") ? [record()] : []));
    const store = createApprovalStore(operator, database);

    expect(await store.listForRun("run-1")).toEqual([record()]);
    expect(database.calls[0]?.text).toContain("where space_id = $1 and run_id = $2");
    expect(database.calls[0]?.text).toContain("order by created_at asc");
  });

  it("lists history with run relationships and optional bot, run and status filters", async () => {
    const database = fakeDatabase(({ text }) =>
      text.startsWith("select a.id") ? [historyRecord()] : [],
    );
    const store = createApprovalStore(operator, database);

    await expect(
      store.list({ botId: "bot-1", runId: "run-1", status: "pending" }),
    ).resolves.toEqual([historyRecord()]);

    const query = database.calls[0];
    expect(query?.text).toContain("join run r on r.id = a.run_id and r.space_id = a.space_id");
    expect(query?.text).toContain("r.bot_id = $2");
    expect(query?.text).toContain("a.run_id = $3");
    expect(query?.text).toContain("a.status = $4::approval_status");
    expect(query?.text).toContain("order by a.created_at desc, a.id desc");
    expect(query?.values).toEqual(["space-1", "bot-1", "run-1", "pending"]);
  });
});

describe("the actor's half of the seam", () => {
  it("gives the operator no way to open or time out a gate, and the job no vote", () => {
    const system = createApprovalStore(worker, fakeDatabase());
    const user = createApprovalStore(operator, fakeDatabase());

    // @ts-expect-error -- opening a gate is the run's write, not the operator's.
    expect(user.open).toBeUndefined();
    // @ts-expect-error -- a vote is the operator's write, not the job's.
    expect(system.decide).toBeUndefined();
  });
});
