import type {
  MemoryDocumentView,
  MemoryRevisionView,
  MemoryWriteOutcomeView,
} from "@porkbot/contracts";

/**
 * The memory screen's state machine (slice 8.3, PRD decision 21; story 24): a
 * framework-free controller like the thread console, so the screen is a
 * function of one state object and the fetch-and-refresh rules live in one
 * place a unit test can drive without a DOM.
 *
 * The controller's subject is the store's own decisions. A mutation —
 * correcting a document, removing it, restoring a revision — is applied by the
 * server and its outcome is rendered as the server wrote it: an effective
 * change reloads the list and the open history, `no_change` says nothing
 * happened, and a domain refusal shows the rule's sentence without pretending
 * the write landed. Editing memory therefore takes effect immediately: the
 * reload is a new `list` call, not a restart or a run.
 *
 * History is loaded on demand and kept per document, because a bot can hold
 * many documents and most are never expanded. The tombstone scope lists what a
 * deletion removed; restoring from that list names the tombstone revision the
 * list already carries, so the screen never guesses a revision number.
 */

/** The API surface the memory screen needs, narrow enough to fake without a network. */
export interface MemoryTransport {
  list(botId: string, scope: MemoryScope): Promise<readonly MemoryDocumentView[]>;
  revisions(botId: string, documentId: string): Promise<readonly MemoryRevisionView[]>;
  update(input: {
    readonly botId: string;
    readonly documentId: string;
    readonly title: string;
    readonly content: string;
    readonly reason: string;
  }): Promise<MemoryWriteOutcomeView>;
  remove(input: {
    readonly botId: string;
    readonly documentId: string;
    readonly reason: string;
  }): Promise<MemoryWriteOutcomeView>;
  restore(input: {
    readonly botId: string;
    readonly documentId: string;
    readonly revision: number;
    readonly reason: string;
  }): Promise<MemoryWriteOutcomeView>;
}

/** Which documents the list shows; live by default, tombstones on request. */
export type MemoryScope = "active" | "deleted";

export interface MemoryHistoryState {
  readonly status: "loading" | "ready" | "refused";
  readonly revisions: readonly MemoryRevisionView[];
}

/**
 * A mutation's answer, scoped to the document it concerns so the sentence
 * appears beside the right card rather than as page-level chrome.
 */
export interface MemoryNotice {
  readonly documentId: string;
  readonly kind: "error" | "info";
  readonly text: string;
}

export interface MemoryState {
  readonly botId: string;
  readonly status: "loading" | "ready" | "refused";
  /** The sentence to show when `status` is `refused`, else `null`. */
  readonly refusal: string | null;
  readonly scope: MemoryScope;
  readonly documents: readonly MemoryDocumentView[];
  /** Open document histories, by document id; absent until one is opened. */
  readonly history: Readonly<Record<string, MemoryHistoryState>>;
  /** Which histories are expanded, in the order they were first opened. */
  readonly openHistory: readonly string[];
  readonly notice: MemoryNotice | null;
  /** The document whose mutation is in flight, for disabling its controls. */
  readonly pendingDocumentId: string | null;
}

export interface MemoryController {
  state(): MemoryState;
  subscribe(listener: () => void): () => void;
  /** Reads the current scope; a newer call supersedes one still in flight. */
  load(): void;
  setScope(scope: MemoryScope): void;
  /** Opens a document's history, loading it the first time. */
  toggleHistory(documentId: string): void;
  /** Applies a correction; resolves true when the server accepted an effective change. */
  save(input: {
    readonly documentId: string;
    readonly title: string;
    readonly content: string;
    readonly reason: string;
  }): Promise<boolean>;
  remove(input: { readonly documentId: string; readonly reason: string }): Promise<boolean>;
  restore(input: {
    readonly documentId: string;
    readonly revision: number;
    readonly reason: string;
  }): Promise<boolean>;
}

export interface MemoryControllerOptions {
  readonly transport: MemoryTransport;
  readonly botId: string;
}

const unreadable = "Memory could not be loaded.";

