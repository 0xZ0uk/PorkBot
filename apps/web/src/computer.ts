import type {
  Bot,
  ComputerProvidersView,
  ComputerProviderView,
  ComputerSnapshotView,
  ComputerView,
  ProviderFailureKindView,
} from "@porkbot/contracts";

/**
 * The bot-computer screen's state machine (slice 9.4, PRD story 31): a
 * framework-free controller like the memory and connections screens', so the
 * screen renders one state object and the read/write rules live where a unit
 * test can drive them without a DOM.
 *
 * The controller owns the operator's questions. Where does this bot run: the
 * bot's stored `computerProvider` is the selection, `null` means the
 * deployment's default, and the two are distinguishable because they are
 * different fields rather than a guess. Which providers exist and which are
 * usable: the deployment answers through `computers.providers`, and an
 * unavailable kind is rendered as unavailable with the classified reason the
 * supervisor reported — never smoothed into a checkmark the first run would
 * contradict. What happens when I switch: the warning is a pure function of
 * state the screen already holds, so the same sentence is computed before the
 * write for the confirmation and after it for the outcome, exactly like the
 * connections screen's revoke.
 *
 * The snapshot path is explicit because a provider switch moves nothing. A
 * home lives on one provider's machine and a snapshot is an archive in the
 * space's storage: capturing the running machine first, switching, and then
 * restoring the snapshot into the new machine is how files cross the boundary.
 * The controller exposes the three steps separately so each is one operator
 * decision and each failure keeps the previous state readable.
 */

/** A provider the operator can choose: a kind, or `null` for the deployment default. */
export interface ProviderChoice {
  readonly kind: string | null;
}

export interface ComputerNotice {
  readonly kind: "info" | "error";
  readonly text: string;
}

export interface ComputerState {
  readonly status: "loading" | "ready" | "refused";
  /** The sentence to show when `status` is `refused`, else `null`. */
  readonly refusal: string | null;
  readonly bot: Bot | null;
  readonly providers: ComputerProvidersView | null;
  readonly computer: ComputerView | null;
  readonly snapshots: readonly ComputerSnapshotView[];
  /** The choice armed for confirmation, or `null` when the radios are quiet. */
  readonly candidate: ProviderChoice | null;
  /** What write is in flight, for disabling the controls. */
  readonly pending: "switch" | "snapshot" | "restore" | null;
  readonly notice: ComputerNotice | null;
}

/** The API surface the computer screen needs, narrow enough to fake. */
export interface ComputerTransport {
  /** One read: the bot, the deployment's providers, the machine and its snapshots. */
  load(botId: string): Promise<{
    readonly bot: Bot;
    readonly providers: ComputerProvidersView;
    readonly computer: ComputerView;
    readonly snapshots: readonly ComputerSnapshotView[];
  }>;
  setProvider(input: { readonly botId: string; readonly kind: string | null }): Promise<Bot>;
  snapshot(input: { readonly botId: string }): Promise<ComputerSnapshotView>;
  restore(input: { readonly botId: string; readonly snapshotId: string }): Promise<ComputerView>;
}

export interface ComputerController {
  state(): ComputerState;
  subscribe(listener: () => void): () => void;
  /** The initial read and the explicit retry; clears any notice and confirmation. */
  load(): void;
  /** Arms a different choice for confirmation; choosing the current one is a no-op. */
  choose(choice: ProviderChoice): void;
  /** Cancels the armed choice. */
  cancel(): void;
  /** Captures the running machine and records it in the space's storage. */
  snapshot(): Promise<void>;
  /** Replaces the bot's machine home with a captured snapshot. */
  restore(snapshotId: string): Promise<void>;
  /** Confirms the armed choice: validates, then stores it. */
  confirm(): Promise<void>;
}

export interface ComputerControllerOptions {
  readonly transport: ComputerTransport;
  readonly botId: string;
}

const unreadable = "The computer settings could not be loaded.";

/** The kind a bot actually runs on: its own selection, or the deployment's default. */
export function effectiveKind(state: Pick<ComputerState, "bot" | "providers">): string | null {
  if (state.bot === null || state.providers === null) {
    return null;
  }

  return state.bot.computerProvider ?? state.providers.defaultKind;
}

/** Whether the bot follows the deployment default rather than its own kind. */
export function followsDefault(state: Pick<ComputerState, "bot">): boolean {
  return state.bot !== null && state.bot.computerProvider === null;
}

/**
 * The display name of a kind. The kinds are the deployment's own vocabulary;
 * the three v1.0 names get a sentence an operator recognizes, and anything a
 * future deployment configures reads as itself rather than as a blank.
 */
export function providerName(kind: string): string {
  switch (kind) {
    case "offline":
      return "Offline emulator";
    case "docker":
      return "Local Docker";
    case "daytona":
      return "Daytona cloud";
    default:
      return kind;
  }
}

/** The sentence an unavailable provider shows, in the shared vocabulary's terms. */
const failureSentences: Record<ProviderFailureKindView, string> = {
  gone: "Not reachable",
  not_found: "Not reachable",
  rate_limited: "Rate limited",
  timed_out: "Did not answer",
  auth_failed: "Credentials refused",
};

/** What one provider's readiness answer reads as. */
export function availabilityOf(provider: ComputerProviderView): string {
  if (provider.available) {
    return "Available";
  }

  return provider.failure === null
    ? "Unavailable"
    : `Unavailable · ${failureSentences[provider.failure]}`;
}

/** The provider a bot's selection names, when the deployment still configures it. */
export function selectedProvider(
  state: Pick<ComputerState, "bot" | "providers">,
): ComputerProviderView | null {
  const kind = state.bot?.computerProvider ?? null;

  if (kind === null || state.providers === null) {
    return null;
  }

  return state.providers.providers.find((provider) => provider.kind === kind) ?? null;
}

