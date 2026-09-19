import { randomUUID } from "node:crypto";
import { Effect } from "effect";
import { McpServerEmulator } from "@porkbot/adapters";
import { apiRole, createCredentialKeyring, createRepositories, workerRole } from "@porkbot/db";
import type { SystemRepositories, UserActor, UserRepositories } from "@porkbot/db";
import { createMcpTools } from "@porkbot/effect";
import { connectToSuite, createSuiteDatabase } from "@porkbot/testkit";
import type { SuiteClient, SuiteDatabase } from "@porkbot/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The MCP registry over the real database and the real roles (slice 9.5): the
 * operator installs and discovers through the `porkbot_api` grant, the job
 * reads the granted tools through the `porkbot_worker` grant, and the tool call
 * runs against the offline emulator. This is the chain the unit suites split
 * across fakes — install, discovery, persistence, grant, run-path read — closed
 * over Postgres, including the grants migration that gives the worker SELECT
 * only.
 */

const suiteName = "worker_mcp_registry";
const serverUrl = "https://mcp.example.invalid/mcp";

const tools = [
  {
    name: "list_issues",
    description: "List open issues.",
    parameters: { type: "object", properties: { limit: { type: "integer" } } },
  },
] as const;

const keyring = createCredentialKeyring({
  activeKeyId: "suite",
  keys: [{ id: "suite", key: Buffer.alloc(32, 0x21).toString("base64") }],
});

let suite: SuiteDatabase | undefined;
let administrator: SuiteClient | undefined;
let api: SuiteClient | undefined;
let worker: SuiteClient | undefined;

let spaceId = "";
let botId = "";
let owner: UserActor;

let apiRepositories: UserRepositories;
let workerRepositories: SystemRepositories;

beforeAll(async () => {
  suite = await createSuiteDatabase({ suite: suiteName });
  administrator = await connectToSuite(suite);
  api = await connectToSuite(suite, { role: apiRole });
  worker = await connectToSuite(suite, { role: workerRole });

  spaceId = await insertSpace("mcp registry");
  const userId = await insertUser();
  await insertMember(spaceId, userId);
  botId = await insertBot(spaceId, userId);
  owner = { kind: "user", spaceId, userId, role: "owner" };

  apiRepositories = createRepositories(owner, api, { credentialKeys: keyring });
  workerRepositories = createRepositories(
    { kind: "system", spaceId, jobId: "mcp-registry-suite" },
    worker,
    { credentialKeys: keyring },
  );
}, 180_000);

afterAll(async () => {
  await api?.end();
  await worker?.end();
  await administrator?.end();
  await suite?.destroy();
});

/** The install path's steps, run through the operator's real grants. */
async function installGrantedServer(
  emulator: McpServerEmulator,
  name: string,
): Promise<{ readonly serverId: string; readonly credentialName: string }> {
  const credentialName = `mcp:${name}`;
  const server = await apiRepositories.mcp.create({
    name,
    url: serverUrl,
    auth: "none",
    credentialName,
  });
  const description = await emulator.discover({ url: serverUrl });

  await apiRepositories.mcp.replaceTools(server.id, description.tools);
  await apiRepositories.mcp.setStatus(server.id, "ready", null);
  await apiRepositories.mcp.grant(botId, server.id);

  return { serverId: server.id, credentialName };
}

