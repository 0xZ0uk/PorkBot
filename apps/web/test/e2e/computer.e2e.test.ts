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
 * The computer screen end to end: the built client modules — the contracts'
 * oRPC client, the computer controller and the screen — mounted in a DOM,
 * reading and writing a real HTTP server on loopback.
 *
 * The acceptance criteria this proves over the wire: a bot's provider is a
 * stored setting that survives a reload, chosen from a sheet that says what
 * each kind is and why one is unavailable; the snapshot path — capture, switch,
 * restore — moves the bot's files across a provider change; the terminal runs
 * commands through the supervisor's exec seam and the file view reads real
 * state through it; and the lifecycle control's state and its results survive a
 * reload.
 *
 * The register's sheet and dialogs portal into `document.body`, so the queries
 * read the body rather than the mount div.
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

/** Every button on the page: the mount div and the register's portals alike. */
function buttons(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")];
}

function buttonByText(text: string): HTMLButtonElement {
  const found = buttons().find((button) => button.textContent === text);

  if (found === undefined) {
    throw new Error(`no button labelled "${text}"`);
  }

  return found;
}

async function click(text: string): Promise<void> {
  await act(async () => {
    buttonByText(text).click();
  });
}

/** The machine's state word, as the screen surface renders it. */
function machineWord(): string | undefined {
  return document.body.querySelector(".computer-view-state")?.textContent ?? undefined;
}

function radioFor(text: string): HTMLInputElement {
  const radio = radioOrUndefined(text);

  if (radio === undefined) {
    throw new Error(`no radio for "${text}"`);
  }

  return radio;
}

/** The radio as soon as the sheet rendered, `undefined` while it still has not. */
function radioOrUndefined(text: string): HTMLInputElement | undefined {
  const row = [...document.body.querySelectorAll(".provider-option")].find((option) =>
    option.textContent?.includes(text),
  );

  return row?.querySelector<HTMLInputElement>('input[type="radio"]') ?? undefined;
}

async function chooseProvider(text: string): Promise<void> {
  await until(
    () => buttons().some((button) => button.textContent === "Change"),
    "the provider row",
  );
  await click("Change");
  await until(() => radioOrUndefined(text) !== undefined, `the ${text} radio`);

  await act(async () => {
    radioFor(text).click();
  });
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
        () => before.container.textContent?.includes("Offline emulator") === true,
        "the provider row",
      );

      // The sheet says what each kind is and why the unavailable one cannot
      // serve a machine; its radio is out of reach rather than a selection
      // that would fail at the bot's first run.
      await click("Change");
      await until(() => radioOrUndefined("Daytona cloud") !== undefined, "the provider list");
      expect(document.body.textContent).toContain("Unavailable · Credentials refused");
      expect(radioFor("Daytona cloud").disabled).toBe(true);

      await act(async () => {
        radioFor("Local Docker").click();
      });

      // Choosing closes the sheet and arms the confirmation, so the write is
      // still two deliberate steps.
      expect(document.body.querySelector(".provider-list")).toBeNull();
      expect(document.body.textContent).toContain("does not move this bot's home");

      await click("Switch to Local Docker");

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
        () => after.container.textContent?.includes("Local Docker") === true,
        "the stored selection after reload",
      );
      await click("Change");
      await until(() => radioOrUndefined("Local Docker") !== undefined, "the provider list");

      expect(radioFor("Local Docker").checked).toBe(true);
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
      await chooseProvider("Local Docker");
      await click("Take a snapshot");

      await until(
        () => mounted.container.textContent?.includes("2.0 KB") === true,
        "the captured snapshot",
      );
      expect(api.snapshots).toHaveLength(1);
      expect(api.calls).toContain("computers/snapshot");

      await click("Switch to Local Docker");

      await until(
        () =>
          mounted.container.textContent?.includes("This bot now runs on Local Docker.") === true,
        "the switch outcome",
      );

      await click("Restore");
      await click("Restore");

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

/** Sets a controlled input's value the way React's onChange reads it. */
function setValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;

  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the terminal and file views over the real wire", () => {
  it("runs a command and walks the machine's home through the supervisor's seam", async () => {
    const api = await startScriptedComputerApi({
      bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
      providers,
    });
    const mounted = await mountComputer(api);

    try {
      // A running machine lists its home as part of the read.
      await until(
        () => mounted.container.textContent?.includes("notes.md") === true,
        "the home listing",
      );
      expect(api.calls).toContain("computers/files");

      await click("Terminal");

      const input = document.body.querySelector<HTMLInputElement>(".terminal-form input");
      const form = document.body.querySelector<HTMLFormElement>(".terminal-form");

      if (input === null || form === null) {
        throw new Error("the terminal form did not render");
      }

      await act(async () => {
        setValue(input, "ls");
      });
      await act(async () => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });

      await until(
        () => mounted.container.textContent?.includes("ran: ls") === true,
        "the terminal answer",
      );
      expect(api.calls).toContain("computers/terminal");

      await click("Files");
      await click("notes.md");

      await until(
        () => mounted.container.textContent?.includes("# Notes") === true,
        "the file preview",
      );
      expect(api.calls).toContain("computers/file");

      await click("projects/");

      await until(
        () => mounted.container.textContent?.includes("readme.md") === true,
        "the nested directory",
      );
    } finally {
      await mounted.unmount();
      await api.close();
    }
  });

  it("stops and starts the machine, and the state survives a reload", async () => {
    const api = await startScriptedComputerApi({
      bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
      providers,
    });
    const before = await mountComputer(api);

    try {
      await until(() => machineWord() === "Running", "the running machine");

      await click("Running");
      await click("Stop — park it, keeping the home");

      await until(() => machineWord() === "Stopped", "the stop");
      expect(api.computer).toMatchObject({ assigned: true, state: "stopped" });
      // A stopped machine has no terminal to point at.
      expect(before.container.querySelector(".terminal")).toBeNull();
    } finally {
      await before.unmount();
    }

    // The reload: the state is the server's, not a client memory.
    const after = await mountComputer(api);

    try {
      await until(() => machineWord() === "Stopped", "the stopped machine after reload");

      await click("Stopped");
      await click("Start — bring the machine up");

      await until(() => machineWord() === "Running", "the restart");
      expect(api.computer).toMatchObject({ assigned: true, state: "running" });
    } finally {
      await after.unmount();
      await api.close();
    }
  });
});
