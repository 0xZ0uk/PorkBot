import { execFile, execFileSync } from "node:child_process";

/**
 * The container runtime seam for the Postgres harness.
 *
 * Docker is driven through the CLI rather than a client library for the two
 * properties the acceptance criteria need. First, the harness CLI's actions are
 * separate process invocations: the container must outlive the process that
 * started it, and a client library that reaps its containers when the process
 * exits cannot express "started here, used later". Second, the only dependency
 * becomes the `docker` binary the host already has, so booting the harness
 * pulls exactly one image — the Postgres one — and no reaper image on top.
 *
 * Every command runs through `runCommand`, which never uses a shell: arguments
 * are passed as an array, so an image name or a suite name can never become
 * shell syntax.
 */

export const testkitContainerLabel = "porkbot.testkit=1";

export interface CommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly timeoutMs?: number;
  readonly cwd?: string;
}

const secretFlag = /password|secret|token|key/i;

/**
 * An error message is a thing CI uploads, so `--env POSTGRES_PASSWORD=...` must
 * not survive into it. Only values of secret-looking `--env` pairs are hidden;
 * everything else stays readable for debugging.
 */
export function redactArguments(args: readonly string[]): string[] {
  return args.map((argument, index) => {
    const previous = args[index - 1];

    if (previous !== "--env" && previous !== "-e") {
      return argument;
    }

    const separator = argument.indexOf("=");

    if (separator <= 0) {
      return argument;
    }

    return secretFlag.test(argument.slice(0, separator))
      ? `${argument.slice(0, separator)}=***`
      : argument;
  });
}

export class CommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];

  constructor(command: string, args: readonly string[], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CommandError";
    this.command = command;
    this.args = redactArguments(args);
  }
}

export class DockerUnavailableError extends CommandError {
  constructor(message: string, options?: ErrorOptions) {
    super("docker", [], message, options);
    this.name = "DockerUnavailableError";
  }
}

export function runCommand(
  command: string,
  args: readonly string[],
  options: CommandOptions = {},
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? 60_000,
        maxBuffer: 10 * 1024 * 1024,
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = stderr.trim() === "" ? error.message : stderr.trim();
          reject(
            new CommandError(
              command,
              args,
              `${command} ${redactArguments(args).join(" ")} failed: ${detail}`,
              { cause: error },
            ),
          );
          return;
        }

        resolve({ stdout, stderr });
      },
    );
  });
}

export async function dockerServerVersion(): Promise<string> {
  const { stdout } = await runCommand("docker", ["version", "--format", "{{.Server.Version}}"]);
  const version = stdout.trim();

  if (version === "") {
    throw new DockerUnavailableError("docker answered without a server version.");
  }

  return version;
}

/**
 * Fails with an actionable message when there is no Docker daemon. The harness
 * never skips itself when the runtime is missing — a tier that silently does
 * nothing is worse than a tier that fails — but the message has to name the way
 * out, which is the attached-Postgres mode.
 */
export async function requireDocker(): Promise<string> {
  try {
    return await dockerServerVersion();
  } catch (error) {
    throw new DockerUnavailableError(
      "Docker is not reachable, so the Postgres harness cannot start a container. " +
        "Start Docker, or point TESTKIT_DATABASE_URL at an existing Postgres to run against that server instead.",
      { cause: error },
    );
  }
}

