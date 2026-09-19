import { Effect } from "effect";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerFrame,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
} from "@porkbot/adapter-kit";
import { DEFAULT_APPROVAL_TIMEOUT_MS, parseEgressAllowlist } from "@porkbot/core";
import { describe, expect, it } from "vitest";
import type { ApprovalRecord, ApprovalStore } from "./approval-gate.ts";
import type { ArtifactRecorder } from "./artifact-recorder.ts";
import type { ComputerCommandRunner } from "./computer-commands.ts";
import { createComputerTools, MAX_COMPUTER_OUTPUT_BYTES } from "./computer-tools.ts";
import { NotFoundError } from "./errors.ts";
import { createToolDispatcher } from "./tool-dispatcher.ts";
import type {
  ToolCall,
  ToolCallAdmission,
  ToolCallLedger,
  ToolOutcome,
} from "./tool-dispatcher.ts";

/**
 * The computer tools (slice 6.9): five registrations over one `exec` door. The
 * tests drive them through a recording provider, so they pin the command each
 * tool sends — the contract the emulator and a real container both implement —
 * and the result each tool hands the model: the exit code, the streams, and
 * the label that keeps file bytes, shell output and page text data rather than
 * instructions.
 */

const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };

class RecordingProvider implements ComputerProvider {
  readonly requests: ComputerExecRequest[] = [];
  readonly results: ComputerExecResult[] = [];
  #next = 0;

  queue(result: Partial<ComputerExecResult>): this {
    this.results.push({ exitCode: 0, stdout: "", stderr: "", ...result });
    return this;
  }

  async validate(): Promise<void> {
    // Nothing to check in a test double.
  }

  async ensure(computer: ComputerRef): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async status(computer: ComputerRef): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async stop(computer: ComputerRef): Promise<ComputerStatus> {
    return { computer, state: "stopped" };
  }

  async list(): Promise<readonly ComputerStatus[]> {
    return [];
  }

  async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
    this.requests.push(request);
    const result = this.results[this.#next] ?? { exitCode: 0, stdout: "", stderr: "" };
    this.#next += 1;
    return result;
  }

  async snapshot(): Promise<ComputerSnapshot> {
    return { snapshotId: "snapshot-1", key: "snapshots/1", size: 1, checksum: "0".repeat(64) };
  }

  async restore(computer: ComputerRef): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async destroy(): Promise<void> {}

  frames(): AsyncIterable<ComputerFrame> {
    return {
      async *[Symbol.asyncIterator]() {},
    };
  }

  async input(): Promise<void> {}
}

/**
 * The tools under test speak through the runner seam, not a raw provider. This
 * passthrough is deliberately unfenced: the tests here pin the command each
 * tool composes and the label it returns, and the fence itself is the subject
 * of `computer-commands.test.ts`.
 */
function providerCommands(provider: ComputerProvider): ComputerCommandRunner {
  return {
    exec: (request) =>
      Effect.tryPromise({
        try: () =>
          provider.exec({
            computer: request.computer,
            command: request.command,
            timeoutMs: request.timeoutMs,
          }),
        catch: (error) => error,
      }),
  };
}

interface ToolOptions {
  readonly maxDurationMs?: number;
  readonly home?: string;
  readonly artifacts?: ArtifactRecorder;
  readonly approvals?: ApprovalStore;
  readonly allowlist?: readonly string[];
}

function toolsFor(provider: ComputerProvider, options: ToolOptions = {}) {
  const registrations = createComputerTools({
    commands: providerCommands(provider),
    computer,
    maxDurationMs:
      options.maxDurationMs ??
      (options.approvals === undefined ? 30_000 : DEFAULT_APPROVAL_TIMEOUT_MS + 30_000),
    ...(options.home === undefined ? {} : { home: options.home }),
    ...(options.artifacts === undefined ? {} : { artifacts: options.artifacts }),
    ...(options.approvals === undefined ? {} : { approvals: options.approvals }),
    ...(options.allowlist === undefined
      ? {}
      : { allowlist: parseEgressAllowlist(options.allowlist) }),
  });
  const byName = new Map(registrations.map((registration) => [registration.name, registration]));

  return {
    registrations,
    byName,
    run: (name: string, args: unknown) => {
      const registration = byName.get(name);

      if (registration === undefined) {
        throw new Error(`no registration named ${name}`);
      }

      const call: ToolCall = { runId: "run-1", callId: "call-1", tool: name, arguments: args };

      return Effect.runPromise(registration.execute(call));
    },
  };
}

