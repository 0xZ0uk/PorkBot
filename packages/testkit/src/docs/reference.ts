import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * The environment reference's check (slice 12.7). The `.env.schema` files and
 * `deploy/porkbot.env.example` are the source of truth for names; this module
 * reads them and fails when `docs/environment.md` and the prose around it
 * drift, in both directions:
 *
 *   - a schema or template variable that is not documented;
 *   - a documented variable no schema or template declares;
 *   - a `required` annotation or a Compose refusal the table does not state;
 *   - a `PORKBOT_*`/`TESTKIT_*` name in README or docs that nothing declares.
 *
 * It reads files and nothing else, so the CI job needs no install.
 */

export interface SchemaDeclaration {
  readonly name: string;
  /** Repo-relative schema path, for problem messages. */
  readonly schema: string;
  readonly required: boolean;
  readonly sensitive: boolean;
}

export interface ReferenceRow {
  readonly name: string;
  readonly required: string;
  readonly defaultValue: string;
  readonly notes: string;
}

export interface ParsedReference {
  readonly rows: readonly ReferenceRow[];
  readonly problems: readonly string[];
}

/** Every schema the workspace ships: the root plus each app and package. */
export function schemaFilePaths(repoRoot: string): string[] {
  const paths: string[] = [];

  if (existsSync(path.join(repoRoot, ".env.schema"))) {
    paths.push(".env.schema");
  }

  for (const group of ["apps", "packages"]) {
    const groupDirectory = path.join(repoRoot, group);

    if (!existsSync(groupDirectory)) {
      continue;
    }

    for (const entry of readdirSync(groupDirectory).sort()) {
      if (existsSync(path.join(groupDirectory, entry, ".env.schema"))) {
        paths.push(`${group}/${entry}/.env.schema`);
      }
    }
  }

  return paths;
}

/** The declarations in one schema, with the annotations written above them. */
export function parseSchema(text: string, schema: string): SchemaDeclaration[] {
  const lines = text.split("\n");
  const declarations: SchemaDeclaration[] = [];

  lines.forEach((line, index) => {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);

    if (match === null) {
      return;
    }

    const [, name = ""] = match;
    const annotations: string[] = [];

    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const previous = lines[cursor] ?? "";

      if (!previous.startsWith("#")) {
        break;
      }

      annotations.push(previous);
    }

    const joined = annotations.join(" ");

    declarations.push({
      name,
      schema,
      required: /@required\b/.test(joined),
      sensitive: /@sensitive\b/.test(joined),
    });
  });

  return declarations;
}

/** The keys `pnpm deploy:setup` renders into `deploy/.env`. */
export function templateKeys(text: string): string[] {
  const keys: string[] = [];

  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);

    if (match !== null) {
      keys.push(match[1] ?? "");
    }
  }

  return keys;
}

/**
 * The rows of every `| Variable | Required | Default | Notes |` table. Other
 * tables in the reference are deliberately skipped: only this shape claims to
 * answer required/default, so only this shape is checked.
 */
export function parseReferenceTables(text: string): ParsedReference {
  const rows: ReferenceRow[] = [];
  const problems: string[] = [];
  let inTable = false;
  let lineNumber = 0;

  for (const line of text.split("\n")) {
    lineNumber += 1;
    const cells = line.split("|").map((cell) => cell.trim());

    if (cells.length < 6 || !line.startsWith("|")) {
      inTable = false;
      continue;
    }

    const [, first = "", second = ""] = cells;

    if (first === "Variable" && second === "Required") {
      inTable = true;
      continue;
    }

    if (!inTable || /^-+$/.test(first)) {
      continue;
    }

    const [, nameCell = "", required = "", defaultValue = "", notes = ""] = cells;
    const nameMatch = /^`([A-Z][A-Z0-9_]*)`$/.exec(nameCell);

    if (nameMatch === null) {
      problems.push(
        `docs/environment.md:${String(lineNumber)}: table row "${nameCell}" is not a backticked variable name.`,
      );
      continue;
    }

    const [, name = ""] = nameMatch;

    if (required !== "required" && required !== "optional") {
      problems.push(
        `docs/environment.md:${String(lineNumber)}: ${name} must say "required" or "optional", not "${required}".`,
      );
    }

    if (defaultValue === "") {
      problems.push(`docs/environment.md:${String(lineNumber)}: ${name} has no default cell.`);
    }

    if (notes === "") {
      problems.push(`docs/environment.md:${String(lineNumber)}: ${name} has no notes.`);
    }

    rows.push({ name, required, defaultValue, notes });
  }

  return { rows, problems };
}

function mentions(text: string, name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(text);
}

