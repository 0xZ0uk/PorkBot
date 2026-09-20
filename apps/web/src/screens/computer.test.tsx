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
 * The computer screen in a real DOM: the provider list reads each kind's
 * readiness answer, an unavailable kind is a disabled radio rather than a
 * selection that fails later, the switch confirmation states what does not
 * move and offers the snapshot path, the lifecycle controls enable exactly the
 * verbs the machine's state allows, reset arms a confirmation that names what
 * is lost, the terminal submits commands, and the file view navigates.
 *
 * The fixture is the state a loaded controller would hand over, so no network
 * and no controller is involved — the screen is a function of its props.
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

function buttonWith(label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );

  if (button === undefined) {
    throw new Error(`no button labelled "${label}"`);
  }

  return button;
}

function radios(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>('input[type="radio"]')];
}

describe("the provider list", () => {
  it("marks an unavailable provider unavailable and disables its radio", async () => {
    const providers = {
      defaultKind: "offline",
      providers: [
        fakeProvider(),
        fakeProvider({ kind: "docker", available: false, failure: "auth_failed" }),
      ],
    };
    await render(<ComputerScreen {...screenProps(state({ providers }))} />);

    expect(container.textContent).toContain("Unavailable · Credentials refused");
    expect(radios()).toHaveLength(3);
    // Offline and the deployment default are available; Docker is not.
    expect(radios().map((radio) => radio.disabled)).toEqual([false, false, true]);
  });

  it("checks the radio the bot's stored selection names", async () => {
    await render(
      <ComputerScreen
        {...screenProps(state({ bot: { ...fakeBot("bot-1", "Ada"), computerProvider: "docker" } }))}
      />,
    );

    const checked = radios().find((radio) => radio.checked);

    expect(checked).toBeDefined();
    expect(container.textContent).toContain("Local Docker");
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

    expect(container.textContent).toContain("does not configure");
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

    expect(container.textContent).toContain("does not move this bot's home");
    const snapshot = buttonWith("Take a snapshot");
    expect(snapshot.disabled).toBe(false);

    await act(async () => {
      snapshot.click();
    });
    expect(props.onSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      buttonWith("Switch to Local Docker").click();
    });
    expect(props.onConfirm).toHaveBeenCalledTimes(1);
  });

  it("disables the snapshot button when there is no running machine", async () => {
    await render(<ComputerScreen {...screenProps(state({ candidate: { kind: "docker" } }))} />);

    expect(buttonWith("Take a snapshot").disabled).toBe(true);
  });

  it("lets the operator cancel the armed choice", async () => {
    const props = screenProps(state({ candidate: { kind: null } }));
    await render(<ComputerScreen {...props} />);

    await act(async () => {
      buttonWith("Cancel").click();
    });
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("the snapshots section", () => {
  it("arms a restore confirmation that names what it replaces", async () => {
    const snapshot = fakeSnapshot({ sizeBytes: 2_048 });
    const props = screenProps(state({ snapshots: [snapshot] }));
    await render(<ComputerScreen {...props} />);

    expect(container.textContent).toContain("2.0 KB");

    await act(async () => {
      buttonWith("Restore").click();
    });

    expect(container.textContent).toContain("Restoring replaces this machine's home.");

    await act(async () => {
      buttonWith("Restore").click();
    });
    expect(props.onRestore).toHaveBeenCalledWith(snapshot.id);
  });

  it("says there is nothing captured yet", async () => {
    await render(<ComputerScreen {...screenProps(state())} />);

    expect(container.textContent).toContain("No snapshots yet.");
  });
});

describe("the machine controls", () => {
  it("enables exactly the verbs the machine's state allows", async () => {
    await render(
      <ComputerScreen
        {...screenProps(state({ computer: { assigned: true, state: "stopped" } }))}
      />,
    );

    expect(buttonWith("Start").disabled).toBe(false);
    expect(buttonWith("Stop").disabled).toBe(true);
    expect(buttonWith("Reset").disabled).toBe(false);
    expect(buttonWith("Recover").disabled).toBe(false);
  });

  it("disables start on a running machine and every lifecycle verb with no machine", async () => {
    await render(
      <ComputerScreen
        {...screenProps(state({ computer: { assigned: true, state: "running" } }))}
      />,
    );

    expect(buttonWith("Start").disabled).toBe(true);
    expect(buttonWith("Stop").disabled).toBe(false);

    await render(<ComputerScreen {...screenProps(state())} />);

    for (const label of ["Start", "Stop", "Reset", "Recover"]) {
      expect(buttonWith(label).disabled).toBe(true);
    }
  });

  it("arms a reset confirmation that names what is lost and runs the verb", async () => {
    const props = screenProps(
      state({ computer: { assigned: true, state: "running" }, snapshots: [fakeSnapshot()] }),
    );
    await render(<ComputerScreen {...props} />);

    await act(async () => {
      buttonWith("Reset").click();
    });

    expect(container.textContent).toContain("Snapshots are kept");

    await act(async () => {
      buttonWith("Reset the machine").click();
    });
    expect(props.onLifecycle).toHaveBeenCalledWith("reset");
  });

  it("says the machine is not running rather than offering a dead terminal", async () => {
    await render(<ComputerScreen {...screenProps(state())} />);

    expect(container.textContent).toContain("Start the machine to use its terminal and files.");
    expect(container.querySelector(".terminal")).toBeNull();
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

    expect(container.textContent).toContain("$ echo hi");
    expect(container.textContent).toContain("not found");
    expect(container.textContent).toContain("Exit code 1");

    const input = container.querySelector<HTMLInputElement>(".terminal-form input");
    const form = container.querySelector<HTMLFormElement>(".terminal-form");
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

    expect(container.textContent).toContain("No commands run yet.");
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

    expect(container.textContent).toContain("Home");
    expect(buttonWith("Up").disabled).toBe(true);

    await act(async () => {
      buttonWith("projects/").click();
    });
    expect(props.onOpenDirectory).toHaveBeenCalledWith(entries[1]);

    await act(async () => {
      buttonWith("notes.md").click();
    });
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

    expect(container.textContent).toContain("/projects");
    expect(container.textContent).toContain("hello");
    expect(container.textContent).toContain("Only the first part of the file is shown.");

    await act(async () => {
      buttonWith("Up").click();
    });
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

    expect(container.textContent).toContain("That directory could not be listed.");
    expect(container.textContent).toContain("projects/");
  });
});
