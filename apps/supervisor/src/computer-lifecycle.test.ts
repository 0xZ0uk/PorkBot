import { ComputerEmulator, ComputerProviderError } from "@porkbot/adapters";
import type {
  ComputerExecRequest,
  ComputerExecResult,
  ComputerProvider,
  ComputerRef,
  ComputerSnapshot,
  ComputerStatus,
} from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { createComputerLifecycle } from "./computer-lifecycle.ts";

/**
 * The lifecycle service's own rules: the four operations, what survives each,
 * and the reconciliation pass that keeps a supervisor crash from orphaning
 * machines. The provider is the offline emulator, so the suite runs a real
 * machine through a real seam with no daemon — where a behavior depends on a
 * provider failure, a thin delegate injects exactly that failure.
 */

const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };
const otherComputer: ComputerRef = { computerId: "computer-2", botId: "bot-2" };

function lifecycleOver(provider: ComputerProvider = new ComputerEmulator()) {
  return { lifecycle: createComputerLifecycle({ provider }), provider };
}

/** A provider that delegates every method, overriding `ensure` for one machine. */
function withFailingEnsure(base: ComputerProvider, failing: ComputerRef): ComputerProvider {
  return {
    ensure: (ref) =>
      ref.computerId === failing.computerId
        ? Promise.reject(
            new ComputerProviderError("rate_limited", `no capacity for ${ref.computerId}`),
          )
        : base.ensure(ref),
    status: (ref: ComputerRef): Promise<ComputerStatus> => base.status(ref),
    stop: (ref: ComputerRef): Promise<ComputerStatus> => base.stop(ref),
    list: (): Promise<readonly ComputerStatus[]> => base.list(),
    exec: (request: ComputerExecRequest): Promise<ComputerExecResult> => base.exec(request),
    snapshot: (ref: ComputerRef): Promise<ComputerSnapshot> => base.snapshot(ref),
    restore: (ref: ComputerRef, snapshot: ComputerSnapshot): Promise<ComputerStatus> =>
      base.restore(ref, snapshot),
    destroy: (ref: ComputerRef): Promise<void> => base.destroy(ref),
  };
}

