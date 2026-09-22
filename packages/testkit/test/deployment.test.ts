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
import { caddyImage } from "../src/harness/images.ts";
import { caddyProbePort, spaRootPath } from "../src/proxy/caddy.ts";
import { parseCgroupProbe } from "../src/deployment/measure.ts";
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
const caddyfileText = readFileSync(path.join(deployDirectory, "Caddyfile"), "utf8");
const dockerfileText = readFileSync(path.join(repoRoot, "Dockerfile"), "utf8");

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

    // The single-host record: 4 vCPU / 8 GB is the base host. The floor has
    // two terms that scale differently — the memory term with the bots active
    // at once (a parked machine's memory is back with the host inside the park
    // window) and the disk term with every configured bot (a home volume
    // survives a park). This checks the stack's ceilings plus one bot at the
    // declared memory share against the host's RAM, and that the declared
    // swap bound is independent of that share and smaller than it.
    const perBotMemoryMb = Number(
      /^PORKBOT_COMPUTER_MEMORY_MB=(\d+)$/m.exec(templateText)?.[1] ?? "0",
    );
    const perBotSwapMb = Number(
      /^PORKBOT_COMPUTER_SWAP_MB=(\d+)$/m.exec(templateText)?.[1] ?? "-1",
    );

    expect(perBotMemoryMb).toBeGreaterThan(0);
    expect(perBotSwapMb).toBeGreaterThanOrEqual(0);
    expect(perBotSwapMb).toBeLessThan(perBotMemoryMb);
    expect(totalCpus + 1).toBeLessThanOrEqual(4);
    expect(totalMemoryBytes + perBotMemoryMb * memoryThresholds.m).toBeLessThanOrEqual(
      8 * memoryThresholds.g,
    );
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

/**
 * The proxy contract, asserted from the shipped config (slice 12.2). The
 * integration suite in apps/api proves the behaviour against the real image;
 * these tests fail first, and by name, when an edit drops a directive that is
 * the reason the file exists.
 */
