import { ModelEmulator } from "@porkbot/adapters";
import type { ModelEmulatorScript } from "@porkbot/adapters";
import { createRepositories } from "@porkbot/db";
import type {
  BotRecord,
  FencedRunPatch,
  MessageRecord,
  RunLease,
  RunRecord,
  SystemRepositories,
  ThreadRecord,
} from "@porkbot/db";
import type { PendingSteer, RunUsage } from "@porkbot/effect";
import type { RunEvent } from "@porkbot/core";
import { createLogger } from "@porkbot/logging";
import { afterEach, describe, expect, it } from "vitest";
import type { RunExecution } from "./jobs/run-execute.ts";
import { createLiveRunWork } from "./live-run.ts";
import { createRunExecutor } from "./run-execution.ts";

/**
 * The live launch's offline run (slice 6.11): the operator's message starts a
 * run, the run dials the loopback model endpoint through the shipped bridge and
 * agent loop, and the session's events are what the executor records and
 * settles. No key, no network and no daemon: the emulator speaks the real wire,
 * and every other seam is the job's actor-scoped repository.
 */

const spaceId = "space-1";
const runId = "run-1";
const threadId = "thread-1";
const botId = "bot-1";
const model = "fixture-model";
const modelCredentialName = "model-key";

const openEmulators: ModelEmulator[] = [];

afterEach(async () => {
  await Promise.all(openEmulators.splice(0).map(async (emulator) => emulator.stop()));
});

async function createEmulator(script: ModelEmulatorScript): Promise<ModelEmulator> {
  const emulator = await ModelEmulator.start(script, globalThis.fetch);
  openEmulators.push(emulator);
  return emulator;
}

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: runId,
    spaceId,
    botId,
    threadId,
    taskId: "task-1",
    userId: "user-1",
    status: "running",
    trigger: "message",
    error: null,
    errorCode: null,
    leaseOwner: "job-1",
    leaseFence: 1,
    leaseExpiresAt: new Date(Date.now() + 120_000),
    stopRequestedAt: null,
    lastHeartbeatAt: null,
    lastProgressAt: null,
    currentStep: null,
    currentStepTool: null,
    stalledAt: null,
    notifiedAt: null,
    checkpoint: {},
    clientNonce: "nonce-1",
    sourceMessageId: "message-1",
    startedAt: new Date(0),
    completedAt: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

