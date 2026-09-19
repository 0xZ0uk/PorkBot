/**
 * The register of dangerous actions (slice 10.2, PRD decision 30; story 40).
 *
 * "Dangerous" is defined here once, and every tool consults this module before
 * it acts, so the classes an operator is asked about cannot drift between the
 * file tools, the browser and an MCP server's tools. The five classes are the
 * whole definition:
 *
 *   - `credential_access` — a call whose arguments name a credential store,
 *     read or written. This is the PRD's "secret-adjacent path reads"; a write
 *     into the store is the same secret-adjacent access, because writing a
 *     key is how one is planted.
 *   - `credential_request` — a call that asks to use a stored bot secret. The
 *     value is never in the call; the operator's approval is what binds the
 *     secret to this run's proxy, so every ask is a gate.
 *   - `write_outside_home` — a write whose path resolves outside the bot's
 *     home. An approved call proceeds against that resolved path; the policy
 *     does not refuse it outright, because a refusal the operator could have
 *     reversed is not an approval gate.
 *   - `egress_unlisted` — a fetch or browser navigation to a host that is not
 *     on the run's allowlist. The host decision itself is `decideEgress`'s;
 *     this module only puts its answer in the one register.
 *   - `send` and `delete` — a call whose tool is a connector side effect. An
 *     MCP server names its own tools, so the class comes from the verbs in
 *     that name (`connectorDangerousActions`); a tool whose name says
 *     `delete_issue` or `send_email` declares itself.
 *
 * The classification is a claim the arguments still have to support. A tool
 * declares the classes it can perform (`declared`), and a rule fires only when
 * the call's own path or URL matches: `file_write` declares
 * `write_outside_home` and an inside-home write stays ungated, which is the
 * acceptance criterion that the gate stays usable. For the same reason nothing
 * here classifies `shell`: a command string cannot be attributed to one class
 * without a parser that would be wrong in both directions, and the sandbox is
 * the shell's boundary (PRD decision 29).
 *
 * A tool that declares a path class must name its path argument `path`, and a
 * tool that declares `egress_unlisted` must name its URL argument `url`; those
 * are the two shapes the rules read, and the tool factories are the call sites
 * the tests exercise.
 */

import { decideEgress } from "./egress-policy.ts";
import type { EgressAllowlist } from "./egress-policy.ts";
import { resolveComputerPath } from "./files.ts";

/**
 * Every class an approval gate answers to. The order is the order the rules
 * are evaluated in, most specific first: a credential path that is also
 * outside the home is a credential access, not a home escape.
 */
export const DANGEROUS_ACTION_CLASSES = [
  "credential_access",
  "credential_request",
  "write_outside_home",
  "egress_unlisted",
  "send",
  "delete",
] as const;

export type DangerousActionClass = (typeof DANGEROUS_ACTION_CLASSES)[number];

/** Whether a value is one of the registered classes; transports parse with it. */
export function isDangerousActionClass(value: unknown): value is DangerousActionClass {
  return (
    typeof value === "string" && (DANGEROUS_ACTION_CLASSES as readonly string[]).includes(value)
  );
}

/**
 * Directory names whose contents are a credential store. A path that passes
 * through any of these is in the store, so reading `.ssh/known_hosts` gates
 * the same way reading the key does.
 */
export const CREDENTIAL_STORE_DIRECTORIES = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".kube",
  ".docker",
  ".password-store",
  ".secrets",
  "gcloud",
] as const;

/**
 * File names that are a credential store wherever they live. `.env` and
 * `credentials` are included because they are how a project keeps its keys;
 * a deployment that keeps secrets elsewhere does not pay for the rule.
 */
export const CREDENTIAL_STORE_FILES = [
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pgpass",
  ".env",
  "credentials",
  "id_rsa",
  "id_ed25519",
  "id_ecdsa",
  "id_dsa",
] as const;

