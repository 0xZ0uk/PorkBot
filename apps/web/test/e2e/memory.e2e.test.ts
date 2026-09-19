// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppRouter } from "../../src/router.tsx";
import { createSessionController } from "../../src/session.ts";
import type { AuthTransport, SessionActor } from "../../src/session.ts";
import { createHttpMemoryTransport } from "../../src/transport.ts";
import {
  fakeMemoryDocument,
  fakeMemoryRevision,
  scriptedBotsTransport,
  scriptedConnectionsTransport,
  scriptedThreadTransport,
  scriptedUsageTransport,
} from "../fakes.ts";
import { startScriptedMemoryApi } from "./scripted-memory-api.ts";
import type { ScriptedMemoryApi } from "./scripted-memory-api.ts";

/**
 * The memory screen end to end: the built client modules — the contracts' oRPC
 * client and the memory controller — mounted in a DOM, reading and writing a
 * real HTTP server on loopback.
 *
 * The acceptance criterion this proves is edit-and-persist: a correction is
 * applied through the contract, rendered from the server's answer, and is
 * still there when the tab is reloaded — the controller has no state of its
 * own to lose. The second spec proves the same path for a removal and the
 * restore that reverses it, including the tombstone scope the list reads.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const botId = "01900000-0000-7000-8000-000000000001";
const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

beforeEach(() => {
  // jsdom logs "not implemented" for the router's scroll restoration; the
  // subject here is the memory screen, not the scroll position.
  window.scrollTo = () => undefined;
});

function fakeAuth(): AuthTransport {
  return {
    currentActor: async () => actor,
    signIn: async () => undefined,
    signUp: async () => undefined,
    signOut: async () => undefined,
    signupAvailability: async () => "closed" as const,
  };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

interface MountedMemory {
  readonly container: HTMLDivElement;
  unmount(): Promise<void>;
}

/**
 * The screen the way a browser gets one: the router guards the route, the
 * memory transport talks to the scripted API over HTTP, and the DOM is the
 * memory screen. Mounting twice is the reload.
 */
async function mountMemory(api: ScriptedMemoryApi): Promise<MountedMemory> {
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const router = createAppRouter(
    {
      auth,
      session,
      bots: scriptedBotsTransport(),
      threads: scriptedThreadTransport(),
      memory: createHttpMemoryTransport({ origin: api.url }),
      usage: scriptedUsageTransport(),
      connections: scriptedConnectionsTransport(),
    },
    createMemoryHistory({ initialEntries: [`/bots/${botId}/memory`] }),
  );
  const container = document.createElement("div");

  document.body.append(container);
  const root: Root = createRoot(container);

  await act(async () => {
    await router.load();
  });
  await act(async () => {
    root.render(createElement(RouterProvider, { router }));
  });

  return {
    container,

    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  );

  if (found === undefined) {
    throw new Error(`no button labelled "${text}"`);
  }

  return found as HTMLButtonElement;
}

/** React's value tracker ignores a plain `element.value =`, so set natively. */
function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;

  setter?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

async function submit(form: HTMLFormElement): Promise<void> {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("the memory screen over the real wire", () => {
  it("edits a document and the correction survives a reload", async () => {
    const api = await startScriptedMemoryApi({
      botId,
      documents: [fakeMemoryDocument()],
      revisions: { "doc-1": [fakeMemoryRevision()] },
    });
    const before = await mountMemory(api);

    try {
      await until(
        () => before.container.textContent?.includes("keyboard-driven") === true,
        "the listed document",
      );

      await act(async () => {
        buttonByText(before.container, "Edit").click();
      });

      const form = before.container.querySelector("form.memory-form");

      expect(form).not.toBeNull();

      const [title, reason] = [...(form?.querySelectorAll("input") ?? [])];
      const content = form?.querySelector("textarea");

      setValue(title as HTMLInputElement, "Preferred editor");
      setValue(content as HTMLTextAreaElement, "The operator prefers Neovim.");
      setValue(reason as HTMLInputElement, "operator correction");
      await submit(form as HTMLFormElement);

      await until(
        () =>
          before.container.textContent?.includes("v2") === true &&
          before.container.querySelector("form.memory-form") === null,
        "the persisted correction",
      );

      expect(before.container.textContent).toContain("The operator prefers Neovim.");
      expect(api.calls).toContain("memory/update");
    } finally {
      await before.unmount();
    }

    // The reload: a fresh client and a fresh controller, with the server's
    // state as the only thing that could remember the correction.
    const after = await mountMemory(api);

    try {
      await until(
        () => after.container.textContent?.includes("The operator prefers Neovim.") === true,
        "the correction after reload",
      );

      expect(after.container.textContent).toContain("v2");
      expect(after.container.textContent).not.toContain("keyboard-driven editing");
    } finally {
      await after.unmount();
      await api.close();
    }
  });

  it("removes a document and restores it from the removed scope", async () => {
    const api = await startScriptedMemoryApi({
      botId,
      documents: [fakeMemoryDocument()],
      revisions: { "doc-1": [fakeMemoryRevision()] },
    });
    const view = await mountMemory(api);

    try {
      await until(
        () => view.container.textContent?.includes("keyboard-driven") === true,
        "the listed document",
      );

      await act(async () => {
        buttonByText(view.container, "Delete").click();
      });

      const removeForm = view.container.querySelector("form.memory-form");

      expect(removeForm).not.toBeNull();
      setValue(removeForm?.querySelector("input") as HTMLInputElement, "no longer relevant");
      await submit(removeForm as HTMLFormElement);

      await until(
        () => view.container.textContent?.includes("Nothing remembered yet.") === true,
        "the removal",
      );

      await act(async () => {
        buttonByText(view.container, "Removed").click();
      });

      await until(
        () => view.container.textContent?.includes("Preferred editor") === true,
        "the tombstone in the removed scope",
      );

      await act(async () => {
        buttonByText(view.container, "Restore").click();
      });

      await until(
        () => view.container.textContent?.includes("Nothing removed.") === true,
        "the restore",
      );

      await act(async () => {
        buttonByText(view.container, "Current").click();
      });

      await until(
        () => view.container.textContent?.includes("Preferred editor") === true,
        "the restored document",
      );

      expect(view.container.textContent).toContain("v3");
      expect(api.calls).toContain("memory/remove");
      expect(api.calls).toContain("memory/restore");
    } finally {
      await view.unmount();
      await api.close();
    }
  });
});
