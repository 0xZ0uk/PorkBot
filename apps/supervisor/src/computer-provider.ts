import { ComputerEmulator, createDockerComputerProvider } from "@porkbot/adapters";
import type { ComputerCeilings, DockerComputerProviderOptions } from "@porkbot/adapters";
import type { ComputerProvider } from "@porkbot/adapter-kit";

/**
 * The supervisor's computer-provider configuration (slice 7.2).
 *
 * Which computer a bot gets is deployment configuration, expressed through
 * generic computer settings rather than provider-specific ones: `provider`
 * names the kind (`offline` or `docker`), `image` names the machine a computer
 * boots from, `socket` names where that provider is reached, and the ceilings
 * are one bot's share of the host floor. The offline default is deliberate:
 * the local stack runs with no daemon and no keys until an operator opts into
 * real machines, and a Docker selection without an image fails closed here at
 * boot instead of at a bot's first run.
 *
 * These are the only names the process reads, and every value is validated at
 * boot, so a typo is a process that refuses to start with a clear line rather
 * than a fleet that misbehaves later.
 */

export interface ComputerProviderSelection {
  readonly kind: "offline" | "docker";
  readonly provider: ComputerProvider;
  /** How long a running machine may go without a command before it is parked. */
  readonly idleTimeoutMs: number;
}

/** The default idle window: a quarter-hour of no commands parks the machine. */
export const DEFAULT_IDLE_TIMEOUT_MS = 900_000;

type Environment = Readonly<Record<string, string | undefined>>;

function setting(env: Environment, name: string): string | undefined {
  const value = env[name]?.trim();

  return value === undefined || value === "" ? undefined : value;
}

function choice<T extends string>(
  env: Environment,
  name: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = setting(env, name);

  if (value === undefined) {
    return fallback;
  }

  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, received "${value}"`);
  }

  return value as T;
}

function integer(env: Environment, name: string, fallback: number, minimum: number): number {
  const value = setting(env, name);

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(
      `${name} must be an integer of at least ${String(minimum)}, received "${value}"`,
    );
  }

  return parsed;
}

function positiveNumber(env: Environment, name: string, fallback: number): number {
  const value = setting(env, name);

  if (value === undefined) {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, received "${value}"`);
  }

  return parsed;
}

/** Builds the provider this process will own, from the environment alone. */
export function createComputerProviderSelection(
  env: Environment = process.env,
): ComputerProviderSelection {
  const idleTimeoutMs = integer(env, "PORKBOT_COMPUTER_IDLE_MS", DEFAULT_IDLE_TIMEOUT_MS, 0);
  const kind = choice(env, "PORKBOT_COMPUTER_PROVIDER", ["offline", "docker"] as const, "offline");

  if (kind === "offline") {
    return { kind, provider: new ComputerEmulator(), idleTimeoutMs };
  }

  const image = setting(env, "PORKBOT_COMPUTER_IMAGE");

  if (image === undefined) {
    throw new Error(
      "PORKBOT_COMPUTER_PROVIDER=docker needs PORKBOT_COMPUTER_IMAGE naming the computer image",
    );
  }

  const ceilings: Partial<ComputerCeilings> = {
    cpus: positiveNumber(env, "PORKBOT_COMPUTER_CPUS", 1),
    memoryMb: integer(env, "PORKBOT_COMPUTER_MEMORY_MB", 2_048, 1),
    diskMb: integer(env, "PORKBOT_COMPUTER_DISK_MB", 10_240, 1),
    pids: integer(env, "PORKBOT_COMPUTER_PIDS", 512, 1),
    tmpfsMb: integer(env, "PORKBOT_COMPUTER_TMPFS_MB", 256, 1),
  };
  const options: DockerComputerProviderOptions = {
    image,
    socketPath: setting(env, "PORKBOT_COMPUTER_SOCKET") ?? "/var/run/docker.sock",
    home: setting(env, "PORKBOT_COMPUTER_HOME") ?? "/home/agent",
    snapshotDirectory:
      setting(env, "PORKBOT_COMPUTER_SNAPSHOT_DIR") ?? "/var/lib/porkbot/computer-snapshots",
    pullPolicy: choice(
      env,
      "PORKBOT_COMPUTER_PULL",
      ["missing", "always", "never"] as const,
      "missing",
    ),
    diskQuota: choice(env, "PORKBOT_COMPUTER_DISK_QUOTA", ["none", "storage-opt"] as const, "none"),
    ceilings,
  };

  return { kind, provider: createDockerComputerProvider(options), idleTimeoutMs };
}
