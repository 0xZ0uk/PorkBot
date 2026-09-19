import { Effect, Either, Fiber } from "effect";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import type {
  ComputerLeaseAcquisition,
  ComputerLeaseHolder,
  ComputerLeaseStore,
} from "./computer-commands.ts";
import {
  ComputerCommandFailedError,
  ComputerLeaseHeldError,
  ComputerLeaseTtlError,
  createFencedComputerCommands,
} from "./computer-commands.ts";
import { LeaseLostError, ToolCallConflictError } from "./errors.ts";
import type {
  ToolCall,
  ToolCallAdmission,
  ToolCallLedger,
  ToolOutcome,
} from "./tool-dispatcher.ts";

/**
 * The fenced command runner in behaviour (slice 7.4): the run's own
 * `(runId, owner, fence)` is held on the computer around every command, a
 * retried call id replays instead of re-running the effect, a lost fence is
 * the typed `LeaseLostError` rather than a provider timeout, a live foreign
 * holder is the classified `rate_limited`, and the computer TTL can never be
 * built longer than the run TTL.
 *
 * The provider and store here are scripted: what the store's SQL adds is
 * proven against real Postgres in `@porkbot/db`'s integration suite, which
 * composes this same runner with the committed `computer_lease` statements.
 */

const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };
const holder: ComputerLeaseHolder = {
  botId: computer.botId,
  runId: "run-1",
  owner: "job-1",
  fence: 1,
};

class CountingProvider implements ComputerProvider {
  readonly requests: ComputerExecRequest[] = [];
  #results: ComputerExecResult[] = [];
  #failures: unknown[] = [];

  queue(result: Partial<ComputerExecResult>): this {
    this.#results.push({ exitCode: 0, stdout: "", stderr: "", ...result });
    return this;
  }

  fail(error: unknown): this {
    this.#failures.push(error);
    return this;
  }

  get calls(): number {
    return this.requests.length;
  }

  async ensure(): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async status(): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async stop(): Promise<ComputerStatus> {
    return { computer, state: "stopped" };
  }

  async list(): Promise<readonly ComputerStatus[]> {
    return [];
  }

  async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
    this.requests.push(request);
    const failure = this.#failures.shift();

    if (failure !== undefined) {
      throw failure;
    }

    return this.#results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }

  async snapshot(): Promise<ComputerSnapshot> {
    return { snapshotId: "snapshot-1", key: "scope/snapshot-1.tar" };
  }

  async restore(): Promise<ComputerStatus> {
    return { computer, state: "running" };
  }

  async destroy(): Promise<void> {}
}

/** A provider whose one command parks until the test releases it. */
class BlockingProvider extends CountingProvider {
  readonly entered: Promise<void>;
  #enteredResolve: () => void = () => {};
  #release: (() => void) | undefined;
  readonly #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  constructor() {
    super();
    this.entered = new Promise((resolve) => {
      this.#enteredResolve = resolve;
    });
  }

  override async exec(request: ComputerExecRequest): Promise<ComputerExecResult> {
    this.requests.push(request);
    this.#enteredResolve();
    await this.#gate;

    return { exitCode: 0, stdout: "late", stderr: "" };
  }

  release(): void {
    this.#release?.();
  }
}

interface ScriptedStore extends ComputerLeaseStore {
  readonly holds: ComputerLeaseHolder[];
  readonly released: ComputerLeaseHolder[];
}

function scriptedStore(...acquisitions: readonly ComputerLeaseAcquisition[]): ScriptedStore {
  const queue = [...acquisitions];
  const holds: ComputerLeaseHolder[] = [];
  const released: ComputerLeaseHolder[] = [];

  return {
    holds,
    released,
    async hold(held): Promise<ComputerLeaseAcquisition> {
      holds.push(held);

      return (
        queue.shift() ?? {
          status: "held",
          lease: { ...held, expiresAt: new Date(Date.now() + 60_000) },
        }
      );
    },
    async release(held): Promise<boolean> {
      released.push(held);

      return true;
    },
  };
}

interface MemoryLedger {
  readonly ledger: ToolCallLedger;
  readonly outcomes: Map<string, ToolOutcome>;
  readonly inFlight: Map<string, string>;
}

