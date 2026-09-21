import type { Bot, Credential, ModelConnection, ModelProbe } from "@porkbot/contracts";

/**
 * The connections screen's state machine (slice 9.3, PRD decisions 12, 13 and
 * 19; stories 12, 14 and 15): a framework-free controller like the memory
 * screen's, so the screen renders one state object and the read/write rules
 * live where a unit test can drive them without a DOM.
 *
 * The controller owns the operator's four questions. What is connected: the
 * connection list carries the credential's mask and never its value, so the
 * screen cannot show a secret it was not given. What happens when I test it:
 * a probe result is kept per connection exactly as the endpoint answered,
 * including "no streaming" and a classified refusal, and it is never smoothed
 * into a stored hope. What breaks when I revoke: the impact of a credential
 * revoke or a connection disconnect is a pure function of state the controller
 * already holds, computed before the write for the confirmation and after it
 * for the outcome sentence. Which one is the default: the space default is the
 * server's flag, and a bot's override is its own connection id — the two are
 * distinguishable because they are different fields, never a guess.
 *
 * A create is deliberately two procedures in order: `credentials.store` puts
 * the key in the encrypted store, then `modelConnections.create` names it. The
 * connection contract has no field that can carry the value — that is its
 * point — so the client composes the pair and says which half failed.
 */

/** A connection the operator is creating; the blank fields mean "not given". */
export interface NewConnectionInput {
  readonly label: string;
  readonly baseUrl: string;
  readonly credentialName: string;
  /** Blank stores no model default; the endpoint's answer decides instead. */
  readonly defaultModel: string;
  /** Blank reuses the credential already stored under `credentialName`. */
  readonly credentialValue: string;
}

/** The API surface the connections screen needs, narrow enough to fake. */
export interface ConnectionsTransport {
  listConnections(): Promise<readonly ModelConnection[]>;
  listCredentials(): Promise<readonly Credential[]>;
  /** The active bots, for the per-bot override map. */
  listBots(): Promise<readonly Bot[]>;
  createConnection(input: {
    readonly label: string;
    readonly baseUrl: string;
    readonly credentialName: string;
    readonly defaultModel: string | null;
  }): Promise<ModelConnection>;
  storeCredential(input: { readonly name: string; readonly value: string }): Promise<Credential>;
  /** Revokes by name; the effect is on the next provider resolve. */
  revokeCredential(name: string): Promise<void>;
  setDefaultConnection(id: string): Promise<ModelConnection>;
  removeConnection(id: string): Promise<ModelConnection>;
  /** The live probe, resolved to the contract's `probe` half. */
  probeConnection(id: string): Promise<ModelProbe>;
  setBotConnection(input: {
    readonly botId: string;
    readonly connectionId: string | null;
  }): Promise<Bot>;
}

/** One connection's probe lifecycle; `failed` is a transport failure, not a refusal. */
export type ConnectionProbeState =
  | { readonly status: "probing" }
  | { readonly status: "answered"; readonly probe: ModelProbe }
  | { readonly status: "failed" };

export interface ConnectionsNotice {
  readonly kind: "info" | "error";
  readonly text: string;
}

export interface ConnectionsState {
  readonly status: "loading" | "ready" | "refused";
  /** The sentence to show when `status` is `refused`, else `null`. */
  readonly refusal: string | null;
  readonly connections: readonly ModelConnection[];
  readonly credentials: readonly Credential[];
  readonly bots: readonly Bot[];
  /** Probe results by connection id; absent until a probe is asked for. */
  readonly probes: Readonly<Record<string, ConnectionProbeState>>;
  readonly notice: ConnectionsNotice | null;
  /** The id, name or bot whose write is in flight, for disabling its controls. */
  readonly pending: string | null;
}

export interface ConnectionsController {
  state(): ConnectionsState;
  subscribe(listener: () => void): () => void;
  /** The initial read and the explicit retry; clears any notice. */
  load(): void;
  probe(id: string): Promise<void>;
  setDefault(id: string): Promise<void>;
  disconnect(id: string): Promise<void>;
  revoke(name: string): Promise<void>;
  /** Stores the key when one is given, then creates the connection. */
  create(input: NewConnectionInput): Promise<boolean>;
  setBotConnection(botId: string, connectionId: string | null): Promise<void>;
}

export interface ConnectionsControllerOptions {
  readonly transport: ConnectionsTransport;
}

const unreadable = "Connections could not be loaded.";

/**
 * The connections that name a credential. The revoke confirmation and the
 * revocation's outcome sentence both read the answer from here, so "what will
 * break" is the same computation before and after the write.
 */
export function connectionsUsingCredential(
  connections: readonly ModelConnection[],
  credentialName: string,
): readonly ModelConnection[] {
  return connections.filter((connection) => connection.credentialName === credentialName);
}

