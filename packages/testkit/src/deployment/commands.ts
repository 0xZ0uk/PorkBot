import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deploymentEnvHeader, parseEnvFile, renderDeploymentEnv } from "./env-file.ts";
import { deploymentValuePlans, generateDeploymentSecrets } from "./secrets.ts";
import { requiredDeploymentKeys, validateDeploymentEnv } from "./validate.ts";
import type { DeploymentProblem } from "./validate.ts";

/**
 * The single-host deployment commands (slice 12.1, PRD stories 1 and 2).
 *
 * `deploy:setup` renders deploy/.env from the committed template, generating
 * every secret in the register; `deploy:check` validates the file without
 * touching Docker; `deploy:up` does the setup when the file is absent,
 * validates it, then runs the production compose file and waits for every
 * healthcheck, reporting readiness per service. `status`, `logs`, `down` and
 * `exec` wrap the matching compose commands.
 *
 * Everything that runs a process goes through `context.spawn`, so a test can
 * drive the whole CLI against a temporary directory and a scripted Docker.
 */

export const deploymentDirectoryName = "deploy";
export const deploymentComposeFileName = "compose.yaml";
export const deploymentTemplateFileName = "porkbot.env.example";
export const deploymentEnvFileName = ".env";
export const defaultProjectName = "porkbot";
export const defaultWaitSeconds = "300";

export interface SpawnOptions {
  readonly cwd?: string;
  /**
   * Extra environment for the child. Compose reads interpolation from the
   * shell environment too, which is how a management command runs without the
   * deployment's real env file.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Stream to the terminal instead of capturing (builds, logs, up). */
  readonly inherit?: boolean;
}

export interface SpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface DeploymentContext {
  readonly repoRoot: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly spawn: (command: string, args: readonly string[], options?: SpawnOptions) => SpawnResult;
  /** The bytes a generated secret is made of; injectable for tests. */
  readonly randomBytes: (size: number) => Buffer;
  /** The checkout's release tag, or null when git cannot answer. */
  readonly imageTag: () => string | null;
}

interface DeployOptions {
  readonly command: string;
  readonly origin: string | undefined;
  readonly webOrigin: string | undefined;
  readonly tag: string | undefined;
  readonly proxyImage: string | undefined;
  readonly egressNetwork: string | undefined;
  readonly envFile: string | undefined;
  readonly force: boolean;
  readonly compose: boolean;
  readonly volumes: boolean;
  readonly waitSeconds: string | undefined;
  readonly positionals: readonly string[];
}

export function usageText(): string {
  return [
    "Usage: deploy <command> [options]",
    "",
    "Commands:",
    "  setup    Render deploy/.env from the template, generating every secret.",
    "  check    Validate the env file; --compose also proves Compose accepts the file.",
    "  up       Setup if needed, validate, build, start, and wait for every healthcheck.",
    "  status   Show each service's state, health and published ports.",
    "  logs     Follow the stack's logs.",
    "  down     Stop the stack; pass --volumes to delete its data too.",
    "  exec     Run a command in a running service: deploy exec postgres psql -U porkbot",
    "",
    "Options:",
    "  --origin <url>        The public origin (setup and up; required when rendering).",
    "  --web-origin <url>    The origin notification links use (defaults to --origin).",
    "  --tag <tag>          Image tag for the release (defaults to the checkout's git SHA).",
    "  --proxy-image <ref>   Enable the credential proxy with this sidecar image; needs",
    "  --egress-network <n>  ...this egress network. Both together enable the segment.",
    "  --env-path <path>     Env file to write or read (default: deploy/.env, relative to the repo).",
    "  --force               Regenerate every generated secret (setup); rotates credentials.",
    "  --compose             Also run `docker compose config` (check).",
    "  --volumes             Delete volumes too, including Postgres data (down).",
    "  --wait-timeout <s>    Health wait budget for `up` (default: PORKBOT_DEPLOY_WAIT_SECONDS or 300).",
    "  --help                This text.",
  ].join("\n");
}

function isOptionValue(argument: string): boolean {
  return argument.startsWith("--");
}

