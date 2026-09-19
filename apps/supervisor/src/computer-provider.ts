import {
  ComputerEmulator,
  ComputerProviderError,
  createDaytonaComputerProvider,
  createDockerComputerProvider,
  DEFAULT_COMPUTER_ARCHIVE_DIRECTORY,
  LocalStorageProvider,
} from "@porkbot/adapters";
import type {
  ComputerCeilings,
  DaytonaComputerCeilings,
  DockerComputerProviderOptions,
  DockerProxyOptions,
} from "@porkbot/adapters";
import type {
  ComputerProvider,
  ComputerRef,
  ComputerStatus,
  CredentialProxyAdmin,
  StorageProvider,
} from "@porkbot/adapter-kit";

/**
 * The supervisor's computer-provider configuration (slices 7.2 and 7.3).
 *
 * Which computer a bot gets is the operator's choice, expressed per bot
 * through the bot's `computerProvider` setting and defaulted by this
 * process's configuration: `PORKBOT_COMPUTER_PROVIDER` names the default
 * kind, and every kind whose settings are complete is available for a bot to
 * select. The offline emulator is always available and the default, so the
 * local stack runs with no daemon and no keys until an operator opts into real
 * machines; a default that names an unconfigured kind fails closed here at
 * boot instead of at a bot's first run. A real provider additionally needs the
 * storage seam its snapshots are written through (slice 7.5): `PORKBOT_STORAGE_DIR`
 * names the local storage root, and a deployment that configures a real
 * provider without one fails closed here rather than capturing an archive it
 * cannot keep.
 *
 * The registry is one `ComputerProvider` over the configured kinds. A call
 * whose reference names a kind this deployment configured goes to that
 * provider; one that names nothing goes to the default; one that names an
 * unknown or unconfigured kind is refused with the shared vocabulary's
 * `not_found`, so the operator sees a typed refusal rather than a machine
 * silently created somewhere else. `list` merges every provider's machines and
 * tags each reference with the kind that holds it, which is what keeps the
 * idle sweep and reconciliation routing a stop to the right provider.
 *
 * Every value is validated at boot, and the names are generic computer
 * settings rather than vendor ones (the provider rules): `image` names the
 * machine a computer boots from, `endpoint` names where the cloud control
 * plane is reached, `token` is its key, and the ceilings are one bot's share
 * of the host floor.
 */

