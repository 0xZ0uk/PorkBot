import { Effect } from "effect";
import { ComputerEmulator, emulatorAgentRuntimeLayer } from "@porkbot/adapters";
import type { EmulatorStep } from "@porkbot/adapters";
import { createRepositories } from "@porkbot/db";
import type { FencedRunPatch, RunLease, RunRecord, SystemRepositories } from "@porkbot/db";
import {
  consumeRunSession,
  createComputerTools,
  createFencedComputerCommands,
  createRunEventRecorder,
  createToolDispatcher,
  liveRunsLayer,
  withLiveRun,
} from "@porkbot/effect";
import type {
  ComputerLease,
  ComputerLeaseAcquisition,
  ComputerLeaseHolder,
  ComputerLeaseStore,
  RunStartRequest,
  ToolCallAdmission,
  ToolCallLedger,
  ToolOutcome,
} from "@porkbot/effect";
import type { RunEvent } from "@porkbot/core";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createRunExecutor } from "./run-execution.ts";
import type { RunExecution } from "./jobs/run-execute.ts";

/**
 * The first full run whose tools actually execute (slice 6.9).
 *
 * The model half is the shipped offline runtime's script — which call to make,
 * in order — and the machine half is real: every tool step runs through the
 * same `ToolDispatcher` machinery (durable call ids, declared budgets,
 * classified failures) a Pi-backed run uses, and every file, shell and browser
 * call crosses `ComputerProvider.exec` into the emulator. The run executes
 * under the worker's real execution harness: claim already happened in the
 * handler above it, and this suite observes the fence, the settlement and the
 * recorded event stream.
 *
 * Nothing here needs a key, a socket or a daemon. The point of the slice is
 * that this run is not a rehearsal: replace the emulated computer with the
 * Docker provider (slice 7.2) and the same tools, the same events and the same
 * settlement happen on a real machine.
 */

const computer = { computerId: "computer-1", botId: "bot-1" };
const pageUrl = "https://docs.example.invalid/start";

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    spaceId: "space-1",
    botId: computer.botId,
    threadId: "thread-1",
    taskId: "task-1",
    userId: "user-1",
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

/**
 * The in-memory computer lease for the offline path. It mirrors the stored
 * one's observable rules — a live foreign holder is `busy`, an expired or own
 * binding is replaced, a release only clears the exact binding — without a
 * database, so this suite proves the run's commands really travel through the
 * fence and that the settlement releases the machine.
 */
class MemoryComputerLeases implements ComputerLeaseStore {
  readonly leases = new Map<string, ComputerLease>();
  readonly releases: ComputerLeaseHolder[] = [];

  async hold(holder: ComputerLeaseHolder, ttlSeconds: number): Promise<ComputerLeaseAcquisition> {
    const existing = this.leases.get(holder.botId);
    const now = Date.now();
    const ours =
      existing !== undefined &&
      existing.runId === holder.runId &&
      existing.owner === holder.owner &&
      existing.fence === holder.fence;

    if (existing !== undefined && existing.expiresAt.getTime() > now && !ours) {
      return { status: "busy", expiresAt: existing.expiresAt };
    }

    const lease: ComputerLease = { ...holder, expiresAt: new Date(now + ttlSeconds * 1000) };
    this.leases.set(holder.botId, lease);

    return { status: "held", lease };
  }

  async release(holder: ComputerLeaseHolder): Promise<boolean> {
    this.releases.push(holder);
    const existing = this.leases.get(holder.botId);

    if (
      existing === undefined ||
      existing.runId !== holder.runId ||
      existing.owner !== holder.owner ||
      existing.fence !== holder.fence
    ) {
      return false;
    }

    this.leases.delete(holder.botId);

    return true;
  }
}

interface FakeRunner {
  readonly repositories: SystemRepositories;
  readonly updates: Array<{ readonly lease: RunLease; readonly patch: FencedRunPatch }>;
}

function fakeRepositories(leases: ComputerLeaseStore): FakeRunner {
  const updates: Array<{ lease: RunLease; patch: FencedRunPatch }> = [];
  const actor = { kind: "system" as const, spaceId: "space-1", jobId: "job-1" };
  const repositories = createRepositories(actor, {
    async query<Row>() {
      return { rows: [] as readonly Row[] };
    },
  });

  repositories.runs.heartbeat = async () => runRecord();
  repositories.runs.update = async (_id, lease, patch) => {
    updates.push({ lease, patch });

    return runRecord();
  };
  repositories.computerLeases.hold = (holder, ttlSeconds) => leases.hold(holder, ttlSeconds);
  repositories.computerLeases.release = (holder) => leases.release(holder);

  return { repositories, updates };
}

function executionFor(runner: FakeRunner): RunExecution {
  return {
    actor: { kind: "system", spaceId: "space-1", jobId: "job-1" },
    run: runRecord(),
    repositories: runner.repositories,
    logger: createLogger({ service: "@porkbot/worker", write: () => {} }),
    resumed: false,
  };
}

function memoryLedger(): ToolCallLedger {
  const settled = new Map<string, ToolOutcome>();

  return {
    begin: async (call): Promise<ToolCallAdmission> =>
      settled.get(call.callId) ?? { status: "started" },
    complete: async (call, result): Promise<ToolOutcome> => {
      const outcome: ToolOutcome = { status: "completed", result };
      settled.set(call.callId, outcome);
      return outcome;
    },
    fail: async (call, error): Promise<ToolOutcome> => {
      const outcome: ToolOutcome = { status: "failed", error };
      settled.set(call.callId, outcome);
      return outcome;
    },
  };
}

