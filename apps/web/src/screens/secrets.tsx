import { Button } from "@porkbot/ui";
import { useState } from "react";
import type { BotSecretAuthView } from "@porkbot/contracts";
import { authLabel, forgetWarning, secretStatusLabel } from "../secrets.ts";
import type { NewSecretInput, SecretsState } from "../secrets.ts";

/**
 * The secrets surface (slice 11.5; slice 9.6's contract): one bot's stored
 * credentials, read by name, destination and status.
 *
 * The screen shows the origin a value is bound to and how it authenticates,
 * never the value — no response carries one, so there is nothing to hide. The
 * bot picker is the list's scope: switching bots reads that bot's rows rather
 * than filtering the previous ones, so a secret can never appear under the
 * wrong name. Forgetting is the destructive write, and its confirmation says
 * what the clear costs: a request that uses the value fails until it is stored
 * again.
 */

export interface SecretsScreenProps {
  readonly state: SecretsState;
  readonly onReload: () => void;
  readonly onSelectBot: (botId: string) => void;
  readonly onStore: (input: NewSecretInput) => Promise<boolean>;
  readonly onForget: (name: string) => Promise<void>;
}

export function SecretsScreen({
  state,
  onReload,
  onSelectBot,
  onStore,
  onForget,
}: SecretsScreenProps) {
  const [storing, setStoring] = useState(false);

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
        <h2>Secrets</h2>
        {state.bots.length === 0 ? null : (
          <Button
            aria-expanded={storing}
            onClick={() => {
              setStoring(!storing);
            }}
          >
            {storing ? "Cancel" : "Store secret"}
          </Button>
        )}
      </header>

      {state.bots.length === 0 ? (
        state.status === "ready" ? (
          <p className="muted">No bots yet. Create one to store a secret for it.</p>
        ) : null
      ) : (
        <>
          <label className="field">
            <span>Bot</span>
            <select
              value={state.selectedBotId ?? ""}
              disabled={state.pending !== null}
              onChange={(event) => {
                onSelectBot(event.target.value);
              }}
            >
              {state.bots.map((bot) => (
                <option key={bot.id} value={bot.id}>
                  {bot.name}
                </option>
              ))}
            </select>
          </label>

          {state.notice === null ? null : (
            <p
              className={state.notice.kind === "error" ? "form-error" : "muted"}
              role={state.notice.kind === "error" ? "alert" : "status"}
            >
              {state.notice.text}
            </p>
          )}

          {storing ? (
            <StoreSecretForm
              pending={state.pending === "store"}
              onSubmit={async (input) => {
                if (await onStore(input)) {
                  setStoring(false);
                }
              }}
            />
          ) : null}

          {state.secrets.length === 0 ? (
            <p className="muted">No secrets stored for this bot.</p>
          ) : (
            <ul className="connection-key-list">
              {state.secrets.map((secret) => (
                <li key={secret.name} className="connection-key">
                  <span className="connection-credential">{secret.name}</span>{" "}
                  <span className="muted">{hostOf(secret.origin)}</span>{" "}
                  <span className="muted">{authLabel(secret.auth)}</span>{" "}
                  <span className="connection-key-use muted">
                    {secretStatusLabel(secret.status)}
                  </span>
                  <ForgetSecret
                    name={secret.name}
                    pending={state.pending === secret.name}
                    onForget={onForget}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

interface ForgetSecretProps {
  readonly name: string;
  readonly pending: boolean;
  readonly onForget: (name: string) => Promise<void>;
}

function ForgetSecret({ name, pending, onForget }: ForgetSecretProps) {
  const [forgetting, setForgetting] = useState(false);

  if (!forgetting) {
    return (
      <Button
        disabled={pending}
        onClick={() => {
          setForgetting(true);
        }}
      >
        Forget
      </Button>
    );
  }

  return (
    <span className="connection-confirm">
      <span className="muted" role="status">
        {forgetWarning(name)}
      </span>{" "}
      <Button
        disabled={pending}
        onClick={() => {
          void onForget(name).then(() => {
            setForgetting(false);
          });
        }}
      >
        Forget value
      </Button>{" "}
      <Button
        disabled={pending}
        onClick={() => {
          setForgetting(false);
        }}
      >
        Cancel
      </Button>
    </span>
  );
}

interface StoreSecretFormProps {
  readonly pending: boolean;
  readonly onSubmit: (input: NewSecretInput) => Promise<void>;
}

function StoreSecretForm({ pending, onSubmit }: StoreSecretFormProps) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [origin, setOrigin] = useState("");
  const [authType, setAuthType] = useState<"bearer" | "header" | "basic">("bearer");
  const [headerName, setHeaderName] = useState("x-api-key");
  const [username, setUsername] = useState("");
  const auth = authFor(authType, headerName, username);

  return (
    <form
      className="memory-form"
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit({ name, value, origin, auth });
      }}
    >
      <label className="field">
        <span>Name</span>
        <input
          required
          maxLength={64}
          placeholder="api_token"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </label>
      <label className="field">
        <span>Value</span>
        <input
          required
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
          }}
        />
      </label>
      <label className="field">
        <span>Origin</span>
        <input
          required
          type="url"
          maxLength={2_048}
          placeholder="https://api.example.invalid"
          value={origin}
          onChange={(event) => {
            setOrigin(event.target.value);
          }}
        />
      </label>
      <label className="field">
        <span>Authentication</span>
        <select
          value={authType}
          onChange={(event) => {
            setAuthType(event.target.value as "bearer" | "header" | "basic");
          }}
        >
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
          <option value="basic">Basic</option>
        </select>
      </label>

      {authType === "header" ? (
        <label className="field">
          <span>Header name</span>
          <input
            required
            maxLength={120}
            value={headerName}
            onChange={(event) => {
              setHeaderName(event.target.value);
            }}
          />
        </label>
      ) : null}

      {authType === "basic" ? (
        <label className="field">
          <span>Username</span>
          <input
            required
            maxLength={200}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
        </label>
      ) : null}

      <p className="muted">Stored encrypted; it is never shown again.</p>
      <Button type="submit" disabled={pending}>
        Store
      </Button>
    </form>
  );
}

function authFor(
  type: "bearer" | "header" | "basic",
  headerName: string,
  username: string,
): BotSecretAuthView {
  switch (type) {
    case "bearer":
      return { type: "bearer" };
    case "header":
      return { type: "header", name: headerName };
    case "basic":
      return { type: "basic", username };
  }
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
