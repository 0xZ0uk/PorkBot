// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppRouter } from "../../src/router.tsx";
import { createSessionController } from "../../src/session.ts";
import type { AuthTransport, SessionActor } from "../../src/session.ts";
import { createHttpComputerTransport } from "../../src/transport.ts";
import {
  fakeBot,
  scriptedBotsTransport,
  scriptedConnectionsTransport,
  scriptedMemoryTransport,
  scriptedThreadTransport,
  scriptedUsageTransport,
} from "../fakes.ts";
import { startScriptedComputerApi } from "./scripted-computer-api.ts";
import type { ScriptedComputerApi } from "./scripted-computer-api.ts";

/**
 * The computer settings screen end to end: the built client modules — the
 * contracts' oRPC client, the computer controller and the screen — mounted in
 * a DOM, reading and writing a real HTTP server on loopback.
 *
 * The acceptance criteria this proves over the wire: a bot's provider is a
 * stored setting that survives a reload; an unavailable provider is shown as
 * unavailable rather than selected; and the snapshot path — capture, switch,
 * restore — moves the bot's files across a provider change.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

beforeEach(() => {
  // jsdom logs "not implemented" for the router's scroll restoration; the
  // subject here is the computer screen, not the scroll position.
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

interface MountedComputer {
  readonly container: HTMLDivElement;
  unmount(): Promise<void>;
}

async function mountComputer(api: ScriptedComputerApi): Promise<MountedComputer> {
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const router = createAppRouter(
    {
      auth,
      session,
      bots: scriptedBotsTransport(),
      threads: scriptedThreadTransport(),
      memory: scriptedMemoryTransport(),
      usage: scriptedUsageTransport(),
      connections: scriptedConnectionsTransport(),
      computer: createHttpComputerTransport({ origin: api.url }),
    },
    createMemoryHistory({ initialEntries: ["/bots/bot-1/computer"] }),
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
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === text,
  );

  if (found === undefined) {
    throw new Error(`no button labelled "${text}"`);
  }

  return found as HTMLButtonElement;
}

async function click(container: HTMLElement, text: string): Promise<void> {
  await act(async () => {
    buttonByText(container, text).click();
  });
}

function radioFor(container: HTMLElement, text: string): HTMLInputElement {
  const radio = radioOrUndefined(container, text);

  if (radio === undefined) {
    throw new Error(`no radio for "${text}"`);
  }

  return radio;
}

/** The radio as soon as the list rendered, `undefined` while it still has not. */
function radioOrUndefined(container: HTMLElement, text: string): HTMLInputElement | undefined {
  const row = [...container.querySelectorAll(".provider-option")].find((option) =>
    option.textContent?.includes(text),
  );

  return row?.querySelector<HTMLInputElement>('input[type="radio"]') ?? undefined;
}

const providers = {
  defaultKind: "offline",
  providers: [
    { kind: "offline", available: true, failure: null },
    { kind: "docker", available: true, failure: null },
    { kind: "daytona", available: false, failure: "auth_failed" as const },
  ],
};

describe("the computer screen over the real wire", () => {
  it("stores a switched provider and it survives a reload", async () => {
    const api = await startScriptedComputerApi({
      bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
      providers,
    });
    const before = await mountComputer(api);

    try {
      await until(
        () => before.container.textContent?.includes("Local Docker") === true,
        "the provider list",
      );

      // The unavailable kind is shown as unavailable, and its radio is out of
      // reach, rather than a selection that would fail at the bot's first run.
      expect(before.container.textContent).toContain("Unavailable · Credentials refused");
      expect(radioFor(before.container, "Daytona cloud").disabled).toBe(true);

      await act(async () => {
        radioFor(before.container, "Local Docker").click();
      });

      expect(before.container.textContent).toContain("does not move this bot's home");

      await click(before.container, "Switch to Local Docker");

      await until(
        () => before.container.textContent?.includes("This bot now runs on Local Docker.") === true,
        "the switch outcome",
      );
      expect(api.calls).toContain("bots/update");
      expect(api.bot.computerProvider).toBe("docker");
    } finally {
      await before.unmount();
    }

    // The reload: a fresh client and a fresh controller, with the server's
    // state as the only thing that could remember the selection.
    const after = await mountComputer(api);

    try {
      await until(
        () => radioOrUndefined(after.container, "Local Docker")?.checked === true,
        "the stored selection after reload",
      );
    } finally {
      await after.unmount();
      await api.close();
    }
  });

  it("captures a snapshot, switches, and restores it into the new machine", async () => {
    const api = await startScriptedComputerApi({
      bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
      providers,
    });
    const mounted = await mountComputer(api);

    try {
      await until(
        () => radioOrUndefined(mounted.container, "Local Docker") !== undefined,
        "the provider list",
      );

      await act(async () => {
        radioFor(mounted.container, "Local Docker").click();
      });
      await click(mounted.container, "Take a snapshot");

      await until(
        () => mounted.container.textContent?.includes("2.0 KB") === true,
        "the captured snapshot",
      );
      expect(api.snapshots).toHaveLength(1);
      expect(api.calls).toContain("computers/snapshot");

      await click(mounted.container, "Switch to Local Docker");

      await until(
        () =>
          mounted.container.textContent?.includes("This bot now runs on Local Docker.") === true,
        "the switch outcome",
      );

      await click(mounted.container, "Restore");
      await click(mounted.container, "Restore");

      await until(
        () =>
          mounted.container.textContent?.includes("Snapshot restored into this bot's machine.") ===
          true,
        "the restore outcome",
      );
      expect(api.computer).toMatchObject({ assigned: true, state: "running" });
    } finally {
      await mounted.unmount();
      await api.close();
    }
  });
});
