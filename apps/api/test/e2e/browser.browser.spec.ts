import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import {
  ComputerEmulator,
  InProcessRealtimeFanout,
  LocalStorageProvider,
  MailEmulator,
  ModelEmulator,
} from "@porkbot/adapters";
import type { ComputerRef } from "@porkbot/adapter-kit";
import type { RunEvent, RunStep } from "@porkbot/core";
import {
  createApprovalStore,
  createCredentialKeyring,
  createRepositories,
  createRunEventSink,
  deploymentSettings,
  openDatabase,
  queryable,
  readDeploymentSettings,
} from "@porkbot/db";
import type { DatabaseHandle, SystemActor, UserActor, UserRepositories } from "@porkbot/db";
import type { SafeFetch } from "@porkbot/effect";
import { createLogger } from "@porkbot/logging";
import { createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteDatabase } from "@porkbot/testkit";
import { createOperatorAuth } from "../../src/operator-auth.ts";
import type { OperatorAuth } from "../../src/operator-auth.ts";
import type { ComputerLifecycleProvider } from "../../src/services/computers.ts";
import { createDeploymentService } from "../../src/services/deployment.ts";
import { createApiServer } from "../../src/server.ts";

/**
 * A release-flow browser fixture: the browser talks to a real built SPA over
 * one origin, the API is the shipped Node server, and the only providers are
 * the mail, model and computer emulators. The front proxy is deliberately
 * tiny and test-local; it recreates the single-origin deployment shape so the
 * browser exercises the same HTTP transport as a deployment.
 */

const ownerEmail = "browser-owner@example.invalid";
const password = "correct-horse-battery";
const authSecret = "browser-e2e-secret-not-real-0123456789abcdef";
const logger = createLogger({ level: "info", service: "@porkbot/api", write: () => {} });

interface StaticHost {
  readonly child: ChildProcess;
  readonly port: number;
}

interface BrowserRun {
  readonly runId: string;
  readonly threadId: string;
  readonly callId: string;
  continueAfterApproval(): Promise<void>;
  cancel(): Promise<void>;
  /** Settle the run successfully, so the surface closes with its report card. */
  complete(): Promise<void>;
  /** Settle the run as failed, so the surface closes with the failure line. */
  fail(): Promise<void>;
}

interface StartRunOptions {
  /**
   * Where the run parks. `approval` (the default) is the gate the existing
   * flows drive; `working` leaves the run mid-call, so a test can capture the
   * live strip and then settle it with `complete()` or `fail()`.
   */
  readonly stop?: "approval" | "working";
}

interface BrowserHarness {
  readonly origin: string;
  readonly suite: SuiteDatabase;
  readonly database: DatabaseHandle;
  readonly operator: OperatorAuth;
  readonly apiServer: Server;
  readonly proxy: Server;
  readonly staticHost: StaticHost;
  readonly realtime: InProcessRealtimeFanout;
  readonly computer: ComputerEmulator;
  readonly model: ModelEmulator;
  actor: UserActor | undefined;
  repositories: UserRepositories | undefined;
  bindActor(page: Page): Promise<UserRepositories>;
  attachComputer(botId: string): Promise<void>;
  seedMemory(botId: string): Promise<void>;
  seedUsage(botId: string): Promise<void>;
  startRun(threadId: string, options?: StartRunOptions): Promise<BrowserRun>;
  close(): Promise<void>;
}

interface RunRow {
  readonly id: string;
  readonly sourceMessageId: string | null;
}

interface SteeringRow {
  readonly id: string;
  readonly text: string | null;
}

type EventTemplate = {
  readonly schemaVersion: 1;
  readonly threadId: string;
  readonly runId: string;
  readonly type: RunEvent["type"];
} & Record<string, unknown>;

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();

      if (address === null || typeof address === "string") {
        reject(new Error("the test server did not return a socket address"));
        return;
      }

      resolve(address.port);
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

function forward(request: IncomingMessage, response: ServerResponse, port: number): void {
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port,
      path: request.url ?? "/",
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${String(port)}` },
    },
    (answer) => {
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(response);
    },
  );

  upstream.on("error", () => {
    if (!response.headersSent) {
      response.writeHead(502, { "content-type": "application/json" });
    }

    response.end(JSON.stringify({ error: "upstream_unavailable" }));
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function isApiRequest(request: IncomingMessage): boolean {
  const pathname = new URL(request.url ?? "/", "http://browser").pathname;

  return (
    pathname.startsWith("/rpc/") ||
    pathname.startsWith("/api/auth/") ||
    pathname.startsWith("/files/") ||
    pathname.startsWith("/webhooks/") ||
    pathname === "/healthz" ||
    pathname === "/livez" ||
    pathname === "/readyz" ||
    (request.method === "POST" && pathname.startsWith("/threads/"))
  );
}

async function startWebHost(): Promise<StaticHost> {
  const webRoot = path.resolve(import.meta.dirname, "../../../web");
  const child = spawn(process.execPath, ["dist/host/main.js"], {
    cwd: webRoot,
    env: { ...process.env, PORT: "0", LOG_LEVEL: "info" },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("the built web host did not report a port")),
      15_000,
    );
    const lines = createInterface({ input: child.stdout });

    lines.on("line", (line) => {
      try {
        const record = JSON.parse(line) as { readonly msg?: string; readonly port?: number };

        if (record.msg === "web listening" && typeof record.port === "number") {
          clearTimeout(timer);
          resolve(record.port);
        }
      } catch {
        // The logger may write a non-JSON line before the structured record.
      }
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the built web host exited before listening (code ${String(code)})`));
    });
  });

  return { child, port };
}

async function stopWebHost(host: StaticHost): Promise<void> {
  if (host.child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    host.child.once("exit", () => resolve());
    host.child.kill("SIGTERM");
  });
}

