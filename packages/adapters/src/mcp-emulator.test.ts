import { describe, expect, it } from "vitest";
import { McpServerEmulator } from "./mcp-emulator.ts";
import { mcpServerConformance } from "./mcp-conformance.ts";

/**
 * The offline MCP server emulator, held to the conformance suite every
 * `McpServerProvider` implementation passes. The emulator is scripted, so its
 * own tests also pin the parts the conformance suite assumes: a persistent
 * failure is per URL, a one-shot failure is consumed by the next request, and
 * servers, answers and requests can be cleared between tests.
 */

const tools = [
  {
    name: "echo",
    description: "Echo the text back.",
    parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  {
    name: "explode",
    description: "Fail on purpose.",
    parameters: { type: "object" },
  },
  {
    name: "list_issues",
    description: "List the issues.",
    parameters: { type: "object" },
  },
] as const;

function scripted(): McpServerEmulator {
  return new McpServerEmulator()
    .serve({ url: "https://mcp.example.invalid/mcp", tools })
    .serveFailure("https://rate.example.invalid/mcp", { kind: "rate_limited" })
    .serveFailure("https://forbidden.example.invalid/mcp", { kind: "auth_failed" })
    .serve({ url: "https://private.example.invalid/mcp", tools, accessToken: "conformance-token" })
    .answerTool("echo", { content: "echo: hi" })
    .answerTool("explode", { content: "boom", isError: true });
}

mcpServerConformance("the emulator", async () => ({
  provider: scripted(),
  serverUrl: "https://mcp.example.invalid/mcp",
  missingUrl: "https://missing.example.invalid/mcp",
  rateLimitedUrl: "https://rate.example.invalid/mcp",
  forbiddenUrl: "https://forbidden.example.invalid/mcp",
  authRequiredUrl: "https://private.example.invalid/mcp",
  accessToken: "conformance-token",
  expectedTools: tools,
  callTool: "echo",
  callArguments: { text: "hi" },
  callContent: "echo: hi",
  failingTool: "explode",
  clientId: "porkbot",
  redirectUri: "https://api.example.invalid/oauth/mcp/callback",
  state: "state-1",
  rejectedCode: "",
}));

describe("the MCP server emulator's own scripts", () => {
  it("requires a served URL for every method", async () => {
    const emulator = scripted();

    await expect(
      emulator.discover({ url: "https://missing.example.invalid/mcp" }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      emulator.call({
        url: "https://missing.example.invalid/mcp",
        tool: "echo",
        arguments: {},
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      emulator.authorizationUrl({
        url: "https://missing.example.invalid/mcp",
        clientId: "porkbot",
        redirectUri: "https://api.example.invalid/callback",
        state: "state-1",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
    await expect(
      emulator.exchangeCode({
        url: "https://missing.example.invalid/mcp",
        clientId: "porkbot",
        code: "code-1",
        redirectUri: "https://api.example.invalid/callback",
      }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });

  it("consumes an injected failure exactly once", async () => {
    const emulator = scripted().failNext({ kind: "timed_out", detail: "one shot" });

    await expect(
      emulator.discover({ url: "https://mcp.example.invalid/mcp" }),
    ).rejects.toMatchObject({ kind: "timed_out", detail: "one shot" });
    await expect(
      emulator.discover({ url: "https://mcp.example.invalid/mcp" }),
    ).resolves.toMatchObject({ serverName: "emulated-server" });
  });

  it("records what the caller sent, in order", async () => {
    const emulator = scripted();

    await emulator.call({
      url: "https://mcp.example.invalid/mcp",
      tool: "echo",
      arguments: { text: "one" },
    });
    await emulator.call({
      url: "https://mcp.example.invalid/mcp",
      tool: "echo",
      arguments: { text: "two" },
    });

    expect(emulator.calls.map((call) => call.arguments)).toEqual([
      { text: "one" },
      { text: "two" },
    ]);
    expect(emulator.lastCall()?.arguments).toEqual({ text: "two" });
  });

  it("forgets servers, scripts and requests when cleared", async () => {
    const emulator = scripted();

    await emulator.discover({ url: "https://mcp.example.invalid/mcp" });
    emulator.clear();

    expect(emulator.discoveries).toEqual([]);
    await expect(
      emulator.discover({ url: "https://mcp.example.invalid/mcp" }),
    ).rejects.toMatchObject({ kind: "not_found" });
  });
});
