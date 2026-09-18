import { Effect, Fiber, TestClock, TestContext } from "effect";
import { parseEgressAllowlist } from "@porkbot/core";
import type { ProviderFailure, WebAccessProvider } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import type { ApprovalRecord, ApprovalStore } from "./approval-gate.ts";
import type { ToolCall } from "./tool-dispatcher.ts";
import {
  createWebTools,
  MAX_WEB_BYTES,
  MAX_WEB_QUERY_LENGTH,
  MAX_WEB_URL_LENGTH,
  WEB_TOOL_NAMES,
} from "./web-tools.ts";

/**
 * The web tools in behaviour: an allowlisted fetch proceeds and returns a
 * labelled result, a destination outside the list waits on the durable gate
 * and turns a denial, a timeout or a bad URL into a model-readable refusal,
 * search returns labelled results without gating the operator's own search
 * service, and a provider refusal keeps its shared classification.
 *
 * The provider here is a scripted `WebAccessProvider` (the real emulator lives
 * in `@porkbot/adapters`, which this package's module map does not import), and
 * the store is in memory with Effect's `TestClock`, so no test needs a network,
 * a key or a wall clock.
 */

const runId = "run-1";
const callId = "call-1";
const approvalTimeoutMs = 30_000;
const pollIntervalMs = 1_000;

interface ScriptedProvider extends WebAccessProvider {
  readonly fetches: { url: string; maxBytes: number | undefined }[];
  readonly searches: { query: string; limit: number | undefined }[];
  result: { url: string; status: number; contentType: string; body: string } | undefined;
  searchResults: { title: string; url: string; snippet: string }[];
  refusal: ProviderFailure | undefined;
}

function scriptedProvider(): ScriptedProvider {
  const provider: ScriptedProvider = {
    fetches: [],
    searches: [],
    result: {
      url: "",
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: "The page body.",
    },
    searchResults: [{ title: "A result", url: "https://example.com/a", snippet: "The snippet." }],
    refusal: undefined,
    async fetch(request) {
      provider.fetches.push({ url: request.url, maxBytes: request.maxBytes });

      if (provider.refusal !== undefined) {
        throw provider.refusal;
      }

      const result = provider.result as NonNullable<ScriptedProvider["result"]>;

      return { ...result, url: result.url === "" ? request.url : result.url };
    },
    async search(request) {
      provider.searches.push({ query: request.query, limit: request.limit });

      if (provider.refusal !== undefined) {
        throw provider.refusal;
      }

      return provider.searchResults;
    },
  };

  return provider;
}

interface MemoryApprovals {
  readonly store: ApprovalStore;
  readonly rows: Map<string, ApprovalRecord>;
}

function memoryApprovals(): MemoryApprovals {
  const rows = new Map<string, ApprovalRecord>();

  return {
    rows,
    store: {
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
          status: "pending",
          expiresAt: request.expiresAt,
          decidedBy: null,
          decidedAt: null,
          reason: null,
        };
        rows.set(request.callId, record);
        return record;
      },
      async find(_runId, id) {
        return rows.get(id);
      },
      async resolveTimeout(_runId, id) {
        const existing = rows.get(id);

        if (existing === undefined) {
          throw new Error("no row");
        }

        const timedOut: ApprovalRecord = {
          ...existing,
          status: "timed_out",
          decidedAt: new Date(0),
        };
        rows.set(id, timedOut);
        return timedOut;
      },
    },
  };
}

function decidedRow(status: "approved" | "denied", reason: string | null = null): ApprovalRecord {
  return {
    id: "approval-seeded",
    runId,
    callId,
    tool: WEB_TOOL_NAMES.fetch,
    status,
    expiresAt: new Date(approvalTimeoutMs),
    decidedBy: "operator-1",
    decidedAt: new Date(0),
    reason,
  };
}

function call(arguments_: unknown, tool: string = WEB_TOOL_NAMES.fetch): ToolCall {
  return { runId, callId, tool, arguments: arguments_ };
}

function tools(provider: WebAccessProvider, approvals: MemoryApprovals, hosts: readonly string[]) {
  return createWebTools({
    provider,
    allowlist: parseEgressAllowlist(hosts),
    approvals: approvals.store,
    approvalTimeoutMs,
    approvalPollIntervalMs: pollIntervalMs,
  });
}

