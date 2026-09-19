import { Effect } from "effect";
import { emulatorAgentRuntimeLayer, McpServerEmulator } from "@porkbot/adapters";
import type { EmulatorStep } from "@porkbot/adapters";
import { serializeMcpCredential } from "@porkbot/effect";
import { createRepositories } from "@porkbot/db";
import type { FencedRunPatch, RunLease, RunRecord, SystemRepositories } from "@porkbot/db";
import {
  consumeRunSession,
  createMcpTools,
  createRunEventRecorder,
  createToolDispatcher,
  liveRunsLayer,
  withLiveRun,
} from "@porkbot/effect";
import type {
  McpGrantedServer,
  McpRunServers,
  RunStartRequest,
  ToolCallAdmission,
  ToolCallLedger,
  ToolOutcome,
} from "@porkbot/effect";
import type {
  McpAuthorizationRequest,
  McpCallRequest,
  McpCodeExchangeRequest,
  McpDiscoverRequest,
  McpServerProvider,
} from "@porkbot/adapter-kit";
import type { RunEvent } from "@porkbot/core";
import { createLogger } from "@porkbot/logging";
import { describe, expect, it } from "vitest";
import { createRunExecutor } from "./run-execution.ts";
import type { RunExecution } from "./jobs/run-execute.ts";

/**
 * An MCP server's tools inside a real run (slice 9.5): installation and
 * discovery live in the API, and this suite starts where the run does. The
 * registrations are built from what `discover` reports for the servers the
 * bot's grants name, then every call crosses the same dispatcher, lease and
 * event machinery a Pi-backed run uses.
 *
 * The two acceptance criteria this suite pins end to end are the scoping ones:
 * a server the bot was not granted contributes no tool, and a revoke while the
 * run is open stops the next call — the first call completes and the second
 * fails with the shared `auth_failed` vocabulary.
 */

const spaceId = "space-1";
const botId = "bot-1";
const serverUrl = "https://mcp.example.invalid/mcp";

