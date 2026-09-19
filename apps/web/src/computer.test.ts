import { describe, expect, it } from "vitest";
import {
  createComputerController,
  switchWarning,
  switchOutcome,
  effectiveKind,
  selectionUnconfigured,
  availabilityOf,
} from "./computer.ts";
import type { ComputerController, ComputerState } from "./computer.ts";
import { fakeBot, fakeProvider, fakeSnapshot, scriptedComputerTransport } from "../test/fakes.ts";

/**
 * The computer settings controller without a DOM: the read, the readiness
 * answers and the write rules the screen depends on. The tests pin what a
 * person observes — an unavailable provider rendered as unavailable, a switch
 * that says what does not move, the snapshot path that makes files cross a
 * provider change, and the outcome sentence after the write — rather than the
 * transport's shape.
 */

async function until(
  controller: ComputerController,
  predicate: (state: ComputerState) => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate(controller.state())) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`timed out waiting for ${label}`);
}

function loaded(transport: ReturnType<typeof scriptedComputerTransport>): ComputerController {
  const controller = createComputerController({ transport, botId: "bot-1" });
  controller.load();

  return controller;
}

describe("loading the screen", () => {
  it("reads the bot, the deployment's providers, the machine and its snapshots in one pass", async () => {
    const controller = loaded(
      scriptedComputerTransport({
        bot: fakeBot("bot-1", "Ada"),
        snapshots: [fakeSnapshot()],
      }),
    );

    await until(controller, (state) => state.status === "ready", "the read");
    expect(controller.state().providers?.defaultKind).toBe("offline");
    expect(controller.state().snapshots).toHaveLength(1);
    expect(effectiveKind(controller.state())).toBe("offline");
  });

  it("shows a refusal sentence when the read cannot be made", async () => {
    const controller = loaded(scriptedComputerTransport({ listFailure: new Error("unreachable") }));

    await until(controller, (state) => state.status === "refused", "the refusal");
    expect(controller.state().refusal).toBe("The computer settings could not be loaded.");
  });
});

describe("the readiness read", () => {
  it("renders an unavailable provider's classified reason and the effective selection", () => {
    expect(availabilityOf(fakeProvider({ available: false, failure: "auth_failed" }))).toBe(
      "Unavailable · Credentials refused",
    );
    expect(availabilityOf(fakeProvider({ available: false, failure: "rate_limited" }))).toBe(
      "Unavailable · Rate limited",
    );
    expect(availabilityOf(fakeProvider({ available: false, failure: null }))).toBe("Unavailable");
    expect(availabilityOf(fakeProvider())).toBe("Available");
  });
});

describe("choosing a provider", () => {
  it("distinguishes following the deployment default from a named kind", async () => {
    const controller = loaded(
      scriptedComputerTransport({
        bot: { ...fakeBot("bot-1", "Ada"), computerProvider: "docker" },
      }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    expect(effectiveKind(controller.state())).toBe("docker");

    controller.choose({ kind: null });
    expect(controller.state().candidate).toEqual({ kind: null });

    controller.cancel();
    expect(controller.state().candidate).toBeNull();
  });

  it("arms nothing when the operator picks the selection the bot already stores", async () => {
    const controller = loaded(
      scriptedComputerTransport({
        bot: { ...fakeBot("bot-1", "Ada"), computerProvider: "offline" },
      }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    controller.choose({ kind: "offline" });
    expect(controller.state().candidate).toBeNull();
  });

  it("stores the confirmed choice and reports the outcome", async () => {
    const controller = loaded(scriptedComputerTransport());
    await until(controller, (state) => state.status === "ready", "the read");

    controller.choose({ kind: "docker" });
    await controller.confirm();

    await until(
      controller,
      (state) => state.bot?.computerProvider === "docker",
      "the provider write",
    );
    expect(controller.state().candidate).toBeNull();
    expect(controller.state().notice?.text).toBe(switchOutcome({ kind: "docker" }));
  });

  it("keeps the list and shows an error when the write is refused", async () => {
    const controller = loaded(scriptedComputerTransport({ writeFailure: new Error("refused") }));
    await until(controller, (state) => state.status === "ready", "the read");

    controller.choose({ kind: "docker" });
    await controller.confirm();

    expect(controller.state().notice).toEqual({
      kind: "error",
      text: "The change could not be saved.",
    });
    expect(controller.state().bot?.computerProvider).toBeNull();
  });

  it("flags a stored kind this deployment no longer configures", async () => {
    const controller = loaded(
      scriptedComputerTransport({
        bot: { ...fakeBot("bot-1", "Ada"), computerProvider: "daytona" },
        providers: { defaultKind: "offline", providers: [fakeProvider()] },
      }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    expect(selectionUnconfigured(controller.state())).toBe(true);
    expect(effectiveKind(controller.state())).toBe("daytona");
  });
});

describe("the switch warning", () => {
  const assigned = {
    bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
    computer: { assigned: true as const, state: "running" as const },
    snapshots: [],
  };

  it("names the home and the snapshot path for a bot with a machine", () => {
    expect(switchWarning(assigned, { kind: "docker" })).toBe(
      "Switching to Local Docker does not move this bot's home or apply a snapshot. Take a snapshot first to bring the files across, then restore it once the machine runs on Local Docker.",
    );
  });

  it("says there is nothing to move for a bot with no machine and no snapshots", () => {
    expect(
      switchWarning(
        { bot: fakeBot("bot-1", "Ada"), computer: { assigned: false }, snapshots: [] },
        { kind: null },
      ),
    ).toContain("There is no home or snapshot to move.");
  });

  it("points at snapshots that stay in this space when there is no machine", () => {
    expect(
      switchWarning(
        {
          bot: fakeBot("bot-1", "Ada"),
          computer: { assigned: false },
          snapshots: [fakeSnapshot()],
        },
        { kind: "docker" },
      ),
    ).toContain("Snapshots stay in this space and can be restored");
  });

  it("says the home is already gone when the machine is gone", () => {
    expect(
      switchWarning(
        {
          bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
          computer: { assigned: true, state: "gone" },
          snapshots: [],
        },
        { kind: "docker" },
      ),
    ).toContain("the current machine no longer exists");
  });
});

describe("the snapshot path", () => {
  it("captures a snapshot and appends it to the list", async () => {
    const controller = loaded(scriptedComputerTransport());
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.snapshot();

    await until(controller, (state) => state.snapshots.length === 1, "the capture");
    expect(controller.state().notice?.text).toBe(
      "Snapshot captured. Switch, then restore it into the new machine.",
    );
  });

  it("restores a snapshot into the machine and reports it", async () => {
    const controller = loaded(scriptedComputerTransport({ snapshots: [fakeSnapshot()] }));
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.restore(fakeSnapshot().id);

    await until(controller, (state) => state.computer?.assigned === true, "the restore");
    expect(controller.state().notice?.text).toBe("Snapshot restored into this bot's machine.");
  });

  it("keeps the snapshot list and shows an error when a restore is refused", async () => {
    const controller = loaded(
      scriptedComputerTransport({
        snapshots: [fakeSnapshot()],
        writeFailure: new Error("refused"),
      }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.restore(fakeSnapshot().id);

    expect(controller.state().notice).toEqual({
      kind: "error",
      text: "The change could not be saved.",
    });
    expect(controller.state().snapshots).toHaveLength(1);
  });
});
