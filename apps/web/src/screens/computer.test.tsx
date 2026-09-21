// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComputerState } from "../computer.ts";
import { ComputerScreen } from "./computer.tsx";
import { fakeBot, fakeProvider, fakeSnapshot } from "../../test/fakes.ts";

/**
 * The computer screen in a real DOM: the screen tab is a window frame whose
 * body states plainly where no live view exists, the lifecycle control's menu
 * states what each verb does and the destructive pair confirms, the terminal
 * and file views are tabs beside the screen, the provider sheet answers what
 * each kind is and why one is unavailable, and a snapshot arms its restore.
 *
 * The fixture is the state a loaded controller would hand over, so no network
 * and no controller is involved — the screen is a function of its props. The
 * register's sheet and dialogs portal into `document.body`, so the queries
 * read the body rather than the mount div.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function state(overrides: Partial<ComputerState> = {}): ComputerState {
  return {
    status: "ready",
    refusal: null,
    bot: fakeBot("bot-1", "Ada"),
    providers: {
      defaultKind: "offline",
      providers: [fakeProvider(), fakeProvider({ kind: "docker" })],
    },
    computer: { assigned: false },
    snapshots: [],
    candidate: null,
    pending: null,
    notice: null,
    terminal: { pending: false, entries: [] },
    files: { path: null, entries: [], preview: null, pending: false, refusal: null },
    ...overrides,
  };
}

function screenProps(state: ComputerState) {
  return {
    state,
    onReload: vi.fn(),
    onChoose: vi.fn(),
    onCancel: vi.fn(),
    onConfirm: vi.fn(async () => undefined),
    onSnapshot: vi.fn(async () => undefined),
    onRestore: vi.fn(async () => undefined),
    onLifecycle: vi.fn(async () => undefined),
    onRun: vi.fn(async () => undefined),
    onOpenDirectory: vi.fn(async () => undefined),
    onOpenFile: vi.fn(async () => undefined),
    onOpenParent: vi.fn(async () => undefined),
  };
}

/** Sets a controlled input's value the way React's onChange reads it. */
function setValue(input: Element, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

/** Every button on the page: the mount div and the register's portals alike. */
function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")];
}