export function createMemoryController(options: MemoryControllerOptions): MemoryController {
  const { transport, botId } = options;
  const listeners = new Set<() => void>();
  let state: MemoryState = {
    botId,
    status: "loading",
    refusal: null,
    scope: "active",
    documents: [],
    history: {},
    openHistory: [],
    notice: null,
    pendingDocumentId: null,
  };
  // Bumped on every list load and, per document, on every history load, so a
  // late answer from a superseded request cannot replace the state a newer one
  // already produced.
  let listGeneration = 0;
  const historyGeneration = new Map<string, number>();

  function publish(next: MemoryState): void {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  async function reload(scope: MemoryScope): Promise<void> {
    const mine = ++listGeneration;
    publish({ ...state, status: "loading", scope, refusal: null, notice: null });

    try {
      const documents = await transport.list(botId, scope);

      if (mine !== listGeneration) {
        return;
      }

      publish({ ...state, status: "ready", documents, refusal: null, notice: null });
    } catch {
      if (mine !== listGeneration) {
        return;
      }

      publish({ ...state, status: "refused", documents: [], refusal: unreadable });
    }
  }

  async function loadHistory(documentId: string): Promise<void> {
    const mine = (historyGeneration.get(documentId) ?? 0) + 1;
    historyGeneration.set(documentId, mine);
    const current = state;

    publish({
      ...current,
      history: { ...current.history, [documentId]: { status: "loading", revisions: [] } },
    });

    try {
      const revisions = await transport.revisions(botId, documentId);

      if (historyGeneration.get(documentId) !== mine) {
        return;
      }

      publish({
        ...state,
        history: { ...state.history, [documentId]: { status: "ready", revisions } },
      });
    } catch {
      if (historyGeneration.get(documentId) !== mine) {
        return;
      }

      publish({
        ...state,
        history: { ...state.history, [documentId]: { status: "refused", revisions: [] } },
      });
    }
  }

  /**
   * The shared tail of every mutation: render the decision, then refresh what
   * the decision invalidates. A refusal or `no_change` is the whole story and
   * nothing is refetched; an effective change reloads the list in the current
   * scope and, when it is open, the document's history.
   */
  async function apply(
    documentId: string,
    call: () => Promise<MemoryWriteOutcomeView>,
  ): Promise<boolean> {
    publish({ ...state, pendingDocumentId: documentId, notice: null });

    let outcome: MemoryWriteOutcomeView;

    try {
      outcome = await call();
    } catch {
      publish({
        ...state,
        pendingDocumentId: null,
        notice: { documentId, kind: "error", text: "The change could not be saved." },
      });

      return false;
    }

    if (!outcome.ok) {
      publish({
        ...state,
        pendingDocumentId: null,
        notice: { documentId, kind: "error", text: outcome.message },
      });

      return false;
    }

    if (outcome.action === "no_change") {
      publish({
        ...state,
        pendingDocumentId: null,
        notice: { documentId, kind: "info", text: "Nothing changed." },
      });

      return true;
    }

    publish({ ...state, pendingDocumentId: null, notice: null });
    await reload(state.scope);

    if (state.openHistory.includes(documentId)) {
      await loadHistory(documentId);
    }

    return true;
  }

  return {
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },

    load() {
      void reload(state.scope);
    },

    setScope(scope) {
      if (scope === state.scope) {
        return;
      }

      void reload(scope);
    },

    toggleHistory(documentId) {
      const open = state.openHistory.includes(documentId);

      publish({
        ...state,
        openHistory: open
          ? state.openHistory.filter((candidate) => candidate !== documentId)
          : [...state.openHistory, documentId],
      });

      if (!open && state.history[documentId] === undefined) {
        void loadHistory(documentId);
      }
    },

    save: (input) => apply(input.documentId, () => transport.update({ botId, ...input })),
    remove: (input) => apply(input.documentId, () => transport.remove({ botId, ...input })),
    restore: (input) => apply(input.documentId, () => transport.restore({ botId, ...input })),
  };
}