describe("the reverse proxy config", () => {
  const apiRoute = /@api path[\s\S]*?\n\t\}/.exec(caddyfileText)?.[0] ?? "";

  it("serves one origin, with the API mounts routed before the SPA", () => {
    expect(caddyfileText).toMatch(/^\{\$PORKBOT_SITE_ADDRESS:/m);

    for (const mount of [
      "/healthz",
      "/healthz/*",
      "/livez",
      "/readyz",
      "/rpc/*",
      "/api/*",
      "/files/*",
      "/oauth/*",
      "/webhooks/*",
      "/threads/*/attachments",
    ]) {
      expect(apiRoute, `${mount} must route to the API`).toContain(mount);
    }

    expect(apiRoute).toContain("reverse_proxy {$PORKBOT_API_UPSTREAM:api:3001}");
    // The SPA is the fallback, not a mount of its own — and it is a file
    // server under the baked root, not a second process to proxy to.
    expect(caddyfileText).toContain(`root * ${spaRootPath}`);
    expect(caddyfileText).toContain("file_server");
    expect(caddyfileText).not.toContain("PORKBOT_WEB_UPSTREAM");
    expect(caddyfileText).not.toContain("web:3000");
  });

  it("keeps the deep-link fallback and a missing asset apart", () => {
    // The rewrite `src/host.ts` implemented now lives in the shipped config:
    // an extension-less path is a client route and gets the shell, and a
    // missing file with an extension is answered 404 rather than with a blank
    // page and a 200. The behaviours are exercised against the real image in
    // apps/api's reverse-proxy integration suite.
    expect(caddyfileText).toContain("not path_regexp");
    expect(caddyfileText).toContain("rewrite /_shell.html");
    expect(caddyfileText).toContain("respond 404");
  });

  it("caches a hashed asset forever and the document never", () => {
    // The document is the release — a cached shell pins stale asset URLs —
    // while a hashed asset is content-addressed and safe to keep forever.
    expect(caddyfileText).toContain('header Cache-Control "public, max-age=31536000, immutable"');
    expect(caddyfileText).toContain('header Cache-Control "no-cache"');
  });

  it("disables response buffering on the API route", () => {
    // `-1` is Caddy's low-latency mode; without it a small stream sits in the
    // response buffer until something fills or closes it, which for a token
    // stream is never.
    expect(apiRoute).toMatch(/flush_interval -1/);
    // A positive flush interval or an explicit response buffer would undo it,
    // and `encode` brings its own buffer to the same listener.
    expect(caddyfileText).not.toMatch(/flush_interval\s+[0-9]/);
    expect(caddyfileText).not.toMatch(/response_buffers/);
    expect(caddyfileText).not.toMatch(/^\s*encode\b/m);
  });

  it("caps client reads and idle connections but not the response", () => {
    const timeouts = /\n\tservers \{[\s\S]*?\n\t\}/.exec(caddyfileText)?.[0] ?? "";

    expect(timeouts).toContain("read_header 10s");
    expect(timeouts).toContain("read_body 5m");
    expect(timeouts).toContain("idle 5m");
    // A server-level `write` timeout bounds a whole response; a token stream
    // is expected to stay open, so the cap is deliberately absent.
    expect(timeouts).not.toMatch(/write\s/);
    // The API's response headers are awaited under a bound; its frames are
    // not, because they are the stream.
    expect(apiRoute).toContain("dial_timeout 5s");
    expect(apiRoute).toContain("response_header_timeout 30s");
  });

  it("leaves every request header, and so Last-Event-ID, to the API", () => {
    // No header operation on the API route means Caddy passes request headers
    // through untouched; a `header_up -Last-Event-ID` or a rewritten cookie
    // would resume the wrong stream or drop the session. The only header rules
    // in the file are the SPA's response cache directives — any other one has
    // to be a deliberate, reviewed edit to this test.
    expect(apiRoute).not.toMatch(/^\s*header/m);
    expect(caddyfileText).not.toMatch(/^\s*header(?:_up|_down)\s/m);
  });

  it("answers the container healthcheck on a loopback listener", () => {
    const probe =
      new RegExp(`http://127\\.0\\.0\\.1:${String(caddyProbePort)} \\{[\\s\\S]*?\\n\\}`).exec(
        caddyfileText,
      )?.[0] ?? "";

    expect(probe).toContain("handle /healthz");
    expect(probe).toContain("reverse_proxy {$PORKBOT_API_UPSTREAM:api:3001}");
  });

  it("ships the built SPA in a proxy image from the register's Caddy pin", () => {
    // The proxy is now a built release image like the api: it carries the SPA
    // the release ships, so an upgrade switches both. Its base is the same
    // pinned Caddy the harness boots, and the baked root is the path the
    // Caddyfile serves and the tests mount over.
    expect(dockerfileText).toContain(`FROM ${caddyImage} AS proxy`);
    expect(dockerfileText).toContain(`COPY --from=build /repo/apps/web/dist/client ${spaRootPath}`);
    expect(caddyfileText).toContain(`root * ${spaRootPath}`);

    for (const composeText of [deployComposeText, localComposeText]) {
      const block = composeServiceBlock(composeText, "proxy") ?? "";

      expect(block).toContain("target: proxy");
      expect(block).toMatch(/image: porkbot\/proxy:/);
    }

    expect(caddyImage).not.toContain(":latest");
    expect(caddyImage).toMatch(/@sha256:[a-f0-9]{64}$/);
  });

  it("keeps no web service: the SPA is the proxy's own files", () => {
    for (const composeText of [deployComposeText, localComposeText]) {
      expect(composeServices(composeText)).not.toContain("web");
    }

    expect(dockerfileText).not.toMatch(/^FROM\s+\S+\s+AS\s+web$/m);
    expect(deployComposeText).not.toContain("PORKBOT_WEB_PORT");
  });

  it("publishes the public ports only on the proxy", () => {
    const proxy = composeServiceBlock(deployComposeText, "proxy") ?? "";

    expect(proxy).toContain(":80:80");
    expect(proxy).toContain(":443:443");
    expect(proxy).toContain(`http://127.0.0.1:${String(caddyProbePort)}/healthz`);

    for (const service of ["api"]) {
      const block = composeServiceBlock(deployComposeText, service) ?? "";

      expect(block, `${service} must not be published beyond loopback`).toMatch(
        /- "127\.0\.0\.1:\$\{PORKBOT_[A-Z_]+_PORT/,
      );
    }
  });
});

