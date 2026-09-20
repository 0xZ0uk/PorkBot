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
  runStarted,
  scriptedBotsTransport,
  scriptedComputerTransport,
  scriptedConnectionsTransport,
  scriptedMemoryTransport,
  scriptedUsageTransport,
  toolCompleted,
  toolRequested,
} from "../fakes.ts";
import { startScriptedThreadApi } from "./scripted-thread-api.ts";
import type { ScriptedThreadApi } from "./scripted-thread-api.ts";

/**
 * The composer over the real wire (slice 11.3): the built client modules —
 * the oRPC send, the XHR upload, the console's `noteSent` fold and the
 * transcript's chips — mounted in a DOM, talking to a real HTTP server on
 * loopback that answers the upload route, the send procedure and the
 * download route the same way the API does.
 *
 * What is proven here that the unit tier cannot: the chosen file's bytes
 * actually cross the socket, the send addresses the id the upload answered,
 * the sent message's chip downloads the same bytes back, and a reload reads
 * the persisted message — chips included — from the transcript alone.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const threadId = "01900000-0000-7000-8000-000000000001";
const runId = "01900000-0000-7000-8000-0000000000f0";
const artifactId = "01900000-0000-7000-8000-00000000a1f0";
const callId = "01900000-0000-7000-8000-0000000000c0";

const actor: SessionActor = { userId: "user-1", spaceId: "space-1", role: "owner" };

beforeEach(() => {
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

interface MountedConsole {
  readonly container: HTMLDivElement;
  unmount(): Promise<void>;
}

async function mountConsole(api: ScriptedThreadApi): Promise<MountedConsole> {
  const auth = fakeAuth();
  const session = createSessionController({ transport: auth });
  const transport = createHttpConsoleTransport({ origin: api.url });
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
    createMemoryHistory({ initialEntries: [`/threads/${threadId}`] }),
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

/** Types into the composer's textarea the way React's onChange reads it. */
async function typeMessage(container: HTMLElement, text: string): Promise<void> {
  const field = container.querySelector(".composer textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;

  setter?.call(field, text);

  await act(async () => {
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Stages a file through the hidden chooser, as the "Attach files" button does. */
async function chooseFile(container: HTMLElement, file: File): Promise<void> {
  const chooser = container.querySelector(".composer input[type='file']") as HTMLInputElement;

  Object.defineProperty(chooser, "files", { value: [file], configurable: true });

  await act(async () => {
    chooser.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("the composer over the real wire", () => {
  it("uploads a chosen file, sends it with the message, and reads it back on reload", async () => {
    const api = await startScriptedThreadApi({ threadId, messages: [], events: [] });
    const view = await mountConsole(api);

    try {
      await until(() => view.container.querySelector(".composer") !== null, "the composer");

      // Choose the file first: the row stages and the upload crosses the
      // socket while the message is still being typed.
      await chooseFile(
        view.container,
        new File(["the file's bytes"], "notes.txt", { type: "text/plain" }),
      );

      await until(
        () => view.container.querySelector(".composer-file-ready") !== null,
        "the upload to settle",
      );

      expect(api.uploads).toHaveLength(1);
      expect(api.uploads[0]).toMatchObject({ filename: "notes.txt", contentType: "text/plain" });
      expect(api.uploads[0]?.body.toString("utf8")).toBe("the file's bytes");

      await typeMessage(view.container, "read this");

      const field = view.container.querySelector(".composer textarea") as HTMLTextAreaElement;

      await act(async () => {
        field.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });

      await until(() => api.sends.length === 1, "the send");

      const send = api.sends[0] as { attachmentIds?: string[]; clientNonce?: string };

      // The send addresses the id the upload answered — the bytes never ride
      // the message — and carries a nonce a resubmission would replay.
      expect(send.attachmentIds).toEqual([api.uploads[0]?.id]);
      expect(typeof send.clientNonce).toBe("string");

      // The note fold put the sent message in the transcript with its chip,
      // before any event would.
      await until(
        () => view.container.querySelector("a.message-attachment") !== null,
        "the attachment chip",
      );

      const chip = view.container.querySelector("a.message-attachment");
      const href = chip?.getAttribute("href") ?? "";

      expect(chip?.textContent).toContain("notes.txt");
      expect(view.container.textContent).toContain("read this");

      // The chip is a real download: the same bytes come back over HTTP.
      const downloaded = await fetch(`${api.url}${href}`);

      expect(downloaded.status).toBe(200);
      expect(await downloaded.text()).toBe("the file's bytes");
    } finally {
      await view.unmount();
    }

    // The reload: a fresh console reads the persisted message — file blocks
    // included — from the transcript route alone.
    const reloaded = await mountConsole(api);

    try {
      await until(
        () => reloaded.container.querySelector("a.message-attachment") !== null,
        "the chip after reload",
      );

      expect(reloaded.container.textContent).toContain("read this");
      expect(reloaded.container.querySelector("a.message-attachment")?.getAttribute("href")).toBe(
        `/files/${api.uploads[0]?.id ?? ""}`,
      );
    } finally {
      await reloaded.unmount();
      await api.close();
    }
  });

  it("shows a failed upload on its row and keeps the message unsent", async () => {
    // A server that answers the upload route's 404: the thread the composer
    // uploads to is not this one, which is what a stale or foreign id looks
    // like to the real route.
    const api = await startScriptedThreadApi({
      threadId: "01900000-0000-7000-8000-000000000099",
      messages: [],
      events: [],
    });
    const view = await mountConsole(api);

    try {
      await until(() => view.container.querySelector(".composer") !== null, "the composer");

      await chooseFile(view.container, new File(["x"], "lost.txt", { type: "text/plain" }));
      await typeMessage(view.container, "do not lose me");

      await until(
        () => view.container.querySelector(".composer-file-failed") !== null,
        "the failed row",
      );

      // The failure is visible — the route's 404 is the thread's answer, so
      // the row says so — the send never happened, and the draft — text and
      // the file's row — is still standing for the retry.
      expect(view.container.textContent).toContain("This thread is not available.");
      expect(api.sends).toHaveLength(0);
      expect(
        (view.container.querySelector(".composer textarea") as HTMLTextAreaElement).value,
      ).toBe("do not lose me");
    } finally {
      await view.unmount();
      await api.close();
    }
  });

  it("shows a run's produced artifact in the thread, downloadable and durable", async () => {
    const api = await startScriptedThreadApi({
      threadId,
      messages: [],
      events: [
        runStarted(threadId, runId, 1),
        toolRequested(threadId, runId, 2, callId, "file_write", {
          path: "reports/summary.md",
        }),
        toolCompleted(threadId, runId, 3, callId, {
          ok: true,
          path: "reports/summary.md",
          artifact: {
            id: artifactId,
            filename: "summary.md",
            contentType: "text/markdown",
            sizeBytes: 20,
            downloadPath: `/files/${artifactId}`,
          },
        }),
      ],
      files: {
        [artifactId]: {
          filename: "summary.md",
          contentType: "text/markdown",
          body: "# the report\n",
        },
      },
    });
    const view = await mountConsole(api);

    try {
      // The artifact link is on the row without opening the call's details:
      // "produced artifacts appear in the thread" is not buried a click deep.
      await until(
        () => view.container.querySelector("a.tool-call-download") !== null,
        "the artifact link",
      );

      const link = view.container.querySelector("a.tool-call-download");

      expect(link?.getAttribute("href")).toBe(`/files/${artifactId}`);
      expect(link?.textContent).toContain("summary.md");

      const details = view.container.querySelector(
        "details.tool-call-details",
      ) as HTMLDetailsElement;

      expect(details.open).toBe(false);

      // And the link is a real download, not a route away from the thread.
      const downloaded = await fetch(`${api.url}/files/${artifactId}`);

      expect(await downloaded.text()).toBe("# the report\n");
    } finally {
      await view.unmount();
    }

    // After a reload the same replay produces the same link: the artifact is
    // a durable row, not a live-session artifact.
    const reloaded = await mountConsole(api);

    try {
      await until(
        () => reloaded.container.querySelector("a.tool-call-download") !== null,
        "the artifact link after reload",
      );

      expect(reloaded.container.querySelector("a.tool-call-download")?.getAttribute("href")).toBe(
        `/files/${artifactId}`,
      );
    } finally {
      await reloaded.unmount();
      await api.close();
    }
  });
});
