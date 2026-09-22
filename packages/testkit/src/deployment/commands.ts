import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { deploymentEnvHeader, parseEnvFile, renderDeploymentEnv } from "./env-file.ts";
import {
  readReleaseState,
  releaseStatePath,
  replaceImageTag,
  writeReleaseState,
} from "./release.ts";
import {
  defaultMeasurementBotCount,
  defaultMeasurementIdleSeconds,
  defaultMeasurementRawPath,
  defaultMeasurementSampleIntervalSeconds,
  defaultMeasurementTablePath,
  runDeploymentMeasure,
} from "./measure.ts";
import { deploymentValuePlans, generateDeploymentSecrets } from "./secrets.ts";
import { isDeploymentImageTag, requiredDeploymentKeys, validateDeploymentEnv } from "./validate.ts";
import type { DeploymentProblem } from "./validate.ts";

/**
 * The single-host deployment commands (slices 12.1, 12.4 and 14.1, PRD
 * stories 1, 2 and 8).
 *
 * `deploy:setup` renders deploy/.env from the committed template, generating
 * every secret in the register; `deploy:check` validates the file without
 * starting anything — and, when the Docker provider is selected, reads the
 * daemon's storage driver to report whether the disk budget is enforceable;
 * `deploy:up` does the setup when the file is absent, validates it, then runs
 * the production compose file and waits for every healthcheck, reporting
 * readiness per service. `upgrade` preflights a target
 * image, migrates after that preflight, and switches only after a second health
 * check; `rollback` redeploys the recorded prior image without migrations.
 * `status`, `logs`, `down` and `exec` wrap the matching compose commands.
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

const applicationServices = ["api", "worker", "backup", "proxy", "supervisor"] as const;
const releaseServices = ["migrate", ...applicationServices] as const;

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
  readonly computerImage: string | undefined;
  readonly proxyImage: string | undefined;
  readonly egressNetwork: string | undefined;
  readonly envFile: string | undefined;
  readonly force: boolean;
  readonly compose: boolean;
  readonly volumes: boolean;
  readonly waitSeconds: string | undefined;
  readonly measureBots: string | undefined;
  readonly measureIdleSeconds: string | undefined;
  readonly measureSampleIntervalSeconds: string | undefined;
  readonly measureTablePath: string | undefined;
  readonly measureRawPath: string | undefined;
  readonly positionals: readonly string[];
}

export function usageText(): string {
  return [
    "Usage: deploy <command> [options]",
    "",
    "Commands:",
    "  setup    Render deploy/.env from the template, generating every secret.",
    "  check    Validate the env file; --compose also proves Compose accepts the file.",
    "           With the Docker provider selected it also reads the daemon's storage",
    "           driver and reports whether PORKBOT_COMPUTER_DISK_MB is enforced.",
    "  up       Setup if needed, validate, build, start, and wait for every healthcheck.",
    "  upgrade  Pull a release, preflight its health, migrate, then switch services.",
    "  rollback Redeploy the previous release without reversing database migrations.",
    "  measure  Cold-boot the live stack, run the provider/backup workload, and write a floor table.",
    "  status   Show each service's state, health and published ports.",
    "  logs     Follow the stack's logs.",
    "  down     Stop the stack; pass --volumes to delete its data too.",
    "  exec     Run a command in a running service: deploy exec postgres psql -U porkbot",
    "",
    "Options:",
    "  --origin <url>        The public origin (setup and up; required when rendering).",
    "  --web-origin <url>    The origin notification links use (defaults to --origin).",
    "  --tag <tag>          Image tag for setup/upgrade, or an explicit rollback target.",
    "  --computer-image <ref>  Machine image to store during setup (also enables Docker measurement).",
    "  --proxy-image <ref>   Enable the credential proxy with this sidecar image; needs",
    "  --egress-network <n>  ...this egress network. Both together enable the segment.",
    "  --env-path <path>     Env file to write or read (default: deploy/.env, relative to the repo).",
    "  --force               Regenerate every generated secret (setup); rotates credentials.",
    "  --compose             Also run `docker compose config` (check).",
    "  --volumes             Delete volumes too, including Postgres data (down).",
    "  --wait-timeout <s>    Health wait budget for `up` (default: PORKBOT_DEPLOY_WAIT_SECONDS or 300).",
    "  --bots <n>            Bot count per provider for `measure` (default: 1).",
    "  --idle-seconds <s>    Idle phase duration for `measure` (default: 3600).",
    "  --sample-interval-seconds <s>  Idle sample interval (default: 60).",
    "  --table-path <path>   Floor table output (measure; defaults to the architecture table).",
    "  --raw-path <path>     Raw JSON output (measure; defaults to the ignored artifact path).",
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
  let computerImage: string | undefined;
  let proxyImage: string | undefined;
  let egressNetwork: string | undefined;
  let envFile: string | undefined;
  let force = false;
  let compose = false;
  let volumes = false;
  let waitSeconds: string | undefined;
  let measureBots: string | undefined;
  let measureIdleSeconds: string | undefined;
  let measureSampleIntervalSeconds: string | undefined;
  let measureTablePath: string | undefined;
  let measureRawPath: string | undefined;

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
          computerImage,
          proxyImage,
          egressNetwork,
          envFile,
          force,
          compose,
          volumes,
          waitSeconds,
          measureBots,
          measureIdleSeconds,
          measureSampleIntervalSeconds,
          measureTablePath,
          measureRawPath,
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
      "--computer-image",
      "--proxy-image",
      "--egress-network",
      "--env-path",
      "--wait-timeout",
      "--bots",
      "--idle-seconds",
      "--sample-interval-seconds",
      "--table-path",
      "--raw-path",
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
        case "--computer-image":
          computerImage = taken.value;
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
        case "--bots":
          measureBots = taken.value;
          break;
        case "--idle-seconds":
          measureIdleSeconds = taken.value;
          break;
        case "--sample-interval-seconds":
          measureSampleIntervalSeconds = taken.value;
          break;
        case "--table-path":
          measureTablePath = taken.value;
          break;
        case "--raw-path":
          measureRawPath = taken.value;
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
      computerImage,
      proxyImage,
      egressNetwork,
      envFile,
      force,
      compose,
      volumes,
      waitSeconds,
      measureBots,
      measureIdleSeconds,
      measureSampleIntervalSeconds,
      measureTablePath,
      measureRawPath,
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
  const computerImage = options.computerImage?.trim() || prior("PORKBOT_COMPUTER_IMAGE");

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

  if (computerImage !== "") {
    setupValues.set("PORKBOT_COMPUTER_IMAGE", computerImage);
  }

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
  reportDiskQuota(context, values);

  return options.compose ? checkComposeDefinition(context, envFile) : 0;
}

/**
 * Whether the supervisor this environment produces will construct the Docker
 * provider, mirroring `apps/supervisor/src/computer-provider.ts`: an image
 * selects the machine contract, and a cloud endpoint does not also build
 * Docker unless Docker is the default kind.
 */