function parseDeployArguments(
  argv: readonly string[],
):
  | { readonly ok: true; readonly options: DeployOptions }
  | { readonly ok: false; readonly problem: string } {
  const positionals: string[] = [];
  let command = "";
  let origin: string | undefined;
  let webOrigin: string | undefined;
  let tag: string | undefined;
  let proxyImage: string | undefined;
  let egressNetwork: string | undefined;
  let envFile: string | undefined;
  let force = false;
  let compose = false;
  let volumes = false;
  let waitSeconds: string | undefined;

  const takeValue = (index: number, flag: string): { value: string } | { problem: string } => {
    const value = argv[index + 1];

    if (value === undefined || isOptionValue(value)) {
      return { problem: `${flag} needs a value.` };
    }

    return { value };
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";

    if (command === "exec") {
      // Everything after `exec` is the service and its command; -U and --help
      // belong to the program being exec'd, not to this CLI.
      positionals.push(argument);
      continue;
    }

    if (argument === "--force") {
      force = true;
      continue;
    }

    if (argument === "--compose") {
      compose = true;
      continue;
    }

    if (argument === "--volumes") {
      volumes = true;
      continue;
    }

    if (argument === "--help") {
      return {
        ok: true,
        options: {
          command: "help",
          origin,
          webOrigin,
          tag,
          proxyImage,
          egressNetwork,
          envFile,
          force,
          compose,
          volumes,
          waitSeconds,
          positionals,
        },
      };
    }

    const option = argument.startsWith("-") ? argument : undefined;
    // Deliberately not `--env-file`: Node consumes that flag anywhere on its
    // command line (it loads the file and exits), so it would never reach this
    // parser. Docker Compose still gets its own `--env-file` when we run it.
    const valueFlags = [
      "--origin",
      "--web-origin",
      "--tag",
      "--proxy-image",
      "--egress-network",
      "--env-path",
      "--wait-timeout",
    ];

    if (option !== undefined && valueFlags.includes(option)) {
      const taken = takeValue(index, option);

      if ("problem" in taken) {
        return { ok: false, problem: taken.problem };
      }

      index += 1;

      switch (option) {
        case "--origin":
          origin = taken.value;
          break;
        case "--web-origin":
          webOrigin = taken.value;
          break;
        case "--tag":
          tag = taken.value;
          break;
        case "--proxy-image":
          proxyImage = taken.value;
          break;
        case "--egress-network":
          egressNetwork = taken.value;
          break;
        case "--env-path":
          envFile = taken.value;
          break;
        case "--wait-timeout":
          waitSeconds = taken.value;
          break;
        default:
          break;
      }

      continue;
    }

    if (option !== undefined) {
      return { ok: false, problem: `Unknown option "${argument}".` };
    }

    if (command === "") {
      command = argument;
      continue;
    }

    positionals.push(argument);
  }

  if (command === "") {
    return { ok: false, problem: "A command is required." };
  }

  return {
    ok: true,
    options: {
      command,
      origin,
      webOrigin,
      tag,
      proxyImage,
      egressNetwork,
      envFile,
      force,
      compose,
      volumes,
      waitSeconds,
      positionals,
    },
  };
}

function defaultEnvFilePath(context: DeploymentContext): string {
  return path.join(context.repoRoot, deploymentDirectoryName, deploymentEnvFileName);
}

function resolveEnvFilePath(context: DeploymentContext, options: DeployOptions): string {
  if (options.envFile === undefined) {
    return defaultEnvFilePath(context);
  }

  return path.isAbsolute(options.envFile)
    ? options.envFile
    : path.resolve(context.repoRoot, options.envFile);
}

function displayPath(context: DeploymentContext, filePath: string): string {
  const relative = path.relative(context.repoRoot, filePath);

  return relative === "" || relative.startsWith("..") ? filePath : relative;
}

function templateFilePath(context: DeploymentContext): string {
  return path.join(context.repoRoot, deploymentDirectoryName, deploymentTemplateFileName);
}

function composeFilePath(context: DeploymentContext): string {
  return path.join(context.repoRoot, deploymentDirectoryName, deploymentComposeFileName);
}

function projectName(context: DeploymentContext): string {
  return context.env["PORKBOT_DEPLOY_PROJECT"] ?? defaultProjectName;
}

