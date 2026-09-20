import { describe, expect, it } from "vitest";
import {
  canBrowse,
  createComputerController,
  switchWarning,
  switchOutcome,
  effectiveKind,
  lifecycleOutcome,
  MAX_TERMINAL_ENTRIES,
  resetWarning,
  selectionUnconfigured,
  availabilityOf,
} from "./computer.ts";
import type { ComputerController, ComputerState, ComputerTransport } from "./computer.ts";
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

describe("the machine controls", () => {
  it("starts a stopped machine, stops a running one, and reports each outcome", async () => {
    const controller = loaded(
      scriptedComputerTransport({ computer: { assigned: true, state: "stopped" } }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    // A stopped machine has no shell to point the file view at.
    expect(canBrowse(controller.state())).toBe(false);

    await controller.lifecycle("boot");

    await until(
      controller,
      (state) => state.computer?.assigned === true && state.computer.state === "running",
      "the start",
    );
    expect(controller.state().notice?.text).toBe(lifecycleOutcome("boot"));

    await controller.lifecycle("stop");

    await until(
      controller,
      (state) => state.computer?.assigned === true && state.computer.state === "stopped",
      "the stop",
    );
  });

  it("resets the machine and says what it destroyed", async () => {
    const controller = loaded(
      scriptedComputerTransport({ computer: { assigned: true, state: "stopped" } }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.lifecycle("reset");

    await until(
      controller,
      (state) => state.computer?.assigned === true && state.computer.state === "running",
      "the reset",
    );
    expect(controller.state().notice?.text).toBe(lifecycleOutcome("reset"));
  });

  it("shows an error when a lifecycle write is refused", async () => {
    const controller = loaded(
      scriptedComputerTransport({
        computer: { assigned: true, state: "running" },
        writeFailure: new Error("refused"),
      }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.lifecycle("stop");

    expect(controller.state().notice).toEqual({
      kind: "error",
      text: "The change could not be saved.",
    });
  });
});

describe("the reset warning", () => {
  it("says the home is gone and snapshots are kept when there are any", () => {
    expect(resetWarning({ snapshots: [fakeSnapshot()] })).toContain("Snapshots are kept");
  });

  it("says nothing is snapshotted when there is nothing to restore", () => {
    expect(resetWarning({ snapshots: [] })).toContain("nothing is snapshotted");
  });
});

describe("the terminal", () => {
  it("appends each command's answer in the order they ran", async () => {
    const controller = loaded(
      scriptedComputerTransport({ computer: { assigned: true, state: "running" } }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.run("echo hi");

    await until(controller, (state) => state.terminal.entries.length === 1, "the command");
    expect(controller.state().terminal.entries[0]).toEqual({
      command: "echo hi",
      exitCode: 0,
      stdout: "ran: echo hi\n",
      stderr: "",
      truncated: false,
    });
  });

  it("does not call the transport for a blank command", async () => {
    const controller = loaded(
      scriptedComputerTransport({ computer: { assigned: true, state: "running" } }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.run("   ");

    expect(controller.state().terminal.entries).toEqual([]);
  });

  it("keeps the history and shows an error when a command is refused", async () => {
    const controller = loaded(
      scriptedComputerTransport({
        computer: { assigned: true, state: "running" },
        browseFailure: new Error("refused"),
      }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    await controller.run("echo hi");

    expect(controller.state().terminal.entries).toEqual([]);
    expect(controller.state().notice).toEqual({
      kind: "error",
      text: "The command could not be run.",
    });
  });
});

describe("the file view", () => {
  const directories = {
    "": [
      { name: "notes.md", kind: "file" as const, sizeBytes: 12 },
      { name: "projects", kind: "directory" as const, sizeBytes: 0 },
    ],
    projects: [{ name: "readme.md", kind: "file" as const, sizeBytes: 5 }],
  };
  const files = { "notes.md": "# Notes\n", "projects/readme.md": "hello" };

  it("lists the home as part of a read of a running machine", async () => {
    const controller = loaded(
      scriptedComputerTransport({ computer: { assigned: true, state: "running" }, directories }),
    );

    await until(controller, (state) => state.files.path === "", "the home listing");
    expect(controller.state().files.entries.map((entry) => entry.name)).toEqual([
      "notes.md",
      "projects",
    ]);
  });

  it("opens a directory, reads one of its files, and returns to the parent", async () => {
    const controller = loaded(
      scriptedComputerTransport({
        computer: { assigned: true, state: "running" },
        directories,
        files,
      }),
    );
    await until(controller, (state) => state.files.path === "", "the home listing");

    const directory = controller.state().files.entries.find((entry) => entry.name === "projects");

    if (directory === undefined) {
      throw new Error("the projects directory is missing from the listing");
    }

    await controller.openDirectory(directory);

    await until(controller, (state) => state.files.path === "projects", "the directory");

    const file = controller.state().files.entries.find((entry) => entry.name === "readme.md");

    if (file === undefined) {
      throw new Error("the readme file is missing from the listing");
    }

    await controller.openFile(file);

    await until(controller, (state) => state.files.preview !== null, "the file");
    expect(controller.state().files.preview).toEqual({
      path: "projects/readme.md",
      content: "hello",
      truncated: false,
    });

    await controller.openParent();

    await until(controller, (state) => state.files.path === "", "the parent");
    expect(controller.state().files.preview).toBeNull();
  });

  it("keeps the previous listing and says so when a read is refused", async () => {
    const healthy = scriptedComputerTransport({
      computer: { assigned: true, state: "running" },
      directories,
    });
    let failing = false;
    const flaky: ComputerTransport = {
      ...healthy,
      files: async (input) => {
        if (failing) {
          throw new Error("refused");
        }

        return healthy.files(input);
      },
    };
    const controller = createComputerController({ transport: flaky, botId: "bot-1" });
    controller.load();

    await until(controller, (state) => state.files.path === "", "the home listing");

    // The listing was read before the machine went away; the next read fails.
    failing = true;
    await controller.openDirectory({ name: "projects", kind: "directory", sizeBytes: 0 });

    await until(
      controller,
      (state) => state.files.refusal === "That directory could not be listed.",
      "the refusal",
    );
    expect(controller.state().files.path).toBe("");
    expect(controller.state().files.entries).toHaveLength(2);
  });
});

describe("the terminal history", () => {
  it("keeps only the newest runs", async () => {
    const controller = loaded(
      scriptedComputerTransport({ computer: { assigned: true, state: "running" } }),
    );
    await until(controller, (state) => state.status === "ready", "the read");

    for (let index = 0; index < MAX_TERMINAL_ENTRIES + 2; index += 1) {
      await controller.run(`echo ${String(index)}`);
    }

    const entries = controller.state().terminal.entries;

    expect(entries).toHaveLength(MAX_TERMINAL_ENTRIES);
    expect(entries[0]?.command).toBe("echo 2");
    expect(entries.at(-1)?.command).toBe(`echo ${String(MAX_TERMINAL_ENTRIES + 1)}`);
  });
});
