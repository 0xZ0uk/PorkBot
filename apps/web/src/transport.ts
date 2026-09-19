import { ORPCError, createApiClient, defaultThreadPageSize, maxPageSize } from "@porkbot/contracts";
import type { Bot, Message, Thread } from "@porkbot/contracts";
import { AuthRefusal } from "./session.ts";
import type { ThreadConsoleTransport } from "./console.ts";
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
 * the auth library's own routes: the API mounts its handler under
 * `/api/auth` (slice 12.1 wires the process), and this module is the client
 * half of that mount — no second session protocol, and the cookie stays
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