/**
 * The run's durable gate in memory, enough for the tools' wiring: an opened
 * row carries the call and its arguments, and a seeded row is what an
 * operator's vote left behind. Tests seed a decision instead of waiting one
 * out, so no test needs a clock.
 */
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

/** Seeds the decision a call's gate will find, keyed by the call the tools use. */
function seedDecision(
  approvals: ReturnType<typeof memoryApprovals>,
  status: "approved" | "denied",
  reason: string | null = null,
): void {
  approvals.rows.set("call-1", {
    id: "approval-seeded",
    runId: "run-1",
    callId: "call-1",
    tool: "seeded",
    arguments: {},
    status,
    expiresAt: new Date(60_000),
    decidedBy: "operator-1",
    decidedAt: new Date(0),
    reason,
  });
}

function expectLabel(value: unknown): { content: string; origin: string; path: string } {
  const labelled = value as { content: string; label: string; origin: string; path: string };

  expect(labelled.label).toBe("untrusted");
  return labelled;
}

describe("the shell tool", () => {
  it("sends the command with the declared budget and labels its output", async () => {
    const provider = new RecordingProvider().queue({ stdout: "hello\n", exitCode: 0 });
    const tools = toolsFor(provider, { maxDurationMs: 12_345 });

    const result = await tools.run("shell", { command: "printf 'hello\\n'" });

    expect(provider.requests).toEqual([
      { computer, command: "printf 'hello\\n'", timeoutMs: 12_345 },
    ]);
    expect(result).toMatchObject({ ok: true, exitCode: 0, stderr: "" });
    expectLabel((result as { stdout: unknown }).stdout);
    expect((result as { stdout: { content: string } }).stdout.content).toBe("hello\n");
  });

  it("reports a non-zero exit as a completed call the model can read", async () => {
    const provider = new RecordingProvider().queue({ exitCode: 2, stderr: "bad flags" });
    const tools = toolsFor(provider);

    await expect(tools.run("shell", { command: "ls --nope" })).resolves.toMatchObject({
      ok: false,
      exitCode: 2,
      stderr: "bad flags",
    });
  });

  it("refuses a blank or oversized command without reaching the machine", async () => {
    const provider = new RecordingProvider();
    const tools = toolsFor(provider);

    await expect(tools.run("shell", { command: "  " })).resolves.toMatchObject({
      ok: false,
      reason: "invalid_arguments",
    });
    await expect(tools.run("shell", { command: "x".repeat(20_000) })).resolves.toMatchObject({
      ok: false,
      reason: "invalid_arguments",
    });
    expect(provider.requests).toEqual([]);
  });

  it("truncates output past the inline budget instead of carrying it whole", async () => {
    const provider = new RecordingProvider().queue({
      stdout: "x".repeat(MAX_COMPUTER_OUTPUT_BYTES + 100),
    });
    const tools = toolsFor(provider);

    const result = (await tools.run("shell", { command: "cat big" })) as {
      stdout: { content: string };
      stdoutTruncated?: boolean;
    };

    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.content).toContain("[truncated]");
    expect(new TextEncoder().encode(result.stdout.content).byteLength).toBeLessThanOrEqual(
      MAX_COMPUTER_OUTPUT_BYTES + " [truncated]".length,
    );
  });
});

