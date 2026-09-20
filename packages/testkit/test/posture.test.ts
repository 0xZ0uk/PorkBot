import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkPostureFiles } from "../src/posture/files.ts";
import { publishedRefs, scanHistory } from "../src/posture/history.ts";
import {
  CONTENT_PERSONAL_DATA_RULES,
  PROSE_PERSONAL_DATA_RULES,
  findPersonalDataMatches,
  findSecretMatches,
  isPersonalEmail,
  isReservedEmail,
} from "../src/posture/patterns.ts";
import { findRepoRoot } from "../src/paths.ts";

/**
 * The public-posture audit is only useful if its rules fire on the shapes they
 * name and stay quiet on this repository's deliberate fixtures. Every fixture
 * below is assembled at runtime for the same reason the real test fixtures are:
 * a literal provider shape in this file would be the leak the audit exists to
 * catch, and GitHub's push protection would refuse the commit.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

function git(directory: string, args: readonly string[], env: Record<string, string> = {}): string {
  return execFileSync("git", [...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scratchRepository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "porkbot-posture-"));
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "Posture Fixture"]);
  git(directory, ["config", "user.email", "fixture@users.noreply.github.com"]);
  return directory;
}

describe("the secret register", () => {
  it("flags provider-shaped secrets and not their parts", () => {
    const slack = ["xoxb", "123456789012", "abcdefghijklmnop"].join("-");
    const token = ["ghp", "abcdefghijklmnopqrstuvwxyz0123456789"].join("_");

    expect(findSecretMatches(`token is ${slack}`).map((match) => match.rule)).toEqual([
      "secret/slack-token",
    ]);
    expect(findSecretMatches(`token is ${token}`).map((match) => match.rule)).toEqual([
      "secret/github-token",
    ]);
    expect(findSecretMatches("xoxb-")).toEqual([]);
    expect(findSecretMatches("sk-live-abcdefghijklmnopqrstuvwxyz")).toEqual([]);
  });

  it("flags a PEM header and a JWT", () => {
    const header = ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" ");
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", "c2lnbmF0dXJl"].join(".");

    expect(findSecretMatches(header).map((match) => match.rule)).toContain("secret/private-key");
    expect(findSecretMatches(jwt).map((match) => match.rule)).toContain("secret/jwt");
  });
});

describe("the personal-data rules", () => {
  it("flags a real address and a personal home directory", () => {
    const address = ["person", "personal-domain.dev"].join("@");
    const home = ["", "home", "someone", "code"].join("/");

    expect(isPersonalEmail(address)).toBe(true);
    expect(
      findPersonalDataMatches(address, CONTENT_PERSONAL_DATA_RULES).map((m) => m.rule),
    ).toEqual(["personal/email"]);
    expect(isReservedEmail("owner@example.invalid")).toBe(true);
    expect(isReservedEmail("agent@users.noreply.github.com")).toBe(true);
    expect(isReservedEmail("password@database.internal")).toBe(true);
    expect(findPersonalDataMatches(home, CONTENT_PERSONAL_DATA_RULES).map((m) => m.rule)).toEqual([
      "personal/home-path",
    ]);
  });

  it("flags a machine-local hostname in prose and not a file named like one", () => {
    const rules = PROSE_PERSONAL_DATA_RULES;
    const flag = (text: string) => findPersonalDataMatches(text, rules).map((match) => match.rule);

    expect(flag("the box at build-box.local is down")).toContain("personal/private-hostname");
    expect(flag("see https://staging.lan for the copy")).toContain("personal/private-hostname");
    expect(flag("a root `.env.local` applies everywhere")).not.toContain(
      "personal/private-hostname",
    );
  });
});

describe("the history scan", () => {
  it("finds a secret in blob content and names the file, never the value", () => {
    const directory = scratchRepository();
    const slack = ["xoxb", "123456789012", "abcdefghijklmnop"].join("-");

    try {
      writeFileSync(path.join(directory, "config.txt"), `token = "${slack}"\n`);
      git(directory, ["add", "config.txt"]);
      git(directory, ["commit", "-qm", "feat: add configuration"]);

      const { findings, stats } = scanHistory(directory, ["HEAD"]);

      expect(stats.commits).toBe(1);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.kind).toBe("secret");
      expect(findings[0]?.rule).toBe("secret/slack-token");
      expect(findings[0]?.subject).toContain("config.txt");
      expect(JSON.stringify(findings)).not.toContain(slack);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("finds a personal identity, commit prose and nothing in a clean repository", () => {
    const directory = scratchRepository();
    const address = ["person", "personal-domain.dev"].join("@");
    const home = ["", "home", "someone", "code"].join("/");

    try {
      writeFileSync(path.join(directory, "notes.md"), "placeholders only\n");
      git(directory, ["add", "notes.md"]);
      git(directory, [
        "commit",
        "-qm",
        `fix: read files under ${home}`,
        "--author",
        `Test Person <${address}>`,
      ]);

      const { findings } = scanHistory(directory, ["HEAD"]);

      expect(findings.some((finding) => finding.rule === "personal/email")).toBe(true);
      expect(findings.some((finding) => finding.rule === "personal/home-path")).toBe(true);
      expect(findings.every((finding) => finding.kind !== "secret")).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stays quiet on a repository of reserved placeholders", () => {
    const directory = scratchRepository();

    try {
      writeFileSync(
        path.join(directory, "example.md"),
        [
          "owner@example.invalid",
          "https://api.model.example/v1",
          "/home/agent/notes/todo.md",
          "//user:placeholder@database.internal",
          "",
        ].join("\n"),
      );
      git(directory, ["add", "example.md"]);
      git(directory, ["commit", "-qm", "docs: add examples"]);

      expect(scanHistory(directory, ["HEAD"]).findings).toEqual([]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("lists the refs a fresh clone would carry", () => {
    expect(publishedRefs(repoRoot).length).toBeGreaterThan(0);
  });
});

describe("the posture files", () => {
  it("accepts the repository's own files", () => {
    expect(checkPostureFiles(repoRoot)).toEqual([]);
  });

  it("names every missing promise in a directory that has none", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "porkbot-posture-files-"));

    try {
      const findings = checkPostureFiles(directory);
      const subjects = findings.map((finding) => finding.subject);

      expect(subjects).toContain("LICENSE");
      expect(subjects).toContain("CONTRIBUTING.md");
      expect(subjects).toContain("SECURITY.md");
      expect(subjects).toContain("CODE_OF_CONDUCT.md");
      expect(subjects).toContain(".github/ISSUE_TEMPLATE/bug_report.yml");
      expect(subjects).toContain(".github/ISSUE_TEMPLATE/feature_request.yml");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