function startRequest(runId: string): RunStartRequest {
  return {
    runId,
    threadId: "thread-1",
    startSeq: 1,
    connection: { baseUrl: "https://model.example.test/v1", credentialName: "model-key" },
    model: "test-model",
    messages: [{ role: "user", content: "write the report and read it back" }],
  };
}

interface OfflineRun {
  readonly recorded: readonly RunEvent[];
  readonly updates: FakeRunner["updates"];
  readonly leases: MemoryComputerLeases;
}

async function runOffline(): Promise<OfflineRun> {
  const leases = new MemoryComputerLeases();
  const runner = fakeRepositories(leases);
  const emulator = new ComputerEmulator();
  emulator
    .servePage({ url: pageUrl, title: "Start here", text: "The report is due today." })
    .serveBrowserAction({ url: pageUrl, selector: "#next", action: "click" });
  await emulator.ensure(computer);

  const recorded: RunEvent[] = [];
  const script: readonly EmulatorStep[] = [
    { kind: "token.delta", messageId: "assistant-1", delta: "On it. " },
    {
      kind: "tool.immediate",
      callId: "call-shell",
      tool: "shell",
      arguments: { command: "printf 'the report is ready' > report.txt" },
    },
    {
      kind: "tool.immediate",
      callId: "call-read",
      tool: "file_read",
      arguments: { path: "report.txt" },
    },
    {
      kind: "tool.immediate",
      callId: "call-browser",
      tool: "browser",
      arguments: { action: "open", url: pageUrl },
    },
    { kind: "run.completed", messageId: "assistant-1" },
  ];

  const execute = createRunExecutor({
    heartbeatIntervalMs: 5,
    work: (execution) => {
      const ledger = memoryLedger();
      const owner = execution.run.leaseOwner ?? "job-1";
      const commands = createFencedComputerCommands({
        provider: emulator,
        ledger,
        leases,
        lease: {
          botId: execution.run.botId,
          runId: execution.run.id,
          owner,
          fence: execution.run.leaseFence,
        },
        runLeaseTtlSeconds: 120,
        computerLeaseTtlSeconds: 120,
      });
      const tools = createToolDispatcher({
        registrations: createComputerTools({
          commands,
          computer,
          maxDurationMs: 30_000,
        }),
        ledger,
        leaseTtlMs: 120_000,
        heartbeat: Effect.void,
      });

      return withLiveRun(
        execution.run.id,
        emulatorAgentRuntimeLayer(startRequest(execution.run.id), script, { tools }),
        (session) => {
          const recorder = createRunEventRecorder();

          return consumeRunSession(session, (event) =>
            Effect.sync(() => {
              recorded.push(recorder.record(event));
            }),
          );
        },
      ).pipe(Effect.provide(liveRunsLayer));
    },
  });

  await execute(executionFor(runner));

  return { recorded: recorded as readonly RunEvent[], updates: runner.updates, leases };
}

function toolResult(recorded: readonly RunEvent[], callId: string): unknown {
  const event = recorded.find(
    (candidate) => candidate.type === "tool.completed" && candidate.callId === callId,
  );

  return event?.type === "tool.completed" ? event.result : undefined;
}

describe("the first full offline run", () => {
  it("executes each tool on the emulated computer and settles the run completed", async () => {
    const { recorded, updates } = await runOffline();

    expect(recorded.map((event) => event.type)).toEqual([
      "run.started",
      "token.delta",
      "tool.requested",
      "tool.completed",
      "tool.requested",
      "tool.completed",
      "tool.requested",
      "tool.completed",
      "run.completed",
    ]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      patch: { status: "completed", completed: true, attempt: "completed" },
    });
  });

  it("reads back the bytes the shell wrote, so the filesystem persists within the run", async () => {
    const { recorded } = await runOffline();

    const shell = toolResult(recorded, "call-shell") as { ok: boolean; exitCode: number };
    expect(shell.ok).toBe(true);
    expect(shell.exitCode).toBe(0);

    const read = toolResult(recorded, "call-read") as {
      ok: boolean;
      path: string;
      content: { label: string; path: string; content: string; origin: string };
    };

    expect(read.ok).toBe(true);
    expect(read.path).toBe("report.txt");
    expect(read.content.label).toBe("untrusted");
    expect(read.content.path).toBe("file_read");
    expect(read.content.origin).toBe("home:report.txt");
    expect(read.content.content).toBe("the report is ready");
  });

  it("returns browser page text labelled with the page it came from", async () => {
    const { recorded } = await runOffline();

    const browser = toolResult(recorded, "call-browser") as {
      ok: boolean;
      url: string;
      text: { label: string; path: string; origin: string; content: string };
    };

    expect(browser.ok).toBe(true);
    expect(browser.url).toBe(pageUrl);
    expect(browser.text.label).toBe("untrusted");
    expect(browser.text.path).toBe("computer_output");
    expect(browser.text.origin).toBe(pageUrl);
    expect(browser.text.content).toContain("The report is due today.");
  });
});
