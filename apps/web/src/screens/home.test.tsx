// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import type { Approval, BotSection, Thread } from "@porkbot/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fakeBot,
  fakeThread,
  scriptedBotsTransport,
  scriptedComputerTransport,
  scriptedConnectionsTransport,
  scriptedMemoryTransport,
  scriptedThreadTransport,
  scriptedUsageTransport,
} from "../../test/fakes.ts";
import type { ScriptedBotsTransportOptions } from "../../test/fakes.ts";
import type { BotsTransport } from "../bots.ts";
import { createAppRouter } from "../router.tsx";
import { createSessionController } from "../session.ts";
import type { AuthTransport, SessionActor } from "../session.ts";
import type { ApprovalTransport } from "../transport.ts";

/**
 * The roster's home screen (slice 13.6), mounted through the real router so
 * the shell's loader, the row's links and its menu are the shipped ones. The
 * suite holds the three things the slice promises: one row per bot with its
 * identity, role, state and activity; the grouped list with a pinned group and
 * an archived group; and empty states that name the next action.
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

function section(id: string, name: string, position: number): BotSection {
  return {
    id,
    name,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function pendingApproval(botId: string): Approval {
  return {
    id: `approval-${botId}`,
    botId,
    threadId: `thread-${botId}`,
    runId: `run-${botId}`,
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

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom logs "not implemented" for the router's scroll restoration.
  window.scrollTo = () => undefined;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

interface MountOptions {
  readonly bots?: ScriptedBotsTransportOptions;
  readonly threads?: readonly Thread[];
  readonly approvals?: readonly Approval[];
  readonly failing?: { readonly value: boolean };
}

async function mountHome(options: MountOptions = {}): Promise<ReturnType<typeof createAppRouter>> {
  const failing = options.failing;
  const consoleTransport = scriptedThreadTransport({
    threads: options.threads ?? [],
    newThread: fakeThread("thread-new", "bot-1"),
  });
  const bots = scriptedBotsTransport(consoleTransport, options.bots);
  const guarded: BotsTransport = {
    ...bots,
    listBots: async (scope) => {
      if (failing?.value === true) {
        throw new Error("unreachable");
      }

      return bots.listBots(scope);
    },
  };
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const approvalTransport: ApprovalTransport | undefined =
    options.approvals === undefined
      ? undefined
      : {
          list: async () => options.approvals ?? [],
          decide: async () => {
            throw new Error("not exercised by this test");
          },
        };
  const router = createAppRouter(
    {
      auth,
      session,
      bots: guarded,
      threads: consoleTransport,
      memory: scriptedMemoryTransport(),
      usage: scriptedUsageTransport(),
      connections: scriptedConnectionsTransport(),
      computer: scriptedComputerTransport(),
      ...(approvalTransport === undefined ? {} : { approvals: approvalTransport }),
    },
    createMemoryHistory({ initialEntries: ["/"] }),
  );

  await act(async () => {
    await router.load();
  });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });

  return router;
}

function rowNamed(name: string): HTMLElement | undefined {
  return [...container.querySelectorAll<HTMLElement>("[data-roster-card]")].find((row) =>
    row.textContent?.includes(name),
  );
}

function buttonByText(text: string, scope: ParentNode = container): HTMLElement {
  const found = [...scope.querySelectorAll<HTMLElement>("button, [role='menuitem']")].find(
    (el) => el.textContent === text,
  );

  if (found === undefined) {
    throw new Error(`no control labelled "${text}"`);
  }

  return found;
}

async function openActions(row: HTMLElement): Promise<HTMLElement> {
  const trigger = row.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']");

  if (trigger === null) {
    throw new Error("the row has no actions menu");
  }

  await act(async () => {
    trigger.click();
  });

  // Base UI opens the menu asynchronously; wait a frame for the portal.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const menu = document.body.querySelector<HTMLElement>("[role='menu']");

  if (menu === null) {
    throw new Error("the actions menu did not open");
  }

  return menu;
}

describe("the roster's home screen", () => {
  it("lists one row per bot with identity, role, state and activity", async () => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
    await mountHome({
      bots: {
        active: [
          { ...fakeBot("bot-1", "Ada"), title: "Bookkeeping", pinned: true },
          { ...fakeBot("bot-2", "Ledger"), title: "Researcher", sectionId: "section-1" },
        ],
        archived: [
          {
            ...fakeBot("bot-3", "Grace"),
            title: "Archivist",
            archivedAt: "2026-01-02T00:00:00.000Z",
          },
        ],
        sections: [section("section-1", "Research", 0)],
      },
      threads: [
        { ...fakeThread("thread-1", "bot-1"), updatedAt: fiveMinutesAgo },
        { ...fakeThread("thread-2", "bot-2"), updatedAt: twoDaysAgo },
      ],
      approvals: [pendingApproval("bot-2")],
    });

    expect(container.textContent).toContain("Pinned");
    expect(container.textContent).toContain("Research");
    expect(container.textContent).not.toContain("Grace");

    const ada = rowNamed("Ada");

    expect(ada?.textContent).toContain("Bookkeeping");
    expect(ada?.querySelector("[data-avatar]")).not.toBeNull();
    expect(ada?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("idle");
    expect(ada?.textContent).toContain("5m ago");

    const ledger = rowNamed("Ledger");

    expect(ledger?.querySelector("[data-state]")?.getAttribute("data-state")).toBe("waiting");
    expect(ledger?.querySelector("[data-count-badge]")?.textContent).toBe("1");
    expect(ledger?.textContent).toContain("Waiting on web_fetch");
    expect(ledger?.textContent).toContain("2d ago");

    await act(async () => {
      buttonByText("Archived (1)").click();
    });

    const grace = rowNamed("Grace");

    if (grace === undefined) {
      throw new Error("the archived row is missing");
    }

    const menu = await openActions(grace);

    expect(menu.textContent).toContain("Restore");
    expect(menu.textContent).not.toContain("Archive");
  });

  it("reaches the row actions from the keyboard and navigates", async () => {
    const router = await mountHome({
      bots: { active: [fakeBot("bot-1", "Ada")] },
    });
    const row = rowNamed("Ada");

    if (row === undefined) {
      throw new Error("the row is missing");
    }

    const trigger = row.querySelector<HTMLButtonElement>("button[aria-haspopup='menu']");

    expect(trigger?.getAttribute("aria-label")).toBe("Actions for Ada");

    await act(async () => {
      trigger?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
    });

    const menu = document.body.querySelector("[role='menu']");

    expect(menu?.textContent).toContain("Open");
    expect(menu?.textContent).toContain("New thread");
    expect(menu?.textContent).toContain("Edit");
    expect(menu?.textContent).toContain("Memory");
    expect(menu?.textContent).toContain("Usage");
    expect(menu?.textContent).toContain("Pin");
    expect(menu?.textContent).toContain("Archive");
    expect(document.activeElement?.textContent).toBe("Open");

    await act(async () => {
      buttonByText("Memory").click();
    });

    expect(router.state.location.pathname).toBe("/bots/bot-1/memory");
  });

  it("pins a bot from its menu", async () => {
    const setPinned = vi.fn(async (botId: string, pinned: boolean) => ({
      ...fakeBot(botId, "Ada"),
      pinned,
    }));
    await mountHome({
      bots: { active: [fakeBot("bot-1", "Ada")], setPinned },
    });
    const row = rowNamed("Ada");

    if (row === undefined) {
      throw new Error("the row is missing");
    }

    const menu = await openActions(row);

    await act(async () => {
      buttonByText("Pin", menu).click();
    });

    expect(setPinned).toHaveBeenCalledWith("bot-1", true);
  });

  it("asks once before archiving and hands the write to the transport", async () => {
    const archiveBot = vi.fn(async (botId: string) => fakeBot(botId, "Ada"));
    await mountHome({
      bots: { active: [fakeBot("bot-1", "Ada")], archiveBot },
    });
    const row = rowNamed("Ada");

    if (row === undefined) {
      throw new Error("the row is missing");
    }

    const menu = await openActions(row);

    await act(async () => {
      buttonByText("Archive", menu).click();
    });

    expect(container.textContent).toContain(
      "Archive this bot? Its threads and settings will be kept.",
    );

    await act(async () => {
      buttonByText("Confirm archive").click();
    });

    expect(archiveBot).toHaveBeenCalledWith("bot-1");
  });

  it("names the next action when there are no bots", async () => {
    await mountHome();

    expect(container.textContent).toContain("Create your first bot");
    expect(container.textContent).toContain("Give it a name and instructions");
    expect(
      [...container.querySelectorAll("button")].some((button) => button.textContent === "New bot"),
    ).toBe(true);
  });

  it("keeps the archived rows behind the group toggle", async () => {
    const restoreBot = vi.fn(async (botId: string) => fakeBot(botId, "Grace"));
    await mountHome({
      bots: {
        active: [fakeBot("bot-1", "Ada")],
        archived: [{ ...fakeBot("bot-2", "Grace"), archivedAt: "2026-02-01T00:00:00.000Z" }],
        restoreBot,
      },
    });

    expect(container.textContent).not.toContain("Grace");

    await act(async () => {
      buttonByText("Archived (1)").click();
    });

    const grace = rowNamed("Grace");

    if (grace === undefined) {
      throw new Error("the archived row did not appear");
    }

    const menu = await openActions(grace);

    await act(async () => {
      buttonByText("Restore", menu).click();
    });

    expect(restoreBot).toHaveBeenCalledWith("bot-2");
  });

  it("shows the shared failure state and retries the roster read", async () => {
    const failing = { value: true };
    const router = await mountHome({
      bots: { active: [fakeBot("bot-1", "Ada")] },
      failing,
    });

    expect(container.textContent).toContain("The bot list could not be loaded");
    expect(container.querySelector("[data-rail-empty]")?.textContent).toContain(
      "The bot list could not be loaded.",
    );

    failing.value = false;

    await act(async () => {
      buttonByText("Try again").click();
    });

    expect(container.textContent).toContain("Ada");
    expect(router.state.location.pathname).toBe("/");
  });
});
