// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import type { Approval } from "@porkbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "../router.tsx";
import { createSessionController } from "../session.ts";
import type { AuthTransport, SessionActor } from "../session.ts";
import type { ApprovalTransport } from "../transport.ts";
import {
  fakeBot,
  scriptedBotsTransport,
  scriptedComputerTransport,
  scriptedConnectionsTransport,
  scriptedMemoryTransport,
  scriptedThreadTransport,
  scriptedUsageTransport,
} from "../../test/fakes.ts";

/**
 * The workspace shell, in a real DOM and a real router: the rail's active row,
 * the search, the waiting count, the inspector's collapse and its persistence,
 * and the narrow layout's switcher. The route it renders under is a bot's
 * computer screen — any bot-scoped route would do, and this one needs only the
 * scripted computer transport.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

function fakeAuth(): AuthTransport {
  return {
    currentActor: async () => actor,
    signIn: vi.fn(async () => undefined),
    signUp: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    signupAvailability: vi.fn(async () => "open" as const),
  };
}

function pendingApproval(botId: string): Approval {
  return {
    id: `approval-${botId}`,
    botId,
    threadId: "thread-1",
    runId: "run-1",
    callId: "call-1",
    tool: "web_fetch",
    arguments: { url: "https://example.invalid" },
    status: "pending",
    expiresAt: "2026-01-01T00:05:00.000Z",
    decidedBy: null,
    decidedAt: null,
    reason: null,
  };
}

function appAt(path: string, approvals?: readonly Approval[]) {
  const roster = [fakeBot("bot-1", "Ada"), fakeBot("bot-2", "Ledger")];
  const threads = scriptedThreadTransport({ bots: roster });
  const bots = scriptedBotsTransport(threads);
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const approvalTransport: ApprovalTransport | undefined =
    approvals === undefined
      ? undefined
      : {
          list: async () => approvals,
          decide: async () => {
            throw new Error("not exercised by this test");
          },
        };

  return createAppRouter(
    {
      auth,
      session,
      bots: {
        ...bots,
        getBot: async (botId) => {
          const bot = roster.find((candidate) => candidate.id === botId);

          if (bot === undefined) {
            throw new Error("no such bot");
          }

          return bot;
        },
      },
      threads,
      memory: scriptedMemoryTransport(),
      usage: scriptedUsageTransport(),
      connections: scriptedConnectionsTransport(),
      computer: scriptedComputerTransport({ bot: fakeBot("bot-1", "Ada") }),
      ...(approvalTransport === undefined ? {} : { approvals: approvalTransport }),
    },
    createMemoryHistory({ initialEntries: [path] }),
  );
}

/**
 * The root mounts in a div beside `document.body`, not inside it. React portals
 * the register's sheet into `document.body`, and a jsdom-only React 19 bug
 * spins in `dispatchEventForPluginEventSystem` when the portal's container is
 * an ancestor of the root container and focus moves into the portal; the
 * built app hydrates the document and does not have that relationship.
 */
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom logs "not implemented" for the router's scroll restoration.
  window.scrollTo = () => undefined;
  window.localStorage.clear();
  container = document.createElement("div");
  document.documentElement.append(container);
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

async function mount(router: ReturnType<typeof createAppRouter>): Promise<void> {
  await act(async () => {
    await router.load();
  });
  await render(<RouterProvider router={router} />);
}

function rowNamed(name: string): HTMLAnchorElement | undefined {
  return [...container.querySelectorAll<HTMLAnchorElement>('a[href^="/bots/"]')].find((row) =>
    row.textContent?.includes(name),
  );
}

function buttonByLabel(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === label,
  );

  if (found === undefined) {
    throw new Error(
      `no button labelled "${label}"; the buttons are ${JSON.stringify(
        [...container.querySelectorAll("button")].map((button) =>
          button.getAttribute("aria-label"),
        ),
      )}`,
    );
  }

  return found;
}

