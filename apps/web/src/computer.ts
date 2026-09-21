import type {
  Bot,
  ComputerDirectoryView,
  ComputerFileEntryView,
  ComputerFileView,
  ComputerProvidersView,
  ComputerProviderView,
  ComputerSnapshotView,
  ComputerTerminalView,
  ComputerView,
  ProviderFailureKindView,
} from "@porkbot/contracts";

/**
 * The bot-computer screen's state machine (slices 9.4, 11.4 and 13.10, PRD
 * stories 27 and 31, decision 20): a framework-free controller like the memory
 * and connections screens', so the screen renders one state object and the
 * read/write rules live where a unit test can drive them without a DOM.
 *
 * The controller owns the operator's questions. Is the machine up, and what
 * can I do to it: the lifecycle verbs the supervisor owns — boot, stop, reset,
 * recover — each one write, and the destructive pair (reset and recover, both
 * of which can leave a machine that does not exist) is stated before it acts.
 * The screen's own chrome reads that state as a state — one word with a
 * control beside it — rather than as a sentence (design record, State
 * vocabulary; issue #234). What is happening inside it: the terminal runs
 * commands through the same supervisor exec seam the model's shell tool uses,
 * and the file view lists the bot's home and reads one file from it, both
 * home-scoped. Where does this bot run: the bot's stored `computerProvider` is
 * the selection, `null` means the deployment's default, and the two are
 * distinguishable because they are different fields rather than a guess. Which
 * providers exist and which are usable: the deployment answers through
 * `computers.providers`, and an unavailable kind is rendered as unavailable
 * with the classified reason the supervisor reported — never smoothed into a
 * checkmark the first run would contradict. What happens when I switch: the
 * warning is a pure function of state the screen already holds, so the same
 * sentence is computed before the write for the confirmation and after it for
 * the outcome, exactly like the connections screen's revoke.
 *
 * The snapshot path is explicit because a provider switch moves nothing. A
 * home lives on one provider's machine and a snapshot is an archive in the
 * space's storage: capturing the running machine first, switching, and then
 * restoring the snapshot into the new machine is how files cross the boundary.
 * The controller exposes the three steps separately so each is one operator
 * decision and each failure keeps the previous state readable.
 *
 * Screen watch and takeover are deliberately absent (PRD story 28, issue
 * #178): v1.0's observability is the terminal and file tabs beside the screen
 * surface. The seam is already reserved at the bottom of the stack —
 * `ComputerProvider` declares optional `frames()` and `input()`, and the
 * supervisor's capability-gated `/frames` and `/input` paths answer
 * `not_implemented` — so a v1.1 stream lands as one adapter plus the screen
 * surface's body and its take-control control, not as a redesign. The surface
 * therefore states plainly that no live view exists today, and nothing in this
 * module names a frame.
 */

/** A provider the operator can choose: a kind, or `null` for the deployment default. */
export interface ProviderChoice {
  readonly kind: string | null;
}

export interface ComputerNotice {
  readonly kind: "info" | "error";
  readonly text: string;
}

/** One terminal run: the command as typed and the machine's whole answer. */
export interface TerminalEntry extends ComputerTerminalView {
  readonly command: string;
}

/**
 * The most terminal runs the screen keeps. Each answer can carry the view's
 * whole output bound, so an unbounded history would grow the controller and
 * the DOM for the life of the tab; older runs fall away and the newest are
 * what the operator is reading anyway.
 */
export const MAX_TERMINAL_ENTRIES = 50;

/** What the file view is showing: the listed directory, its entries and any open file. */
export interface ComputerFilesState {
  /** The home-relative directory last listed; `null` until one is read. */
  readonly path: string | null;
  readonly entries: readonly ComputerFileEntryView[];
  /** The file opened for reading, or `null` when none is. */
  readonly preview: ComputerFileView | null;
  readonly pending: boolean;
  /** The sentence for the last refused browse, or `null`. */
  readonly refusal: string | null;
}