export interface RevokeImpact {
  readonly connections: readonly ModelConnection[];
  /** Bots that lose their model: override users plus default followers. */
  readonly bots: readonly Bot[];
}

/**
 * What revoking a credential takes down: every connection that names it, and
 * every bot that resolves through one of those — a bot that selected one
 * directly, or one that follows the space default when a broken connection is
 * the default.
 */
export function revokeImpact(
  state: Pick<ConnectionsState, "connections" | "bots">,
  credentialName: string,
): RevokeImpact {
  const connections = connectionsUsingCredential(state.connections, credentialName);
  const broken = new Set(connections.map((connection) => connection.id));
  const breaksDefault = connections.some((connection) => connection.isDefault);
  const bots = state.bots.filter(
    (bot) =>
      (bot.modelConnectionId !== null && broken.has(bot.modelConnectionId)) ||
      (bot.modelConnectionId === null && breaksDefault),
  );

  return { connections, bots };
}

export interface DisconnectImpact {
  readonly wasDefault: boolean;
  /** Bots that fall back: this connection's selectors, plus default followers. */
  readonly bots: readonly Bot[];
}

/** What disconnecting a connection takes down: its selectors and its followers. */
export function disconnectImpact(
  state: Pick<ConnectionsState, "connections" | "bots">,
  connectionId: string,
): DisconnectImpact {
  const connection = state.connections.find((candidate) => candidate.id === connectionId);
  const wasDefault = connection?.isDefault ?? false;
  const bots = state.bots.filter(
    (bot) =>
      bot.modelConnectionId === connectionId || (bot.modelConnectionId === null && wasDefault),
  );

  return { wasDefault, bots };
}

/**
 * A bot count with its verb, so "1 bot falls" and "2 bots fall" are one
 * decision rather than a string a reviewer has to check twice.
 */
function botClause(bots: readonly Bot[], singular: string, plural: string): string {
  return bots.length === 1 ? `1 bot ${singular}` : `${String(bots.length)} bots ${plural}`;
}

/** The same for the connections a revoke names, with their labels. */
function connectionClause(
  connections: readonly ModelConnection[],
  singular: string,
  plural: string,
): string {
  const labels = connections.map((connection) => connection.label).join(", ");

  return connections.length === 1 ? `${labels} ${singular}` : `${labels} ${plural}`;
}

/** The confirmation sentence for a disconnect, shown before the write. */
export function disconnectWarning(impact: DisconnectImpact): string {
  if (impact.bots.length === 0) {
    return "No bot selected it.";
  }

  return impact.wasDefault
    ? `${botClause(impact.bots, "will have no model", "will have no model")} until another default is chosen.`
    : `${botClause(impact.bots, "will fall back", "will fall back")} to the space default.`;
}

/** The outcome sentence for a disconnect, shown after the write. */
export function disconnectOutcome(label: string, impact: DisconnectImpact): string {
  if (impact.bots.length === 0) {
    return `Disconnected ${label}. No bot selected it.`;
  }

  return impact.wasDefault
    ? `Disconnected ${label}. ${botClause(impact.bots, "now has no model", "now have no model")} until another default is chosen.`
    : `Disconnected ${label}. ${botClause(impact.bots, "falls back", "fall back")} to the space default.`;
}

/** The confirmation sentence for a credential revoke, shown before the write. */
export function revokeWarning(impact: RevokeImpact, credentialName: string): string {
  if (impact.connections.length === 0) {
    return `Revoking ${credentialName} breaks nothing; no connection uses it.`;
  }

  if (impact.bots.length === 0) {
    return `Revoking ${credentialName} leaves ${connectionClause(impact.connections, "without a key", "without keys")}.`;
  }

  return `Revoking ${credentialName} leaves ${connectionClause(impact.connections, "without a key", "without keys")} and ${botClause(impact.bots, "has no model", "have no model")}.`;
}

/**
 * The confirmation sentence for a key replaced in place (a rotate), shown
 * before the write: the connection that named the key keeps working, but the
 * value it sends is the new one from the next request on.
 */
export function replaceKeyWarning(credentialName: string): string {
  return `A key named ${credentialName} is already stored. Storing now replaces it; connections that use it send the new key from their next request.`;
}

/** The outcome sentence for a credential revoke, shown after the write. */
export function revokeOutcome(impact: RevokeImpact, credentialName: string): string {
  if (impact.connections.length === 0) {
    return `Revoked ${credentialName}. No connection used it.`;
  }

  if (impact.bots.length === 0) {
    return `Revoked ${credentialName}. ${connectionClause(impact.connections, "has no key", "have no keys")}.`;
  }

  return `Revoked ${credentialName}. ${connectionClause(impact.connections, "has no key", "have no keys")}; ${botClause(impact.bots, "loses its model", "lose their model")} until one is stored.`;
}