function memoryLedger(): MemoryLedger {
  const outcomes = new Map<string, ToolOutcome>();
  const inFlight = new Map<string, string>();

  return {
    outcomes,
    inFlight,
    ledger: {
      async begin(call: ToolCall): Promise<ToolCallAdmission> {
        const outcome = outcomes.get(call.callId);

        if (outcome !== undefined) {
          return outcome.status === "completed"
            ? { status: "completed", result: outcome.result }
            : { status: "failed", error: outcome.error };
        }

        if (inFlight.has(call.callId)) {
          return { status: "in_flight" };
        }

        inFlight.set(call.callId, `${call.tool}:${JSON.stringify(call.arguments)}`);

        return { status: "started" };
      },
      async complete(call: ToolCall, result: unknown): Promise<ToolOutcome> {
        const outcome: ToolOutcome = { status: "completed", result };
        outcomes.set(call.callId, outcome);
        inFlight.delete(call.callId);

        return outcome;
      },
      async fail(call: ToolCall, error: string): Promise<ToolOutcome> {
        const outcome: ToolOutcome = { status: "failed", error };
        outcomes.set(call.callId, outcome);
        inFlight.delete(call.callId);

        return outcome;
      },
    },
  };
}

function runner(options: {
  readonly store: ComputerLeaseStore;
  readonly ledger: ToolCallLedger;
  readonly provider: ComputerProvider;
  readonly runLeaseTtlSeconds?: number;
  readonly computerLeaseTtlSeconds?: number;
}) {
  return createFencedComputerCommands({
    provider: options.provider,
    ledger: options.ledger,
    leases: options.store,
    lease: holder,
    runLeaseTtlSeconds: options.runLeaseTtlSeconds ?? 120,
    computerLeaseTtlSeconds: options.computerLeaseTtlSeconds ?? 120,
  });
}

function command(callId = "call-1") {
  return {
    computer,
    runId: holder.runId,
    callId,
    tool: "shell",
    command: "printf hello",
    timeoutMs: 30_000,
  } as const;
}

async function attempt(program: Effect.Effect<unknown, unknown>) {
  return Effect.runPromise(program.pipe(Effect.either));
}

/** The failure of an attempted command; a test that gets a success fails loudly. */
function failureOf(outcome: Either.Either<unknown, unknown>): unknown {
  if (Either.isRight(outcome)) {
    throw new Error(`expected the command to fail, got ${JSON.stringify(outcome.right)}`);
  }

  return outcome.left;
}

describe("the computer lease TTLs", () => {
  it("refuses a computer lease that outlives the run lease", () => {
    expect(() =>
      runner({
        store: scriptedStore(),
        ledger: memoryLedger().ledger,
        provider: new CountingProvider(),
        runLeaseTtlSeconds: 120,
        computerLeaseTtlSeconds: 121,
      }),
    ).toThrow(ComputerLeaseTtlError);
  });

  it("accepts a computer lease equal to the run lease, which is the shipped choice", () => {
    expect(() =>
      runner({
        store: scriptedStore(),
        ledger: memoryLedger().ledger,
        provider: new CountingProvider(),
        runLeaseTtlSeconds: 120,
        computerLeaseTtlSeconds: 120,
      }),
    ).not.toThrow();
  });

  it("refuses a TTL that is not a positive whole number of seconds", () => {
    const build = (run: number, computerTtl: number) =>
      runner({
        store: scriptedStore(),
        ledger: memoryLedger().ledger,
        provider: new CountingProvider(),
        runLeaseTtlSeconds: run,
        computerLeaseTtlSeconds: computerTtl,
      });

    expect(() => build(0, 0)).toThrow(ComputerLeaseTtlError);
    expect(() => build(120, 0)).toThrow(ComputerLeaseTtlError);
    expect(() => build(120, 1.5)).toThrow(ComputerLeaseTtlError);
  });
});

