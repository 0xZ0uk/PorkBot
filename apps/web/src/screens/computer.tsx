import { Button } from "@porkbot/ui";
import { useState } from "react";
import type { ComputerProviderView, ComputerSnapshotView } from "@porkbot/contracts";
import {
  availabilityOf,
  computerSentence,
  followsDefault,
  providerName,
  selectedProvider,
  selectionUnconfigured,
  switchWarning,
} from "../computer.ts";
import type { ComputerState, ProviderChoice } from "../computer.ts";

/**
 * One bot's computer settings (slice 9.4, PRD story 31): where the bot's
 * machine runs, what the deployment can actually serve, and how to move files
 * when the answer changes.
 *
 * The screen reads only what the contract carries. The deployment's providers
 * arrive with their readiness answers, so an unavailable kind is a disabled
 * radio with the classified reason beside it — a refused key, a rate limit, a
 * daemon that did not answer — rather than a selection that fails at the
 * bot's first run. The bot's stored selection is one of two distinguishable
 * states: a named kind, or "follow the deployment default", and a kind the
 * deployment no longer configures reads as a warning rather than as a checked
 * radio.
 *
 * Switching is destructive to nothing and honest about it: the confirmation
 * says that the home and snapshots do not travel, and offers the snapshot path
 * before the write. The snapshots section makes the other end of that path a
 * button: a captured archive can be restored into whichever machine the bot
 * runs on next, because an archive lives in the space's storage rather than on
 * a provider.
 */

export interface ComputerScreenProps {
  readonly state: ComputerState;
  readonly onReload: () => void;
  readonly onChoose: (choice: ProviderChoice) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => Promise<void>;
  readonly onSnapshot: () => Promise<void>;
  readonly onRestore: (snapshotId: string) => Promise<void>;
}

export function ComputerScreen({
  state,
  onReload,
  onChoose,
  onCancel,
  onConfirm,
  onSnapshot,
  onRestore,
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

  return (
    <section className="console" aria-busy={state.status === "loading"}>
      <header className="memory-header">
        <h2>{state.bot.name}</h2>
      </header>

      {state.notice === null ? null : (
        <p
          className={state.notice.kind === "error" ? "form-error" : "muted"}
          role={state.notice.kind === "error" ? "alert" : "status"}
        >
          {state.notice.text}
        </p>
      )}

      <p className="muted">{computerSentence(state)}</p>

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
        <input
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
              void onRestore(snapshot.id).then(() => {
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
