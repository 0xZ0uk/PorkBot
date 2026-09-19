import { randomUUID } from "node:crypto";
import { isProviderFailure } from "@porkbot/adapter-kit";
import type { McpOAuthTokens, McpServerDescription, McpServerProvider } from "@porkbot/adapter-kit";
import {
  assertAllowedUrl,
  InvalidOAuthStateError,
  McpServerUnavailableError,
  NotFoundError,
  parseMcpCredential,
  serializeMcpCredential,
} from "@porkbot/effect";
import type { McpCredential, McpServerView } from "@porkbot/effect";
import { resolveBoundActor } from "@porkbot/db";
import type {
  OAuthStateBinding,
  OAuthStateStore,
  PostgresDatabase,
  UserActor,
  UserRepositories,
} from "@porkbot/db";

/**
 * The MCP install and OAuth service (slice 9.5, PRD story 38).
 *
 * The router is transport translation; this is where the two actor worlds meet.
 * Install runs under the operator's actor: the URL is checked against the
 * URL-safety rules before anything is written, the row is created, the OAuth
 * client credential is encrypted, and discovery persists the tool list. The
 * callback runs with no session at all: the state was issued to the initiating
 * actor, `consume` resolves that binding exactly once, and the membership is
 * re-read before anything is written — so a revocation between install and
 * callback refuses the flow rather than granting a credential to a user who is
 * no longer a member.
 *
 * Nothing here logs. A provider failure is re-thrown through the shared
 * vocabulary (`McpServerUnavailableError`), never as a raw response body, and
 * the credential value leaves the encrypted store only through `resolve`.
 */

/** The one path the OAuth server redirects back to. */
export const mcpCallbackPath = "/oauth/mcp/callback";

/** What separates the server id from the nonce inside the one-time state. */
const stateBindingSeparator = ".";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface McpInstallRequest {
  readonly name: string;
  readonly url: string;
  readonly auth: "none" | "oauth";
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
}

export interface McpInstallResult {
  readonly server: McpServerView;
  /** Where the browser goes next for an OAuth server; `null` for a public one. */
  readonly authorizationUrl: string | null;
}

export interface McpCallbackResult {
  readonly server: McpServerView;
}

export interface McpService {
  /** Installs one server for the actor and discovers its tools. */
  install(
    actor: UserActor,
    repositories: UserRepositories,
    input: McpInstallRequest,
  ): Promise<McpInstallResult>;
  /**
   * Completes the browser flow: consumes the one-time state, re-reads the
   * initiating membership, exchanges the code, stores the tokens encrypted and
   * discovers the tools. A replay, a foreign server or a missing code is the
   * typed `InvalidOAuthStateError`; the stored state is spent either way.
   */
  completeAuthorization(state: string, code: string | undefined): Promise<McpCallbackResult>;
}

export interface McpServiceOptions {
  readonly provider: McpServerProvider;
  /** The one-time state ledger; the binding is issued from the actor. */
  readonly ingress: OAuthStateStore;
  /** The absolute URL the browser returns to. */
  readonly callbackUrl: string;
  /**
   * Resolves the membership the one-time binding names. Defaults to
   * `@porkbot/db`'s `resolveBoundActor` over `database` — the binding's own
   * space, so a user with more than one membership completes the flow in the
   * space it was started in. A test supplies a fake.
   */
  readonly resolveActorFromBinding?:
    ((binding: OAuthStateBinding) => Promise<UserActor | null>) | undefined;
  /** Builds the actor-scoped repositories the callback writes through. */
  readonly repositoriesFor: (actor: UserActor) => UserRepositories;
  /** The database the default membership resolution binds to. */
  readonly database?: PostgresDatabase | undefined;
}

/** The credential row name one server's tokens and client secret live under. */
export function mcpCredentialName(serverName: string): string {
  return `mcp:${serverName}`;
}

function providerFailure(error: unknown): never {
  if (isProviderFailure(error)) {
    throw new McpServerUnavailableError(
      error.kind,
      error.detail === undefined || error.detail.trim() === ""
        ? `the MCP server failed (${error.kind})`
        : error.detail,
    );
  }

  throw error;
}

