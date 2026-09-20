/**
 * The literal reading of a Compose file the deployment checks compare against.
 *
 * This is deliberately a scanner, not a YAML parser: `test/deployment.test.ts`
 * uses it to fail when the env template and deploy/compose.yaml drift, and
 * `deploy:check --compose` hands the same file to `docker compose config` for
 * the authoritative parse. The image-reference scanner in
 * `../dependencies/image-refs.ts` takes the same approach for the same reason:
 * a check that skips what it cannot parse can be defeated by writing something
 * it cannot parse.
 */

export interface ComposeVariable {
  readonly name: string;
  /**
   * True for `${NAME:?}` — Compose refuses to start when it is missing. A
   * `${NAME:-default}` reference is optional and never in this set.
   */
  readonly required: boolean;
}

/**
 * Every `${NAME...}` reference outside an escaped `$${...}`, with the required
 * ones marked. The negative lookbehind is what keeps `${POSTGRES_USER}` inside
 * Compose's `$${POSTGRES_USER}` escape out of the result.
 */
export function composeVariables(text: string): ComposeVariable[] {
  const variables = new Map<string, boolean>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    for (const match of line.matchAll(/(?<!\$)\$\{([A-Z][A-Z0-9_]*)(:?[-?])?/g)) {
      const name = match[1] ?? "";
      const operator = match[2] ?? "";
      const required = operator === ":?";

      variables.set(name, (variables.get(name) ?? false) || required);
    }
  }

  return [...variables].map(([name, required]) => ({ name, required }));
}

/** The service names declared under `services:`, in file order. */
export function composeServices(text: string): string[] {
  const services: string[] = [];
  let inServices = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line === "" || line.startsWith("#")) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;

    if (indent === 0) {
      inServices = line === "services:";
      continue;
    }

    if (!inServices) {
      continue;
    }

    if (indent === 2 && /^[A-Za-z0-9_-]+:$/.test(line)) {
      services.push(line.slice(0, -1));
    }
  }

  return services;
}

/**
 * A service's own block, from its `    name:` line to the next sibling. The
 * deployment tests use it to assert per-service facts (a healthcheck, a CPU
 * and memory ceiling) without a YAML dependency.
 */
export function composeServiceBlock(text: string, service: string): string | undefined {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${service}:`);

  if (start === -1) {
    return undefined;
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[A-Za-z0-9_-]+:$/.test(line));
  const block = end === -1 ? rest : rest.slice(0, end);

  return [lines[start], ...block].join("\n");
}
