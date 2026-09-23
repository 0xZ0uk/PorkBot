import { Button, Field, Input, Select } from "@porkbot/ui";
import { useState } from "react";
import type { McpServerDetail, McpServerSummary } from "@porkbot/contracts";
import { liveGrants, removeWarning, revokeWarning, serverStatusLabel } from "../mcp.ts";
import type { McpInstallInput, McpState } from "../mcp.ts";
import { McpSkeleton } from "./loading.tsx";

/**
 * The MCP servers surface (slice 11.5; slice 9.5's contract): install a server
 * by URL, read back what discovery found, grant it to bots, and uninstall it.
 *
 * The list shows each server's status in the contract's words — a server
 * awaiting authorization is not a server that failed, and both are different
 * from one that is ready. Opening a server shows its tools and its access; an
 * install that needs OAuth leaves a consent link behind and a "Check again"
 * button, so the operator finishes the flow in the provider's page and then
 * sees the status the server actually reports.
 *
 * Uninstalling and revoking a grant are the destructive pair, and both confirm
 * first with the consequence the state already holds: how many tools and bots
 * a removal takes down, and which bot loses the tools at its next call.
 */

export interface McpScreenProps {
  readonly state: McpState;
  readonly onReload: () => void;
  readonly onOpen: (id: string) => void;
  readonly onClose: () => void;
  readonly onInstall: (input: McpInstallInput) => Promise<boolean>;
  readonly onRemove: (id: string) => Promise<void>;
  readonly onGrant: (botId: string) => Promise<void>;
  readonly onRevokeGrant: (botId: string) => Promise<void>;
  readonly onRecheck: () => void;
}

export function McpScreen(props: McpScreenProps) {
  const { state } = props;

  if (state.status === "refused") {
    return (
      <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
        <p
          className="rounded-md border border-destructive bg-card p-2 text-foreground"
          role="alert"
        >
          {state.refusal}
        </p>
        <Button onClick={props.onReload}>Try again</Button>
      </section>
    );
  }

  if (state.status === "loading" && state.selected === null) {
    return <McpSkeleton />;
  }

  return state.selected === null ? (
    <McpList {...props} />
  ) : (
    <McpDetail {...props} selected={state.selected} />
  );
}