function dockerProviderConfigured(values: ReadonlyMap<string, string>): boolean {
  const image = values.get("PORKBOT_COMPUTER_IMAGE")?.trim() ?? "";
  const endpoint = values.get("PORKBOT_COMPUTER_ENDPOINT")?.trim() ?? "";
  const kind = values.get("PORKBOT_COMPUTER_PROVIDER")?.trim() || "offline";

  return image !== "" && (endpoint === "" || kind === "docker");
}

/**
 * The storage drivers that answer a Docker `size` quota, mirrored from the
 * authoritative register in `packages/core/src/disk-quota.ts` (the supervisor
 * and the adapters apply that one). The mirror exists because the deployment
 * CLI must stay free of workspace imports: `@porkbot/testkit` is a dev
 * dependency of every other package, so depending on one of them would make
 * Turborepo's build graph cyclic. Keep the two lists in step when a driver
 * joins or leaves the register.
 */
const diskQuotaDrivers = ["btrfs", "overlay2"] as const;

/** Whether the named driver answers a `size` quota on the given backing filesystem. */
function diskQuotaDriverAnswers(driver: string, backingFilesystem: string | undefined): boolean {
  const normalized = driver.trim().toLowerCase();
  const backing = backingFilesystem?.trim().toLowerCase();

  if (normalized === "btrfs") {
    return true;
  }

  return normalized === "overlay2" && backing === "xfs";
}

