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
 * The computer settings screen in a real DOM: the provider list reads each
 * kind's readiness answer, an unavailable kind is a disabled radio rather than
 * a selection that fails later, the switch confirmation states what does not
 * move and offers the snapshot path, and the snapshots section makes a
 * restore a confirmation of its own.
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
  };
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
