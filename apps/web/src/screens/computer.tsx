import { Button, Dialog, Field, Input, Menu, Sheet, Tabs } from "@porkbot/ui";
import { useState } from "react";
import type {
  ComputerFileEntryView,
  ComputerProviderView,
  ComputerSnapshotView,
} from "@porkbot/contracts";
import {
  availabilityOf,
  canBrowse,
  effectiveKind,
  followsDefault,
  lifecycleActionLabel,
  lifecyclePending,
  lifecyclePendingLabel,
  machineState,
  machineStateNote,
  machineStateWord,
  providerDescription,
  providerName,
  recoverWarning,
  resetWarning,
  selectedProvider,
  selectionUnconfigured,
  switchWarning,
} from "../computer.ts";
import type { ComputerLifecycleAction, ComputerState, ProviderChoice } from "../computer.ts";
import { ComputerSkeleton } from "./loading.tsx";

/**
 * One bot's computer (slices 9.4, 11.4 and 13.10; PRD stories 27, 30 and 31):
 * the machine as a surface, not a form.
 *
 * The screen is the primary tab: a window frame with the machine's state
 * inside it. A provider that offers frames gets a live body here and a
 * take-control control in the chrome; no provider does in v1.0 (issue #178
 * reserves the stream for v1.1), so the body states that plainly and points at
 * the tabs that do show the machine. The terminal and the file view are the
 * other two tabs — each one command or one directory, through the same
 * supervisor seams the model's tools use — and both read the machine's state
 * rather than a supervisor refusal when it is not running.
 *
 * Lifecycle is one control: its trigger is the state word (Running, Stopped,
 * Gone, No machine), and its menu states what each verb does before it is
 * chosen. Start and Stop act on selection; Reset and Recover open a
 * confirmation that names what the write can destroy, because both can leave a
 * machine that does not exist. The provider choice is a sheet: what each kind
 * is, whether it is available and why not, and a selection still confirms
 * before it is stored. Snapshots keep their list and their per-row restore
 * confirmation.
 */

export interface ComputerScreenProps {
  readonly state: ComputerState;
  readonly onReload: () => void;
  readonly onChoose: (choice: ProviderChoice) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly onSnapshot: () => Promise<void>;
  readonly onRestore: (snapshotId: string) => Promise<void>;
  readonly onLifecycle: (action: ComputerLifecycleAction) => Promise<void>;
  readonly onRun: (command: string) => Promise<void>;
  readonly onOpenDirectory: (entry: ComputerFileEntryView | null) => Promise<void>;
  readonly onOpenFile: (entry: ComputerFileEntryView) => Promise<void>;
  readonly onOpenParent: () => Promise<void>;
}