function composeArguments(
  context: DeploymentContext,
  args: readonly string[],
  options: { readonly envFile?: string } = {},
): string[] {
  const base = [
    "compose",
    "--project-name",
    projectName(context),
    "--file",
    composeFilePath(context),
  ];

  if (options.envFile !== undefined) {
    base.push("--env-file", options.envFile);
  }

  return [...base, ...args];
}

function printProblems(
  context: DeploymentContext,
  label: string,
  problems: readonly DeploymentProblem[],
): void {
  context.err(`FAIL ${label}`);
  for (const problem of problems) {
    context.err(`  ${problem.key}: ${problem.message}`);
  }
  context.err(
    `${String(problems.length)} problem(s); nothing was started. ` +
      `Fix ${label} (or re-run \`pnpm deploy:setup\`) and try again.`,
  );
}

/** Reads and validates the env file; null when it is missing or invalid. */
function loadValidEnvFile(
  context: DeploymentContext,
  envFile: string,
): ReadonlyMap<string, string> | null {
  const label = displayPath(context, envFile);

  if (!existsSync(envFile)) {
    context.err(
      `No env file at ${label}. Run \`pnpm deploy:setup --origin <url>\` (or ` +
        "`pnpm deploy:up --origin <url>`) to render one.",
    );

    return null;
  }

  const values = parseEnvFile(readFileSync(envFile, "utf8"));
  const problems = validateDeploymentEnv(values);

  if (problems.length > 0) {
    printProblems(context, label, problems);

    return null;
  }

  return values;
}

/**
 * Renders deploy/.env from the template.
 *
 * Setup is idempotent: an existing file's non-empty values are carried through
 * (secrets included), and only values that are missing, blank or unresolved
 * are generated or taken from the flags. `--force` is the one way to rotate
 * the generated secrets, and it says what that breaks. This is what lets an
 * operator enable the credential proxy on a running deployment without
 * re-keying the database.
 */