describe("the computer lifecycle", () => {
  it("boots, parks and boots again from the same home", async () => {
    const { lifecycle } = lifecycleOver();

    await expect(lifecycle.boot(computer)).resolves.toMatchObject({ state: "running" });
    await expect(lifecycle.stop(computer)).resolves.toMatchObject({ state: "stopped" });
    await expect(lifecycle.status(computer)).resolves.toMatchObject({ state: "stopped" });
    await expect(lifecycle.boot(computer)).resolves.toMatchObject({ state: "running" });
  });

  it("resets to a clean machine and recovers whatever state it finds", async () => {
    const { lifecycle } = lifecycleOver();

    await lifecycle.boot(computer);
    await lifecycle.exec({
      computer,
      command: "printf 'kept' > /home/agent/before-reset.txt",
      timeoutMs: 5_000,
    });

    await expect(lifecycle.reset(computer)).resolves.toMatchObject({ state: "running" });
    const afterReset = await lifecycle.exec({
      computer,
      command: "cat /home/agent/before-reset.txt",
      timeoutMs: 5_000,
    });

    expect(afterReset.exitCode).not.toBe(0);

    await lifecycle.destroy(computer);
    await expect(lifecycle.recover(computer)).resolves.toMatchObject({ state: "running" });
    await lifecycle.stop(computer);
    await expect(lifecycle.recover(computer)).resolves.toMatchObject({ state: "running" });
  });

  it("refuses an identity that cannot produce an isolated network before the provider sees it", async () => {
    const { lifecycle, provider } = lifecycleOver();

    await expect(lifecycle.boot({ computerId: "", botId: "bot-1" })).rejects.toThrow(RangeError);
    await expect(lifecycle.recover({ computerId: "computer-1", botId: "  " })).rejects.toThrow(
      RangeError,
    );
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("passes status, exec, snapshots and destroy straight through", async () => {
    const { lifecycle } = lifecycleOver();

    await lifecycle.boot(computer);
    await expect(
      lifecycle.exec({ computer, command: "printf 'through'", timeoutMs: 5_000 }),
    ).resolves.toMatchObject({ exitCode: 0, stdout: "through" });

    const snapshot = await lifecycle.snapshot(computer);
    await lifecycle.destroy(computer);
    await expect(lifecycle.restore(computer, snapshot)).resolves.toMatchObject({
      state: "running",
    });
    await expect(lifecycle.list()).resolves.toEqual([
      expect.objectContaining({ computer, state: "running" }),
    ]);
  });
});

describe("the boot reconciliation pass", () => {
  it("adopts every machine a crashed supervisor left behind", async () => {
    const provider = new ComputerEmulator();
    const crashed = createComputerLifecycle({ provider });

    await crashed.boot(computer);
    await crashed.boot(otherComputer);
    await crashed.stop(otherComputer);

    // The supervisor restarts with no memory of the previous process; the
    // provider still holds both machines, so the pass must find and adopt them.
    const restarted = createComputerLifecycle({ provider });
    const report = await restarted.reconcile();

    expect(report.listed).toBe(2);
    expect(report.failed).toEqual([]);
    expect(report.adopted).toEqual(expect.arrayContaining([computer, otherComputer]));
    await expect(restarted.status(computer)).resolves.toMatchObject({ state: "running" });
    // A machine the operator parked before the crash comes back parked: a
    // deliberate stop is not an orphan to clean up.
    await expect(restarted.status(otherComputer)).resolves.toMatchObject({ state: "stopped" });
  });

  it("is idempotent and reports nothing to do on an empty provider", async () => {
    const { lifecycle } = lifecycleOver();

    await expect(lifecycle.reconcile()).resolves.toEqual({
      listed: 0,
      adopted: [],
      failed: [],
    });

    await lifecycle.boot(computer);
    const first = await lifecycle.reconcile();
    const second = await lifecycle.reconcile();

    expect(first.adopted).toEqual([computer]);
    expect(second.adopted).toEqual([computer]);
    await expect(lifecycle.list()).resolves.toHaveLength(1);
  });

  it("keeps one refused machine from stopping the rest of the fleet", async () => {
    const emulator = new ComputerEmulator();
    await emulator.ensure(computer);
    await emulator.ensure(otherComputer);

    const provider = withFailingEnsure(emulator, otherComputer);
    const report = await createComputerLifecycle({ provider }).reconcile();

    expect(report.listed).toBe(2);
    expect(report.adopted).toEqual([computer]);
    expect(report.failed).toEqual([
      { computer: otherComputer, detail: `no capacity for ${otherComputer.computerId}` },
    ]);
  });

  it("surfaces an unreachable provider instead of pretending the fleet is empty", async () => {
    const provider: ComputerProvider = {
      ...new ComputerEmulator(),
      list: () => Promise.reject(new ComputerProviderError("timed_out", "the daemon is not there")),
      status: () => Promise.reject(new ComputerProviderError("timed_out", "unreachable")),
      stop: () => Promise.reject(new ComputerProviderError("timed_out", "unreachable")),
      ensure: () => Promise.reject(new ComputerProviderError("timed_out", "unreachable")),
      exec: () => Promise.reject(new ComputerProviderError("timed_out", "unreachable")),
      snapshot: () => Promise.reject(new ComputerProviderError("timed_out", "unreachable")),
      restore: () => Promise.reject(new ComputerProviderError("timed_out", "unreachable")),
      destroy: () => Promise.reject(new ComputerProviderError("timed_out", "unreachable")),
    };

    await expect(createComputerLifecycle({ provider }).reconcile()).rejects.toMatchObject({
      kind: "timed_out",
    });
  });
});