describe("the MCP registry across roles", () => {
  it("discovers, persists, grants and offers the tool to the run path", async () => {
    const emulator = new McpServerEmulator()
      .serve({ url: serverUrl, serverName: "issue-tracker", serverVersion: "2.0.0", tools })
      .answerTool("list_issues", { content: "issue #1: the printer is on fire" });
    const { serverId, credentialName } = await installGrantedServer(
      emulator,
      `install-${randomUUID()}`,
    );

    // The job's own role reads the granted server and its persisted tools.
    const granted = await workerRepositories.mcp.listGrantedForBot(botId);
    const installed = granted.find((entry) => entry.server.id === serverId);

    expect(installed?.tools).toEqual(tools);

    const registration = onlyRegistration(
      createMcpTools({
        provider: emulator,
        server: { id: serverId, name: installed?.server.name ?? "", url: serverUrl },
        tools: installed?.tools ?? [],
        readCredential: () => workerRepositories.credentials.resolve(credentialName),
        isGranted: () => workerRepositories.mcp.isGranted(botId, serverId),
      }),
    );

    const result = await Effect.runPromise(
      registration.execute({
        runId: "run-1",
        callId: "call-1",
        tool: registration.name,
        arguments: { limit: 5 },
      }),
    );

    expect(result).toMatchObject({
      ok: true,
      content: {
        label: "untrusted",
        path: "mcp_output",
        content: "issue #1: the printer is on fire",
      },
    });
  });

  it("revokes through the operator's grant and refuses the job's next call", async () => {
    const emulator = new McpServerEmulator()
      .serve({ url: serverUrl, serverName: "issue-tracker", serverVersion: "2.0.0", tools })
      .answerTool("list_issues", { content: "issue #1" });
    const { serverId } = await installGrantedServer(emulator, `revoke-${randomUUID()}`);

    const registration = onlyRegistration(
      createMcpTools({
        provider: emulator,
        server: { id: serverId, name: "issues", url: serverUrl },
        tools,
        readCredential: async () => undefined,
        isGranted: () => workerRepositories.mcp.isGranted(botId, serverId),
      }),
    );

    const call = {
      runId: "run-2",
      callId: "call-2",
      tool: registration.name,
      arguments: {},
    };

    await expect(Effect.runPromise(registration.execute(call))).resolves.toMatchObject({
      ok: true,
    });

    await apiRepositories.mcp.revoke(botId, serverId);

    expect(
      (await workerRepositories.mcp.listGrantedForBot(botId)).map((e) => e.server.id),
    ).not.toContain(serverId);
    const refused = await Effect.runPromise(
      registration.execute({ ...call, callId: "call-3" }),
    ).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    expect(refused?.message).toContain("not granted");
  });

  it("keeps the credential readable by the worker and writable only by the operator", async () => {
    const name = `credential-${randomUUID()}`;

    await apiRepositories.credentials.store(name, "access-token");

    await expect(workerRepositories.credentials.resolve(name)).resolves.toBe("access-token");

    // The worker's grant on the registry is SELECT only: a job cannot install,
    // grant or revoke, whatever interface it reaches for.
    await expect(
      worker?.query("insert into bot_mcp_server (space_id, bot_id, server_id) values ($1,$2,$3)", [
        spaceId,
        botId,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

function onlyRegistration(
  registrations: ReturnType<typeof createMcpTools>,
): ReturnType<typeof createMcpTools>[number] {
  const registration = registrations[0];

  if (registration === undefined) {
    throw new Error("expected one registration");
  }

  return registration;
}

function db(): SuiteClient {
  if (administrator === undefined) {
    throw new Error("the suite's client was not created; the beforeAll hook failed first");
  }

  return administrator;
}

async function insertSpace(name: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into space (name) values ($1) returning id::text as id",
    [name],
  );

  return required(rows[0]?.id);
}

async function insertUser(): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    'insert into "user" (name, email) values ($1, $2) returning id::text as id',
    ["MCP Suite", `${randomUUID()}@example.test`],
  );

  return required(rows[0]?.id);
}

async function insertMember(space: string, user: string): Promise<void> {
  await db().query(
    "insert into space_member (space_id, user_id, role) values ($1, $2, 'owner'::space_member_role)",
    [space, user],
  );
}

async function insertBot(space: string, user: string): Promise<string> {
  const { rows } = await db().query<{ id: string }>(
    "insert into bot (space_id, user_id, name, color, spawn_key) " +
      "values ($1, $2, 'Probe', '#4f46e5', $3) returning id::text as id",
    [space, user, randomUUID()],
  );

  return required(rows[0]?.id);
}

function required<Value>(value: Value | undefined): Value {
  if (value === undefined) {
    throw new Error("the fixture insert returned no id");
  }

  return value;
}
