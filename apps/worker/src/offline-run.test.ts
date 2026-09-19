import { Effect } from "effect";
import {
  ComputerEmulator,
  createMemoryCredentialStore,
  emulatorAgentRuntimeLayer,
  proxyTokenHeader,
} from "@porkbot/adapters";
import type { EmulatorStep } from "@porkbot/adapters";
import { createRepositories } from "@porkbot/db";
import type { FencedRunPatch, RunLease, RunRecord, SystemRepositories } from "@porkbot/db";
import {
  consumeRunSession,
  createBotSecretTools,
  createComputerTools,
  createFencedComputerCommands,
  createRunCredentialProxy,
  createRunEventRecorder,
  createToolDispatcher,
  liveRunsLayer,
  RUN_PROXY_TOKEN_ENV,
  RUN_PROXY_URL_ENV,
  withLiveRun,
} from "@porkbot/effect";
import type {
  ApprovalRecord,
  ApprovalStore,
  BotSecretRequests,
  BotSecretResolver,
  BotSecretSummary,
  SafeFetch,
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
import { parseEgressAllowlist } from "@porkbot/core";
import type { RunEvent } from "@porkbot/core";
import { createLogger } from "@porkbot/logging";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStorage } from "../test/memory-storage.ts";
import { createRunExecutor } from "./run-execution.ts";
import type { RunExecution } from "./jobs/run-execute.ts";
import { materializeRunAttachments } from "./run-attachments.ts";

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
const proxySecret = "test-proxy-capability-secret";
const modelOrigin = "https://model.example.test";
const modelCredentialName = "model-key";
const modelCredentialValue = "sk-model-secret-marker";
const botSecretName = "example_api";
const botSecretOrigin = "https://api.example.test";
const botSecretValue = "sk-bot-secret-marker";
const attachment = {
  id: "41a2f8a2-4a5a-4a6e-8f3a-2f5c9d1b7e4c",
  storageKey: "files/space-1/object/report.txt",
};

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
    // A live lease, because slice 7.8's grant deadline is read against the
    // wall clock the proxy holds rather than this record's epoch clock.
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

  // The source message and its attachment row, as the run's materialization
  // reads them (slice 7.6): the message block references the stored file, and
  // the run's space scopes both reads.
  repositories.messages.findSourceForRun = async () => ({
    id: "message-1",
    threadId: "thread-1",
    seq: 0,
    role: "user",
    blocks: [
      { type: "text", text: "read the attached brief" },
      {
        type: "file",
        attachmentId: attachment.id,
        filename: "brief.txt",
        contentType: "text/plain",
        sizeBytes: 20,
      },
    ],
    runId: "run-1",
    clientNonce: "nonce-1",
    createdAt: new Date(0),
  });
  repositories.files.findAttachments = async () => [
    {
      id: attachment.id,
      spaceId: "space-1",
      threadId: "thread-1",
      botId: computer.botId,
      userId: "user-1",
      filename: "brief.txt",
      contentType: "text/plain",
      sizeBytes: 20,
      storageKey: attachment.storageKey,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    },
  ];

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

