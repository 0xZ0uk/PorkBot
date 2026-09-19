// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBot } from "../../test/fakes.ts";
import { BotEditorScreen } from "./bot-editor.tsx";

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

function props(bot = null as ReturnType<typeof fakeBot> | null) {
  return {
    bot,
    sections: [],
    avatarUrl: null,
    computer: null,
    pending: false,
    notice: null,
    onSave: vi.fn(async () => true),
    onCreateSection: vi.fn(async () => null),
    onAvatar: vi.fn(async () => undefined),
    onClearAvatar: vi.fn(async () => undefined),
    onComputer: vi.fn(async () => null),
    onArchive: vi.fn(async () => undefined),
    onRestore: vi.fn(async () => undefined),
  };
}

describe("bot editor", () => {
  it("keeps an invalid create local and tells the operator what to do", async () => {
    const screen = props();
    await act(async () => root.render(<BotEditorScreen {...screen} />));

    const form = container.querySelector("form");
    await act(async () => form?.dispatchEvent(new Event("submit", { bubbles: true })));

    expect(container.textContent).toContain("Enter a name for this bot.");
    expect(screen.onSave).not.toHaveBeenCalled();
  });

  it("requires a second, explicit action before archiving", async () => {
    const screen = props(fakeBot("bot-1", "Ada"));
    await act(async () => root.render(<BotEditorScreen {...screen} />));

    const archive = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Archive bot",
    );
    await act(async () => archive?.click());
    expect(screen.onArchive).not.toHaveBeenCalled();

    const confirm = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Confirm archive",
    );
    await act(async () => confirm?.click());
    expect(screen.onArchive).toHaveBeenCalledOnce();
  });
});