/** The lifecycle verbs the supervisor owns; each is one write on the machine. */
export type ComputerLifecycleAction = "boot" | "stop" | "reset" | "recover";

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
  readonly pending: "switch" | "snapshot" | "restore" | ComputerLifecycleAction | null;
  readonly notice: ComputerNotice | null;
  /** The terminal's runs, oldest first. */
  readonly terminal: {
    readonly pending: boolean;
    readonly entries: readonly TerminalEntry[];
  };
  /** The file view's last listing and open file. */
  readonly files: ComputerFilesState;
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
  boot(input: { readonly botId: string }): Promise<ComputerView>;
  stop(input: { readonly botId: string }): Promise<ComputerView>;
  reset(input: { readonly botId: string }): Promise<ComputerView>;
  recover(input: { readonly botId: string }): Promise<ComputerView>;
  /** Runs one command through the supervisor's exec seam. */
  terminal(input: {
    readonly botId: string;
    readonly command: string;
  }): Promise<ComputerTerminalView>;
  /** Lists one directory of the bot's home; an absent path is the home itself. */
  files(input: {
    readonly botId: string;
    readonly path?: string | undefined;
  }): Promise<ComputerDirectoryView>;
  /** Reads one file of the bot's home. */
  file(input: { readonly botId: string; readonly path: string }): Promise<ComputerFileView>;
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
  /** Starts, stops, resets or recovers the machine; the answer is the new state. */
  lifecycle(action: ComputerLifecycleAction): Promise<void>;
  /** Runs one terminal command and appends its answer. */
  run(command: string): Promise<void>;
  /** Opens a directory by its entry, or lists the home when one is absent. */
  openDirectory(entry: ComputerFileEntryView | null): Promise<void>;
  /** Opens one of the listed files for reading. */
  openFile(entry: ComputerFileEntryView): Promise<void>;
  /** Navigates to the parent of the listed directory, staying at the home. */
  openParent(): Promise<void>;
}

/** The lifecycle verbs the confirmation arms, as the controller names them. */
export const lifecycleActions: readonly ComputerLifecycleAction[] = [
  "boot",
  "stop",
  "reset",
  "recover",
];

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

/**
 * The machine's state as the surface states it: one word and one hook, not a
 * sentence (design record, State vocabulary). `unassigned` is the bot with no
 * machine yet — a normal answer the screen renders, not an error.
 */
export type MachineState = "unassigned" | "running" | "stopped" | "gone";

export function machineState(state: Pick<ComputerState, "bot" | "computer">): MachineState {
  if (
    state.bot === null ||
    state.bot.computerId === null ||
    state.computer === null ||
    !state.computer.assigned
  ) {
    return "unassigned";
  }

  return state.computer.state;
}

/** The word the lifecycle control shows; the same word the screen's body reads. */
export function machineStateWord(state: Pick<ComputerState, "bot" | "computer">): string {
  switch (machineState(state)) {
    case "unassigned":
      return "No machine";
    case "running":
      return "Running";
    case "stopped":
      return "Stopped";
    case "gone":
      return "Gone";
  }
}

/**
 * What the screen surface says where no live view exists. A provider offers no
 * frames in v1.0 (issue #178 reserves the stream for v1.1), so the surface
 * states that plainly and points at the tabs that do show the machine, rather
 * than rendering an empty frame that looks like a load.
 */
export function machineStateNote(state: Pick<ComputerState, "bot" | "computer">): string {
  switch (machineState(state)) {
    case "unassigned":
      return "It is created the first time this bot runs.";
    case "running":
      return "No live view: this provider sends no frames yet. The terminal and files tabs show what the machine is doing.";
    case "stopped":
      return "Start the machine to use its terminal and files.";
    case "gone":
      return "The provider no longer holds it. Recover to create a fresh machine; its home is not on the provider.";
  }
}