function runSetup(context: DeploymentContext, options: DeployOptions): number {
  const envFile = resolveEnvFilePath(context, options);
  const templateFile = templateFilePath(context);
  const existed = existsSync(envFile);
  const existing = existed
    ? parseEnvFile(readFileSync(envFile, "utf8"))
    : new Map<string, string>();

  if (!existsSync(templateFile)) {
    context.err(
      `The template ${displayPath(context, templateFile)} is missing; ` +
        "run this from the repository that shipped it.",
    );

    return 1;
  }

  const prior = (key: string): string => {
    const value = existing.get(key)?.trim() ?? "";

    return value.startsWith("@") ? "" : value;
  };
  const origin = options.origin?.trim() || prior("PORKBOT_AUTH_ORIGIN");

  if (origin === "") {
    context.err(
      "setup needs the deployment's public origin: " +
        "`pnpm deploy:setup --origin https://bots.example.com`.",
    );

    return 2;
  }

  const webOrigin = options.webOrigin?.trim() || prior("PORKBOT_WEB_ORIGIN") || origin;
  const imageTag = options.tag?.trim() || prior("PORKBOT_IMAGE_TAG") || context.imageTag();

  if (imageTag === undefined || imageTag === null || imageTag === "") {
    context.err(
      "Could not read the checkout's git SHA. Pass the release tag explicitly: " +
        "`pnpm deploy:setup --origin <url> --tag <tag>`.",
    );

    return 2;
  }

  const proxyImage = options.proxyImage?.trim() || prior("PORKBOT_COMPUTER_PROXY_IMAGE");
  const egressNetwork = options.egressNetwork?.trim() || prior("PORKBOT_COMPUTER_EGRESS_NETWORK");

  if ((proxyImage === "") !== (egressNetwork === "")) {
    context.err(
      "The credential proxy needs both --proxy-image and --egress-network, or neither. " +
        "A partial proxy configuration is what the supervisor refuses at boot.",
    );

    return 2;
  }

  const proxyEnabled = proxyImage !== "" && egressNetwork !== "";
  const generated = generateDeploymentSecrets(context.randomBytes, {
    credentialProxy: proxyEnabled,
  });

  if (!options.force) {
    for (const key of generated.keys()) {
      const keep = prior(key);

      if (keep !== "") {
        generated.set(key, keep);
      }
    }
  }

  const setupValues = new Map<string, string>([
    ["PORKBOT_AUTH_ORIGIN", origin],
    ["PORKBOT_WEB_ORIGIN", webOrigin],
    [
      "PORKBOT_MCP_CALLBACK_URL",
      prior("PORKBOT_MCP_CALLBACK_URL") || `${origin.replace(/\/+$/, "")}/oauth/mcp/callback`,
    ],
    ["PORKBOT_IMAGE_TAG", imageTag],
  ]);

  if (proxyEnabled) {
    setupValues.set("PORKBOT_COMPUTER_PROXY_IMAGE", proxyImage);
    setupValues.set("PORKBOT_COMPUTER_EGRESS_NETWORK", egressNetwork);
  }

  let rendered: string;

  try {
    rendered = renderDeploymentEnv({
      template: readFileSync(templateFile, "utf8"),
      plans: deploymentValuePlans,
      generated,
      setup: setupValues,
    });
  } catch (error) {
    context.err(`The template could not be rendered: ${(error as Error).message}`);

    return 1;
  }

  const problems = validateDeploymentEnv(parseEnvFile(rendered));

  if (problems.length > 0) {
    // Rendering is validated before a byte is written: setup can never leave a
    // file the stack would refuse.
    printProblems(context, displayPath(context, envFile), problems);

    return 1;
  }

  mkdirSync(path.dirname(envFile), { recursive: true });
  writeFileSync(envFile, `${deploymentEnvHeader(displayPath(context, envFile))}\n${rendered}`, {
    mode: 0o600,
  });
  chmodSync(envFile, 0o600);

  context.out(`Wrote ${displayPath(context, envFile)} (mode 0600).`);

  if (!existed) {
    context.out(
      `Generated ${String(generated.size)} secrets: ${[...generated.keys()].join(", ")}.`,
    );
    context.out("Next: `pnpm deploy:check`, then `pnpm deploy:up`.");

    return 0;
  }

  context.out(
    options.force
      ? "Regenerated every secret; existing values that were not secrets were kept."
      : "Kept every existing secret; only missing or blank settings were filled.",
  );

  if (options.force) {
    context.err(
      "A running Postgres cluster keeps its superuser password from first init (change it " +
        "with ALTER ROLE); the two service roles are re-set by the migrate one-shot on the " +
        "next `pnpm deploy:up`.",
    );
  }

  if (proxyEnabled && prior("PORKBOT_PROXY_TOKEN_SECRET") === "") {
    context.out("The credential proxy is enabled and its capability token was generated.");
  }

  context.out("Next: `pnpm deploy:check`, then `pnpm deploy:up`.");

  return 0;
}

function ensureDocker(context: DeploymentContext): number {
  const version = context.spawn("docker", ["version", "--format", "{{.Server.Version}}"], {
    cwd: context.repoRoot,
  });

  if ((version.status ?? 1) !== 0) {
    context.err(
      "Docker is not reachable. Install Docker, start the daemon, then try again. " +
        (version.stderr.trim() === "" ? "" : `Docker said: ${version.stderr.trim()}`),
    );

    return 1;
  }

  const composeVersion = context.spawn("docker", ["compose", "version"], {
    cwd: context.repoRoot,
  });

  if ((composeVersion.status ?? 1) !== 0) {
    context.err(
      "Docker Compose v2 is not available (`docker compose`). Install it, then try again.",
    );

    return 1;
  }

  return 0;
}

/**
 * A throwaway interpolation environment for `status`, `logs`, `down` and
 * `exec`. Compose interpolates the whole file before it does anything, so
 * these commands need every `${NAME:?}` resolved, but they never read a
 * container's settings: the running containers already carry them. Using fake
 * values here is what lets an operator take a stack down with a lost or
 * broken env file.
 */
function managementEnvironment(): Record<string, string> {
  return Object.fromEntries(requiredDeploymentKeys.map((key) => [key, "management-command"]));
}