/** The run's gate, already answered: every ask resolves approved on the first read. */
function autoApprovedGate(): ApprovalStore {
  const recordFor = (request: {
    readonly runId: string;
    readonly callId: string;
    readonly tool: string;
    readonly arguments: unknown;
    readonly expiresAt: Date;
  }): ApprovalRecord => ({
    id: `approval-${request.callId}`,
    runId: request.runId,
    callId: request.callId,
    tool: request.tool,
    arguments: request.arguments,
    status: "approved",
    expiresAt: request.expiresAt,
    decidedBy: "operator-1",
    decidedAt: new Date(0),
    reason: null,
  });

  return {
    async open(request) {
      return recordFor(request);
    },
    async find(runId, callId) {
      return recordFor({
        runId,
        callId,
        tool: "request_secret",
        arguments: {},
        expiresAt: new Date(0),
      });
    },
    async resolveTimeout(runId, callId) {
      return recordFor({
        runId,
        callId,
        tool: "request_secret",
        arguments: {},
        expiresAt: new Date(0),
      });
    },
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
  /** Every command the emulated sandbox received, in order. */
  readonly commands: readonly {
    readonly command: string;
    readonly environment?: Readonly<Record<string, string>> | undefined;
  }[];
  /** What the proxy put on the wire upstream, recorded by the injected leg. */
  readonly upstreamCalls: readonly {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }[];
  /** Every capability environment handed to a command, in order. */
  readonly environments: readonly Readonly<Record<string, string>>[];
  /** A call a holder of the run's capability made before the run settled. */
  readonly capabilityCallStatus: number;
  /** The capability call naming the approved bot secret, before the forget. */
  readonly secretCallStatus: number;
  /** The same call after the agent's forget took the upstream back. */
  readonly secretAfterForgetStatus: number;
}

/** Every emulator this suite started, so each test's proxy servers are released. */
const runningEmulators: ComputerEmulator[] = [];

afterEach(async () => {
  await Promise.all(runningEmulators.splice(0).map(async (emulator) => emulator.close()));
});

/** The upstream leg: records what crossed, answers a fixed model response. */
function recordingUpstream(calls: OfflineRun["upstreamCalls"][number][]): SafeFetch {
  return async (url, init) => {
    const headers: Record<string, string> = {};

    for (const [name, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[name.toLowerCase()] = value;
    }

    calls.push({ url: url.toString(), headers });

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function runOffline(): Promise<OfflineRun> {
  const leases = new MemoryComputerLeases();
  const runner = fakeRepositories(leases);
  const storage = new MemoryStorage();
  storage.putFrom(attachment.storageKey, "the attached brief", "text/plain");
  const upstreamCalls: OfflineRun["upstreamCalls"][number][] = [];
  const emulator = new ComputerEmulator({
    proxy: { tokenSecret: proxySecret, fetch: recordingUpstream(upstreamCalls) },
  });
  runningEmulators.push(emulator);
  emulator
    .servePage({ url: pageUrl, title: "Start here", text: "The report is due today." })
    .serveBrowserAction({ url: pageUrl, selector: "#next", action: "click" });
  await emulator.ensure(computer);

  const credentials = createMemoryCredentialStore([[modelCredentialName, modelCredentialValue]]);

  // One stored bot secret: the value is held server-side, and only the proxy
  // handle's resolver ever sees it.
  const botSecretRow: {
    destination: { name: string; origin: string; auth: { type: "bearer" } };
    value: string | undefined;
  } = {
    destination: { name: botSecretName, origin: botSecretOrigin, auth: { type: "bearer" } },
    value: botSecretValue,
  };
  const botSecrets: BotSecretRequests & BotSecretResolver = {
    async list(): Promise<readonly BotSecretSummary[]> {
      return [
        {
          name: botSecretName,
          status: botSecretRow.value === undefined ? "forgotten" : "stored",
          origin: botSecretOrigin,
          auth: { type: "bearer" },
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ];
    },
    async find(_botId, name) {
      if (name !== botSecretName) {
        return undefined;
      }

      return {
        name: botSecretName,
        status: botSecretRow.value === undefined ? "forgotten" : "stored",
        origin: botSecretOrigin,
        auth: { type: "bearer" },
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
    },
    async forget(_botId, name) {
      if (name !== botSecretName || botSecretRow.value === undefined) {
        return { removed: false };
      }

      botSecretRow.value = undefined;
      return { removed: true };
    },
    async resolve(_botId, name) {
      if (name !== botSecretName || botSecretRow.value === undefined) {
        return undefined;
      }

      return { destination: botSecretRow.destination, value: botSecretRow.value };
    },
  };
  const runProxy = createRunCredentialProxy({
    provider: emulator,
    credentials,
    botSecrets,
    tokenSecret: proxySecret,
  });
  const approvals = autoApprovedGate();
  /** What the proxy-holding command actually got, kept for the assertions. */
  const commandEnvironments: Readonly<Record<string, string>>[] = [];
  let capabilityCallStatus = 0;
  let secretCallStatus = 0;
  let secretAfterForgetStatus = 0;

  const recorded: RunEvent[] = [];
  const script: readonly EmulatorStep[] = [
    { kind: "token.delta", messageId: "assistant-1", delta: "On it. " },
    {
      kind: "tool.immediate",
      callId: "call-attachment",
      tool: "file_read",
      arguments: { path: `attachments/${attachment.id}/brief.txt` },
    },
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
    {
      kind: "tool.immediate",
      callId: "call-secret-request",
      tool: "request_secret",
      arguments: { name: botSecretName, origin: botSecretOrigin, auth: { type: "bearer" } },
    },
    { kind: "tool.immediate", callId: "call-secret-list", tool: "list_secrets", arguments: {} },
    { kind: "run.completed", messageId: "assistant-1" },
  ];

  const execute = createRunExecutor({
    heartbeatIntervalMs: 5,
    work: (execution) =>
      Effect.gen(function* () {
        const ledger = memoryLedger();
        const owner = execution.run.leaseOwner ?? "job-1";
        // The run's grant (slice 7.8): the credential is resolved server-side
        // into the computer's proxy, and the commands below carry only the
        // proxy's URL and a per-command capability. The grant's deadline is
        // the run's own lease end.
        const proxy = yield* Effect.tryPromise(() =>
          runProxy.open({
            computer,
            runId: execution.run.id,
            expiresAtSeconds: Math.floor(
              (execution.run.leaseExpiresAt ?? new Date()).getTime() / 1_000,
            ),
            upstreams: [
              { name: "model", origin: modelOrigin, credentialName: modelCredentialName },
            ],
          }),
        );

        // The harness owns revocation: registering here is the whole
        // contract, and the settle path revokes whether the session completed,
        // failed or lost its lease.
        execution.registerProxy?.(proxy);
        const environment = (timeoutMs: number): Readonly<Record<string, string>> => {
          const built = proxy.environmentFor(timeoutMs);

          commandEnvironments.push(built);
          return built;
        };

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
          environment,
        });

        // The message's attachment is placed in the home before the session
        // starts, through the same fenced runner the tools use.
        yield* materializeRunAttachments(execution.run, {
          computer,
          commands,
          repositories: execution.repositories,
          storage,
        });

        const tools = createToolDispatcher({
          registrations: [
            ...createComputerTools({
              commands,
              computer,
              maxDurationMs: 30_000,
              allowlist: parseEgressAllowlist(["docs.example.invalid"]),
            }),
            // The bot secret tools (slice 9.6): the ask opens the run's durable
            // gate, the approved name becomes one more proxy upstream, and the
            // value is resolved inside the proxy handle rather than here.
            ...createBotSecretTools({
              botId: execution.run.botId,
              secrets: botSecrets,
              proxy,
              approvals,
              approvalTimeoutMs: 10_000,
              maxDurationMs: 30_000,
            }),
          ],
          ledger,
          leaseTtlMs: 120_000,
          heartbeat: Effect.void,
        });

        // What a holder of the run's capability does with it: a real HTTP call
        // to the proxy while the grant is open. The credential crosses on the
        // proxy's own upstream leg; the caller's request carries none.
        const capability = proxy.environmentFor(30_000);
        const response = yield* Effect.tryPromise(() =>
          fetch(`${capability[RUN_PROXY_URL_ENV]}/u/model/v1/chat/completions`, {
            method: "POST",
            headers: {
              [proxyTokenHeader]: capability[RUN_PROXY_TOKEN_ENV] ?? "",
              "content-type": "application/json",
            },
            body: JSON.stringify({ model: "test-model" }),
          }),
        );
        capabilityCallStatus = response.status;

        const outcome = yield* withLiveRun(
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

        // The run's holder reaches the approved secret exactly as it reaches
        // the model credential: a capability and the upstream name, and the
        // proxy injects the value on its own leg.
        const secretCapability = proxy.environmentFor(30_000);
        const secretCall = (): Promise<Response> =>
          fetch(`${secretCapability[RUN_PROXY_URL_ENV]}/u/${botSecretName}/v1/items`, {
            headers: { [proxyTokenHeader]: secretCapability[RUN_PROXY_TOKEN_ENV] ?? "" },
          });

        secretCallStatus = (yield* Effect.tryPromise(secretCall)).status;

        // The agent's own forget: the value is cleared and the upstream is
        // taken back through the same handle, so the next request is refused
        // before any upstream is dialed.
        yield* tools.execute({
          runId: execution.run.id,
          callId: "call-secret-forget",
          tool: "forget_secret",
          arguments: { name: botSecretName },
        });

        secretAfterForgetStatus = (yield* Effect.tryPromise(secretCall)).status;

        return outcome;
      }),
  });

  await execute(executionFor(runner));

  return {
    recorded: recorded as readonly RunEvent[],
    updates: runner.updates,
    leases,
    commands: emulator.commands,
    upstreamCalls,
    environments: commandEnvironments,
    capabilityCallStatus,
    secretCallStatus,
    secretAfterForgetStatus,
  };
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
    expect(read.content.origin).toBe("home:/report.txt");
    expect(read.content.content).toBe("the report is ready");
  });

  it("reads the bytes an uploaded attachment was materialized from", async () => {
    const { recorded } = await runOffline();

    const read = toolResult(recorded, "call-attachment") as {
      ok: boolean;
      bytes: number;
      content: { label: string; path: string; origin: string; content: string };
    };

    expect(read.ok).toBe(true);
    expect(read.bytes).toBe(18);
    expect(read.content.label).toBe("untrusted");
    expect(read.content.path).toBe("file_read");
    expect(read.content.origin).toBe(`home:/attachments/${attachment.id}/brief.txt`);
    expect(read.content.content).toBe("the attached brief");
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

  it("carries only a proxy capability into the sandbox, never the model credential", async () => {
    const { commands, environments, upstreamCalls, capabilityCallStatus } = await runOffline();

    // The capability worked: a real HTTP call through the proxy reached the
    // upstream with the credential the proxy injected.
    const modelCalls = upstreamCalls.filter((call) => call.url.startsWith(modelOrigin));

    expect(capabilityCallStatus).toBe(200);
    expect(modelCalls).toHaveLength(1);
    expect(modelCalls[0]?.url).toBe(`${modelOrigin}/v1/chat/completions`);
    expect(modelCalls[0]?.headers["authorization"]).toBe(`Bearer ${modelCredentialValue}`);

    // Every command carried the proxy's address and its own short-lived
    // token, and nothing a credential could hide in.
    expect(environments.length).toBeGreaterThan(0);

    for (const environment of environments) {
      expect(environment[RUN_PROXY_URL_ENV]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(environment[RUN_PROXY_TOKEN_ENV]).toBeTruthy();
      expect(Object.keys(environment).sort()).toEqual([RUN_PROXY_TOKEN_ENV, RUN_PROXY_URL_ENV]);
    }

    const sandboxView = JSON.stringify({ commands, environments });
    expect(sandboxView).not.toContain(modelCredentialValue);
    expect(sandboxView).not.toContain(modelOrigin);
  });

  it("lets an approved ask reach the secret's upstream only through the proxy", async () => {
    const { recorded, upstreamCalls, environments, secretCallStatus } = await runOffline();

    // The ask was annotated by the tool and answered by the gate; the list
    // names the credential and its status, never its value or destination.
    expect(toolResult(recorded, "call-secret-request")).toMatchObject({
      ok: true,
      name: botSecretName,
      status: "granted",
    });
    expect(toolResult(recorded, "call-secret-list")).toEqual({
      ok: true,
      secrets: [{ name: botSecretName, status: "stored" }],
    });

    // The capability call reached the secret's origin with the injected
    // header; the sandbox's own request carried nothing but the token.
    expect(secretCallStatus).toBe(200);
    const secretCall = upstreamCalls.find((call) => call.url === `${botSecretOrigin}/v1/items`);
    expect(secretCall?.headers["authorization"]).toBe(`Bearer ${botSecretValue}`);

    // Nothing the model can see — events, tool results, the sandbox's
    // environments — carries the value. The destination is the ask itself and
    // the operator's card; the list result above is the one surface and it
    // names only the credential and its status.
    const modelView = JSON.stringify({ recorded, environments });
    expect(modelView).not.toContain(botSecretValue);
  });

  it("takes the upstream back on the agent's forget, so the next request is refused", async () => {
    const { recorded, upstreamCalls, secretAfterForgetStatus } = await runOffline();

    expect(secretAfterForgetStatus).toBe(403);
    // The second call never dialed an upstream: the proxy refused the name
    // before the request left the machine.
    expect(upstreamCalls.filter((call) => call.url.startsWith(botSecretOrigin))).toHaveLength(1);

    const modelView = JSON.stringify(recorded);
    expect(modelView).not.toContain(botSecretValue);
  });

  it("revokes the run's grant when the run ends, so an unexpired capability dies with it", async () => {
    const { environments } = await runOffline();
    const last = environments.at(-1);

    expect(last).toBeDefined();

    const response = await fetch(`${last?.[RUN_PROXY_URL_ENV] ?? ""}/u/model/v1/models`, {
      headers: { [proxyTokenHeader]: last?.[RUN_PROXY_TOKEN_ENV] ?? "" },
    });

    // The token still verifies — it is unexpired and bound to this computer —
    // but the run it names has no grant any more, so the proxy refuses.
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "no_grant" });
  });
});