/** The verbs that make a connector tool a send. */
export const CONNECTOR_SEND_VERBS = [
  "send",
  "post",
  "publish",
  "reply",
  "forward",
  "share",
  "upload",
  "submit",
] as const;

/** The verbs that make a connector tool a delete. */
export const CONNECTOR_DELETE_VERBS = [
  "delete",
  "remove",
  "destroy",
  "drop",
  "purge",
  "revoke",
  "unlink",
  "archive",
  "trash",
  "forget",
] as const;

/** One flagged call: the class it belongs to and the line the operator reads. */
export interface DangerousAction {
  readonly class: DangerousActionClass;
  /** A concrete sentence naming the path, host or tool the call would act on. */
  readonly summary: string;
}

export interface DangerousActionRequest {
  readonly tool: string;
  readonly arguments: unknown;
  /** The bot's home directory; a path inside it is not `write_outside_home`. */
  readonly home: string;
  /** The run's egress allowlist; the default is the empty, fail-closed list. */
  readonly allowlist: EgressAllowlist;
  /**
   * The classes the tool's own surface declares. A rule only fires for a
   * declared class, and the call's arguments still have to match it.
   */
  readonly declared?: readonly DangerousActionClass[] | undefined;
}

/**
 * What the policy says about one call. `refused` exists for the one
 * destination that cannot even be attributed to a host: asking the operator
 * about it would be asking about nothing, so the tool refuses it without a
 * gate — the same answer `decideEgress` already gives.
 */
export type DangerousActionClassification =
  | { readonly verdict: "safe" }
  | { readonly verdict: "refused"; readonly reason: "invalid_url" }
  | { readonly verdict: "dangerous"; readonly action: DangerousAction };

const SAFE: DangerousActionClassification = { verdict: "safe" };

/**
 * The classes a connector tool name declares, from the verbs in it. Names are
 * split on case and non-alphanumeric boundaries, so `sendEmail`, `send_email`
 * and `email.send` all reach the same tokens. A name carrying both a read and
 * a mutation verb (`search_and_destroy`) is conservative and declares the
 * mutation; over-asking is what auto-review (BL.6) exists to remove, and
 * under-asking is what this policy exists to prevent.
 */
export function connectorDangerousActions(toolName: string): readonly DangerousActionClass[] {
  const tokens = tokenize(toolName);
  const classes: DangerousActionClass[] = [];

  if (CONNECTOR_DELETE_VERBS.some((verb) => tokens.has(verb))) {
    classes.push("delete");
  }

  if (CONNECTOR_SEND_VERBS.some((verb) => tokens.has(verb))) {
    classes.push("send");
  }

  return classes;
}

function tokenize(value: string): ReadonlySet<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token !== ""),
  );
}

/** Whether a path names a credential store, by any of its segments. */
export function isCredentialStorePath(path: string): boolean {
  const segments = path
    .split(/[\\/]+/)
    .map((segment) => segment.trim().toLowerCase())
    .filter((segment) => segment !== "");

  return segments.some(
    (segment) =>
      (CREDENTIAL_STORE_DIRECTORIES as readonly string[]).includes(segment) ||
      (CREDENTIAL_STORE_FILES as readonly string[]).includes(segment),
  );
}

function declaredIncludes(request: DangerousActionRequest, action: DangerousActionClass): boolean {
  return request.declared?.includes(action) ?? false;
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];

  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The credential-store rule. It needs a path argument and a declared claim,
 * and it answers the store question on the raw spelling before any resolution:
 * `.ssh/id_rsa` is the store whether the caller meant it relative or absolute.
 */
function credentialAccess(
  request: DangerousActionRequest,
  record: Record<string, unknown>,
): DangerousAction | undefined {
  if (!declaredIncludes(request, "credential_access")) {
    return undefined;
  }

  const path = readString(record, "path");

  if (path === undefined || !isCredentialStorePath(path)) {
    return undefined;
  }

  return {
    class: "credential_access",
    summary: `access the credential store "${path}"`,
  };
}

