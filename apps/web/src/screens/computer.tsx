import { BotAvatar, Button, Field, Input } from "@porkbot/ui";
import { useState } from "react";
import type {
  ComputerFileEntryView,
  ComputerProviderView,
  ComputerSnapshotView,
} from "@porkbot/contracts";
import {
  availabilityOf,
  canBrowse,
  computerSentence,
  followsDefault,
  lifecyclePendingLabel,
  providerName,
  resetWarning,
  selectedProvider,
  selectionUnconfigured,
  switchWarning,
} from "../computer.ts";
import type { ComputerLifecycleAction, ComputerState, ProviderChoice } from "../computer.ts";

/**
 * One bot's computer (slices 9.4 and 11.4, PRD stories 27, 30 and 31): what
 * the operator sees of a machine and what they can do to it.
 *
 * The read is the contract's own: the machine's state, the deployment's
 * providers with their readiness answers, the snapshots in this space. The
 * lifecycle controls are the supervisor's four verbs — Start, Stop, Reset,
 * Recover — and Reset arms a confirmation because it destroys the machine and
 * its home while keeping the snapshots that can bring files back. The
 * terminal and the file view are v1.0's visibility into what the machine is
 * doing: the terminal runs one command at a time through the same supervisor
 * exec seam the model's shell tool uses, and the file view lists the bot's
 * home and reads one file from it. Both are disabled while the machine is not
 * running, so a stopped computer answers with its state rather than with a
 * supervisor refusal.
 *
 * Screen watch and takeover do not ship in v1.0 (PRD story 28, issue #178),
 * and this screen deliberately has no section for them: the reserved seam is
 * `ComputerProvider.frames()`/`input()` and the supervisor's capability-gated
 * `/frames` and `/input` paths, both documented at their declarations. When
 * the stream lands, its surface is a section here beside the terminal.
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
  if (state.status === "refused") {
    return (
      <section className="console">
        <p className="form-error" role="alert">
          {state.refusal}
        </p>
        <Button onClick={onReload}>Try again</Button>
      </section>
    );
  }

  if (state.bot === null || state.providers === null) {
    return <section className="console" aria-busy="true" />;
  }

  const busy = state.pending !== null;
  const current = selectedProvider(state);
  const browse = canBrowse(state);

  return (
    <section className="console" aria-busy={state.status === "loading"}>
      <header className="memory-header">
        <div className="bot-identity">
          <BotAvatar id={state.bot.id} name={state.bot.name} color={state.bot.color} size={32} />
          <h2>{state.bot.name}</h2>
        </div>
      </header>

      {state.notice === null ? null : (
        <p
          className={state.notice.kind === "error" ? "form-error" : "muted"}
          role={state.notice.kind === "error" ? "alert" : "status"}
        >
          {state.notice.text}
        </p>
      )}

      <Machine state={state} onLifecycle={onLifecycle} />

      {browse ? (
        <>
          <Terminal state={state} onRun={onRun} />
          <Files
            state={state}
            onOpenDirectory={onOpenDirectory}
            onOpenFile={onOpenFile}
            onOpenParent={onOpenParent}
          />
        </>
      ) : (
        <p className="muted">Start the machine to use its terminal and files.</p>
      )}

      <fieldset className="provider-choice">
        <legend>Where this bot&apos;s computer runs</legend>

        {selectionUnconfigured(state) ? (
          <p className="form-error" role="alert">
            {`This bot is set to "${String(state.bot.computerProvider)}", which this deployment does not configure. Choose a provider below.`}
          </p>
        ) : null}

        <ul className="provider-list">
          <ProviderOption
            name="Deployment default"
            detail={providerName(state.providers.defaultKind)}
            provider={defaultProvider(state)}
            checked={followsDefault(state)}
            disabled={busy || defaultUnavailable(state)}
            onChoose={() => {
              onChoose({ kind: null });
            }}
          />

          {state.providers.providers.map((provider) => (
            <ProviderOption
              key={provider.kind}
              name={providerName(provider.kind)}
              detail={provider.kind}
              provider={provider}
              checked={state.bot?.computerProvider === provider.kind}
              disabled={busy || !provider.available}
              onChoose={() => {
                onChoose({ kind: provider.kind });
              }}
            />
          ))}
        </ul>
      </fieldset>

      {current === null || current.available ? null : (
        <p className="muted">
          {`The machine on ${providerName(current.kind)} may not start: ${availabilityOf(current).toLowerCase()}.`}
        </p>
      )}

      {state.candidate === null ? null : (
        <SwitchConfirmation
          state={state}
          pending={state.pending}
          onConfirm={onConfirm}
          onCancel={onCancel}
          onSnapshot={onSnapshot}
        />
      )}

      <Snapshots state={state} pending={state.pending} onRestore={onRestore} />
    </section>
  );
}

/**
 * The machine's state and the supervisor's four lifecycle verbs. Reset is the
 * one destructive verb, so it arms a confirmation that says what is lost —
 * the machine and its home — and what is kept.
 */
