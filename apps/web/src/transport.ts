import { ORPCError, createApiClient } from "@porkbot/contracts";
import { AuthRefusal } from "./session.ts";
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

export function createHttpAuthTransport(options: HttpAuthTransportOptions = {}): AuthTransport {
  const client = createApiClient({ url: `${options.origin ?? ""}${options.rpcPath ?? rpcPath}` });
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