/**
 * Reports the write-layer budget's enforcement (slice 14.4) at the one place an
 * operator looks before booting. The question "will `PORKBOT_COMPUTER_DISK_MB`
 * actually hold?" has a driver-shaped answer, so it is read from the daemon's
 * own `/info` and classified by the same rule the supervisor applies. The check
 * stays a check: an unreachable daemon and an unsupported driver are reported,
 * not fatal, because `auto` is a promise stated where it can be kept and a
 * disclosed no-op where it cannot.
 */
function reportDiskQuota(context: DeploymentContext, values: ReadonlyMap<string, string>): void {
  if (!dockerProviderConfigured(values)) {
    return;
  }

  const rawMode = values.get("PORKBOT_COMPUTER_DISK_QUOTA")?.trim() || "auto";
  const mode = rawMode === "none" || rawMode === "storage-opt" ? rawMode : "auto";

  if (mode === "none") {
    context.out(
      "note disk budget: disabled by PORKBOT_COMPUTER_DISK_QUOTA=none; PORKBOT_COMPUTER_DISK_MB is not a quota",
    );

    return;
  }

  const result = context.spawn(
    "docker",
    ["info", "--format", "{{.Driver}}\t{{json .DriverStatus}}"],
    { cwd: context.repoRoot },
  );

  if ((result.status ?? 1) !== 0) {
    context.out(
      "note disk budget: the daemon could not be reached here, so its storage driver (and whether PORKBOT_COMPUTER_DISK_MB is enforceable) was not determined",
    );

    return;
  }

  const [driver = "", statusJson = ""] = result.stdout.trim().split("\t");
  let backingFilesystem: string | undefined;

  try {
    const parsed: unknown = JSON.parse(statusJson === "" ? "[]" : statusJson);

    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (
          Array.isArray(entry) &&
          entry[0] === "Backing Filesystem" &&
          typeof entry[1] === "string"
        ) {
          backingFilesystem = entry[1];
        }
      }
    }
  } catch {
    // A daemon that answers no driver details leaves the backing filesystem
    // unknown, which is reported as unsupported rather than assumed to be xfs.
  }

  const name = driver.trim().toLowerCase();
  const answers = diskQuotaDriverAnswers(name, backingFilesystem);
  const driverText = name === "" ? "the daemon named no storage driver" : `"${name}"`;
  const backingText =
    backingFilesystem === undefined ? "an unreported" : `a "${backingFilesystem}"`;

  // `storage-opt` always sends the quota, so an incapable driver refuses the
  // create; `auto` only claims what the driver answers. Either way the check
  // says which happened rather than leaving the budget implicit.
  if (mode === "storage-opt") {
    context.out(
      answers
        ? `ok   disk budget: PORKBOT_COMPUTER_DISK_QUOTA=storage-opt is answered by ${driverText} over ${backingText} backing filesystem`
        : `warn disk budget: PORKBOT_COMPUTER_DISK_QUOTA=storage-opt will be sent and refused, because ${driverText} does not answer a size quota (the drivers that do are ${diskQuotaDrivers.join(", ")}, the last only over xfs)`,
    );

    return;
  }

  if (answers) {
    context.out(`ok   disk budget: PORKBOT_COMPUTER_DISK_MB is enforced by ${driverText}`);
  } else {
    context.err(
      `warn disk budget: PORKBOT_COMPUTER_DISK_MB is not enforced, because ${driverText} does not answer a size quota (the drivers that do are ${diskQuotaDrivers.join(", ")}, the last only over xfs with pquota); the write layer belongs to the host's disk`,
    );
  }
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