export interface ComputerProviderSelection {
  /** The deployment's default kind, used when a bot selected none. */
  readonly kind: string;
  /** Every kind this deployment configured and a bot may select. */
  readonly kinds: readonly string[];
  /** One provider over the configured kinds, dispatching per reference. */
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

/**
 * The one registry. Every method resolves the provider from the reference and
 * delegates; `list` is the only method that is not a delegation, because it
 * spans every configured provider and must re-tag what it merges.
 */
function createProviderRegistry(
  providers: Readonly<Record<string, ComputerProvider>>,
  defaultKind: string,
): ComputerProvider {
  function resolve(computer: ComputerRef): ComputerProvider {
    const kind = computer.provider ?? defaultKind;
    const provider = providers[kind];

    if (provider === undefined) {
      throw new ComputerProviderError(
        "not_found",
        `this deployment has no "${kind}" computer provider configured`,
      );
    }

    return provider;
  }

  /**
   * The registry's proxy door (slice 7.8). It is present when any configured
   * kind runs a proxy; a machine whose kind has none is refused with the
   * shared `not_found` on `grant` and answers absent on `endpoint`, so the
   * mixed-fleet case is honest instead of pretending every provider is alike.
   */
  const proxy: CredentialProxyAdmin | undefined = Object.values(providers).some(
    (provider) => provider.proxy !== undefined,
  )
    ? {
        async grant(computer, grant) {
          const admin = resolve(computer).proxy;

          if (admin === undefined) {
            throw new ComputerProviderError(
              "not_found",
              `the "${computer.provider ?? defaultKind}" computer provider runs no credential proxy`,
            );
          }

          return await admin.grant(computer, grant);
        },
        async revoke(computer, runId) {
          await resolve(computer).proxy?.revoke(computer, runId);
        },
        async endpoint(computer) {
          return await resolve(computer).proxy?.endpoint(computer);
        },
      }
    : undefined;

  return {
    async ensure(computer) {
      return await resolve(computer).ensure(computer);
    },
    async status(computer) {
      return await resolve(computer).status(computer);
    },
    async stop(computer) {
      return await resolve(computer).stop(computer);
    },
    async list(): Promise<readonly ComputerStatus[]> {
      const listed = await Promise.all(
        Object.entries(providers).map(async ([kind, provider]) => {
          const statuses = await provider.list();

          return statuses.map((status) => ({
            ...status,
            computer: { ...status.computer, provider: kind },
          }));
        }),
      );

      return listed.flat();
    },
    async exec(request) {
      return await resolve(request.computer).exec(request);
    },
    async snapshot(computer) {
      return await resolve(computer).snapshot(computer);
    },
    async restore(computer, snapshot) {
      return await resolve(computer).restore(computer, snapshot);
    },
    async destroy(computer) {
      await resolve(computer).destroy(computer);
    },
    ...(proxy === undefined ? {} : { proxy }),
  };
}

/**
 * The storage seam a real provider's snapshots are written through. The local
 * provider is the self-hosting default (slice 7.7), and the same seam accepts
 * the S3-compatible provider — the store is tested over both — so a deployment
 * with its own object storage substitutes one constructor and nothing else.
 */
function snapshotStorage(env: Environment): StorageProvider {
  const root = setting(env, "PORKBOT_STORAGE_DIR");

  if (root === undefined) {
    throw new Error(
      "PORKBOT_STORAGE_DIR is required when a real computer provider is configured: snapshots have no storage root otherwise",
    );
  }

  return new LocalStorageProvider({ root });
}

/** Builds the providers and the registry this process will own, from the environment alone. */
export function createComputerProviderSelection(
  env: Environment = process.env,
): ComputerProviderSelection {
  const idleTimeoutMs = integer(env, "PORKBOT_COMPUTER_IDLE_MS", DEFAULT_IDLE_TIMEOUT_MS, 0);
  const image = setting(env, "PORKBOT_COMPUTER_IMAGE");
  const endpoint = setting(env, "PORKBOT_COMPUTER_ENDPOINT");
  const token = setting(env, "PORKBOT_COMPUTER_TOKEN");
  // The credential-proxy sidecar (slice 7.8): three settings that only make
  // sense together. All present, every Docker computer gets a proxy and the
  // deployment can grant run-scoped upstream access; all absent, the provider
  // offers no proxy seam, which is the honest offline default. A partial
  // configuration is refused at boot rather than half-running a proxy.
  const proxyImage = setting(env, "PORKBOT_COMPUTER_PROXY_IMAGE");
  const proxyTokenSecret = setting(env, "PORKBOT_PROXY_TOKEN_SECRET");
  const proxyEgressNetwork = setting(env, "PORKBOT_COMPUTER_EGRESS_NETWORK");
  let proxyOptions: DockerProxyOptions | undefined;

  if (
    proxyImage !== undefined ||
    proxyTokenSecret !== undefined ||
    proxyEgressNetwork !== undefined
  ) {
    if (
      proxyImage === undefined ||
      proxyTokenSecret === undefined ||
      proxyEgressNetwork === undefined
    ) {
      throw new Error(
        "the credential proxy needs PORKBOT_COMPUTER_PROXY_IMAGE, PORKBOT_PROXY_TOKEN_SECRET and PORKBOT_COMPUTER_EGRESS_NETWORK together",
      );
    }

    proxyOptions = {
      image: proxyImage,
      tokenSecret: proxyTokenSecret,
      egressNetwork: proxyEgressNetwork,
    };
  }
  const scratchDirectory =
    setting(env, "PORKBOT_COMPUTER_ARCHIVE_DIR") ?? DEFAULT_COMPUTER_ARCHIVE_DIRECTORY;
  const defaultKind = choice(
    env,
    "PORKBOT_COMPUTER_PROVIDER",
    ["offline", "docker", "daytona"] as const,
    "offline",
  );

  const providers: Record<string, ComputerProvider> = { offline: new ComputerEmulator() };

  // The generic image selects the machine contract. A deployment that names
  // only an image is a Docker deployment, so Docker is built for a bot to
  // select; a deployment that names the cloud endpoint gets the cloud
  // provider instead, unless it also names Docker as the default — otherwise a
  // cloud-only process would dial a Docker socket it does not have on every
  // reconciliation.
  const dockerConfigured =
    image !== undefined && (endpoint === undefined || defaultKind === "docker");
  // One storage seam per process: both real providers write snapshots to the
  // same place, and building it lazily keeps the offline deployment free of a
  // storage root it never uses.
  let storage: StorageProvider | undefined;
  const snapshots = (): StorageProvider => (storage ??= snapshotStorage(env));

  if (dockerConfigured && image !== undefined) {
    const ceilings: Partial<ComputerCeilings> = {
      cpus: positiveNumber(env, "PORKBOT_COMPUTER_CPUS", 1),
      memoryMb: integer(env, "PORKBOT_COMPUTER_MEMORY_MB", 2_048, 1),
      diskMb: integer(env, "PORKBOT_COMPUTER_DISK_MB", 10_240, 1),
      pids: integer(env, "PORKBOT_COMPUTER_PIDS", 512, 1),
      tmpfsMb: integer(env, "PORKBOT_COMPUTER_TMPFS_MB", 256, 1),
    };
    // Every setting is validated before the storage seam is built, so a
    // typo'd policy is reported as itself rather than as a missing root.
    const pullPolicy = choice(
      env,
      "PORKBOT_COMPUTER_PULL",
      ["missing", "always", "never"] as const,
      "missing",
    );
    const diskQuota = choice(
      env,
      "PORKBOT_COMPUTER_DISK_QUOTA",
      ["none", "storage-opt"] as const,
      "none",
    );
    const options: DockerComputerProviderOptions = {
      image,
      socketPath: setting(env, "PORKBOT_COMPUTER_SOCKET") ?? "/var/run/docker.sock",
      home: setting(env, "PORKBOT_COMPUTER_HOME") ?? "/home/agent",
      storage: snapshots(),
      scratchDirectory,
      pullPolicy,
      diskQuota,
      ceilings,
      ...(proxyOptions === undefined ? {} : { proxy: proxyOptions }),
    };

    providers["docker"] = createDockerComputerProvider(options);
  }

  if (endpoint !== undefined || token !== undefined) {
    if (endpoint === undefined || token === undefined || image === undefined) {
      throw new Error(
        "PORKBOT_COMPUTER_ENDPOINT and PORKBOT_COMPUTER_TOKEN need PORKBOT_COMPUTER_IMAGE naming the machine image",
      );
    }

    const ceilings: Partial<DaytonaComputerCeilings> = {
      cpus: positiveNumber(env, "PORKBOT_COMPUTER_CPUS", 1),
      memoryMb: integer(env, "PORKBOT_COMPUTER_MEMORY_MB", 2_048, 1),
      diskMb: integer(env, "PORKBOT_COMPUTER_DISK_MB", 10_240, 1),
    };

    providers["daytona"] = createDaytonaComputerProvider({
      endpoint,
      toolboxUrl: setting(env, "PORKBOT_COMPUTER_TOOLBOX_URL"),
      token,
      image,
      home: setting(env, "PORKBOT_COMPUTER_HOME") ?? "/home/agent",
      storage: snapshots(),
      scratchDirectory,
      ceilings,
    });
  }

  if (providers[defaultKind] === undefined) {
    throw new Error(
      `PORKBOT_COMPUTER_PROVIDER=${defaultKind} is not configured; provide its settings (for example PORKBOT_COMPUTER_IMAGE)`,
    );
  }

  return {
    kind: defaultKind,
    kinds: Object.keys(providers),
    provider: createProviderRegistry(providers, defaultKind),
    idleTimeoutMs,
  };
}
