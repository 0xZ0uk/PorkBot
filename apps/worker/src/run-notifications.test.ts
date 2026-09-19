import { NotificationEmulator } from "@porkbot/adapters";
import { createRepositories } from "@porkbot/db";
import type { RunRecord, SystemRepositories } from "@porkbot/db";
import type { NotificationEligibility } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { notifySettledRun, notifyStalledRun } from "./run-notifications.ts";
import type { RunNotificationContext, RunNotificationTarget } from "./run-notifications.ts";

/**
 * The run-liveness producers: one message per run state, one link to the run's
 * timeline, and one durable claim deciding who sends.
 *
 * The tests drive the producers the way the worker does — with the run row a
 * fenced write just returned — and observe deliveries in the emulator's
 * mailbox. The claim is a fake map, so "a second producer sends nothing" is
 * demonstrated rather than assumed from the SQL, and the preference check is
 * the real `@porkbot/effect` delivery path reading a stubbed eligibility seam.
 */

const origin = "https://porkbot.example.invalid";

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    userId: "00000000-0000-4000-8000-000000000001",
    status: "running",
    trigger: "message",
    error: null,
    errorCode: null,
    leaseOwner: "job-1",
    leaseFence: 1,
    leaseExpiresAt: new Date(120_000),
    stopRequestedAt: null,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    currentStep: null,
    currentStepTool: null,
    stalledAt: null,
    notifiedAt: null,
    checkpoint: {},
    clientNonce: "nonce-1",
    sourceMessageId: null,
    startedAt: new Date(0),
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

interface Fake {
  readonly repositories: SystemRepositories;
  readonly claimed: string[];
  readonly eligibilityCalls: Array<{ readonly userId: string; readonly kind: string }>;
  readonly lines: Record<string, unknown>[];
}

function fake(
  options: {
    readonly eligible?: NotificationEligibility;
    readonly claimFails?: boolean;
    readonly provider?: RunNotificationTarget["provider"];
  } = {},
): Fake & { readonly context: (emulator: NotificationEmulator) => RunNotificationContext } {
  const claimed = new Set<string>();
  const claimedOrder: string[] = [];
  const eligibilityCalls: Array<{ userId: string; kind: string }> = [];
  const lines: Record<string, unknown>[] = [];
  const actor = { kind: "system" as const, spaceId: "space-1", jobId: "job-1" };
  const repositories = createRepositories(actor, {
    async query<Row>() {
      return { rows: [] as readonly Row[] };
    },
  });

  repositories.runs.claimNotification = async (id) => {
    if (options.claimFails === true) {
      throw new Error("the database is unreachable");
    }

    if (claimed.has(id)) {
      return false;
    }

    claimed.add(id);
    claimedOrder.push(id);

    return true;
  };
  repositories.notifications.eligibility = async (userId, kind) => {
    eligibilityCalls.push({ userId, kind });

    return options.eligible ?? "enabled";
  };

  const logger = createLogger({
    service: "@porkbot/worker",
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });

  return {
    repositories,
    claimed: claimedOrder,
    eligibilityCalls,
    lines,
    context: (emulator) => ({
      repositories,
      logger,
      target: { origin, provider: options.provider ?? emulator },
    }),
  };
}

