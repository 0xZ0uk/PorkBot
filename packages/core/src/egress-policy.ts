/**
 * The run's egress allowlist: which hosts a run may reach without asking, and
 * what to do about the rest (PRD decision 30; story 40; slice 10.1).
 *
 * "Dangerous" includes any egress to a host not already in the run's allowlist,
 * so the allowlist is the unit the approval gate is asked about. This module
 * decides only that question — allowed, needs an operator's approval, or
 * refused before a request exists — and it decides it on the host, never on the
 * address: private, loopback, link-local and metadata ranges are the URL-safety
 * module's one list, and duplicating them here would create the second opinion
 * the rule against two lists exists to prevent.
 *
 * The allowlist is configuration, so parsing is strict and one entry that
 * cannot be a host fails the whole list: a deployment that meant to allow
 * `example.com` but typed a URL should not silently run with a narrower or
 * stranger set. An entry is a hostname or an IPv4 literal; `*.example.com`
 * allows subdomains at any depth but not the apex, which must be listed
 * explicitly. An empty list is a legitimate, fail-closed configuration: nothing
 * is reachable without an approval.
 *
 * The functions are pure and shareable: the tool layer calls `decideEgress`
 * before it makes a request, the approval gate consumes the decision, and a
 * test needs no network to pin either.
 */

export type EgressHostRule =
  | { readonly kind: "host"; readonly host: string }
  | { readonly kind: "subdomains"; readonly domain: string };

export interface EgressAllowlist {
  readonly rules: readonly EgressHostRule[];
}

/** Nothing reachable without an approval; the default a run starts from. */
export const EMPTY_EGRESS_ALLOWLIST: EgressAllowlist = { rules: [] };

/**
 * What the tool layer must do about one destination. `allowed` proceeds,
 * `needs_approval` records a durable gate before anything is sent, and
 * `refused` is a destination that cannot even be attributed to a host, so
 * asking the operator would be asking about nothing.
 */
export type EgressDecision =
  | { readonly decision: "allowed"; readonly host: string }
  | { readonly decision: "needs_approval"; readonly host: string; readonly url: string }
  | { readonly decision: "refused"; readonly reason: "invalid_url" };

export class EgressAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressAllowlistError";
  }
}

export type EgressHostRejection =
  "blank" | "scheme" | "credentials" | "port" | "path" | "wildcard" | "malformed" | "duplicate";

function rejectionDetail(reason: EgressHostRejection): string {
  switch (reason) {
    case "blank":
      return "a blank entry names no host";
    case "scheme":
      return "write the host alone; the scheme is decided by the URL-safety rules";
    case "credentials":
      return "remove the credentials; the allowlist names hosts, not logins";
    case "port":
      return "write the host without a port; the allowlist names hosts";
    case "path":
      return "write the host without a path, query or fragment";
    case "wildcard":
      return "a wildcard may only open a hostname (for example *.example.com)";
    case "malformed":
      return "expected a hostname or IPv4 literal, for example example.com";
    case "duplicate":
      return "the entry is already in the list";
  }
}

export class InvalidEgressHost extends EgressAllowlistError {
  readonly entry: string;
  readonly reason: EgressHostRejection;

  constructor(entry: string, reason: EgressHostRejection) {
    super(`Invalid egress allowlist entry "${entry}": ${rejectionDetail(reason)}`);
    this.name = "InvalidEgressHost";
    this.entry = entry;
    this.reason = reason;
  }
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function isIpv4(host: string): boolean {
  const parts = host.split(".");

  if (parts.length !== 4) {
    return false;
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false;
    }

    const value = Number(part);

    return value >= 0 && value <= 255 && String(value) === part;
  });
}

function isHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) {
    return false;
  }

  return host.split(".").every((label) => HOSTNAME_LABEL.test(label));
}

/**
 * The host an entry names, normalized: lowercased and stripped of a single
 * trailing dot, which is the same host. The reason it can fail is returned
 * rather than thrown so the caller can name the rule it broke.
 */
