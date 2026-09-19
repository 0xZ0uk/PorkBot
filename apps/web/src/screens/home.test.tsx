// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBot, fakeThread } from "../../test/fakes.ts";
import { HomeScreen } from "./home.tsx";
import type { BotListItem } from "../bots.ts";

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

function item(id: string, kind: "healthy" | "stopped" | "failed"): BotListItem {
  const bot = fakeBot(id, id === "bot-1" ? "Ada" : "Grace");
  const computer =
    kind === "failed"
      ? ({ kind: "failed" } as const)
      : ({
          kind,
          view: { assigned: true, state: kind === "healthy" ? "running" : "stopped" },
        } as const);

  return {
    bot,
    computer,
    threads: [fakeThread(`thread-${id}`, id)],
    lastActivityAt: "2026-02-02T12:00:00.000Z",
  };
}

describe("bot home", () => {
  it("renders health and activity, and confirms archive before writing", async () => {
    const onArchive = vi.fn(async () => undefined);

    await act(async () => {
      root.render(
        <HomeScreen
          active={[item("bot-1", "healthy"), item("bot-2", "stopped"), item("bot-3", "failed")]}
          archived={[]}
          sections={[]}
          pendingBotId={null}
          error={null}
          onNewThread={() => undefined}
          onArchive={onArchive}
          onRestore={async () => undefined}
          renderCreate={() => <a href="/bots/new">New bot</a>}
          renderEdit={(bot) => <a href={`/bots/${bot.id}/edit`}>Edit</a>}
          renderMemory={() => null}
          renderUsage={() => null}
          renderThread={(thread) => <li key={thread.id}>Thread</li>}
        />,
      );
    });

    expect(container.textContent).toContain("Ready");
    expect(container.textContent).toContain("Computer stopped");
    expect(container.textContent).toContain("Computer unavailable");
    expect(container.textContent).toContain("Last active");

    const archive = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Archive",
    );
    await act(async () => archive?.click());
    expect(onArchive).not.toHaveBeenCalled();

    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm archive",
    );
    await act(async () => confirm?.click());
    expect(onArchive).toHaveBeenCalledWith("bot-1");
  });

  it("explains the first action when there are no active bots", async () => {
    await act(async () => {
      root.render(
        <HomeScreen
          active={[]}
          archived={[]}
          sections={[]}
          pendingBotId={null}
          error={null}
          onNewThread={() => undefined}
          onArchive={async () => undefined}
          onRestore={async () => undefined}
          renderCreate={() => <a href="/bots/new">New bot</a>}
          renderEdit={() => null}
          renderMemory={() => null}
          renderUsage={() => null}
          renderThread={() => null}
        />,
      );
    });

    expect(container.textContent).toContain("Create your first bot");
    expect(container.querySelector("a[href='/bots/new']")).not.toBeNull();
  });
});