function taggedEnvironment(tag: string): Readonly<Record<string, string>> {
  return { PORKBOT_IMAGE_TAG: tag };
}

function readReleaseStateOrReport(
  context: DeploymentContext,
  envFile: string,
): ReturnType<typeof readReleaseState> | undefined {
  try {
    return readReleaseState(releaseStatePath(envFile));
  } catch (error) {
    context.err(`The release state is not usable: ${(error as Error).message}`);

    return undefined;
  }
}

function rememberActiveRelease(
  context: DeploymentContext,
  envFile: string,
  active: string,
  previousHint?: string | null,
): boolean {
  try {
    const state = readReleaseState(releaseStatePath(envFile));
    const previous =
      previousHint ?? (state !== null && state.active !== active ? state.active : state?.previous);

    writeReleaseState(releaseStatePath(envFile), { active, previous: previous ?? null });

    return true;
  } catch (error) {
    context.err(
      `The stack is running, but its release state could not be recorded: ${(error as Error).message}`,
    );

    return false;
  }
}

function targetEnvironment(
  context: DeploymentContext,
  values: ReadonlyMap<string, string>,
  tag: string,
): ReadonlyMap<string, string> | null {
  if (!isDeploymentImageTag(tag)) {
    printProblems(context, `release ${tag}`, [
      {
        key: "PORKBOT_IMAGE_TAG",
        message: "must be an immutable Docker release tag and must not be `latest`",
      },
    ]);

    return null;
  }

  const candidate = new Map(values);
  candidate.set("PORKBOT_IMAGE_TAG", tag);
  const problems = validateDeploymentEnv(candidate);

  if (problems.length > 0) {
    printProblems(context, `release ${tag}`, problems);

    return null;
  }

  return candidate;
}

function pullRelease(context: DeploymentContext, envFile: string, tag: string): number {
  context.out(`Pulling release images tagged ${tag}.`);

  const result = context.spawn(
    "docker",
    composeArguments(context, ["pull", "--ignore-pull-failures", ...releaseServices], { envFile }),
    {
      cwd: context.repoRoot,
      env: taggedEnvironment(tag),
      inherit: true,
    },
  );

  if ((result.status ?? 1) !== 0) {
    context.err(`Release ${tag} could not be pulled; the active release was not changed.`);
  }

  return result.status ?? 1;
}

function candidateName(context: DeploymentContext, runId: string, service: string): string {
  const project = projectName(context)
    .replace(/[^a-zA-Z0-9_.-]/g, "-")
    .slice(0, 36);

  return `${project}-release-check-${runId}-${service}`;
}

function cleanupCandidates(context: DeploymentContext, names: readonly string[]): void {
  for (const name of [...names].reverse()) {
    context.spawn("docker", ["rm", "--force", name], { cwd: context.repoRoot });
  }
}

function candidateWaitBudgetMs(budget: string): number {
  const seconds = Number(budget);

  return Number.isFinite(seconds) && seconds > 0 ? Math.max(1, Math.ceil(seconds)) * 1000 : 300_000;
}

function waitForCandidateHealth(context: DeploymentContext, name: string, budget: string): boolean {
  const deadline = Date.now() + candidateWaitBudgetMs(budget);
  const inspectFormat =
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}";

  for (;;) {
    const result = context.spawn("docker", ["inspect", "--format", inspectFormat, name], {
      cwd: context.repoRoot,
    });
    const status = result.stdout.trim().toLowerCase();

    if ((result.status ?? 1) !== 0 || status === "" || status === "dead" || status === "exited") {
      context.err(`Release candidate ${name} stopped before becoming healthy.`);

      return false;
    }

    if (status === "healthy") {
      return true;
    }

    if (status === "unhealthy") {
      context.err(`Release candidate ${name} reported unhealthy.`);

      return false;
    }

    if (Date.now() >= deadline) {
      context.err(`Release candidate ${name} did not become healthy within ${budget}s.`);

      return false;
    }

    // The deployment CLI is intentionally synchronous so every Docker action
    // remains injectable in tests. A short child-process sleep keeps the poll
    // from busy-spinning while retaining that seam.
    context.spawn("sleep", ["1"], { cwd: context.repoRoot });
  }
}

