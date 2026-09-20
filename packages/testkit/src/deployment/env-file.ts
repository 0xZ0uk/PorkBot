import { generatedCredentialKeyId, optionalDeploymentValueKinds } from "./secrets.ts";
import type { DeploymentValuePlan } from "./secrets.ts";

/**
 * Reading and writing the deployment's one environment file.
 *
 * The file Compose reads is plain `KEY=VALUE` text, and this module is the
 * only code that parses it or renders it from the template. Parsing is
 * deliberately close to Compose's own rules — blank lines and `#` comments are
 * ignored, the first `=` separates key from value, and surrounding quotes are
 * stripped — and rendering walks the template line by line, so the comments
 * that document each value survive into the file the operator reads.
 *
 * A value that starts with `@` is a template sentinel. Rendering resolves the
 * ones the register declares and refuses anything else; validation separately
 * refuses a sentinel that reaches an env file unresolved, which is what a
 * hand-copied `porkbot.env.example` would otherwise look like.
 */

export interface RenderDeploymentEnvInput {
  readonly template: string;
  /** The register from `secrets.ts`; passed in so the renderer stays pure. */
  readonly plans: readonly DeploymentValuePlan[];
  /** Generated secrets, keyed by environment variable. */
  readonly generated: ReadonlyMap<string, string>;
  /** Operator values (`--origin`, `--tag`, ...), keyed by variable. */
  readonly setup: ReadonlyMap<string, string>;
}

export function unquoteEnvValue(value: string): string {
  const match = /^(['"])(.*)\1$/.exec(value);

  return match === null ? value : (match[2] ?? "");
}

/** Parses `KEY=VALUE` text the way Compose reads an `--env-file`. */
export function parseEnvFile(text: string): Map<string, string> {
  const values = new Map<string, string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const separator = line.indexOf("=");

    if (separator <= 0) {
      continue;
    }

    const key = line.slice(0, separator).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    values.set(key, unquoteEnvValue(line.slice(separator + 1).trim()));
  }

  return values;
}

/**
 * Values are embedded verbatim into a line of the file, so a newline or a
 * leading `#` would change what the file means. Generated material is safe by
 * construction; operator values are checked here so a flag cannot smuggle a
 * second setting in.
 */
function assertEmbeddableValue(key: string, value: string): void {
  if (value.trim() !== value || value === "" || /[\r\n\0]/.test(value) || value.startsWith("#")) {
    throw new Error(
      `the value for ${key} is not a single trimmed environment value; ` +
        "remove control characters, surrounding whitespace or a leading '#'.",
    );
  }
}

/**
 * Renders the committed template into the deployment's env file. Every plan
 * key must appear in the template exactly carrying its sentinel, and every
 * sentinel must resolve to a generated or operator value; anything else throws
 * rather than writing a file with a literal sentinel in it.
 */
export function renderDeploymentEnv(input: RenderDeploymentEnvInput): string {
  const plansByKey = new Map(input.plans.map((plan) => [plan.key, plan]));
  const resolved = new Set<string>();

  const lines = input.template.split("\n").map((rawLine) => {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(rawLine);

    if (match === null) {
      return rawLine;
    }

    const key = match[1] ?? "";
    const rawValue = match[2] ?? "";
    const plan = plansByKey.get(key);

    if (plan === undefined) {
      return rawLine;
    }

    if (rawValue !== plan.sentinel) {
      throw new Error(
        `${key} must carry the sentinel ${plan.sentinel} in the template; it carries ` +
          `"${rawValue}". Fix deploy/porkbot.env.example or the register in secrets.ts.`,
      );
    }

    const supplied = plan.kind.startsWith("generated-")
      ? input.generated.get(key)
      : input.setup.get(key);
    // An optional kind (the credential proxy) that nothing supplied stays
    // empty: the supervisor treats an empty setting as absent, and a partial
    // proxy configuration is what it refuses.
    const value = supplied ?? (optionalDeploymentValueKinds.has(plan.kind) ? "" : undefined);

    if (value === undefined) {
      throw new Error(
        `no value was supplied for ${key} (${plan.why}); the template cannot be rendered.`,
      );
    }

    if (value !== "") {
      assertEmbeddableValue(key, value);
    }

    resolved.add(key);

    return `${key}=${value}`;
  });

  const missing = input.plans.filter((plan) => !resolved.has(plan.key));

  if (missing.length > 0) {
    throw new Error(
      `the template does not declare ${missing.map((plan) => plan.key).join(", ")}. ` +
        "Every key in the register must appear in deploy/porkbot.env.example.",
    );
  }

  const rendered = lines.join("\n");

  // The keyring's id and the active id are two halves of one fact: the
  // template pins the active id and the generator writes under it. Checking
  // the rendered pair here means a mismatch fails at setup, not at the API's
  // first credential read.
  if (input.plans.some((plan) => plan.kind === "generated-keyring")) {
    assertKeyringActiveId(rendered);
  }

  return rendered;
}

/**
 * The active key id and the keyring's first entry must name the same key: the
 * id is what the envelope records and what a rotation flips.
 */
export function keyringMatchesActiveKey(values: ReadonlyMap<string, string>): boolean {
  const active = values.get("PORKBOT_CREDENTIAL_ACTIVE_KEY");
  const keyring = values.get("PORKBOT_CREDENTIAL_KEYS");

  if (active === undefined || keyring === undefined) {
    return false;
  }

  const first = keyring.split(",")[0]?.trim() ?? "";
  const separator = first.indexOf(":");

  return separator > 0 && first.slice(0, separator) === active;
}

function assertKeyringActiveId(rendered: string): void {
  const values = parseEnvFile(rendered);

  if (!keyringMatchesActiveKey(values)) {
    throw new Error(
      "PORKBOT_CREDENTIAL_ACTIVE_KEY must be the id the generated keyring writes under " +
        `(${generatedCredentialKeyId}); check the template and secrets.ts.`,
    );
  }
}

/** The header `setup` writes above the rendered template. */
export function deploymentEnvHeader(envFileName: string): string {
  return [
    `# Generated by \`pnpm deploy:setup\`. Do not commit this file: every secret`,
    `# in the deployment lives here, and nothing else reads it.`,
    `#`,
    `# Validate it with \`pnpm deploy:check\`, then start the stack with`,
    `# \`pnpm deploy:up\`. The file is mode 0600 (${envFileName}).`,
    "",
  ].join("\n");
}