describe("settled-run notifications", () => {
  it("announces a finished run once, linking the run and its timeline", async () => {
    const world = fake();
    const emulator = new NotificationEmulator();
    const settled = runRecord({ status: "completed", completedAt: new Date(0) });

    await notifySettledRun(settled, world.context(emulator));

    expect(emulator.size).toBe(1);
    expect(emulator.last()).toMatchObject({
      title: "A run has finished",
      body: "The run finished successfully.",
      url: `${origin}/threads/thread-1?run=run-1`,
    });

    // A retry or a concurrent producer for the same state finds the claim
    // taken: the run is announced once, not once per caller.
    await notifySettledRun(settled, world.context(emulator));

    expect(emulator.size).toBe(1);
    expect(world.claimed).toEqual(["run-1"]);
  });

  it("announces a failed run with the failure sentence, never its error text", async () => {
    const world = fake();
    const emulator = new NotificationEmulator();
    const settled = runRecord({
      status: "failed",
      error: "the model endpoint said: api-key=0123456789abcdef",
      errorCode: "gone",
      completedAt: new Date(0),
    });

    await notifySettledRun(settled, world.context(emulator));

    expect(emulator.last()).toMatchObject({
      title: "A run has failed",
      body: "The run failed before it finished.",
    });
    expect(emulator.last()?.body).not.toContain("0123456789abcdef");
  });

  it("announces a lease timeout as a timeout, for either reclaim reason", async () => {
    for (const errorCode of ["checkpoint_absent", "checkpoint_unreadable"]) {
      const world = fake();
      const emulator = new NotificationEmulator();

      await notifySettledRun(
        runRecord({ status: "failed", errorCode, completedAt: new Date(0) }),
        world.context(emulator),
      );

      expect(emulator.last()).toMatchObject({
        title: "A run has timed out",
        body: "Its worker stopped responding and there was nothing to resume.",
      });
    }
  });

  it("says nothing for a run the operator cancelled and claims nothing", async () => {
    const world = fake();
    const emulator = new NotificationEmulator();

    await notifySettledRun(
      runRecord({ status: "cancelled", errorCode: "cancelled", completedAt: new Date(0) }),
      world.context(emulator),
    );

    expect(emulator.size).toBe(0);
    expect(world.claimed).toEqual([]);
  });

  it("respects a disabled preference: the claim is taken, nothing is sent", async () => {
    const world = fake({ eligible: "disabled" });
    const emulator = new NotificationEmulator();

    await notifySettledRun(runRecord({ status: "completed" }), world.context(emulator));

    expect(emulator.size).toBe(0);
    expect(world.claimed).toEqual(["run-1"]);
    expect(world.eligibilityCalls).toEqual([{ userId: runRecord().userId, kind: "run.completed" }]);
  });

  it("never sends to a user outside the space", async () => {
    const world = fake({ eligible: "not_a_recipient" });
    const emulator = new NotificationEmulator();

    await notifySettledRun(
      runRecord({ status: "failed", errorCode: "gone" }),
      world.context(emulator),
    );

    expect(emulator.size).toBe(0);
  });

  it("logs a claim that cannot be taken instead of failing the producer", async () => {
    const world = fake({ claimFails: true });
    const emulator = new NotificationEmulator();

    await expect(
      notifySettledRun(runRecord({ status: "completed" }), world.context(emulator)),
    ).resolves.toBeUndefined();

    expect(emulator.size).toBe(0);
    expect(world.lines.some((line) => line["msg"] === "could not claim a run notification")).toBe(
      true,
    );
  });

  it("logs an adapter defect instead of throwing it at the settlement", async () => {
    const broken = {
      deliver: () => {
        throw new Error("the destination exploded");
      },
    };
    const world = fake({ provider: broken });
    const emulator = new NotificationEmulator();

    await expect(
      notifySettledRun(runRecord({ status: "completed" }), world.context(emulator)),
    ).resolves.toBeUndefined();

    expect(
      world.lines.some(
        (line) =>
          line["msg"] === "could not deliver a run notification" &&
          line["kind"] === "run.completed",
      ),
    ).toBe(true);
  });
});

describe("stall notifications", () => {
  it("delivers the silence sentence and the run's timeline link", async () => {
    const world = fake();
    const emulator = new NotificationEmulator();

    await notifyStalledRun(
      runRecord(),
      { stalledForMs: 400_000, tool: "shell" },
      world.context(emulator),
    );

    expect(emulator.last()).toMatchObject({
      title: "A run has stalled",
      body: "No progress for 7 minutes while running shell.",
      url: `${origin}/threads/thread-1?run=run-1`,
    });
    // A stall claims per episode through the watchdog's own marker, so this
    // path does not touch the terminal claim.
    expect(world.claimed).toEqual([]);
  });

  it("respects a disabled preference: the episode is recorded, nothing is sent", async () => {
    const world = fake({ eligible: "disabled" });
    const emulator = new NotificationEmulator();

    await notifyStalledRun(
      runRecord(),
      { stalledForMs: 400_000, tool: "shell" },
      world.context(emulator),
    );

    expect(emulator.size).toBe(0);
    expect(world.eligibilityCalls).toEqual([{ userId: runRecord().userId, kind: "run.stalled" }]);
  });
});