/**
 * Whether the bot is stored on a kind this deployment no longer configures.
 * That is a real state — a deployment can drop a provider after a bot selected
 * it — and the screen says so rather than showing a radio that cannot check.
 */
export function selectionUnconfigured(state: Pick<ComputerState, "bot" | "providers">): boolean {
  const kind = state.bot?.computerProvider ?? null;

  if (kind === null || state.providers === null) {
    return false;
  }

  return !state.providers.providers.some((provider) => provider.kind === kind);
}

/** The machines' state as one sentence: nothing assigned, or what the provider reported. */
export function computerSentence(state: Pick<ComputerState, "bot" | "computer">): string {
  if (state.bot === null || state.bot.computerId === null || state.computer === null) {
    return "No machine yet. It is created the first time this bot runs.";
  }

  if (!state.computer.assigned) {
    return "No machine yet. It is created the first time this bot runs.";
  }

  switch (state.computer.state) {
    case "running":
      return "The machine is running.";
    case "stopped":
      return "The machine is stopped. Its home stays on the provider.";
    case "gone":
      return "The machine is gone. Its home is no longer on the provider.";
  }
}

/**
 * The confirmation sentence for a switch, computed from state the screen
 * already holds. It says what does not move — the home, and any snapshot the
 * operator does not restore — and points at the snapshot path, so a switch
 * with files to keep is not a silent loss.
 */
export function switchWarning(
  state: Pick<ComputerState, "bot" | "computer" | "snapshots">,
  candidate: ProviderChoice,
): string {
  const target = candidate.kind === null ? "the deployment default" : providerName(candidate.kind);
  const assigned =
    state.bot !== null && state.bot.computerId !== null && state.computer?.assigned === true;
  const hasSnapshots = state.snapshots.length > 0;

  if (!assigned && !hasSnapshots) {
    return `Switching to ${target} stores where the next machine is created. There is no home or snapshot to move.`;
  }

  if (!assigned) {
    return `Switching to ${target} does not apply a snapshot automatically. Snapshots stay in this space and can be restored into the machine on ${target}.`;
  }

  if (state.computer?.assigned === true && state.computer.state === "gone") {
    return `Switching to ${target} keeps this bot's home gone: the current machine no longer exists on its provider. Snapshots stay in this space and can be restored into the machine on ${target}.`;
  }

  return `Switching to ${target} does not move this bot's home or apply a snapshot. Take a snapshot first to bring the files across, then restore it once the machine runs on ${target}.`;
}

/** The outcome sentence for a switch, shown after the write. */
export function switchOutcome(candidate: ProviderChoice): string {
  return candidate.kind === null
    ? "This bot now follows the deployment default."
    : `This bot now runs on ${providerName(candidate.kind)}.`;
}

export function createComputerController(options: ComputerControllerOptions): ComputerController {
  const { transport, botId } = options;
  const listeners = new Set<() => void>();
  let state: ComputerState = {
    status: "loading",
    refusal: null,
    bot: null,
    providers: null,
    computer: null,
    snapshots: [],
    candidate: null,
    pending: null,
    notice: null,
  };
  // Bumped on every read, so a late answer from a superseded load cannot
  // replace the state a newer one already produced.
  let generation = 0;

  function publish(next: ComputerState): void {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  /** The shared read: everything the screen renders in one pass. */
  async function reload(clearNotice: boolean): Promise<void> {
    const mine = ++generation;
    publish({
      ...state,
      status: "loading",
      refusal: null,
      ...(clearNotice ? { notice: null, candidate: null } : {}),
    });

    try {
      const loaded = await transport.load(botId);

      if (mine !== generation) {
        return;
      }

      publish({
        ...state,
        status: "ready",
        refusal: null,
        bot: loaded.bot,
        providers: loaded.providers,
        computer: loaded.computer,
        snapshots: loaded.snapshots,
      });
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "refused", refusal: unreadable });
    }
  }

  /**
   * The shared tail of a write: hold the controls, run the write, then re-read
   * and say what happened. The answer is whether the write landed, so a
   * confirmation stays armed until it actually did.
   */
  async function apply(pending: ComputerState["pending"], call: () => Promise<ComputerNotice>) {
    publish({ ...state, pending, notice: null });

    let notice: ComputerNotice;

    try {
      notice = await call();
    } catch {
      publish({
        ...state,
        pending: null,
        notice: { kind: "error", text: "The change could not be saved." },
      });

      return false;
    }

    publish({ ...state, pending: null, notice });
    await reload(false);

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
      void reload(true);
    },

    choose(choice) {
      // Choosing what the bot already follows arms nothing.
      if (choice.kind === (state.bot?.computerProvider ?? null)) {
        publish({ ...state, candidate: null });
        return;
      }

      publish({ ...state, candidate: choice, notice: null });
    },

    cancel() {
      publish({ ...state, candidate: null });
    },

    async snapshot() {
      await apply("snapshot", async () => {
        await transport.snapshot({ botId });

        return {
          kind: "info",
          text: "Snapshot captured. Switch, then restore it into the new machine.",
        };
      });
    },

    async restore(snapshotId) {
      await apply("restore", async () => {
        await transport.restore({ botId, snapshotId });

        return { kind: "info", text: "Snapshot restored into this bot's machine." };
      });
    },

    async confirm() {
      const candidate = state.candidate;

      if (candidate === null) {
        return;
      }

      const landed = await apply("switch", async () => {
        await transport.setProvider({ botId, kind: candidate.kind });

        return { kind: "info", text: switchOutcome(candidate) };
      });

      if (landed && state.candidate !== null && state.candidate.kind === candidate.kind) {
        publish({ ...state, candidate: null });
      }
    },
  };
}
