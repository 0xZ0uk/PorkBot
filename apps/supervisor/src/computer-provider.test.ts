import { ComputerEmulator } from "@porkbot/adapters";
import { describe, expect, it } from "vitest";
import { createComputerProviderSelection, DEFAULT_IDLE_TIMEOUT_MS } from "./computer-provider.ts";

/**
 * The supervisor's provider configuration (slice 7.2). The process must refuse
 * to start on an unusable configuration and take the offline default when
 * nothing is configured, so these tests pin the selection, the validation and
 * the generic setting names a deployment can rely on.
 */

const computer = { computerId: "computer-1", botId: "bot-1" };

describe("the computer provider selection", () => {
  it("runs the offline emulator by default, with the default idle window", async () => {
    const selection = createComputerProviderSelection({});

    expect(selection.kind).toBe("offline");
    expect(selection.provider).toBeInstanceOf(ComputerEmulator);
    expect(selection.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    await expect(selection.provider.status(computer)).resolves.toMatchObject({ state: "gone" });
  });

  it("builds the Docker provider when the deployment names an image", () => {
    const selection = createComputerProviderSelection({
      PORKBOT_COMPUTER_PROVIDER: "docker",
      PORKBOT_COMPUTER_IMAGE: "porkbot-computer:test",
    });

    expect(selection.kind).toBe("docker");
    expect(selection.provider).not.toBeInstanceOf(ComputerEmulator);
  });

  it("refuses docker without an image rather than booting a nameless machine", () => {
    expect(() => createComputerProviderSelection({ PORKBOT_COMPUTER_PROVIDER: "docker" })).toThrow(
      /PORKBOT_COMPUTER_IMAGE/,
    );
  });

  it("refuses an unknown provider, an unknown pull policy and an unknown quota mode", () => {
    expect(() => createComputerProviderSelection({ PORKBOT_COMPUTER_PROVIDER: "podman" })).toThrow(
      /PORKBOT_COMPUTER_PROVIDER/,
    );
    expect(() =>
      createComputerProviderSelection({
        PORKBOT_COMPUTER_PROVIDER: "docker",
        PORKBOT_COMPUTER_IMAGE: "image",
        PORKBOT_COMPUTER_PULL: "sometimes",
      }),
    ).toThrow(/PORKBOT_COMPUTER_PULL/);
    expect(() =>
      createComputerProviderSelection({
        PORKBOT_COMPUTER_PROVIDER: "docker",
        PORKBOT_COMPUTER_IMAGE: "image",
        PORKBOT_COMPUTER_DISK_QUOTA: "unlimited",
      }),
    ).toThrow(/PORKBOT_COMPUTER_DISK_QUOTA/);
  });

  it("accepts fractional CPUs and refuses a zero or negative ceiling", () => {
    expect(() =>
      createComputerProviderSelection({
        PORKBOT_COMPUTER_PROVIDER: "docker",
        PORKBOT_COMPUTER_IMAGE: "image",
        PORKBOT_COMPUTER_CPUS: "0.5",
      }),
    ).not.toThrow();
    expect(() =>
      createComputerProviderSelection({
        PORKBOT_COMPUTER_PROVIDER: "docker",
        PORKBOT_COMPUTER_IMAGE: "image",
        PORKBOT_COMPUTER_CPUS: "0",
      }),
    ).toThrow(/PORKBOT_COMPUTER_CPUS/);
    expect(() =>
      createComputerProviderSelection({
        PORKBOT_COMPUTER_PROVIDER: "docker",
        PORKBOT_COMPUTER_IMAGE: "image",
        PORKBOT_COMPUTER_MEMORY_MB: "-1",
      }),
    ).toThrow(/PORKBOT_COMPUTER_MEMORY_MB/);
  });

  it("lets an operator disable the idle sweep with zero and refuses a negative window", () => {
    expect(createComputerProviderSelection({ PORKBOT_COMPUTER_IDLE_MS: "0" }).idleTimeoutMs).toBe(
      0,
    );
    expect(() => createComputerProviderSelection({ PORKBOT_COMPUTER_IDLE_MS: "-5" })).toThrow(
      /PORKBOT_COMPUTER_IDLE_MS/,
    );
  });
});
