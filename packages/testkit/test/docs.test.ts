import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { findRepoRoot } from "../src/paths.ts";
import { checkDocs, docOnlyNames, markdownFiles, runtimeNames } from "../src/docs/check.ts";
import {
  duplicateHeadingProblems,
  findLinkProblems,
  headingSlugs,
  slugifyHeading,
} from "../src/docs/links.ts";
import type { MarkdownFile } from "../src/docs/links.ts";
import {
  checkEnvironmentReference,
  parseReferenceTables,
  parseSchema,
  templateKeys,
  unknownEnvironmentMentions,
} from "../src/docs/reference.ts";
import type { ReferenceCheckInput, SchemaDeclaration } from "../src/docs/reference.ts";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(path.join(tmpdir(), "porkbot-docs-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("heading anchors", () => {
  it("matches GitHub's slug for a heading with punctuation", () => {
    expect(slugifyHeading("Runbook: when streaming does not stream")).toBe(
      "runbook-when-streaming-does-not-stream",
    );
    expect(slugifyHeading("`pnpm` usage")).toBe("pnpm-usage");
  });

  it("skips fenced code and suffixes duplicate headings", () => {
    const text = [
      "# Alpha",
      "",
      "```sh",
      "# not a heading",
      "```",
      "",
      "## Alpha",
      "",
      "### Alpha",
    ].join("\n");

    expect(headingSlugs(text)).toEqual(["alpha", "alpha-1", "alpha-2"]);
  });
});

describe("links", () => {
  const root = path.join(scratch, "links");
  const readmePath = path.join(root, "README.md");

  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "a.md"), "# Hello\n\n## Good Anchor\n");
  writeFileSync(
    readmePath,
    [
      "[good](docs/a.md#good-anchor)",
      "[missing file](docs/gone.md)",
      "[bad anchor](docs/a.md#not-there)",
      "[external](https://example.com/missing)",
      "[backticked `docs/a.md`](#heading)",
      "`docs/gone.md`",
    ].join("\n\n"),
  );

  function files(): MarkdownFile[] {
    return [{ path: "README.md", text: readFileSync(readmePath, "utf8") }];
  }

  it("resolves good links and reports the rest", () => {
    const problems = findLinkProblems(root, files()).join("\n");

    expect(problems).toContain("docs/gone.md");
    expect(problems).toContain("#not-there");
    expect(problems).not.toContain("good-anchor");
    expect(problems).not.toContain("example.com");
  });

  it("reports a duplicated heading in a target document", () => {
    const text = "# Same\n\n# Same\n";

    expect(duplicateHeadingProblems([{ path: "docs/a.md", text }]).join("\n")).toContain("same");
  });
});

describe("environment reference", () => {
  it("reads annotations and defaults from a schema", () => {
    const text = [
      "# @sensitive @required @type=url",
      "DATABASE_URL=",
      "",
      "# @type=port",
      "PORT=3001",
    ].join("\n");

    expect(parseSchema(text, ".env.schema")).toEqual([
      { name: "DATABASE_URL", schema: ".env.schema", required: true, sensitive: true },
      { name: "PORT", schema: ".env.schema", required: false, sensitive: false },
    ]);
  });

  it("reads keys from the deployment template", () => {
    expect(templateKeys("PORKBOT_IMAGE_TAG=@image-tag\n# PORKBOT_IGNORED=1\n")).toEqual([
      "PORKBOT_IMAGE_TAG",
    ]);
  });

  it("rejects a row whose required cell is not required or optional", () => {
    const { problems } = parseReferenceTables(
      "| Variable | Required | Default | Notes |\n| --- | --- | --- | --- |\n| `PORT` | yes | `1` | x |\n",
    );

    expect(problems.join("\n")).toContain('"required" or "optional"');
  });

  const declarations: SchemaDeclaration[] = [
    { name: "APP_ENV", schema: ".env.schema", required: false, sensitive: false },
    { name: "DATABASE_URL", schema: ".env.schema", required: true, sensitive: true },
  ];

  function input(text: string): ReferenceCheckInput {
    return {
      text,
      declarations,
      templateKeys: [],
      docOnlyNames: [],
      runtimeNames: [],
      runtimePrefixes: [],
      requiredDeploymentKeys: [],
    };
  }

  it("reports a schema variable the reference does not document", () => {
    const problems = checkEnvironmentReference(
      input("| Variable | Required | Default | Notes |\n| --- | --- | --- | --- |\n"),
    );

    expect(problems.join("\n")).toContain("APP_ENV");
  });

  it("reports an undeclared variable in a table and a missing secret note", () => {
    const text = [
      "| Variable | Required | Default | Notes |",
      "| --- | --- | --- | --- |",
      "| `DATABASE_URL` | optional | — | the database |",
      "| `PORKBOT_INVENTED` | optional | — | x |",
    ].join("\n");
    const problems = checkEnvironmentReference(input(text)).join("\n");

    expect(problems).toContain("PORKBOT_INVENTED");
    expect(problems).toContain("DATABASE_URL");
  });

  it("flags a name no schema declares", () => {
    const problems = unknownEnvironmentMentions(
      "Set `PORKBOT_MYSTERY` and `PORKBOT_BACKUP_S3_*` and `PORKBOT_WEBHOOK_SECRET_<SOURCE>`.",
      "README.md",
      new Set(["PORKBOT_BACKUP_S3_BUCKET"]),
      ["PORKBOT_WEBHOOK_SECRET"],
    ).join("\n");

    expect(problems).toContain("PORKBOT_MYSTERY");
    expect(problems).not.toContain("PORKBOT_BACKUP_S3_");
    expect(problems).not.toContain("PORKBOT_WEBHOOK_SECRET_");
  });
});

describe("the repository's documentation", () => {
  it("is in sync with the schemas, the template and itself", () => {
    expect(checkDocs(repoRoot)).toEqual([]);
  });

  it("checks the README and every docs markdown file", () => {
    const paths = markdownFiles(repoRoot).map((file) => file.path);

    expect(paths).toContain("README.md");
    expect(paths).toContain("docs/self-host.md");
    expect(paths).toContain("docs/environment.md");
    expect(paths).toContain("docs/runbook.md");
    expect(paths).toContain("docs/computers.md");
    expect(paths).toContain("docs/security.md");
  });

  it("registers every non-schema name it allows", () => {
    expect(docOnlyNames.every((name) => /^[A-Z][A-Z0-9_]+$/.test(name))).toBe(true);
    expect(runtimeNames).toContain("PORKBOT_WEBHOOK_SECRET_<SOURCE>");
  });
});