describe("deployment measurement parsing", () => {
  it("reads cgroup v2 memory and CPU counters", () => {
    expect(
      parseCgroupProbe(
        [
          "cgroup=cgroup-v2",
          "memory_current_bytes=1234",
          "memory_peak_bytes=5678",
          "cpu_usage_usec=9012",
        ].join("\n"),
      ),
    ).toEqual({
      source: "cgroup-v2",
      memoryCurrentBytes: 1234,
      memoryPeakBytes: 5678,
      cpuUsageUsec: 9012,
    });
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

  it("refuses an origin on a port the proxy does not publish", () => {
    const publicHost = problemsFor((values) =>
      values.set("PORKBOT_AUTH_ORIGIN", "https://bots.example.com:8443"),
    );

    expect(publicHost.join("\n")).toMatch(
      /PORKBOT_AUTH_ORIGIN: must not name port 8443; the reverse proxy publishes 80 and 443/,
    );

    // Loopback is where an http origin is allowed, and the proxy still owns
    // the port there: it binds what the site address names and publishes 80
    // and 443, so `http://localhost:8080` would be unreachable outside the
    // proxy container.
    const loopback = problemsFor((values) =>
      values.set("PORKBOT_AUTH_ORIGIN", "http://localhost:8080"),
    );

    expect(loopback.join("\n")).toMatch(
      /PORKBOT_AUTH_ORIGIN: must not name port 8080; the reverse proxy publishes 80 and 443/,
    );
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

    const socketGid = problemsFor((values) => values.set("PORKBOT_DOCKER_SOCKET_GID", "not-a-gid"));

    expect(socketGid.join("\n")).toMatch(/PORKBOT_DOCKER_SOCKET_GID: must be a numeric group id/);
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

  it("refuses an unknown disk-quota mode or a negative snapshot retention", () => {
    const quota = problemsFor((values) => values.set("PORKBOT_COMPUTER_DISK_QUOTA", "unlimited"));

    expect(quota.join("\n")).toMatch(/PORKBOT_COMPUTER_DISK_QUOTA: must be one of auto, none/);

    const retention = problemsFor((values) => values.set("PORKBOT_COMPUTER_SNAPSHOT_KEEP", "-1"));

    expect(retention.join("\n")).toMatch(/PORKBOT_COMPUTER_SNAPSHOT_KEEP/);

    // Zero is a valid choice: it keeps every capture.
    expect(
      validateDeploymentEnv(
        (() => {
          const values = baseline();
          values.set("PORKBOT_COMPUTER_SNAPSHOT_KEEP", "0");
          return values;
        })(),
      ),
    ).toEqual([]);
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
    expect(printed).toContain("Generated 9 secrets");
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

  it("setup persists the optional machine image for a measured provider run", () => {
    const { root, envFile } = workspace();
    const image = "node:24.21.0-bookworm-slim@sha256:" + "a".repeat(64);

    expect(
      runDeploy(
        ["setup", "--origin", testOrigin, "--computer-image", image],
        contextFor(root).context,
      ),
    ).toBe(0);

    expect(parseEnvFile(readFileSync(envFile, "utf8")).get("PORKBOT_COMPUTER_IMAGE")).toBe(image);
  });

  it("check reports the disk budget's enforcement from the daemon's storage driver", () => {
    const { root, envFile } = workspace();

    expect(
      runDeploy(
        ["setup", "--origin", testOrigin, "--computer-image", "registry.example.com/computer:1.0"],
        contextFor(root).context,
      ),
    ).toBe(0);
    // Select the Docker provider so the disk verdict is in scope, then leave
    // every other setting the template rendered.
    writeFileSync(
      envFile,
      readFileSync(envFile, "utf8").replace(
        "PORKBOT_COMPUTER_PROVIDER=offline",
        "PORKBOT_COMPUTER_PROVIDER=docker",
      ),
    );

    const capable = contextFor(root, {
      results: (command, args) =>
        command === "docker" && args.includes("info")
          ? { stdout: 'overlay2\t[["Backing Filesystem","xfs"]]\n' }
          : undefined,
    });

    expect(runDeploy(["check"], capable.context)).toBe(0);
    expect(capable.out.join("\n")).toMatch(/disk budget: .*is enforced by "overlay2"/);

    const incapable = contextFor(root, {
      results: (command, args) =>
        command === "docker" && args.includes("info")
          ? { stdout: 'overlay2\t[["Backing Filesystem","ext4"]]\n' }
          : undefined,
    });

    expect(runDeploy(["check"], incapable.context)).toBe(0);
    expect(incapable.err.join("\n")).toMatch(/disk budget: .*not enforced/);

    const unreachable = contextFor(root, {
      results: (command, args) =>
        command === "docker" && args.includes("info") ? { status: 1 } : undefined,
    });

    expect(runDeploy(["check"], unreachable.context)).toBe(0);
    expect(unreachable.out.join("\n")).toMatch(/could not be reached/);
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

  it("measure runs every workload phase and writes a table plus raw report", () => {
    const { root, envFile } = workspace();
    const setup = contextFor(root);

    expect(runDeploy(["setup", "--origin", testOrigin], setup.context)).toBe(0);

    const values = parseEnvFile(readFileSync(envFile, "utf8"));
    values.set("PORKBOT_COMPUTER_IMAGE", "node:24.21.0-bookworm-slim");
    writeFileSync(envFile, [...values].map(([key, value]) => `${key}=${value}`).join("\n"), {
      mode: 0o600,
    });

    const tablePath = path.join(root, "floor.md");
    const rawPath = path.join(root, "measurement.json");
    const { context, calls, out } = contextFor(root, {
      results: (_command, args) =>
        args.includes("--force-drill") ? { stdout: '{"drillStatus":"succeeded"}' } : undefined,
    });

    expect(
      runDeploy(
        [
          "measure",
          "--idle-seconds",
          "0",
          "--sample-interval-seconds",
          "1",
          "--table-path",
          tablePath,
          "--raw-path",
          rawPath,
        ],
        context,
      ),
    ).toBe(0);

    expect(existsSync(tablePath)).toBe(true);
    expect(existsSync(rawPath)).toBe(true);
    expect(readFileSync(tablePath, "utf8")).toContain("Measured deployment floor");

    const report = JSON.parse(readFileSync(rawPath, "utf8")) as {
      schemaVersion: number;
      botCount: number;
      providers: readonly { kind: string; bots: number }[];
      workload: {
        phases: readonly { id: string; completed: boolean }[];
      };
    };

    expect(report.schemaVersion).toBe(1);
    expect(report.botCount).toBe(1);
    expect(report.providers.map((provider) => provider.kind)).toEqual(["offline", "docker"]);
    expect(report.workload.phases.every((phase) => phase.completed)).toBe(true);
    expect(calls.some((call) => call.args.includes("--no-build"))).toBe(true);
    expect(calls.some((call) => call.args.includes("migrate"))).toBe(true);
    expect(calls.some((call) => call.args.includes("backup"))).toBe(true);
    expect(calls.some((call) => call.args.includes("--force-drill"))).toBe(true);
    expect(calls.some((call) => call.args.includes("supervisor"))).toBe(true);
    expect(out.join("\n")).toContain("Wrote measured floor table");
  });

  it("upgrade pulls, health-checks before migrating, then switches and records the prior tag", () => {
    const { root, envFile } = workspace();
    const initial = contextFor(root);

    expect(runDeploy(["up", "--origin", testOrigin], initial.context)).toBe(0);

    const upgrade = contextFor(root, {
      results: (_command, args) => (args.includes("inspect") ? { stdout: "healthy\n" } : undefined),
    });

    expect(runDeploy(["upgrade", "--tag", "nextsha012345"], upgrade.context)).toBe(0);

    const dockerCalls = upgrade.calls.filter((call) => call.command === "docker");
    const pullIndex = dockerCalls.findIndex((call) => call.args.includes("pull"));
    const migrationIndex = dockerCalls.findIndex(
      (call) => call.args.includes("run") && call.args.includes("migrate"),
    );
    const switchIndex = dockerCalls.findIndex((call) => call.args.includes("up"));
    const healthIndexes = dockerCalls
      .map((call, index) => (call.args.includes("inspect") ? index : -1))
      .filter((index) => index >= 0);

    expect(pullIndex).toBeGreaterThanOrEqual(0);
    expect(healthIndexes.length).toBe(10);
    expect(pullIndex).toBeLessThan(healthIndexes[0] ?? Number.POSITIVE_INFINITY);
    expect(healthIndexes[4] ?? -1).toBeLessThan(migrationIndex);
    expect(migrationIndex).toBeLessThan(healthIndexes[5] ?? Number.POSITIVE_INFINITY);
    expect(healthIndexes[9] ?? -1).toBeLessThan(switchIndex);
    expect(dockerCalls[pullIndex]?.options?.env?.["PORKBOT_IMAGE_TAG"]).toBe("nextsha012345");
    expect(dockerCalls[switchIndex]?.args).toEqual(expect.arrayContaining(["--no-deps", "api"]));
    expect(parseEnvFile(readFileSync(envFile, "utf8")).get("PORKBOT_IMAGE_TAG")).toBe(
      "nextsha012345",
    );
    expect(readFileSync(path.join(path.dirname(envFile), ".release-state"), "utf8")).toContain(
      "previous=testsha012345",
    );
  });

  it("leaves the active release alone when the target migration fails", () => {
    const { root, envFile } = workspace();
    const initial = contextFor(root);

    expect(runDeploy(["up", "--origin", testOrigin], initial.context)).toBe(0);

    const upgrade = contextFor(root, {
      results: (_command, args) => {
        if (args.includes("inspect")) {
          return { stdout: "healthy\n" };
        }

        return args.includes("run") && args.includes("migrate")
          ? { status: 1, stderr: "migration refused" }
          : undefined;
      },
    });

    expect(runDeploy(["upgrade", "--tag", "brokensha0123"], upgrade.context)).toBe(1);
    expect(parseEnvFile(readFileSync(envFile, "utf8")).get("PORKBOT_IMAGE_TAG")).toBe(
      "testsha012345",
    );
    expect(upgrade.calls.some((call) => call.args.includes("up"))).toBe(false);
    expect(upgrade.err.join("\n")).toMatch(/active release testsha012345 remains running/);
  });

  it("rolls back the recorded tag without running migrations and states the schema limit", () => {
    const { root, envFile } = workspace();
    const initial = contextFor(root);

    expect(runDeploy(["up", "--origin", testOrigin], initial.context)).toBe(0);

    const upgrade = contextFor(root, {
      results: (_command, args) => (args.includes("inspect") ? { stdout: "healthy\n" } : undefined),
    });
    expect(runDeploy(["upgrade", "--tag", "nextsha012345"], upgrade.context)).toBe(0);

    const rollback = contextFor(root);

    expect(runDeploy(["rollback"], rollback.context)).toBe(0);
    expect(rollback.out.join("\n")).toContain("does not reverse migrations");
    expect(
      rollback.calls.some((call) => call.args.includes("run") && call.args.includes("migrate")),
    ).toBe(false);
    expect(parseEnvFile(readFileSync(envFile, "utf8")).get("PORKBOT_IMAGE_TAG")).toBe(
      "testsha012345",
    );
    expect(readFileSync(path.join(path.dirname(envFile), ".release-state"), "utf8")).toContain(
      "previous=nextsha012345",
    );
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
