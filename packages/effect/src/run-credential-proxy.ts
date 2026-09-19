import type {
  ComputerProvider,
  ComputerProxyEndpoint,
  ComputerRef,
  CredentialStore,
  ProviderFailure,
  ProxyUpstreamGrant,
} from "@porkbot/adapter-kit";
import { botSecretCredentialHeader } from "@porkbot/core";
import type { BotSecretResolver } from "./bot-secrets.ts";
import {
  createProxyCapabilityCodec,
  MAX_PROXY_CAPABILITY_TTL_SECONDS,
} from "./proxy-capability.ts";

/**
 * The run-scoped credential proxy (slice 7.8, PRD decision 29; audit P1 item 7).
 *
 * This is the composition between a run and its computer's proxy: it resolves
 * the run's credentials server-side, writes them into a grant the sandbox can
 * never read, and hands the run's commands a capability instead — a URL and a
 * signed token, nothing else. The grant is the whole of one run's credentialed
 * egress: it names each upstream by a name the sandbox types, and the proxy is
 * the only party that knows which origin that name dials and which credential
 * header it carries.
 *
 * Three properties are decided here rather than left to a caller:
 *
 *   - the grant's deadline is the run's own; a crashed writer cannot leave a
 *     grant reachable past it, because the proxy checks the deadline on every
 *     request and the run's settle path revokes the file besides;
 *   - the capability is minted per command, bound to the run *and* the
 *     computer, and its lifetime covers that command's budget — so a token
 *     read out of a sandbox's environment stops working shortly after the
 *     command that carried it, and never works on another run's grant or
 *     another machine's proxy;
 *   - a missing provider proxy is a typed refusal (`not_found`), not a silent
 *     fallback to a sandbox with no way out; a missing credential is a typed
 *     refusal too, with the credential's *name* in the detail and never a
 *     value.
 *
 * Nothing here writes a credential into an environment: `environmentFor` is
 * the only method a command path calls, and what it returns is a capability.
 */

/** The environment variable a sandboxed command finds its proxy at. */
export const RUN_PROXY_URL_ENV = "PORKBOT_PROXY_URL";
/** The environment variable a sandboxed command authenticates its proxy with. */
export const RUN_PROXY_TOKEN_ENV = "PORKBOT_PROXY_TOKEN";

/**
 * One upstream a run may reach. `credentialName` is resolved through the
 * deployment's credential store on the server side; a plan without one is a
 * plain allowlist entry the proxy forwards with only the caller's safe headers.
 */
export interface RunProxyUpstreamPlan {
  /** The name the sandbox calls, for example `model` or `github`. */
  readonly name: string;
  /** The absolute HTTPS origin the proxy forwards to; no path. */
  readonly origin: string;
  /** The stored credential the proxy injects, if any. */
  readonly credentialName?: string | undefined;
  /** The header the credential rides in; `authorization` by default. */
  readonly header?: string | undefined;
  /** The scheme prefixed to the value; `Bearer` by default, `""` for none. */
  readonly scheme?: string | undefined;
}

export interface RunCredentialProxyOptions {
  /** The provider whose `proxy` admin will hold the grant. */
  readonly provider: ComputerProvider;
  /** Where a credential name resolves; the deployment's store, server-side only. */
  readonly credentials: CredentialStore;
  /**
   * Where a bot secret resolves (slice 9.6). Present, a run may grow an
   * upstream mid-life by asking for a stored bot secret; absent, `grantSecret`
   * answers `unavailable` and no secret can be added to the grant. The resolver
   * returns a value only into this handle's own header construction.
   */
  readonly botSecrets?: BotSecretResolver | undefined;
  /** The key capabilities are signed with; shared with the computer's proxy. */
  readonly tokenSecret: string | Uint8Array;
  /** The clock, in whole seconds; injected in tests. */
  readonly nowSeconds?: (() => number) | undefined;
}

export interface OpenRunCredentialProxyRequest {
  readonly computer: ComputerRef;
  readonly runId: string;
  /**
   * The grant's hard deadline in whole Unix seconds — the run's lease end, so
   * an abandoned grant dies with the run rather than waiting for a sweep.
   */
  readonly expiresAtSeconds: number;
  readonly upstreams: readonly RunProxyUpstreamPlan[];
}