function offlineComputer(computer: ComputerEmulator): ComputerLifecycleProvider {
  return Object.assign(computer, {
    reset: async (ref: ComputerRef) => {
      await computer.destroy(ref);
      return computer.ensure(ref);
    },
    recover: (ref: ComputerRef) => computer.ensure(ref),
    // The fixture serves the emulator and reports a second kind the deployment
    // does not configure, so the provider sheet's unavailable row and its
    // reason are exercised rather than only asserted.
    providers: async () => ({ defaultKind: "offline", kinds: ["offline", "docker"] }),
    validateProvider: async (kind: string) => ({
      kind,
      available: kind === "offline",
      failure: kind === "offline" ? null : ("not_found" as const),
    }),
  }) satisfies ComputerLifecycleProvider;
}

async function createHarness(): Promise<BrowserHarness> {
  const suite = await createSuiteDatabase({ suite: "api_browser" });
  const database = openDatabase(suite.connectionString, "api");
  const storageRoot = await mkdtemp(path.join(tmpdir(), "porkbot-browser-storage-"));
  const credentialKeys = createCredentialKeyring({
    activeKeyId: "browser",
    keys: [{ id: "browser", key: Buffer.alloc(32, 7).toString("base64") }],
  });
  const proxy = createServer();
  const proxyPort = await listen(proxy);
  const origin = `http://127.0.0.1:${String(proxyPort)}`;
  const computer = new ComputerEmulator();
  const computers = offlineComputer(computer);
  const realtime = new InProcessRealtimeFanout();
  const model = await ModelEmulator.start(
    {
      models: ["porkbot-e2e"],
      turns: [{ steps: [{ type: "text", delta: "offline" }], finishReason: "stop" }],
    },
    globalThis.fetch as unknown as SafeFetch,
  );
  const operator = createOperatorAuth({
    database: database.database,
    secret: authSecret,
    origin,
    mail: new MailEmulator(),
    logger,
  });

  await database.database
    .insert(deploymentSettings)
    .values({ signupsEnabled: true, adminEmail: ownerEmail });

  const apiServer = createApiServer({
    services: {
      deployment: createDeploymentService(() => readDeploymentSettings(database.database)),
      realtime,
      storage: new LocalStorageProvider({ root: storageRoot }),
      computers,
      modelRuntime: () => model,
    },
    logger,
    authHandler: operator.handler,
    resolveActor: operator.resolveActor,
    repositoriesFor: (actor) => createRepositories(actor, queryable(database), { credentialKeys }),
    cursorSecret: authSecret,
  });
  const apiPort = await listen(apiServer);
  const staticHost = await startWebHost();

  proxy.on("request", (request, response) => {
    forward(request, response, isApiRequest(request) ? apiPort : staticHost.port);
  });

  const harness: BrowserHarness = {
    origin,
    suite,
    database,
    operator,
    apiServer,
    proxy,
    staticHost,
    realtime,
    computer,
    model,
    actor: undefined,
    repositories: undefined,
    async bindActor(page) {
      const cookies = await page.context().cookies(origin);
      const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
      const actor = await operator.resolveActor(new Headers({ cookie: cookieHeader }));

      if (actor === null) {
        throw new Error("the browser session did not resolve to an actor");
      }

      const repositories = createRepositories(actor, queryable(database), { credentialKeys });
      harness.actor = actor;
      harness.repositories = repositories;
      return repositories;
    },
    async attachComputer(botId) {
      const repositories = harness.repositories;

      if (repositories === undefined) {
        throw new Error("bindActor must run before attaching a computer");
      }

      await repositories.bots.update(botId, { computerId: randomUUID() });
    },
    async seedMemory(botId) {
      const repositories = harness.repositories;

      if (repositories === undefined) {
        throw new Error("bindActor must run before seeding memory");
      }

      const documentId = randomUUID();
      const result = await repositories.memory.write(botId, {
        write: {
          action: "create",
          documentId,
          kind: "fact",
          title: "Release note",
          content: "The browser fixture starts offline.",
        },
        reason: "Seed the release-flow memory card",
      });

      if (!result.ok) {
        throw new Error("the browser fixture could not seed memory");
      }
    },
    async seedUsage(botId) {
      const query = queryable(database);
      const { rows } = await query.query<{ readonly id: string }>(
        "select id from run where bot_id = $1 order by created_at desc, id desc limit 1",
        [botId],
      );
      const runId = rows[0]?.id;

      if (runId === undefined) {
        throw new Error("the browser fixture needs a run before seeding usage");
      }

      // The offline fixture drives scripted events rather than a live model, so
      // no usage rows exist; the ledger is seeded with the shape a week of
      // calls would leave, including one day whose provider reported nothing.
      // It is a fixture for the capture, not a claim about the runtime.
      const days: readonly {
        readonly daysAgo: number;
        readonly input: number | null;
        readonly output: number | null;
      }[] = [
        { daysAgo: 0, input: 4820, output: 1290 },
        { daysAgo: 1, input: 2360, output: 640 },
        { daysAgo: 2, input: null, output: null },
        { daysAgo: 4, input: 980, output: 260 },
        { daysAgo: 5, input: 1510, output: 410 },
      ];

      for (const day of days) {
        await query.query(
          "insert into usage_record (space_id, bot_id, run_id, provider, model, input_tokens, output_tokens, created_at) " +
            "select r.space_id, r.bot_id, r.id, 'offline', 'porkbot-e2e', $2, $3, " +
            "now() - make_interval(days => $4) from run r where r.id = $1",
          [runId, day.input, day.output, day.daysAgo],
        );
      }
    },
    async startRun(threadId, options = {}) {
      const actor = harness.actor;
      const repositories = harness.repositories;

      if (actor === undefined || repositories === undefined) {
        throw new Error("bindActor must run before starting a run");
      }

      const system: SystemActor = {
        kind: "system",
        spaceId: actor.spaceId,
        jobId: `browser-${randomUUID()}`,
      };
      const systemRepositories = createRepositories(system, queryable(database));
      const sink = createRunEventSink(system, queryable(database));
      const approvals = createApprovalStore(system, queryable(database));
      const owner = `browser-worker-${randomUUID()}`;
      let run: RunRow | undefined;
      let claimed: Awaited<ReturnType<typeof systemRepositories.runs.claim>> | undefined;

      // The send that starts a run is asynchronous from the test's point of
      // view, so the poll looks for a run it can actually claim rather than
      // stopping at the thread's previous, already-settled row.
      for (let attempt = 0; attempt < 20 && claimed === undefined; attempt += 1) {
        const { rows } = await queryable(database).query<RunRow>(
          'select id, source_message_id as "sourceMessageId" from run where thread_id = $1 ' +
            "order by created_at desc, id desc limit 1",
          [threadId],
        );
        const candidate = rows[0];

        if (candidate !== undefined) {
          const claim = await systemRepositories.runs.claim(candidate.id, 0, owner);

          if (claim !== undefined) {
            run = candidate;
            claimed = claim;
          }
        }

        if (claimed === undefined) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }

      if (run === undefined || claimed === undefined) {
        throw new Error("the browser send did not create a claimable run");
      }

      const lease = { owner, fence: claimed.leaseFence };
      const callId = randomUUID();
      const assistantMessageId = randomUUID();
      const thread = await repositories.threads.findById(threadId);
      // The same allocation the worker's live run uses: the thread's counter is
      // the next event's position, and the floor of 1 is the first event a
      // thread ever has. Incrementing before the append would leave a gap, and
      // a subscription's reducer holds a non-contiguous frame as pending.
      let sequence = Math.max(1, thread.nextEventSeq);

      async function append(event: EventTemplate): Promise<void> {
        await sink.append({ ...event, seq: sequence } as RunEvent);
        await realtime.publish({ threadId, latestSeq: sequence });
        sequence += 1;
      }

      await append({
        schemaVersion: 1,
        threadId,
        runId: run.id,
        type: "run.started",
      });
      await systemRepositories.runs.heartbeat(run.id, lease, {
        progressed: true,
        idleSeconds: 0,
        step: { kind: "thinking", tool: null } satisfies RunStep,
      });
      await append({
        schemaVersion: 1,
        threadId,
        runId: run.id,
        type: "token.delta",
        messageId: assistantMessageId,
        delta: "Working offline. ",
      });
      await append({
        schemaVersion: 1,
        threadId,
        runId: run.id,
        type: "tool.requested",
        callId,
        tool: "shell",
        arguments: { command: "echo offline" },
      });
      await systemRepositories.runs.heartbeat(run.id, lease, {
        progressed: true,
        idleSeconds: 0,
        step: { kind: "working", tool: "shell" } satisfies RunStep,
      });

      if (options.stop !== "working") {
        const expiresAt = new Date(Date.now() + 60 * 60 * 1_000);

        await approvals.open({
          runId: run.id,
          callId,
          tool: "shell",
          arguments: { command: "echo offline" },
          expiresAt,
        });
        await append({
          schemaVersion: 1,
          threadId,
          runId: run.id,
          type: "approval.requested",
          callId,
          expiresAt: expiresAt.toISOString(),
        });
        await systemRepositories.runs.heartbeat(run.id, lease, {
          progressed: true,
          idleSeconds: 0,
          step: { kind: "waiting", tool: "shell" } satisfies RunStep,
        });
        await systemRepositories.runs.update(run.id, lease, { status: "waiting_approval" });
      }

      // A second gate on the same run, already past its deadline and settled
      // by the store, so the captures carry a timed-out card beside the
      // pending one without waiting out a real ten-minute gate.
      const timedOutCallId = randomUUID();
      const expiredAt = new Date(Date.now() - 60_000);

      await append({
        schemaVersion: 1,
        threadId,
        runId: run.id,
        type: "tool.requested",
        callId: timedOutCallId,
        tool: "file_write",
        arguments: { path: "/srv/report.txt" },
      });
      await approvals.open({
        runId: run.id,
        callId: timedOutCallId,
        tool: "file_write",
        arguments: { path: "/srv/report.txt" },
        expiresAt: expiredAt,
      });
      await approvals.resolveTimeout(run.id, timedOutCallId);
      await append({
        schemaVersion: 1,
        threadId,
        runId: run.id,
        type: "approval.requested",
        callId: timedOutCallId,
        expiresAt: expiredAt.toISOString(),
      });
      await append({
        schemaVersion: 1,
        threadId,
        runId: run.id,
        type: "approval.resolved",
        callId: timedOutCallId,
        decision: "timed_out",
      });

      return {
        runId: run.id,
        threadId,
        callId,
        async continueAfterApproval() {
          const { rows: steeringRows } = await queryable(database).query<SteeringRow>(
            "select id, blocks->0->>'text' as text from message where thread_id = $1 and run_id = $2 " +
              "order by seq desc, id desc limit 1",
            [threadId, run.id],
          );
          const steering = steeringRows[0];

          if (steering === undefined || steering.text === null) {
            throw new Error("the browser steer did not persist");
          }

          await systemRepositories.runs.update(run.id, lease, { status: "running" });
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "approval.resolved",
            callId,
            decision: "approved",
          });
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "run.steered",
            messageId: steering.id,
            text: steering.text,
          });
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "tool.completed",
            callId,
            result: { stdout: "offline", exitCode: 0 },
            durationMs: 12,
          });
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "token.delta",
            messageId: assistantMessageId,
            delta: "offline assistant response",
          });
          await systemRepositories.runs.heartbeat(run.id, lease, {
            progressed: true,
            idleSeconds: 0,
            step: { kind: "thinking", tool: null } satisfies RunStep,
          });
        },
        async cancel() {
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "run.cancelled",
            reason: "operator",
          });
          await systemRepositories.runs.update(run.id, lease, {
            status: "cancelled",
            completed: true,
            release: true,
            attempt: "cancelled",
          });
        },
        async complete() {
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "tool.completed",
            callId,
            result: { stdout: "offline", exitCode: 0 },
            durationMs: 42,
          });
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "token.delta",
            messageId: assistantMessageId,
            delta: "offline assistant response",
          });
          await systemRepositories.runs.heartbeat(run.id, lease, {
            progressed: true,
            idleSeconds: 0,
            step: { kind: "thinking", tool: null } satisfies RunStep,
          });
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "run.completed",
            messageId: assistantMessageId,
          });
          await systemRepositories.runs.update(run.id, lease, {
            status: "completed",
            completed: true,
            release: true,
            attempt: "completed",
          });
        },
        async fail() {
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "tool.failed",
            callId,
            error: 'tool "shell" failed (timed_out): no answer before the deadline',
            durationMs: 30_000,
          });
          await append({
            schemaVersion: 1,
            threadId,
            runId: run.id,
            type: "run.failed",
            error: "the model connection dropped",
            code: "provider",
          });
          await systemRepositories.runs.update(run.id, lease, {
            status: "failed",
            completed: true,
            release: true,
            attempt: "failed",
          });
        },
      };
    },
    async close() {
      await closeServer(proxy);
      await closeServer(apiServer);
      await stopWebHost(staticHost);
      await model.stop();
      await computer.close();
      await database.close();
      await suite.destroy();
      await rm(storageRoot, { recursive: true, force: true });
    },
  };

  // The proxy was bound first so its origin could be used by Better Auth. Its
  // request listener is attached after the API and static host are ready, so a
  // browser can never observe a half-composed origin.
  return harness;
}