/**
 * The confirmation sentence for a recover, computed from state the screen
 * already holds. Recover asks the provider to bring the machine back: one it
 * still holds is adopted or started, and one it no longer holds is created
 * fresh — which is why the sentence names the empty home before the write.
 */
export function recoverWarning(state: Pick<ComputerState, "snapshots">): string {
  return state.snapshots.length === 0
    ? "Recovering adopts this machine if the provider still holds it and creates a fresh one if not. A fresh machine starts with an empty home; nothing is snapshotted."
    : "Recovering adopts this machine if the provider still holds it and creates a fresh one if not. A fresh machine starts with an empty home; snapshots are kept, and one can be restored into it.";
}

/**
 * The one-line statement each lifecycle verb carries in the control's menu, so
 * the menu says what the action does before it is chosen (issue #234). The
 * destructive pair reads as a consequence, and Reset keeps the register's
 * destructive colour because the item destroys the machine's home.
 */
export function lifecycleActionLabel(action: ComputerLifecycleAction): string {
  switch (action) {
    case "boot":
      return "Start — bring the machine up";
    case "stop":
      return "Stop — park it, keeping the home";
    case "reset":
      return "Reset — destroy the machine and its home";
    case "recover":
      return "Recover — adopt it, or create a fresh one";
  }
}

/** The lifecycle write in flight, or `null` when `pending` is another write. */
export function lifecyclePending(
  pending: ComputerState["pending"],
): ComputerLifecycleAction | null {
  return pending === "boot" || pending === "stop" || pending === "reset" || pending === "recover"
    ? pending
    : null;
}

/**
 * What one configured kind is, in a sentence, for the provider sheet (issue
 * #234). The three v1.0 kinds answer from the operator documentation
 * (`docs/computers.md`); a kind a future deployment configures reads as
 * itself rather than as a blank.
 */
