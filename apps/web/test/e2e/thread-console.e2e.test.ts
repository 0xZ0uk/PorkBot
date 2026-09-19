// @vitest-environment jsdom
import { RouterProvider, createMemoryHistory } from "@tanstack/react-router";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { beforeEach, describe, expect, it } from "vitest";
import { createAppRouter } from "../../src/router.tsx";
import { createSessionController } from "../../src/session.ts";
import type { AuthTransport, SessionActor } from "../../src/session.ts";
import { createHttpConsoleTransport } from "../../src/transport.ts";
import {
  runCompleted,
  runStarted,
  textMessage,
  tokenDelta,
  toolCompleted,
  toolFailed,
  toolRequested,
} from "../fakes.ts";
import { startScriptedThreadApi } from "./scripted-thread-api.ts";
import type { ScriptedThreadApi } from "./scripted-thread-api.ts";

/**
 * The console's resume path, end to end: the built client modules — the
 * contracts' oRPC subscription, the core reducer and the console's own state
 * machine — mounted in a DOM, reading a real SSE connection from a real HTTP
 * server on loopback.
 *
 * Three acceptance criteria are proven here: tokens render before the run
 * completes; a reload reconnects from zero and shows the snapshot the wire
 * would have produced; and a dropped connection reconnects from its signed
 * cursor with the connection state visible and no duplicated token. The
 * server is scripted, so the frames are exactly the events the test pushes.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const threadId = "01900000-0000-7000-8000-000000000001";
const runId = "01900000-0000-7000-8000-0000000000f0";
const userMessageId = "01900000-0000-7000-8000-0000000000a0";
const assistantMessageId = "01900000-0000-7000-8000-0000000000a1";

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

beforeEach(() => {
  // jsdom logs "not implemented" for the router's scroll restoration; the
  // subject here is the stream, not the scroll position.
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

function userMessage() {
  return textMessage({
    id: userMessageId,
    threadId,
    seq: 0,
    role: "user",
    text: "count",
    runId,
  });
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

interface MountedConsole {
  readonly container: HTMLDivElement;
  unmount(): Promise<void>;
}

/**
 * A console view the way a browser gets one: the router guards the route, the
 * console transport talks to the scripted API over HTTP, and the DOM is the
 * console screen. Mounting twice is the reload.
 */
