// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAppRouter } from "./router.tsx";
import { createSessionController } from "./session.ts";
import type { AuthTransport, SessionActor } from "./session.ts";
import type { ConsoleTransport, UsageTransport } from "./transport.ts";
import {
  createScriptedEvents,
  fakeBot,
  fakeMemoryDocument,
  fakeMemoryRevision,
  fakeThread,
  runCompleted,
  runStarted,
  scriptedComputerTransport,
  scriptedConnectionsTransport,
  scriptedBotsTransport,
  scriptedMemoryTransport,
  scriptedUsageTransport,
  scriptedThreadTransport,
  textMessage,
  tokenDelta,
} from "../test/fakes.ts";
import type { ComputerTransport } from "./computer.ts";
import type { MemoryTransport } from "./memory.ts";

/**
 * The route guards, in a real DOM: the shell's three states are reachable from
 * the router. A visitor with no session lands on sign-in, an actor lands on the
 * home console, and a session read that has not answered yet shows the
 * bootstrapping screen instead of either.
 *
 * The router runs on a memory history with fake transports, so nothing here
 * touches a network or the browser's own history. Rendering the root document
 * into a test container is what makes jsdom warn about `<html>` inside a
 * `<div>`; the document element is the browser's to own, so the warning is the
 * harness's, not the app's.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

function fakeTransport(currentActor: AuthTransport["currentActor"]): AuthTransport {
  return {
    currentActor,
    signIn: vi.fn(async () => undefined),
    signUp: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
    signupAvailability: vi.fn(async () => "open" as const),
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  // jsdom logs "not implemented" for the router's scroll restoration; the
  // behaviour under test is the guard, not the scroll position.
  window.scrollTo = () => undefined;
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

function appWith(
  currentActor: AuthTransport["currentActor"],
  transport: ConsoleTransport = scriptedThreadTransport(),
) {
  const auth = fakeTransport(currentActor);
  const session = createSessionController({ transport: auth });

  return createAppRouter(
    {
      auth,
      session,
      bots: scriptedBotsTransport(transport),
      threads: transport,
      memory: scriptedMemoryTransport(),
      usage: scriptedUsageTransport(),
      connections: scriptedConnectionsTransport(),
      computer: scriptedComputerTransport(),
    },
    createMemoryHistory({ initialEntries: ["/"] }),
  );
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => {
    root.render(element);
  });
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${label}`);
    }

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

describe("the shell's route guards", () => {
  it("lands an anonymous visitor on sign-in", async () => {
    const router = appWith(async () => null);

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    expect(router.state.location.pathname).toBe("/sign-in");
    expect(container.textContent).toContain("Sign in");
  });

  it("lands a signed-in actor on the console", async () => {
    const router = appWith(async () => actor);

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    expect(router.state.location.pathname).toBe("/");
    expect(container.textContent).toContain("Create your first bot");
    expect(container.textContent).toContain("Sign out");
  });

  it("sends a signed-in actor away from the sign-in form", async () => {
    const auth = fakeTransport(async () => actor);
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
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({ initialEntries: ["/sign-in"] }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    expect(router.state.location.pathname).toBe("/");
    expect(container.textContent).toContain("Create your first bot");
  });

  it("does not settle while the session read is unanswered", async () => {
    let answer: (value: SessionActor | null) => void = () => undefined;
    const read = new Promise<SessionActor | null>((resolve) => {
      answer = resolve;
    });
    const router = appWith(() => read);
    let settled = false;

    const loading = router.load().then(() => {
      settled = true;
    });

    await act(async () => {
      await Promise.resolve();
    });

    // While the read is unanswered the router presents its default pending
    // component — the bootstrapping screen — and has not chosen a destination.
    expect(settled).toBe(false);

    answer(actor);

    await act(async () => {
      await loading;
    });

    expect(router.state.location.pathname).toBe("/");
  });

  it("keeps the skip link and its target on the core screens", async () => {
    const signedOut = appWith(async () => null);

    await act(async () => {
      await signedOut.load();
    });
    await render(<RouterProvider router={signedOut} />);

    expect(container.querySelector("a[href='#main']")?.textContent).toBe("Skip to main content");
    expect(container.querySelector("#main")).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
    root = createRoot(container);

    const signedIn = appWith(async () => actor);

    await act(async () => {
      await signedIn.load();
    });
    await render(<RouterProvider router={signedIn} />);

    expect(container.querySelector("a[href='#main']")).not.toBeNull();
    expect(container.querySelector("#main")).not.toBeNull();
  });

  it("re-reads the session when sign-out fails instead of pretending", async () => {
    const auth = fakeTransport(async () => actor);
    auth.signOut = vi.fn(async () => {
      throw new Error("connection refused");
    });
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
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({ initialEntries: ["/"] }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    const signOut = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Sign out",
    );

    expect(signOut).toBeDefined();

    await act(async () => {
      signOut?.click();
    });

    expect(container.textContent).toContain("Create your first bot");
  });
});

describe("the console routes", () => {
  it("lists the roster on the home screen with its actions behind a menu", async () => {
    const router = appWith(
      async () => actor,
      scriptedThreadTransport({
        bots: [fakeBot("bot-1", "Ada")],
        threads: [fakeThread("thread-1", "bot-1")],
      }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    expect(container.textContent).toContain("Ada");

    const row = [...container.querySelectorAll(".roster-card")].find((card) =>
      card.textContent?.includes("Ada"),
    );
    const trigger = row?.querySelector("button[aria-haspopup='menu']");

    expect(trigger).toBeDefined();

    await act(async () => {
      (trigger as HTMLButtonElement).click();
    });

    const menu = document.body.querySelector("[role='menu']");
    const labels = [...(menu?.querySelectorAll("[role='menuitem']") ?? [])].map(
      (item) => item.textContent,
    );

    expect(labels).toEqual([
      "Open",
      "New thread",
      "Edit",
      "Memory",
      "Routines",
      "Usage",
      "Pin",
      "Archive",
    ]);
  });

  it("renders a thread's streamed text on the console route", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({
      transcript: [
        textMessage({ id: "message-0", threadId: "thread-1", seq: 0, role: "user", text: "go" }),
      ],
      events: events.procedure,
    });
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });
    const router = createAppRouter(
      {
        auth,
        session,
        bots: scriptedBotsTransport(transport),
        threads: transport,
        memory: scriptedMemoryTransport(),
        usage: scriptedUsageTransport(),
        connections: scriptedConnectionsTransport(),
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({ initialEntries: ["/bots/bot-1/threads/thread-1"] }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    expect(container.textContent).toContain("go");
    await until(() => events.calls.length === 1, "the subscription");

    events.push(runStarted("thread-1", "run-1", 1));
    events.push(tokenDelta("thread-1", "run-1", 2, "message-1", "Hel"));

    await until(() => container.textContent?.includes("Hel") === true, "the first delta");
    expect(container.textContent).not.toContain("Hello");

    events.push(tokenDelta("thread-1", "run-1", 3, "message-1", "lo"));
    events.push(runCompleted("thread-1", "run-1", 4, "message-1"));

    await until(() => container.textContent?.includes("Hello") === true, "the completed text");
  });

  it("reports the thread's run state to the shell's header", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({
      bots: [fakeBot("bot-1", "Ada")],
      threads: [fakeThread("thread-1", "bot-1")],
      events: events.procedure,
      runs: {
        "run-1": {
          id: "run-1",
          status: "running",
          liveness: {
            state: "working",
            tool: "shell",
            heartbeatLagMs: 1_000,
            sinceProgressMs: 500,
          },
        },
      },
    });
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });
    const router = createAppRouter(
      {
        auth,
        session,
        bots: scriptedBotsTransport(transport),
        threads: transport,
        memory: scriptedMemoryTransport(),
        usage: scriptedUsageTransport(),
        connections: scriptedConnectionsTransport(),
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({ initialEntries: ["/bots/bot-1/threads/thread-1"] }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);
    await until(() => events.calls.length === 1, "the subscription");

    expect(container.querySelector(".shell-header [data-state]")).toBeNull();

    events.push(runStarted("thread-1", "run-1", 1));

    await until(
      () => container.querySelector(".shell-header [data-state='working']") !== null,
      "the header's working chip",
    );
    expect(container.querySelector(".shell-rail-row[aria-current='page']")?.textContent).toContain(
      "Ada",
    );
  });

  it("sends a message with an attachment from the composer, chips and all", async () => {
    const events = createScriptedEvents();
    const transport = scriptedThreadTransport({
      transcript: [],
      events: events.procedure,
      uploadAttachment: async (input) => {
        input.onProgress?.(4, 4);

        return {
          id: "attachment-1",
          filename: input.filename,
          contentType: input.contentType,
          sizeBytes: 4,
        };
      },
      send: async (input) => ({
        action: "start_run",
        runId: "run-1",
        message: {
          id: "message-9",
          threadId: input.threadId,
          seq: 0,
          role: "user",
          blocks: [
            { type: "text", text: input.text },
            {
              type: "file",
              attachmentId: "attachment-1",
              filename: "notes.txt",
              contentType: "text/plain",
              sizeBytes: 4,
            },
          ],
          runId: "run-1",
          createdAt: "2026-01-02T00:00:00.000Z",
        },
      }),
    });
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });
    const router = createAppRouter(
      {
        auth,
        session,
        bots: scriptedBotsTransport(transport),
        threads: transport,
        memory: scriptedMemoryTransport(),
        usage: scriptedUsageTransport(),
        connections: scriptedConnectionsTransport(),
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({ initialEntries: ["/bots/bot-1/threads/thread-1"] }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);
    await until(() => container.querySelector(".composer") !== null, "the composer");

    // Type the message the way a keyboard user does.
    const field = container.querySelector(".composer textarea") as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

    setter?.call(field, "look at this");

    await act(async () => {
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });

    // Stage a file through the chooser; the send stays off while it uploads.
    const chooser = container.querySelector(".composer input[type='file']") as HTMLInputElement;

    Object.defineProperty(chooser, "files", {
      value: [new File(["data"], "notes.txt", { type: "text/plain" })],
      configurable: true,
    });

    await act(async () => {
      chooser.dispatchEvent(new Event("change", { bubbles: true }));
    });

    await until(
      () => container.querySelector(".composer-file-ready") !== null,
      "the upload to settle",
    );
    expect(container.textContent).toContain("notes.txt");

    // Enter is the keyboard user's send.
    await act(async () => {
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    await until(() => transport.sendCalls.length === 1, "the send");
    expect(transport.sendCalls[0]).toMatchObject({
      threadId: "thread-1",
      text: "look at this",
      attachmentIds: ["attachment-1"],
    });

    // The sent message is in the transcript — not on the next mount — with
    // its file as a download chip.
    await until(
      () => container.querySelector(".message-attachment") !== null,
      "the attachment chip",
    );

    const chip = container.querySelector("a.message-attachment");

    expect(chip?.getAttribute("href")).toBe("/files/attachment-1");
    expect(chip?.textContent).toContain("notes.txt");
    expect(container.querySelector(".composer textarea")).toHaveProperty("value", "");
  });

  it("resolves a truncated call's artifact on its own route", async () => {
    const transport = scriptedThreadTransport({
      toolResults: {
        "run-1:call-1": { tool: "shell", result: { stdout: "the whole output" } },
      },
    });
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });
    const router = createAppRouter(
      {
        auth,
        session,
        bots: scriptedBotsTransport(transport),
        threads: transport,
        memory: scriptedMemoryTransport(),
        usage: scriptedUsageTransport(),
        connections: scriptedConnectionsTransport(),
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({
        initialEntries: ["/bots/bot-1/threads/thread-1/tool-results/run-1/call-1"],
      }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    expect(container.textContent).toContain("Tool result");
    expect(container.textContent).toContain("shell");
    expect(container.textContent).toContain('"stdout": "the whole output"');
    expect(container.querySelector("a[href='/bots/bot-1/threads/thread-1']")?.textContent).toBe(
      "Back to thread",
    );
  });

  it("shows a refusal when the artifact is not there", async () => {
    const auth = fakeTransport(async () => actor);
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
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({
        initialEntries: ["/bots/bot-1/threads/thread-1/tool-results/run-1/call-missing"],
      }),
    );

    await act(async () => {
      await router.load().catch(() => undefined);
    });
    await render(<RouterProvider router={router} />);

    expect(container.textContent).toContain("The tool result could not be loaded.");
  });
});

describe("the memory route", () => {
  function memoryRouter(memory: MemoryTransport): ReturnType<typeof createAppRouter> {
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });

    return createAppRouter(
      {
        auth,
        session,
        bots: scriptedBotsTransport(),
        threads: scriptedThreadTransport(),
        memory,
        usage: scriptedUsageTransport(),
        connections: scriptedConnectionsTransport(),
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({ initialEntries: ["/bots/bot-1/memory"] }),
    );
  }

  async function mountMemory(memory: MemoryTransport): Promise<void> {
    const router = memoryRouter(memory);

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);
  }

  function buttonByText(text: string): HTMLButtonElement {
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

  it("lists what the bot remembers and folds long content", async () => {
    const long = "x".repeat(600);
    await mountMemory(
      scriptedMemoryTransport({
        documents: [fakeMemoryDocument({ content: long })],
        revisions: { "doc-1": [fakeMemoryRevision()] },
      }),
    );

    expect(container.textContent).toContain("Preferred editor");
    expect(container.textContent).toContain("Fact");
    expect(container.textContent).toContain("v1");

    const details = container.querySelector("details.memory-text-details");

    expect(details).not.toBeNull();
    expect(details?.querySelector("summary")?.textContent?.length).toBeLessThan(long.length);
    expect(details?.querySelector("p.memory-content")?.textContent).toBe(long);
  });

  it("shows an empty state instead of a blank list", async () => {
    await mountMemory(scriptedMemoryTransport());

    expect(container.textContent).toContain("Nothing remembered yet.");
    expect(container.querySelector(".memory-list")).toBeNull();
  });

  it("shows a refusal and offers the retry that reads again", async () => {
    let failing = true;
    const transport: MemoryTransport = {
      ...scriptedMemoryTransport({
        documents: [fakeMemoryDocument()],
        revisions: { "doc-1": [fakeMemoryRevision()] },
      }),
      list: async () => {
        if (failing) {
          throw new Error("unreachable");
        }

        return [fakeMemoryDocument()];
      },
    };

    await mountMemory(transport);

    await until(
      () => container.textContent?.includes("Memory could not be loaded.") === true,
      "the refusal",
    );

    failing = false;

    await act(async () => {
      buttonByText("Try again").click();
    });

    await until(
      () => container.textContent?.includes("Preferred editor") === true,
      "the retry's document",
    );
  });

  it("edits a document in place and the reload shows the correction", async () => {
    await mountMemory(
      scriptedMemoryTransport({
        documents: [fakeMemoryDocument()],
        revisions: { "doc-1": [fakeMemoryRevision()] },
      }),
    );

    await act(async () => {
      buttonByText("Edit").click();
    });

    const form = container.querySelector("form.memory-form");

    expect(form).not.toBeNull();

    const [title, reason] = [...(form?.querySelectorAll("input") ?? [])];
    const content = form?.querySelector("textarea");

    setValue(title as HTMLInputElement, "Preferred editor");
    setValue(content as HTMLTextAreaElement, "The operator prefers Neovim.");
    setValue(reason as HTMLInputElement, "operator correction");
    await submit(form as HTMLFormElement);

    await until(
      () =>
        container.textContent?.includes("v2") === true &&
        container.querySelector("form.memory-form") === null,
      "the persisted correction",
    );

    expect(container.textContent).toContain("The operator prefers Neovim.");
    expect(container.querySelector("form.memory-form")).toBeNull();
  });

  it("shows the history with who made each change and when", async () => {
    await mountMemory(
      scriptedMemoryTransport({
        documents: [fakeMemoryDocument({ revision: 2 })],
        revisions: {
          "doc-1": [
            fakeMemoryRevision(),
            fakeMemoryRevision({
              revision: 2,
              origin: "agent_proposed",
              author: "bot-1",
              reason: "learned in a run",
              createdAt: "2026-01-02T00:00:00.000Z",
            }),
          ],
        },
      }),
    );

    await act(async () => {
      buttonByText("History").click();
    });

    await until(() => container.querySelectorAll(".revision").length === 2, "the revision history");

    const revisions = [...container.querySelectorAll(".revision")];

    expect(revisions[0]?.textContent).toContain("You");
    expect(revisions[1]?.textContent).toContain("Bot");
    expect(revisions[1]?.textContent).toContain("learned in a run");
    expect(revisions[1]?.querySelector("time")?.getAttribute("datetime")).toBe(
      "2026-01-02T00:00:00.000Z",
    );
  });

  it("removes a document and restores it from the removed scope", async () => {
    await mountMemory(
      scriptedMemoryTransport({
        documents: [fakeMemoryDocument()],
        revisions: { "doc-1": [fakeMemoryRevision()] },
      }),
    );

    await act(async () => {
      buttonByText("Delete").click();
    });

    const removeForm = container.querySelector("form.memory-form");

    expect(removeForm).not.toBeNull();
    setValue(removeForm?.querySelector("input") as HTMLInputElement, "no longer relevant");
    await submit(removeForm as HTMLFormElement);

    await until(
      () => container.textContent?.includes("Nothing remembered yet.") === true,
      "the removed document to leave the live list",
    );

    await act(async () => {
      buttonByText("Removed").click();
    });

    await until(
      () => container.textContent?.includes("Preferred editor") === true,
      "the tombstone in the removed scope",
    );

    await act(async () => {
      buttonByText("Restore").click();
    });

    await until(
      () => container.textContent?.includes("Nothing removed.") === true,
      "the restored document to leave the removed scope",
    );

    await act(async () => {
      buttonByText("Current").click();
    });

    await until(
      () => container.textContent?.includes("Preferred editor") === true,
      "the restored document in the live list",
    );

    expect(container.textContent).toContain("v3");
  });
});

describe("the usage route", () => {
  function usageRouter(usage: UsageTransport): ReturnType<typeof createAppRouter> {
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });

    return createAppRouter(
      {
        auth,
        session,
        bots: scriptedBotsTransport(),
        threads: scriptedThreadTransport(),
        memory: scriptedMemoryTransport(),
        usage,
        connections: scriptedConnectionsTransport(),
        computer: scriptedComputerTransport(),
      },
      createMemoryHistory({ initialEntries: ["/bots/bot-1/usage"] }),
    );
  }

  async function mountUsage(usage: UsageTransport): Promise<void> {
    const router = usageRouter(usage);

    await act(async () => {
      // A failed loader rejects `load`; the route's error component is what
      // this suite asserts, and the rejection is the router's own report.
      await router.load().catch(() => undefined);
    });
    await render(<RouterProvider router={router} />);
  }

  it("renders the all-time total and each day's bucket", async () => {
    await mountUsage(
      scriptedUsageTransport({
        usage: {
          botId: "bot-1",
          total: { inputTokens: 3500, outputTokens: 700, reported: 4, unreported: 1 },
          periods: [
            {
              startsAt: "2026-01-02T00:00:00.000Z",
              inputTokens: 1200,
              outputTokens: 200,
              reported: 2,
              unreported: 0,
            },
          ],
        },
      }),
    );

    expect(container.textContent).toContain("Usage");
    expect(container.textContent).toContain("All time");
    expect(container.textContent).toContain("3500");
    expect(container.textContent).toContain("700");
    expect(container.textContent).toContain("2026-01-02");
    expect(container.textContent).toContain("1200");
    expect(container.textContent).toContain("1 of 5 not reported");
  });

  it("renders an unreported figure as such, never as a zero", async () => {
    await mountUsage(
      scriptedUsageTransport({
        usage: {
          botId: "bot-1",
          total: { inputTokens: null, outputTokens: null, reported: 0, unreported: 2 },
          periods: [],
        },
      }),
    );

    const values = [...container.querySelectorAll(".usage-totals dd")].map(
      (value) => value.textContent,
    );

    expect(values).toEqual(["Not reported", "Not reported", "2"]);
    expect(container.textContent).toContain("No usage in this period.");
  });

  it("shows a bot with no calls as an empty state rather than zero rows", async () => {
    await mountUsage(
      scriptedUsageTransport({
        usage: {
          botId: "bot-1",
          total: { inputTokens: null, outputTokens: null, reported: 0, unreported: 0 },
          periods: [],
        },
      }),
    );

    expect(container.textContent).toContain("No usage recorded yet.");
  });

  it("shows the refusal with a retry when the read fails", async () => {
    await mountUsage(scriptedUsageTransport({ failure: new Error("connection refused") }));

    expect(container.textContent).toContain("Usage could not be loaded.");
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Try again",
      ),
    ).toBe(true);
  });
});

describe("the computer route", () => {
  function computerRouter(computer: ComputerTransport): ReturnType<typeof createAppRouter> {
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });

    return createAppRouter(
      {
        auth,
        session,
        bots: scriptedBotsTransport(),
        threads: scriptedThreadTransport(),
        memory: scriptedMemoryTransport(),
        usage: scriptedUsageTransport(),
        connections: scriptedConnectionsTransport(),
        computer,
      },
      createMemoryHistory({ initialEntries: ["/bots/bot-1/computer"] }),
    );
  }

  async function mountComputer(computer: ComputerTransport): Promise<void> {
    const router = computerRouter(computer);

    await act(async () => {
      // A failed load rejects `load`; the route's own refusal state is what
      // this suite asserts, and the rejection is the router's report.
      await router.load().catch(() => undefined);
    });
    await render(<RouterProvider router={router} />);
  }

  function buttonByText(text: string): HTMLButtonElement {
    const found = [...document.body.querySelectorAll("button")].find(
      (button) => button.textContent === text,
    );

    if (found === undefined) {
      throw new Error(`no button labelled "${text}"`);
    }

    return found as HTMLButtonElement;
  }

  async function click(text: string): Promise<void> {
    await act(async () => {
      buttonByText(text).click();
    });
  }

  it("shows the deployment's providers in the sheet and stores a switch", async () => {
    const computer = scriptedComputerTransport({
      bot: { ...fakeBot("bot-1", "Ada"), computerId: "computer-1" },
      computer: { assigned: true, state: "running", instanceId: "i-1" },
    });
    await mountComputer(computer);

    await click("Change");

    expect(document.body.textContent).toContain("Where this bot's computer runs");
    expect(document.body.textContent).toContain("Offline emulator");
    expect(document.body.textContent).toContain("Local Docker");

    const docker = [...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]')][2];

    if (docker === undefined) {
      throw new Error("the Docker radio is missing");
    }

    await act(async () => {
      docker.click();
    });

    expect(document.body.textContent).toContain("does not move this bot's home");

    await click("Switch to Local Docker");

    await until(
      () => container.textContent?.includes("This bot now runs on Local Docker.") === true,
      "the switch outcome",
    );
  });

  it("shows the refusal with a retry when the read fails", async () => {
    await mountComputer(scriptedComputerTransport({ listFailure: new Error("unreachable") }));

    expect(container.textContent).toContain("The computer settings could not be loaded.");
    expect(buttonByText("Try again")).toBeDefined();
  });
});
