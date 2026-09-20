import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { runDeploy } from "../src/deployment/commands.ts";
import type { DeploymentContext, SpawnOptions, SpawnResult } from "../src/deployment/commands.ts";
import {
  composeServiceBlock,
  composeServices,
  composeVariables,
} from "../src/deployment/compose.ts";
import { parseEnvFile, renderDeploymentEnv } from "../src/deployment/env-file.ts";
import {
  deploymentValuePlans,
  generateDeploymentSecrets,
  generatedSecretSentinel,
} from "../src/deployment/secrets.ts";
import { requiredDeploymentKeys, validateDeploymentEnv } from "../src/deployment/validate.ts";
import { findRepoRoot } from "../src/paths.ts";

const repoRoot = findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
const deployDirectory = path.join(repoRoot, "deploy");
const templateText = readFileSync(path.join(deployDirectory, "porkbot.env.example"), "utf8");
const deployComposeText = readFileSync(path.join(deployDirectory, "compose.yaml"), "utf8");
const localComposeText = readFileSync(path.join(repoRoot, "compose.yaml"), "utf8");

const testOrigin = "https://bots.example.com";

/** A deterministic byte source so the generated values are stable in tests. */
function countingBytes(seed = 7): (size: number) => Buffer {
  let counter = seed;

  return (size) => {
    counter += 1;

    return Buffer.alloc(size, counter);
  };
}

function renderedEnv(): string {
  return renderDeploymentEnv({
    template: templateText,
    plans: deploymentValuePlans,
    generated: generateDeploymentSecrets(countingBytes()),
    setup: new Map([
      ["PORKBOT_AUTH_ORIGIN", testOrigin],
      ["PORKBOT_WEB_ORIGIN", testOrigin],
      ["PORKBOT_MCP_CALLBACK_URL", `${testOrigin}/oauth/mcp/callback`],
      ["PORKBOT_IMAGE_TAG", "testsha012345"],
    ]),
  });
}

