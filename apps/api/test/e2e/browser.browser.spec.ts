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
  startRun(threadId: string): Promise<BrowserRun>;
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
    providers: async () => ({ defaultKind: "offline", kinds: ["offline"] }),
    validateProvider: async (kind: string) => ({
      kind,
      available: kind === "offline",
      failure: kind === "offline" ? null : ("not_found" as const),
    }),
  }) satisfies ComputerLifecycleProvider;
}

async function createHarness(): Promise<BrowserHarness> {
  const suite = await createSuiteDatabase({ suite: "api_browser" });
  const database = openDatabase(suite.connectionString);
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
    async startRun(threadId) {
      const actor = harness.actor;
      const repositories = harness.repositories;

      if (actor === undefined || repositories === undefined) {
        throw new Error("bindActor must run before starting a run");
      }

      let run: RunRow | undefined;

      for (let attempt = 0; attempt < 20 && run === undefined; attempt += 1) {
        const { rows } = await queryable(database).query<RunRow>(
          'select id, source_message_id as "sourceMessageId" from run where thread_id = $1 ' +
            "order by created_at desc, id desc limit 1",
          [threadId],
        );
        run = rows[0];

        if (run === undefined) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }

      if (run === undefined) {
        throw new Error("the browser send did not create a run");
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
      const claimed = await systemRepositories.runs.claim(run.id, 0, owner);

      if (claimed === undefined) {
        throw new Error("the browser run was not claimable");
      }

      const lease = { owner, fence: claimed.leaseFence };
      const callId = randomUUID();
      const assistantMessageId = randomUUID();
      const thread = await repositories.threads.findById(threadId);
      let sequence = thread.nextEventSeq;

      async function append(event: EventTemplate): Promise<void> {
        sequence += 1;
        await sink.append({ ...event, seq: sequence } as RunEvent);
        await realtime.publish({ threadId, latestSeq: sequence });
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
  await expect(page.locator(".roster-card, .empty-state").first()).toBeVisible();

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
      const pane = document.querySelector(".shell-pane");
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
          const pane = document.querySelector(".shell-pane");
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
 * The conversation's acceptance captures (slice 13.7): a run streaming, a
 * message with an attachment, and an upload failure on its row, each in both
 * modes. They land in `test-results/ui/` beside the shell's captures, which CI
 * uploads and the pull request links, and each state is exercised here rather
 * than only asserted, so the capture is of the real client against the real
 * API.
 */
async function captureConversationState(page: Page, name: string): Promise<void> {
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
    const memoryCard = page.locator(".memory-document").first();
    await expect(memoryCard.getByRole("heading", { name: "Release note" })).toBeVisible();
    await memoryCard.getByRole("button", { name: "Edit" }).click();
    const memoryForm = memoryCard.locator("form.memory-form");
    await memoryForm.getByLabel("Title", { exact: true }).fill("Release note updated");
    await memoryForm.locator("textarea").fill("The browser fixture still starts offline.");
    await memoryForm.locator("input").nth(1).fill("Verify memory editing");
    await memoryForm.getByRole("button", { name: "Save" }).click();
    await expect(memoryCard.getByRole("heading", { name: "Release note updated" })).toBeVisible();

    const routine = await rpc<{ readonly botId: string }>(page, "routines/create", {
      botId,
      instruction: "Check the offline queue",
      cron: "0 * * * *",
      timezone: "UTC",
    });
    expect(routine.botId).toBe(botId);

    await page.goto(`${current.origin}/settings/connections`);
    await page.getByRole("button", { name: "New connection" }).click();
    await page.getByLabel("Label", { exact: true }).fill("Offline model");
    await page.getByLabel("Base URL", { exact: true }).fill(current.model.baseUrl);
    await page.getByLabel("Credential name", { exact: true }).fill("offline-model-emulator");
    await page.getByLabel("API key", { exact: true }).fill("offline");
    await page.getByLabel("Default model (optional)", { exact: true }).fill("porkbot-e2e");
    await page.getByRole("button", { name: "Connect" }).click();
    const modelConnection = page.locator(".connection").filter({ hasText: "Offline model" });
    await expect(modelConnection).toBeVisible();
    await modelConnection.getByRole("button", { name: "Test" }).click();
    await expect(modelConnection.getByText(/Reachable · 1 model · streaming/)).toBeVisible();

    await page.goto(`${current.origin}/bots/${botId}/computer`);
    await expect(page.getByText(/The machine is gone/)).toBeVisible();
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByText("The machine is running.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Stop" }).click();
    await expect(page.getByText(/The machine is stopped/)).toBeVisible();
    await page.getByRole("button", { name: "Start" }).click();
    await expect(page.getByText("The machine is running.", { exact: true })).toBeVisible();
    await page.getByLabel("Command", { exact: true }).fill("echo offline");
    await page.getByRole("button", { name: "Run" }).click();
    await expect(page.getByText("$ echo offline", { exact: true })).toBeVisible();
    await expect(page.locator("pre.terminal-stdout")).toHaveText("offline");

    await page.goto(current.origin);
    const helper = page.locator(".roster-card").filter({ hasText: "Offline Helper" });

    await helper.getByRole("button", { name: "Actions for Offline Helper" }).click();
    await page.getByRole("menuitem", { name: "New thread" }).click();
    await expect(page).toHaveURL(/\/bots\/[^/]+\/threads\/[^/]+$/);
    const threadId = threadIdFromUrl(page.url());
    await page.getByLabel("Message", { exact: true }).fill("Start offline task");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Start offline task", { exact: true })).toBeVisible();

    const run = await current.startRun(threadId);
    await expect(page.getByText("shell", { exact: true })).toBeVisible();
    await expect(page.getByText(/Waiting for approval: shell/)).toBeVisible();

    await page.goto(`${current.origin}/approvals`);
    await expect(page.getByRole("heading", { name: "Approvals" })).toBeVisible();
    await expect(page.locator(".approval-status")).toHaveText("Pending");
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.locator(".approval-status")).toHaveText("Approved");

    await page.goto(`${current.origin}/bots/${botId}/threads/${threadId}`);
    await page.getByLabel("Message", { exact: true }).fill("Steer this run");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByText("Steer this run", { exact: true })).toBeVisible();
    await run.continueAfterApproval();

    // A streaming run: the tokens have landed and the run is still live, so
    // the capture shows the bubbles, the attribution and the stop control.
    await expect(page.getByText(/offline assistant response/)).toBeVisible();
    await captureConversationState(page, "conversation-streaming");

    await rpc(page, "runs/stop", { runId: run.runId });
    await run.cancel();
    await expect(page.getByText(/offline assistant response/)).toBeVisible();

    await page.reload();
    await expect(page.getByText(/offline assistant response/)).toBeVisible();
    await expect(page.getByText("shell", { exact: true })).toBeVisible();
    expect(await repositories.routines.listForBot(botId)).toHaveLength(1);

    // An attachment: staged, uploaded and sent, then read back as the card in
    // the operator's bubble.
    await page
      .locator(".composer input[type='file']")
      .setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("offline") });
    await expect(page.locator(".composer-file-ready")).toBeVisible();
    await page.getByLabel("Message", { exact: true }).fill("Here is the note");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.locator("a.message-attachment")).toBeVisible();
    await captureConversationState(page, "conversation-attachment");

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
      .locator(".composer input[type='file']")
      .setInputFiles({ name: "lost.txt", mimeType: "text/plain", buffer: Buffer.from("offline") });
    await expect(page.locator(".composer-file-failed")).toBeVisible();
    await captureConversationState(page, "conversation-upload-failed");
    await page.unroute("**/threads/*/attachments**");

    await captureWorkspace(page, current.origin, botId, threadId);

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

    const ledger = page.locator(".roster-card").filter({ hasText: "Ledger" });

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