/**
 * The credential-request rule (slice 9.6). A tool that asks to use a stored bot
 * secret declares the class; the call's own destination is metadata and never a
 * value, and the operator's approval is what binds the secret to this run's
 * proxy. A request that names nothing cannot be attributed to a credential, so
 * the tool's own validation refuses it before this rule is consulted.
 */
function credentialRequest(
  request: DangerousActionRequest,
  record: Record<string, unknown>,
): DangerousAction | undefined {
  if (!declaredIncludes(request, "credential_request")) {
    return undefined;
  }

  const name = readString(record, "name");

  if (name === undefined) {
    return undefined;
  }

  return {
    class: "credential_request",
    summary: `use the stored credential "${name}"`,
  };
}

/**
 * The home-escape rule. The path is resolved exactly as the file tool will
 * resolve it, so the gate fires on the same path the command would name; a
 * path that cannot resolve at all is the tool's invalid-argument refusal, not
 * a gate.
 */
function writeOutsideHome(
  request: DangerousActionRequest,
  record: Record<string, unknown>,
): DangerousAction | undefined {
  if (!declaredIncludes(request, "write_outside_home")) {
    return undefined;
  }

  const path = readString(record, "path");

  if (path === undefined) {
    return undefined;
  }

  const resolved = resolveComputerPath(request.home, path);

  if (!resolved.ok || !resolved.value.outside) {
    return undefined;
  }

  return {
    class: "write_outside_home",
    summary: `write outside the home to "${resolved.value.path}"`,
  };
}

/**
 * The egress rule: `decideEgress` owns the host decision, and this maps its
 * answer into the register. An invalid URL is the policy's one refusal.
 */
function egressUnlisted(
  request: DangerousActionRequest,
  record: Record<string, unknown>,
): DangerousActionClassification | undefined {
  if (!declaredIncludes(request, "egress_unlisted")) {
    return undefined;
  }

  const url = readString(record, "url");

  if (url === undefined) {
    return undefined;
  }

  const decision = decideEgress(request.allowlist, url);

  if (decision.decision === "refused") {
    return { verdict: "refused", reason: "invalid_url" };
  }

  if (decision.decision === "allowed") {
    return SAFE;
  }

  return {
    verdict: "dangerous",
    action: {
      class: "egress_unlisted",
      summary: `reach "${decision.host}", which is not on this run's egress allowlist`,
    },
  };
}

function connectorAction(
  request: DangerousActionRequest,
  action: "send" | "delete",
): DangerousAction | undefined {
  if (!declaredIncludes(request, action)) {
    return undefined;
  }

  return {
    class: action,
    summary:
      action === "send"
        ? `send through the "${request.tool}" tool`
        : `delete through the "${request.tool}" tool`,
  };
}

/**
 * Classifies one call. The rules run in the register's order and the first
 * match wins; a rule that does not apply returns `undefined` and the next one
 * gets its turn. `safe` is the ordinary answer, and it is what keeps a benign
 * action in a declared class — a read inside the home, a write beside it, an
 * allowlisted host — from ever reaching the approval gate.
 */
export function classifyDangerousAction(
  request: DangerousActionRequest,
): DangerousActionClassification {
  const record = asRecord(request.arguments) ?? {};

  const credential = credentialAccess(request, record);
  if (credential !== undefined) {
    return { verdict: "dangerous", action: credential };
  }

  const request_ = credentialRequest(request, record);
  if (request_ !== undefined) {
    return { verdict: "dangerous", action: request_ };
  }

  const deletion = connectorAction(request, "delete");
  if (deletion !== undefined) {
    return { verdict: "dangerous", action: deletion };
  }

  const send = connectorAction(request, "send");
  if (send !== undefined) {
    return { verdict: "dangerous", action: send };
  }

  const egress = egressUnlisted(request, record);
  if (egress !== undefined) {
    return egress;
  }

  const escape = writeOutsideHome(request, record);
  if (escape !== undefined) {
    return { verdict: "dangerous", action: escape };
  }

  return SAFE;
}