describe("the file tools", () => {
  it("resolves a relative read against the home before it names a command", async () => {
    const provider = new RecordingProvider().queue({ stdout: "notes" });
    const tools = toolsFor(provider);

    const result = await tools.run("file_read", { path: "notes/todo.md" });

    expect(provider.requests[0]?.command).toBe("cat -- '/home/agent/notes/todo.md'");
    expect(result).toMatchObject({ ok: true, path: "notes/todo.md", bytes: 5 });
    const labelled = expectLabel((result as { content: unknown }).content);
    expect(labelled.path).toBe("file_read");
    expect(labelled.origin).toBe("home:/notes/todo.md");
  });

  it("accepts an absolute read inside the home and refuses one outside it", async () => {
    const provider = new RecordingProvider().queue({ stdout: "x" });
    const tools = toolsFor(provider);

    const result = (await tools.run("file_read", { path: "/home/agent/notes/todo.md" })) as {
      content: { origin: string };
    };

    expect(result.content.origin).toBe("home:/notes/todo.md");
    expect(provider.requests[0]?.command).toBe("cat -- '/home/agent/notes/todo.md'");

    const refused = await tools.run("file_read", { path: "/etc/hosts" });

    expect(refused).toMatchObject({ ok: false, reason: "outside_home" });
    expect(provider.requests).toHaveLength(1);
  });

  it("refuses a traversal that climbs out of the home without reaching the machine", async () => {
    const provider = new RecordingProvider();
    const tools = toolsFor(provider);

    for (const path of ["../etc/passwd", "notes/../../etc/passwd", "/home"]) {
      await expect(tools.run("file_read", { path })).resolves.toMatchObject({
        ok: false,
        reason: "outside_home",
      });
      await expect(tools.run("file_list", { path })).resolves.toMatchObject({
        ok: false,
        reason: "outside_home",
      });
      // A write outside the home is a dangerous action; with no gate to ask,
      // the answer is fail-closed rather than the plain confinement refusal.
      await expect(tools.run("file_write", { path, content: "x" })).resolves.toMatchObject({
        ok: false,
        reason: "approval_unavailable",
        class: "write_outside_home",
      });
    }

    expect(provider.requests).toEqual([]);
  });

  it("reports a missing file as not_found without throwing", async () => {
    const provider = new RecordingProvider().queue({
      exitCode: 1,
      stderr: "cat: nope: No such file or directory\n",
    });
    const tools = toolsFor(provider);

    await expect(tools.run("file_read", { path: "nope" })).resolves.toMatchObject({
      ok: false,
      reason: "not_found",
    });
  });

  it("writes base64 so no shell metacharacter in the content is interpreted", async () => {
    const provider = new RecordingProvider();
    const tools = toolsFor(provider);
    const content = "line one\n$(rm -rf /) && 'quoted' \"double\" `backtick`";

    const result = await tools.run("file_write", { path: "notes/x.txt", content });

    const command = provider.requests[0]?.command ?? "";
    expect(command.startsWith("mkdir -p '/home/agent/notes' && printf '%s' '")).toBe(true);
    expect(command).toContain("| base64 -d > '/home/agent/notes/x.txt'");

    const encoded = /printf '%s' '([^']*)' \| base64 -d/.exec(command)?.[1] ?? "";
    expect(Buffer.from(encoded, "base64").toString("utf8")).toBe(content);
    expect(result).toMatchObject({
      ok: true,
      path: "notes/x.txt",
      bytes: Buffer.byteLength(content, "utf8"),
    });
  });

  it("writes to a top-level path without inventing a parent", async () => {
    const provider = new RecordingProvider();
    const tools = toolsFor(provider);

    await tools.run("file_write", { path: "note.txt", content: "" });

    expect(provider.requests[0]?.command).not.toContain("mkdir -p");
    expect(provider.requests[0]?.command).toContain("> '/home/agent/note.txt'");
  });

  it("keeps a successful write as a downloadable artifact when a recorder is present", async () => {
    const provider = new RecordingProvider();
    const recorded: Array<{ callId: string; filename: string; contentType: string; text: string }> =
      [];
    const tools = toolsFor(provider, {
      artifacts: {
        record: (request) =>
          Effect.sync(() => {
            recorded.push({
              callId: request.callId,
              filename: request.filename,
              contentType: request.contentType,
              text: Buffer.from(request.bytes).toString("utf8"),
            });

            return {
              id: "artifact-1",
              filename: request.filename,
              contentType: request.contentType,
              sizeBytes: request.bytes.byteLength,
              downloadPath: "/files/artifact-1",
            };
          }),
      },
    });

    const result = await tools.run("file_write", { path: "reports/summary.md", content: "# Hi" });

    expect(recorded).toEqual([
      {
        callId: "call-1",
        filename: "summary.md",
        contentType: "text/markdown",
        text: "# Hi",
      },
    ]);
    expect(result).toMatchObject({
      ok: true,
      artifact: { id: "artifact-1", downloadPath: "/files/artifact-1", sizeBytes: 4 },
    });
  });

  it("reports only the path when no recorder is configured", async () => {
    const provider = new RecordingProvider();
    const tools = toolsFor(provider);

    const result = await tools.run("file_write", { path: "note.txt", content: "hi" });

    expect(result).not.toHaveProperty("artifact");
  });

  it("lists a directory, defaulting to the home directory, with a labelled listing", async () => {
    const provider = new RecordingProvider().queue({ stdout: "a.txt\nb.txt\n" });
    const tools = toolsFor(provider);

    const result = (await tools.run("file_list", {})) as {
      ok: boolean;
      path: string;
      names: readonly string[];
      listing: unknown;
    };

    expect(result).toMatchObject({ ok: true, path: ".", names: ["a.txt", "b.txt"] });
    const labelled = expectLabel(result.listing);
    expect(labelled.origin).toBe("home:/");
    expect(provider.requests[0]?.command).toBe("ls -- '/home/agent'");

    const provider2 = new RecordingProvider().queue({ stdout: "nested\n" });
    const tools2 = toolsFor(provider2);

    await expect(tools2.run("file_list", { path: "notes" })).resolves.toMatchObject({
      ok: true,
      path: "notes",
      names: ["nested"],
    });
    expect(provider2.requests[0]?.command).toBe("ls -- '/home/agent/notes'");
  });
});