function checkComposeDefinition(context: DeploymentContext, envFile: string): number {
  if (ensureDocker(context) !== 0) {
    return 1;
  }

  const result = context.spawn(
    "docker",
    composeArguments(context, ["config", "--quiet"], { envFile }),
    { cwd: context.repoRoot },
  );

  if ((result.status ?? 1) !== 0) {
    context.err(
      `Docker Compose rejected ${displayPath(context, composeFilePath(context))} with this ` +
        `environment:\n${result.stderr.trim()}`,
    );

    return 1;
  }

  context.out(
    `ok   ${displayPath(context, composeFilePath(context))}: Compose accepts the definition ` +
      "with this environment.",
  );

  return 0;
}

function runCheck(context: DeploymentContext, options: DeployOptions): number {
  const envFile = resolveEnvFilePath(context, options);
  const values = loadValidEnvFile(context, envFile);

  if (values === null) {
    return 1;
  }

  context.out(
    `ok   ${displayPath(context, envFile)}: ${String(values.size)} settings, every requirement satisfied.`,
  );

  return options.compose ? checkComposeDefinition(context, envFile) : 0;
}

function dockerSocketProblem(
  context: DeploymentContext,
  values: ReadonlyMap<string, string>,
): string | undefined {
  // A remote daemon resolves bind sources on its own host, so a local check
  // would be a guess. The local case is exact and worth failing on: Compose
  // would otherwise create a root-owned directory where the socket belongs.
  if ((context.env["DOCKER_HOST"] ?? "") !== "") {
    return undefined;
  }

  // Empty or absent falls back to the compose file's own default, which is
  // exactly the path about to be mounted.
  const socket = values.get("PORKBOT_DOCKER_SOCKET")?.trim() || "/var/run/docker.sock";

  try {
    if (statSync(socket).isSocket()) {
      return undefined;
    }
  } catch {
    // Fall through to the message.
  }

  return (
    `PORKBOT_DOCKER_SOCKET (${socket}) is not a socket, so the supervisor's mount would ` +
    "create a directory instead. Point it at the daemon's socket, or set DOCKER_HOST if the " +
    "daemon is remote."
  );
}

function waitSeconds(context: DeploymentContext, options: DeployOptions): string {
  return options.waitSeconds ?? context.env["PORKBOT_DEPLOY_WAIT_SECONDS"] ?? defaultWaitSeconds;
}

function runUp(context: DeploymentContext, options: DeployOptions): number {
  const envFile = resolveEnvFilePath(context, options);

  if (!existsSync(envFile)) {
    context.out(`No env file at ${displayPath(context, envFile)}; rendering one.`);

    const setupExit = runSetup(context, options);

    if (setupExit !== 0) {
      return setupExit;
    }
  }

  const values = loadValidEnvFile(context, envFile);

  if (values === null) {
    return 1;
  }

  const socketProblem = dockerSocketProblem(context, values);

  if (socketProblem !== undefined) {
    context.err(socketProblem);

    return 1;
  }

  if (ensureDocker(context) !== 0) {
    return 1;
  }

  const budget = waitSeconds(context, options);

  // The build runs as its own command so the health budget measures the
  // services, not the first compile: Compose counts a whole `up` invocation —
  // including a cold build — against `--wait-timeout`, and a fresh host would
  // otherwise time out while the images were still being built.
  context.out("Building the application images.");
  const build = context.spawn("docker", composeArguments(context, ["build"], { envFile }), {
    cwd: context.repoRoot,
    inherit: true,
  });

  if ((build.status ?? 1) !== 0) {
    context.err("The images could not be built; see the build output above.");

    return build.status ?? 1;
  }

  context.out(`Starting the PorkBot stack; waiting up to ${budget}s for every healthcheck.`);

  const up = context.spawn(
    "docker",
    composeArguments(
      context,
      ["up", "--detach", "--remove-orphans", "--wait", "--wait-timeout", budget],
      { envFile },
    ),
    { cwd: context.repoRoot, inherit: true },
  );

  const status = up.status ?? 1;

  if (status !== 0) {
    context.err("\nThe stack did not become healthy. Recent state and logs:");

    const state = context.spawn(
      "docker",
      composeArguments(context, ["ps", "--all", "--format", "table {{.Service}}\t{{.Status}}"]),
      { cwd: context.repoRoot, env: managementEnvironment() },
    );

    if (state.stdout.trim() !== "") {
      context.err(state.stdout.trimEnd());
    }

    const logs = context.spawn(
      "docker",
      composeArguments(context, ["logs", "--tail", "80", "--no-color"]),
      { cwd: context.repoRoot, env: managementEnvironment() },
    );

    if (logs.stdout.trim() !== "") {
      context.err(`\n${logs.stdout.trimEnd()}`);
    }

    context.err("\nFix the failure and re-run `pnpm deploy:up`.");

    return status;
  }

  context.out("");
  const state = context.spawn(
    "docker",
    composeArguments(context, ["ps", "--format", "table {{.Service}}\t{{.Status}}\t{{.Ports}}"]),
    { cwd: context.repoRoot, env: managementEnvironment() },
  );
  context.out(state.stdout.trimEnd());

  const bind = values.get("PORKBOT_BIND_ADDRESS")?.trim() ?? "127.0.0.1";
  const webPort = values.get("PORKBOT_WEB_PORT")?.trim() ?? "3000";
  const apiPort = values.get("PORKBOT_API_PORT")?.trim() ?? "3001";

  context.out(
    [
      "",
      "The stack is up and healthy.",
      `  web  http://${bind}:${webPort}`,
      `  api  http://${bind}:${apiPort}/healthz`,
      "",
      "Ports bind to " +
        bind +
        "; the public origin and HTTPS are the reverse-proxy contract (slice 12.2).",
      "Follow the logs with `pnpm deploy:logs`, stop it with `pnpm deploy:down`.",
    ].join("\n"),
  );

  return 0;
}

