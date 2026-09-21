import { Button, Field, Input, Select } from "@porkbot/ui";
import { useState } from "react";
import type { Bot, Credential, ModelConnection, ModelFailureKind } from "@porkbot/contracts";
import {
  disconnectImpact,
  disconnectWarning,
  replaceKeyWarning,
  revokeImpact,
  revokeWarning,
} from "../connections.ts";
import type { ConnectionProbeState, ConnectionsState, NewConnectionInput } from "../connections.ts";

/**
 * The connections screen (slice 9.3, PRD decisions 12, 13 and 19; stories 12,
 * 14 and 15): what is connected, what it costs to remove, and which model a bot
 * actually runs.
 *
 * The screen shows only what the contract carries. A connection reads as its
 * label, the endpoint's host, the credential *name* and the mask the store
 * derived — never a value, because no response has one. Its status is the last
 * probe's own answer: "streaming unsupported" is printed when the endpoint
 * answered without an event stream, and a classified refusal is named as the
 * kind it is rather than smoothed into a checkmark. Last used is when a request
 * last left, or "Never used" — an honest answer, not a zero.
 *
 * Revoking and disconnecting are the destructive pair, so both arm a
 * confirmation first and both state the consequence from the state the screen
 * already holds: a credential revoke names the connections that lose their key
 * and the bots that lose their model; a disconnect names the bots that fall
 * back, and says when the space default itself is going away. The write that
 * follows is the controller's, and the outcome sentence repeats the impact the
 * confirmation showed.
 *
 * The space default is the server's single flag; a bot's override is its own
 * connection id. They read as different things because they are: the default
 * gets a badge on its card, and every bot in the list below is either following
 * the default or using a named connection.
 */

export interface ConnectionsScreenProps {
  readonly state: ConnectionsState;
  readonly onReload: () => void;
  readonly onProbe: (id: string) => void;
  readonly onSetDefault: (id: string) => Promise<void>;
  readonly onDisconnect: (id: string) => Promise<void>;
  readonly onRevoke: (name: string) => Promise<void>;
  readonly onCreate: (input: NewConnectionInput) => Promise<boolean>;
  readonly onSetBotConnection: (botId: string, connectionId: string | null) => Promise<void>;
}