function runRecord(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: "run-1",
    spaceId,
    botId,
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

interface FakeRunner {
  readonly repositories: SystemRepositories;
  readonly updates: Array<{ readonly lease: RunLease; readonly patch: FencedRunPatch }>;
}

/**
 * The run's read half of the registry, over one mutable grant set. The
 * registrations are built once from `listGrantedForBot`, exactly as the run
 * path does; `isGranted` is the live re-read the tool layer asks before every
 * call, so flipping it models a revoke mid-run without rebuilding anything.
 */
function fakeGrantSet(): {
  readonly runServers: McpRunServers;
  readonly granted: Map<string, McpGrantedServer[]>;
  readonly live: Set<string>;
} {
  const granted = new Map<string, McpGrantedServer[]>();
  const live = new Set<string>();

  return {
    granted,
    live,
    runServers: {
      async listGrantedForBot(requestedBotId) {
        return granted.get(requestedBotId) ?? [];
      },
      async isGranted(requestedBotId, serverId) {
        return live.has(`${requestedBotId}:${serverId}`);
      },
    },
  };
}

function fakeRepositories(runServers: McpRunServers): FakeRunner {
  const updates: Array<{ lease: RunLease; patch: FencedRunPatch }> = [];
  const actor = { kind: "system" as const, spaceId, jobId: "job-1" };
  const repositories = createRepositories(actor, {
    async query<Row>() {
      return { rows: [] as readonly Row[] };
    },
  });

  Object.assign(repositories, { mcp: runServers });
  repositories.runs.heartbeat = async () => runRecord();
  repositories.runs.update = async (_id, lease, patch) => {
    updates.push({ lease, patch });

    return runRecord();
  };

  return { repositories, updates };
}

function executionFor(runner: FakeRunner, overrides: Partial<RunRecord> = {}): RunExecution {
  return {
    actor: { kind: "system", spaceId, jobId: "job-1" },
    run: runRecord(overrides),
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
    messages: [{ role: "user", content: "file the issue" }],
  };
}

const script: readonly EmulatorStep[] = [
  {
    kind: "tool.immediate",
    callId: "call-mcp-1",
    tool: "mcp_issue_tracker_list_issues",
    arguments: { limit: 5 },
  },
  {
    kind: "tool.immediate",
    callId: "call-mcp-2",
    tool: "mcp_issue_tracker_list_issues",
    arguments: { limit: 5 },
  },
  { kind: "run.completed", messageId: "assistant-1" },
];

interface RunOutcome {
  readonly recorded: readonly RunEvent[];
  readonly definitions: readonly string[];
}

/**
 * Runs the script against an emulator server with the given grant state.
 * `revokeAfterCall` flips the live grant once the server has served that many
 * calls, which is exactly what an operator revoking mid-run does to the store.
 */
async function runWithMcp(options: {
  readonly granted: boolean;
  readonly revokeAfterCall?: number;
}): Promise<RunOutcome> {
  const emulator = new McpServerEmulator()
    .serve({
      url: serverUrl,
      serverName: "issue-tracker",
      serverVersion: "2.0.0",
      tools: [
        {
          name: "list_issues",
          description: "List open issues.",
          parameters: { type: "object", properties: { limit: { type: "integer" } } },
        },
      ],
    })
    .answerTool("list_issues", { content: "issue #1: the printer is on fire" });

  const grants = fakeGrantSet();
  const discovered = emulator.discover({ url: serverUrl });
  const runner = fakeRepositories(grants.runServers);
  const recorded: RunEvent[] = [];
  let definitions: readonly string[] = [];
  let calls = 0;

  if (options.granted) {
    grants.live.add(`${botId}:server-1`);
    grants.granted.set(botId, [
      {
        server: {
          id: "server-1",
          name: "issue-tracker",
          url: serverUrl,
          auth: "none",
          status: "ready",
          credentialName: "mcp:issue-tracker",
          lastError: null,
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
        tools: (await discovered).tools,
      },
    ]);
  }

  const provider: McpServerProvider = {
    discover: (request: McpDiscoverRequest) => emulator.discover(request),
    call: async (request: McpCallRequest) => {
      const result = await emulator.call(request);
      calls += 1;

      if (options.revokeAfterCall !== undefined && calls >= options.revokeAfterCall) {
        grants.live.delete(`${botId}:server-1`);
      }

      return result;
    },
    authorizationUrl: (request: McpAuthorizationRequest) => emulator.authorizationUrl(request),
    exchangeCode: (request: McpCodeExchangeRequest) => emulator.exchangeCode(request),
  };

  const execute = createRunExecutor({
    heartbeatIntervalMs: 5,
    work: (execution) =>
      Effect.gen(function* () {
        const runServers = yield* Effect.promise(() =>
          execution.repositories.mcp.listGrantedForBot(execution.run.botId),
        );
        const registrations = runServers.flatMap((grantedServer) =>
          createMcpTools({
            provider,
            server: {
              id: grantedServer.server.id,
              name: grantedServer.server.name,
              url: grantedServer.server.url,
            },
            tools: grantedServer.tools,
            readCredential: async () => serializeMcpCredential({ accessToken: "emulator-token" }),
            isGranted: () => execution.repositories.mcp.isGranted(botId, grantedServer.server.id),
          }),
        );

        const tools = createToolDispatcher({
          registrations,
          ledger: memoryLedger(),
          leaseTtlMs: 120_000,
          heartbeat: Effect.void,
        });

        definitions = tools.definitions().map((definition) => definition.name);

        return yield* withLiveRun(
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
      }),
  });

  await execute(executionFor(runner));

  return { recorded: recorded as readonly RunEvent[], definitions };
}

describe("an MCP server's tools in a run", () => {
  it("offers the discovered tool and returns its labelled content", async () => {
    const { recorded, definitions } = await runWithMcp({ granted: true });

    expect(definitions).toContain("mcp_issue_tracker_list_issues");

    const first = recorded.find(
      (event) => event.type === "tool.completed" && event.callId === "call-mcp-1",
    );

    expect(first?.type).toBe("tool.completed");

    if (first?.type !== "tool.completed") {
      throw new Error("the first MCP call did not complete");
    }

    expect(first.result).toMatchObject({
      ok: true,
      isError: false,
      content: {
        label: "untrusted",
        path: "mcp_output",
        origin: "mcp:issue-tracker:list_issues",
        content: "issue #1: the printer is on fire",
      },
    });
  });

  it("stops the next call when the grant is revoked mid-run", async () => {
    const { recorded } = await runWithMcp({ granted: true, revokeAfterCall: 1 });

    expect(recorded.find((event) => event.type === "tool.completed")?.type).toBe("tool.completed");

    const failed = recorded.find((event) => event.type === "tool.failed");

    expect(failed?.type).toBe("tool.failed");

    if (failed?.type !== "tool.failed") {
      throw new Error("the revoked call did not fail");
    }

    expect(failed.callId).toBe("call-mcp-2");
    expect(failed.error).toContain("auth_failed");
    expect(failed.error).toContain("not granted");
  });

  it("contributes no tools for a bot without the grant", async () => {
    const { recorded, definitions } = await runWithMcp({ granted: false });

    // The model may still ask for the name it saw in a previous run; the
    // dispatcher never registered it, so nothing ever completes.
    expect(definitions).toEqual([]);
    expect(recorded.filter((event) => event.type === "tool.completed")).toEqual([]);
  });
});