function botRecord(): BotRecord {
  return {
    id: botId,
    spaceId,
    userId: "user-1",
    name: "Ada",
    title: "Research bot",
    description: "Reads things.",
    instructions: "Answer briefly.",
    color: "#000000",
    pinned: false,
    position: 0,
    sectionId: null,
    archivedAt: null,
    spawnKey: "spawn-1",
    avatarKey: null,
    computerId: null,
    computerProvider: null,
    modelConnectionId: null,
    model: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function threadRecord(): ThreadRecord {
  return {
    id: threadId,
    spaceId,
    botId,
    userId: "user-1",
    nextEventSeq: 1,
    nextMessageSeq: 2,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

function sourceMessage(): MessageRecord {
  return {
    id: "message-1",
    threadId,
    seq: 0,
    role: "user",
    blocks: [{ type: "text", text: "Say hello" }],
    runId,
    clientNonce: "nonce-1",
    createdAt: new Date(0),
  };
}

interface FakeCommands {
  readonly steers: PendingSteer[];
  stop: boolean;
}

interface FakeRunner {
  readonly repositories: SystemRepositories;
  readonly recorded: RunEvent[];
  readonly updates: { readonly lease: RunLease; readonly patch: FencedRunPatch }[];
  readonly usage: RunUsage[];
  readonly commands: FakeCommands;
  readonly connected: boolean;
}

function fakeRunner(emulator: ModelEmulator, connected = true): FakeRunner {
  const recorded: RunEvent[] = [];
  const usage: RunUsage[] = [];
  const updates: { lease: RunLease; patch: FencedRunPatch }[] = [];
  const commands: FakeCommands = { steers: [], stop: false };
  const actor = { kind: "system" as const, spaceId, jobId: "job-1" };
  const repositories = createRepositories(actor, {
    async query<Row>() {
      return { rows: [] as readonly Row[] };
    },
  });

  repositories.bots.findById = async () => botRecord();
  repositories.threads.findById = async () => threadRecord();
  repositories.modelConnections.resolveForBot = async () =>
    connected
      ? {
          connectionId: "connection-1",
          baseUrl: emulator.connection.baseUrl,
          credentialName: modelCredentialName,
          model,
        }
      : undefined;
  repositories.messages.listForThread = async () => [sourceMessage()];
  repositories.messages.findSourceForRun = async () => sourceMessage();
  repositories.events.listAfter = async () => [];
  repositories.events.append = async (event) => {
    recorded.push(event);
  };
  repositories.memory.list = async () => [];
  repositories.commands.claimSteers = async () => commands.steers.splice(0);
  repositories.commands.stopRequested = async () => commands.stop;
  repositories.usage.record = async (report) => {
    usage.push(report);
  };
  repositories.runs.listForThread = async () => [runRecord({ status: "queued" })];
  repositories.runs.heartbeat = async () => runRecord();
  repositories.runs.update = async (_id, lease, patch) => {
    updates.push({ lease, patch });
    return runRecord({ status: patch.status ?? "running", completedAt: new Date(0) });
  };
  repositories.computerLeases.release = async () => false;

  return { repositories, recorded, updates, usage, commands, connected };
}

function executionFor(runner: FakeRunner): RunExecution {
  return {
    actor: { kind: "system", spaceId, jobId: "job-1" },
    run: runRecord(),
    repositories: runner.repositories,
    logger: createLogger({ service: "@porkbot/worker", write: () => {} }),
    resumed: false,
  };
}

function executorFor(emulator: ModelEmulator) {
  return createRunExecutor({
    work: createLiveRunWork({ modelRuntime: emulator, commandPollIntervalMs: 5 }),
  });
}

describe("the live launch", () => {
  it("streams the model's answer into the run events and settles completed", async () => {
    const emulator = await createEmulator({
      models: [model],
      turns: [
        {
          steps: [
            { type: "text", delta: "Hello " },
            { type: "text", delta: "there" },
          ],
        },
      ],
    });
    const runner = fakeRunner(emulator);

    await executorFor(emulator)(executionFor(runner));

    expect(runner.recorded.map((event) => event.type)).toEqual([
      "run.started",
      "token.delta",
      "token.delta",
      "run.completed",
    ]);
    expect(
      runner.recorded.flatMap((event) => (event.type === "token.delta" ? [event.delta] : [])),
    ).toEqual(["Hello ", "there"]);
    expect(runner.updates).toEqual([
      {
        lease: { owner: "job-1", fence: 1 },
        patch: expect.objectContaining({ status: "completed" }),
      },
    ]);

    // The prompt was composed from the bot's identity and instructions.
    expect(emulator.requests).toHaveLength(1);
    const messages = emulator.requests[0]?.messages ?? [];
    const system = messages.find((message) => message.role === "system");
    expect(system?.content).toContain("Ada");
    expect(system?.content).toContain("Answer briefly.");
    expect(messages.at(-1)).toEqual({ role: "user", content: "Say hello" });
  });

  it("injects a durable steer into the live run and records it", async () => {
    const emulator = await createEmulator({
      models: [model],
      turns: [
        {
          steps: [
            { type: "text", delta: "first" },
            { type: "gate", name: "pause", reason: "steering" },
          ],
        },
        { steps: [{ type: "text", delta: "second" }] },
      ],
    });
    const runner = fakeRunner(emulator);
    const execution = executorFor(emulator)(executionFor(runner));

    await emulator.waitForGate("pause");
    runner.commands.steers.push({ messageId: "message-steer", text: "keep going" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    emulator.releaseGate("pause");
    await execution;

    expect(runner.recorded.find((event) => event.type === "run.steered")).toMatchObject({
      messageId: "message-steer",
      text: "keep going",
    });
    expect(runner.recorded.at(-1)?.type).toBe("run.completed");
    expect(emulator.requests).toHaveLength(2);
    expect(emulator.requests[1]?.messages.at(-1)).toEqual({
      role: "user",
      content: "keep going",
    });
  });

  it("cancels the live run when the operator's stop mark appears", async () => {
    const emulator = await createEmulator({
      models: [model],
      turns: [
        {
          steps: [
            { type: "text", delta: "working" },
            { type: "gate", name: "pause", reason: "steering" },
          ],
        },
      ],
    });
    const runner = fakeRunner(emulator);
    const execution = executorFor(emulator)(executionFor(runner));

    await emulator.waitForGate("pause");
    runner.commands.stop = true;
    await new Promise((resolve) => setTimeout(resolve, 30));
    emulator.releaseGate("pause");
    await execution;

    const terminal = runner.recorded.at(-1);
    expect(terminal?.type).toBe("run.cancelled");
    expect(runner.updates.at(-1)?.patch).toMatchObject({
      status: "cancelled",
      errorCode: "cancelled",
    });
  });

  it("fails the run with a sentence when the bot has no model connection", async () => {
    const emulator = await createEmulator({ models: [model], turns: [] });
    const runner = fakeRunner(emulator, false);

    await executorFor(emulator)(executionFor(runner));

    expect(runner.recorded).toEqual([]);
    expect(runner.updates.at(-1)?.patch).toMatchObject({
      status: "failed",
      error: "This bot has no model connection selected, so the run has nothing to answer with.",
    });
  });

  it("fails a scheduled run with the sentence that names what is missing", async () => {
    const emulator = await createEmulator({ models: [model], turns: [] });
    const runner = fakeRunner(emulator);
    runner.repositories.messages.listForThread = async () => [];

    await executorFor(emulator)(executionFor(runner));

    expect(runner.recorded).toEqual([]);
    expect(runner.updates.at(-1)?.patch).toMatchObject({
      status: "failed",
      error: "this run has no operator message to answer; scheduled runs are not supported yet",
    });
  });
});