export function providerDescription(kind: string): string {
  switch (kind) {
    case "offline":
      return "An in-process emulator on this deployment; not a security boundary.";
    case "docker":
      return "A container on the host that serves this deployment, on its own isolated network.";
    case "daytona":
      return "A sandbox in the Daytona cloud.";
    default:
      return "";
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

/**
 * Whether the machine is up. Its terminal and files exist only while it runs —
 * a stopped or missing machine has no shell to reach — so the screen disables
 * both rather than letting a command answer the supervisor's refusal.
 */
export function canBrowse(state: Pick<ComputerState, "computer">): boolean {
  return state.computer?.assigned === true && state.computer.state === "running";
}

/**
 * The reset confirmation's sentence, computed from state the screen already
 * holds. A reset destroys the machine and its home — processes, files, the lot
 * — and keeps only the space's snapshots, so the sentence says which of the
 * two situations the operator is in before the write.
 */
export function resetWarning(state: Pick<ComputerState, "snapshots">): string {
  return state.snapshots.length === 0
    ? "Resetting destroys this machine and its home; nothing is snapshotted. The next run creates a clean machine."
    : "Resetting destroys this machine and its home. Snapshots are kept; restore one to bring files back.";
}

/** The outcome sentence each lifecycle write reports, in the screen's own words. */
export function lifecycleOutcome(action: ComputerLifecycleAction): string {
  switch (action) {
    case "boot":
      return "The machine was started.";
    case "stop":
      return "The machine was stopped. Its home stays on the provider.";
    case "recover":
      return "The machine was recovered.";
    case "reset":
      return "The machine was reset. Its home is gone; snapshots are kept.";
  }
}

/** The sentence an action's button shows while its write is in flight. */
export function lifecyclePendingLabel(action: ComputerLifecycleAction): string {
  switch (action) {
    case "boot":
      return "Starting…";
    case "stop":
      return "Stopping…";
    case "recover":
      return "Recovering…";
    case "reset":
      return "Resetting…";
  }
}

/** The home-relative path one entry would open, given the directory it is in. */
export function childPath(directory: string, name: string): string {
  return directory === "" ? name : `${directory}/${name}`;
}

/** The parent of a home-relative directory, clamped at the home. */
export function parentPath(directory: string): string {
  const slash = directory.lastIndexOf("/");

  return slash < 0 ? "" : directory.slice(0, slash);
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
    terminal: { pending: false, entries: [] },
    files: { path: null, entries: [], preview: null, pending: false, refusal: null },
  };
  // Bumped on every read, so a late answer from a superseded load cannot
  // replace the state a newer one already produced.
  let generation = 0;
  // The file view's own read counter, so a directory answer that a later
  // navigation superseded cannot replace the listing the operator is looking at.
  let filesGeneration = 0;

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

      // A running machine has a shell to point the file view at, so the home
      // is listed as part of the read; a stopped one leaves the last listing
      // in place, disabled. The read is not awaited so the rest of the screen
      // renders first and the section's own pending state is honest.
      if (canBrowse({ computer: loaded.computer })) {
        void loadDirectory(undefined);
      }
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

  /**
   * The file view's read. The listing replaces the previous one only when it
   * is the newest read — a navigation that outran another keeps the directory
   * the operator asked for — and a refused read keeps the previous listing
   * visible with the refusal beside it.
   */
  async function loadDirectory(path: string | undefined): Promise<void> {
    const mine = ++filesGeneration;
    publish({ ...state, files: { ...state.files, pending: true, refusal: null } });

    try {
      const listing = await transport.files(path === undefined ? { botId } : { botId, path });

      if (mine !== filesGeneration) {
        return;
      }

      publish({
        ...state,
        files: {
          path: listing.path,
          entries: listing.entries,
          preview: null,
          pending: false,
          refusal: null,
        },
      });
    } catch {
      if (mine !== filesGeneration) {
        return;
      }

      publish({
        ...state,
        files: { ...state.files, pending: false, refusal: "That directory could not be listed." },
      });
    }
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

    async lifecycle(action) {
      await apply(action, async () => {
        await transport[action]({ botId });

        return { kind: "info", text: lifecycleOutcome(action) };
      });
    },

    async run(command) {
      const trimmed = command.trim();

      if (trimmed === "" || state.terminal.pending) {
        return;
      }

      publish({ ...state, terminal: { ...state.terminal, pending: true }, notice: null });

      try {
        const result = await transport.terminal({ botId, command: trimmed });

        const kept = [...state.terminal.entries, { command: trimmed, ...result }];

        publish({
          ...state,
          terminal: {
            pending: false,
            entries: kept.slice(Math.max(0, kept.length - MAX_TERMINAL_ENTRIES)),
          },
        });
      } catch {
        publish({
          ...state,
          terminal: { ...state.terminal, pending: false },
          notice: { kind: "error", text: "The command could not be run." },
        });
      }
    },

    async openDirectory(entry) {
      if (entry !== null && entry.kind !== "directory") {
        return;
      }

      const target = entry === null ? "" : childPath(state.files.path ?? "", entry.name);

      await loadDirectory(target);
    },

    async openFile(entry) {
      if (entry.kind !== "file") {
        return;
      }

      const mine = ++filesGeneration;
      const path = childPath(state.files.path ?? "", entry.name);
      publish({ ...state, files: { ...state.files, pending: true, refusal: null } });

      try {
        const file = await transport.file({ botId, path });

        if (mine !== filesGeneration) {
          return;
        }

        publish({
          ...state,
          files: { ...state.files, preview: file, pending: false, refusal: null },
        });
      } catch {
        if (mine !== filesGeneration) {
          return;
        }

        publish({
          ...state,
          files: { ...state.files, pending: false, refusal: "That file could not be read." },
        });
      }
    },

    async openParent() {
      await loadDirectory(parentPath(state.files.path ?? ""));
    },
  };
}