describe("the browser tool", () => {
  it("sends the action as one JSON argument and labels the page text", async () => {
    const provider = new RecordingProvider().queue({
      stdout: JSON.stringify({
        ok: true,
        action: "open",
        url: "https://example.invalid/page",
        title: "Example",
        text: "body text",
      }),
    });
    const tools = toolsFor(provider, { allowlist: ["example.invalid"] });

    const result = await tools.run("browser", {
      action: "open",
      url: "https://example.invalid/page",
    });

    expect(provider.requests[0]?.command).toBe(
      `browser '{"action":"open","url":"https://example.invalid/page"}'`,
    );
    const labelled = expectLabel((result as { text: unknown }).text);
    expect(labelled.path).toBe("computer_output");
    expect(labelled.origin).toBe("https://example.invalid/page");
    expect(labelled.content).toContain("body text");
  });

  it("requires a url, a selector or text for the action that needs it", async () => {
    const provider = new RecordingProvider();
    const tools = toolsFor(provider);

    await expect(tools.run("browser", { action: "open" })).resolves.toMatchObject({
      ok: false,
      reason: "invalid_arguments",
    });
    await expect(tools.run("browser", { action: "click" })).resolves.toMatchObject({
      ok: false,
      reason: "invalid_arguments",
    });
    await expect(tools.run("browser", { action: "type", selector: "#a" })).resolves.toMatchObject({
      ok: false,
      reason: "invalid_arguments",
    });
    expect(provider.requests).toEqual([]);
  });

  it("turns a helper refusal into a completed result the model can recover from", async () => {
    const provider = new RecordingProvider().queue({
      exitCode: 1,
      stdout: JSON.stringify({ ok: false, error: 'no click action is scripted for "#missing"' }),
    });
    const tools = toolsFor(provider);

    await expect(tools.run("browser", { action: "click", selector: "#missing" })).resolves.toEqual({
      ok: false,
      reason: "browser_error",
      message: 'no click action is scripted for "#missing"',
    });
  });

  it("refuses a page record it cannot read rather than passing bytes through", async () => {
    const provider = new RecordingProvider().queue({ stdout: "not json" });
    const tools = toolsFor(provider);

    await expect(tools.run("browser", { action: "read" })).resolves.toMatchObject({
      ok: false,
      reason: "browser_error",
    });
  });
});

