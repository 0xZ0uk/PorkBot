import { Effect } from "effect";
import type {
  McpCallRequest,
  McpCallResult,
  McpServerDescription,
  McpServerProvider,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import type { ApprovalRecord, ApprovalStore } from "./approval-gate.ts";
import { NotFoundError } from "./errors.ts";
import { parseMcpCredential, serializeMcpCredential } from "./mcp-credentials.ts";
import { createMcpTools, mcpToolName, McpGrantRevokedError } from "./mcp-tools.ts";
import type { ToolCall, ToolRegistration } from "./tool-dispatcher.ts";

/**
 * The MCP tool registrations (slice 9.5): what the model is offered, what a
 * call sends the server, and the two live questions every call re-asks. The
 * provider here is a recording seam, so the assertions are about the tool
 * layer — labelling, naming and the revoke check — never about a transport.
 */

const server = { id: "server-1", name: "Issue Tracker", url: "https://mcp.example.invalid/mcp" };

const tools = [
  {
    name: "list_issues",
    description: "List open issues.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer" } },
      additionalProperties: false,
    },
  },
] as const;

interface RecordingProvider {
  readonly provider: McpServerProvider;
  readonly calls: McpCallRequest[];
  failNext: Error | undefined;
}

function recordingProvider(): RecordingProvider {
  const calls: McpCallRequest[] = [];
  const state: RecordingProvider = {
    calls,
    failNext: undefined,
    provider: {
      async discover(): Promise<McpServerDescription> {
        return { serverName: "issue-tracker", serverVersion: "1.0.0", tools };
      },
      async call(request: McpCallRequest): Promise<McpCallResult> {
        if (state.failNext !== undefined) {
          const failure = state.failNext;
          state.failNext = undefined;
          throw failure;
        }

        calls.push({ ...request });
        return { content: "issue #1: the printer is on fire", isError: false };
      },
      async authorizationUrl(): Promise<string> {
        return "https://auth.example.invalid/authorize";
      },
      async exchangeCode() {
        return { accessToken: "token", tokenType: "Bearer" };
      },
    },
  };

  return state;
}

function onlyRegistration(tools: ReturnType<typeof createMcpTools>): ToolRegistration {
  const registration = tools[0];

  if (registration === undefined) {
    throw new Error("expected one registration");
  }

  return registration;
}

function call(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    runId: "run-1",
    callId: "call-1",
    tool: "mcp_issue_tracker_list_issues",
    arguments: { limit: 5 },
    ...overrides,
  };
}

describe("the model-facing MCP tool name", () => {
  it("slugs the server and the tool into one function name", () => {
    expect(mcpToolName("Issue Tracker", "list_issues")).toBe("mcp_issue_tracker_list_issues");
    expect(mcpToolName("Git/Her?b", "search.repos")).toBe("mcp_git_her_b_search_repos");
  });

  it("bounds the name and never leaves it empty", () => {
    const name = mcpToolName("a".repeat(200), "b".repeat(200));

    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^mcp_[a-z0-9_]+$/);
    expect(mcpToolName("...", "***")).toBe("mcp_server_tool");
  });
});

