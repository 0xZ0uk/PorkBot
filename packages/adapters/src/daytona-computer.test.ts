import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isProviderFailure } from "@porkbot/adapter-kit";
import type { ComputerProvider, ComputerRef, ProviderFailure } from "@porkbot/adapter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { computerConformance } from "./computer-conformance.ts";
import type { ComputerConformanceHarness } from "./computer-conformance.ts";
import {
  createDaytonaComputerProvider,
  DEFAULT_DAYTONA_COMPUTER_HOME,
} from "./daytona-computer.ts";
import type { DaytonaComputerProviderOptions } from "./daytona-computer.ts";
import { DaytonaEngineEmulator } from "./daytona-engine-emulator.ts";
import { DaytonaProtocolError } from "./daytona-errors.ts";
import { LocalStorageProvider } from "./local-storage.ts";

/**
 * The Daytona computer provider (slice 7.3). Every test drives the shipped
 * provider through the API emulator over loopback HTTP: the same requests the
 * provider sends a real control plane cross this suite, so lifecycle, the
 * classifier, the ceilings, park-and-resume and the snapshot round-trip are
 * exercised with no network and no key. The shared conformance suite is the
 * important half — it is the same suite the emulator, the Docker provider and
 * the supervisor transport register — and the tests after it pin what is
 * Daytona-specific.
 */

const image = "porkbot-test-image:1";
const computer: ComputerRef = { computerId: "computer-1", botId: "bot-1" };
const otherComputer: ComputerRef = { computerId: "computer-2", botId: "bot-2" };

const running: DaytonaEngineEmulator[] = [];
const directories: string[] = [];

async function emulator(): Promise<DaytonaEngineEmulator> {
  const started = await DaytonaEngineEmulator.start();
  running.push(started);
  return started;
}

async function providerOver(
  daemon: DaytonaEngineEmulator,
  overrides: Partial<DaytonaComputerProviderOptions> = {},
): Promise<ComputerProvider> {
  const storage = await mkdtemp(path.join(tmpdir(), "porkbot-daytona-storage-"));
  const scratch = await mkdtemp(path.join(tmpdir(), "porkbot-daytona-archives-"));

  directories.push(storage, scratch);

  return createDaytonaComputerProvider({
    endpoint: daemon.endpoint,
    token: daemon.token,
    image,
    fetch: globalThis.fetch,
    storage: new LocalStorageProvider({ root: storage }),
    scratchDirectory: scratch,
    bootTimeoutMs: 5_000,
    requestTimeoutMs: 5_000,
    archiveTimeoutMs: 15_000,
    ...overrides,
  });
}

afterEach(async () => {
  await Promise.all(running.splice(0).map(async (instance) => instance.stop()));
  await Promise.all(
    directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })),
  );
});

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

async function createHarness(): Promise<ComputerConformanceHarness> {
  const daemon = await emulator();
  const provider = await providerOver(daemon);

  return {
    provider,
    computer: { ...computer },
    otherComputer: { ...otherComputer },
    home: DEFAULT_DAYTONA_COMPUTER_HOME,
    timeoutMs: 25,
    slowCommand: "sleep 5",
  };
}

await computerConformance("createDaytonaComputerProvider", createHarness);

/**
 * The reserved screen path is v1.1 work, and this provider deliberately does
 * not implement it: the interface keeps `frames()`/`input()` optional, the
 * conformance suite skips them when they are absent, and a cloud adapter that
 * guessed at a screen protocol would be a spec, not an implementation.
 */
describe("the Daytona computer provider's reserved screen path", () => {
  it("leaves frames and input unimplemented on the v1.0 seam", async () => {
    const provider = await providerOver(await emulator());

    expect(provider.frames).toBeUndefined();
    expect(provider.input).toBeUndefined();
  });
});