function runManagement(
  context: DeploymentContext,
  args: readonly string[],
  options: { readonly inherit?: boolean } = {},
): number {
  if (ensureDocker(context) !== 0) {
    return 1;
  }

  const result = context.spawn("docker", composeArguments(context, args), {
    cwd: context.repoRoot,
    env: managementEnvironment(),
    ...(options.inherit === true ? { inherit: true } : {}),
  });

  // A captured command's output is the command: `status` prints a table and to
  // swallow it would make the command silent.
  if (options.inherit !== true && result.stdout.trim() !== "") {
    context.out(result.stdout.trimEnd());
  }

  if (options.inherit !== true && (result.status ?? 1) !== 0 && result.stderr.trim() !== "") {
    context.err(result.stderr.trimEnd());
  }

  return result.status ?? 1;
}

function runDown(context: DeploymentContext, options: DeployOptions): number {
  if (options.volumes) {
    context.err(
      "Removing the stack AND its volumes: Postgres data, bot storage and computer archives " +
        "will be deleted. This cannot be undone.",
    );
  }

  return runManagement(
    context,
    options.volumes
      ? ["down", "--volumes", "--remove-orphans", "--timeout", "30"]
      : ["down", "--remove-orphans", "--timeout", "30"],
    { inherit: true },
  );
}

function runExec(context: DeploymentContext, options: DeployOptions): number {
  const [service, ...command] = options.positionals;

  if (service === undefined) {
    context.err("exec needs a service: `pnpm deploy:exec postgres psql -U porkbot`.");

    return 2;
  }

  return runManagement(context, ["exec", service, ...command], { inherit: true });
}

/**
 * The CLI entry point. Returns the process exit code; `cli.ts` is the thin
 * wiring that supplies the real filesystem, Docker and clock.
 */
export function runDeploy(argv: readonly string[], context: DeploymentContext): number {
  const parsed = parseDeployArguments(argv);

  if (!parsed.ok) {
    context.err(parsed.problem);
    context.err("");
    context.err(usageText());

    return 2;
  }

  const options = parsed.options;

  switch (options.command) {
    case "help":
      context.out(usageText());

      return 0;
    case "setup":
      return runSetup(context, options);
    case "check":
      return runCheck(context, options);
    case "up":
      return runUp(context, options);
    case "status":
      return runManagement(context, [
        "ps",
        "--all",
        "--format",
        "table {{.Service}}\t{{.Status}}\t{{.Ports}}",
      ]);
    case "logs":
      return runManagement(context, ["logs", "--follow", "--tail", "100", "--no-color"], {
        inherit: true,
      });
    case "down":
      return runDown(context, options);
    case "exec":
      return runExec(context, options);
    default:
      context.err(`Unknown command "${options.command}".`);
      context.err("");
      context.err(usageText());

      return 2;
  }
}