describe("the MCP tool registrations", () => {
  it("carry the server's schema and say the output is untrusted", () => {
    const provider = recordingProvider();
    const registration = onlyRegistration(
      createMcpTools({
        provider: provider.provider,
        server,
        tools,
        readCredential: async () => undefined,
        isGranted: async () => true,
      }),
    );

    expect(registration?.name).toBe("mcp_issue_tracker_list_issues");
    expect(registration?.parameters).toEqual(tools[0]?.parameters);
    expect(registration?.description).toContain("List open issues.");
    expect(registration?.description).toContain("untrusted external data");
  });

  it("sends the resolved access token and labels the result with its origin", async () => {
    const provider = recordingProvider();
    const registration = onlyRegistration(
      createMcpTools({
        provider: provider.provider,
        server,
        tools,
        readCredential: async () =>
          serializeMcpCredential({ accessToken: "secret-token", refreshToken: "refresh" }),
        isGranted: async () => true,
      }),
    );

    const result = (await Effect.runPromise(registration.execute(call()))) as {
      ok: boolean;
      isError: boolean;
      content: Record<string, unknown>;
    };

    expect(provider.calls).toEqual([
      {
        url: server.url,
        tool: "list_issues",
        arguments: { limit: 5 },
        accessToken: "secret-token",
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.content).toMatchObject({
      label: "untrusted",
      path: "mcp_output",
      origin: "mcp:Issue Tracker:list_issues",
      content: "issue #1: the printer is on fire",
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });

  it("stops the next call once the grant is revoked", async () => {
    const provider = recordingProvider();
    let granted = true;
    const registration = onlyRegistration(
      createMcpTools({
        provider: provider.provider,
        server,
        tools,
        readCredential: async () => undefined,
        isGranted: async () => granted,
      }),
    );

    await expect(Effect.runPromise(registration.execute(call()))).resolves.toMatchObject({
      ok: true,
    });

    // The revoke takes effect mid-lifecycle: the run was open, the grant is
    // gone, and the next call never reaches the server.
    granted = false;

    const failure = await Effect.runPromise(registration.execute(call({ callId: "call-2" }))).then(
      () => undefined,
      (error: unknown) => error as Error,
    );

    // Effect's `runPromise` wraps a failure in a FiberFailure; the classified
    // error is what the dispatcher reads out of the cause.
    expect(failure?.name).toContain(McpGrantRevokedError.name);
    expect(failure?.message).toContain("not granted");
    expect(provider.calls).toHaveLength(1);
  });

  it("keeps a provider failure in the shared vocabulary", async () => {
    const provider = recordingProvider();
    provider.failNext = new Error("boom");
    const registration = onlyRegistration(
      createMcpTools({
        provider: provider.provider,
        server,
        tools,
        readCredential: async () => undefined,
        isGranted: async () => true,
      }),
    );

    await expect(Effect.runPromise(registration.execute(call()))).rejects.toThrow("boom");
  });

  it("refuses non-object arguments without calling the server", async () => {
    const provider = recordingProvider();
    const registration = onlyRegistration(
      createMcpTools({
        provider: provider.provider,
        server,
        tools,
        readCredential: async () => undefined,
        isGranted: async () => true,
      }),
    );

    await expect(
      Effect.runPromise(registration.execute(call({ arguments: "not an object" }))),
    ).resolves.toMatchObject({ ok: false, reason: "invalid_arguments" });
    expect(provider.calls).toEqual([]);
  });
});

describe("the danger policy on MCP tools", () => {
  const sendTool = [
    {
      name: "send_email",
      description: "Send an email.",
      parameters: { type: "object", properties: { to: { type: "string" } } },
    },
  ] as const;

  const deleteTool = [
    {
      name: "delete_issue",
      description: "Delete an issue.",
      parameters: { type: "object", properties: { id: { type: "string" } } },
    },
  ] as const;

  function memoryApprovals() {
    const rows = new Map<string, ApprovalRecord>();

    const store: ApprovalStore = {
      async open(request) {
        const existing = rows.get(request.callId);

        if (existing !== undefined) {
          return existing;
        }

        const record: ApprovalRecord = {
          id: `approval-${rows.size + 1}`,
          runId: request.runId,
          callId: request.callId,
          tool: request.tool,
          arguments: request.arguments,
          status: "pending",
          expiresAt: request.expiresAt,
          decidedBy: null,
          decidedAt: null,
          reason: null,
        };
        rows.set(request.callId, record);
        return record;
      },
      async find(_runId, callId) {
        return rows.get(callId);
      },
      async resolveTimeout(_runId, callId) {
        const existing = rows.get(callId);

        if (existing === undefined) {
          throw new NotFoundError("approval", callId);
        }

        const timedOut: ApprovalRecord = {
          ...existing,
          status: "timed_out",
          decidedAt: new Date(0),
        };
        rows.set(callId, timedOut);
        return timedOut;
      },
    };

    return { store, rows };
  }

  function seedDenied(approvals: ReturnType<typeof memoryApprovals>): void {
    approvals.rows.set("call-1", {
      id: "approval-seeded",
      runId: "run-1",
      callId: "call-1",
      tool: "mcp_issue_tracker_send_email",
      arguments: {},
      status: "denied",
      expiresAt: new Date(60_000),
      decidedBy: "operator-1",
      decidedAt: new Date(0),
      reason: null,
    });
  }

  it("gates a declared send before the server is dialed", async () => {
    const provider = recordingProvider();
    const approvals = memoryApprovals();
    seedDenied(approvals);
    const registration = createMcpTools({
      provider: provider.provider,
      server,
      tools: sendTool,
      readCredential: async () => undefined,
      isGranted: async () => true,
      approvals: approvals.store,
    })[0];

    await expect(
      Effect.runPromise(
        registration?.execute(
          call({ tool: "mcp_issue_tracker_send_email", arguments: { to: "a@b" } }),
        ) ?? Effect.die("no registration"),
      ),
    ).resolves.toMatchObject({ ok: false, reason: "approval_denied", class: "send" });
    expect(provider.calls).toEqual([]);
  });

  it("gates a declared delete before the server is dialed", async () => {
    const provider = recordingProvider();
    const approvals = memoryApprovals();
    seedDenied(approvals);
    const registration = createMcpTools({
      provider: provider.provider,
      server,
      tools: deleteTool,
      readCredential: async () => undefined,
      isGranted: async () => true,
      approvals: approvals.store,
    })[0];

    await expect(
      Effect.runPromise(
        registration?.execute(
          call({ tool: "mcp_issue_tracker_delete_issue", arguments: { id: "1" } }),
        ) ?? Effect.die("no registration"),
      ),
    ).resolves.toMatchObject({ ok: false, reason: "approval_denied", class: "delete" });
    expect(provider.calls).toEqual([]);
  });

  it("refuses a budget that does not cover the approval window", () => {
    expect(() =>
      createMcpTools({
        provider: recordingProvider().provider,
        server,
        tools: sendTool,
        readCredential: async () => undefined,
        isGranted: async () => true,
        approvals: memoryApprovals().store,
        approvalTimeoutMs: 60_000,
        maxDurationMs: 30_000,
      }),
    ).toThrow(RangeError);
  });

  it("refuses a declared call with no gate to ask", async () => {
    const provider = recordingProvider();
    const registration = createMcpTools({
      provider: provider.provider,
      server,
      tools: sendTool,
      readCredential: async () => undefined,
      isGranted: async () => true,
    })[0];

    await expect(
      Effect.runPromise(
        registration?.execute(
          call({ tool: "mcp_issue_tracker_send_email", arguments: { to: "a@b" } }),
        ) ?? Effect.die("no registration"),
      ),
    ).resolves.toMatchObject({ ok: false, reason: "approval_unavailable", class: "send" });
    expect(provider.calls).toEqual([]);
  });

  it("leaves a read tool ungated even with a store configured", async () => {
    const provider = recordingProvider();
    const approvals = memoryApprovals();
    const registration = createMcpTools({
      provider: provider.provider,
      server,
      tools,
      readCredential: async () => undefined,
      isGranted: async () => true,
      approvals: approvals.store,
    })[0];

    await expect(
      Effect.runPromise(registration?.execute(call()) ?? Effect.die("no registration")),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(approvals.rows.size).toBe(0);
    expect(provider.calls).toHaveLength(1);
  });
});

describe("the MCP credential codec", () => {
  it("round-trips the fields a server needs", () => {
    expect(
      parseMcpCredential(
        serializeMcpCredential({
          clientId: "porkbot",
          clientSecret: "client-secret",
          accessToken: "access",
          refreshToken: "refresh",
          expiresAt: "2030-01-01T00:00:00.000Z",
        }),
      ),
    ).toEqual({
      clientId: "porkbot",
      clientSecret: "client-secret",
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
  });

  it("fails closed on junk, blank fields and non-objects", () => {
    expect(parseMcpCredential(undefined)).toEqual({});
    expect(parseMcpCredential("not json")).toEqual({});
    expect(parseMcpCredential('["access"]')).toEqual({});
    expect(parseMcpCredential('{"accessToken":"  ","token":"x"}')).toEqual({});
  });
});