async function mountConsole(
  api: ScriptedThreadApi,
  path = `/threads/${threadId}`,
): Promise<MountedConsole> {
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const transport = createHttpConsoleTransport({ origin: api.url });
  const router = createAppRouter(
    { auth, session, threads: transport },
    createMemoryHistory({ initialEntries: [path] }),
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

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("the streaming console over the real wire", () => {
  it("renders tokens as they stream and never waits for completion", async () => {
    const api = await startScriptedThreadApi({
      threadId,
      messages: [userMessage()],
      events: [
        runStarted(threadId, runId, 1),
        tokenDelta(threadId, runId, 2, assistantMessageId, "One "),
      ],
    });
    const view = await mountConsole(api);

    try {
      await until(() => view.container.textContent?.includes("One ") === true, "the first delta");

      expect(view.container.textContent).not.toContain("One two");
      // Live and quiet: no connection chrome while frames are flowing.
      expect(view.container.querySelector("[role='status']")).toBeNull();

      api.push(tokenDelta(threadId, runId, 3, assistantMessageId, "two"));
      api.push(runCompleted(threadId, runId, 4, assistantMessageId));

      await until(
        () => view.container.textContent?.includes("One two") === true,
        "the completed text",
      );

      expect(countOccurrences(view.container.textContent ?? "", "One two")).toBe(1);

      const entries = [...view.container.querySelectorAll(".transcript > li")];

      expect(entries.map((entry) => entry.textContent)).toEqual(["Youcount", "BotOne two"]);
      expect(entries.at(-1)?.className).not.toContain("message-streaming");
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("reloads into the same snapshot the wire would have produced", async () => {
    const api = await startScriptedThreadApi({
      threadId,
      messages: [userMessage()],
      events: [
        runStarted(threadId, runId, 1),
        tokenDelta(threadId, runId, 2, assistantMessageId, "One "),
      ],
    });
    const before = await mountConsole(api);

    await until(() => before.container.textContent?.includes("One ") === true, "the partial text");

    // The tab goes away mid-run; the run keeps writing to the durable stream.
    await before.unmount();
    api.push(tokenDelta(threadId, runId, 3, assistantMessageId, "two"));
    api.push(runCompleted(threadId, runId, 4, assistantMessageId));

    // The reload: a fresh client, a fresh snapshot, and the durable rows are
    // the stream. It must replay from zero rather than depend on a cursor.
    const after = await mountConsole(api);

    try {
      await until(
        () => after.container.textContent?.includes("One two") === true,
        "the replayed text",
      );

      expect(api.subscriptions).toHaveLength(2);
      expect(api.subscriptions[0]?.lastEventId).toBeUndefined();
      expect(api.subscriptions[1]?.lastEventId).toBeUndefined();

      const entries = [...after.container.querySelectorAll(".transcript > li")];

      expect(entries.map((entry) => entry.textContent)).toEqual(["Youcount", "BotOne two"]);
      expect(countOccurrences(after.container.textContent ?? "", "One two")).toBe(1);
    } finally {
      await after.unmount();
      await api.close();
    }
  });

  it("reconnects a dropped connection from its cursor, visibly", async () => {
    const api = await startScriptedThreadApi({
      threadId,
      messages: [userMessage()],
      events: [
        runStarted(threadId, runId, 1),
        tokenDelta(threadId, runId, 2, assistantMessageId, "One"),
      ],
    });
    const view = await mountConsole(api);

    try {
      await until(() => view.container.textContent?.includes("One") === true, "the first delta");

      api.dropConnections();

      await until(
        () => view.container.textContent?.includes("Reconnecting…") === true,
        "the reconnecting line",
      );

      api.push(tokenDelta(threadId, runId, 3, assistantMessageId, " two"));
      api.push(runCompleted(threadId, runId, 4, assistantMessageId));

      await until(
        () => view.container.textContent?.includes("Resumed") === true,
        "the resumed line",
      );
      await until(
        () => view.container.textContent?.includes("One two") === true,
        "the resumed text",
      );

      // The resume carried the signed cursor of the last delivered frame, and
      // the token text appears once: no duplicate from the replay.
      expect(api.subscriptions.at(-1)?.lastEventId).toBe("cursor-2");
      expect(countOccurrences(view.container.textContent ?? "", "One two")).toBe(1);

      const entries = [...view.container.querySelectorAll(".transcript > li")];

      expect(entries.map((entry) => entry.textContent)).toEqual(["Youcount", "BotOne two"]);
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("renders the tool-call timeline from the wire and resolves its artifact over HTTP", async () => {
    const callId = "01900000-0000-7000-8000-0000000000c0";
    const failedCallId = "01900000-0000-7000-8000-0000000000c1";
    const api = await startScriptedThreadApi({
      threadId,
      messages: [userMessage()],
      events: [
        runStarted(threadId, runId, 1),
        toolRequested(threadId, runId, 2, callId, "shell", {
          command: "cat report.txt",
          token: "[redacted]",
        }),
        toolCompleted(threadId, runId, 3, callId, "preview [truncated]", {
          durationMs: 250,
          resultArtifact: { kind: "tool_call", callId, bytes: 20_480 },
        }),
        toolRequested(threadId, runId, 4, failedCallId, "rm", { path: "/etc" }),
        toolFailed(
          threadId,
          runId,
          5,
          failedCallId,
          'tool "rm" failed (timed_out): no answer',
          30_000,
        ),
        tokenDelta(threadId, runId, 6, assistantMessageId, "One two"),
        runCompleted(threadId, runId, 7, assistantMessageId),
      ],
      toolResults: { [`${runId}:${callId}`]: { tool: "shell", result: { stdout: "all of it" } } },
    });
    const view = await mountConsole(api);

    try {
      await until(
        () => view.container.querySelectorAll(".tool-call").length === 2,
        "the tool timeline",
      );

      // The calls sit in the transcript where the run made them: after the
      // prompt, before the answer.
      const items = [...view.container.querySelectorAll(".transcript > li")];

      expect(
        items.map((item) => item.querySelector(".tool-call-name")?.textContent ?? null),
      ).toEqual([null, "shell", "rm", null]);

      const calls = [...view.container.querySelectorAll(".tool-call")];

      expect(calls[0]?.querySelector(".tool-call-status")?.textContent).toBe("Completed");
      expect(calls[0]?.querySelector(".tool-call-duration")?.textContent).toBe("250 ms");
      expect(calls[0]?.className).not.toContain("tool-call-failed");
      expect(calls[1]?.className).toContain("tool-call-failed");
      expect(calls[1]?.querySelector(".tool-call-status")?.textContent).toBe("Failed");
      expect(calls[1]?.textContent).toContain('tool "rm" failed (timed_out): no answer');

      // The wire carried the redacted argument and the DOM shows exactly it.
      expect(calls[0]?.textContent).toContain("[redacted]");
      expect(view.container.textContent).not.toContain("sk-live");

      const link = calls[0]?.querySelector("a.tool-call-artifact");

      expect(link?.getAttribute("href")).toBe(
        `/threads/${threadId}/tool-results/${runId}/${callId}`,
      );
    } finally {
      await view.unmount();
    }

    // The destination resolves over the same HTTP API: the preview the event
    // carried and the full value the artifact holds are different values.
    const artifact = await mountConsole(
      api,
      `/threads/${threadId}/tool-results/${runId}/${callId}`,
    );

    try {
      await until(
        () => artifact.container.textContent?.includes("all of it") === true,
        "the full result",
      );

      expect(artifact.container.textContent).toContain("shell");
      expect(artifact.container.textContent).not.toContain("[truncated]");
    } finally {
      await artifact.unmount();
      await api.close();
    }
  });
});