function normalizeHostEntry(entry: string): { host: string } | { reason: EgressHostRejection } {
  const trimmed = entry.trim();

  if (trimmed === "") {
    return { reason: "blank" };
  }

  if (trimmed.includes("://")) {
    return { reason: "scheme" };
  }

  if (trimmed.includes("@")) {
    return { reason: "credentials" };
  }

  const wildcard = trimmed.startsWith("*.");
  const rawHost = wildcard ? trimmed.slice(2) : trimmed;

  if (wildcard && rawHost === "") {
    return { reason: "wildcard" };
  }

  if (rawHost.includes("*")) {
    return { reason: "wildcard" };
  }

  if (rawHost.includes(":")) {
    return { reason: "port" };
  }

  if (/[/?#]/.test(rawHost)) {
    return { reason: "path" };
  }

  const host = rawHost.toLowerCase().replace(/\.$/, "");

  // A dotted-quad spelling is an address or a typo, never a hostname: letting
  // "256.0.0.1" through as a name would allowlist nothing while looking like it
  // allowlisted an address.
  if (/^[0-9.]+$/.test(host)) {
    if (!isIpv4(host)) {
      return { reason: "malformed" };
    }

    if (wildcard) {
      return { reason: "wildcard" };
    }

    return { host };
  }

  if (!isHostname(host)) {
    return { reason: "malformed" };
  }

  return { host };
}

/**
 * Parses the operator's entries into one allowlist. Every entry must normalize
 * to a host, and no host may be listed twice; a list that fails any of those is
 * rejected whole so a typo cannot narrow or widen the run silently.
 */
export function parseEgressAllowlist(entries: readonly string[]): EgressAllowlist {
  const rules: EgressHostRule[] = [];
  const seen = new Set<string>();

  for (const entry of entries) {
    const wildcard = entry.trim().startsWith("*.");
    const normalized = normalizeHostEntry(entry);

    if ("reason" in normalized) {
      throw new InvalidEgressHost(entry, normalized.reason);
    }

    const key = `${wildcard ? "*" : ""}:${normalized.host}`;

    if (seen.has(key)) {
      throw new InvalidEgressHost(entry, "duplicate");
    }

    seen.add(key);
    rules.push(
      wildcard
        ? { kind: "subdomains", domain: normalized.host }
        : { kind: "host", host: normalized.host },
    );
  }

  return { rules };
}

/** The one spelling a host is compared in: lowercase, without a trailing dot. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, "");
}

function ruleMatches(rule: EgressHostRule, host: string): boolean {
  if (rule.kind === "host") {
    return host === rule.host;
  }

  return host.endsWith(`.${rule.domain}`);
}

/**
 * Whether a host is on the list. The comparison is on the normalized host, so
 * a caller may pass either a `URL.hostname` or an operator's spelling.
 */
export function isHostAllowed(allowlist: EgressAllowlist, host: string): boolean {
  const normalized = normalizeHost(host);

  if (normalized === "") {
    return false;
  }

  return allowlist.rules.some((rule) => ruleMatches(rule, normalized));
}

/**
 * The decision for one destination. A URL that cannot yield a non-blank host is
 * refused; everything else is either on the list or a question for the
 * operator, and the decision always names the host in its normalized spelling
 * so a log line and an approval row agree. Address safety (HTTPS, credentials,
 * blocked ranges) is deliberately not repeated here: `safeFetch` owns it, and
 * the allowlist answer must stay the same whichever address the name resolves
 * to.
 *
 * An IPv6 literal parses to a bracketed host that an allowlist entry cannot
 * spell — entries are hostnames or IPv4 literals — so it always takes the
 * approval path and the URL-safety rules still decide whether it is reachable.
 */
export function decideEgress(allowlist: EgressAllowlist, url: string): EgressDecision {
  const parsed = parseUrl(url);

  if (parsed === undefined) {
    return { decision: "refused", reason: "invalid_url" };
  }

  const host = normalizeHost(parsed.hostname);

  if (host === "") {
    return { decision: "refused", reason: "invalid_url" };
  }

  if (isHostAllowed(allowlist, host)) {
    return { decision: "allowed", host };
  }

  return { decision: "needs_approval", host, url };
}

function parseUrl(url: string): URL | undefined {
  if (typeof url !== "string" || url.trim() === "") {
    return undefined;
  }

  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}
