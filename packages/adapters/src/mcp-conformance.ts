import type { McpServerProvider, McpToolDescriptor, ProviderFailure } from "@porkbot/adapter-kit";
import { isProviderFailure } from "@porkbot/adapter-kit";

/**
 * The MCP server conformance suite (slice 9.5): one set of behaviors every
 * `McpServerProvider` implementation must show, run against the offline
 * emulator and against the HTTP provider over a wire emulator's loopback
 * server. An implementation that drifts from the seam — a discovery that drops
 * a tool schema, a missing server that arrives as a generic error, an unknown
 * tool that throws instead of answering `not_found`, a token exchange that
 * returns no token — fails here rather than in the install path that persists
 * the description.
 *
 * The test runner is imported inside the function, not at module scope: this
 * file is reachable from `@porkbot/adapters`' entry point, which the API and
 * the supervisor deploy, and a static `vitest` import would make a production
 * image require the test toolchain. `mcpServerConformance` is therefore async;
 * a test file calls it with top-level `await`.
 *
 * The suite calls no network and holds no real key: the HTTP side dials an
 * in-process server on loopback, which is why the same file can run both. A
 * harness supplies the URLs and scripts; the assertions are about the seam,
 * never about a vendor.
 */

export interface McpServerConformanceHarness {
  readonly provider: McpServerProvider;
  /** A served server with `expectedTools`. */
  readonly serverUrl: string;
  /** A URL no server is served at. */
  readonly missingUrl: string;
  /** A URL whose server answers as rate limited. */
  readonly rateLimitedUrl: string;
  /** A URL whose server refuses with an authorization failure. */
  readonly forbiddenUrl: string;
  /** A URL whose server requires `accessToken`. */
  readonly authRequiredUrl: string;
  /** The token `authRequiredUrl` accepts. */
  readonly accessToken: string;
  readonly expectedTools: readonly McpToolDescriptor[];
  /** The tool the scripted call runs. */
  readonly callTool: string;
  readonly callArguments: unknown;
  readonly callContent: string;
  /** A tool whose scripted answer carries `isError: true`. */
  readonly failingTool: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  /** An authorization code the token endpoint refuses. */
  readonly rejectedCode: string;
}

export type McpServerConformanceFactory = () => Promise<McpServerConformanceHarness>;

/** The classified failure a call produced, or a thrown assertion if it resolved. */
async function failureFrom(call: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await call;
  } catch (error) {
    if (!isProviderFailure(error)) {
      throw new Error(`expected a ProviderFailure, received ${String(error)}`, { cause: error });
    }

    return error;
  }

  throw new Error("expected the call to fail");
}

/** Registers the suite with the test runner, which is imported lazily so no production image loads it. */
export async function mcpServerConformance(
  name: string,
  create: McpServerConformanceFactory,
): Promise<void> {
  const { describe, expect, it } = await import("vitest");

  describe(`${name} MCP server conformance`, () => {
    it("discovers the server's identity and tool schemas unchanged", async () => {
      const harness = await create();

      const description = await harness.provider.discover({ url: harness.serverUrl });

      expect(description.serverName.trim()).not.toBe("");
      expect(description.serverVersion.trim()).not.toBe("");
      expect(description.tools).toEqual(harness.expectedTools);
    });

    it("reports a missing server as a classified not_found", async () => {
      const harness = await create();

      const failure = await failureFrom(harness.provider.discover({ url: harness.missingUrl }));

      expect(failure.kind).toBe("not_found");
      expect(failure.detail?.trim()).not.toBe("");
    });

    it("backs off a rate-limited server", async () => {
      const harness = await create();

      const failure = await failureFrom(harness.provider.discover({ url: harness.rateLimitedUrl }));

      expect(failure.kind).toBe("rate_limited");
    });

    it("asks for help when a server refuses the request", async () => {
      const harness = await create();

      const failure = await failureFrom(harness.provider.discover({ url: harness.forbiddenUrl }));

      expect(failure.kind).toBe("auth_failed");
    });

    it("requires the access token a server demands, and accepts it", async () => {
      const harness = await create();

      const refused = await failureFrom(
        harness.provider.discover({ url: harness.authRequiredUrl }),
      );
      expect(refused.kind).toBe("auth_failed");

      const description = await harness.provider.discover({
        url: harness.authRequiredUrl,
        accessToken: harness.accessToken,
      });
      expect(description.tools).toEqual(harness.expectedTools);
    });

    it("runs a tool with the model's arguments and returns its text", async () => {
      const harness = await create();

      const result = await harness.provider.call({
        url: harness.serverUrl,
        tool: harness.callTool,
        arguments: harness.callArguments,
      });

      expect(result.isError).toBe(false);
      expect(result.content).toBe(harness.callContent);
    });

    it("reports an unknown tool as not_found", async () => {
      const harness = await create();

      const failure = await failureFrom(
        harness.provider.call({
          url: harness.serverUrl,
          tool: "no-such-tool",
          arguments: {},
        }),
      );

      expect(failure.kind).toBe("not_found");
    });

    it("returns a tool's own domain error as a completed failed call", async () => {
      const harness = await create();

      const result = await harness.provider.call({
        url: harness.serverUrl,
        tool: harness.failingTool,
        arguments: {},
      });

      expect(result.isError).toBe(true);
    });

    it("builds an https authorization URL carrying the client, redirect and state", async () => {
      const harness = await create();

      const authorizationUrl = await harness.provider.authorizationUrl({
        url: harness.serverUrl,
        clientId: harness.clientId,
        redirectUri: harness.redirectUri,
        state: harness.state,
      });

      const url = new URL(authorizationUrl);
      expect(url.protocol).toBe("https:");
      expect(url.searchParams.get("client_id")).toBe(harness.clientId);
      expect(url.searchParams.get("redirect_uri")).toBe(harness.redirectUri);
      expect(url.searchParams.get("state")).toBe(harness.state);
    });

    it("exchanges an authorization code for a token", async () => {
      const harness = await create();

      const tokens = await harness.provider.exchangeCode({
        url: harness.serverUrl,
        clientId: harness.clientId,
        code: "conformance-code",
        redirectUri: harness.redirectUri,
      });

      expect(tokens.accessToken.trim()).not.toBe("");
      expect(tokens.tokenType.trim()).not.toBe("");
    });

    it("reports a refused code exchange as auth_failed", async () => {
      const harness = await create();

      const failure = await failureFrom(
        harness.provider.exchangeCode({
          url: harness.serverUrl,
          clientId: harness.clientId,
          code: harness.rejectedCode,
          redirectUri: harness.redirectUri,
        }),
      );

      expect(failure.kind).toBe("auth_failed");
    });
  });
}