function buttonWith(label: string): HTMLButtonElement {
  const button = buttons().find((candidate) => candidate.textContent === label);

  if (button === undefined) {
    throw new Error(`no button labelled "${label}"`);
  }

  return button;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

/** Opens the lifecycle control's menu and returns the item the label names. */
async function menuItem(trigger: string, item: string): Promise<HTMLButtonElement> {
  await click(buttonWith(trigger));

  return buttonWith(item);
}

function radios(): HTMLInputElement[] {
  return [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
}

async function openProviderSheet(): Promise<void> {
  await click(buttonWith("Change"));
}

describe("the screen surface", () => {
  it("renders the machine's state as a word, not a sentence", async () => {
    await render(
      <ComputerScreen
        {...screenProps(
          state({
            bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
            computer: { assigned: true, state: "running" },
          }),
        )}
      />,
    );

    expect(document.body.querySelector(".computer-view-state")?.textContent).toBe("Running");
    expect(document.body.textContent).not.toContain("The machine is running.");
  });

  it("states plainly that no live view exists where frames do not", async () => {
    await render(
      <ComputerScreen
        {...screenProps(
          state({
            bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
            computer: { assigned: true, state: "running" },
          }),
        )}
      />,
    );

    expect(document.body.textContent).toContain("No live view");
    expect(document.body.querySelector(".computer-frame")).not.toBeNull();
    // No provider offers frames in v1.0, so the surface renders no control
    // that would answer the supervisor's `not_implemented`.
    expect(buttons().some((button) => button.textContent === "Take control")).toBe(false);
  });

  it("says there is no machine yet for a bot that has never run", async () => {
    await render(<ComputerScreen {...screenProps(state())} />);

    expect(document.body.querySelector(".computer-view-state")?.textContent).toBe("No machine");
    expect(document.body.textContent).toContain("It is created the first time this bot runs.");
  });
});

describe("the tabs", () => {
  it("offers the screen, terminal and files, and keeps the machine's answer in each", async () => {
    const props = screenProps(
      state({
        computer: { assigned: true, state: "running" },
        terminal: {
          pending: false,
          entries: [
            { command: "echo hi", exitCode: 0, stdout: "hi\n", stderr: "", truncated: false },
          ],
        },
        files: {
          path: "",
          entries: [{ name: "notes.md", kind: "file", sizeBytes: 12 }],
          preview: null,
          pending: false,
          refusal: null,
        },
      }),
    );
    await render(<ComputerScreen {...props} />);

    for (const label of ["Screen", "Terminal", "Files"]) {
      expect(buttonWith(label)).toBeDefined();
    }

    await click(buttonWith("Terminal"));
    expect(document.body.textContent).toContain("$ echo hi");

    await click(buttonWith("Files"));
    expect(document.body.textContent).toContain("notes.md");
  });

  it("says the machine is not running rather than offering a dead terminal", async () => {
    await render(
      <ComputerScreen
        {...screenProps(
          state({
            bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
            computer: { assigned: true, state: "stopped" },
          }),
        )}
      />,
    );

    expect(document.body.textContent).toContain("Start the machine to use its terminal and files.");
    expect(document.body.querySelector(".terminal")).toBeNull();
  });
});

describe("the provider sheet", () => {
  it("marks an unavailable provider unavailable and disables its radio", async () => {
    const providers = {
      defaultKind: "offline",
      providers: [
        fakeProvider(),
        fakeProvider({ kind: "docker", available: false, failure: "auth_failed" }),
      ],
    };
    await render(<ComputerScreen {...screenProps(state({ providers }))} />);
    await openProviderSheet();

    expect(document.body.textContent).toContain("Unavailable · Credentials refused");
    expect(radios()).toHaveLength(3);
    // Offline and the deployment default are available; Docker is not.
    expect(radios().map((radio) => radio.disabled)).toEqual([false, false, true]);
  });

  it("says what each provider is beside its name", async () => {
    await render(<ComputerScreen {...screenProps(state())} />);
    await openProviderSheet();

    expect(document.body.textContent).toContain("An in-process emulator on this deployment");
    expect(document.body.textContent).toContain(
      "A container on the host that serves this deployment",
    );
  });

  it("checks the radio the bot's stored selection names", async () => {
    await render(
      <ComputerScreen
        {...screenProps(state({ bot: { ...fakeBot("bot-1", "Ada"), computerProvider: "docker" } }))}
      />,
    );
    await openProviderSheet();

    const checked = radios().find((radio) => radio.checked);

    expect(checked).toBeDefined();
    expect(checked?.closest(".provider-option")?.textContent).toContain("Local Docker");
  });

  it("warns about a stored kind the deployment no longer configures", async () => {
    await render(
      <ComputerScreen
        {...screenProps(
          state({
            bot: { ...fakeBot("bot-1", "Ada"), computerProvider: "daytona" },
            providers: { defaultKind: "offline", providers: [fakeProvider()] },
          }),
        )}
      />,
    );
    await openProviderSheet();

    expect(document.body.textContent).toContain("does not configure");
  });

  it("arms the switch and closes the sheet when a provider is chosen", async () => {
    const props = screenProps(state());
    await render(<ComputerScreen {...props} />);
    await openProviderSheet();

    const docker = radios().find((radio) =>
      radio.closest(".provider-option")?.textContent?.includes("Local Docker"),
    );

    if (docker === undefined) {
      throw new Error("the Docker radio is missing");
    }

    await click(docker);

    expect(props.onChoose).toHaveBeenCalledWith({ kind: "docker" });
    expect(document.body.querySelector(".provider-list")).toBeNull();
  });
});

describe("the switch confirmation", () => {
  it("states what does not move and offers the snapshot path for a running machine", async () => {
    const props = screenProps(
      state({
        bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
        computer: { assigned: true, state: "running" },
        candidate: { kind: "docker" },
      }),
    );
    await render(<ComputerScreen {...props} />);

    expect(document.body.textContent).toContain("does not move this bot's home");
    const snapshot = buttonWith("Take a snapshot");
    expect(snapshot.disabled).toBe(false);

    await click(snapshot);
    expect(props.onSnapshot).toHaveBeenCalledTimes(1);

    await click(buttonWith("Switch to Local Docker"));
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables the snapshot button when there is no running machine", async () => {
    await render(<ComputerScreen {...screenProps(state({ candidate: { kind: "docker" } }))} />);

    expect(buttonWith("Take a snapshot").disabled).toBe(true);
  });

  it("lets the operator cancel the armed choice", async () => {
    const props = screenProps(state({ candidate: { kind: null } }));
    await render(<ComputerScreen {...props} />);

    await click(buttonWith("Cancel"));
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("the snapshots section", () => {
  it("arms a restore confirmation that names what it replaces", async () => {
    const snapshot = fakeSnapshot({ sizeBytes: 2_048 });
    const props = screenProps(state({ snapshots: [snapshot] }));
    await render(<ComputerScreen {...props} />);

    expect(document.body.textContent).toContain("2.0 KB");

    await click(buttonWith("Restore"));
    expect(document.body.textContent).toContain("Restoring replaces this machine's home.");

    await click(buttonWith("Restore"));
    expect(props.onRestore).toHaveBeenCalledWith(snapshot.id);
  });

  it("says there is nothing captured yet", async () => {
    await render(<ComputerScreen {...screenProps(state())} />);

    expect(document.body.textContent).toContain("No snapshots yet.");
  });
});

describe("the lifecycle control", () => {
  const running = state({
    bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
    computer: { assigned: true, state: "running" },
  });

  it("states what each verb does and enables exactly what the machine allows", async () => {
    await render(<ComputerScreen {...screenProps(running)} />);

    const start = await menuItem("Running", "Start — bring the machine up");
    expect(start.disabled).toBe(true);
    expect(buttonWith("Stop — park it, keeping the home").disabled).toBe(false);
    expect(buttonWith("Reset — destroy the machine and its home").disabled).toBe(false);
    expect(buttonWith("Recover — adopt it, or create a fresh one").disabled).toBe(false);
  });

  it("enables start on a stopped machine", async () => {
    await render(
      <ComputerScreen
        {...screenProps(
          state({
            bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
            computer: { assigned: true, state: "stopped" },
          }),
        )}
      />,
    );

    await click(buttonWith("Stopped"));
    expect(buttonWith("Start — bring the machine up").disabled).toBe(false);
    expect(buttonWith("Stop — park it, keeping the home").disabled).toBe(true);
  });

  it("keeps every verb out of reach for a bot with no machine", async () => {
    await render(<ComputerScreen {...screenProps(state())} />);

    await click(buttonWith("No machine"));

    for (const label of [
      "Start — bring the machine up",
      "Stop — park it, keeping the home",
      "Reset — destroy the machine and its home",
      "Recover — adopt it, or create a fresh one",
    ]) {
      expect(buttonWith(label).disabled).toBe(true);
    }
  });

  it("runs a plain verb on selection", async () => {
    const props = screenProps(running);
    await render(<ComputerScreen {...props} />);

    const stop = await menuItem("Running", "Stop — park it, keeping the home");
    await click(stop);

    expect(props.onLifecycle).toHaveBeenCalledWith("stop");
  });

  it("confirms a reset and names what is destroyed", async () => {
    const props = screenProps({ ...running, snapshots: [fakeSnapshot()] });
    await render(<ComputerScreen {...props} />);

    const reset = await menuItem("Running", "Reset — destroy the machine and its home");
    await click(reset);

    expect(document.body.textContent).toContain("Snapshots are kept");

    await click(buttonWith("Reset the machine"));
    expect(props.onLifecycle).toHaveBeenCalledWith("reset");
  });

  it("confirms a recover and names the empty home it can create", async () => {
    const props = screenProps(running);
    await render(<ComputerScreen {...props} />);

    const recover = await menuItem("Running", "Recover — adopt it, or create a fresh one");
    await click(recover);

    expect(document.body.textContent).toContain("empty home");

    await click(buttonWith("Recover the machine"));
    expect(props.onLifecycle).toHaveBeenCalledWith("recover");
  });
});

describe("the terminal", () => {
  it("submits the typed command and renders the machine's answer", async () => {
    const props = screenProps(
      state({
        computer: { assigned: true, state: "running" },
        terminal: {
          pending: false,
          entries: [
            { command: "echo hi", exitCode: 0, stdout: "hi\n", stderr: "", truncated: false },
            { command: "nope", exitCode: 1, stdout: "", stderr: "not found\n", truncated: false },
          ],
        },
      }),
    );
    await render(<ComputerScreen {...props} />);
    await click(buttonWith("Terminal"));

    expect(document.body.textContent).toContain("$ echo hi");
    expect(document.body.textContent).toContain("not found");
    expect(document.body.textContent).toContain("Exit code 1");

    const input = document.body.querySelector<HTMLInputElement>(".terminal-form input");
    const form = document.body.querySelector<HTMLFormElement>(".terminal-form");
    expect(input).not.toBeNull();
    expect(form).not.toBeNull();

    await act(async () => {
      setValue(input as HTMLInputElement, "ls");
    });
    await act(async () => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(props.onRun).toHaveBeenCalledWith("ls");
  });

  it("says there is nothing to show before the first command", async () => {
    await render(
      <ComputerScreen
        {...screenProps(state({ computer: { assigned: true, state: "running" } }))}
      />,
    );
    await click(buttonWith("Terminal"));

    expect(document.body.textContent).toContain("No commands run yet.");
  });
});

describe("the file view", () => {
  const entries = [
    { name: "notes.md", kind: "file" as const, sizeBytes: 12 },
    { name: "projects", kind: "directory" as const, sizeBytes: 0 },
  ];

  it("lists the home, opens a directory, and previews a file", async () => {
    const props = screenProps(
      state({
        computer: { assigned: true, state: "running" },
        files: { path: "", entries, preview: null, pending: false, refusal: null },
      }),
    );
    await render(<ComputerScreen {...props} />);
    await click(buttonWith("Files"));

    expect(document.body.textContent).toContain("Home");
    expect(buttonWith("Up").disabled).toBe(true);

    await click(buttonWith("projects/"));
    expect(props.onOpenDirectory).toHaveBeenCalledWith(entries[1]);

    await click(buttonWith("notes.md"));
    expect(props.onOpenFile).toHaveBeenCalledWith(entries[0]);
  });

  it("renders a preview, its truncation, and the up control inside a directory", async () => {
    const props = screenProps(
      state({
        computer: { assigned: true, state: "running" },
        files: {
          path: "projects",
          entries: [{ name: "readme.md", kind: "file", sizeBytes: 5 }],
          preview: { path: "projects/readme.md", content: "hello", truncated: true },
          pending: false,
          refusal: null,
        },
      }),
    );
    await render(<ComputerScreen {...props} />);
    await click(buttonWith("Files"));

    expect(document.body.textContent).toContain("/projects");
    expect(document.body.textContent).toContain("hello");
    expect(document.body.textContent).toContain("Only the first part of the file is shown.");

    await click(buttonWith("Up"));
    expect(props.onOpenParent).toHaveBeenCalledTimes(1);
  });

  it("shows a refused browse beside the previous listing", async () => {
    await render(
      <ComputerScreen
        {...screenProps(
          state({
            computer: { assigned: true, state: "running" },
            files: {
              path: "",
              entries,
              preview: null,
              pending: false,
              refusal: "That directory could not be listed.",
            },
          }),
        )}
      />,
    );
    await click(buttonWith("Files"));

    expect(document.body.textContent).toContain("That directory could not be listed.");
    expect(document.body.textContent).toContain("projects/");
  });
});
