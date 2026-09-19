import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrationsDirectory } from "./files.ts";

/**
 * The migration folder is generated output, and this test is the reviewer who
 * checks: it copies the committed journal and snapshots into a scratch
 * directory, runs `drizzle-kit generate` against the same schema, and requires
 * the result to be byte-identical. A schema change that was not generated and
 * committed shows up as an extra migration; a hand-deleted file shows up as a
 * missing one.
 *
 * `drizzle-kit generate --custom` files are copied, never regenerated — they
 * are hand-written by design and the process rule for them (a `-- hand-edited:`
 * marker with the reason) is enforced in review, not here.
 */

const packageRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const drizzleKit = path.join(packageRoot, "node_modules", "drizzle-kit", "bin.cjs");
const schema = path.join(packageRoot, "src", "schema", "index.ts");

/**
 * drizzle-kit prefixes `--out` with `./`, so an absolute output path silently
 * becomes a relative one; generation runs with the scratch directory as the
 * working directory and `--out .` instead. The schema path stays absolute, and
 * the scratch directory is outside the repository, so a failed run cannot
 * leave generated files in the tree.
 */
function generateInto(scratch: string): string {
  return execFileSync(
    process.execPath,
    [drizzleKit, "generate", "--dialect", "postgresql", "--schema", schema, "--out", "."],
    { cwd: scratch, encoding: "utf8" },
  );
}

function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();

  const walk = (relative: string): void => {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const next = path.join(relative, entry.name);

      if (entry.isDirectory()) {
        walk(next);
      } else if (entry.isFile()) {
        files.set(next, readFileSync(path.join(root, next), "utf8"));
      }
    }
  };

  walk("");

  return files;
}

function describeDifference(
  committed: Map<string, string>,
  generated: Map<string, string>,
): string {
  const lines: string[] = [];

  for (const [file, content] of committed) {
    const other = generated.get(file);

    if (other === undefined) {
      lines.push(`committed ${file} was not generated from the current schema`);
    } else if (other !== content) {
      lines.push(`committed ${file} differs from what the current schema generates`);
    }
  }

  for (const file of generated.keys()) {
    if (!committed.has(file)) {
      lines.push(`${file} is generated from the current schema but is not committed`);
    }
  }

  return lines.join("\n");
}

describe("the committed migrations", () => {
  // The generation spawns `drizzle-kit` as a child process and copies the
  // journal and its snapshots, so it takes seconds and competes with the other
  // workers of the tier; the default ten seconds is a coin flip when the tier
  // is loaded, and a timeout there is a false report about the migrations.
  it("are exactly what drizzle-kit generates from the current schema", { timeout: 60_000 }, () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "porkbot-migrations-"));

    try {
      cpSync(migrationsDirectory(), scratch, { recursive: true });
      generateInto(scratch);

      const committed = readTree(migrationsDirectory());
      const generated = readTree(scratch);
      const difference = describeDifference(committed, generated);

      expect(
        difference,
        `${difference}\n\nRun "pnpm db:generate" and commit the result; never hand-edit generated SQL.`,
      ).toBe("");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("has a migrations directory with a journal", () => {
    expect(statSync(migrationsDirectory()).isDirectory()).toBe(true);
  });
});
