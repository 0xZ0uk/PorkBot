import { isProviderFailure } from "@porkbot/adapter-kit";
import { describe, expect, it } from "vitest";
import { createComputerProviderSelection, DEFAULT_IDLE_TIMEOUT_MS } from "./computer-provider.ts";

/**
 * The supervisor's provider configuration (slices 7.2 and 7.3). The process
 * must refuse to start on an unusable configuration and take the offline
 * default when nothing is configured, so these tests pin the selection, the
 * validation and the generic setting names a deployment can rely on. The
 * registry tests pin the per-bot routing: a reference that names a configured
 * kind reaches it, one that names nothing reaches the default, and one that
 * names an unconfigured kind is refused with the shared vocabulary.
 */

const computer = { computerId: "computer-1", botId: "bot-1" };
/** A real provider's snapshots need a storage root; no test writes through it. */
const storageRoot = "/tmp/porkbot-computer-provider-test-storage";

describe("the computer provider selection", () => {
  it("runs the offline emulator by default, with the default idle window", async () => {
    const selection = createComputerProviderSelection({});

    expect(selection.kind).toBe("offline");
    expect(selection.kinds).toEqual(["offline"]);
    expect(selection.idleTimeoutMs).toBe(DEFAULT_IDLE_TIMEOUT_MS);
    await expect(selection.provider.status(computer)).resolves.toMatchObject({ state: "gone" });
  });

  it("builds the Docker provider when the deployment names an image", () => {
    const selection = createComputerProviderSelection({
      PORKBOT_COMPUTER_PROVIDER: "docker",
      PORKBOT_COMPUTER_IMAGE: "porkbot-computer:test",
      PORKBOT_STORAGE_DIR: storageRoot,
    });

    expect(selection.kind).toBe("docker");
    expect(selection.kinds).toEqual(["offline", "docker"]);
  });

  it("refuses a real provider without a storage root for its snapshots", () => {
    expect(() =>
      createComputerProviderSelection({
        PORKBOT_COMPUTER_PROVIDER: "docker",
        PORKBOT_COMPUTER_IMAGE: "porkbot-computer:test",
      }),
    ).toThrow(/PORKBOT_STORAGE_DIR/);
  });

  it("builds the cloud provider when the deployment names an endpoint, key and image", () => {
    const selection = createComputerProviderSelection({
      PORKBOT_COMPUTER_PROVIDER: "daytona",
      PORKBOT_COMPUTER_ENDPOINT: "https://cloud.example.invalid/api",
      PORKBOT_COMPUTER_TOKEN: "test-key",
      PORKBOT_COMPUTER_IMAGE: "porkbot-computer:test",
      PORKBOT_STORAGE_DIR: storageRoot,
    });

    expect(selection.kind).toBe("daytona");
    expect(selection.kinds).toEqual(["offline", "daytona"]);
  });

  it("refuses a cloud setting that is only half configured", () => {
    expect(() =>
      createComputerProviderSelection({
        PORKBOT_COMPUTER_PROVIDER: "daytona",
        PORKBOT_COMPUTER_ENDPOINT: "https://cloud.example.invalid/api",
      }),
    ).toThrow(/PORKBOT_COMPUTER_IMAGE/);
  });

  it("routes a per-bot selection to its provider and refuses an unconfigured kind", async () => {
    const selection = createComputerProviderSelection({});

    await expect(
      selection.provider.ensure({ ...computer, provider: "offline" }),
    ).resolves.toMatchObject({ state: "running" });

    // Every provider tags the machines it lists, so reconciliation and the
    // idle sweep route a stop back to the provider that holds the machine.
    await expect(selection.provider.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ computer: expect.objectContaining({ provider: "offline" }) }),
      ]),
    );

    let refusal: unknown;

    try {
      await selection.provider.status({ ...computer, provider: "daytona" });
    } catch (error) {
      refusal = error;
    }

    expect(isProviderFailure(refusal)).toBe(true);
    expect(isProviderFailure(refusal) ? refusal.kind : undefined).toBe("not_found");
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
        PORKBOT_STORAGE_DIR: storageRoot,
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
