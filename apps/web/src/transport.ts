import { ORPCError, createApiClient, defaultThreadPageSize, maxPageSize } from "@porkbot/contracts";
import type { Approval, Bot, Message, Thread, UsageBot } from "@porkbot/contracts";
import type { BotsTransport } from "./bots.ts";
import { AuthRefusal } from "./session.ts";
import type { ComputerTransport } from "./computer.ts";
import type { ConnectionsTransport } from "./connections.ts";
import type { ThreadConsoleTransport } from "./console.ts";
import type { MemoryTransport } from "./memory.ts";
import type {
  AuthTransport,
  Credentials,
  Registration,
  SessionActor,
  SignupAvailability,
} from "./session.ts";

/**
 * The auth transport: the API's RPC endpoint for questions the contract
 * answers, and Better Auth's REST routes for the credential exchange.
 *
 * The two halves are deliberate. `account.me` and `deployment.status` are
 * contract procedures, so the shell consumes them through the derived client
 * and never sees a wire shape it invented. Sign-in, sign-up and sign-out are
 * the auth library's own routes: the API composes its handler through
 * `createOperatorAuth` and mounts it under `/api/auth`, and this module is the
 * client half of that mount — no second session protocol, and the cookie stays
 * `HttpOnly` and untouched by this code.
 *
 * The default paths are same-origin, which is the deployment's shape: one TLS
 * origin serves the SPA and the API (PRD decision 32). The desktop wrapper
 * passes the deployment's absolute origin instead.
 */

/** Better Auth's default mount, and the path the API's handler answers on. */
export const authBasePath = "/api/auth";

/** The RPC endpoint the contract server is mounted on. */
export const rpcPath = "/rpc";

export interface HttpAuthTransportOptions {
  /** Absolute origin of a remote deployment; same-origin when omitted. */
  readonly origin?: string;
  readonly rpcPath?: string;
  readonly authBasePath?: string;
  /** Injected in tests; defaults to the browser's `fetch`. */
  readonly fetch?: typeof fetch;
}

function jsonHeaders(): HeadersInit {
  return { "content-type": "application/json" };
}

/** Reads the auth library's error sentence, falling back to a plain refusal. */
async function refusalMessage(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();

    if (typeof body === "object" && body !== null && "message" in body) {
      const message = (body as { message?: unknown }).message;

      if (typeof message === "string" && message.length > 0) {
        return message;
      }
    }
  } catch {
    // A refusal without a JSON body is still a refusal.
  }

  return "The request was refused.";
}

/**
 * The RPC endpoint as an absolute URL. The contract's client parses its `url`
 * with `new URL`, so a relative `/rpc` throws before a request is made; the
 * page's own origin is what "same-origin" means at run time, and a desktop
 * wrapper passes the deployment's origin instead. The REST path below stays
 * relative because `fetch` accepts one.
 */
function resolveRpcUrl(options: HttpAuthTransportOptions): string {
  const path = options.rpcPath ?? rpcPath;
  const base = options.origin ?? globalThis.location?.origin;

  // The prerender that writes `_shell.html` runs this composition in Node,
  // where there is no `location`: it gets the relative path, which the
  // prerendered bootstrapping page never dials. A browser and the desktop
  // wrapper always take the absolute branch, so the client — which parses its
  // endpoint with `new URL` — never sees a relative one at run time.
  return base === undefined ? path : new URL(path, base).href;
}

export function createHttpAuthTransport(options: HttpAuthTransportOptions = {}): AuthTransport {
  const client = createApiClient({ url: resolveRpcUrl(options) });
  const base = `${options.origin ?? ""}${options.authBasePath ?? authBasePath}`;
  const perform = options.fetch ?? globalThis.fetch;

  async function post(path: string, body: Readonly<Record<string, string>>): Promise<void> {
    let response: Response;

    try {
      response = await perform(`${base}${path}`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
        credentials: "same-origin",
      });
    } catch {
      throw new AuthRefusal("unreachable", "The server could not be reached.");
    }

    if (!response.ok) {
      throw new AuthRefusal("refused", await refusalMessage(response));
    }
  }

  return {
    currentActor: async (): Promise<SessionActor | null> => {
      try {
        const actor = await client.account.me({});

        return { userId: actor.userId, spaceId: actor.spaceId, role: actor.role };
      } catch (error) {
        // The gate's typed 401 is the anonymous case, not a failure: the client
        // is signed out. Anything else (a 500, a dropped connection) stays a
        // failure so the shell says "unavailable" instead of "signed out".
        if (error instanceof ORPCError && error.code === "UNAUTHORIZED") {
          return null;
        }

        throw error;
      }
    },
    signIn: (credentials: Credentials) =>
      post("/sign-in/email", { email: credentials.email, password: credentials.password }),
    signUp: (registration: Registration) =>
      post("/sign-up/email", {
        name: registration.name,
        email: registration.email,
        password: registration.password,
      }),
    signOut: () => post("/sign-out", {}),
    signupAvailability: async (): Promise<SignupAvailability> => {
      try {
        const status = await client.deployment.status({});

        return status.signups;
      } catch {
        // The sign-in form still works when this pre-auth question cannot be
        // answered; it just cannot honestly offer registration.
        return "unknown";
      }
    },
  };
}