function startHealthyCandidates(
  context: DeploymentContext,
  envFile: string,
  tag: string,
  budget: string,
): string[] | null {
  const runId = context.randomBytes(6).toString("hex");
  const names: string[] = [];

  for (const service of applicationServices) {
    const name = candidateName(context, runId, service);
    const result = context.spawn(
      "docker",
      composeArguments(
        context,
        ["run", "--detach", "--pull", "never", "--no-deps", "--name", name, service],
        { envFile },
      ),
      {
        cwd: context.repoRoot,
        env: taggedEnvironment(tag),
        inherit: true,
      },
    );

    if ((result.status ?? 1) !== 0) {
      context.err(
        `The ${service} service for release ${tag} could not be started for health-checking.`,
      );
      cleanupCandidates(context, names);

      return null;
    }

    names.push(name);

    if (!waitForCandidateHealth(context, name, budget)) {
      cleanupCandidates(context, names);

      return null;
    }
  }

  return names;
}

function switchServices(
  context: DeploymentContext,
  envFile: string,
  tag: string,
  budget: string,
): number {
  const result = context.spawn(
    "docker",
    composeArguments(
      context,
      [
        "up",
        "--detach",
        "--pull",
        "never",
        "--no-build",
        "--no-deps",
        "--wait",
        "--wait-timeout",
        budget,
        ...applicationServices,
      ],
      { envFile },
    ),
    {
      cwd: context.repoRoot,
      env: taggedEnvironment(tag),
      inherit: true,
    },
  );

  return result.status ?? 1;
}

function runUpgrade(context: DeploymentContext, options: DeployOptions): number {
  const envFile = resolveEnvFilePath(context, options);
  const values = loadValidEnvFile(context, envFile);

  if (values === null) {
    return 1;
  }

  const current = values.get("PORKBOT_IMAGE_TAG")?.trim() ?? "";
  const state = readReleaseStateOrReport(context, envFile);

  if (state === undefined || (state !== null && state.active !== current)) {
    if (state !== undefined && state !== null) {
      context.err(
        `The env file names ${current}, but the release state names ${state.active}; ` +
          "refusing to guess which release is active.",
      );
    }

    return 1;
  }

  const tag = options.tag?.trim() || context.imageTag();

  if (tag === undefined || tag === null || tag === "") {
    context.err(
      "upgrade needs the release tag: pass `--tag <git-sha>` or run it from the release checkout.",
    );

    return 2;
  }

  if (tag === current) {
    context.err(`Release ${tag} is already active; pass the new release's git SHA to upgrade.`);

    return 2;
  }

  if (targetEnvironment(context, values, tag) === null) {
    return 1;
  }

  if (ensureDocker(context) !== 0) {
    return 1;
  }

  const socketProblem = dockerSocketProblem(context, values);

  if (socketProblem !== undefined) {
    context.err(socketProblem);

    return 1;
  }

  if (pullRelease(context, envFile, tag) !== 0) {
    return 1;
  }

  const budget = waitSeconds(context, options);
  const candidates = startHealthyCandidates(context, envFile, tag, budget);

  if (candidates === null) {
    context.err("The active release is still running; no migration or switch was attempted.");

    return 1;
  }

  context.out(
    `Release ${tag} is healthy in disposable containers. Applying its migrations before the switch.`,
  );
  const migration = context.spawn(
    "docker",
    composeArguments(context, ["run", "--rm", "--pull", "never", "--no-deps", "migrate"], {
      envFile,
    }),
    {
      cwd: context.repoRoot,
      env: taggedEnvironment(tag),
      inherit: true,
    },
  );

  if ((migration.status ?? 1) !== 0) {
    cleanupCandidates(context, candidates);
    context.err(
      `Migration for release ${tag} failed; the active release ${current} remains running and no switch was made.`,
    );

    return migration.status ?? 1;
  }

  for (const name of candidates) {
    if (!waitForCandidateHealth(context, name, budget)) {
      cleanupCandidates(context, candidates);
      context.err(
        `Release ${tag} failed its post-migration health-check; the active release ${current} remains running, but the migration remains applied.`,
      );

      return 1;
    }
  }

  cleanupCandidates(context, candidates);
  context.out(`Switching the deployment to release ${tag}.`);
  const switched = switchServices(context, envFile, tag, budget);

  if (switched !== 0) {
    context.err(`The switch to ${tag} failed; restoring active release ${current}.`);
    const restored = switchServices(context, envFile, current, budget);

    if (restored === 0) {
      context.err(`Release ${current} is still active. The migration remains applied.`);
    } else {
      context.err(
        `The previous release could not be restored automatically. Keep the deployment offline and investigate before retrying; the schema was not rolled back.`,
      );
    }

    return switched;
  }

  try {
    replaceImageTag(envFile, tag);
    writeReleaseState(releaseStatePath(envFile), { active: tag, previous: current });
  } catch (error) {
    context.err(
      `Release ${tag} is running, but its local release record could not be updated: ${(error as Error).message}`,
    );

    return 1;
  }

  context.out(`Upgrade complete: ${tag} is active; rollback can redeploy ${current} if needed.`);

  return 0;
}

