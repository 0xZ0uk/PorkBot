import { Effect, Exit } from "effect";
import type { ProviderFailure } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  InvalidToolCallError,
  LeaseLostError,
  ToolCallConflictError,
  ToolLedgerError,
  UnknownToolError,
} from "./errors.ts";
import { createToolDispatcher, ToolRegistrationError } from "./tool-dispatcher.ts";
import type {
  ToolCall,
  ToolCallAdmission,
  ToolCallLedger,
  ToolOutcome,
  ToolRegistration,
} from "./tool-dispatcher.ts";

/**
 * The dispatch seam in behaviour: one registration carries metadata and
 * handler; the model-facing definitions are generated from the same values the
 * dispatcher executes; a blank call id cannot be dispatched; an unknown name is
 * a typed error; a ledger admits each call once and a retry replays the stored
 * outcome; the heartbeat runs between the durable claim and the handler; and a
 * tool longer than the run lease is refused at construction.
 *
 * The ledger here is in memory: what durability adds is proven against real
 * Postgres in `@porkbot/db`'s integration suite, which composes this same
 * dispatcher with the `external_effect` ledger.
 */

const call = (overrides: Partial<ToolCall> = {}): ToolCall => ({
  runId: "run-1",
  callId: "call-1",
  tool: "echo",
  arguments: { text: "hi" },
  ...overrides,
});

interface MemoryLedger {
  readonly ledger: ToolCallLedger;
  readonly events: string[];
  /** Makes the next `begin` answer with the given admission. */
  nextAdmission: ToolCallAdmission | undefined;
}

function memoryLedger(): MemoryLedger {
  const settled = new Map<string, ToolOutcome>();
  const claims = new Map<string, string>();
  const memory: MemoryLedger = {
    events: [],
    nextAdmission: undefined,
    ledger: {
      async begin(input) {
        memory.events.push(`begin ${input.callId}`);

        if (memory.nextAdmission !== undefined) {
          const admission = memory.nextAdmission;
          memory.nextAdmission = undefined;
          return admission;
        }

        const claim = claims.get(input.callId);
        if (claim !== undefined && claim !== `${input.tool}:${JSON.stringify(input.arguments)}`) {
          return { status: "call_id_reused" };
        }

        const outcome = settled.get(input.callId);
        if (outcome === undefined) {
          claims.set(input.callId, `${input.tool}:${JSON.stringify(input.arguments)}`);
          return { status: "started" };
        }

        return outcome.status === "completed"
          ? { status: "completed", result: outcome.result }
          : { status: "failed", error: outcome.error };
      },
      async complete(input, result) {
        memory.events.push(`complete ${input.callId}`);
        const outcome: ToolOutcome = { status: "completed", result };
        settled.set(input.callId, outcome);
        return outcome;
      },
      async fail(input, error) {
        memory.events.push(`fail ${input.callId}`);
        const outcome: ToolOutcome = { status: "failed", error };
        settled.set(input.callId, outcome);
        return outcome;
      },
    },
  };

  return memory;
}

function registration(overrides: Partial<ToolRegistration> = {}): ToolRegistration {
  return {
    name: "echo",
    description: "Echo the text back.",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    maxDurationMs: 1_000,
    execute: (input) => Effect.succeed(input.arguments),
    ...overrides,
  };
}

function dispatcherOf(
  registrations: readonly ToolRegistration[],
  memory = memoryLedger(),
  overrides: {
    readonly leaseTtlMs?: number;
    readonly heartbeat?: Effect.Effect<void, LeaseLostError>;
  } = {},
) {
  const dispatcher = createToolDispatcher({
    registrations,
    ledger: memory.ledger,
    leaseTtlMs: overrides.leaseTtlMs ?? 60_000,
    heartbeat: overrides.heartbeat ?? Effect.void,
  });

  return { dispatcher, memory };
}

