import { NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import type { Queryable } from "./queryable.ts";
import { createUsageStore } from "./usage-store.ts";

/**
 * The usage store without a server: a recording fake stands in for the pg
 * client, so these tests prove the module's own contract — the append takes
 * the bot and space from the run row and refuses a run outside the job's
 * space, the operator's read is scoped by the bot pre-read, and an unreported
 * sum stays null instead of collapsing to zero. `(bot_id, created_at)` and the
 * checks that make negatives unrepresentable are the schema's business, and
 * the integration matrix runs the same seams against Postgres.
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

const operator: UserActor = { kind: "user", spaceId: "space-1", userId: "user-1", role: "owner" };
const worker: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };

const isBotLookup = (text: string): boolean => text.startsWith("select id from bot");
const isInsert = (text: string): boolean => text.startsWith("insert into usage_record");
const isTotal = (text: string): boolean =>
  text.startsWith("select count(*) filter") && !text.includes("group by");
const isPeriods = (text: string): boolean => text.includes("group by");

describe("the run's write half", () => {
  it("appends one record with the run's own bot and space", async () => {
    const database = fakeDatabase(() => [{ id: "usage-1" }]);
    const recorder = createUsageStore(worker, database);

    await recorder.record({
      runId: "run-1",
      provider: "openai",
      model: "gpt-test",
      inputTokens: 1200,
      outputTokens: 340,
    });

    const insert = database.calls.find(({ text }) => isInsert(text));

    expect(insert?.text).toContain("select r.space_id, r.bot_id, r.id");
    expect(insert?.text).toContain("from run r");
    expect(insert?.text).toContain("where r.id = $2 and r.space_id = $1");
    expect(insert?.values).toEqual(["space-1", "run-1", "openai", "gpt-test", 1200, 340]);
    expect(database.calls).toHaveLength(1);
  });

  it("records an unreported turn with nulls rather than zeros", async () => {
    const database = fakeDatabase(() => [{ id: "usage-1" }]);

    await createUsageStore(worker, database).record({
      runId: "run-1",
      provider: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
    });

    expect(database.calls[0]?.values).toEqual(["space-1", "run-1", null, null, null, null]);
  });

  it("refuses a run outside the job's space as the shared not-found", async () => {
    const database = fakeDatabase(() => []);

    await expect(
      createUsageStore(worker, database).record({
        runId: "run-foreign",
        provider: null,
        model: null,
        inputTokens: null,
        outputTokens: null,
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(database.calls.filter(({ text }) => isInsert(text))).toHaveLength(1);
  });
});

describe("the operator's read half", () => {
  it("refuses a bot outside the actor's space before any aggregate runs", async () => {
    const database = fakeDatabase(() => []);

    await expect(
      createUsageStore(operator, database).forBot("bot-foreign", {
        since: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(database.calls).toHaveLength(1);
    expect(isBotLookup(database.calls[0]?.text ?? "")).toBe(true);
    expect(database.calls[0]?.values).toEqual(["bot-foreign", "space-1"]);
  });

  it("answers the all-time total and the window's daily buckets, scoped by bot", async () => {
    const since = new Date("2026-01-01T00:00:00.000Z");
    const database = fakeDatabase(({ text }) => {
      if (isBotLookup(text)) {
        return [{ id: "bot-1" }];
      }

      if (isPeriods(text)) {
        return [
          {
            startsAt: new Date("2026-01-02T00:00:00.000Z"),
            inputTokens: 1200,
            outputTokens: 340,
            reported: 2,
            unreported: 0,
          },
        ];
      }

      return [{ inputTokens: 3500, outputTokens: 700, reported: 4, unreported: 1 }];
    });

    const summary = await createUsageStore(operator, database).forBot("bot-1", { since });

    expect(summary).toEqual({
      total: { inputTokens: 3500, outputTokens: 700, reported: 4, unreported: 1 },
      periods: [
        {
          startsAt: new Date("2026-01-02T00:00:00.000Z"),
          inputTokens: 1200,
          outputTokens: 340,
          reported: 2,
          unreported: 0,
        },
      ],
    });

    const total = database.calls.find(({ text }) => isTotal(text));

    expect(total?.text).toContain("from usage_record where space_id = $1 and bot_id = $2");
    expect(total?.values).toEqual(["space-1", "bot-1"]);

    const periods = database.calls.find(({ text }) => isPeriods(text));

    expect(periods?.text).toContain("date_trunc('day', created_at, 'UTC')");
    expect(periods?.text).toContain("created_at >= $3");
    expect(periods?.text).toContain("group by");
    expect(periods?.values).toEqual(["space-1", "bot-1", since]);
  });

  it("answers an empty total when the bot has no records", async () => {
    // The total aggregate always returns one row — zeros and nulls with no
    // records, exactly as Postgres answers it — while the grouped query has no
    // groups at all.
    const database = fakeDatabase(({ text }) => {
      if (isBotLookup(text)) {
        return [{ id: "bot-1" }];
      }

      return isPeriods(text)
        ? []
        : [{ inputTokens: null, outputTokens: null, reported: 0, unreported: 0 }];
    });

    const summary = await createUsageStore(operator, database).forBot("bot-1", {
      since: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(summary).toEqual({
      total: { inputTokens: null, outputTokens: null, reported: 0, unreported: 0 },
      periods: [],
    });
  });

  it("keeps a period whose provider reported nothing as nulls, not zeros", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isBotLookup(text)) {
        return [{ id: "bot-1" }];
      }

      if (isPeriods(text)) {
        return [
          {
            startsAt: new Date("2026-01-02T00:00:00.000Z"),
            inputTokens: null,
            outputTokens: null,
            reported: 0,
            unreported: 3,
          },
        ];
      }

      return [{ inputTokens: null, outputTokens: null, reported: 0, unreported: 3 }];
    });

    const summary = await createUsageStore(operator, database).forBot("bot-1", {
      since: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(summary.total).toEqual({
      inputTokens: null,
      outputTokens: null,
      reported: 0,
      unreported: 3,
    });
    expect(summary.periods[0]?.inputTokens).toBeNull();
    expect(summary.periods[0]?.outputTokens).toBeNull();
  });
});