function runRollback(context: DeploymentContext, options: DeployOptions): number {
  const envFile = resolveEnvFilePath(context, options);
  const values = loadValidEnvFile(context, envFile);

  if (values === null) {
    return 1;
  }

  const current = values.get("PORKBOT_IMAGE_TAG")?.trim() ?? "";
  const state = readReleaseStateOrReport(context, envFile);

  if (state === undefined || (state !== null && state.active !== current)) {
    if (state !== undefined && state !== null) {
      context.err(
        `The env file names ${current}, but the release state names ${state.active}; ` +
          "refusing to guess which release is active.",
      );
    }

    return 1;
  }

  const tag = options.tag?.trim() || state?.previous;

  if (tag === undefined || tag === null || tag === "") {
    context.err(
      "No previous release is recorded. Complete an upgrade first, or pass `--tag <git-sha>`.",
    );

    return 2;
  }

  if (tag === current) {
    context.err(`Release ${tag} is already active; nothing to roll back.`);

    return 2;
  }

  if (targetEnvironment(context, values, tag) === null) {
    return 1;
  }

  if (ensureDocker(context) !== 0) {
    return 1;
  }

  if (pullRelease(context, envFile, tag) !== 0) {
    return 1;
  }

  const budget = waitSeconds(context, options);
  context.out(
    `Rollback limitation: this redeploys image ${tag} against the current database schema; it does not reverse migrations.`,
  );
  context.out(`Redeploying release ${tag} without running migrations.`);
  const switched = switchServices(context, envFile, tag, budget);

  if (switched !== 0) {
    context.err(`Rollback to ${tag} did not become healthy; restoring active release ${current}.`);
    const restored = switchServices(context, envFile, current, budget);

    if (restored !== 0) {
      context.err(
        "The active release could not be restored automatically. Keep the deployment offline and investigate; the schema remains unchanged by rollback.",
      );
    }

    return switched;
  }

  try {
    replaceImageTag(envFile, tag);
    writeReleaseState(releaseStatePath(envFile), { active: tag, previous: current });
  } catch (error) {
    context.err(
      `Release ${tag} is running, but its local release record could not be updated: ${(error as Error).message}`,
    );

    return 1;
  }

  context.out(
    `Rollback complete: ${tag} is active against the newer schema. Restore a compatible database backup separately if schema reversal is required.`,
  );

  return 0;
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

  const activeTag = values.get("PORKBOT_IMAGE_TAG")?.trim() ?? "";

  if (!rememberActiveRelease(context, envFile, activeTag)) {
    return 1;
  }

  context.out("");
  const state = context.spawn(
    "docker",
    composeArguments(context, ["ps", "--format", "table {{.Service}}\t{{.Status}}\t{{.Ports}}"]),
    { cwd: context.repoRoot, env: managementEnvironment() },
  );
  context.out(state.stdout.trimEnd());

  const apiPort = values.get("PORKBOT_API_PORT")?.trim() ?? "3001";
  const origin = values.get("PORKBOT_AUTH_ORIGIN")?.trim() ?? "";

  context.out(
    [
      "",
      "The stack is up and healthy.",
      `  origin  ${origin} (the reverse proxy; see deploy/Caddyfile)`,
      `  api     http://127.0.0.1:${apiPort}/healthz (loopback only)`,
      "",
      "The proxy is the public origin. If it answers without a certificate yet, check that DNS " +
        "points at this host and read `pnpm deploy:logs proxy`.",
      "Follow the logs with `pnpm deploy:logs`, stop it with `pnpm deploy:down`.",
    ].join("\n"),
  );

  return 0;
}

