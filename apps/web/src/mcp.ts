import type { Bot, McpGrant, McpServerDetail, McpServerSummary } from "@porkbot/contracts";

/**
 * The MCP server settings surface's state machine (slice 11.5; slice 9.5's
 * contract): install a server by URL, read back what discovery found, attach
 * it to bots, and uninstall it.
 *
 * Install is two shapes in one answer. A server that needs no authorization is
 * ready on the create; an OAuth server answers `pending_authorization` beside
 * the consent URL the browser must visit. The controller keeps that URL in
 * state — the screen renders it as a link — and "Check again" re-reads the
 * server, so the operator returns from the provider and sees the status the
 * server actually reports rather than a stored hope.
 *
 * Uninstalling is the destructive write, and the confirmation is a pure
 * function of what the detail and the grant list already hold: how many tools
 * disappear with the server, and how many bots lose access. A grant revoke is
 * the other one: the server survives, one bot loses it at its next call.
 */

/** The MCP install form, as the screen collects it. */
export interface McpInstallInput {
  readonly name: string;
  readonly url: string;
  readonly auth: "none" | "oauth";
  readonly clientId?: string;
  readonly clientSecret?: string;
}

/** The MCP surface's API, narrow enough to fake. */
export interface McpTransport {
  list(): Promise<readonly McpServerSummary[]>;
  /** The active bots, for the grant picker. */
  listBots(): Promise<readonly Bot[]>;
  get(id: string): Promise<McpServerDetail>;
  install(input: McpInstallInput): Promise<{
    readonly server: McpServerDetail;
    readonly authorizationUrl: string | null;
  }>;
  remove(id: string): Promise<void>;
  grants(id: string): Promise<readonly McpGrant[]>;
  grant(id: string, botId: string): Promise<void>;
  revoke(id: string, botId: string): Promise<void>;
}

export interface McpNotice {
  readonly kind: "info" | "error";
  readonly text: string;
}

export interface McpState {
  readonly status: "loading" | "ready" | "refused";
  /** The sentence to show when `status` is `refused`, else `null`. */
  readonly refusal: string | null;
  readonly servers: readonly McpServerSummary[];
  /** The opened server's detail; `null` while the list is showing. */
  readonly selected: McpServerDetail | null;
  /** The selected server's grants, live and revoked. */
  readonly grants: readonly McpGrant[];
  /** The active bots, for the grant picker. */
  readonly bots: readonly Bot[];
  /**
   * The consent an OAuth install is waiting on: the server it belongs to and
   * the URL the operator must visit. It survives closing the detail — the
   * provider's page is where the operator finishes the flow, and the detail
   * carries no URL of its own — and it clears when the list is read again or
   * the server is removed.
   */
  readonly consent: { readonly serverId: string; readonly url: string } | null;
  readonly notice: McpNotice | null;
  /** The id whose read or write is in flight, for disabling its controls. */
  readonly pending: string | null;
}

export interface McpController {
  state(): McpState;
  subscribe(listener: () => void): () => void;
  /** The list read and the explicit retry; clears any notice or consent. */
  load(): void;
  /** Opens one server's detail and grants. */
  open(id: string): Promise<void>;
  /** Returns to the list; a pending consent survives for its server. */
  close(): void;
  /** Installs and, when consent is needed, holds its URL; `true` on success. */
  install(input: McpInstallInput): Promise<boolean>;
  remove(id: string): Promise<void>;
  grant(botId: string): Promise<void>;
  revokeGrant(botId: string): Promise<void>;
  /** Re-reads the list and the open server; the answer to a completed consent. */
  recheck(): Promise<void>;
}

export interface McpControllerOptions {
  readonly transport: McpTransport;
}

const unreadable = "MCP servers could not be loaded.";

/** The grants that are live; a revoked grant is history, not access. */
export function liveGrants(grants: readonly McpGrant[]): readonly McpGrant[] {
  return grants.filter((grant) => grant.revokedAt === null);
}

function toolClause(count: number): string {
  if (count === 0) {
    return "no discovered tools";
  }

  return count === 1 ? "1 tool" : `${String(count)} tools`;
}

function botClause(count: number, singular: string, plural: string): string {
  return count === 1 ? `1 bot ${singular}` : `${String(count)} bots ${plural}`;
}

/** The confirmation sentence for an uninstall, shown before the write. */
export function removeWarning(server: McpServerDetail, grants: readonly McpGrant[]): string {
  const live = liveGrants(grants).length;

  return `Removing ${server.name} deletes ${toolClause(server.tools.length)} and its stored credential; ${botClause(live, "loses access", "lose access")}.`;
}

/** The outcome sentence for an uninstall, shown after the write. */
export function removeOutcome(server: McpServerDetail, grants: readonly McpGrant[]): string {
  const live = liveGrants(grants).length;

  return `Removed ${server.name}. ${toolClause(server.tools.length)} and its stored credential are gone; ${botClause(live, "lost access", "lost access")}.`;
}

/** The confirmation sentence for a grant revoke, shown before the write. */
export function revokeWarning(botName: string): string {
  return `${botName} loses this server's tools on its next call.`;
}

/** The status as words; the core vocabulary's closed set, exhaustively mapped. */
const statusLabels: Readonly<Record<McpServerDetail["status"], string>> = {
  pending_authorization: "Awaiting authorization",
  ready: "Ready",
  error: "Failed",
};