/**
 * What one mid-life secret ask did. `granted` means the upstream is published
 * and the next command's capability can reach it; `missing` means the operator
 * approved but no value is stored; `name_taken` means an upstream of that name
 * already belongs to the run's opening plan; `unavailable` means the run has no
 * secret resolver or its grant is already closed.
 */
export type BotSecretGrantResult =
  | { readonly status: "granted" }
  | { readonly status: "missing" }
  | { readonly status: "name_taken" }
  | { readonly status: "unavailable" };

/**
 * The narrow half of a run's handle the bot-secret tools hold: grow the grant
 * by one named secret, or take one back. The value never crosses this seam —
 * `grantSecret` resolves and injects it inside the handle — so a tool that
 * holds this interface cannot read a credential even by accident.
 */
export interface BotSecretUpstreams {
  /** Resolves one stored bot secret and publishes it as an upstream. */
  grantSecret(name: string): Promise<BotSecretGrantResult>;
  /**
   * Removes one secret upstream and republishes, so the next request naming it
   * is refused. Removing a name the handle does not own is a no-op.
   */
  revokeSecret(name: string): Promise<void>;
}

/** What a run holds: where its proxy is, how a command authenticates, and how to revoke. */
export interface RunCredentialProxyHandle extends BotSecretUpstreams {
  readonly endpoint: ComputerProxyEndpoint;
  /**
   * The environment one command carries. Called per command so each command's
   * capability is fresh and sized to that command's own budget.
   */
  environmentFor(timeoutMs: number): Readonly<Record<string, string>>;
  /**
   * Removes the grant; idempotent, and safe from a settle path that races a
   * failure. A closed handle refuses later upstream changes rather than
   * resurrecting a grant for a run that already ended.
   */
  revoke(): Promise<void>;
}

/**
 * The provider cannot run a credential proxy. It is the shared vocabulary's
 * `not_found`: a run whose machine has no proxy cannot be given one, and the
 * caller decides whether to run without it rather than reaching the sandbox
 * with a credential the proxy was supposed to hold.
 */
export class RunProxyUnavailableError extends Error implements ProviderFailure {
  readonly kind = "not_found" as const;
  readonly detail: string;

  constructor(providerKind: string | undefined) {
    const detail =
      providerKind === undefined
        ? "this deployment runs no credential proxy for the run's computer"
        : `the "${providerKind}" computer provider runs no credential proxy`;

    super(detail);
    this.name = "RunProxyUnavailableError";
    this.detail = detail;
  }
}

/**
 * A credential the run's plan named is not in the store. The detail carries
 * the name — which the plan itself supplied, never a value — so the wiring is
 * fixable without a secret ever reaching a log line.
 */
export class RunProxyCredentialError extends Error implements ProviderFailure {
  readonly kind = "auth_failed" as const;
  readonly detail: string;

  constructor(credentialName: string) {
    const detail = `the credential "${credentialName}" is not stored for this space`;

    super(detail);
    this.name = "RunProxyCredentialError";
    this.detail = detail;
  }
}

/**
 * The capability's lifetime for one command: its budget plus a small slack,
 * never past the ceiling. There is deliberately no floor — a token minted for
 * a one-second command goes stale in about half a minute, not in the codec's
 * five-minute default — so a capability read out of a finished command's
 * environment buys an attacker as little as the command itself did, while a
 * ten-minute command still carries a token that covers it.
 */
function capabilityTtlSeconds(timeoutMs: number): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(
      `a proxy capability needs a positive command budget, received ${String(timeoutMs)}`,
    );
  }

  return Math.min(MAX_PROXY_CAPABILITY_TTL_SECONDS, Math.ceil(timeoutMs / 1_000) + 30);
}

export interface RunCredentialProxy {
  /** Resolves the plan, writes the grant and returns the run's handle. */
  open(request: OpenRunCredentialProxyRequest): Promise<RunCredentialProxyHandle>;
}

