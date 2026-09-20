import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { parseEnvFile } from "../../src/deployment/env-file.ts";
import { deploymentValuePlans } from "../../src/deployment/secrets.ts";
import { findRepoRoot } from "../../src/paths.ts";

/**
 * The single-host deployment definition (slice 12.1) is proven against the
 * real thing the operator runs: this spec invokes the deployment CLI as a
 * child process, renders the committed template into a throwaway env file with
 * generated secrets, and lets Docker Compose interpolate deploy/compose.yaml
 * against it. A typo in the production compose file or a required setting the
 * template does not declare fails here by name, without building an image.
 *
 * The spec uses a reserved example origin and writes only to a temporary
 * directory; nothing it renders is committed or kept.
 */

const cliPath = fileURLToPath(new URL("../../src/deployment/cli.ts", import.meta.url));
const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const exampleOrigin = "https://bots.example.invalid";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

interface CliResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: readonly string[]): CliResult {
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };

    return {
      status: failure.status ?? 1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

describe("the single-host deployment definition", () => {
  it("renders the template with generated secrets and Compose accepts the stack", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "porkbot-deploy-integration-"));
    temporaryDirectories.push(directory);
    const envPath = path.join(directory, "deploy.env");

    const setup = runCli(["setup", "--origin", exampleOrigin, "--env-path", envPath]);

    expect(setup.stderr).toBe("");
    expect(setup.status).toBe(0);
    expect(existsSync(envPath)).toBe(true);
    expect(statSync(envPath).mode & 0o777).toBe(0o600);

    const values = parseEnvFile(readFileSync(envPath, "utf8"));

    for (const plan of deploymentValuePlans) {
      const value = values.get(plan.key) ?? "";

      if (!plan.kind.startsWith("generated-") || value === "") {
        continue;
      }

      expect(setup.stdout, `${plan.key}'s value must not be printed`).not.toContain(value);
    }

    expect(setup.stdout).toContain("Generated 9 secrets");

    const check = runCli(["check", "--env-path", envPath, "--compose"]);

    expect(check.stderr).toBe("");
    expect(check.status).toBe(0);
    expect(check.stdout).toContain("deploy/compose.yaml");
  });

  it("names a weak env file instead of starting anything", () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "porkbot-deploy-integration-"));
    temporaryDirectories.push(directory);
    const envPath = path.join(directory, "deploy.env");
    const setup = runCli([
      "setup",
      "--origin",
      "http://bots.example.invalid",
      "--env-path",
      envPath,
    ]);

    // Plain http outside loopback is refused before a byte is written.
    expect(setup.status).toBe(1);
    expect(existsSync(envPath)).toBe(false);
    expect(setup.stderr).toContain("must be https outside loopback");
  });
});