/**
 * The console's API surface: the bots and threads a signed-in operator can
 * open, and one thread's transcript and event stream. It is the same derived
 * client the auth transport uses — the contract types every call — narrowed to
 * the five methods the screens need, so a test can hand the router a fake and
 * the screens never see a wire shape they invented.
 */
export interface ConsoleTransport extends ThreadConsoleTransport {
  /** The actor's active bots, in the contract's order. */
  listBots(): Promise<readonly Bot[]>;
  /** One bot's most recently active threads, newest first. */
  listThreads(botId: string): Promise<readonly Thread[]>;
  createThread(botId: string): Promise<Thread>;
  /**
   * The full value behind a truncated tool event (slice 6.8): the artifact
   * pointer's `(threadId, runId, callId)` is the whole address, and the
   * contract's typed `NOT_FOUND` covers a foreign or unsettled call.
   */
  toolResult(input: {
    readonly threadId: string;
    readonly runId: string;
    readonly callId: string;
  }): Promise<{ readonly tool: string; readonly result: unknown }>;
}

/** The pending/history approval surface shared by the thread and history screens. */
export interface ApprovalTransport {
  list(filters?: {
    readonly botId?: string;
    readonly runId?: string;
    readonly status?: "pending" | "approved" | "denied" | "timed_out";
  }): Promise<readonly Approval[]>;
  decide(input: {
    readonly runId: string;
    readonly callId: string;
    readonly vote: "approve" | "deny";
    readonly reason?: string;
  }): Promise<{ readonly approval: Approval; readonly applied: boolean }>;
}

/**
 * How many transcript pages one console start walks. The contract pages
 * forward from the oldest row, and the console wants the turn that started the
 * live run — the newest one — so it walks to the end; the cap keeps a thread
 * with thousands of messages from turning one page load into an unbounded
 * batch of requests. The stream itself is not paged, so the live run is
 * complete either way.
 */
const maxTranscriptPages = 10;

export function createHttpConsoleTransport(
  options: HttpAuthTransportOptions = {},
): ConsoleTransport {
  const client = createApiClient({ url: resolveRpcUrl(options) });

  return {
    listBots: async () => (await client.bots.list({ scope: "active" })).bots,
    listThreads: async (botId) =>
      (await client.threads.list({ botId, limit: defaultThreadPageSize })).threads,
    createThread: (botId) => client.threads.create({ botId }),
    toolResult: (input) => client.threads.toolResult(input),
    run: (runId) => client.runs.get({ runId }),

    transcript: async (threadId) => {
      const messages: Message[] = [];
      let afterSeq: number | undefined;

      for (let page = 0; page < maxTranscriptPages; page += 1) {
        const result = await client.threads.messages({
          threadId,
          limit: maxPageSize,
          ...(afterSeq === undefined ? {} : { afterSeq }),
        });

        messages.push(...result.messages);

        if (result.nextSeq === null) {
          break;
        }

        afterSeq = result.nextSeq;
      }

      return messages;
    },

    events: client.threads.events,
  };
}

export function createHttpApprovalTransport(
  options: HttpAuthTransportOptions = {},
): ApprovalTransport {
  const client = createApiClient({ url: resolveRpcUrl(options) });

  return {
    list: (filters = {}) => client.approvals.list(filters).then((result) => result.approvals),
    decide: (input) => client.approvals.decide(input),
  };
}