export function ConnectionsScreen({
  state,
  onReload,
  onProbe,
  onSetDefault,
  onDisconnect,
  onRevoke,
  onCreate,
  onSetBotConnection,
}: ConnectionsScreenProps) {
  const [creating, setCreating] = useState(false);

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

  return (
    <section className="console" aria-busy={state.status === "loading"}>
      <header className="memory-header">
        <h2>Models and connections</h2>
        <Button
          aria-expanded={creating}
          onClick={() => {
            setCreating(!creating);
          }}
        >
          {creating ? "Cancel" : "New connection"}
        </Button>
      </header>

      {state.notice === null ? null : (
        <p
          className={state.notice.kind === "error" ? "form-error" : "muted"}
          role={state.notice.kind === "error" ? "alert" : "status"}
        >
          {state.notice.text}
        </p>
      )}

      {creating ? (
        <CreateConnectionForm
          pending={state.pending === "create"}
          existingNames={state.credentials.map((credential) => credential.name)}
          onSubmit={async (input) => {
            if (await onCreate(input)) {
              setCreating(false);
            }
          }}
        />
      ) : null}

      {state.connections.length === 0 ? (
        state.status === "ready" ? (
          <p className="muted">No connections yet. Add one to give a bot a model.</p>
        ) : null
      ) : (
        <ul className="connection-list">
          {state.connections.map((connection) => {
            const impact = disconnectImpact(state, connection.id);

            return (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                probe={state.probes[connection.id]}
                pending={state.pending === connection.id}
                onProbe={onProbe}
                onSetDefault={onSetDefault}
                onDisconnect={onDisconnect}
                disconnectBots={impact.bots}
                disconnectWasDefault={impact.wasDefault}
              />
            );
          })}
        </ul>
      )}

      <StoredKeys
        credentials={state.credentials}
        state={state}
        pendingName={state.pending}
        onRevoke={onRevoke}
      />

      {state.bots.length > 0 && state.connections.length > 0 ? (
        <section className="connection-bots">
          <h3>Bots</h3>
          <ul className="connection-bot-list">
            {state.bots.map((bot) => (
              <li key={bot.id} className="connection-bot">
                <Field label={bot.name}>
                  <Select
                    disabled={state.pending === bot.id}
                    value={bot.modelConnectionId ?? ""}
                    onChange={(event) => {
                      const connectionId = event.target.value;

                      void onSetBotConnection(bot.id, connectionId === "" ? null : connectionId);
                    }}
                  >
                    <option value="">Space default</option>
                    {state.connections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

interface ConnectionCardProps {
  readonly connection: ModelConnection;
  readonly probe: ConnectionProbeState | undefined;
  readonly pending: boolean;
  readonly onProbe: (id: string) => void;
  readonly onSetDefault: (id: string) => Promise<void>;
  readonly onDisconnect: (id: string) => Promise<void>;
  readonly disconnectBots: readonly Bot[];
  readonly disconnectWasDefault: boolean;
}

function ConnectionCard({
  connection,
  probe,
  pending,
  onProbe,
  onSetDefault,
  onDisconnect,
  disconnectBots,
  disconnectWasDefault,
}: ConnectionCardProps) {
  const [disconnecting, setDisconnecting] = useState(false);

  return (
    <li className="connection">
      <div className="connection-header">
        <h3>{connection.label}</h3>
        {connection.isDefault ? <span className="connection-badge">Space default</span> : null}
      </div>

      <p className="connection-provider muted">{hostOf(connection.baseUrl)}</p>

      <dl className="connection-details">
        <dt>Key</dt>
        <dd>
          <span className="connection-credential">{connection.credentialName}</span>{" "}
          {connection.credentialMaskedValue === null ? (
            <span className="connection-missing-key">no key stored</span>
          ) : (
            <span className="muted">{connection.credentialMaskedValue}</span>
          )}
        </dd>
        <dt>Model</dt>
        <dd>{connection.defaultModel ?? <span className="muted">Endpoint default</span>}</dd>
        <dt>Last used</dt>
        <dd>
          {connection.lastUsedAt === null ? "Never used" : formatMoment(connection.lastUsedAt)}
        </dd>
        <dt>Status</dt>
        <dd>
          <ProbeLine probe={probe} />
        </dd>
      </dl>

      <div className="memory-actions">
        <Button
          disabled={pending}
          onClick={() => {
            onProbe(connection.id);
          }}
        >
          Test
        </Button>
        {connection.isDefault ? null : (
          <Button
            disabled={pending}
            onClick={() => {
              void onSetDefault(connection.id);
            }}
          >
            Make default
          </Button>
        )}
        <Button
          disabled={pending}
          onClick={() => {
            setDisconnecting(!disconnecting);
          }}
        >
          {disconnecting ? "Cancel" : "Disconnect"}
        </Button>
      </div>

      {disconnecting ? (
        <div className="memory-form">
          <p className="muted">
            {disconnectWasDefault ? `This is the space default. ` : ""}
            {disconnectWarning({ wasDefault: disconnectWasDefault, bots: disconnectBots })}
          </p>
          <div className="memory-actions">
            <Button
              disabled={pending}
              onClick={() => {
                void onDisconnect(connection.id).then(() => {
                  setDisconnecting(false);
                });
              }}
            >
              Disconnect
            </Button>
            <Button
              disabled={pending}
              onClick={() => {
                setDisconnecting(false);
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

interface StoredKeysProps {
  readonly credentials: readonly Credential[];
  readonly state: ConnectionsState;
  readonly pendingName: string | null;
  readonly onRevoke: (name: string) => Promise<void>;
}

function StoredKeys({ credentials, state, pendingName, onRevoke }: StoredKeysProps) {
  return (
    <section className="connection-keys">
      <h3>Stored keys</h3>
      {credentials.length === 0 ? (
        <p className="muted">No stored keys.</p>
      ) : (
        <ul className="connection-key-list">
          {credentials.map((credential) => (
            <li key={credential.id} className="connection-key">
              <span className="connection-credential">{credential.name}</span>{" "}
              <span className="muted">{credential.maskedValue}</span>
              <span className="connection-key-use muted"> {keyUse(state, credential.name)}</span>
              <RevokeKey
                name={credential.name}
                state={state}
                pending={pendingName === credential.name}
                onRevoke={onRevoke}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface RevokeKeyProps {
  readonly name: string;
  readonly state: ConnectionsState;
  readonly pending: boolean;
  readonly onRevoke: (name: string) => Promise<void>;
}

function RevokeKey({ name, state, pending, onRevoke }: RevokeKeyProps) {
  const [revoking, setRevoking] = useState(false);
  const impact = revokeImpact(state, name);

  if (!revoking) {
    return (
      <Button
        disabled={pending}
        onClick={() => {
          setRevoking(true);
        }}
      >
        Revoke
      </Button>
    );
  }

  return (
    <span className="connection-confirm">
      <span className="muted">{revokeWarning(impact, name)}</span>{" "}
      <Button
        disabled={pending}
        onClick={() => {
          void onRevoke(name).then(() => {
            setRevoking(false);
          });
        }}
      >
        Revoke key
      </Button>{" "}
      <Button
        disabled={pending}
        onClick={() => {
          setRevoking(false);
        }}
      >
        Cancel
      </Button>
    </span>
  );
}

function CreateConnectionForm({
  pending,
  existingNames,
  onSubmit,
}: {
  readonly pending: boolean;
  readonly existingNames: readonly string[];
  readonly onSubmit: (input: NewConnectionInput) => Promise<void>;
}) {
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [credentialName, setCredentialName] = useState("model-key");
  const [credentialValue, setCredentialValue] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const trimmedName = credentialName.trim();
  const reuse = existingNames.includes(trimmedName);
  // A value under a stored name is a rotate: it confirms before the write, and
  // emptying the field, renaming or editing the value disarms it — a rotate
  // always follows a click on the confirmation the operator can see.
  const replacing = confirmingReplace && reuse && credentialValue.trim() !== "";

  return (
    <form
      className="memory-form"
      onSubmit={(event) => {
        event.preventDefault();

        if (reuse && credentialValue.trim() !== "" && !replacing) {
          setConfirmingReplace(true);

          return;
        }

        void onSubmit({
          label,
          baseUrl,
          credentialName: trimmedName,
          credentialValue,
          defaultModel,
        });
      }}
    >
      <Field label="Label">
        <Input
          required
          maxLength={200}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
          }}
        />
      </Field>
      <Field label="Base URL">
        <Input
          required
          type="url"
          maxLength={2_048}
          placeholder="https://models.example.invalid/v1"
          value={baseUrl}
          onChange={(event) => {
            setBaseUrl(event.target.value);
          }}
        />
      </Field>
      <Field label="Credential name">
        <Input
          required
          maxLength={200}
          value={credentialName}
          onChange={(event) => {
            setCredentialName(event.target.value);
            setConfirmingReplace(false);
          }}
        />
      </Field>
      <Field label="API key">
        <Input
          type="password"
          autoComplete="off"
          required={!reuse}
          maxLength={16_384}
          value={credentialValue}
          onChange={(event) => {
            setCredentialValue(event.target.value);
            setConfirmingReplace(false);
          }}
        />
      </Field>
      <p className="muted">
        {reuse
          ? `A key named ${trimmedName} is already stored; leave this blank to reuse it.`
          : "Stored encrypted; it is never shown again."}
      </p>

      {replacing ? (
        <p className="muted" role="status">
          {replaceKeyWarning(trimmedName)}
        </p>
      ) : null}

      <Field label="Default model (optional)">
        <Input
          maxLength={200}
          value={defaultModel}
          onChange={(event) => {
            setDefaultModel(event.target.value);
          }}
        />
      </Field>
      <div className="memory-actions">
        <Button type="submit" disabled={pending}>
          {replacing ? "Replace key" : "Connect"}
        </Button>
        {replacing ? (
          <Button
            disabled={pending}
            onClick={() => {
              setConfirmingReplace(false);
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** What a connection's last probe answered, in the probe's own words. */
function ProbeLine({ probe }: { readonly probe: ConnectionProbeState | undefined }) {
  if (probe === undefined) {
    return <span className="muted">Not tested yet</span>;
  }

  if (probe.status === "probing") {
    return <span className="muted">Testing…</span>;
  }

  if (probe.status === "failed") {
    return <span className="connection-probe-failed">The endpoint could not be tested.</span>;
  }

  const { probe: answer } = probe;

  if (answer.failure !== null) {
    return <span className="connection-probe-failed">{failureLabels[answer.failure]}</span>;
  }

  if (!answer.reachable) {
    return <span className="connection-probe-failed">Not reachable</span>;
  }

  return (
    <span>
      {`Reachable · ${modelCount(answer.models.length)} · ${
        answer.streaming ? "streaming" : "streaming unsupported"
      }`}
    </span>
  );
}

const failureLabels: Record<ModelFailureKind, string> = {
  gone: "Endpoint unreachable",
  not_found: "Model not found",
  rate_limited: "Rate limited",
  timed_out: "Timed out",
  auth_failed: "Key refused",
};

function modelCount(count: number): string {
  if (count === 0) {
    return "no models";
  }

  return count === 1 ? "1 model" : `${String(count)} models`;
}

function keyUse(state: ConnectionsState, name: string): string {
  const connections = state.connections.filter((connection) => connection.credentialName === name);

  if (connections.length === 0) {
    return "Not used by any connection.";
  }

  return `Used by ${connections.map((connection) => connection.label).join(", ")}.`;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

function formatMoment(iso: string): string {
  return new Date(iso).toLocaleString();
}