describe("a fenced computer command", () => {
  it("holds the computer around the command and records the result", async () => {
    const provider = new CountingProvider().queue({ stdout: "hello\n" });
    const memory = memoryLedger();
    const store = scriptedStore();
    const fenced = runner({ store, ledger: memory.ledger, provider });

    const result = await Effect.runPromise(fenced.exec(command()));

    expect(result).toMatchObject({ exitCode: 0, stdout: "hello\n" });
    expect(provider.requests).toEqual([{ computer, command: "printf hello", timeoutMs: 30_000 }]);
    expect(store.holds).toEqual([holder, holder]);
    expect([...memory.outcomes.values()]).toEqual([
      { status: "completed", result: { exitCode: 0, stdout: "hello\n", stderr: "" } },
    ]);
  });

  it("replays a retried call id instead of repeating its effect", async () => {
    const provider = new CountingProvider().queue({ stdout: "once\n" });
    const memory = memoryLedger();
    const store = scriptedStore();
    const fenced = runner({ store, ledger: memory.ledger, provider });

    const first = await Effect.runPromise(fenced.exec(command()));
    const second = await Effect.runPromise(fenced.exec(command()));

    expect(provider.calls).toBe(1);
    expect(second).toEqual(first);
    // The replay short-circuits before the fence: the computer is not held for
    // a command that does not run.
    expect(store.holds).toEqual([holder, holder]);
  });

  it("cannot commit when the run was reclaimed while the command ran", async () => {
    const provider = new CountingProvider().queue({ stdout: "too late\n" });
    const memory = memoryLedger();
    const store = scriptedStore(
      { status: "held", lease: { ...holder, expiresAt: new Date(Date.now() + 60_000) } },
      { status: "run_lost" },
    );
    const fenced = runner({ store, ledger: memory.ledger, provider });

    const failure = failureOf(await attempt(fenced.exec(command())));

    expect(failure).toBeInstanceOf(LeaseLostError);
    expect((failure as LeaseLostError).runId).toBe("run-1");
    // The command ran, but its outcome is not recorded as this run's: the
    // reclaim settles the claim as a failure and a resume replays that.
    expect(memory.outcomes.size).toBe(0);
    expect(provider.calls).toBe(1);
  });

  it("cannot commit when the fence moved between the command and the hold", async () => {
    const provider = new CountingProvider().queue({ stdout: "stale\n" });
    const memory = memoryLedger();
    const store = scriptedStore(
      { status: "held", lease: { ...holder, expiresAt: new Date(Date.now() + 60_000) } },
      { status: "busy", expiresAt: new Date(Date.now() + 60_000) },
    );
    const fenced = runner({ store, ledger: memory.ledger, provider });

    const failure = failureOf(await attempt(fenced.exec(command())));

    expect(failure).toBeInstanceOf(LeaseLostError);
    expect(memory.outcomes.size).toBe(0);
  });

  it("classifies a live foreign holder as rate_limited, not a timeout", async () => {
    const provider = new CountingProvider();
    const memory = memoryLedger();
    const store = scriptedStore({
      status: "busy",
      expiresAt: new Date(Date.now() + 30_000),
    });
    const fenced = runner({ store, ledger: memory.ledger, provider });

    const failure = failureOf(await attempt(fenced.exec(command())));

    expect(failure).toBeInstanceOf(ComputerLeaseHeldError);
    expect((failure as ComputerLeaseHeldError).kind).toBe("rate_limited");
    expect(provider.calls).toBe(0);
    // The claim is settled so the refusal does not read as in flight forever.
    expect([...memory.outcomes.values()]).toMatchObject([{ status: "failed" }]);
  });

  it("records a provider failure and replays it on a retry", async () => {
    const failure = Object.assign(new Error("the machine is gone"), { kind: "gone" });
    const provider = new CountingProvider().fail(failure);
    const memory = memoryLedger();
    const store = scriptedStore();
    const fenced = runner({ store, ledger: memory.ledger, provider });

    const first = failureOf(await attempt(fenced.exec(command())));

    expect(first).toBe(failure);
    expect([...memory.outcomes.values()]).toMatchObject([
      { status: "failed", error: "the machine is gone" },
    ]);

    const second = failureOf(await attempt(fenced.exec(command())));

    expect(second).toBeInstanceOf(ComputerCommandFailedError);
    expect((second as Error).message).toBe("the machine is gone");
    expect(provider.calls).toBe(1);
  });

  it("reports cancellation as an interrupt and leaves the claim for the reclaim", async () => {
    const provider = new BlockingProvider();
    const memory = memoryLedger();
    const fenced = runner({ store: scriptedStore(), ledger: memory.ledger, provider });

    const fiber = Effect.runFork(fenced.exec(command()));
    await provider.entered;
    await Effect.runPromise(Fiber.interrupt(fiber));

    // The interruption is the fence's own cancellation: nothing settles the
    // command as completed, and no `fail` claims an outcome the reclaim owns.
    expect(memory.outcomes.size).toBe(0);
    expect(memory.inFlight.size).toBe(1);
  });

  it("refuses a concurrent retry of the same call id while the command is in flight", async () => {
    const provider = new BlockingProvider();
    const memory = memoryLedger();
    const fenced = runner({ store: scriptedStore(), ledger: memory.ledger, provider });

    const first = Effect.runPromise(fenced.exec(command()));
    await provider.entered;

    const second = failureOf(await attempt(fenced.exec(command())));

    expect(second).toBeInstanceOf(ToolCallConflictError);

    provider.release();
    await expect(first).resolves.toMatchObject({ stdout: "late" });
    expect(provider.calls).toBe(1);
  });
});