function Machine({
  state,
  onLifecycle,
}: {
  readonly state: ComputerState;
  readonly onLifecycle: (action: ComputerLifecycleAction) => Promise<void>;
}) {
  const [armingReset, setArmingReset] = useState(false);
  const busy = state.pending !== null;
  const assigned = state.computer?.assigned === true;
  const running = assigned && state.computer?.state === "running";

  return (
    <section className="machine">
      <h3>Machine</h3>
      <p className="muted">{computerSentence(state)}</p>

      <div className="bot-actions">
        <Button
          disabled={busy || !assigned || running}
          onClick={() => {
            void onLifecycle("boot");
          }}
        >
          {state.pending === "boot" ? lifecyclePendingLabel("boot") : "Start"}
        </Button>
        <Button
          disabled={busy || !running}
          onClick={() => {
            void onLifecycle("stop");
          }}
        >
          {state.pending === "stop" ? lifecyclePendingLabel("stop") : "Stop"}
        </Button>
        <Button
          disabled={busy || !assigned}
          onClick={() => {
            setArmingReset(true);
          }}
        >
          Reset
        </Button>
        <Button
          disabled={busy || !assigned}
          onClick={() => {
            void onLifecycle("recover");
          }}
        >
          {state.pending === "recover" ? lifecyclePendingLabel("recover") : "Recover"}
        </Button>
      </div>

      {armingReset ? (
        <div className="memory-form provider-confirm">
          <p className="muted">{resetWarning(state)}</p>
          <div className="memory-actions">
            <Button
              variant="primary"
              disabled={busy}
              onClick={() => {
                setArmingReset(false);
                void onLifecycle("reset");
              }}
            >
              {state.pending === "reset" ? lifecyclePendingLabel("reset") : "Reset the machine"}
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                setArmingReset(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
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
    <section className="terminal">
      <h3>Terminal</h3>

      <form
        className="terminal-form"
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
        <p className="muted">No commands run yet.</p>
      ) : (
        <ol className="terminal-list">
          {state.terminal.entries.map((entry, index) => (
            <li key={index} className="terminal-entry">
              <pre className="terminal-command">{`$ ${entry.command}`}</pre>
              {entry.stdout === "" ? null : <pre className="terminal-stdout">{entry.stdout}</pre>}
              {entry.stderr === "" ? null : <pre className="terminal-stderr">{entry.stderr}</pre>}
              {entry.exitCode === 0 ? null : (
                <p className="muted">{`Exit code ${String(entry.exitCode)}`}</p>
              )}
              {entry.truncated ? (
                <p className="muted">Output was cut at the view&apos;s limit.</p>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
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
    <section className="files">
      <h3>Files</h3>

      <div className="file-path">
        <Button
          disabled={files.pending || home}
          onClick={() => {
            void onOpenParent();
          }}
        >
          Up
        </Button>
        <span className="muted">{home ? "Home" : `/${files.path ?? ""}`}</span>
      </div>

      {files.refusal === null ? null : (
        <p className="form-error" role="alert">
          {files.refusal}
        </p>
      )}

      {files.pending && files.entries.length === 0 ? (
        <p className="muted" aria-busy="true">
          Listing…
        </p>
      ) : files.entries.length === 0 ? (
        <p className="muted">This directory is empty.</p>
      ) : (
        <ul className="file-list">
          {files.entries.map((entry) => (
            <li key={entry.name} className="file-entry">
              <Button
                disabled={files.pending}
                onClick={() => {
                  void (entry.kind === "directory" ? onOpenDirectory(entry) : onOpenFile(entry));
                }}
              >
                {entry.kind === "directory" ? `${entry.name}/` : entry.name}
              </Button>
              {entry.kind === "file" && entry.sizeBytes > 0 ? (
                <span className="muted">{formatBytes(entry.sizeBytes)}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {files.preview === null ? null : (
        <div className="file-preview">
          <p className="muted">{`/${files.preview.path}`}</p>
          <pre className="file-content">{files.preview.content}</pre>
          {files.preview.truncated ? (
            <p className="muted">Only the first part of the file is shown.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}

/** One radio row: the choice, what it names, and its readiness answer. */
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
    <li className="provider-option">
      <label>
        <Input
          type="radio"
          name="computer-provider"
          checked={checked}
          disabled={disabled}
          onChange={onChoose}
        />
        <span className="provider-name">{name}</span>
        <span className="provider-detail muted">{detail}</span>
      </label>
      <span className={provider.available ? "muted" : "provider-unavailable"}>
        {availabilityOf(provider)}
      </span>
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
 * panel, so what is confirmed is exactly what was read.
 */
function SwitchConfirmation({
  state,
  pending,
  onConfirm,
  onCancel,
  onSnapshot,
}: {
  readonly state: ComputerState;
  readonly pending: ComputerState["pending"];
  readonly onConfirm: () => Promise<void>;
  readonly onCancel: () => void;
  readonly onSnapshot: () => Promise<void>;
}) {
  const candidate = state.candidate;

  if (candidate === null) {
    return null;
  }

  const target = candidate.kind === null ? "the deployment default" : providerName(candidate.kind);
  const canSnapshot =
    state.computer?.assigned === true && state.computer.state === "running" && pending === null;

  return (
    <div className="memory-form provider-confirm">
      <p className="muted">{switchWarning(state, candidate)}</p>
      <div className="memory-actions">
        <Button
          disabled={pending !== null || !canSnapshot}
          onClick={() => {
            void onSnapshot();
          }}
        >
          {pending === "snapshot" ? "Capturing…" : "Take a snapshot"}
        </Button>
        <Button
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
      </div>
    </div>
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
    <section className="connection-keys">
      <h3>Snapshots</h3>
      {state.snapshots.length === 0 ? (
        <p className="muted">No snapshots yet.</p>
      ) : (
        <ul className="connection-key-list">
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
    <li className="connection-key">
      <span>{formatMoment(snapshot.createdAt)}</span>{" "}
      <span className="muted">{formatBytes(snapshot.sizeBytes)}</span>
      {restoring ? (
        <span className="connection-confirm">
          <span className="muted">Restoring replaces this machine&apos;s home. </span>{" "}
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
