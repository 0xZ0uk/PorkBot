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
import type { ConsoleTransport } from "./transport.ts";
import {
  createScriptedEvents,
  fakeBot,
  fakeThread,
  runCompleted,
  runStarted,
  scriptedThreadTransport,
  textMessage,
  tokenDelta,
} from "../test/fakes.ts";

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
    { auth, session, threads: transport },
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
    expect(container.textContent).toContain("No bots yet.");
    expect(container.textContent).toContain("Sign out");
  });

  it("sends a signed-in actor away from the sign-in form", async () => {
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });
    const router = createAppRouter(
      { auth, session, threads: scriptedThreadTransport() },
      createMemoryHistory({ initialEntries: ["/sign-in"] }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    expect(router.state.location.pathname).toBe("/");
    expect(container.textContent).toContain("No bots yet.");
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
      { auth, session, threads: scriptedThreadTransport() },
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

    expect(container.textContent).toContain("No bots yet.");
  });
});

describe("the console routes", () => {
  it("lists a bot's threads on the home screen", async () => {
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
    expect(container.textContent).toContain("New thread");

    const link = container.querySelector("a[href='/threads/thread-1']");

    expect(link).not.toBeNull();
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
      { auth, session, threads: transport },
      createMemoryHistory({ initialEntries: ["/threads/thread-1"] }),
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

  it("resolves a truncated call's artifact on its own route", async () => {
    const transport = scriptedThreadTransport({
      toolResults: {
        "run-1:call-1": { tool: "shell", result: { stdout: "the whole output" } },
      },
    });
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });
    const router = createAppRouter(
      { auth, session, threads: transport },
      createMemoryHistory({
        initialEntries: ["/threads/thread-1/tool-results/run-1/call-1"],
      }),
    );

    await act(async () => {
      await router.load();
    });
    await render(<RouterProvider router={router} />);

    expect(container.textContent).toContain("Tool result");
    expect(container.textContent).toContain("shell");
    expect(container.textContent).toContain('"stdout": "the whole output"');
    expect(container.querySelector("a[href='/threads/thread-1']")?.textContent).toBe(
      "Back to thread",
    );
  });

  it("shows a refusal when the artifact is not there", async () => {
    const auth = fakeTransport(async () => actor);
    const session = createSessionController({ transport: auth });
    const router = createAppRouter(
      { auth, session, threads: scriptedThreadTransport() },
      createMemoryHistory({
        initialEntries: ["/threads/thread-1/tool-results/run-1/call-missing"],
      }),
    );

    await act(async () => {
      await router.load().catch(() => undefined);
    });
    await render(<RouterProvider router={router} />);

    expect(container.textContent).toContain("The tool result could not be loaded.");
  });
});