async function rpc<T>(page: Page, procedure: string, input: unknown): Promise<T> {
  return page.evaluate(
    async ({ procedure: path, input: body }) => {
      const response = await fetch(`/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      });
      const payload = (await response.json()) as { readonly json?: T; readonly error?: unknown };

      if (!response.ok || !("json" in payload)) {
        throw new Error(`RPC ${path} failed with status ${String(response.status)}`);
      }

      return payload.json as T;
    },
    { procedure, input },
  );
}

function botIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/\/bots\/([^/]+)\/edit$/);

  if (match?.[1] === undefined) {
    throw new Error(`the bot editor URL did not contain a bot id: ${url}`);
  }

  return match[1];
}

function threadIdFromUrl(url: string): string {
  const match = new URL(url).pathname.match(/\/threads\/([^/]+)$/);

  if (match?.[1] === undefined) {
    throw new Error(`the thread URL did not contain a thread id: ${url}`);
  }

  return match[1];
}

/**
 * The roster's acceptance captures (slice 13.6): a populated roster, the empty
 * roster a fresh operator lands on, and the archived group. They land in
 * `test-results/ui/` beside the shell captures, which CI uploads and the pull
 * request links; the archived group is captured open because that is the state
 * the slice adds.
 */
async function captureRoster(
  page: Page,
  origin: string,
  name: string,
  options: {
    readonly archived?: boolean;
    readonly narrow?: boolean;
    readonly modes?: readonly ("dark" | "light")[];
  } = {},
): Promise<void> {
  const uiDir = path.resolve("test-results/ui");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(origin);
  await expect(page.getByRole("heading", { name: "Bots" })).toBeVisible();
  // The loader is what fills the rows; wait for the roster to settle rather
  // than for the heading alone, so a capture is never of a loading pane.
  await expect(page.locator("[data-roster-card], [data-empty]").first()).toBeVisible();

  if (options.archived === true) {
    await page.getByRole("button", { name: /^Archived \(/ }).click();
    await expect(page.getByRole("button", { name: "Hide archived" })).toBeVisible();
  }

  for (const mode of options.modes ?? ["dark"]) {
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(uiDir, `${name}-1280-${mode}.png`) });
  }

  if (options.narrow === true) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);

    const overflow = await page.evaluate(() => {
      const pane = document.querySelector("[data-shell-pane]");
      return pane === null ? 0 : pane.scrollWidth - pane.clientWidth;
    });

    expect(overflow, "the roster does not scroll sideways at 390").toBe(0);
    await page.screenshot({ path: path.join(uiDir, `${name}-390-dark.png`) });
  }
}

/**
 * The shell's acceptance captures (slice 13.4): the workspace at 1280 and 390
 * in both modes, plus the narrow switcher sheet. They land in
 * `test-results/ui/` beside the release screenshot, which CI uploads and the
 * pull request links; the narrow switcher is exercised here rather than only
 * asserted, because it is the pane the shell replaces the rail with.
 */
async function captureWorkspace(
  page: Page,
  origin: string,
  botId: string,
  threadId: string,
): Promise<void> {
  const uiDir = path.resolve("test-results/ui");
  const threadUrl = `${origin}/bots/${botId}/threads/${threadId}`;

  // One load, four captures: resizing and emulating the colour scheme do not
  // navigate, so the console's stream stays open and the captures show the
  // workspace rather than a reconnect line.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(threadUrl);
  await expect(page.getByText("Start offline task", { exact: true })).toBeVisible();

  for (const mode of ["dark", "light"] as const) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.emulateMedia({ colorScheme: mode });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(uiDir, `shell-${String(width)}-${mode}.png`) });

      if (width === 390) {
        const overflow = await page.evaluate(() => {
          const pane = document.querySelector("[data-shell-pane]");
          return pane === null ? 0 : pane.scrollWidth - pane.clientWidth;
        });

        expect(overflow, "the content pane does not scroll horizontally at 390").toBe(0);
      }
    }
  }

  // The narrow switcher sheet, the pane the shell replaces the rail with. It
  // is exercised here rather than only asserted, and the capture waits out the
  // sheet's 180ms enter animation.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.getByRole("button", { name: "Switch bot" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(uiDir, "shell-390-switcher-dark.png") });
  await page
    .getByRole("dialog")
    .getByRole("link", { name: /Offline Helper/ })
    .click();
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}$`));
}

/**
 * The approval captures (slice 13.9): the inline card with a pending gate and
 * a timed-out one in the transcript, the queue that mirrors the same decision,
 * and the thread once the operator answered, each in both modes; the narrow
 * capture is the design record's inline card at 390. They land in
 * `test-results/ui/` beside the conversation captures, which CI uploads and
 * the pull request links.
 */
async function captureApprovalState(
  page: Page,
  name: string,
  options: { readonly narrow?: boolean } = {},
): Promise<void> {
  const uiDir = path.resolve("test-results/ui");

  await mkdir(uiDir, { recursive: true });

  for (const mode of ["dark", "light"] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(uiDir, `${name}-1280-${mode}.png`) });
  }

  if (options.narrow === true) {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(200);

    const overflow = await page.evaluate(() => {
      const pane = document.querySelector("[data-shell-pane]");
      return pane === null ? 0 : pane.scrollWidth - pane.clientWidth;
    });

    expect(overflow, "the approval card does not scroll sideways at 390").toBe(0);
    await page.screenshot({ path: path.join(uiDir, `${name}-390-dark.png`) });
  }
}