function measurementInteger(
  context: DeploymentContext,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  flag: string,
): number | null {
  if (raw === undefined) {
    return fallback;
  }

  if (!/^\d+$/.test(raw)) {
    context.err(`${flag} must be a whole number of at least ${String(minimum)}.`);

    return null;
  }

  const value = Number(raw);

  if (!Number.isSafeInteger(value) || value < minimum) {
    context.err(`${flag} must be a whole number of at least ${String(minimum)}.`);

    return null;
  }

  return value;
}

function runMeasure(context: DeploymentContext, options: DeployOptions): number {
  const envFile = resolveEnvFilePath(context, options);
  const values = loadValidEnvFile(context, envFile);

  if (values === null) {
    return 1;
  }

  // The workload intentionally exercises both provider implementations. A
  // deployment with only the offline emulator would produce a partial floor
  // and make the table look more complete than the host's real configuration.
  if ((values.get("PORKBOT_COMPUTER_IMAGE")?.trim() ?? "") === "") {
    context.err(
      "deploy:measure needs PORKBOT_COMPUTER_IMAGE so it can exercise both the offline and Docker providers; configure the image and re-run deploy:check first.",
    );

    return 2;
  }

  const botCount = measurementInteger(
    context,
    options.measureBots,
    defaultMeasurementBotCount,
    1,
    "--bots",
  );
  const idleSeconds = measurementInteger(
    context,
    options.measureIdleSeconds,
    defaultMeasurementIdleSeconds,
    0,
    "--idle-seconds",
  );
  const sampleIntervalSeconds = measurementInteger(
    context,
    options.measureSampleIntervalSeconds,
    defaultMeasurementSampleIntervalSeconds,
    1,
    "--sample-interval-seconds",
  );

  if (botCount === null || idleSeconds === null || sampleIntervalSeconds === null) {
    return 2;
  }

  const socketProblem = dockerSocketProblem(context, values);

  if (socketProblem !== undefined) {
    context.err(socketProblem);

    return 1;
  }

  return runDeploymentMeasure(
    {
      repoRoot: context.repoRoot,
      composeFile: composeFilePath(context),
      projectName: projectName(context),
      envFile,
      env: context.env,
      out: context.out,
      err: context.err,
      spawn: context.spawn,
    },
    {
      botCount,
      waitSeconds: waitSeconds(context, options),
      idleSeconds,
      sampleIntervalSeconds,
      tablePath: options.measureTablePath ?? defaultMeasurementTablePath,
      rawPath: options.measureRawPath ?? defaultMeasurementRawPath,
    },
  );
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
    case "upgrade":
      return runUpgrade(context, options);
    case "rollback":
      return runRollback(context, options);
    case "measure":
      return runMeasure(context, options);
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