describe("the Daytona computer provider failure classification", () => {
  it("classifies a sandbox the service no longer holds as gone", async () => {
    const daemon = await emulator();
    const provider = await providerOver(daemon);
    await provider.ensure(computer);
    await provider.destroy(computer);

    await expect(provider.status(computer)).resolves.toMatchObject({ state: "gone" });

    const failure = await failureFrom(
      provider.exec({ computer, command: "true", timeoutMs: 1_000 }),
    );

    expect(failure.kind).toBe("gone");
  });

  it("classifies a quota as rate_limited", async () => {
    const daemon = await emulator();
    daemon.failNext({
      method: "POST",
      pathIncludes: "/sandbox",
      status: 429,
      message: "too many requests",
    });
    const provider = await providerOver(daemon);

    const failure = await failureFrom(provider.ensure(computer));

    expect(failure.kind).toBe("rate_limited");
  });

  it("classifies a refused credential as auth_failed", async () => {
    const daemon = await emulator();
    const provider = await providerOver(daemon, { token: "not-the-key" });

    const failure = await failureFrom(provider.ensure(computer));

    expect(failure.kind).toBe("auth_failed");
  });

  it("keeps an unclassifiable refusal a protocol error rather than a guessed kind", async () => {
    const daemon = await emulator();
    daemon.failNext({
      method: "POST",
      pathIncludes: "/sandbox",
      status: 500,
      message: "the control plane fell over",
    });
    const provider = await providerOver(daemon);

    await expect(provider.ensure(computer)).rejects.toBeInstanceOf(DaytonaProtocolError);
  });
});

describe("the Daytona computer provider lifecycle", () => {
  it("bounds boot and reports timed_out when the sandbox never becomes ready", async () => {
    const daemon = await emulator();
    daemon.stallBoot(200);
    const provider = await providerOver(daemon, { bootTimeoutMs: 20 });

    const failure = await failureFrom(provider.ensure(computer));

    expect(failure.kind).toBe("timed_out");
    expect(failure.detail?.trim()).not.toBe("");
  });

  it("adopts a sandbox that became ready before the boot budget expired", async () => {
    const daemon = await emulator();
    daemon.stallBoot(5);
    const provider = await providerOver(daemon, { bootTimeoutMs: 500 });

    await expect(provider.ensure(computer)).resolves.toMatchObject({ state: "running" });
  });

  it("applies per-bot ceilings to the create request", async () => {
    const daemon = await emulator();
    const provider = await providerOver(daemon, {
      ceilings: (ref) =>
        ref.computerId === computer.computerId ? { cpus: 2, memoryMb: 4_096, diskMb: 8_192 } : {},
    });

    await provider.ensure(computer);
    await provider.ensure(otherComputer);

    const creates = daemon.requests
      .filter((entry) => entry.method === "POST" && entry.path === "/api/sandbox")
      .map((entry) => entry.body as Record<string, unknown>);

    expect(creates[0]).toMatchObject({ cpu: 2, memory: 4, disk: 8 });
    // The default share is the shell-shaped one, which Daytona rounds up to
    // its one-gibibyte floor rather than refusing.
    expect(creates[1]).toMatchObject({ cpu: 1, memory: 1, disk: 10 });
  });

  it("snapshots a parked machine by waking it, and restores the home", async () => {
    const daemon = await emulator();
    const provider = await providerOver(daemon);
    await provider.ensure(computer);
    await provider.exec({
      computer,
      command: "printf 'kept' > /home/agent/keep.txt",
      timeoutMs: 2_000,
    });
    await provider.stop(computer);

    const snapshot = await provider.snapshot(computer);

    await provider.destroy(computer);
    await expect(provider.restore(computer, snapshot)).resolves.toMatchObject({
      state: "running",
    });
    await expect(
      provider.exec({ computer, command: "cat /home/agent/keep.txt", timeoutMs: 2_000 }),
    ).resolves.toMatchObject({ stdout: "kept" });
  });

  it("reports stdout and stderr separately through the toolbox", async () => {
    const daemon = await emulator();
    const provider = await providerOver(daemon);
    await provider.ensure(computer);

    const result = await provider.exec({
      computer,
      command: "printf 'out' && cat /home/agent/missing.txt",
      timeoutMs: 2_000,
    });

    expect(result.stdout).toBe("out");
    expect(result.stderr).toContain("No such file or directory");
    expect(result.exitCode).not.toBe(0);
  });

  it("rejects an unusable per-bot ceiling as a caller bug", async () => {
    const daemon = await emulator();

    await expect(providerOver(daemon, { ceilings: { cpus: 0 } })).rejects.toThrow(RangeError);
  });
});