export function createConnectionsController(
  options: ConnectionsControllerOptions,
): ConnectionsController {
  const { transport } = options;
  const listeners = new Set<() => void>();
  let state: ConnectionsState = {
    status: "loading",
    refusal: null,
    connections: [],
    credentials: [],
    bots: [],
    probes: {},
    notice: null,
    pending: null,
  };
  // Bumped on every read, so a late answer from a superseded load cannot
  // replace the state a newer one already produced.
  let generation = 0;

  function publish(next: ConnectionsState): void {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  /**
   * The shared read. It is a full re-read rather than a patch because every
   * list can change shape with one write — disconnecting a default changes
   * which bots fall back, revoking a credential changes masks — and a read is
   * cheap next to inventing the same transitions twice.
   */
  async function reload(clearNotice: boolean): Promise<void> {
    const mine = ++generation;
    publish({
      ...state,
      status: "loading",
      refusal: null,
      ...(clearNotice ? { notice: null } : {}),
    });

    try {
      const [connections, credentials, bots] = await Promise.all([
        transport.listConnections(),
        transport.listCredentials(),
        transport.listBots(),
      ]);

      if (mine !== generation) {
        return;
      }

      publish({
        ...state,
        status: "ready",
        connections,
        credentials,
        bots,
        refusal: null,
      });
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "refused", refusal: unreadable });
    }
  }

  /**
   * The shared tail of every write: hold the controls, run the write, then
   * re-read and say what happened. A write that failed leaves the read state
   * as it was — the lists still show the last truth the server gave us — and
   * only the notice changes. The answer is whether the write landed: a
   * refusal and a half-done create are both `false`, so a form that opened for
   * the create stays open until it actually happened.
   */
  async function apply(pending: string, call: () => Promise<ConnectionsNotice>): Promise<boolean> {
    publish({ ...state, pending, notice: null });

    let notice: ConnectionsNotice;

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

    // The notice is set before the read so the read's publishes carry it.
    publish({ ...state, pending: null, notice });
    await reload(false);

    return notice.kind === "info";
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

    async probe(id) {
      publish({ ...state, pending: id, probes: { ...state.probes, [id]: { status: "probing" } } });

      try {
        const probe = await transport.probeConnection(id);

        publish({
          ...state,
          pending: null,
          probes: { ...state.probes, [id]: { status: "answered", probe } },
        });
        await reload(false);
      } catch {
        publish({
          ...state,
          pending: null,
          probes: { ...state.probes, [id]: { status: "failed" } },
        });
      }
    },

    async setDefault(id) {
      const connection = state.connections.find((candidate) => candidate.id === id);
      const label = connection?.label ?? "";

      await apply(id, async () => {
        await transport.setDefaultConnection(id);

        return { kind: "info", text: `${label} is now the space default.` };
      });
    },

    async disconnect(id) {
      const impact = disconnectImpact(state, id);
      const connection = state.connections.find((candidate) => candidate.id === id);
      const label = connection?.label ?? "";

      await apply(id, async () => {
        await transport.removeConnection(id);

        return { kind: "info", text: disconnectOutcome(label, impact) };
      });
    },

    async revoke(name) {
      const impact = revokeImpact(state, name);

      await apply(name, async () => {
        await transport.revokeCredential(name);

        return { kind: "info", text: revokeOutcome(impact, name) };
      });
    },

    async create(input) {
      return apply("create", async () => {
        // The key is stored first and separately because the connection
        // contract cannot carry it. A connection that then fails to create has
        // still stored the key, and the outcome sentence says exactly that
        // rather than pretending nothing was written.
        if (input.credentialValue !== "") {
          await transport.storeCredential({
            name: input.credentialName,
            value: input.credentialValue,
          });
        }

        const defaultModel = input.defaultModel.trim();

        try {
          await transport.createConnection({
            label: input.label,
            baseUrl: input.baseUrl,
            credentialName: input.credentialName,
            defaultModel: defaultModel === "" ? null : defaultModel,
          });
        } catch {
          return {
            kind: "error",
            text: "The key was stored, but the connection was not created.",
          };
        }

        return { kind: "info", text: `Connected ${input.label}.` };
      });
    },

    async setBotConnection(botId, connectionId) {
      const bot = state.bots.find((candidate) => candidate.id === botId);
      const connection = state.connections.find((candidate) => candidate.id === connectionId);
      const botName = bot?.name ?? "The bot";

      await apply(botId, async () => {
        await transport.setBotConnection({ botId, connectionId });

        return connection === undefined
          ? { kind: "info", text: `${botName} now follows the space default.` }
          : { kind: "info", text: `${botName} now uses ${connection.label}.` };
      });
    },
  };
}
