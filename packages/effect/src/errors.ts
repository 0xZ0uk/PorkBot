/**
 * The shared typed-error vocabulary the transport boundary maps from (PRD
 * decision 28). Errors live here rather than beside the code that throws them,
 * because `@porkbot/effect` owns the one `Cause -> ORPCError` table and must be
 * able to name every error it maps without importing a data layer.
 *
 * Nothing here carries secret material or an operator-visible hint: a typed
 * error is a fact the caller already had, not a diagnostic.
 */

/**
 * A resource the caller asked for does not exist *in the caller's scope*. The
 * two cases — "no such row" and "a row in another space" — deliberately produce
 * the same error, so a response can never confirm that a guessed id exists
 * somewhere else (PRD decision 7).
 */
export class NotFoundError extends Error {
  readonly resource: string;
  readonly id: string;

  constructor(resource: string, id: string) {
    super(`${resource} ${id} was not found`);
    this.name = "NotFoundError";
    this.resource = resource;
    this.id = id;
  }
}

/**
 * The deployment configuration disagrees with itself: the settings table holds
 * more than one row, so "are signups open?" has no single answer. Fail-closed
 * ownership (PRD decision 8) means the resolution must be an explicit
 * misconfiguration surfaced to the operator, never a coin flip between rows,
 * and never a silently-open deployment.
 */
export class DeploymentSettingsConflictError extends Error {
  readonly rows: number;

  constructor(rows: number) {
    super(
      `deployment_settings holds ${rows} rows; exactly one configuration is expected. ` +
        "Remove the extra rows and keep the one the operator wrote.",
    );
    this.name = "DeploymentSettingsConflictError";
    this.rows = rows;
  }
}

/**
 * An adapter asked the credential store for a secret the deployment does not
 * hold, and the provider fails closed rather than sending anything unauthenticated
 * (PRD decision 28 maps this to `PRECONDITION`). The name identifies which
 * credential is missing; the value never existed to leak.
 */
export class CredentialMissingError extends Error {
  readonly credentialName: string;

  constructor(credentialName: string) {
    super(
      `credential "${credentialName}" is not configured. ` +
        "Store it through the deployment's credential source before enabling the provider.",
    );
    this.name = "CredentialMissingError";
    this.credentialName = credentialName;
  }
}

/**
 * Why a user-supplied URL was refused. The reasons are distinct because a
 * caller can act on them differently: `insecure_scheme` and
 * `embedded_credentials` are configuration mistakes an operator can fix, while
 * `blocked_address` is the trust boundary holding (PRD decision 23).
 */
export type BlockedUrlReason =
  "invalid_url" | "insecure_scheme" | "embedded_credentials" | "blocked_address";

function blockedUrlMessage(
  reason: BlockedUrlReason,
  host: string | undefined,
  address: string | undefined,
): string {
  switch (reason) {
    case "invalid_url":
      return "the URL is not a valid absolute URL.";
    case "insecure_scheme":
      return (
        `only https URLs may be fetched${host === undefined ? "" : `; got another scheme for "${host}"`}. ` +
        "Plain http can be read and rewritten in flight."
      );
    case "embedded_credentials":
      return (
        `the URL for "${host ?? "the host"}" embeds credentials. ` +
        "Store the secret separately and send it as a header, so it cannot leak through a URL."
      );
    case "blocked_address":
      return (
        `"${host ?? "the host"}" resolves to ${address ?? "an address"} which is private, loopback, ` +
        "link-local, metadata or otherwise not publicly routable. This fetch was refused."
      );
  }
}

/**
 * A fetch of a user-supplied URL was refused before any request was sent
 * (PRD decision 23). Blocked fetches produce this typed error — never a raw
 * network failure — so the transport boundary maps one fact instead of parsing
 * an errno, and a caller can tell a policy refusal from an unreachable host.
 *
 * The error carries the host name and the offending address, never the URL:
 * a URL may embed a credential or a secret query parameter, and an error is
 * serialized into logs.
 */
export class BlockedUrlError extends Error {
  readonly reason: BlockedUrlReason;
  readonly host: string | undefined;
  readonly address: string | undefined;

  constructor(reason: BlockedUrlReason, host?: string, address?: string) {
    super(blockedUrlMessage(reason, host, address));
    this.name = "BlockedUrlError";
    this.reason = reason;
    this.host = host;
    this.address = address;
  }
}