/**
 * The computer surface's acceptance captures (slice 13.10): the running
 * machine with its tabs and state control in both modes, the lifecycle menu
 * that states what each verb does, the reset confirmation, the provider sheet
 * and the stopped machine. They land in `test-results/ui/` beside the shell's
 * captures, which CI uploads and the pull request links, and each state is
 * exercised here rather than only asserted, so the capture is of the real
 * client against the real API. The machine is left running.
 */
async function captureComputer(page: Page): Promise<void> {
  const uiDir = path.resolve("test-results/ui");
  const surface = page.locator("[data-computer-view-state]");

  await mkdir(uiDir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  for (const mode of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    // Park the pointer away from the controls so a capture never shows a
    // hover state the state under test does not have.
    await page.mouse.move(0, 0);
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(uiDir, `interface-computer-1280-${mode}.png`) });
  }

  await page.emulateMedia({ colorScheme: "dark" });

  // The lifecycle menu, open: every verb states what it does before it is
  // chosen.
  await page.getByRole("button", { name: /machine actions/ }).click();
  await expect(
    page.getByRole("menuitem", { name: "Reset — destroy the machine and its home" }),
  ).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(uiDir, "computer-lifecycle.png") });

  // The destructive verb confirms, naming what is lost and what is kept.
  await page
    .getByRole("menuitem", { name: "Reset — destroy the machine and its home" })
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(uiDir, "computer-reset.png") });
  await page.getByRole("button", { name: "Cancel" }).evaluate((el) => (el as HTMLElement).click());

  // The provider sheet: what each kind is and why one is unavailable, then the
  // confirmation a choice still arms.
  await page.getByRole("button", { name: "Change" }).evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(uiDir, "computer-provider.png") });
  // A press, not `check()`: the radio is controlled by the stored selection,
  // so choosing arms the confirmation rather than flipping the radio itself.
  await page
    .getByRole("radio", { name: /^Offline emulator/ })
    .evaluate((el) => (el as HTMLElement).click());
  await expect(page.getByText("does not move this bot's home")).toBeVisible();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(uiDir, "computer-switch-confirm.png") });
  await page.getByRole("button", { name: "Cancel" }).evaluate((el) => (el as HTMLElement).click());

  // The stopped machine: the surface states the state, and the terminal and
  // files say the machine is not running rather than offering a dead shell.
  await page.getByRole("button", { name: /machine actions/ }).click();
  await page
    .getByRole("menuitem", { name: "Stop — park it, keeping the home" })
    .evaluate((el) => (el as HTMLElement).click());
  await expect(surface).toHaveText("Stopped");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(uiDir, "computer-stopped.png") });

  await page.getByRole("button", { name: /machine actions/ }).click();
  await page
    .getByRole("menuitem", { name: "Start — bring the machine up" })
    .evaluate((el) => (el as HTMLElement).click());
  await expect(surface).toHaveText("Running");
}