export interface PostgresContainerRequest {
  readonly name: string;
  readonly image: string;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface RunningContainer {
  readonly id: string;
  readonly name: string;
  readonly host: string;
  readonly port: number;
}

/**
 * Boots one Postgres container. The image may need to be pulled, which is why
 * the timeout is minutes rather than seconds; CI pre-pulls it so the pull
 * happens outside the test hooks.
 */
export async function startPostgresContainer(
  request: PostgresContainerRequest,
): Promise<RunningContainer> {
  const args = [
    "run",
    "--detach",
    "--name",
    request.name,
    "--label",
    testkitContainerLabel,
    "--env",
    `POSTGRES_USER=${request.user}`,
    "--env",
    `POSTGRES_PASSWORD=${request.password}`,
    "--env",
    `POSTGRES_DB=${request.database}`,
    "--publish",
    "127.0.0.1::5432",
    request.image,
  ];

  const { stdout } = await runCommand("docker", args, { timeoutMs: 180_000 });
  const id = stdout.trim();

  if (id === "") {
    throw new CommandError("docker", args, "docker run returned no container id.");
  }

  try {
    const { host, port } = await publishedPort(id, 5432);

    return { id, name: request.name, host, port };
  } catch (error) {
    await removeContainer(id).catch(() => {});
    throw error;
  }
}

export async function publishedPort(
  containerId: string,
  containerPort: number,
): Promise<{ host: string; port: number }> {
  const { stdout } = await runCommand("docker", ["port", containerId, `${containerPort}/tcp`]);

  return parsePublishedPort(stdout);
}

/** Parses `docker port` output such as `127.0.0.1:49153` or `[::1]:49153`. */
export function parsePublishedPort(output: string): { host: string; port: number } {
  const line = output
    .split("\n")
    .map((candidate) => candidate.trim())
    .find((candidate) => candidate !== "");

  if (line === undefined) {
    throw new Error("docker port printed no mapping, so the published port is unknown.");
  }

  const separator = line.lastIndexOf(":");

  if (separator <= 0) {
    throw new Error(`docker port printed "${line}", which is not a host:port mapping.`);
  }

  const rawHost = line.slice(0, separator);
  const host = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
  const port = Number(line.slice(separator + 1));

  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`docker port printed "${line}", which has no usable port.`);
  }

  return { host, port };
}

export async function containerExists(containerId: string): Promise<boolean> {
  try {
    await runCommand("docker", ["inspect", "--format", "{{.Id}}", containerId], {
      timeoutMs: 30_000,
    });

    return true;
  } catch {
    return false;
  }
}

/** Idempotent: removing a container that is already gone is a success. */
export async function removeContainer(containerId: string): Promise<void> {
  try {
    await runCommand("docker", ["rm", "--force", "--volumes", containerId], {
      timeoutMs: 60_000,
    });
  } catch (error) {
    if (!(error instanceof CommandError) || !/No such container/i.test(error.message)) {
      throw error;
    }
  } finally {
    unregisterContainerCleanup(containerId);
  }
}

const containersToRemove = new Set<string>();
let cleanupHooksInstalled = false;

function removeContainerSync(containerId: string): void {
  try {
    execFileSync("docker", ["rm", "--force", "--volumes", containerId], {
      stdio: "ignore",
      timeout: 30_000,
    });
  } catch {
    // Best effort. `docker rm -f $(docker ps -aq --filter label=porkbot.testkit=1)`
    // sweeps anything this misses.
  }
}

function removeRegisteredSync(): void {
  for (const id of containersToRemove) {
    removeContainerSync(id);
  }
}

/**
 * The synchronous backstop for a harness a process owns. Test teardown is the
 * deterministic path; this closes the two gaps where there is none — a test
 * process that exits through a thrown error (`exit`) and a CI runner or a human
 * killing the process (`SIGINT`, `SIGTERM`). `exit` alone is not enough: turbo
 * signals a task's process when a sibling task fails, and that signal never
 * becomes an exit event unless somebody handles it.
 *
 * A CLI harness is deliberately never registered here: its container must
 * outlive the `start` process, and its state file is what later commands — and
 * a human after a hard kill — use to find and remove it.
 */
export function registerContainerCleanup(containerId: string): void {
  containersToRemove.add(containerId);

  if (cleanupHooksInstalled) {
    return;
  }

  cleanupHooksInstalled = true;
  process.on("exit", removeRegisteredSync);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      removeRegisteredSync();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
}

export function unregisterContainerCleanup(containerId: string): void {
  containersToRemove.delete(containerId);
}
