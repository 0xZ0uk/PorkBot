/**
 * Per-computer network isolation, as policy (slice 7.1, PRD decision 20; story
 * 29).
 *
 * A bot's computer must reach neither another bot's computer nor a service on
 * the host. The supervisor is the only process that can make that true — it
 * holds the Docker socket — but the decision is data, not a Docker call, so it
 * lives here and one implementation of each computer provider turns it into a
 * network. Two properties are the whole policy:
 *
 *   - the name is derived from the computer's own identity, so two computers
 *     can never share a network by accident, and the derivation is pure and
 *     stable across restarts so a rebuilt supervisor adopts the same network;
 *   - the plan says "internal", so the network has no route off it: no host
 *     gateway, no published ports and no second network to fall back to.
 *
 * `assertComputerNetworkPlan` is the guard a provider runs before it creates
 * anything. It refuses a plan that names the host, the default bridge or the
 * default network, or that turns off the internal-only property, so a provider
 * cannot quietly write a second policy in a Docker flag. The names Docker
 * already owns are listed here rather than discovered at runtime, because
 * "porkbot never attaches a computer to the default bridge" must hold even
 * when Docker is not running to ask.
 */

/** The identity a per-computer network is derived from; ids are opaque strings. */
export interface ComputerIdentity {
  readonly computerId: string;
  readonly botId: string;
}

/** Every isolated network this deployment creates carries this prefix. */
export const COMPUTER_NETWORK_PREFIX = "porkbot-bot";

/**
 * Docker's own network names, which a per-computer network may never be and
 * may never join: `host` removes the boundary entirely, `bridge` and `default`
 * are shared by every container that does not opt out, and `none` is not a
 * network a computer can work in.
 */
export const RESERVED_NETWORK_NAMES = ["host", "bridge", "default", "none"] as const;

/** The longest name Docker accepts for a network; the derivation stays inside it. */
export const MAX_COMPUTER_NETWORK_NAME_LENGTH = 63;

/**
 * How much of each id reaches the name. The two budgets plus the prefix, two
 * separators and the eight-character hash stay inside the Docker limit exactly,
 * so a very long bot id truncates the readable part instead of the hash that
 * keeps two ids apart.
 */
const MAX_BOT_SLUG_LENGTH = 24;
const MAX_COMPUTER_SLUG_LENGTH = 16;

/**
 * The isolation plan for one computer. `driver`, `internal` and `gatewayMode`
 * are the provider's instructions; `hostNetwork` and `publishPorts` are stated
 * as `false` rather than omitted so a reader sees the whole boundary, and a
 * provider that serializes this plan cannot lose a field to a default.
 *
 * `internal` alone still leaves the network's gateway address answering, and a
 * service the host binds to that address is reachable from inside the
 * computer. `gatewayMode: "isolated"` removes the gateway address entirely, so
 * "cannot reach host services" is a property of the network rather than of
 * what the host happens to bind. The provider must ask for both; an engine
 * without gateway modes refuses the create, which is the fail-closed answer.
 */
export interface ComputerNetworkPlan {
  readonly name: string;
  readonly driver: "bridge";
  /** No route off the network: the internet and the other bridges are unreachable. */
  readonly internal: true;
  /** No gateway address on the network, so the host's own services are unreachable too. */
  readonly gatewayMode: "isolated";
  /** The computer never joins the host's network namespace. */
  readonly hostNetwork: false;
  /** Nothing on the computer is reachable from the host. */
  readonly publishPorts: false;
}

/** Why a plan was refused; the provider fails closed on any of them. */
export type ComputerNetworkPlanProblem =
  | "not_prefixed"
  | "reserved_name"
  | "name_too_long"
  | "external_route"
  | "reachable_gateway"
  | "host_network"
  | "published_ports";

/**
 * Pure FNV-1a over the identity. The hash is not an integrity check; it is what
 * makes two ids that sanitize to the same slug still name different networks,
 * and what keeps a name unique when an id contains characters Docker would not
 * accept.
 */
function identityHash(input: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

/** Lowercase, keep `[a-z0-9_-]`, collapse the rest into separators. */
function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized === "" ? "computer" : normalized;
}

/**
 * The network one computer lives on. Same identity in, same name out, on every
 * process and every restart, so `ensure` after a crash adopts the network the
 * previous process created instead of leaking a second one.
 */
export function planComputerNetwork(computer: ComputerIdentity): ComputerNetworkPlan {
  if (computer.computerId.trim() === "" || computer.botId.trim() === "") {
    throw new RangeError("a computer network needs both a bot id and a computer id");
  }

  const hash = identityHash(`${computer.botId}\u0000${computer.computerId}`);
  const botSlug = slug(computer.botId).slice(0, MAX_BOT_SLUG_LENGTH);
  const computerSlug = slug(computer.computerId).slice(0, MAX_COMPUTER_SLUG_LENGTH);

  return {
    name: `${COMPUTER_NETWORK_PREFIX}-${botSlug}-${computerSlug}-${hash}`,
    driver: "bridge",
    internal: true,
    gatewayMode: "isolated",
    hostNetwork: false,
    publishPorts: false,
  };
}

/** Every way a plan can break the isolation rule, in a fixed order. */
export function computerNetworkPlanProblems(
  plan: ComputerNetworkPlan,
): readonly ComputerNetworkPlanProblem[] {
  const problems: ComputerNetworkPlanProblem[] = [];

  if (!plan.name.startsWith(`${COMPUTER_NETWORK_PREFIX}-`)) {
    problems.push("not_prefixed");
  }

  if ((RESERVED_NETWORK_NAMES as readonly string[]).includes(plan.name)) {
    problems.push("reserved_name");
  }

  if (plan.name.length > MAX_COMPUTER_NETWORK_NAME_LENGTH) {
    problems.push("name_too_long");
  }

  if (plan.internal !== true || plan.driver !== "bridge") {
    problems.push("external_route");
  }

  if (plan.gatewayMode !== "isolated") {
    problems.push("reachable_gateway");
  }

  if (plan.hostNetwork !== false) {
    problems.push("host_network");
  }

  if (plan.publishPorts !== false) {
    problems.push("published_ports");
  }

  return problems;
}

/**
 * The guard a provider runs before creating or joining a network. A refusal
 * names the offending property, so a misconfigured adapter fails at the seam
 * instead of producing a computer that can see the host.
 */
export function assertComputerNetworkPlan(plan: ComputerNetworkPlan): ComputerNetworkPlan {
  const problems = computerNetworkPlanProblems(plan);

  if (problems.length > 0) {
    throw new RangeError(
      `computer network "${plan.name}" is not isolated: ${problems.join(", ")}. ` +
        "Build it with planComputerNetwork so the policy has one owner.",
    );
  }

  return plan;
}