function setValue(element: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  const input = element as HTMLInputElement & { _valueTracker?: { setValue: (v: string) => void } };

  input._valueTracker?.setValue("");
  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function stubNarrow(narrow: boolean): void {
  (globalThis as { matchMedia?: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("max-width: 767px") ? narrow : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
}

describe("the workspace", () => {
  it("marks the rail row of the bot whose screen is open", async () => {
    const router = appAt("/bots/bot-1/computer");

    await mount(router);

    const active = container.querySelector('a[href^="/bots/"][aria-current="page"]');

    expect(active?.textContent).toContain("Ada");
    expect(rowNamed("Ledger")?.getAttribute("aria-current")).toBeNull();
    expect(container.querySelector("#main .text-heading")?.textContent).toBe("Ada");
    expect(container.querySelector('[data-side="right"] .text-heading')?.textContent).toBe("Ada");
  });

  it("filters the roster from the search field", async () => {
    const router = appAt("/bots/bot-1/computer");

    await mount(router);

    const search = container.querySelector<HTMLInputElement>('input[type="search"]');

    if (search === null) {
      throw new Error("the search field is missing");
    }

    await act(async () => {
      setValue(search, "ledg");
    });

    expect([...container.querySelectorAll("[data-name]")].map((name) => name.textContent)).toEqual([
      "Ledger",
    ]);

    await act(async () => {
      const again = container.querySelector<HTMLInputElement>('input[type="search"]') ?? search;
      setValue(again, "nobody");
      again.dispatchEvent(new Event("change", { bubbles: true }));
    });

    expect(container.textContent).toContain("No bots match.");
  });

  it("collapses the inspector and remembers the choice across mounts", async () => {
    const router = appAt("/bots/bot-1/computer");

    await mount(router);
    expect(container.querySelector('[data-side="right"][data-state="expanded"]')).not.toBeNull();

    await act(async () => {
      buttonByLabel("Hide bot context")?.click();
    });

    expect(container.querySelector('[data-side="right"][data-state="expanded"]')).toBeNull();
    expect(window.localStorage.getItem("porkbot.inspector")).toBe("collapsed");

    // A navigation does not reopen it.
    await act(async () => {
      await router.navigate({ to: "/bots/$botId/computer", params: { botId: "bot-1" } });
    });
    expect(container.querySelector('[data-side="right"][data-state="expanded"]')).toBeNull();

    // A fresh mount reads the stored choice.
    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);
    await render(<RouterProvider router={router} />);
    expect(container.querySelector('[data-side="right"][data-state="expanded"]')).toBeNull();

    await act(async () => {
      buttonByLabel("Show bot context")?.click();
    });

    expect(container.querySelector('[data-side="right"][data-state="expanded"]')).not.toBeNull();
    expect(window.localStorage.getItem("porkbot.inspector")).toBe("expanded");
  });

  it("shows what is waiting for you in the rail, the header and the inspector", async () => {
    const router = appAt("/bots/bot-1/computer", [pendingApproval("bot-1")]);

    await mount(router);

    expect(rowNamed("Ada")?.textContent).toContain("1");
    expect(container.querySelector('#main [data-state="waiting"]')).not.toBeNull();
    expect(container.querySelector('nav[aria-label="Workspace"]')?.textContent).toContain("1");
    expect(container.textContent).toContain("1 action is waiting for you.");
  });

  it("renders the footer's single trips as register rows, not bare anchors", async () => {
    const router = appAt("/bots/bot-1/computer");

    await mount(router);

    const footer = container.querySelector('nav[aria-label="Workspace"]');

    expect(footer).not.toBeNull();

    for (const label of ["Approvals", "Settings", "Sign out"]) {
      const row = [...(footer?.querySelectorAll<HTMLElement>("a, button") ?? [])].find((entry) =>
        entry.textContent?.includes(label),
      );

      expect(row, label).toBeDefined();
      expect(row?.querySelector("svg"), label).not.toBeNull();
    }

    expect(container.querySelector(".app-header")).toBeNull();
  });

  it("shows one pane at a time below 64rem with a working switcher", async () => {
    stubNarrow(true);
    const router = appAt("/bots/bot-1/computer");

    await mount(router);

    expect(container.querySelector('[data-side="left"][data-state="expanded"]')).toBeNull();
    expect(container.querySelector('[data-side="right"][data-state="expanded"]')).toBeNull();
    expect(container.querySelector("#main")).not.toBeNull();

    const switcher = buttonByLabel("Switch bot");

    await act(async () => {
      switcher.click();
    });

    const sheet = document.body.querySelector("[role='dialog']");

    expect(sheet?.getAttribute("role")).toBe("dialog");
    expect(document.querySelector('[aria-label="Bots"]')).not.toBeNull();
    expect(sheet?.textContent).toContain("Ledger");

    const ledger = [
      ...(sheet?.querySelectorAll<HTMLAnchorElement>('a[href^="/bots/"]') ?? []),
    ].find((row) => row.textContent?.includes("Ledger"));

    await act(async () => {
      ledger?.click();
    });

    expect(document.body.querySelector("[role='dialog']")).toBeNull();
    expect(router.state.location.pathname).toBe("/bots/bot-2");

    const toggle = buttonByLabel("Show bot context");

    await act(async () => {
      toggle.click();
    });

    const inspectorSheet = document.body.querySelector("[role='dialog']");

    expect(inspectorSheet?.textContent).toContain("Ledger");
    expect(inspectorSheet?.textContent).toContain("Screens");

    await act(async () => {
      inspectorSheet?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(document.body.querySelector("[role='dialog']")).toBeNull();

    delete (globalThis as { matchMedia?: unknown }).matchMedia;
  });
});
