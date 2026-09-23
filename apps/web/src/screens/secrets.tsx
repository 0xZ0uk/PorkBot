import { Button, Field, Input, Select } from "@porkbot/ui";
import { useState } from "react";
import type { BotSecretAuthView } from "@porkbot/contracts";
import { authLabel, forgetWarning, rotateWarning, secretStatusLabel } from "../secrets.ts";
import type { NewSecretInput, SecretsState } from "../secrets.ts";
import { SecretsSkeleton } from "./loading.tsx";

/**
 * The secrets surface (slice 11.5; slice 9.6's contract): one bot's stored
 * credentials, read by name, destination and status.
 *
 * The screen shows the origin a value is bound to and how it authenticates,
 * never the value — no response carries one, so there is nothing to hide. The
 * bot picker is the list's scope: switching bots reads that bot's rows rather
 * than filtering the previous ones, so a secret can never appear under the
 * wrong name. Forgetting and rotating are the destructive writes: forgetting
 * confirms that the value is cleared and a request using it fails until it is
 * stored again, and storing over an existing name — a rotate — confirms that
 * the old value is replaced, with the same consequence.
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

  if (state.status === "loading") {
    return <SecretsSkeleton />;
  }

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <header className="flex flex-col gap-1">
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
          <p className="text-muted-foreground">No bots yet. Create one to store a secret for it.</p>
        ) : null
      ) : (
        <>
          <Field label="Bot">
            <Select
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
            </Select>
          </Field>

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

          {storing ? (
            <StoreSecretForm
              pending={state.pending === "store"}
              existingNames={state.secrets.map((secret) => secret.name)}
              onSubmit={async (input) => {
                if (await onStore(input)) {
                  setStoring(false);
                }
              }}
            />
          ) : null}

          {state.secrets.length === 0 ? (
            <p className="text-muted-foreground">No secrets stored for this bot.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {state.secrets.map((secret) => (
                <li
                  key={secret.name}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2"
                >
                  <span className="font-mono text-code wrap-anywhere">{secret.name}</span>{" "}
                  <span className="text-muted-foreground">{hostOf(secret.origin)}</span>{" "}
                  <span className="text-muted-foreground">{authLabel(secret.auth)}</span>{" "}
                  <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
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
    <span className="flex flex-wrap items-center gap-2 rounded-md border border-destructive bg-card p-2">
      <span className="text-muted-foreground" role="status">
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
  /** The stored names, so a store over one of them confirms the rotate. */
  readonly existingNames: readonly string[];
  readonly onSubmit: (input: NewSecretInput) => Promise<void>;
}

function StoreSecretForm({ pending, existingNames, onSubmit }: StoreSecretFormProps) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [origin, setOrigin] = useState("");
  const [authType, setAuthType] = useState<"bearer" | "header" | "basic">("bearer");
  const [headerName, setHeaderName] = useState("x-api-key");
  const [username, setUsername] = useState("");
  const [confirming, setConfirming] = useState(false);
  const auth = authFor(authType, headerName, username);
  // Recomputed on every render: a name edited away from an existing one
  // disarms the confirmation rather than leaving a warning about a row that
  // will not be touched. Any edit disarms it, so a rotate always follows a
  // click on the confirmation the operator can see.
  const trimmedName = name.trim();
  const rotating = confirming && existingNames.includes(trimmedName);

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border bg-background p-2"
      onSubmit={(event) => {
        event.preventDefault();

        if (existingNames.includes(trimmedName) && !rotating) {
          setConfirming(true);

          return;
        }

        void onSubmit({ name: trimmedName, value, origin, auth });
      }}
    >
      <Field label="Name">
        <Input
          required
          maxLength={64}
          placeholder="api_token"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setConfirming(false);
          }}
        />
      </Field>
      <Field label="Value">
        <Input
          required
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            setConfirming(false);
          }}
        />
      </Field>
      <Field label="Origin">
        <Input
          required
          type="url"
          maxLength={2_048}
          placeholder="https://api.example.invalid"
          value={origin}
          onChange={(event) => {
            setOrigin(event.target.value);
          }}
        />
      </Field>
      <Field label="Authentication">
        <Select
          value={authType}
          onChange={(event) => {
            setAuthType(event.target.value as "bearer" | "header" | "basic");
          }}
        >
          <option value="bearer">Bearer token</option>
          <option value="header">Custom header</option>
          <option value="basic">Basic</option>
        </Select>
      </Field>

      {authType === "header" ? (
        <Field label="Header name">
          <Input
            required
            maxLength={120}
            value={headerName}
            onChange={(event) => {
              setHeaderName(event.target.value);
            }}
          />
        </Field>
      ) : null}

      {authType === "basic" ? (
        <Field label="Username">
          <Input
            required
            maxLength={200}
            value={username}
            onChange={(event) => {
              setUsername(event.target.value);
            }}
          />
        </Field>
      ) : null}

      <p className="text-muted-foreground">Stored encrypted; it is never shown again.</p>

      {rotating ? (
        <p className="text-muted-foreground" role="status">
          {rotateWarning(trimmedName)}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending}>
          {rotating ? "Replace value" : "Store"}
        </Button>
        {rotating ? (
          <Button
            disabled={pending}
            onClick={() => {
              setConfirming(false);
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
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
