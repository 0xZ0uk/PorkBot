import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { findRepoRoot } from "../src/paths.ts";

/**
 * The screenshot gate the README promises: when a pull request changes
 * `apps/web`, `packages/ui` or `packages/tokens`, the e2e tier must produce the
 * browser screenshot and publish its artifact link. The `Detect UI changes`
 * step in `.github/workflows/ci.yml` is what decides, and it once piped the
 * file list through ripgrep — which the runner image does not carry — so the
 * command failed, the step read every UI change as none, and the gate silently
 * never fired.
 *
 * This suite runs the step's own script against a scratch repository with a
 * PATH that holds git and nothing else, which is the CI condition the old
 * command failed in. A gate that cannot run must fail here rather than skip in
 * review.
 */

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));

function git(directory: string, args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scratchRepository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "porkbot-ui-gate-"));
  git(directory, ["init", "-q", "-b", "main"]);
  git(directory, ["config", "user.name", "UI Gate Fixture"]);
  git(directory, ["config", "user.email", "fixture@users.noreply.github.com"]);
  return directory;
}

function commit(directory: string, message: string): string {
  git(directory, ["add", "-A"]);
  git(directory, ["commit", "-q", "-m", message]);
  return git(directory, ["rev-parse", "HEAD"]).trim();
}

/** The `run:` block of the detect step, dedented to a standalone script. */
function detectScript(): string {
  const workflow = readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const lines = workflow.split("\n");
  const step = lines.findIndex((line) => line.trim() === "- name: Detect UI changes");

  if (step === -1) {
    throw new Error("ci.yml has no Detect UI changes step; the screenshot gate moved or vanished.");
  }

  const run = lines.findIndex((line, index) => index > step && line.trim() === "run: |");

  if (run === -1) {
    throw new Error("the Detect UI changes step has no block script.");
  }

  const indent = (lines[run] ?? "").match(/^\s*/)?.[0].length ?? 0;
  const body: string[] = [];

  for (let index = run + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineIndent = line.match(/^\s*/)?.[0].length ?? 0;

    if (line.trim() !== "" && lineIndent <= indent) {
      break;
    }

    body.push(line.slice(indent + 2));
  }

  return `${body.join("\n")}\n`;
}

/**
 * Runs the step with a PATH that holds only git: the runner image ships no
 * ripgrep, and a step that needs one must fail this test, not skip on CI.
 */
function runDetect(directory: string, baseSha: string, headSha: string): string {
  const output = path.join(directory, "github-output");
  const bin = path.join(directory, "bin");
  const gitShim = path.join(bin, "git");
  mkdirSync(bin, { recursive: true });

  if (!existsSync(gitShim)) {
    symlinkSync(execFileSync("which", ["git"], { encoding: "utf8" }).trim(), gitShim);
  }

  writeFileSync(output, "");

  execFileSync("/bin/bash", ["-c", detectScript()], {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: bin,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      BASE_SHA: baseSha,
      HEAD_SHA: headSha,
      GITHUB_OUTPUT: output,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  return readFileSync(output, "utf8").trim();
}

describe("the UI screenshot gate", () => {
  it("reads a UI change as changed and a non-UI change as not", () => {
    const repository = scratchRepository();

    try {
      writeFileSync(path.join(repository, "README.md"), "base\n");
      const base = commit(repository, "base");

      mkdirSync(path.join(repository, "docs"), { recursive: true });
      writeFileSync(path.join(repository, "docs", "note.md"), "note\n");
      const docsHead = commit(repository, "docs");

      mkdirSync(path.join(repository, "apps", "web", "src"), { recursive: true });
      writeFileSync(path.join(repository, "apps", "web", "src", "styles.css"), "a {}\n");
      const uiHead = commit(repository, "ui");

      expect(runDetect(repository, base, docsHead)).toBe("changed=false");
      expect(runDetect(repository, base, uiHead)).toBe("changed=true");
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