export interface ReferenceCheckInput {
  readonly text: string;
  readonly declarations: readonly SchemaDeclaration[];
  readonly templateKeys: readonly string[];
  readonly docOnlyNames: readonly string[];
  readonly runtimeNames: readonly string[];
  readonly runtimePrefixes: readonly string[];
  readonly requiredDeploymentKeys: readonly string[];
}

/** Problems with the reference itself: coverage, rows, and required answers. */
export function checkEnvironmentReference(input: ReferenceCheckInput): string[] {
  const { rows, problems: rowProblems } = parseReferenceTables(input.text);
  const problems = [...rowProblems];
  const rowByName = new Map(rows.map((row) => [row.name, row]));
  const known = new Set<string>([
    ...input.declarations.map((declaration) => declaration.name),
    ...input.templateKeys,
    ...input.docOnlyNames,
    ...input.runtimeNames,
  ]);

  for (const name of new Set(rows.map((row) => row.name))) {
    if (!known.has(name)) {
      problems.push(
        `docs/environment.md documents ${name}, which no schema, template or override register declares.`,
      );
    }
  }

  const requiredBySchema = new Set<string>();

  for (const name of new Set(input.declarations.map((declaration) => declaration.name))) {
    const declarations = input.declarations.filter((declaration) => declaration.name === name);

    if (!mentions(input.text, name)) {
      problems.push(
        `docs/environment.md does not document ${name} (${declarations[0]?.schema ?? ""}).`,
      );
    }

    if (declarations.every((declaration) => declaration.required)) {
      requiredBySchema.add(name);
    }

    if (declarations.some((declaration) => declaration.sensitive)) {
      const row = rowByName.get(name);

      if (row === undefined) {
        problems.push(`docs/environment.md has no row for the secret ${name}.`);
      } else if (!/secret|sensitive/i.test(row.notes)) {
        problems.push(`docs/environment.md row ${name} should say the value is a secret.`);
      }
    }
  }

  for (const name of input.templateKeys) {
    if (!mentions(input.text, name)) {
      problems.push(`docs/environment.md does not document the deployment key ${name}.`);
    }
  }

  for (const name of [...input.docOnlyNames, ...input.runtimeNames]) {
    const base = name.replace(/<[^>]*>/g, "").replace(/_+$/, "");

    if (!input.text.includes(base)) {
      problems.push(
        `docs/environment.md does not mention ${name}, which the override register names.`,
      );
    }
  }

  for (const name of requiredBySchema) {
    const row = rowByName.get(name);

    if (row === undefined) {
      problems.push(`docs/environment.md has no required/optional row for ${name}.`);
    } else if (row.required !== "required") {
      problems.push(
        `docs/environment.md marks ${name} optional, but the schema marks it required.`,
      );
    }
  }

  for (const name of input.requiredDeploymentKeys) {
    const row = rowByName.get(name);

    if (row === undefined) {
      problems.push(`docs/environment.md has no required/optional row for ${name}.`);
    } else if (row.required !== "required") {
      problems.push(
        `docs/environment.md marks ${name} optional, but Compose refuses to start without it.`,
      );
    }
  }

  return problems;
}

/**
 * Names in prose that nothing declares. A trailing `*` or `<...>` is a family
 * (`PORKBOT_BACKUP_S3_*`, `PORKBOT_WEBHOOK_SECRET_<SOURCE>`); a family passes
 * when a declared name starts with it or it is registered as a runtime prefix.
 */
export function unknownEnvironmentMentions(
  text: string,
  file: string,
  knownNames: ReadonlySet<string>,
  runtimePrefixes: readonly string[],
): string[] {
  const problems: string[] = [];

  for (const match of text.matchAll(/(?<![A-Z0-9_])(?:PORKBOT|TESTKIT)_[A-Z0-9_]+/g)) {
    const raw = match[0];
    const next = text[match.index + raw.length];
    const isFamily = next === "*" || next === "<";
    const name = isFamily ? raw.replace(/_+$/, "") : raw;

    if (knownNames.has(name)) {
      continue;
    }

    if (
      isFamily &&
      (runtimePrefixes.includes(name) || [...knownNames].some((known) => known.startsWith(name)))
    ) {
      continue;
    }

    problems.push(
      `${file}: ${raw} is not declared in any .env.schema or in deploy/porkbot.env.example.`,
    );
  }

  return problems;
}

/** Convenience for the CLI: every declaration across every schema file. */
export function readSchemaDeclarations(repoRoot: string): SchemaDeclaration[] {
  const declarations: SchemaDeclaration[] = [];

  for (const schema of schemaFilePaths(repoRoot)) {
    const text = readFileSync(path.join(repoRoot, ...schema.split("/")), "utf8");
    declarations.push(...parseSchema(text, schema));
  }

  return declarations;
}