export function createMcpService(options: McpServiceOptions): McpService {
  const resolveActorFromBinding =
    options.resolveActorFromBinding ??
    ((binding: OAuthStateBinding) =>
      options.database === undefined
        ? Promise.resolve(null)
        : resolveBoundActor(options.database, binding));

  async function discoverAndPersist(
    repositories: UserRepositories,
    server: { readonly id: string; readonly url: string },
    accessToken: string | undefined,
  ): Promise<McpServerView> {
    let description: McpServerDescription;

    try {
      description = await options.provider.discover({
        url: server.url,
        ...(accessToken === undefined ? {} : { accessToken }),
      });
    } catch (error) {
      providerFailure(error);
    }

    await repositories.mcp.replaceTools(server.id, description.tools);
    await repositories.mcp.setStatus(server.id, "ready", null);

    return repositories.mcp.findById(server.id);
  }

  /**
   * Records why the server is not usable without masking the original failure:
   * `setStatus` is the bookkeeping, the thrown error is the answer.
   */
  async function recordFailure(
    repositories: UserRepositories,
    serverId: string,
    detail: string,
  ): Promise<void> {
    try {
      await repositories.mcp.setStatus(serverId, "error", detail);
    } catch {
      // The original failure is what the caller must see; a bookkeeping miss
      // must not replace it.
    }
  }

  return {
    async install(
      actor: UserActor,
      repositories: UserRepositories,
      input: McpInstallRequest,
    ): Promise<McpInstallResult> {
      // The URL-safety pre-flight runs before any row exists, so a refused
      // scheme, an embedded credential or a private address never becomes an
      // installed server. The provider repeats the check on the connection.
      assertAllowedUrl(input.url);
      const url = new URL(input.url).href;
      const credentialName = mcpCredentialName(input.name);

      const server = await repositories.mcp.create({
        name: input.name,
        url,
        auth: input.auth,
        credentialName,
      });

      if (input.auth === "none") {
        try {
          return {
            server: await discoverAndPersist(repositories, server, undefined),
            authorizationUrl: null,
          };
        } catch (error) {
          await recordFailure(
            repositories,
            server.id,
            isProviderFailure(error) ? (error.detail ?? "discovery failed") : "discovery failed",
          );
          throw error;
        }
      }

      try {
        if (input.clientId === undefined || input.clientId.trim() === "") {
          throw new McpServerUnavailableError(
            "auth_failed",
            "an OAuth server needs the client id this deployment registered",
          );
        }

        const credential: McpCredential = {
          clientId: input.clientId,
          ...(input.clientSecret === undefined ? {} : { clientSecret: input.clientSecret }),
        };

        await repositories.credentials.store(credentialName, serializeMcpCredential(credential));

        // The state names the server before the dot and carries a fresh nonce
        // after it; only the whole raw value is stored (hashed), so a state
        // bound to another server cannot be presented here.
        const state = `${server.id}${stateBindingSeparator}${randomUUID()}`;
        const issued = await options.ingress.issue({ actor, state });

        if (!issued) {
          throw new McpServerUnavailableError(
            "timed_out",
            "a fresh OAuth state could not be issued",
          );
        }

        const authorizationUrl = await options.provider.authorizationUrl({
          url,
          clientId: input.clientId ?? "",
          redirectUri: options.callbackUrl,
          state,
        });

        return { server: await repositories.mcp.findById(server.id), authorizationUrl };
      } catch (error) {
        await recordFailure(
          repositories,
          server.id,
          isProviderFailure(error)
            ? (error.detail ?? "authorization failed")
            : "authorization failed",
        );
        throw error;
      }
    },

    async completeAuthorization(
      state: string,
      code: string | undefined,
    ): Promise<McpCallbackResult> {
      if (code === undefined || code.trim() === "") {
        throw new InvalidOAuthStateError("missing_code");
      }

      // The server id rides in the state's prefix; the store hashes the whole
      // value, so a tampered prefix cannot consume anything.
      const separator = state.indexOf(stateBindingSeparator);
      const serverId = separator === -1 ? "" : state.slice(0, separator);
      const binding = await options.ingress.consume(state);

      if (binding === undefined) {
        throw new InvalidOAuthStateError("unknown_or_used");
      }

      const actor = await resolveActorFromBinding(binding);

      if (actor === null) {
        throw new InvalidOAuthStateError("actor_gone");
      }

      const repositories = options.repositoriesFor(actor);
      const server = await findServer(repositories, serverId);
      const raw = await repositories.credentials.resolve(server.credentialName);
      const credential = parseMcpCredential(raw);

      if (credential.clientId === undefined) {
        throw new McpServerUnavailableError(
          "auth_failed",
          "the server's OAuth client is not stored",
        );
      }

      let tokens: McpOAuthTokens;

      try {
        tokens = await options.provider.exchangeCode({
          url: server.url,
          clientId: credential.clientId,
          code,
          redirectUri: options.callbackUrl,
          ...(credential.clientSecret === undefined
            ? {}
            : { clientSecret: credential.clientSecret }),
        });
      } catch (error) {
        providerFailure(error);
      }

      const stored: McpCredential = {
        clientId: credential.clientId,
        ...(credential.clientSecret === undefined ? {} : { clientSecret: credential.clientSecret }),
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken === undefined ? {} : { refreshToken: tokens.refreshToken }),
        ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt.toISOString() }),
      };

      await repositories.credentials.store(server.credentialName, serializeMcpCredential(stored));

      try {
        return { server: await discoverAndPersist(repositories, server, tokens.accessToken) };
      } catch (error) {
        await recordFailure(
          repositories,
          server.id,
          isProviderFailure(error) ? (error.detail ?? "discovery failed") : "discovery failed",
        );
        throw error;
      }
    },
  };
}

/**
 * A state that names no addressable server is the same answer as one naming a
 * foreign server: the typed rejection. The guard keeps a malformed prefix out
 * of a UUID column, where Postgres would answer a cast error instead.
 */
async function findServer(
  repositories: UserRepositories,
  serverId: string,
): Promise<McpServerView> {
  if (!uuidPattern.test(serverId)) {
    throw new InvalidOAuthStateError("unknown_server");
  }

  try {
    return await repositories.mcp.findById(serverId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      throw new InvalidOAuthStateError("unknown_server");
    }

    throw error;
  }
}