function McpList({ state, onReload, onOpen, onInstall }: McpScreenProps) {
  const [installing, setInstalling] = useState(false);

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <header className="flex flex-col gap-1">
        <h2>MCP servers</h2>
        <div className="flex flex-wrap gap-2">
          <Button disabled={state.status === "loading"} onClick={onReload}>
            Refresh
          </Button>
          <Button
            aria-expanded={installing}
            onClick={() => {
              setInstalling(!installing);
            }}
          >
            {installing ? "Cancel" : "Install server"}
          </Button>
        </div>
      </header>

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

      {installing ? (
        <InstallForm
          pending={state.pending === "install"}
          onSubmit={async (input) => {
            if (await onInstall(input)) {
              setInstalling(false);
            }
          }}
        />
      ) : null}

      {state.servers.length === 0 ? (
        state.status === "ready" ? (
          <p className="text-muted-foreground">No servers installed.</p>
        ) : null
      ) : (
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {state.servers.map((server) => (
            <li
              key={server.id}
              className="flex flex-col gap-2 rounded-lg border border-border bg-card p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3>{server.name}</h3>
                <span className="inline-flex items-center gap-0.5 whitespace-nowrap rounded-full border px-2 py-0.5 text-meta">
                  {serverStatusLabel(server.status)}
                </span>
              </div>
              <p className="text-heading text-muted-foreground">{hostOf(server.url)}</p>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
                <dt>Auth</dt>
                <dd>{authLabel(server.auth)}</dd>
                <dt>Tools</dt>
                <dd>{toolCount(server.toolCount)}</dd>
                {server.lastError === null ? null : (
                  <>
                    <dt>Last error</dt>
                    <dd className="text-destructive">{server.lastError}</dd>
                  </>
                )}
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={state.pending === server.id}
                  onClick={() => {
                    onOpen(server.id);
                  }}
                >
                  Open
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface McpDetailProps extends McpScreenProps {
  readonly selected: McpServerDetail;
}

function McpDetail({
  state,
  selected,
  onClose,
  onRemove,
  onGrant,
  onRevokeGrant,
  onRecheck,
}: McpDetailProps) {
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const live = liveGrants(state.grants);
  const grantedTo = new Set(live.map((grant) => grant.botId));
  const available = state.bots.filter((bot) => !grantedTo.has(bot.id));
  const [grantBotId, setGrantBotId] = useState("");

  return (
    <section className="mx-auto flex w-full max-w-2xl flex-col gap-3">
      <p>
        <Button onClick={onClose}>Back to servers</Button>
      </p>
      <h2>{selected.name}</h2>

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

      <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-body">
        <dt>Endpoint</dt>
        <dd>{hostOf(selected.url)}</dd>
        <dt>Auth</dt>
        <dd>{authLabel(selected.auth)}</dd>
        <dt>Status</dt>
        <dd>{serverStatusLabel(selected.status)}</dd>
        {selected.lastError === null ? null : (
          <>
            <dt>Last error</dt>
            <dd className="text-destructive">{selected.lastError}</dd>
          </>
        )}
      </dl>

      {state.consent === null || state.consent.serverId !== selected.id ? null : (
        <p className="text-muted-foreground">
          <a href={state.consent.url} target="_blank" rel="noreferrer">
            Open the consent page
          </a>{" "}
          to authorize this server, then check again.{" "}
          <Button onClick={onRecheck}>Check again</Button>
        </p>
      )}

      <section className="flex flex-wrap gap-1">
        <h3>Tools</h3>
        {selected.tools.length === 0 ? (
          <p className="text-muted-foreground">No tools discovered.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {selected.tools.map((tool) => (
              <li
                key={tool.name}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2"
              >
                <span className="font-mono text-code wrap-anywhere">{tool.name}</span>{" "}
                <span className="text-muted-foreground">{tool.description}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-wrap gap-1">
        <h3>Bots with access</h3>
        {live.length === 0 ? (
          <p className="text-muted-foreground">No bot has access.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {live.map((grant) => (
              <li
                key={grant.botId}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-background p-2"
              >
                <span>{botName(state.bots, grant.botId)}</span>
                <RevokeGrant
                  botLabel={botName(state.bots, grant.botId)}
                  pending={state.pending === grant.botId}
                  onRevoke={() => onRevokeGrant(grant.botId)}
                />
              </li>
            ))}
          </ul>
        )}

        {state.bots.length === 0 ? (
          <p className="text-muted-foreground">No active bots.</p>
        ) : available.length === 0 ? (
          <p className="text-muted-foreground">Every active bot has access.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Field label="Grant to">
              <Select
                value={grantBotId}
                disabled={state.pending !== null}
                onChange={(event) => {
                  setGrantBotId(event.target.value);
                }}
              >
                <option value="">Choose a bot</option>
                {available.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Button
              disabled={grantBotId === "" || state.pending !== null}
              onClick={() => {
                const botId = grantBotId;

                void onGrant(botId).then(() => {
                  setGrantBotId("");
                });
              }}
            >
              Grant
            </Button>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h3>Remove</h3>
        {confirmingRemove ? (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-background p-2">
            <p className="text-muted-foreground" role="status">
              {removeWarning(selected, state.grants)}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={state.pending === selected.id}
                onClick={() => {
                  void onRemove(selected.id).then(() => {
                    setConfirmingRemove(false);
                  });
                }}
              >
                Remove server
              </Button>
              <Button
                disabled={state.pending === selected.id}
                onClick={() => {
                  setConfirmingRemove(false);
                }}
              >
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button
            disabled={state.pending === selected.id}
            onClick={() => {
              setConfirmingRemove(true);
            }}
          >
            Remove
          </Button>
        )}
      </section>
    </section>
  );
}

interface RevokeGrantProps {
  readonly botLabel: string;
  readonly pending: boolean;
  readonly onRevoke: () => Promise<void>;
}

function RevokeGrant({ botLabel, pending, onRevoke }: RevokeGrantProps) {
  const [revoking, setRevoking] = useState(false);

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
    <span className="flex flex-wrap items-center gap-2 rounded-md border border-destructive bg-card p-2">
      <span className="text-muted-foreground" role="status">
        {revokeWarning(botLabel)}
      </span>{" "}
      <Button
        disabled={pending}
        onClick={() => {
          void onRevoke().then(() => {
            setRevoking(false);
          });
        }}
      >
        Revoke access
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

interface InstallFormProps {
  readonly pending: boolean;
  readonly onSubmit: (input: McpInstallInput) => Promise<void>;
}

function InstallForm({ pending, onSubmit }: InstallFormProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [auth, setAuth] = useState<"none" | "oauth">("none");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");

  return (
    <form
      className="flex flex-col gap-2 rounded-md border border-border bg-background p-2"
      onSubmit={(event) => {
        event.preventDefault();
        const secret = clientSecret.trim();

        void onSubmit(
          auth === "none"
            ? { name, url, auth }
            : { name, url, auth, clientId, ...(secret === "" ? {} : { clientSecret: secret }) },
        );
      }}
    >
      <Field label="Name">
        <Input
          required
          maxLength={120}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
        />
      </Field>
      <Field label="Server URL">
        <Input
          required
          type="url"
          maxLength={2_048}
          placeholder="https://mcp.example.invalid/mcp"
          value={url}
          onChange={(event) => {
            setUrl(event.target.value);
          }}
        />
      </Field>
      <Field label="Authentication">
        <Select
          value={auth}
          onChange={(event) => {
            setAuth(event.target.value as "none" | "oauth");
          }}
        >
          <option value="none">None</option>
          <option value="oauth">OAuth</option>
        </Select>
      </Field>

      {auth === "oauth" ? (
        <>
          <Field label="Client ID">
            <Input
              required
              maxLength={200}
              value={clientId}
              onChange={(event) => {
                setClientId(event.target.value);
              }}
            />
          </Field>
          <Field label="Client secret (optional)">
            <Input
              type="password"
              autoComplete="off"
              maxLength={2_000}
              value={clientSecret}
              onChange={(event) => {
                setClientSecret(event.target.value);
              }}
            />
          </Field>
        </>
      ) : null}

      <Button type="submit" disabled={pending}>
        Install
      </Button>
    </form>
  );
}

function botName(
  bots: readonly { readonly id: string; readonly name: string }[],
  botId: string,
): string {
  return bots.find((bot) => bot.id === botId)?.name ?? botId;
}

function authLabel(auth: McpServerSummary["auth"]): string {
  return auth === "oauth" ? "OAuth" : "None";
}

function toolCount(count: number): string {
  return count === 1 ? "1 tool" : `${String(count)} tools`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
