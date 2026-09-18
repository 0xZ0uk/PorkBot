import type { NotificationPreferenceSet } from "@porkbot/core";
import { NotFoundError } from "@porkbot/effect";
import { describe, expect, it } from "vitest";
import type { SystemActor, UserActor } from "./actor.ts";
import { createNotificationStore } from "./notification-store.ts";
import type { Queryable } from "./queryable.ts";

/**
 * The notification store without a server: a recording fake stands in for the
 * pg client, so these tests prove the module's own contract — the operator's
 * read fills in the quiet defaults, a set is one membership-scoped upsert, and
 * the delivery-path eligibility joins `space_member` so a non-member and a
 * missing preference are different answers. Whether the unique index really
 * absorbs a concurrent second set is not provable here; the integration suite
 * runs the same calls against Postgres.
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

const isRead = (text: string): boolean =>
  text.startsWith("select kind::text as kind, enabled from notification_preference");
const isUpsert = (text: string): boolean => text.startsWith("insert into notification_preference");

describe("the operator's preference half", () => {
  it("reads every kind with the quiet defaults filled in, scoped to the actor", async () => {
    const database = fakeDatabase(() => []);
    const preferences = createNotificationStore(operator, database);

    const set: NotificationPreferenceSet = await preferences.read();

    expect(set).toEqual({
      "run.completed": false,
      "run.failed": false,
      "run.needs_approval": false,
      "run.stalled": false,
    });

    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.text).toContain("where space_id = $1 and user_id = $2");
    expect(database.calls[0]?.values).toEqual(["space-1", "user-1"]);
  });

  it("lays the stored rows over the defaults", async () => {
    const database = fakeDatabase(() => [
      { kind: "run.failed", enabled: true },
      { kind: "run.completed", enabled: false },
    ]);

    const set = await createNotificationStore(operator, database).read();

    expect(set["run.failed"]).toBe(true);
    expect(set["run.stalled"]).toBe(false);
  });

  it("sets one kind with a membership-scoped upsert and returns the refreshed set", async () => {
    const database = fakeDatabase(({ text }) => {
      if (isUpsert(text)) {
        return [{ id: "preference-1" }];
      }

      return isRead(text) ? [{ kind: "run.failed", enabled: true }] : [];
    });

    const set = await createNotificationStore(operator, database).set("run.failed", true);

    const upserts = database.calls.filter(({ text }) => isUpsert(text));

    expect(upserts).toHaveLength(1);
    expect(upserts[0]?.text).toContain("from space_member m");
    expect(upserts[0]?.text).toContain("on conflict (space_id, user_id, kind)");
    expect(upserts[0]?.text).toContain("returning id");
    expect(upserts[0]?.values).toEqual(["space-1", "user-1", "run.failed", true]);
    expect(set["run.failed"]).toBe(true);
    expect(database.calls.some(({ text }) => isRead(text))).toBe(true);
  });

  it("refuses a set that matched no membership row instead of reporting success", async () => {
    const database = fakeDatabase(() => []);

    await expect(
      createNotificationStore(operator, database).set("run.failed", true),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(database.calls.filter(({ text }) => isUpsert(text))).toHaveLength(1);
  });
});

describe("the delivery path's eligibility half", () => {
  const recipient = "0198f000-0000-7000-8000-000000000001";

  it("answers not_a_recipient when the user holds no membership row", async () => {
    const database = fakeDatabase(() => []);
    const recipients = createNotificationStore(worker, database);

    await expect(recipients.eligibility(recipient, "run.failed")).resolves.toBe("not_a_recipient");

    expect(database.calls[0]?.text).toContain("from space_member m left join");
    expect(database.calls[0]?.text).toContain("m.space_id = $1 and m.user_id = $2");
    expect(database.calls[0]?.values).toEqual(["space-1", recipient, "run.failed"]);
  });

  it("answers not_a_recipient for an id that cannot name a member, without a query", async () => {
    const database = fakeDatabase(() => [{ enabled: true }]);
    const recipients = createNotificationStore(worker, database);

    await expect(recipients.eligibility("not-a-uuid", "run.failed")).resolves.toBe(
      "not_a_recipient",
    );
    expect(database.calls).toEqual([]);
  });

  it("answers disabled for a member with no row or an off switch", async () => {
    for (const row of [{ enabled: false }]) {
      const database = fakeDatabase(() => [row]);

      await expect(
        createNotificationStore(worker, database).eligibility(recipient, "run.stalled"),
      ).resolves.toBe("disabled");
    }
  });

  it("answers enabled for a member whose switch is on", async () => {
    const database = fakeDatabase(() => [{ enabled: true }]);

    await expect(
      createNotificationStore(worker, database).eligibility(recipient, "run.stalled"),
    ).resolves.toBe("enabled");
  });
});