/**
 * The settings captures (slice 13.13): the one panel and each of its six
 * sections, in both modes, with the explicit mode control exercised rather
 * than emulated — the capture is of the choice the slice adds. They land in
 * `test-results/ui/` beside the shell's captures, which CI uploads and the
 * pull request links, and the panel is the real client reading the real API,
 * so a section that holds nothing says so.
 */
async function captureSettings(page: Page, origin: string): Promise<void> {
  const uiDir = path.resolve("test-results/ui");
  const sections = ["models", "mcp", "secrets", "notifications", "usage", "account"];

  await mkdir(uiDir, { recursive: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/settings`);
  await expect(page.locator("#account")).toBeVisible();

  for (const mode of ["Dark", "Light"] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      document.querySelector("[data-shell-pane]")?.scrollTo(0, 0);
    });
    await page.waitForTimeout(200);
    await page.screenshot({
      path: path.join(uiDir, `interface-settings-1280-${mode.toLowerCase()}.png`),
    });

    for (const id of sections) {
      await page.evaluate((sectionId) => {
        document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
      }, id);
      await page.waitForTimeout(200);
      await page.screenshot({
        path: path.join(uiDir, `settings-${id}-1280-${mode.toLowerCase()}.png`),
      });
    }
  }
}

/**
 * The memory captures (slice 13.12): a document card with its revision
 * timeline open, and the Removed scope where the tombstone is marked. They
 * land in `test-results/ui/` beside the shell's captures, which CI uploads and
 * the pull request links, and the history is opened through the screen's own
 * control rather than staged.
 */
async function captureMemory(
  page: Page,
  name: string,
  options: { readonly history?: boolean } = {},
): Promise<void> {
  const uiDir = path.resolve("test-results/ui");

  await mkdir(uiDir, { recursive: true });

  if (options.history === true) {
    await page
      .locator("[data-memory-document]")
      .first()
      .getByRole("button", { name: "History" })
      .click();
    await expect(page.locator("[data-memory-timeline-entry]").first()).toBeVisible();
  }

  for (const mode of ["dark", "light"] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(uiDir, `${name}-1280-${mode}.png`) });
  }
}

/**
 * The usage captures (slice 13.12): one bot's report (stat tiles and daily
 * bars) and the settings report that fans out over every bot. They land in
 * `test-results/ui/` beside the memory captures, which CI uploads and the pull
 * request links.
 */
async function captureUsage(page: Page, origin: string, botId: string): Promise<void> {
  const uiDir = path.resolve("test-results/ui");

  await mkdir(uiDir, { recursive: true });

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${origin}/bots/${botId}/usage`);
  await expect(page.locator("[data-usage-stat]").first()).toBeVisible();

  for (const mode of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(uiDir, `usage-bot-1280-${mode}.png`) });
  }

  await page.goto(`${origin}/settings/usage`);
  await expect(page.locator("[data-usage-stat]").first()).toBeVisible();

  for (const mode of ["dark", "light"] as const) {
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(uiDir, `usage-settings-1280-${mode}.png`) });
  }
}

