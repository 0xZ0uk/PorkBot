import { describe, expect, it } from "vitest";
import { createMemoryController } from "./memory.ts";
import type { MemoryController, MemoryState, MemoryTransport } from "./memory.ts";
import { fakeMemoryDocument, fakeMemoryRevision, scriptedMemoryTransport } from "../test/fakes.ts";

/**
 * The memory controller without a DOM: the fetch-and-refresh rules the screen
 * depends on, driven through the transport seam. The tests pin what a person
 * observes — a scope's documents, a correction that reloads the list, a
 * refusal that shows the rule's sentence rather than pretending the write
 * landed — and the lazy history that is read once per document.
 *
 * The scripted transport applies the same decisions the durable store does,
 * so an effective write is observable as a changed document and no-change and
 * refusal are the store's real answers.
 */

async function until(
  controller: MemoryController,
  predicate: (state: MemoryState) => boolean,
  label: string,
): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate(controller.state())) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error(`timed out waiting for ${label}`);
}

function loaded(
  transport: MemoryTransport,
  botId = "bot-1",
): { readonly controller: MemoryController } {
  const controller = createMemoryController({ transport, botId });
  controller.load();

  return { controller };
}

describe("loading the list", () => {
  it("reads the active scope first and the removed scope on request", async () => {
    const transport = scriptedMemoryTransport({
      documents: [
        fakeMemoryDocument(),
        fakeMemoryDocument({
          documentId: "doc-2",
          title: "Old fact",
          deletedAt: "2026-01-02T00:00:00.000Z",
        }),
      ],
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the live list");
    expect(controller.state().documents.map((document) => document.documentId)).toEqual(["doc-1"]);

    controller.setScope("deleted");

    await until(
      controller,
      (state) => state.scope === "deleted" && state.documents.length === 1,
      "the removed list",
    );
    expect(controller.state().documents.map((document) => document.documentId)).toEqual(["doc-2"]);
  });

  it("shows a refusal sentence when the list cannot be read", async () => {
    const transport: MemoryTransport = {
      ...scriptedMemoryTransport(),
      list: async () => {
        throw new Error("unreachable");
      },
    };
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "refused", "the refusal");
    expect(controller.state().refusal).toBe("Memory could not be loaded.");
  });
});

describe("reading history", () => {
  it("loads a document's history once and keeps it cached", async () => {
    let reads = 0;
    const transport: MemoryTransport = {
      ...scriptedMemoryTransport(),
      revisions: async () => {
        reads += 1;
        return [fakeMemoryRevision()];
      },
    };
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    controller.toggleHistory("doc-1");

    await until(controller, (state) => state.history["doc-1"]?.status === "ready", "the history");

    controller.toggleHistory("doc-1");
    controller.toggleHistory("doc-1");

    await until(controller, (state) => state.openHistory.includes("doc-1"), "the reopen");

    expect(reads).toBe(1);
  });
});

describe("applying a mutation", () => {
  it("reloads the list after an effective correction", async () => {
    const transport = scriptedMemoryTransport({
      documents: [fakeMemoryDocument()],
      revisions: { "doc-1": [fakeMemoryRevision()] },
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    const applied = await controller.save({
      documentId: "doc-1",
      title: "Preferred editor",
      content: "The operator prefers Neovim.",
      reason: "operator correction",
    });

    expect(applied).toBe(true);
    expect(controller.state().documents[0]?.content).toBe("The operator prefers Neovim.");
    expect(controller.state().documents[0]?.revision).toBe(2);
    expect(controller.state().notice).toBeNull();
  });

  it("keeps the rule's sentence when the store refuses", async () => {
    const transport = scriptedMemoryTransport();
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    const applied = await controller.save({
      documentId: "doc-1",
      title: "Preferred editor",
      content: "Vim.",
      reason: "operator correction",
    });

    expect(applied).toBe(false);
    expect(controller.state().notice?.kind).toBe("error");
    expect(controller.state().notice?.text).toContain("doc-1");
  });

  it("says nothing changed when the store decides no_change", async () => {
    const transport = scriptedMemoryTransport({
      documents: [fakeMemoryDocument()],
      revisions: { "doc-1": [fakeMemoryRevision()] },
    });
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    const applied = await controller.save({
      documentId: "doc-1",
      title: "Preferred editor",
      content: "The operator prefers keyboard-driven editing.",
      reason: "operator correction",
    });

    expect(applied).toBe(true);
    expect(controller.state().notice).toMatchObject({ kind: "info", text: "Nothing changed." });
  });

  it("reports a transport failure without losing the loaded list", async () => {
    const transport: MemoryTransport = {
      ...scriptedMemoryTransport({
        documents: [fakeMemoryDocument()],
        revisions: { "doc-1": [fakeMemoryRevision()] },
      }),
      update: async () => {
        throw new Error("unreachable");
      },
    };
    const { controller } = loaded(transport);

    await until(controller, (state) => state.status === "ready", "the list");
    const applied = await controller.save({
      documentId: "doc-1",
      title: "Preferred editor",
      content: "Vim.",
      reason: "operator correction",
    });

    expect(applied).toBe(false);
    expect(controller.state().documents).toHaveLength(1);
    expect(controller.state().notice).toMatchObject({
      kind: "error",
      text: "The change could not be saved.",
    });
  });
});