export function createRunCredentialProxy(options: RunCredentialProxyOptions): RunCredentialProxy {
  const codec = createProxyCapabilityCodec(
    options.tokenSecret,
    options.nowSeconds === undefined ? {} : { nowSeconds: options.nowSeconds },
  );

  async function headersFor(plan: RunProxyUpstreamPlan): Promise<ProxyUpstreamGrant> {
    if (plan.credentialName === undefined) {
      return { name: plan.name, origin: plan.origin };
    }

    const value = await options.credentials.resolve(plan.credentialName);

    if (value === undefined || value === "") {
      throw new RunProxyCredentialError(plan.credentialName);
    }

    const header = (plan.header ?? "authorization").toLowerCase();
    const scheme = plan.scheme ?? "Bearer";

    return {
      name: plan.name,
      origin: plan.origin,
      headers: { [header]: scheme === "" ? value : `${scheme} ${value}` },
    };
  }

  return {
    async open(request: OpenRunCredentialProxyRequest): Promise<RunCredentialProxyHandle> {
      const admin = options.provider.proxy;

      if (admin === undefined) {
        throw new RunProxyUnavailableError(request.computer.provider);
      }

      if (!Number.isSafeInteger(request.expiresAtSeconds) || request.expiresAtSeconds <= 0) {
        throw new RangeError(
          `a run's proxy grant needs a positive whole expiry, received ${String(request.expiresAtSeconds)}`,
        );
      }

      const upstreams: ProxyUpstreamGrant[] = [];

      for (const plan of request.upstreams) {
        upstreams.push(await headersFor(plan));
      }

      const endpoint = await admin.grant(request.computer, {
        runId: request.runId,
        expiresAtSeconds: request.expiresAtSeconds,
        upstreams,
      });
      const binding = {
        runId: request.runId,
        computerId: request.computer.computerId,
        botId: request.computer.botId,
      };

      // The mid-life half (slice 9.6): a bot secret is resolved into one more
      // upstream and the whole grant is republished — the admin seam replaces,
      // and the proxy reads the grant file per request, so the next command's
      // capability reaches the new upstream with no restart. Every mutation is
      // serialized and a closed handle refuses to republish, so a settle path's
      // revoke cannot be raced by a late grant.
      const secretUpstreams = new Map<string, ProxyUpstreamGrant>();
      let closed = false;
      let pending: Promise<unknown> = Promise.resolve();

      const serialize = <A>(work: () => Promise<A>): Promise<A> => {
        const result = pending.then(work, work);
        pending = result.then(
          () => undefined,
          () => undefined,
        );
        return result;
      };

      const publish = (): Promise<ComputerProxyEndpoint> =>
        admin.grant(request.computer, {
          runId: request.runId,
          expiresAtSeconds: request.expiresAtSeconds,
          upstreams: [...upstreams, ...secretUpstreams.values()],
        });

      return {
        endpoint,
        environmentFor(timeoutMs: number): Readonly<Record<string, string>> {
          const ttlSeconds = capabilityTtlSeconds(timeoutMs);

          return {
            [RUN_PROXY_URL_ENV]: endpoint.url,
            [RUN_PROXY_TOKEN_ENV]: codec.mint(binding, ttlSeconds),
          };
        },
        grantSecret(name: string): Promise<BotSecretGrantResult> {
          return serialize(async () => {
            if (closed || options.botSecrets === undefined) {
              return { status: "unavailable" } satisfies BotSecretGrantResult;
            }

            if (upstreams.some((upstream) => upstream.name === name)) {
              return { status: "name_taken" } satisfies BotSecretGrantResult;
            }

            const resolved = await options.botSecrets.resolve(request.computer.botId, name);

            if (resolved === undefined || resolved.value === "") {
              return { status: "missing" } satisfies BotSecretGrantResult;
            }

            const header = botSecretCredentialHeader(resolved.destination, resolved.value);
            const previous = secretUpstreams.get(name);

            secretUpstreams.set(name, {
              name,
              origin: resolved.destination.origin,
              headers: { [header.name.toLowerCase()]: header.value },
            });

            try {
              await publish();
            } catch (error) {
              if (previous === undefined) {
                secretUpstreams.delete(name);
              } else {
                secretUpstreams.set(name, previous);
              }

              throw error;
            }

            return { status: "granted" } satisfies BotSecretGrantResult;
          });
        },
        revokeSecret(name: string): Promise<void> {
          return serialize(async () => {
            const previous = secretUpstreams.get(name);

            if (closed || previous === undefined) {
              return;
            }

            secretUpstreams.delete(name);

            try {
              await publish();
            } catch (error) {
              // The local map is what a retry consults: keeping the entry when
              // the republish failed means the next revoke tries again rather
              // than reporting a removal the proxy never received.
              secretUpstreams.set(name, previous);
              throw error;
            }
          });
        },
        revoke(): Promise<void> {
          closed = true;
          secretUpstreams.clear();

          return serialize(() => admin.revoke(request.computer, request.runId));
        },
      };
    },
  };
}