function registration<A>(registrations: readonly A[], name: string): A {
  const found = registrations.find(
    (registration_) => (registration_ as { name: string }).name === name,
  );

  if (found === undefined) {
    throw new Error(`no registration named ${name}`);
  }

  return found;
}

function run<A, E>(effect: Effect.Effect<A, E, never>): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(TestContext.TestContext)));
}

async function outcome(effect: Effect.Effect<unknown, unknown>): Promise<unknown> {
  return run(effect);
}

describe("web_fetch", () => {
  it("fetches an allowlisted page and returns it labelled untrusted", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    const fetchTool = registration(
      tools(provider, approvals, ["example.com"]),
      WEB_TOOL_NAMES.fetch,
    );

    const result = await outcome(fetchTool.execute(call({ url: "https://example.com/page" })));

    expect(result).toMatchObject({
      ok: true,
      status: 200,
      contentType: "text/html; charset=utf-8",
      content: {
        label: "untrusted",
        path: "web_fetch",
        origin: "https://example.com/page",
        content: "The page body.",
      },
    });
    expect(provider.fetches).toEqual([{ url: "https://example.com/page", maxBytes: undefined }]);
    expect(approvals.rows.size).toBe(0);
  });

  it("labels the page with the provider's final URL, not the URL the model asked for", async () => {
    const provider = scriptedProvider();
    provider.result = {
      url: "https://example.com/final",
      status: 200,
      contentType: "text/html",
      body: "The redirected page.",
    };
    const approvals = memoryApprovals();
    const fetchTool = registration(
      tools(provider, approvals, ["example.com"]),
      WEB_TOOL_NAMES.fetch,
    );

    const result = await outcome(fetchTool.execute(call({ url: "https://example.com/start" })));

    expect(result).toMatchObject({
      ok: true,
      content: { origin: "https://example.com/final" },
    });
  });

  it("caps the model's byte budget at the tool's ceiling", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    const fetchTool = registration(
      tools(provider, approvals, ["example.com"]),
      WEB_TOOL_NAMES.fetch,
    );

    await outcome(
      fetchTool.execute(call({ url: "https://example.com/page", max_bytes: MAX_WEB_BYTES * 100 })),
    );

    expect(provider.fetches[0]?.maxBytes).toBe(MAX_WEB_BYTES);
  });

  it("proceeds once an operator approved the destination", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    approvals.rows.set(callId, decidedRow("approved"));
    const fetchTool = registration(tools(provider, approvals, []), WEB_TOOL_NAMES.fetch);

    const result = await outcome(fetchTool.execute(call({ url: "https://other.test/page" })));

    expect(result).toMatchObject({ ok: true });
    expect(provider.fetches).toHaveLength(1);
  });

  it("refuses without calling the provider when the operator denied", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    approvals.rows.set(callId, decidedRow("denied", "not this host"));
    const fetchTool = registration(tools(provider, approvals, []), WEB_TOOL_NAMES.fetch);

    const result = await outcome(fetchTool.execute(call({ url: "https://other.test/page" })));

    expect(result).toMatchObject({
      ok: false,
      reason: "egress_denied",
      operatorReason: "not this host",
    });
    expect(provider.fetches).toEqual([]);
  });

  it("denies when the approval window closes with no decision", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    const fetchTool = registration(tools(provider, approvals, []), WEB_TOOL_NAMES.fetch);

    const result = await run(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          fetchTool.execute(call({ url: "https://other.test/page" })),
        );
        yield* Effect.yieldNow();
        yield* TestClock.adjust(approvalTimeoutMs + pollIntervalMs);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toMatchObject({ ok: false, reason: "egress_denied" });
    expect(provider.fetches).toEqual([]);
    expect(approvals.rows.get(callId)?.status).toBe("timed_out");
  });

  it("refuses a URL that cannot be attributed, without opening a gate", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    const fetchTool = registration(
      tools(provider, approvals, ["example.com"]),
      WEB_TOOL_NAMES.fetch,
    );

    const result = await outcome(fetchTool.execute(call({ url: "not a url" })));

    expect(result).toMatchObject({ ok: false, reason: "invalid_url" });
    expect(approvals.rows.size).toBe(0);
    expect(provider.fetches).toEqual([]);
  });

  it("reports invalid arguments to the model", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    const fetchTool = registration(
      tools(provider, approvals, ["example.com"]),
      WEB_TOOL_NAMES.fetch,
    );

    const rejected: readonly unknown[] = [
      undefined,
      {},
      { url: "" },
      { url: "  " },
      { url: 7 },
      { url: `https://example.com/${"a".repeat(MAX_WEB_URL_LENGTH)}` },
      { url: "https://example.com", max_bytes: "lots" },
      { url: "https://example.com", max_bytes: 0 },
    ];

    for (const arguments_ of rejected) {
      const result = await outcome(fetchTool.execute(call(arguments_)));

      expect(result).toMatchObject({ ok: false, reason: "invalid_arguments" });
    }

    expect(provider.fetches).toEqual([]);
  });

  it("keeps a provider refusal classified for the dispatcher", async () => {
    const provider = scriptedProvider();
    provider.refusal = Object.assign(new Error("missing"), {
      kind: "not_found" as const,
      detail: "the destination does not exist",
    });
    const approvals = memoryApprovals();
    const fetchTool = registration(
      tools(provider, approvals, ["example.com"]),
      WEB_TOOL_NAMES.fetch,
    );

    const exit = await run(
      fetchTool.execute(call({ url: "https://example.com/missing" })).pipe(Effect.either),
    );

    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect((exit.left as { kind?: unknown }).kind).toBe("not_found");
    }
  });
});