describe("tool registration", () => {
  it("generates the model-facing definitions from the same values the dispatcher executes", () => {
    const { dispatcher } = dispatcherOf([
      registration(),
      registration({
        name: "shell",
        description: "Run a shell command.",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      }),
    ]);

    expect(dispatcher.definitions()).toEqual([
      {
        name: "echo",
        description: "Echo the text back.",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
      {
        name: "shell",
        description: "Run a shell command.",
        parameters: { type: "object", properties: { command: { type: "string" } } },
      },
    ]);
    expect(dispatcher.canHandle("echo")).toBe(true);
    expect(dispatcher.canHandle("shell")).toBe(true);
    expect(dispatcher.canHandle("mystery")).toBe(false);
  });

  it("refuses a duplicate tool name, so the model cannot be offered two of one", () => {
    expect(() => dispatcherOf([registration(), registration()])).toThrowError(
      expect.objectContaining({ name: "ToolRegistrationError", reason: "duplicate_name" }),
    );
  });

  it("refuses a registration without a name or a description", () => {
    expect(() => dispatcherOf([registration({ name: " " })])).toThrowError(
      expect.objectContaining({ reason: "empty_name" }),
    );
    expect(() => dispatcherOf([registration({ description: "" })])).toThrowError(
      expect.objectContaining({ reason: "empty_description" }),
    );
  });

  it("refuses a name with surrounding whitespace instead of registering a name the model cannot call", () => {
    expect(() => dispatcherOf([registration({ name: " echo " })])).toThrowError(
      expect.objectContaining({ reason: "untrimmed_name" }),
    );
  });

  it("refuses a schema that is not a JSON Schema object", () => {
    expect(() => dispatcherOf([registration({ parameters: undefined })])).toThrowError(
      expect.objectContaining({ reason: "invalid_parameters" }),
    );
    expect(() => dispatcherOf([registration({ parameters: [] })])).toThrowError(
      expect.objectContaining({ reason: "invalid_parameters" }),
    );
  });

  it("refuses a tool whose declared duration outlives the run lease", () => {
    expect(() =>
      dispatcherOf([registration({ maxDurationMs: 60_001 })], memoryLedger()),
    ).toThrowError(expect.objectContaining({ reason: "duration_exceeds_lease" }));
  });

  it("refuses a non-positive duration and a non-positive lease TTL", () => {
    expect(() => dispatcherOf([registration({ maxDurationMs: 0 })])).toThrowError(
      expect.objectContaining({ reason: "invalid_duration" }),
    );
    expect(() => dispatcherOf([registration()], memoryLedger(), { leaseTtlMs: 0 })).toThrowError(
      expect.objectContaining({ reason: "invalid_lease_ttl" }),
    );
  });

  it("names the tool and the reason in the boot failure", () => {
    try {
      dispatcherOf([registration({ name: "shell", maxDurationMs: 120_000 })]);
      expect.unreachable("the registration should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolRegistrationError);
      expect((error as ToolRegistrationError).tool).toBe("shell");
      expect((error as Error).message).toContain("120000");
    }
  });
});

describe("dispatching one call", () => {
  it("executes a registered tool and returns its result", async () => {
    const { dispatcher } = dispatcherOf([registration()]);

    const outcome = await Effect.runPromise(dispatcher.execute(call()));

    expect(outcome).toEqual({ status: "completed", result: { text: "hi" } });
  });

  it("answers an unknown tool with a typed error and never runs a handler", async () => {
    let runs = 0;
    const { dispatcher, memory } = dispatcherOf([
      registration({
        execute: () => {
          runs += 1;
          return Effect.succeed("ran");
        },
      }),
    ]);

    const error = await Effect.runPromise(
      dispatcher.execute(call({ tool: "mystery" })).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(UnknownToolError);
    expect(error.message).toContain("mystery");
    expect(runs).toBe(0);
    expect(memory.events).toEqual([]);
  });

  it("refuses a call without a durable call id, the non-null idempotency key", async () => {
    let runs = 0;
    const { dispatcher } = dispatcherOf([
      registration({
        execute: () => {
          runs += 1;
          return Effect.succeed("ran");
        },
      }),
    ]);

    const error = await Effect.runPromise(
      dispatcher.execute(call({ callId: "  " })).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(InvalidToolCallError);
    expect((error as InvalidToolCallError).field).toBe("callId");
    expect(runs).toBe(0);
  });

  it("replays a completed call instead of running its handler twice", async () => {
    let runs = 0;
    const { dispatcher, memory } = dispatcherOf([
      registration({
        execute: (input) => {
          runs += 1;
          return Effect.succeed({ text: input.arguments, run: runs });
        },
      }),
    ]);

    const first = await Effect.runPromise(dispatcher.execute(call()));
    const second = await Effect.runPromise(dispatcher.execute(call()));

    expect(first).toEqual({ status: "completed", result: { text: { text: "hi" }, run: 1 } });
    expect(second).toEqual(first);
    expect(runs).toBe(1);
    expect(memory.events).toEqual(["begin call-1", "complete call-1", "begin call-1"]);
  });

  it("replays a failed call without re-running its handler", async () => {
    let runs = 0;
    const { dispatcher, memory } = dispatcherOf([
      registration({
        execute: () => {
          runs += 1;
          return Effect.fail(new Error("the provider refused"));
        },
      }),
    ]);

    const first = await Effect.runPromise(dispatcher.execute(call()));
    const second = await Effect.runPromise(dispatcher.execute(call()));

    expect(first).toEqual({ status: "failed", error: 'tool "echo" failed' });
    expect(second).toEqual(first);
    expect(runs).toBe(1);
    expect(memory.events).toContain("fail call-1");
  });

  it("reports a handler that dies as a generic failure, not as a defect", async () => {
    const { dispatcher } = dispatcherOf([registration({ execute: () => Effect.die("boom") })]);

    const outcome = await Effect.runPromise(dispatcher.execute(call()));

    expect(outcome).toEqual({ status: "failed", error: 'tool "echo" failed' });
  });

  it("surfaces only the classified detail of a provider failure", async () => {
    class RefusedError extends Error implements ProviderFailure {
      readonly kind = "rate_limited" as const;
      readonly detail = "the endpoint is refusing work; back off";

      constructor() {
        super("raw vendor text that must not reach the model");
      }
    }

    const { dispatcher } = dispatcherOf([
      registration({
        // The bare wrapper is what a tool wrapping a provider promise writes;
        // classification has to read through Effect's UnknownException.
        execute: () => Effect.tryPromise(() => Promise.reject(new RefusedError())),
      }),
    ]);

    const outcome = await Effect.runPromise(dispatcher.execute(call()));

    expect(outcome).toEqual({
      status: "failed",
      error: 'tool "echo" failed (rate_limited): the endpoint is refusing work; back off',
    });
  });

  it("keeps an unclassified handler error out of the model-visible outcome", async () => {
    const { dispatcher } = dispatcherOf([
      registration({
        execute: () => Effect.fail(new Error("sent Bearer sk-live-1234567890 to the provider")),
      }),
    ]);

    const outcome = await Effect.runPromise(dispatcher.execute(call()));

    expect(outcome).toEqual({ status: "failed", error: 'tool "echo" failed' });
    expect(JSON.stringify(outcome)).not.toContain("sk-live");
  });

  it("refuses a call id still in flight and one reused for another request", async () => {
    const first = dispatcherOf([registration()]);
    first.memory.nextAdmission = { status: "in_flight" };
    const inFlight = await Effect.runPromise(first.dispatcher.execute(call()).pipe(Effect.flip));
    expect(inFlight).toBeInstanceOf(ToolCallConflictError);
    expect((inFlight as ToolCallConflictError).reason).toBe("in_flight");

    const second = dispatcherOf([registration()]);
    second.memory.nextAdmission = { status: "call_id_reused" };
    const reused = await Effect.runPromise(second.dispatcher.execute(call()).pipe(Effect.flip));
    expect(reused).toBeInstanceOf(ToolCallConflictError);
    expect((reused as ToolCallConflictError).reason).toBe("call_id_reused");
  });

  it("stops before the handler when the durable claim cannot be written", async () => {
    let runs = 0;
    const failing: ToolCallLedger = {
      begin: async () => {
        throw new Error("the pool is gone");
      },
      complete: async (_call, result) => ({ status: "completed", result }),
      fail: async (_call, error) => ({ status: "failed", error }),
    };
    const dispatcher = createToolDispatcher({
      registrations: [
        registration({
          execute: () => {
            runs += 1;
            return Effect.succeed("ran");
          },
        }),
      ],
      ledger: failing,
      leaseTtlMs: 60_000,
      heartbeat: Effect.void,
    });

    const error = await Effect.runPromise(dispatcher.execute(call()).pipe(Effect.flip));

    expect(error).toBeInstanceOf(ToolLedgerError);
    expect((error as ToolLedgerError).operation).toBe("begin");
    expect(runs).toBe(0);
  });
});

describe("heartbeat and budget", () => {
  it("persists the heartbeat after the claim and before the handler", async () => {
    const heartbeats = { count: 0 };
    let beatsAtExecution = -1;
    const { dispatcher, memory } = dispatcherOf(
      [
        registration({
          execute: () =>
            Effect.sync(() => {
              beatsAtExecution = heartbeats.count;
              return "done";
            }),
        }),
      ],
      memoryLedger(),
      {
        heartbeat: Effect.sync(() => {
          heartbeats.count += 1;
        }),
      },
    );

    await Effect.runPromise(dispatcher.execute(call()));

    expect(beatsAtExecution).toBe(1);
    expect(memory.events).toEqual(["begin call-1", "complete call-1"]);
  });

  it("does not run the handler when the heartbeat reports the lease lost", async () => {
    let runs = 0;
    const { dispatcher } = dispatcherOf(
      [
        registration({
          execute: () => {
            runs += 1;
            return Effect.succeed("ran");
          },
        }),
      ],
      memoryLedger(),
      { heartbeat: Effect.fail(new LeaseLostError("run-1")) },
    );

    const error = await Effect.runPromise(dispatcher.execute(call()).pipe(Effect.flip));

    expect(error).toBeInstanceOf(LeaseLostError);
    expect(runs).toBe(0);
  });

  it("fails a handler that overruns its declared duration and records the failure", async () => {
    const { dispatcher, memory } = dispatcherOf([
      registration({ maxDurationMs: 5, execute: () => Effect.sleep("5 seconds") }),
    ]);

    const outcome = await Effect.runPromise(dispatcher.execute(call()));

    expect(outcome).toEqual({
      status: "failed",
      error: 'tool "echo" exceeded its 5ms budget',
    });
    expect(memory.events).toContain("fail call-1");
  });

  it("propagates cancellation instead of reporting the call failed", async () => {
    const { dispatcher, memory } = dispatcherOf([
      registration({ execute: () => Effect.interrupt }),
    ]);

    const exit = await Effect.runPromiseExit(dispatcher.execute(call()));

    expect(Exit.isInterrupted(exit)).toBe(true);
    expect(memory.events).toEqual(["begin call-1"]);
  });

  it("re-raises a lease lost inside the handler instead of reporting a tool failure", async () => {
    // The fenced computer command runner raises the typed loss at its commit
    // gate (slice 7.4). A claim that may have run cannot read as a tool that
    // merely failed, and the run must stop rather than continue; the claim is
    // left for the reclaim to settle, so no `fail` is recorded here.
    const { dispatcher, memory } = dispatcherOf([
      registration({ execute: () => Effect.fail(new LeaseLostError("run-1")) }),
    ]);

    const error = await Effect.runPromise(dispatcher.execute(call()).pipe(Effect.flip));

    expect(error).toBeInstanceOf(LeaseLostError);
    expect(memory.events).toEqual(["begin call-1"]);
  });
});