/** The bot-management surface, kept separate from the conversation console. */
export function createHttpBotsTransport(options: HttpAuthTransportOptions = {}): BotsTransport {
  const client = createApiClient({ url: resolveRpcUrl(options) });

  return {
    listBots: async (scope) => (await client.bots.list({ scope })).bots,
    getBot: (id) => client.bots.get({ id }),
    listSections: async () => (await client.sections.list()).sections,
    listThreads: async (botId) =>
      (await client.threads.list({ botId, limit: defaultThreadPageSize })).threads,
    computerStatus: (botId) => client.computers.status({ botId }),
    createBot: (input) => client.bots.create(input),
    updateBot: (id, input) => client.bots.update({ id, ...input }),
    archiveBot: (id) => client.bots.archive({ id }),
    restoreBot: (id) => client.bots.restore({ id }),
    createSection: (name) => client.sections.create({ name }),
    readAvatar: (id) => client.bots.avatar({ id }),
    setAvatar: (input) => client.bots.setAvatar(input),
    clearAvatar: (id) => client.bots.clearAvatar({ id }),
    bootComputer: (botId) => client.computers.boot({ botId }),
    stopComputer: (botId) => client.computers.stop({ botId }),
    recoverComputer: (botId) => client.computers.recover({ botId }),
  };
}

/**
 * The memory screen's API surface: one bot's documents and their history, and
 * the operator's writes. It is the same derived client narrowed to the
 * procedures the memory controller calls, so the screen never sees a wire
 * shape it invented.
 */
export function createHttpMemoryTransport(options: HttpAuthTransportOptions = {}): MemoryTransport {
  const client = createApiClient({ url: resolveRpcUrl(options) });

  return {
    list: async (botId, scope) => (await client.memory.list({ botId, scope })).documents,
    revisions: async (botId, documentId) =>
      (await client.memory.revisions({ botId, documentId })).revisions,
    update: (input) => client.memory.update(input),
    remove: (input) => client.memory.remove(input),
    restore: (input) => client.memory.restore(input),
  };
}

/**
 * The usage screen's API surface: one bot's all-time totals and its daily
 * buckets, in the contract's shape so the screen invents no wire type. The
 * procedure's window default is the server's; the client does not pick it.
 */
export interface UsageTransport {
  forBot(botId: string): Promise<UsageBot>;
}

export function createHttpUsageTransport(options: HttpAuthTransportOptions = {}): UsageTransport {
  const client = createApiClient({ url: resolveRpcUrl(options) });

  return {
    forBot: (botId) => client.usage.bot({ botId }),
  };
}

/**
 * The computer settings screen's API surface (slice 9.4): the bot's stored
 * selection, the deployment's provider list and readiness answers, the
 * machine's state, and the snapshot pair that moves files across a switch. It
 * is the same derived client narrowed to the procedures the controller calls,
 * so the screen never sees a wire shape it invented.
 */
export function createHttpComputerTransport(
  options: HttpAuthTransportOptions = {},
): ComputerTransport {
  const client = createApiClient({ url: resolveRpcUrl(options) });

  return {
    load: async (botId) => {
      const [bot, providers, computer, snapshots] = await Promise.all([
        client.bots.get({ id: botId }),
        client.computers.providers({}),
        client.computers.status({ botId }),
        client.computers.snapshots({ botId }),
      ]);

      return { bot, providers, computer, snapshots: snapshots.snapshots };
    },
    setProvider: (input) => client.bots.update({ id: input.botId, computerProvider: input.kind }),
    snapshot: (input) => client.computers.snapshot({ botId: input.botId }),
    restore: (input) => client.computers.restore(input),
  };
}

/**
 * The connections screen's API surface (slice 9.3): the connection and
 * credential list reads, the writes the screen offers, and the probe. It is the
 * same derived client narrowed to the procedures the connections controller
 * calls, so the screen never sees a wire shape it invented — and a create is
 * the two calls the contract splits it into: the key goes to
 * `credentials.store`, the connection names it.
 */
export function createHttpConnectionsTransport(
  options: HttpAuthTransportOptions = {},
): ConnectionsTransport {
  const client = createApiClient({ url: resolveRpcUrl(options) });

  return {
    listConnections: async () => (await client.modelConnections.list()).connections,
    listCredentials: async () => (await client.credentials.list()).credentials,
    listBots: async () => (await client.bots.list({ scope: "active" })).bots,
    createConnection: (input) => client.modelConnections.create(input),
    storeCredential: (input) => client.credentials.store(input),
    revokeCredential: async (name) => {
      await client.credentials.remove({ name });
    },
    setDefaultConnection: (id) => client.modelConnections.setDefault({ id }),
    removeConnection: (id) => client.modelConnections.remove({ id }),
    probeConnection: async (id) => (await client.modelConnections.probe({ id })).probe,
    setBotConnection: (input) =>
      client.bots.update({ id: input.botId, modelConnectionId: input.connectionId }),
  };
}