export function ComputerScreen({
  state,
  onReload,
  onChoose,
  onCancel,
  onConfirm,
  onSnapshot,
  onRestore,
  onLifecycle,
  onRun,
  onOpenDirectory,
  onOpenFile,
  onOpenParent,
}: ComputerScreenProps) {
  const [tab, setTab] = useState("screen");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirming, setConfirming] = useState<ComputerLifecycleAction | null>(null);

  if (state.status === "refused") {
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {state.refusal}
        </p>
        <Button onClick={onReload}>Try again</Button>
      </section>
    );
  }

  if (state.bot === null || state.providers === null) {
    return <ComputerSkeleton />;
  }

  const busy = state.pending !== null;
  const running = canBrowse(state);
  const switchOpen = state.candidate !== null;

  return (
    <section
      className="mx-auto flex w-full max-w-2xl flex-col gap-3"
      aria-busy={state.status === "loading"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <MachineControl
          state={state}
          onLifecycle={onLifecycle}
          onConfirm={(action) => {
            setConfirming(action);
          }}
        />
        <ProviderBar
          state={state}
          onOpen={() => {
            setSheetOpen(true);
          }}
        />
      </div>

      {state.notice === null || switchOpen ? null : (
        <p
          className={
            state.notice.kind === "error"
              ? "rounded-md border border-destructive bg-card p-2 text-foreground"
              : "text-muted-foreground"
          }
          role={state.notice.kind === "error" ? "alert" : "status"}
        >
          {state.notice.text}
        </p>
      )}

      <Tabs
        label="Machine views"
        active={tab}
        onSelect={setTab}
        items={[
          { id: "screen", label: "Screen", panel: <ScreenPanel state={state} /> },
          {
            id: "terminal",
            label: "Terminal",
            panel: running ? (
              <Terminal state={state} onRun={onRun} />
            ) : (
              <p className="text-muted-foreground">{machineStateNote(state)}</p>
            ),
          },
          {
            id: "files",
            label: "Files",
            panel: running ? (
              <Files
                state={state}
                onOpenDirectory={onOpenDirectory}
                onOpenFile={onOpenFile}
                onOpenParent={onOpenParent}
              />
            ) : (
              <p className="text-muted-foreground">{machineStateNote(state)}</p>
            ),
          },
        ]}
      />

      <Snapshots state={state} pending={state.pending} onRestore={onRestore} />

      <ProviderSheet
        state={state}
        open={sheetOpen}
        onClose={() => {
          setSheetOpen(false);
        }}
        onChoose={(choice) => {
          setSheetOpen(false);
          onChoose(choice);
        }}
      />

      {state.candidate === null ? null : (
        <SwitchConfirmation
          state={state}
          onCancel={onCancel}
          onConfirm={onConfirm}
          onSnapshot={onSnapshot}
        />
      )}

      <Dialog
        open={confirming !== null}
        title={confirming === "reset" ? "Reset the machine?" : "Recover the machine?"}
        description={confirming === "reset" ? resetWarning(state) : recoverWarning(state)}
        onClose={() => {
          setConfirming(null);
        }}
        actions={
          <>
            <Button
              variant={confirming === "reset" ? "destructive" : "primary"}
              disabled={busy}
              onClick={() => {
                const action = confirming;
                setConfirming(null);

                if (action !== null) {
                  void onLifecycle(action);
                }
              }}
            >
              {confirming === "reset" ? "Reset the machine" : "Recover the machine"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setConfirming(null);
              }}
            >
              Cancel
            </Button>
          </>
        }
      />
    </section>
  );
}

/**
 * The lifecycle control: the machine's state as its trigger's word, and the
 * four verbs in a menu that states what each one does. Reset and Recover open
 * a confirmation rather than acting on selection, because either can leave the
 * bot with no machine at all.
 */
function MachineControl({
  state,
  onLifecycle,
  onConfirm,
}: {
  readonly state: ComputerState;
  readonly onLifecycle: (action: ComputerLifecycleAction) => Promise<void>;
  readonly onConfirm: (action: ComputerLifecycleAction) => void;
}) {
  const busy = state.pending !== null;
  const running = canBrowse(state);
  const assigned = machineState(state) !== "unassigned";
  const pending = lifecyclePending(state.pending);
  const label = pending === null ? machineStateWord(state) : lifecyclePendingLabel(pending);

  return (
    <span className="inline-flex items-center gap-1 text-meta text-muted-foreground">
      <span
        className="size-2 rounded-full bg-muted-foreground"
        data-state={machineState(state)}
        aria-hidden="true"
      />
      <Menu
        label={label}
        ariaLabel={`${label} — machine actions`}
        items={[
          {
            id: "boot",
            label: lifecycleActionLabel("boot"),
            disabled: busy || !assigned || running,
            onSelect: () => {
              void onLifecycle("boot");
            },
          },
          {
            id: "stop",
            label: lifecycleActionLabel("stop"),
            disabled: busy || !running,
            onSelect: () => {
              void onLifecycle("stop");
            },
          },
          {
            id: "reset",
            label: lifecycleActionLabel("reset"),
            destructive: true,
            disabled: busy || !assigned,
            onSelect: () => {
              onConfirm("reset");
            },
          },
          {
            id: "recover",
            label: lifecycleActionLabel("recover"),
            disabled: busy || !assigned,
            onSelect: () => {
              onConfirm("recover");
            },
          },
        ]}
      />
    </span>
  );
}

/** Where the machine runs, and the sheet that changes it. */
function ProviderBar({
  state,
  onOpen,
}: {
  readonly state: ComputerState;
  readonly onOpen: () => void;
}) {
  const kind = effectiveKind(state);
  const current = selectedProvider(state);
  const unconfigured = selectionUnconfigured(state);

  return (
    <span className="inline-flex items-center gap-1 text-meta">
      <span className="text-muted-foreground">Runs on</span>
      <span className="font-medium">{kind === null ? "no provider" : providerName(kind)}</span>
      {unconfigured ? (
        <span className="text-warning">Not configured</span>
      ) : current === null ? null : (
        <span className={current.available ? "text-muted-foreground" : "text-warning"}>
          {availabilityOf(current)}
        </span>
      )}
      <Button variant="ghost" onClick={onOpen}>
        Change
      </Button>
    </span>
  );
}

