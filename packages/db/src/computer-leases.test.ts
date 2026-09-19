import { describe, expect, it } from "vitest";
import type {
  ComputerLeaseAcquisition,
  ComputerLeaseHolder,
  ComputerLeaseStore,
} from "@porkbot/effect";
import type { SystemActor } from "./actor.ts";
import {
  COMPUTER_LEASE_TTL_SECONDS,
  COMPUTER_WATCHDOG_BATCH_LIMIT,
  createComputerLeaseStore,
  findExpiredComputerLeases,
  holdComputerLease,
  releaseComputerLease,
} from "./computer-leases.ts";
import type { ExpiredComputerLease } from "./computer-leases.ts";
import type { Queryable } from "./queryable.ts";
import { RUN_LEASE_TTL_SECONDS } from "./run-leases.ts";

/**
 * The computer-lease statements' decisions, without Postgres: which branch the
 * one-statement hold takes for a held, busy or lost row, the retry that a
 * read-committed snapshot can force, and what each statement binds. The
 * concurrency and fence proofs need a real server and live in
 * `test/integration/computer-leases.integration.test.ts`; this suite pins the
 * shape the store compiles to and the classification the guard branches on.
 *
 * The shipped TTL relationship is asserted here too: the guard in
 * `@porkbot/effect` is the one place that compares the two leases, and this is
 * the value the deployment actually hands it.
 */

const actor: SystemActor = { kind: "system", spaceId: "space-1", jobId: "job-1" };

const holder: ComputerLeaseHolder = {
  botId: "bot-1",
  runId: "run-1",
  owner: "worker-a",
  fence: 1,
};

const expiresAt = new Date(120_000);

interface HoldRow {
  readonly runHeld: boolean;
  readonly heldBotId: string | null;
  readonly heldRunId: string | null;
  readonly heldOwner: string | null;
  readonly heldFence: number | null;
  readonly heldExpiresAt: Date | null;
  readonly currentExpiresAt: Date | null;
}

function heldRow(): HoldRow {
  return {
    runHeld: true,
    heldBotId: holder.botId,
    heldRunId: holder.runId,
    heldOwner: holder.owner,
    heldFence: holder.fence,
    heldExpiresAt: expiresAt,
    currentExpiresAt: expiresAt,
  };
}

function missing(): HoldRow {
  return {
    runHeld: false,
    heldBotId: null,
    heldRunId: null,
    heldOwner: null,
    heldFence: null,
    heldExpiresAt: null,
    currentExpiresAt: null,
  };
}

function scripted(rows: readonly unknown[]): Queryable & {
  readonly calls: Array<{ readonly text: string; readonly values: readonly unknown[] }>;
} {
  const queue = [...rows];
  const calls: Array<{ readonly text: string; readonly values: readonly unknown[] }> = [];

  return {
    calls,
    async query<Row>(text: string, values: readonly unknown[] = []) {
      calls.push({ text, values });
      const next = queue.shift();
      const batch = Array.isArray(next) ? next : next === undefined ? [] : [next];

      return { rows: batch as readonly Row[] };
    },
  };
}

describe("the shipped computer lease TTL", () => {
  it("does not outlive the run lease it is fenced on", () => {
    expect(COMPUTER_LEASE_TTL_SECONDS).toBeGreaterThan(0);
    expect(COMPUTER_LEASE_TTL_SECONDS).toBeLessThanOrEqual(RUN_LEASE_TTL_SECONDS);
  });
});