describe("web_search", () => {
  it("returns labelled results and asks for the clamped limit", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    const searchTool = registration(tools(provider, approvals, []), WEB_TOOL_NAMES.search);

    const result = await outcome(
      searchTool.execute(call({ query: "porkbot", limit: 100 }, WEB_TOOL_NAMES.search)),
    );

    expect(result).toMatchObject({
      ok: true,
      results: [
        {
          url: "https://example.com/a",
          content: {
            label: "untrusted",
            path: "web_fetch",
            origin: "https://example.com/a",
            content: "A result\n\nThe snippet.",
          },
        },
      ],
    });
    expect(provider.searches).toEqual([{ query: "porkbot", limit: 20 }]);
    expect(approvals.rows.size).toBe(0);
  });

  it("reports invalid arguments to the model", async () => {
    const provider = scriptedProvider();
    const approvals = memoryApprovals();
    const searchTool = registration(tools(provider, approvals, []), WEB_TOOL_NAMES.search);

    const rejected: readonly unknown[] = [
      undefined,
      {},
      { query: "" },
      { query: "  " },
      { query: 7 },
      { query: "q".repeat(MAX_WEB_QUERY_LENGTH + 1) },
      { query: "ok", limit: 1.5 },
      { query: "ok", limit: 0 },
    ];

    for (const arguments_ of rejected) {
      const result = await outcome(searchTool.execute(call(arguments_, WEB_TOOL_NAMES.search)));

      expect(result).toMatchObject({ ok: false, reason: "invalid_arguments" });
    }

    expect(provider.searches).toEqual([]);
  });

  it("keeps a provider refusal classified for the dispatcher", async () => {
    const provider = scriptedProvider();
    provider.refusal = Object.assign(new Error("busy"), {
      kind: "rate_limited" as const,
      detail: "the provider is refusing queries for now",
    });
    const approvals = memoryApprovals();
    const searchTool = registration(tools(provider, approvals, []), WEB_TOOL_NAMES.search);

    const exit = await run(
      searchTool.execute(call({ query: "porkbot" }, WEB_TOOL_NAMES.search)).pipe(Effect.either),
    );

    expect(exit._tag).toBe("Left");
    if (exit._tag === "Left") {
      expect((exit.left as { kind?: unknown }).kind).toBe("rate_limited");
    }
  });
});

describe("the tool registry", () => {
  it("refuses a non-positive duration", () => {
    expect(() =>
      createWebTools({
        provider: scriptedProvider(),
        allowlist: parseEgressAllowlist([]),
        approvals: memoryApprovals().store,
        maxDurationMs: 0,
      }),
    ).toThrow(RangeError);
  });
});