export function serverStatusLabel(status: McpServerDetail["status"]): string {
  return statusLabels[status];
}

export function createMcpController(options: McpControllerOptions): McpController {
  const { transport } = options;
  const listeners = new Set<() => void>();
  let state: McpState = {
    status: "loading",
    refusal: null,
    servers: [],
    selected: null,
    grants: [],
    bots: [],
    consent: null,
    notice: null,
    pending: null,
  };
  // Bumped on every read, so a late answer for a server the operator already
  // closed cannot reopen it under a new frame.
  let generation = 0;

  function publish(next: McpState): void {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  /** The shared list read; keeps the open server only when it is still there. */
  async function readList(showLoading: boolean): Promise<void> {
    const mine = ++generation;
    publish({
      ...state,
      status: showLoading ? "loading" : state.status,
      ...(showLoading ? { refusal: null } : {}),
    });

    try {
      const [servers, bots] = await Promise.all([transport.list(), transport.listBots()]);

      if (mine !== generation) {
        return;
      }

      const selectedId = state.selected?.id;
      const selectedStillThere = servers.find((server) => server.id === selectedId);

      publish({
        ...state,
        status: "ready",
        servers,
        bots,
        refusal: null,
        ...(selectedId !== undefined && selectedStillThere === undefined
          ? { selected: null, grants: [], consent: null }
          : {}),
      });
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "refused", refusal: unreadable });
    }
  }

  async function readDetail(id: string): Promise<void> {
    const mine = ++generation;
    publish({ ...state, pending: id });

    try {
      const [server, grants] = await Promise.all([transport.get(id), transport.grants(id)]);

      if (mine !== generation) {
        return;
      }

      publish({ ...state, status: "ready", selected: server, grants, pending: null });
    } catch {
      if (mine !== generation) {
        return;
      }

      publish({
        ...state,
        pending: null,
        notice: { kind: "error", text: "The server could not be read." },
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
      publish({ ...state, selected: null, grants: [], consent: null, notice: null });
      void readList(true);
    },

    async open(id) {
      publish({ ...state, selected: null, grants: [], notice: null });
      await readDetail(id);
    },

    close() {
      publish({ ...state, selected: null, grants: [], notice: null });
    },

    async install(input) {
      publish({ ...state, pending: "install", notice: null, consent: null });

      let result: Awaited<ReturnType<McpTransport["install"]>>;

      try {
        result = await transport.install(input);
      } catch {
        publish({
          ...state,
          pending: null,
          notice: { kind: "error", text: "The server could not be installed." },
        });

        return false;
      }

      publish({
        ...state,
        pending: null,
        consent:
          result.authorizationUrl === null
            ? null
            : { serverId: result.server.id, url: result.authorizationUrl },
        notice:
          result.authorizationUrl === null
            ? { kind: "info", text: `Installed ${result.server.name}.` }
            : {
                kind: "info",
                text: `Installed ${result.server.name}. Authorize it to finish.`,
              },
      });
      await readList(false);
      await readDetail(result.server.id);

      return true;
    },

    async remove(id) {
      const detail = state.selected?.id === id ? state.selected : null;
      const grants = state.grants;
      const name =
        detail?.name ?? state.servers.find((server) => server.id === id)?.name ?? "The server";

      const removed = await write(id, async () => {
        await transport.remove(id);
        await readList(false);

        return detail === null ? `Removed ${name}.` : removeOutcome(detail, grants);
      });

      if (removed) {
        publish({ ...state, selected: null, grants: [], consent: null });
      }
    },

    async grant(botId) {
      const server = state.selected;

      if (server === null) {
        return;
      }

      const bot = state.bots.find((candidate) => candidate.id === botId);
      const botName = bot?.name ?? "The bot";

      await write(botId, async () => {
        await transport.grant(server.id, botId);
        await readDetail(server.id);

        return `Granted ${server.name} to ${botName}.`;
      });
    },

    async revokeGrant(botId) {
      const server = state.selected;

      if (server === null) {
        return;
      }

      const bot = state.bots.find((candidate) => candidate.id === botId);
      const botName = bot?.name ?? "The bot";

      await write(botId, async () => {
        await transport.revoke(server.id, botId);
        await readDetail(server.id);

        return `${botName} loses ${server.name} on its next call.`;
      });
    },

    async recheck() {
      const selectedId = state.selected?.id;

      await readList(false);

      if (selectedId !== undefined && state.selected?.id === selectedId) {
        await readDetail(selectedId);
      }
    },
  };

  /**
   * The shared tail of the destructive writes: hold the control, run the
   * write, then say what happened. A failed write leaves the lists as the
   * server last answered them, with an error notice instead of a claim, and
   * the answer is whether it landed so the caller can close what it removed.
   */
  async function write(id: string, call: () => Promise<string>): Promise<boolean> {
    publish({ ...state, pending: id, notice: null });

    let sentence: string;

    try {
      sentence = await call();
    } catch {
      publish({
        ...state,
        pending: null,
        notice: { kind: "error", text: "The change could not be saved." },
      });

      return false;
    }

    publish({ ...state, pending: null, notice: { kind: "info", text: sentence } });

    return true;
  }
}