/**
 * The console's acceptance captures (slices 13.7 and 13.8): the conversation's
 * streaming run, attachment and upload failure, and the run surface's live
 * strip and report cards, each in both modes. They land in `test-results/ui/`
 * beside the shell's captures, which CI uploads and the pull request links, and
 * each state is exercised here rather than only asserted, so the capture is of
 * the real client against the real API.
 */
async function captureConsoleState(page: Page, name: string): Promise<void> {
  const uiDir = path.resolve("test-results/ui");

  await mkdir(uiDir, { recursive: true });

  for (const mode of ["dark", "light"] as const) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: mode });
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(uiDir, `${name}-1280-${mode}.png`) });
  }
}

let harness: BrowserHarness | undefined;

test.beforeAll(async () => {
  harness = await createHarness();
});

test.afterAll(async () => {
  await harness?.close();
  harness = undefined;
});

test("drives the release-critical browser flows offline", async ({ page }) => {
  const current = harness;

  if (current === undefined) {
    throw new Error("the browser harness did not start");
  }

  const screenshotPath = path.resolve("test-results/ui/porkbot-browser.png");
  await mkdir(path.dirname(screenshotPath), { recursive: true });

  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());

    if (url.protocol === "data:" || url.protocol === "blob:") {
      await route.continue();
      return;
    }

    if (url.protocol === "http:" && url.hostname === "127.0.0.1") {
      await route.continue();
      return;
    }

    await route.abort();
  });

  try {
    await page.goto(`${current.origin}/sign-up`);
    await expect(page.getByRole("heading", { name: "Create account" })).toBeVisible();
    await page.getByLabel("Name", { exact: true }).fill("Browser Owner");
    await page.getByLabel("Email", { exact: true }).fill(ownerEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Bots" })).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.getByLabel("Email", { exact: true }).fill(ownerEmail);
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Bots" })).toBeVisible();

    // The empty roster (slice 13.6): the home a fresh operator lands on,
    // before the first teammate exists.
    await captureRoster(page, current.origin, "roster-empty");

    const repositories = await current.bindActor(page);

    await page.goto(`${current.origin}/bots/new`);
    await page.getByLabel("Name", { exact: true }).fill("Offline Helper");
    await page.getByLabel("Title", { exact: true }).fill("Release fixture");
    await page.getByLabel("Description", { exact: true }).fill("A deterministic browser bot");
    await page
      .getByLabel("What should this bot do?", { exact: true })
      .fill("Answer using only the offline fixture.");
    await page.getByRole("button", { name: "Create bot" }).click();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/edit$/);
    const botId = botIdFromUrl(page.url());

    await current.attachComputer(botId);
    await current.seedMemory(botId);

    await page.goto(`${current.origin}/bots/${botId}/memory`);
    const memoryCard = page.locator("[data-memory-document]").first();
    await expect(memoryCard.getByRole("heading", { name: "Release note" })).toBeVisible();
    await memoryCard.getByRole("button", { name: "Edit" }).click();
    const memoryForm = memoryCard.locator("[data-memory-form]");
    await memoryForm.getByLabel("Title", { exact: true }).fill("Release note updated");
    await memoryForm.locator("textarea").fill("The browser fixture still starts offline.");
    await memoryForm.locator("input").nth(1).fill("Verify memory editing");
    await memoryForm.getByRole("button", { name: "Save" }).click();
    await expect(memoryCard.getByRole("heading", { name: "Release note updated" })).toBeVisible();

    // The memory captures (slice 13.12): the card with its revision timeline
    // open, then the Removed scope where the tombstone is marked, then the
    // restore that puts the fixture back.
    await captureMemory(page, "memory-history", { history: true });

    await memoryCard.getByRole("button", { name: "Remove" }).click();
    await memoryCard.locator("[data-memory-form]").locator("input").fill("Release done");
    await memoryCard.getByRole("button", { name: "Remove document" }).click();
    await expect(page.getByText("Nothing remembered yet")).toBeVisible();
    await page.getByRole("radio", { name: "Removed" }).click();
    await expect(page.locator("[data-removed]")).toBeVisible();
    await captureMemory(page, "memory-removed");

    await page
      .locator("[data-removed]")
      .getByRole("button", { name: "Restore", exact: true })
      .click();
    await page
      .locator("[data-removed]")
      .locator("[data-memory-form]")
      .getByRole("button", { name: "Restore revision" })
      .click();
    await expect(page.getByText("Nothing removed")).toBeVisible();
    await page.getByRole("radio", { name: "Current" }).click();
    await expect(memoryCard.getByRole("heading", { name: "Release note updated" })).toBeVisible();

    const routine = await rpc<{ readonly botId: string }>(page, "routines/create", {
      botId,
      instruction: "Check the offline queue",
      cron: "0 * * * *",
      timezone: "UTC",
    });
    expect(routine.botId).toBe(botId);

    // The settings panel mounts all six sections at once, so the connections
    // section is the scope for the flow that follows.
    await page.goto(`${current.origin}/settings`);
    const models = page.locator("#models");
    await models.getByRole("button", { name: "New connection" }).click();
    await models.getByLabel("Label", { exact: true }).fill("Offline model");
    await models.getByLabel("Base URL", { exact: true }).fill(current.model.baseUrl);
    await models.getByLabel("Credential name", { exact: true }).fill("offline-model-emulator");
    await models.getByLabel("API key", { exact: true }).fill("offline");
    await models.getByLabel("Default model (optional)", { exact: true }).fill("porkbot-e2e");
    await models.getByRole("button", { name: "Connect" }).click();
    const modelConnection = models
      .locator("[data-connection-row]")
      .filter({ hasText: "Offline model" });
    await expect(modelConnection).toBeVisible();
    await modelConnection.getByRole("button", { name: "Test" }).click();
    await expect(modelConnection.getByText(/Reachable · 1 model · streaming/)).toBeVisible();

    await page.goto(`${current.origin}/bots/${botId}/computer`);
    // The surface states the machine's state as a state: gone until the first
    // start, and the frame says plainly where no live view exists.
    await expect(page.locator("[data-computer-view-state]")).toHaveText("Gone");
    await page.getByRole("button", { name: /machine actions/ }).click();
    await page
      .getByRole("menuitem", { name: "Start — bring the machine up" })
      .evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator("[data-computer-view-state]")).toHaveText("Running");
    await expect(page.getByText("No live view", { exact: false })).toBeVisible();

    await captureComputer(page);

    await page.getByRole("tab", { name: "Terminal" }).click();
    await page.getByLabel("Command", { exact: true }).fill("echo offline");
    await page.getByRole("button", { name: "Run", exact: true }).click();
    await expect(page.getByText("$ echo offline", { exact: true })).toBeVisible();
    await expect(page.locator("[data-terminal-stdout]")).toHaveText("offline");

    await page.goto(current.origin);
    const helper = page.locator("[data-roster-card]").filter({ hasText: "Offline Helper" });

    await helper.getByRole("button", { name: "Actions for Offline Helper" }).click();
    await page.getByRole("menuitem", { name: "New thread" }).click();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/threads\/[^/]+$/);
    const threadId = threadIdFromUrl(page.url());
    await page.getByLabel("Message", { exact: true }).fill("Start offline task");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Start offline task", { exact: true })).toBeVisible();

    const run = await current.startRun(threadId);
    // The run exists, so the usage ledger can be seeded with the shape a week
    // of calls leaves before the usage captures at the end of the flow.
    await current.seedUsage(botId);

    // The card names the same tool as the timeline entry, so the assertion is
    // scoped to the entry rather than the plain word.
    await expect(page.locator("[data-tool-call-name]", { hasText: "shell" })).toBeVisible();
    await expect(page.getByText(/Waiting for approval: shell/)).toBeVisible();

    // The inline approval card (slice 13.9): the action, what it touches, the
    // consequence, the live deadline and two buttons. The run also carries a
    // gate that already timed out, so one capture holds both states and the
    // resolved capture proves the first card answered.
    const pendingCard = page.locator("[data-approval-state='pending']");
    const timedOutCard = page.locator("[data-approval-state='timed_out']");

    await expect(pendingCard).toHaveCount(1);
    await expect(pendingCard.locator("[data-approval-title]")).toHaveText("Approval needed");
    await expect(pendingCard.locator("[data-approval-consequence]")).toHaveText(
      "Run echo offline on the bot's computer.",
    );
    await expect(pendingCard.locator("[data-approval-target]")).toHaveText("echo offline");
    await expect(pendingCard.locator("time")).toHaveText(/left$/);
    await expect(timedOutCard).toHaveCount(1);
    await expect(timedOutCard.locator("[data-approval-title]")).toHaveText("Timed out");
    await expect(timedOutCard.locator("[data-approval-decision]")).toHaveText(
      "The deadline passed, so the run was denied.",
    );
    await captureApprovalState(page, "approval-pending", { narrow: true });

    await page.goto(`${current.origin}/approvals`);
    await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
    await expect(page.locator("#approvals-waiting")).toBeVisible();
    await expect(page.locator("#approvals-history")).toBeVisible();
    await expect(page.locator("[data-approval-state='pending']")).toHaveCount(1);
    await expect(page.locator("[data-approval-state='timed_out']")).toHaveCount(1);
    await captureApprovalState(page, "approvals-queue");

    await page
      .locator("[data-approval-state='pending']")
      .getByRole("button", { name: "Approve" })
      .click();
    await expect(page.locator("[data-approval-state='approved']")).toHaveCount(1);
    await expect(page.locator("#approvals-waiting")).toHaveCount(0);
    await captureApprovalState(page, "approvals-history");

    await page.goto(`${current.origin}/bots/${botId}/threads/${threadId}`);
    await page.getByLabel("Message", { exact: true }).fill("Steer this run");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Steer this run", { exact: true })).toBeVisible();
    await run.continueAfterApproval();

    // A streaming run: the tokens have landed and the run is still live, so
    // the capture shows the bubbles, the attribution and the stop control.
    // The approval card has resolved in place rather than folding away.
    await expect(page.getByText(/offline assistant response/)).toBeVisible();
    await expect(page.locator("[data-approval-state='approved']")).toHaveCount(1);
    await expect(page.locator("[data-approval-state='timed_out']")).toHaveCount(1);
    await captureApprovalState(page, "approval-resolved");
    await captureConsoleState(page, "conversation-streaming");

    await rpc(page, "runs/stop", { runId: run.runId });
    await run.cancel();
    await expect(page.getByText(/offline assistant response/)).toBeVisible();

    await page.reload();
    await expect(page.getByText(/offline assistant response/)).toBeVisible();
    await expect(page.locator("[data-tool-call-name]", { hasText: "shell" })).toBeVisible();
    expect(await repositories.routines.listForBot(botId)).toHaveLength(1);

    // An attachment: staged, uploaded and sent, then read back as the card in
    // the operator's bubble.
    await page
      .locator("[data-composer] input[type='file']")
      .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("offline") });
    await expect(page.locator("[data-composer-file]")).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill("Here is the note");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("a.message-attachment")).toBeVisible();
    await captureConsoleState(page, "conversation-attachment");

    // An upload failure: the route refuses, and the row says so while the
    // draft stands.
    await page.route("**/threads/*/attachments**", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "offline" }),
      });
    });
    await page
      .locator("[data-composer] input[type='file']")
      .setInputFiles({ name: "lost.txt", mimeType: "text/plain", buffer: Buffer.from("offline") });
    await expect(page.locator("[data-composer-file][data-status='failed']")).toBeVisible();
    await captureConsoleState(page, "conversation-upload-failed");
    await page.unroute("**/threads/*/attachments**");
    await page.getByRole("button", { name: "Remove lost.txt" }).click();

    // The run surface (slice 13.8): the live strip while a run works, and the
    // report card a settled run closes with. The queued run the attachment's
    // send started is the one driven here, so the capture is of the real
    // console against the real API rather than a staged transcript.
    const completing = await current.startRun(threadId, { stop: "working" });

    await expect(page.locator("[data-live-strip-step]")).toHaveText("Running shell…");
    await captureConsoleState(page, "run-surface-running");

    await completing.complete();
    await expect(page.locator("[data-run-card-title]").last()).toHaveText("Run finished");
    await captureConsoleState(page, "run-surface-completed");

    // A failed run closes with its own card: the failure line where the ✓
    // lines would be, in the run's own words.
    await page.getByLabel("Message", { exact: true }).fill("Fail the offline task");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Fail the offline task", { exact: true })).toBeVisible();
    const failing = await current.startRun(threadId, { stop: "working" });

    await expect(page.locator("[data-live-strip-step]")).toHaveText("Running shell…");
    await failing.fail();
    await expect(page.locator("[data-run-card-title]").last()).toHaveText("Run failed");
    await captureConsoleState(page, "run-surface-failed");

    await captureWorkspace(page, current.origin, botId, threadId);

    // The usage captures (slice 13.12): one bot's report and the settings
    // report over every bot, after the run that produced the ledger exists.
    await captureUsage(page, current.origin, botId);

    // The settings panel with something in every section it can seed offline:
    // a stored secret and a notification switch over the API, beside the
    // connection, the bots and the usage the flow already produced. MCP stays
    // empty because its install needs a reachable HTTPS server, which the
    // offline fixture does not have; the section says so.
    await rpc(page, "botSecrets/put", {
      botId,
      name: "api_token",
      value: "fixture-value",
      origin: "https://api.example.invalid",
      auth: { type: "bearer" },
    });
    await rpc(page, "notifications/setPreference", { kind: "run.failed", enabled: true });
    await captureSettings(page, current.origin);

    // The roster captures need more than one teammate, and a bot in the
    // archived group: both are seeded over the API because the capture is
    // about how the rows render, not how a bot is created.
    await rpc(page, "bots/create", {
      name: "Ledger",
      title: "Bookkeeping",
      color: "#2563eb",
      spawnKey: randomUUID(),
    });
    await rpc(page, "bots/create", {
      name: "Scout",
      title: "Reading a page",
      color: "#16a34a",
      spawnKey: randomUUID(),
    });
    const retired = await rpc<{ readonly id: string }>(page, "bots/create", {
      name: "Piper",
      title: "Errands",
      color: "#d946ef",
      spawnKey: randomUUID(),
    });

    await rpc(page, "bots/archive", { id: retired.id });

    // Pin one teammate through the row's own menu, so the pinned group is
    // exercised rather than staged before the captures.
    await page.goto(current.origin);

    const ledger = page.locator("[data-roster-card]").filter({ hasText: "Ledger" });

    await ledger.getByRole("button", { name: "Actions for Ledger" }).click();
    await page.getByRole("menuitem", { name: "Pin" }).click();
    await expect(page.getByRole("heading", { name: "Pinned" })).toBeVisible();

    await captureRoster(page, current.origin, "roster-home", {
      modes: ["dark", "light"],
      narrow: true,
    });
    await captureRoster(page, current.origin, "roster-archived", { archived: true });
  } finally {
    if (!page.isClosed()) {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  }
});