describe("holding a computer", () => {
  it("answers held with the row the statement returned", async () => {
    const database = scripted([heldRow()]);

    const acquisition = await holdComputerLease(actor, database, holder);

    expect(acquisition).toEqual({
      status: "held",
      lease: {
        botId: "bot-1",
        runId: "run-1",
        owner: "worker-a",
        fence: 1,
        expiresAt,
      },
    });
    expect(database.calls).toHaveLength(1);
    expect(database.calls[0]?.text).toContain("on conflict (bot_id) do update");
    expect(database.calls[0]?.text).toContain("lease_expires_at > now()");
    expect(database.calls[0]?.values).toEqual([
      actor.spaceId,
      holder.botId,
      holder.runId,
      holder.owner,
      holder.fence,
      COMPUTER_LEASE_TTL_SECONDS,
    ]);
  });

  it("answers busy with a live foreign holder's expiry", async () => {
    const database = scripted([
      {
        runHeld: true,
        heldBotId: null,
        heldRunId: null,
        heldOwner: null,
        heldFence: null,
        heldExpiresAt: null,
        currentExpiresAt: expiresAt,
      } satisfies HoldRow,
    ]);

    await expect(holdComputerLease(actor, database, holder)).resolves.toEqual({
      status: "busy",
      expiresAt,
    });
  });

  it("answers run_lost when the run lease is not the row's", async () => {
    const database = scripted([missing()]);

    await expect(holdComputerLease(actor, database, holder)).resolves.toEqual({
      status: "run_lost",
    });
  });

  it("retries once when a racing writer makes the classification unreadable", async () => {
    const database = scripted([
      {
        runHeld: true,
        heldBotId: null,
        heldRunId: null,
        heldOwner: null,
        heldFence: null,
        heldExpiresAt: null,
        currentExpiresAt: null,
      } satisfies HoldRow,
      { ...heldRow(), heldExpiresAt: expiresAt },
    ]);

    const acquisition = await holdComputerLease(actor, database, holder);

    expect(acquisition.status).toBe("held");
    expect(database.calls).toHaveLength(2);
  });

  it("refuses to guess when two holds cannot classify the row", async () => {
    const unreadable: HoldRow = {
      runHeld: true,
      heldBotId: null,
      heldRunId: null,
      heldOwner: null,
      heldFence: null,
      heldExpiresAt: null,
      currentExpiresAt: null,
    };
    const database = scripted([unreadable, unreadable]);

    await expect(holdComputerLease(actor, database, holder)).rejects.toThrow(
      "the computer lease could not be classified across two holds",
    );
    expect(database.calls).toHaveLength(2);
  });

  it("binds a caller-supplied TTL and refuses a statement with no row", async () => {
    const database = scripted([[]]);

    await expect(holdComputerLease(actor, database, holder, 30)).rejects.toThrow(
      "the computer-lease hold returned no row",
    );
    expect(database.calls[0]?.values[5]).toBe(30);
  });
});

describe("releasing and scanning", () => {
  it("reports whether the exact binding was cleared", async () => {
    const cleared = scripted([[{ id: "lease-1" }]]);

    await expect(releaseComputerLease(actor, cleared, holder)).resolves.toBe(true);
    expect(cleared.calls[0]?.text).toContain("delete from computer_lease");
    expect(cleared.calls[0]?.values).toEqual([
      actor.spaceId,
      holder.botId,
      holder.runId,
      holder.owner,
      holder.fence,
    ]);

    const missed = scripted([[]]);

    await expect(releaseComputerLease(actor, missed, holder)).resolves.toBe(false);
  });

  it("scans expired leases oldest first, with the caller's limit", async () => {
    const expired: ExpiredComputerLease = {
      spaceId: actor.spaceId,
      botId: holder.botId,
      runId: holder.runId,
      owner: holder.owner,
      fence: holder.fence,
      expiresAt: new Date(0),
    };
    const database = scripted([[expired]]);

    await expect(findExpiredComputerLeases(database, 7)).resolves.toEqual([expired]);
    expect(database.calls[0]?.text).toContain("where expires_at <= now()");
    expect(database.calls[0]?.values).toEqual([7]);
    expect(COMPUTER_WATCHDOG_BATCH_LIMIT).toBeGreaterThan(0);
  });
});

describe("the store seam", () => {
  it("delegates hold and release to the scoped statements", async () => {
    const database = scripted([heldRow(), [] as unknown]);
    const store: ComputerLeaseStore = createComputerLeaseStore(actor, database);

    const acquisition: ComputerLeaseAcquisition = await store.hold(holder, 42);

    expect(acquisition.status).toBe("held");
    expect(database.calls[0]?.values[5]).toBe(42);
    await expect(store.release(holder)).resolves.toBe(false);
    expect(database.calls[1]?.text).toContain("delete from computer_lease");
  });
});