describe("the danger policy on the tools", () => {
  it("gates a credential-store read: denied never reaches the machine, approved reads it", async () => {
    const deniedProvider = new RecordingProvider();
    const deniedApprovals = memoryApprovals();
    seedDecision(deniedApprovals, "denied", "not the keys");

    const denied = await toolsFor(deniedProvider, { approvals: deniedApprovals.store }).run(
      "file_read",
      { path: ".ssh/id_rsa" },
    );

    expect(denied).toMatchObject({
      ok: false,
      reason: "approval_denied",
      class: "credential_access",
      operatorReason: "not the keys",
    });
    expect(deniedProvider.requests).toEqual([]);

    const approvedProvider = new RecordingProvider().queue({ stdout: "PRIVATE KEY" });
    const approvedApprovals = memoryApprovals();
    seedDecision(approvedApprovals, "approved");

    const approved = await toolsFor(approvedProvider, {
      approvals: approvedApprovals.store,
    }).run("file_read", { path: ".ssh/id_rsa" });

    expect(approved).toMatchObject({ ok: true, path: ".ssh/id_rsa" });
    expect(approvedProvider.requests[0]?.command).toBe("cat -- '/home/agent/.ssh/id_rsa'");
  });

  it("gates a write outside the home and acts on the resolved path when approved", async () => {
    const provider = new RecordingProvider();
    const approvals = memoryApprovals();
    seedDecision(approvals, "approved");
    const tools = toolsFor(provider, { approvals: approvals.store });

    const result = await tools.run("file_write", { path: "../outside.txt", content: "x" });

    expect(result).toMatchObject({ ok: true, path: "../outside.txt" });
    expect(provider.requests[0]?.command).toContain("> '/home/outside.txt'");
  });

  it("leaves a benign action in the same classes ungated", async () => {
    const provider = new RecordingProvider();
    const approvals = memoryApprovals();
    const tools = toolsFor(provider, { approvals: approvals.store, allowlist: ["example.com"] });

    await tools.run("file_read", { path: "notes/todo.md" });
    await tools.run("file_write", { path: "notes/todo.md", content: "x" });
    await tools.run("browser", { action: "open", url: "https://example.com/page" });

    expect(approvals.rows.size).toBe(0);
    expect(provider.requests).toHaveLength(3);
  });

  it("gates a browser navigation to a host outside the allowlist", async () => {
    const provider = new RecordingProvider();
    const approvals = memoryApprovals();
    seedDecision(approvals, "denied");
    const tools = toolsFor(provider, { approvals: approvals.store });

    const result = await tools.run("browser", { action: "open", url: "https://other.test/page" });

    expect(result).toMatchObject({
      ok: false,
      reason: "approval_denied",
      class: "egress_unlisted",
    });
    expect(provider.requests).toEqual([]);
  });

  it("refuses a dangerous call with no gate to ask", async () => {
    const provider = new RecordingProvider();
    const tools = toolsFor(provider);

    await expect(tools.run("file_read", { path: ".env" })).resolves.toMatchObject({
      ok: false,
      reason: "approval_unavailable",
      class: "credential_access",
    });
    expect(provider.requests).toEqual([]);
  });
});

describe("the computer tool registrations", () => {
  it("offers every tool the model may call, with a schema and a description", () => {
    const tools = toolsFor(new RecordingProvider());

    expect(tools.registrations.map((registration) => registration.name)).toEqual([
      "shell",
      "file_read",
      "file_write",
      "file_list",
      "browser",
    ]);

    for (const registration of tools.registrations) {
      expect(registration.description.trim()).not.toBe("");
      expect(typeof registration.parameters).toBe("object");
    }
  });

  it("is accepted by the dispatcher under a run lease that covers the budget", () => {
    const ledger: ToolCallLedger = {
      begin: async (): Promise<ToolCallAdmission> => ({ status: "started" }),
      complete: async (_call, result): Promise<ToolOutcome> => ({ status: "completed", result }),
      fail: async (_call, error): Promise<ToolOutcome> => ({ status: "failed", error }),
    };

    const dispatcher = createToolDispatcher({
      registrations: createComputerTools({
        commands: providerCommands(new RecordingProvider()),
        computer,
        maxDurationMs: 60_000,
      }),
      ledger,
      leaseTtlMs: 120_000,
      heartbeat: Effect.void,
    });

    expect(dispatcher.canHandle("shell")).toBe(true);
    expect(dispatcher.canHandle("file_read")).toBe(true);
    expect(dispatcher.canHandle("browser")).toBe(true);
    expect(dispatcher.canHandle("web_fetch")).toBe(false);
    expect(dispatcher.definitions().map((definition) => definition.name)).toEqual([
      "shell",
      "file_read",
      "file_write",
      "file_list",
      "browser",
    ]);
  });

  it("refuses a budget that is not a positive integer", () => {
    expect(() =>
      createComputerTools({
        commands: providerCommands(new RecordingProvider()),
        computer,
        maxDurationMs: 0,
      }),
    ).toThrow(RangeError);
  });

  it("refuses a budget that does not cover the approval window", () => {
    expect(() =>
      createComputerTools({
        commands: providerCommands(new RecordingProvider()),
        computer,
        approvals: memoryApprovals().store,
        approvalTimeoutMs: 60_000,
        maxDurationMs: 30_000,
      }),
    ).toThrow(RangeError);
  });
});