describe("deployment register and template", () => {
  it("declares every register sentinel in the template, and nothing else", () => {
    const templateValues = parseEnvFile(templateText);
    const plansByKey = new Map(deploymentValuePlans.map((plan) => [plan.key, plan]));

    for (const plan of deploymentValuePlans) {
      expect(templateValues.get(plan.key), `${plan.key} must be declared`).toBe(plan.sentinel);
    }

    for (const [key, value] of templateValues) {
      if (!value.startsWith("@")) {
        expect(plansByKey.has(key), `${key} carries a literal value`).toBe(false);
        continue;
      }

      expect(plansByKey.get(key)?.sentinel, `${key} carries an unregistered sentinel`).toBe(value);
    }
  });

  it("keeps the template and the deployment compose file in step", () => {
    const templateKeys = [...parseEnvFile(templateText).keys()].sort();
    const composeNames = composeVariables(deployComposeText)
      .map((variable) => variable.name)
      .sort();

    expect(composeNames).toEqual(templateKeys);
  });

  it("requires exactly the values the compose file refuses to default", () => {
    const required = composeVariables(deployComposeText)
      .filter((variable) => variable.required)
      .map((variable) => variable.name)
      .sort();

    expect(required).toEqual([...requiredDeploymentKeys].sort());
  });

  it("ignores escaped variables and keeps required ones apart from defaulted ones", () => {
    const variables = composeVariables(deployComposeText);
    const names = variables.map((variable) => variable.name);

    expect(names).not.toContain("POSTGRES_USER");
    expect(variables.find((variable) => variable.name === "PORKBOT_IMAGE_TAG")?.required).toBe(
      true,
    );
    expect(variables.find((variable) => variable.name === "LOG_LEVEL")?.required).toBe(false);
  });

  it("carries the same service topology as the local stack", () => {
    expect(composeServices(deployComposeText)).toEqual(composeServices(localComposeText));
  });

  it("gives every service a healthcheck and a CPU and memory ceiling", () => {
    // The always-on services merge the `x-app` anchor, which is where their
    // healthcheck lives; postgres declares its own. The check looks for both
    // shapes rather than pretending the anchor is inlined.
    const anchorEnd = deployComposeText.indexOf("\nservices:");
    const anchor = deployComposeText.slice(0, anchorEnd);

    expect(anchor).toContain("healthcheck:");

    for (const service of composeServices(deployComposeText)) {
      const block = composeServiceBlock(deployComposeText, service);

      expect(block, `${service} must have a block`).toBeDefined();

      if (service === "migrate") {
        expect(block, "the one-shot needs no healthcheck").not.toContain("healthcheck:");
      } else if (service === "postgres") {
        expect(block, "postgres must have a healthcheck").toContain("healthcheck:");
      } else {
        expect(block, `${service} must merge the healthchecked anchor`).toContain("<<: *app");
      }

      expect(block, `${service} must declare resource limits`).toContain("resources:");
      expect(block, `${service} must cap CPUs`).toMatch(/cpus:\s*"/);
      expect(block, `${service} must cap memory`).toMatch(/memory:\s*\S/);
    }
  });

  it("keeps the stack's ceilings plus one bot inside the documented host floor", () => {
    const memoryThresholds = { m: 1024 ** 2, g: 1024 ** 3 } as const;
    let totalCpus = 0;
    let totalMemoryBytes = 0;

    for (const service of composeServices(deployComposeText)) {
      const block = composeServiceBlock(deployComposeText, service) ?? "";
      const cpus = /cpus:\s*"([\d.]+)"/.exec(block);
      const memory = /memory:\s*(\d+(?:\.\d+)?)([mg])\b/.exec(block);

      expect(cpus, `${service} must cap CPUs`).not.toBeNull();
      expect(memory, `${service} must cap memory`).not.toBeNull();

      totalCpus += Number(cpus?.[1] ?? 0);
      totalMemoryBytes +=
        Number(memory?.[1] ?? 0) * (memory?.[2] === "g" ? memoryThresholds.g : memoryThresholds.m);
    }

    // README "Single-host deployment": 4 vCPU / 8 GB is the base host, and the
    // default per-bot settings are 1 vCPU / 2048 MB. The stack plus one bot has
    // to fit with room for the OS and the daemon or the floor is a lie.
    expect(totalCpus + 1).toBeLessThanOrEqual(4);
    expect(totalMemoryBytes + 2 * memoryThresholds.g).toBeLessThanOrEqual(8 * memoryThresholds.g);
  });

  it("pins every pulled image by digest and never by latest", () => {
    // The app images are built from this checkout and tagged with the release;
    // the pulled images are the ones that must name a registered digest.
    const pulled = composeServices(deployComposeText)
      .flatMap((service) => {
        const block = composeServiceBlock(deployComposeText, service) ?? "";
        const match = /^ {4}image:\s*(\S+)/m.exec(block);

        return match === null ? [] : [match[1] ?? ""];
      })
      .filter((reference) => !reference.startsWith("porkbot/"));

    expect(pulled.length).toBeGreaterThan(0);

    for (const reference of pulled) {
      expect(reference).toMatch(/@sha256:[a-f0-9]{64}$/i);
      expect(reference).not.toMatch(/:latest@/i);
    }
  });

  it("has no local placeholder left anywhere", () => {
    expect(deployComposeText).not.toMatch(/porkbot-(?:api-|worker-|supervisor-|screen-)?local/);
  });

  it("tags images with the release variable instead of a fixed tag", () => {
    expect(deployComposeText).toMatch(/image: porkbot\/api:\$\{PORKBOT_IMAGE_TAG:\?/);
    expect(deployComposeText).not.toMatch(/image:\s*\S+:local\b/);
  });
});

describe("generating deployment secrets", () => {
  it("generates every generated key, and only generated keys", () => {
    const generated = generateDeploymentSecrets(countingBytes());
    const expected = deploymentValuePlans
      .filter(
        (plan) =>
          plan.kind === "generated-password" ||
          plan.kind === "generated-token" ||
          plan.kind === "generated-keyring",
      )
      .map((plan) => plan.key)
      .sort();

    expect([...generated.keys()].sort()).toEqual(expected);
  });

  it("generates the proxy token only when the proxy is enabled", () => {
    const disabled = generateDeploymentSecrets(countingBytes());
    const enabled = generateDeploymentSecrets(countingBytes(), { credentialProxy: true });

    expect(disabled.has("PORKBOT_PROXY_TOKEN_SECRET")).toBe(false);
    expect(enabled.get("PORKBOT_PROXY_TOKEN_SECRET")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("produces URL-safe, long-enough secrets of the declared shapes", () => {
    const generated = generateDeploymentSecrets();

    expect(generated.get("PORKBOT_POSTGRES_PASSWORD")).toMatch(/^[a-f0-9]{48}$/);
    expect(generated.get("PORKBOT_API_DB_PASSWORD")).toMatch(/^[a-f0-9]{48}$/);
    expect(generated.get("PORKBOT_AUTH_SECRET")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const keyring = generated.get("PORKBOT_CREDENTIAL_KEYS") ?? "";
    const [id, key] = keyring.split(":");

    expect(id).toBe("k1");
    expect(Buffer.from(key ?? "", "base64")).toHaveLength(32);
  });

  it("does not repeat itself between runs", () => {
    const first = generateDeploymentSecrets();
    const second = generateDeploymentSecrets();

    for (const [key, value] of first) {
      expect(second.get(key), `${key} repeated`).not.toBe(value);
    }
  });
});

describe("rendering the deployment env file", () => {
  it("renders the committed template into a valid env file", () => {
    const rendered = renderedEnv();
    const values = parseEnvFile(rendered);

    expect(validateDeploymentEnv(values)).toEqual([]);
    expect(values.get("PORKBOT_AUTH_ORIGIN")).toBe(testOrigin);
    expect(values.get("PORKBOT_WEB_ORIGIN")).toBe(testOrigin);
    expect(values.get("PORKBOT_MCP_CALLBACK_URL")).toBe(`${testOrigin}/oauth/mcp/callback`);
    expect(values.get("PORKBOT_IMAGE_TAG")).toBe("testsha012345");
    expect(values.get("PORKBOT_CREDENTIAL_ACTIVE_KEY")).toBe("k1");
  });

  it("keeps the template's comments in the rendered file", () => {
    const rendered = renderedEnv();

    expect(rendered).toContain("# PorkBot's single deployment environment file");
    expect(rendered).not.toContain(generatedSecretSentinel);
  });

  it("refuses a key whose template value is not its sentinel", () => {
    expect(() =>
      renderDeploymentEnv({
        template: "PORKBOT_AUTH_ORIGIN=@wrong\n",
        plans: deploymentValuePlans,
        generated: new Map(),
        setup: new Map([["PORKBOT_AUTH_ORIGIN", testOrigin]]),
      }),
    ).toThrow(/PORKBOT_AUTH_ORIGIN must carry the sentinel @origin/);
  });

  it("refuses a plan the template does not declare", () => {
    expect(() =>
      renderDeploymentEnv({
        template: "PORKBOT_IMAGE_TAG=@image-tag\n",
        plans: deploymentValuePlans,
        generated: new Map(),
        setup: new Map([["PORKBOT_IMAGE_TAG", "testsha"]]),
      }),
    ).toThrow(/does not declare/);
  });

  it("refuses a value that would break the line it is written to", () => {
    expect(() =>
      renderDeploymentEnv({
        template: "PORKBOT_AUTH_ORIGIN=@origin\n",
        plans: deploymentValuePlans.filter((plan) => plan.key === "PORKBOT_AUTH_ORIGIN"),
        generated: new Map(),
        setup: new Map([["PORKBOT_AUTH_ORIGIN", "https://ok.example.com\nPORKBOT_MAIL_KEY=oops"]]),
      }),
    ).toThrow(/not a single trimmed environment value/);
  });
});

describe("validating the deployment env file", () => {
  const baseline = (): Map<string, string> => parseEnvFile(renderedEnv());

  const problemsFor = (change: (values: Map<string, string>) => void): string[] => {
    const values = baseline();
    change(values);

    return validateDeploymentEnv(values).map((problem) => `${problem.key}: ${problem.message}`);
  };

  it("accepts the rendered baseline", () => {
    expect(validateDeploymentEnv(baseline())).toEqual([]);
  });

  it("refuses a missing required value", () => {
    const problems = problemsFor((values) => values.delete("PORKBOT_SUPERVISOR_TOKEN"));

    expect(problems.join("\n")).toMatch(/PORKBOT_SUPERVISOR_TOKEN: is required/);
  });

  it("refuses an unresolved sentinel", () => {
    const problems = problemsFor((values) => values.set("PORKBOT_AUTH_ORIGIN", "@origin"));

    expect(problems.join("\n")).toMatch(/PORKBOT_AUTH_ORIGIN: still carries the template sentinel/);
  });

  it("refuses the local stack's placeholders", () => {
    const problems = problemsFor((values) =>
      values.set("PORKBOT_API_DB_PASSWORD", "porkbot-api-local"),
    );

    expect(problems.join("\n")).toMatch(/PORKBOT_API_DB_PASSWORD: is the placeholder/);
  });

  it("refuses a short secret", () => {
    const problems = problemsFor((values) => values.set("PORKBOT_AUTH_SECRET", "short"));

    expect(problems.join("\n")).toMatch(/PORKBOT_AUTH_SECRET: is shorter than 24 characters/);
  });

  it("refuses a password that is not URL-safe", () => {
    const problems = problemsFor((values) =>
      values.set("PORKBOT_POSTGRES_PASSWORD", "a+b/c=d".repeat(4)),
    );

    expect(problems.join("\n")).toMatch(/PORKBOT_POSTGRES_PASSWORD: must be URL-safe/);
  });

  it("refuses a secret reused across roles", () => {
    const duplicated = baseline();
    duplicated.set("PORKBOT_SCREEN_TOKEN_SECRET", duplicated.get("PORKBOT_SUPERVISOR_TOKEN") ?? "");

    const problems = validateDeploymentEnv(duplicated);

    expect(problems.map((problem) => problem.key)).toContain("PORKBOT_SCREEN_TOKEN_SECRET");
    expect(problems.map((problem) => problem.message).join("\n")).toMatch(
      /reuses the value of PORKBOT_SUPERVISOR_TOKEN/,
    );
  });

  it("refuses a keyring key that is not 32 bytes", () => {
    const problems = problemsFor((values) => values.set("PORKBOT_CREDENTIAL_KEYS", "k1:c2hvcnQ="));

    expect(problems.join("\n")).toMatch(
      /PORKBOT_CREDENTIAL_KEYS: key "k1" must be a base64 32-byte key/,
    );
  });

  it("refuses an active key that is not in the keyring", () => {
    const problems = problemsFor((values) => values.set("PORKBOT_CREDENTIAL_ACTIVE_KEY", "k9"));

    expect(problems.join("\n")).toMatch(/PORKBOT_CREDENTIAL_ACTIVE_KEY: "k9" does not name a key/);
  });

  it("refuses plain http outside loopback and origins with a path", () => {
    const plain = problemsFor((values) =>
      values.set("PORKBOT_AUTH_ORIGIN", "http://bots.example.com"),
    );

    expect(plain.join("\n")).toMatch(/PORKBOT_AUTH_ORIGIN: must be https outside loopback/);

    const pathed = problemsFor((values) =>
      values.set("PORKBOT_WEB_ORIGIN", "https://bots.example.com/app"),
    );

    expect(pathed.join("\n")).toMatch(/PORKBOT_WEB_ORIGIN: must be an origin with no path/);
  });

  it("refuses an image tag of latest", () => {
    const problems = problemsFor((values) => values.set("PORKBOT_IMAGE_TAG", "latest"));

    expect(problems.join("\n")).toMatch(/PORKBOT_IMAGE_TAG: must not be `latest`/);
  });

  it("refuses a real provider without the settings it boots from", () => {
    const dockerWithoutImage = problemsFor((values) =>
      values.set("PORKBOT_COMPUTER_PROVIDER", "docker"),
    );

    expect(dockerWithoutImage.join("\n")).toMatch(
      /PORKBOT_COMPUTER_IMAGE: is required by the docker provider/,
    );

    const daytonaWithoutConnection = problemsFor((values) => {
      values.set("PORKBOT_COMPUTER_PROVIDER", "daytona");
      values.set("PORKBOT_COMPUTER_IMAGE", "example.invalid/computer:1");
    });

    expect(daytonaWithoutConnection.join("\n")).toMatch(/PORKBOT_COMPUTER_ENDPOINT: is required/);
    expect(daytonaWithoutConnection.join("\n")).toMatch(/PORKBOT_COMPUTER_TOKEN: is required/);
  });

  it("refuses a partial mail, proxy or webhook configuration", () => {
    const mail = problemsFor((values) => values.set("PORKBOT_MAIL_FROM", "porkbot@example.com"));

    expect(mail.join("\n")).toMatch(/PORKBOT_MAIL_ENDPOINT: must be set together/);

    const proxy = problemsFor((values) =>
      values.set("PORKBOT_COMPUTER_PROXY_IMAGE", "example.invalid/proxy:1"),
    );

    expect(proxy.join("\n")).toMatch(/PORKBOT_COMPUTER_EGRESS_NETWORK: must be set together/);

    const webhook = problemsFor((values) =>
      values.set("PORKBOT_NOTIFICATION_WEBHOOK_URL", "https://hooks.example.com/run"),
    );

    expect(webhook.join("\n")).toMatch(/PORKBOT_NOTIFICATION_WEBHOOK_KEY: is required/);
  });

  it("refuses a port outside the range and an unknown log level", () => {
    const port = problemsFor((values) => values.set("PORKBOT_API_PORT", "70000"));

    expect(port.join("\n")).toMatch(/PORKBOT_API_PORT: must be between 1 and 65535/);

    const level = problemsFor((values) => values.set("LOG_LEVEL", "verbose"));

    expect(level.join("\n")).toMatch(/LOG_LEVEL: must be one of/);
  });

  it("accepts a complete optional configuration", () => {
    const values = baseline();
    values.set("PORKBOT_MAIL_ENDPOINT", "https://mail.example.com/send");
    values.set("PORKBOT_MAIL_FROM", "porkbot@example.com");
    values.set("PORKBOT_MAIL_KEY", "provider-issued-key");
    values.set("PORKBOT_NOTIFICATION_WEBHOOK_URL", "https://hooks.example.com/run");
    values.set("PORKBOT_NOTIFICATION_WEBHOOK_KEY", "provider-issued-key-2");
    values.set("PORKBOT_COMPUTER_PROVIDER", "docker");
    values.set("PORKBOT_COMPUTER_IMAGE", "registry.example.com/computer:1.0");
    values.set("PORKBOT_COMPUTER_PROXY_IMAGE", "registry.example.com/proxy:1.0");
    values.set("PORKBOT_COMPUTER_EGRESS_NETWORK", "porkbot-egress");
    values.set("PORKBOT_PROXY_TOKEN_SECRET", "a".repeat(43));

    expect(validateDeploymentEnv(values)).toEqual([]);
  });
});

describe("the deployment commands", () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  interface RecordedCall {
    readonly command: string;
    readonly args: readonly string[];
    readonly options: SpawnOptions | undefined;
  }

  function workspace(): { readonly root: string; readonly envFile: string } {
    const root = mkdtempSync(path.join(os.tmpdir(), "porkbot-deploy-test-"));
    temporaryDirectories.push(root);
    mkdirSync(path.join(root, "deploy"), { recursive: true });
    copyFileSync(
      path.join(deployDirectory, "porkbot.env.example"),
      path.join(root, "deploy", "porkbot.env.example"),
    );
    copyFileSync(
      path.join(deployDirectory, "compose.yaml"),
      path.join(root, "deploy", "compose.yaml"),
    );

    return { root, envFile: path.join(root, "deploy", ".env") };
  }

  function contextFor(
    root: string,
    options: {
      readonly results?: (
        command: string,
        args: readonly string[],
      ) => Partial<SpawnResult> | undefined;
      readonly randomBytes?: (size: number) => Buffer;
    } = {},
  ): {
    readonly context: DeploymentContext;
    readonly calls: RecordedCall[];
    readonly out: string[];
    readonly err: string[];
  } {
    const calls: RecordedCall[] = [];
    const out: string[] = [];
    const err: string[] = [];

    const context: DeploymentContext = {
      repoRoot: root,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: {},
      spawn: (command, args, spawnOptions) => {
        calls.push({ command, args, options: spawnOptions });

        return {
          status: 0,
          stdout: "",
          stderr: "",
          ...options.results?.(command, args),
        };
      },
      randomBytes: options.randomBytes ?? countingBytes(),
      imageTag: () => "testsha012345",
    };

    return { context, calls, out, err };
  }

  it("setup writes a validated env file with mode 0600 and never prints a secret", () => {
    const { root, envFile } = workspace();
    const { context, out, err } = contextFor(root);

    const exit = runDeploy(["setup", "--origin", testOrigin], context);

    expect(exit).toBe(0);
    expect(err).toEqual([]);
    expect(existsSync(envFile)).toBe(true);
    expect(statSync(envFile).mode & 0o777).toBe(0o600);

    const values = parseEnvFile(readFileSync(envFile, "utf8"));

    expect(validateDeploymentEnv(values)).toEqual([]);

    const printed = out.join("\n");
    const authSecret = values.get("PORKBOT_AUTH_SECRET") ?? "";
    const postgresPassword = values.get("PORKBOT_POSTGRES_PASSWORD") ?? "";

    expect(authSecret).not.toBe("");
    expect(postgresPassword).not.toBe("");
    expect(printed).toContain("Generated 7 secrets");
    expect(printed).not.toContain(authSecret);
    expect(printed).not.toContain(postgresPassword);
  });

  it("setup is idempotent: a second run keeps every generated secret", () => {
    const { root, envFile } = workspace();

    expect(runDeploy(["setup", "--origin", testOrigin], contextFor(root).context)).toBe(0);

    const before = parseEnvFile(readFileSync(envFile, "utf8"));
    const { context, out } = contextFor(root);

    // No --origin on the re-run: the existing file supplies it.
    expect(runDeploy(["setup"], context)).toBe(0);
    expect(out.join("\n")).toMatch(/Kept every existing secret/);

    const after = parseEnvFile(readFileSync(envFile, "utf8"));

    expect([...after]).toEqual([...before]);
  });

  it("setup --force rotates the generated secrets and keeps the operator settings", () => {
    const { root, envFile } = workspace();

    expect(runDeploy(["setup", "--origin", testOrigin], contextFor(root).context)).toBe(0);

    const before = parseEnvFile(readFileSync(envFile, "utf8"));
    const { context, err } = contextFor(root, { randomBytes: (size) => randomBytes(size) });

    expect(runDeploy(["setup", "--force"], context)).toBe(0);

    const after = parseEnvFile(readFileSync(envFile, "utf8"));

    expect(after.get("PORKBOT_AUTH_ORIGIN")).toBe(testOrigin);
    expect(after.get("PORKBOT_AUTH_SECRET")).not.toBe(before.get("PORKBOT_AUTH_SECRET"));
    expect(after.get("PORKBOT_POSTGRES_PASSWORD")).not.toBe(
      before.get("PORKBOT_POSTGRES_PASSWORD"),
    );
    expect(err.join("\n")).toMatch(/keeps its superuser password from first init/);
  });

  it("setup enables the credential proxy as a pair and generates its token", () => {
    const { root, envFile } = workspace();
    const { context } = contextFor(root);

    expect(
      runDeploy(
        [
          "setup",
          "--origin",
          testOrigin,
          "--proxy-image",
          "registry.example.com/proxy:1.0",
          "--egress-network",
          "porkbot-egress",
        ],
        context,
      ),
    ).toBe(0);

    const values = parseEnvFile(readFileSync(envFile, "utf8"));

    expect(validateDeploymentEnv(values)).toEqual([]);
    expect(values.get("PORKBOT_COMPUTER_PROXY_IMAGE")).toBe("registry.example.com/proxy:1.0");
    expect(values.get("PORKBOT_COMPUTER_EGRESS_NETWORK")).toBe("porkbot-egress");
    expect(values.get("PORKBOT_PROXY_TOKEN_SECRET")?.length ?? 0).toBeGreaterThanOrEqual(24);
  });

  it("setup refuses half a credential proxy", () => {
    const { root, envFile } = workspace();
    const { context, err } = contextFor(root);

    expect(
      runDeploy(
        ["setup", "--origin", testOrigin, "--proxy-image", "registry.example.com/p:1"],
        context,
      ),
    ).toBe(2);
    expect(existsSync(envFile)).toBe(false);
    expect(err.join("\n")).toMatch(/needs both --proxy-image and --egress-network/);
  });

  it("setup without an origin writes nothing", () => {
    const { root, envFile } = workspace();
    const { context, err } = contextFor(root);

    expect(runDeploy(["setup"], context)).toBe(2);
    expect(existsSync(envFile)).toBe(false);
    expect(err.join("\n")).toMatch(/needs the deployment's public origin/);
  });

  it("setup refuses an origin that could not serve the public deployment", () => {
    const { root, envFile } = workspace();
    const { context, err } = contextFor(root);

    expect(runDeploy(["setup", "--origin", "http://bots.example.com"], context)).toBe(1);
    expect(existsSync(envFile)).toBe(false);
    expect(err.join("\n")).toMatch(/must be https outside loopback/);
  });

  it("up renders a missing env file, validates, and waits on every healthcheck", () => {
    const { root } = workspace();
    const { context, calls } = contextFor(root);

    expect(runDeploy(["up", "--origin", testOrigin], context)).toBe(0);

    const composeCalls = calls.filter((call) => call.command === "docker");

    expect(composeCalls.length).toBeGreaterThan(0);

    const buildIndex = composeCalls.findIndex((call) => call.args.includes("build"));
    const upIndex = composeCalls.findIndex((call) => call.args.includes("up"));
    const up = composeCalls[upIndex];

    // The build is its own command so the wait budget covers the services,
    // not the first compile.
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeLessThan(upIndex);
    expect(up?.args).toEqual(
      expect.arrayContaining(["--wait", "--wait-timeout", "300", "--env-file"]),
    );
    expect(up?.args).not.toContain("--build");
    expect(calls.some((call) => call.args.includes("--file"))).toBe(true);
  });

  it("up refuses to start on an invalid env file without touching Docker", () => {
    const { root, envFile } = workspace();
    const first = contextFor(root);

    expect(runDeploy(["setup", "--origin", testOrigin], first.context)).toBe(0);

    const values = parseEnvFile(readFileSync(envFile, "utf8"));
    values.set("PORKBOT_AUTH_SECRET", "porkbot-local");

    writeFileSync(envFile, [...values].map(([key, value]) => `${key}=${value}`).join("\n"), {
      mode: 0o600,
    });

    const { context, err, calls } = contextFor(root);

    expect(runDeploy(["up"], context)).toBe(1);
    expect(err.join("\n")).toMatch(/PORKBOT_AUTH_SECRET: is the placeholder/);
    expect(calls).toEqual([]);
  });

  it("status works even when the env file is gone, and prints what Compose reports", () => {
    const { root } = workspace();
    const { context, calls, out } = contextFor(root, {
      results: (_command, args) =>
        args.includes("ps") ? { stdout: "api  Up 1 minute (healthy)\n" } : undefined,
    });

    expect(runDeploy(["status"], context)).toBe(0);

    const ps = calls.find((call) => call.args.includes("ps"));

    expect(ps?.args).toEqual(expect.arrayContaining(["--all"]));
    expect(ps?.options?.env?.["PORKBOT_AUTH_SECRET"]).toBe("management-command");
    expect(out.join("\n")).toContain("api  Up 1 minute (healthy)");
  });

  it("down warns before it deletes the volumes", () => {
    const { root } = workspace();
    const { context, calls, err } = contextFor(root);

    expect(runDeploy(["down", "--volumes"], context)).toBe(0);
    expect(err.join("\n")).toMatch(/will be deleted/);
    expect(calls.find((call) => call.args.includes("down"))?.args).toContain("--volumes");
  });

  it("rejects an unknown command with usage", () => {
    const { root } = workspace();
    const { context, err } = contextFor(root);

    expect(runDeploy(["obliterate"], context)).toBe(2);
    expect(err.join("\n")).toMatch(/Unknown command/);
  });
});
