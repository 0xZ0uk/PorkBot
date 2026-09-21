// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeRoutine, fakeRoutineOutcome } from "../../test/fakes.ts";
import type { RoutinesScreenProps } from "./routines.tsx";
import { RoutinesScreen } from "./routines.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function props(overrides: Partial<RoutinesScreenProps> = {}): RoutinesScreenProps {
  return {
    botId: "bot-1",
    routines: [fakeRoutine()],
    outcomes: {
      "routine-1": [
        fakeRoutineOutcome(),
        fakeRoutineOutcome({
          occurrenceId: "occurrence-2",
          scheduledFor: "2026-01-01T09:00:00.000Z",
          status: "missed",
          runId: null,
        }),
      ],
    },
    creating: false,
    editingRoutineId: null,
    pending: null,
    notice: null,
    preview: { status: "idle", fireTimes: [], message: null },
    onCreateOpen: vi.fn(),
    onEdit: vi.fn(),
    onCloseEditor: vi.fn(),
    onPreview: vi.fn(),
    onCreate: vi.fn(async () => true),
    onUpdate: vi.fn(async () => true),
    onToggle: vi.fn(),
    onRemove: vi.fn(),
    onTestRun: vi.fn(async () => ({ runId: "run-test-1", threadId: "thread-routine-1" })),
    ...overrides,
  };
}

function button(text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );

  if (found === undefined) {
    throw new Error(`missing button ${text}`);
  }

  return found;
}

describe("routines screen", () => {
  it("shows the schedule in words, state, last outcome and ledger links", async () => {
    await act(async () => root.render(<RoutinesScreen {...props()} />));

    expect(container.textContent).toContain("Weekdays at 09:00 · UTC");
    expect(container.textContent).toContain("Enabled");
    expect(container.textContent).toContain("Succeeded");
    expect(container.textContent).toContain("Missed");
    expect(container.textContent).toContain("No run was created for this slot.");
    expect(
      container.querySelector("a[href='/bots/bot-1/threads/thread-routine-1?run=run-routine-1']"),
    ).not.toBeNull();
  });

  it("surfaces a manual test run with a link to its thread", async () => {
    const screen = props();
    await act(async () => root.render(<RoutinesScreen {...screen} />));

    await act(async () => button("Test run").click());

    expect(screen.onTestRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: "routine-1" }),
      expect.stringMatching(/^routine-test:/),
    );
    expect(container.textContent).toContain("Test run started.");
    expect(container.textContent).toContain("Open the test run");
  });

  it("wires edit, pause, re-enable and tombstone actions", async () => {
    const screen = props();
    await act(async () => root.render(<RoutinesScreen {...screen} />));

    await act(async () => button("Edit").click());
    expect(screen.onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: "routine-1" }));

    await act(async () => button("Pause").click());
    expect(screen.onToggle).toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));

    await act(async () => button("Remove").click());
    expect(container.textContent).toContain("Future fires will stop");

    await act(async () => button("Remove routine").click());
    expect(screen.onRemove).toHaveBeenCalledWith(expect.objectContaining({ id: "routine-1" }));

    await act(async () =>
      root.render(<RoutinesScreen {...screen} routines={[fakeRoutine({ enabled: false })]} />),
    );
    await act(async () => button("Re-enable").click());
    expect(screen.onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it("keeps schedule previews and invalid reasons visible in the editor", async () => {
    const screen = props({
      routines: [],
      creating: true,
      preview: {
        status: "ready",
        fireTimes: ["2026-01-05T09:00:00.000Z"],
        message: null,
      },
    });
    await act(async () => root.render(<RoutinesScreen {...screen} />));

    expect(container.textContent).toContain("Next fires");
    expect(container.textContent).toContain("2026");
    expect(container.querySelector("textarea")).not.toBeNull();
    expect(container.querySelector("input")?.getAttribute("aria-invalid")).toBeNull();

    const cron = [...container.querySelectorAll<HTMLInputElement>("input")].find(
      (input) => input.value === "0 9 * * 1-5",
    );

    if (cron === undefined) {
      throw new Error("missing cron field");
    }

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

    await act(async () => {
      setter?.call(cron, "0 10 * * 1-5");
      cron.dispatchEvent(new Event("input", { bubbles: true }));
    });

    expect(screen.onPreview).toHaveBeenCalledWith({
      cron: "0 10 * * 1-5",
      timezone: "UTC",
      count: 5,
    });
  });

  it("requires an instruction before creating a routine", async () => {
    const screen = props({ routines: [], creating: true });
    await act(async () => root.render(<RoutinesScreen {...screen} />));

    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true }));
    });

    expect(container.textContent).toContain("Describe the work this routine should start.");
    expect(screen.onCreate).not.toHaveBeenCalled();
  });
});
