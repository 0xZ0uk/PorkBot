import type {
  MemoryEntry,
  MemoryMatch,
  MemoryProvider,
  MemorySearchRequest,
  ProviderFailure,
} from "@porkbot/adapter-kit";
import { isProviderFailure } from "@porkbot/adapter-kit";

/**
 * Recall over two indexes: the deterministic lexical emulator, always
 * available, and an optional real provider that may add semantic ranking.
 *
 * The product never depends on a hosted vendor to remember something. With no
 * provider configured `search` answers from the lexical index; with one
 * configured, `auto` prefers it and `semantic` asks for it, and any classified
 * provider failure (`rate_limited`, `timed_out`, `auth_failed`, …) falls back
 * to lexical matching rather than failing the run. The match `mode` says which
 * index actually answered, so a caller can tell a preference from a
 * degradation. A failure that is not classified is a programming error and is
 * not swallowed.
 *
 * `index` and `forget` reach both indexes: the lexical one is the floor and a
 * failure there is a bug, while the real provider is best-effort exactly
 * because it is only an index — losing it costs recall quality, never a
 * document. `onDegrade` is the operator's window into that, so a refused
 * credential is visible rather than a silently empty memory.
 */

export type MemoryRecallOperation = "index" | "forget" | "search";

export interface MemoryRecallOptions {
  /** The offline lexical index; always present. */
  readonly lexical: MemoryProvider;
  /** The optional real provider; absent means lexical answers everything. */
  readonly semantic?: MemoryProvider;
  /** Called when a configured provider fails and recall degrades. */
  readonly onDegrade?: (failure: ProviderFailure, operation: MemoryRecallOperation) => void;
}

export class MemoryRecall implements MemoryProvider {
  readonly #lexical: MemoryProvider;
  readonly #semantic: MemoryProvider | undefined;
  readonly #onDegrade:
    ((failure: ProviderFailure, operation: MemoryRecallOperation) => void) | undefined;

  constructor(options: MemoryRecallOptions) {
    this.#lexical = options.lexical;
    this.#semantic = options.semantic;
    this.#onDegrade = options.onDegrade;
  }

  async index(entries: readonly MemoryEntry[]): Promise<void> {
    await this.#lexical.index(entries);
    await this.#bestEffort("index", async () => this.#semantic?.index(entries));
  }

  async forget(botId: string, documentIds: readonly string[]): Promise<void> {
    await this.#lexical.forget(botId, documentIds);
    await this.#bestEffort("forget", async () => this.#semantic?.forget(botId, documentIds));
  }

  async search(request: MemorySearchRequest): Promise<readonly MemoryMatch[]> {
    const lexical = (): Promise<readonly MemoryMatch[]> =>
      this.#lexical.search({ ...request, mode: "lexical" });

    if (request.mode === "lexical") {
      return await lexical();
    }

    const semantic = this.#semantic;

    if (semantic === undefined) {
      return await lexical();
    }

    try {
      return await semantic.search(request);
    } catch (error) {
      if (!isProviderFailure(error)) {
        throw error;
      }

      this.#onDegrade?.(error, "search");

      return await lexical();
    }
  }

  /** Runs the semantic half, degrading on a classified failure and only then. */
  async #bestEffort(operation: MemoryRecallOperation, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      if (!isProviderFailure(error)) {
        throw error;
      }

      this.#onDegrade?.(error, operation);
    }
  }
}