/**
 * The screen tab: the window chrome a live view would fill, and the machine's
 * state where no frames exist. Take control lands in the chrome with the v1.1
 * stream (issue #178); no provider offers frames in v1.0, so the surface
 * renders no control that would answer `not_implemented`.
 */
function ScreenPanel({ state }: { readonly state: ComputerState }) {
  const kind = effectiveKind(state);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card" data-computer-frame>
      <div className="flex items-center gap-2 border-b border-border bg-accent px-3 py-2">
        <span className="flex gap-1" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="mx-auto rounded-md bg-background px-3 py-0.5 font-mono text-code text-muted-foreground">
          {kind === null ? "No machine" : providerName(kind)}
        </span>
      </div>
      <div className="flex min-h-40 flex-col items-center justify-center gap-1 p-6">
        <p className="computer-view-state m-0 text-title" data-computer-view-state>
          {machineStateWord(state)}
        </p>
        <p className="text-muted-foreground">{machineStateNote(state)}</p>
      </div>
    </div>
  );
}

/** The operator's terminal: one command at a time and the machine's answer. */
function Terminal({
  state,
  onRun,
}: {
  readonly state: ComputerState;
  readonly onRun: (command: string) => Promise<void>;
}) {
  const [command, setCommand] = useState("");
  const pending = state.terminal.pending;

  return (
    <div className="terminal flex flex-col gap-2">
      <form
        className="terminal-form flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const next = command.trim();

          if (next === "" || pending) {
            return;
          }

          setCommand("");
          void onRun(next);
        }}
      >
        <Field label="Command">
          <Input
            value={command}
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
            onChange={(event) => {
              setCommand(event.target.value);
            }}
          />
        </Field>
        <Button type="submit" disabled={pending || command.trim() === ""}>
          {pending ? "Running…" : "Run"}
        </Button>
      </form>

      {state.terminal.entries.length === 0 ? (
        <p className="text-muted-foreground">No commands run yet.</p>
      ) : (
        <ol className="m-0 flex list-none flex-col gap-2 p-0">
          {state.terminal.entries.map((entry, index) => (
            <li
              key={index}
              className="flex flex-col gap-1 rounded-md border border-border bg-background p-2"
            >
              <pre className="m-0 font-mono text-code">{`$ ${entry.command}`}</pre>
              {entry.stdout === "" ? null : (
                <pre
                  className="m-0 wrap-anywhere whitespace-pre-wrap font-mono text-code"
                  data-terminal-stdout
                >
                  {entry.stdout}
                </pre>
              )}
              {entry.stderr === "" ? null : (
                <pre className="m-0 wrap-anywhere whitespace-pre-wrap font-mono text-code text-destructive">
                  {entry.stderr}
                </pre>
              )}
              {entry.exitCode === 0 ? null : (
                <p className="text-muted-foreground">{`Exit code ${String(entry.exitCode)}`}</p>
              )}
              {entry.truncated ? (
                <p className="text-muted-foreground">Output was cut at the view&apos;s limit.</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** The bot's home: a directory at a time, a file preview, and an Up control. */
function Files({
  state,
  onOpenDirectory,
  onOpenFile,
  onOpenParent,
}: {
  readonly state: ComputerState;
  readonly onOpenDirectory: (entry: ComputerFileEntryView | null) => Promise<void>;
  readonly onOpenFile: (entry: ComputerFileEntryView) => Promise<void>;
  readonly onOpenParent: () => Promise<void>;
}) {
  const { files } = state;
  const home = files.path === null || files.path === "";

  return (
    <div className="flex flex-col gap-2">
      <div className="wrap-anywhere font-mono text-code">
        <Button
          disabled={files.pending || home}
          onClick={() => {
            void onOpenParent();
          }}
        >
          Up
        </Button>
        <span className="text-muted-foreground">{home ? "Home" : `/${files.path ?? ""}`}</span>
      </div>

      {files.refusal === null ? null : (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {files.refusal}
        </p>
      )}

      {files.pending && files.entries.length === 0 ? (
        <p className="text-muted-foreground" aria-busy="true">
          Listing…
        </p>
      ) : files.entries.length === 0 ? (
        <p className="text-muted-foreground">This directory is empty.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {files.entries.map((entry) => (
            <li
              key={entry.name}
              className="flex items-center gap-2 rounded-md border border-border bg-background p-2"
            >
              <Button
                disabled={files.pending}
                onClick={() => {
                  void (entry.kind === "directory" ? onOpenDirectory(entry) : onOpenFile(entry));
                }}
              >
                {entry.kind === "directory" ? `${entry.name}/` : entry.name}
              </Button>
              {entry.kind === "file" && entry.sizeBytes > 0 ? (
                <span className="text-muted-foreground">{formatBytes(entry.sizeBytes)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {files.preview === null ? null : (
        <div className="flex items-center gap-2 rounded-md border border-border bg-background p-2">
          <p className="text-muted-foreground">{`/${files.preview.path}`}</p>
          <pre className="min-w-0 flex-1 wrap-anywhere">{files.preview.content}</pre>
          {files.preview.truncated ? (
            <p className="text-muted-foreground">Only the first part of the file is shown.</p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * The provider sheet: what each configured kind is, whether it can serve a
 * machine and why not when it cannot, and the deployment default as its own
 * choice. Picking one closes the sheet and arms the switch confirmation, so
 * the write still takes two deliberate steps.
 */
function ProviderSheet({
  state,
  open,
  onClose,
  onChoose,
}: {
  readonly state: ComputerState;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onChoose: (choice: ProviderChoice) => void;
}) {
  const providers = state.providers;

  if (providers === null) {
    return null;
  }

  const busy = state.pending !== null;

  return (
    <Sheet
      open={open}
      title="Where this bot's computer runs"
      description="The choice is stored on the bot. Switching moves nothing by itself."
      onClose={onClose}
    >
      {selectionUnconfigured(state) ? (
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {`This bot is set to "${String(state.bot?.computerProvider)}", which this deployment does not configure. Choose a provider below.`}
        </p>
      ) : null}

      <ul className="provider-list m-0 flex list-none flex-col gap-2 p-0">
        <ProviderOption
          name="Deployment default"
          detail={detailOf(providers.defaultKind)}
          provider={defaultProvider(state)}
          checked={followsDefault(state)}
          disabled={busy || defaultUnavailable(state)}
          onChoose={() => {
            onChoose({ kind: null });
          }}
        />

        {providers.providers.map((provider) => (
          <ProviderOption
            key={provider.kind}
            name={providerName(provider.kind)}
            detail={detailOf(provider.kind)}
            provider={provider}
            checked={state.bot?.computerProvider === provider.kind}
            disabled={busy || !provider.available}
            onChoose={() => {
              onChoose({ kind: provider.kind });
            }}
          />
        ))}
      </ul>
    </Sheet>
  );
}

/** What a kind is, as the sheet's second line: its name and its one sentence. */
function detailOf(kind: string): string {
  return [providerName(kind), providerDescription(kind)].filter((part) => part !== "").join(" · ");
}

/** One radio row: the choice, what it is, and its readiness answer. */
function ProviderOption({
  name,
  detail,
  provider,
  checked,
  disabled,
  onChoose,
}: {
  readonly name: string;
  readonly detail: string;
  readonly provider: ComputerProviderView;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onChoose: () => void;
}) {
  return (
    <li className="provider-option flex items-start gap-2 rounded-md border border-border bg-background p-2">
      <label>
        <Input
          type="radio"
          name="computer-provider"
          checked={checked}
          disabled={disabled}
          onChange={onChoose}
        />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="text-heading">{name}</span>
          {detail === "" ? null : <span className="text-meta text-muted-foreground">{detail}</span>}
        </span>
        <span
          className={
            provider.available
              ? "text-meta text-muted-foreground"
              : "text-meta text-muted-foreground text-warning"
          }
        >
          {availabilityOf(provider)}
        </span>
      </label>
    </li>
  );
}

/** The default choice's pseudo-provider: the default kind and its own readiness. */
function defaultProvider(state: ComputerState): ComputerProviderView {
  const kind = state.providers?.defaultKind ?? "";

  return (
    state.providers?.providers.find((provider) => provider.kind === kind) ?? {
      kind,
      available: false,
      failure: null,
    }
  );
}

function defaultUnavailable(state: ComputerState): boolean {
  return !defaultProvider(state).available;
}

/**
 * The switch confirmation: what does not move, the snapshot path, and the
 * write. The warning is the same computation the controller used to arm this
 * panel, so what is confirmed is exactly what was read, and the notice is
 * rendered here while the dialog covers the screen so a refusal is visible.
 */
function SwitchConfirmation({
  state,
  onCancel,
  onConfirm,
  onSnapshot,
}: {
  readonly state: ComputerState;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly onSnapshot: () => Promise<void>;
}) {
  const candidate = state.candidate;

  if (candidate === null) {
    return null;
  }

  const pending = state.pending;
  const target = candidate.kind === null ? "the deployment default" : providerName(candidate.kind);
  const canSnapshot =
    state.computer?.assigned === true && state.computer.state === "running" && pending === null;

  return (
    <Dialog
      open
      title={`Switch to ${target}?`}
      description={switchWarning(state, candidate)}
      onClose={onCancel}
      actions={
        <>
          <Button
            disabled={pending !== null || !canSnapshot}
            onClick={() => {
              void onSnapshot();
            }}
          >
            {pending === "snapshot" ? "Capturing…" : "Take a snapshot"}
          </Button>
          <Button
            variant="primary"
            disabled={pending !== null}
            onClick={() => {
              void onConfirm();
            }}
          >
            {pending === "switch" ? "Switching…" : `Switch to ${target}`}
          </Button>
          <Button disabled={pending !== null} onClick={onCancel}>
            Cancel
          </Button>
        </>
      }
    >
      {state.notice === null ? null : (
        <p
          className={
            state.notice.kind === "error"
              ? "rounded-md border border-destructive bg-card p-2 text-foreground"
              : "text-muted-foreground"
          }
          role={state.notice.kind === "error" ? "alert" : "status"}
        >
          {state.notice.text}
        </p>
      )}
    </Dialog>
  );
}

/**
 * The space's captured archives (slice 7.5): what is recoverable and the one
 * action that replays one. A restore replaces whatever the machine's home is
 * now, so it arms a confirmation first, like every other destructive write.
 */
function Snapshots({
  state,
  pending,
  onRestore,
}: {
  readonly state: ComputerState;
  readonly pending: ComputerState["pending"];
  readonly onRestore: (snapshotId: string) => Promise<void>;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3>Snapshots</h3>
      {state.snapshots.length === 0 ? (
        <p className="text-muted-foreground">No snapshots yet.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {state.snapshots.map((snapshot) => (
            <SnapshotRow
              key={snapshot.id}
              snapshot={snapshot}
              pending={pending}
              onRestore={onRestore}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SnapshotRow({
  snapshot,
  pending,
  onRestore,
}: {
  readonly snapshot: ComputerSnapshotView;
  readonly pending: ComputerState["pending"];
  readonly onRestore: (snapshotId: string) => Promise<void>;
}) {
  const [restoring, setRestoring] = useState(false);

  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2">
      <span>{formatMoment(snapshot.createdAt)}</span>{" "}
      <span className="text-muted-foreground">{formatBytes(snapshot.sizeBytes)}</span>
      {restoring ? (
        <span className="flex flex-wrap items-center gap-2 rounded-md border border-destructive bg-card p-2">
          <span className="text-muted-foreground">
            Restoring replaces this machine&apos;s home.{" "}
          </span>{" "}
          <Button
            disabled={pending !== null}
            onClick={() => {
              // The row leaves its confirming state whether the write landed
              // or was refused; a refusal reaches the operator as the
              // controller's notice above.
              void onRestore(snapshot.id).finally(() => {
                setRestoring(false);
              });
            }}
          >
            Restore
          </Button>{" "}
          <Button
            disabled={pending !== null}
            onClick={() => {
              setRestoring(false);
            }}
          >
            Cancel
          </Button>
        </span>
      ) : (
        <Button
          disabled={pending !== null}
          onClick={() => {
            setRestoring(true);
          }}
        >
          Restore
        </Button>
      )}
    </li>
  );
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) {
    return `${String(bytes)} B`;
  }

  if (bytes < 1_048_576) {
    return `${(bytes / 1_024).toFixed(1)} KB`;
  }

  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}
