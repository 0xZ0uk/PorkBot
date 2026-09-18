import type { MemberRole } from "@porkbot/contracts";

/**
 * The shell's session, as a small framework-free state machine.
 *
 * The three states the shell has to get right are `bootstrapping`, `signed-out`
 * and `signed-in`, and the fourth exists because pretending is worse: a session
 * read that fails is `unavailable`, never "signed out". A guard decides from
 * these states, not from the presence of a cookie (which JavaScript cannot see
 * anyway, because the session cookie is `HttpOnly`).
 *
 * Nothing here touches React or the router, so the transitions are unit-testable
 * with a fake transport, and the same instance is what the route guards read.
 */

/** Who the shell is acting as, derived from `account.me`. */
export interface SessionActor {
  readonly userId: string;
  readonly spaceId: string;
  readonly role: MemberRole;
}

export type SessionState =
  | { readonly status: "bootstrapping" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly actor: SessionActor }
  | { readonly status: "unavailable" };

export interface Credentials {
  readonly email: string;
  readonly password: string;
}

export interface Registration extends Credentials {
  readonly name: string;
}

/** Whether the deployment offers signup; `unknown` is not `closed`. */
export type SignupAvailability = "open" | "closed" | "unknown";

/**
 * The client half of auth. It is an interface so the controller is testable
 * without a network, and so the transport can be swapped when the desktop
 * wrapper points at another origin.
 */
export interface AuthTransport {
  /** The signed-in actor, or `null` when the request is anonymous. */
  currentActor(): Promise<SessionActor | null>;
  signIn(credentials: Credentials): Promise<void>;
  signUp(registration: Registration): Promise<void>;
  signOut(): Promise<void>;
  signupAvailability(): Promise<SignupAvailability>;
}

export type AuthRefusalReason = "refused" | "unreachable" | "not_signed_in";

/**
 * A refused sign-in or sign-up. The reason decides the copy: a refusal keeps
 * the server's sentence, an unreachable deployment gets its own, and a
 * `not_signed_in` read-back means the credential was accepted but no session
 * followed, which is a defect the screen reports without detail.
 */
export class AuthRefusal extends Error {
  override readonly name = "AuthRefusal";
  readonly reason: AuthRefusalReason;

  constructor(reason: AuthRefusalReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface SessionController {
  state(): SessionState;
  subscribe(listener: () => void): () => void;
  /**
   * Resolves the session, reusing the result once resolved and de-duplicating
   * concurrent callers. Route guards call this on every navigation; a guard
   * must not turn one navigation into one session read.
   */
  ensure(): Promise<SessionState>;
  /** Forgets the cached result and reads the session again. */
  reload(): Promise<SessionState>;
  signIn(credentials: Credentials): Promise<void>;
  signUp(registration: Registration): Promise<void>;
  signOut(): Promise<void>;
}

export interface SessionControllerOptions {
  readonly transport: AuthTransport;
}

export function createSessionController(options: SessionControllerOptions): SessionController {
  const listeners = new Set<() => void>();
  let state: SessionState = { status: "bootstrapping" };
  let loaded = false;
  let inFlight: Promise<SessionState> | undefined;

  function setState(next: SessionState): void {
    state = next;

    for (const listener of listeners) {
      listener();
    }
  }

  async function readSession(): Promise<SessionState> {
    let actor: SessionActor | null;

    try {
      actor = await options.transport.currentActor();
    } catch {
      // The distinction matters: an anonymous visitor and a deployment whose
      // session store is down look the same to a browser and must not look the
      // same to the shell. A thrown read is `unavailable`, so the screen says
      // the server could not be reached instead of showing a sign-in form that
      // cannot work.
      setState({ status: "unavailable" });

      return state;
    }

    loaded = true;
    setState(actor === null ? { status: "signed-out" } : { status: "signed-in", actor });

    return state;
  }

  function ensure(): Promise<SessionState> {
    if (loaded) {
      return Promise.resolve(state);
    }

    inFlight ??= readSession().finally(() => {
      inFlight = undefined;
    });

    return inFlight;
  }

  function reload(): Promise<SessionState> {
    loaded = false;

    return ensure();
  }

  async function authenticate(action: () => Promise<void>): Promise<void> {
    await action();

    // Sign-in and sign-up both mint the session cookie; the actor is read back
    // through the same resolver the API uses, so the shell never invents the
    // space or the role from what the auth response happened to return.
    const next = await readSession();

    if (next.status !== "signed-in") {
      throw new AuthRefusal(
        next.status === "unavailable" ? "unreachable" : "not_signed_in",
        "The session could not be established.",
      );
    }
  }

  return {
    state: () => state,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    ensure,
    reload,
    signIn: (credentials) => authenticate(() => options.transport.signIn(credentials)),
    signUp: (registration) => authenticate(() => options.transport.signUp(registration)),
    signOut: async () => {
      await options.transport.signOut();
      loaded = true;
      setState({ status: "signed-out" });
    },
  };
}
