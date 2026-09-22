import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The deployment measurement harness (slice 14.1).
 *
 * The harness deliberately speaks Docker through the same injected process
 * seam as the deployment commands. The daemon remains the authority for the
 * host shape, container list and `docker stats`; a short command executed in
 * each container reads its own cgroup v2 (or v1 compatibility) counters. This
 * keeps a host-side path from guessing which cgroup a remote daemon mounted.
 *
 * A measurement is a workload, not an idle snapshot. It cold-boots the
 * already-built stack, applies migrations, drives both configured provider
 * implementations with N temporary computers, forces a backup and restore
 * drill, and leaves an idle window long enough for the table to distinguish
 * steady state from a peak. The idle duration is shortened by CI, but the
 * phase and its requested duration remain in the report.
 */

export const measurementSchemaVersion = 1;
export const defaultMeasurementBotCount = 1;
export const defaultMeasurementIdleSeconds = 3_600;
export const defaultMeasurementSampleIntervalSeconds = 60;
export const defaultMeasurementTablePath = "docs/architecture/operations-floor.md";
export const defaultMeasurementRawPath = "artifacts/deployment-measurement/latest.json";

/** The services in the production compose file, in its documented order. */
export const measuredStackServices = [
  "postgres",
  "migrate",
  "api",
  "worker",
  "backup",
  "proxy",
  "supervisor",
] as const;

export type MeasurementPhase =
  | "cold-boot"
  | "migration"
  | "bots-idle"
  | "idle-hour"
  | "bots-offline-working"
  | "bots-docker-working"
  | "backup-restore-drill";

export interface MeasurementSpawnOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly inherit?: boolean;
}

export interface MeasurementSpawnResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface MeasurementContext {
  readonly repoRoot: string;
  readonly composeFile: string;
  readonly projectName: string;
  readonly envFile: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly spawn: (
    command: string,
    args: readonly string[],
    options?: MeasurementSpawnOptions,
  ) => MeasurementSpawnResult;
}

export interface DeploymentMeasurementOptions {
  readonly botCount: number;
  readonly waitSeconds: string;
  readonly idleSeconds: number;
  readonly sampleIntervalSeconds: number;
  readonly tablePath: string;
  readonly rawPath: string;
}

export interface MeasurementHostShape {
  readonly cpus: number | null;
  readonly memoryBytes: number | null;
  readonly architecture: string;
  readonly dockerServerVersion: string | null;
}

export interface ContainerCgroupSample {
  readonly memoryCurrentBytes: number | null;
  readonly memoryPeakBytes: number | null;
  readonly cpuUsageUsec: number | null;
  readonly source: "cgroup-v2" | "cgroup-v1" | "unavailable";
}

export interface ContainerStatsSample {
  readonly cpuPercent: number | null;
  readonly memoryCurrentBytes: number | null;
  readonly memoryLimitBytes: number | null;
  readonly memoryPercent: number | null;
}

export interface MeasurementContainerSample {
  readonly service: string;
  readonly containerId: string;
  readonly containerName: string;
  readonly phase: MeasurementPhase;
  readonly cgroup: ContainerCgroupSample;
  readonly stats: ContainerStatsSample;
}

export interface DeploymentMeasurementSample {
  readonly phase: MeasurementPhase;
  readonly capturedAt: string;
  readonly containers: readonly MeasurementContainerSample[];
  readonly warnings: readonly string[];
}

export interface MeasurementPhaseRecord {
  readonly id: MeasurementPhase;
  readonly description: string;
  readonly requestedSeconds: number | null;
  readonly completed: boolean;
}

export interface MeasurementServiceAggregate {
  readonly service: string;
  readonly containers: number;
  readonly idleMemoryBytes: number | null;
  readonly peakMemoryBytes: number | null;
  readonly idleCpuPercent: number | null;
  readonly peakCpuPercent: number | null;
  readonly peakCpuSeconds: number | null;
}

export interface DeploymentMeasurementReport {
  readonly schemaVersion: number;
  readonly measuredAt: string;
  readonly host: MeasurementHostShape;
  readonly botCount: number;
  readonly providers: readonly { readonly kind: "offline" | "docker"; readonly bots: number }[];
  readonly workload: {
    readonly phases: readonly MeasurementPhaseRecord[];
    readonly requestedIdleSeconds: number;
    readonly sampleIntervalSeconds: number;
  };
  readonly totals: {
    readonly idleMemoryBytes: number | null;
    readonly peakMemoryBytes: number | null;
    readonly peakCpuSeconds: number | null;
  };
  readonly services: readonly MeasurementServiceAggregate[];
  readonly samples: readonly DeploymentMeasurementSample[];
}

interface ContainerDescriptor {
  readonly service: string;
  readonly containerId: string;
  readonly containerName: string;
}

interface ParsedDockerInfo {
  readonly host: MeasurementHostShape;
}

const cgroupProbe = String.raw`set -eu
if [ -r /sys/fs/cgroup/memory.current ]; then
  printf 'cgroup=cgroup-v2\n'
  printf 'memory_current_bytes=%s\n' "$(cat /sys/fs/cgroup/memory.current)"
  printf 'memory_peak_bytes=%s\n' "$(cat /sys/fs/cgroup/memory.peak)"
  if [ -r /sys/fs/cgroup/cpu.stat ]; then
    printf 'cpu_usage_usec=%s\n' "$(grep '^usage_usec ' /sys/fs/cgroup/cpu.stat | cut -d' ' -f2 || true)"
  fi
elif [ -r /sys/fs/cgroup/memory/memory.usage_in_bytes ]; then
  printf 'cgroup=cgroup-v1\n'
  printf 'memory_current_bytes=%s\n' "$(cat /sys/fs/cgroup/memory/memory.usage_in_bytes)"
  printf 'memory_peak_bytes=%s\n' "$(cat /sys/fs/cgroup/memory/memory.max_usage_in_bytes)"
  if [ -r /sys/fs/cgroup/cpuacct/cpuacct.usage ]; then
    printf 'cpu_usage_ns=%s\n' "$(cat /sys/fs/cgroup/cpuacct/cpuacct.usage)"
  fi
else
  printf 'cgroup=unavailable\n'
fi`;

const offlineWorkCommand =
  "mkdir -p .porkbot-measure && " +
  "printf 'measurement' >> .porkbot-measure/load.txt && ".repeat(8) +
  "rm -rf .porkbot-measure";

/** A bounded POSIX workload for a real computer image; it never reaches the network. */
const dockerWorkCommand = 'i=0; while [ "$i" -lt 100000 ]; do i=$((i + 1)); done';

const phaseDescriptions: Readonly<Record<MeasurementPhase, string>> = {
  "cold-boot": "cold boot of the already-built deployment stack",
  migration: "the deployment migration one-shot",
  "bots-idle": "N offline and N Docker-provider computers provisioned and idle",
  "idle-hour": "the stack and provider computers left idle for the requested window",
  "bots-offline-working": "N offline-emulator computers executing a bounded shell workload",
  "bots-docker-working": "N Docker-provider computers executing a bounded shell workload",
  "backup-restore-drill": "a forced nightly backup followed by its restore drill",
};

function composeArguments(context: MeasurementContext, args: readonly string[]): string[] {
  return [
    "compose",
    "--project-name",
    context.projectName,
    "--file",
    context.composeFile,
    "--env-file",
    context.envFile,
    ...args,
  ];
}

function docker(
  context: MeasurementContext,
  args: readonly string[],
  options: MeasurementSpawnOptions = {},
): MeasurementSpawnResult {
  return context.spawn("docker", args, {
    cwd: context.repoRoot,
    ...options,
  });
}

function compose(
  context: MeasurementContext,
  args: readonly string[],
  options: MeasurementSpawnOptions = {},
): MeasurementSpawnResult {
  return docker(context, composeArguments(context, args), options);
}

function exitCode(result: MeasurementSpawnResult): number {
  return result.status ?? 1;
}

function parseFiniteNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") {
    return null;
  }

  const value = Number(raw.trim());

  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parseBytes(raw: string | undefined): number | null {
  const value = parseFiniteNumber(raw);

  return value === null ? null : Math.round(value);
}

function parsePercent(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }

  return parseFiniteNumber(raw.replace(/%$/, ""));
}

function memoryUnitMultiplier(unit: string): number {
  switch (unit.toLowerCase()) {
    case "b":
      return 1;
    case "kb":
      return 1_000;
    case "mb":
      return 1_000_000;
    case "gb":
      return 1_000_000_000;
    case "tb":
      return 1_000_000_000_000;
    case "kib":
      return 1024;
    case "mib":
      return 1024 ** 2;
    case "gib":
      return 1024 ** 3;
    case "tib":
      return 1024 ** 4;
    default:
      return 1;
  }
}

function parseDockerMemory(raw: string | undefined): number | null {
  if (raw === undefined) {
    return null;
  }

  const match = /^\s*([\d.]+)\s*([A-Za-z]+)?/.exec(raw);

  if (match === null) {
    return null;
  }

  const value = Number(match[1]);
  const multiplier = memoryUnitMultiplier(match[2] ?? "b");

  return Number.isFinite(value) ? Math.round(value * multiplier) : null;
}

function parseDockerStatsLine(
  line: string,
): { readonly containerId: string; readonly stats: ContainerStatsSample } | undefined {
  const [containerId = "", , cpu = "", memory = "", memoryPercent = ""] = line.split("\t");

  if (containerId.trim() === "") {
    return undefined;
  }

  const [current = "", limit = ""] = memory.split("/");

  return {
    containerId: containerId.trim(),
    stats: {
      cpuPercent: parsePercent(cpu),
      memoryCurrentBytes: parseDockerMemory(current),
      memoryLimitBytes: parseDockerMemory(limit),
      memoryPercent: parsePercent(memoryPercent),
    },
  };
}

export function parseCgroupProbe(text: string): ContainerCgroupSample {
  const values = new Map<string, string>();

  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");

    if (separator > 0) {
      values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }

  const source = values.get("cgroup");
  const cpuUsageUsec =
    parseFiniteNumber(values.get("cpu_usage_usec")) ??
    (() => {
      const nanoseconds = parseFiniteNumber(values.get("cpu_usage_ns"));

      return nanoseconds === null ? null : nanoseconds / 1000;
    })();

  return {
    memoryCurrentBytes: parseBytes(values.get("memory_current_bytes")),
    memoryPeakBytes: parseBytes(values.get("memory_peak_bytes")),
    cpuUsageUsec,
    source:
      source === "cgroup-v2" || source === "cgroup-v1" || source === "unavailable"
        ? source
        : "unavailable",
  };
}

function parseContainerLines(text: string, service: string): ContainerDescriptor[] {
  const descriptors: ContainerDescriptor[] = [];

  for (const line of text.split("\n")) {
    const [serviceName = "", containerId = "", containerName = ""] = line.split("\t");

    if (containerId.trim() === "") {
      continue;
    }

    // Compose emits the service in the first column. The fallback is only for
    // the managed-provider query, whose first column is not a service.
    descriptors.push({
      service: service === "" ? serviceName.trim() : service,
      containerId: containerId.trim(),
      containerName: containerName.trim() || containerId.trim(),
    });
  }

  return descriptors;
}

function listContainers(context: MeasurementContext, botCount: number): ContainerDescriptor[] {
  const composeResult = compose(context, ["ps", "--format", "{{.Service}}\t{{.ID}}\t{{.Name}}"]);
  const composeContainers = parseContainerLines(composeResult.stdout, "");
  const managedContainers = Array.from({ length: botCount }, (_, index) => {
    const managedResult = docker(context, [
      "ps",
      "--filter",
      "label=porkbot.managed=true",
      "--filter",
      "label=porkbot.computer.id",
      "--filter",
      `label=porkbot.bot.id=porkbot-measure-bot-docker-${String(index + 1)}`,
      "--format",
      "{{.ID}}\t{{.Names}}",
    ]);

    return managedResult.stdout.split("\n").flatMap((line) => {
      const [containerId = "", containerName = ""] = line.split("\t");

      return containerId.trim() === ""
        ? []
        : [
            {
              service: "bot-docker",
              containerId: containerId.trim(),
              containerName: containerName.trim() || containerId.trim(),
            },
          ];
    });
  }).flat();
  const byId = new Map<string, ContainerDescriptor>();

  for (const descriptor of [...composeContainers, ...managedContainers]) {
    byId.set(descriptor.containerId, descriptor);
  }

  return [...byId.values()];
}

function statsFor(
  context: MeasurementContext,
  containers: readonly ContainerDescriptor[],
): ReadonlyMap<string, ContainerStatsSample> {
  if (containers.length === 0) {
    return new Map();
  }

  const result = docker(context, [
    "stats",
    "--no-stream",
    "--format",
    "{{.ID}}\t{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}",
    ...containers.map((container) => container.containerId),
  ]);
  const parsed = new Map<string, ContainerStatsSample>();

  for (const line of result.stdout.split("\n")) {
    const entry = parseDockerStatsLine(line);

    if (entry !== undefined) {
      parsed.set(entry.containerId, entry.stats);
    }
  }

  return parsed;
}

function cgroupFor(
  context: MeasurementContext,
  container: ContainerDescriptor,
): ContainerCgroupSample {
  const result = docker(context, ["exec", container.containerId, "sh", "-c", cgroupProbe]);

  return exitCode(result) === 0 ? parseCgroupProbe(result.stdout) : parseCgroupProbe("");
}

function containerIdMatches(left: string, right: string): boolean {
  return left === right || left.startsWith(right) || right.startsWith(left);
}

function statsForContainer(
  stats: ReadonlyMap<string, ContainerStatsSample>,
  id: string,
): ContainerStatsSample {
  for (const [candidate, value] of stats) {
    if (containerIdMatches(candidate, id)) {
      return value;
    }
  }

  return {
    cpuPercent: null,
    memoryCurrentBytes: null,
    memoryLimitBytes: null,
    memoryPercent: null,
  };
}

function captureSample(
  context: MeasurementContext,
  phase: MeasurementPhase,
  botCount: number,
): DeploymentMeasurementSample {
  const descriptors = listContainers(context, botCount);
  const stats = statsFor(context, descriptors);
  const warnings: string[] = [];

  if (descriptors.length === 0) {
    warnings.push("the daemon reported no running deployment containers");
  }

  const containers = descriptors.map((container) => {
    const cgroup = cgroupFor(context, container);

    if (cgroup.source === "unavailable") {
      warnings.push(
        `${container.service} (${container.containerName}) did not expose cgroup counters`,
      );
    }

    return {
      service: container.service,
      containerId: container.containerId,
      containerName: container.containerName,
      phase,
      cgroup,
      stats: statsForContainer(stats, container.containerId),
    } satisfies MeasurementContainerSample;
  });

  return {
    phase,
    capturedAt: new Date().toISOString(),
    containers,
    warnings,
  };
}

function parseDockerInfo(text: string): ParsedDockerInfo {
  const [cpu = "", memory = "", architecture = "", version = ""] = text.trim().split("\t");
  const fallbackCpus = os.cpus().length;
  const fallbackMemory = os.totalmem();

  return {
    host: {
      cpus: parseFiniteNumber(cpu) ?? (fallbackCpus > 0 ? fallbackCpus : null),
      memoryBytes: parseBytes(memory) ?? fallbackMemory,
      architecture: architecture.trim() || os.arch(),
      dockerServerVersion: version.trim() || null,
    },
  };
}

function hostShape(context: MeasurementContext): MeasurementHostShape {
  const result = docker(context, [
    "info",
    "--format",
    "{{.NCPU}}\t{{.MemTotal}}\t{{.Architecture}}\t{{.ServerVersion}}",
  ]);

  return parseDockerInfo(result.stdout).host;
}

function validSeconds(value: number): number {
  return Math.max(0, Math.floor(value));
}

function sleep(context: MeasurementContext, seconds: number): boolean {
  if (seconds <= 0) {
    return true;
  }

  return exitCode(context.spawn("sleep", [String(seconds)], { cwd: context.repoRoot })) === 0;
}

function runColdBoot(context: MeasurementContext, waitSeconds: string): boolean {
  context.out("Measuring cold boot: stopping the deployment while keeping its volumes.");
  const down = compose(context, ["down", "--remove-orphans", "--timeout", "30"], { inherit: true });

  if (exitCode(down) !== 0) {
    context.err("The deployment could not be stopped for the measurement cold boot.");

    return false;
  }

  context.out("Starting the already-built deployment for measurement (builds excluded).");
  const up = compose(
    context,
    ["up", "--detach", "--remove-orphans", "--no-build", "--wait", "--wait-timeout", waitSeconds],
    {
      inherit: true,
      // The requested idle hour must not be cut short by the normal park
      // window. The final restore below recreates the supervisor with the
      // deployment's configured value.
      env: { PORKBOT_COMPUTER_IDLE_MS: "0" },
    },
  );

  if (exitCode(up) !== 0) {
    context.err("The deployment did not become healthy after the measurement cold boot.");
    const logs = compose(context, ["logs", "--tail", "80", "--no-color"]);

    if (logs.stdout.trim() !== "") {
      context.err(logs.stdout.trimEnd());
    }

    return false;
  }

  return true;
}

function runMigration(context: MeasurementContext): boolean {
  context.out("Measuring the migration one-shot.");
  const result = compose(context, ["run", "--rm", "--pull", "never", "--no-deps", "migrate"], {
    inherit: true,
  });

  if (exitCode(result) !== 0) {
    context.err("The migration phase failed; no floor table was written.");

    return false;
  }

  return true;
}

function runBackupDrill(context: MeasurementContext): boolean {
  context.out("Measuring the nightly backup and restore drill.");
  const result = compose(context, [
    "exec",
    "-T",
    "backup",
    "node",
    "dist/cli.js",
    "run",
    "--force-drill",
  ]);

  if (exitCode(result) !== 0) {
    context.err(
      `The backup/restore phase failed${result.stderr.trim() === "" ? "." : `: ${result.stderr.trim()}`}`,
    );

    return false;
  }

  let report: { readonly drillStatus?: unknown } | undefined;

  try {
    const parsed: unknown = JSON.parse(result.stdout);

    if (typeof parsed === "object" && parsed !== null) {
      report = parsed as { readonly drillStatus?: unknown };
    }
  } catch {
    // The exit status still describes the backup, but without JSON there is
    // no evidence that the requested restore drill ran.
  }

  if (report?.drillStatus !== "succeeded") {
    context.err("The backup completed without reporting a successful restore drill.");

    return false;
  }

  return true;
}

function workloadScript(
  action: "start" | "work" | "destroy",
  provider: "offline" | "docker",
  botCount: number,
): string {
  const command = provider === "offline" ? offlineWorkCommand : dockerWorkCommand;

  // This script runs inside the supervisor container. It uses the same
  // authenticated protocol the API and worker use, so the measurement never
  // grows a second provider path or asks the host to hold the Docker socket.
  return `
const action = ${JSON.stringify(action)};
const provider = ${JSON.stringify(provider)};
const botCount = ${String(botCount)};
const token = process.env.PORKBOT_SUPERVISOR_TOKEN ?? "";
const base = process.env.PORKBOT_SUPERVISOR_URL ?? "";
const command = ${JSON.stringify(command)};
const refs = Array.from({ length: botCount }, (_, index) => ({
  computerId: "porkbot-measure-" + provider + "-" + String(index + 1),
  botId: "porkbot-measure-bot-" + provider + "-" + String(index + 1),
  provider,
}));
async function call(path, body) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      authorization: "Bearer " + token,
      "x-porkbot-supervisor-protocol": "1",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text === "" ? {} : JSON.parse(text); } catch {}
  if (!response.ok) {
    const detail = payload && payload.error && typeof payload.error.message === "string"
      ? payload.error.message : "supervisor request failed";
    throw new Error(provider + " " + path + ": " + detail);
  }
  return payload;
}
async function main() {
  if (action === "start") {
    const started = [];
    try {
      for (const computer of refs) {
        await call("/v1/computers/ensure", { computer });
        started.push(computer);
      }
      return { action, provider, bots: started.length };
    } catch (error) {
      await Promise.allSettled(started.map((computer) => call("/v1/computers/destroy", { computer })));
      throw error;
    }
  }
  if (action === "work") {
    const results = await Promise.all(refs.map((computer) => call("/v1/computers/exec", {
      computer, command, timeoutMs: 5000,
    })));
    if (results.some((entry) => entry.result && entry.result.exitCode !== 0)) {
      throw new Error(provider + " workload returned a non-zero exit code");
    }
    return { action, provider, bots: results.length };
  }
  await Promise.all(refs.map((computer) => call("/v1/computers/destroy", { computer })));
  return { action, provider, bots: refs.length };
}
main().then((value) => process.stdout.write(JSON.stringify(value) + "\\n"))
  .catch((error) => { process.stderr.write(String(error && error.message || error) + "\\n"); process.exitCode = 1; });
`.trim();
}

function runProviderAction(
  context: MeasurementContext,
  action: "start" | "work" | "destroy",
  provider: "offline" | "docker",
  botCount: number,
): boolean {
  const script = workloadScript(action, provider, botCount);
  const result = compose(context, [
    "exec",
    "-T",
    "supervisor",
    "node",
    "--input-type=module",
    "-e",
    script,
  ]);

  if (exitCode(result) !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim();
    context.err(
      `${provider} provider ${action} phase failed${detail === "" ? "." : `: ${detail}`}`,
    );

    return false;
  }

  return true;
}

function aggregateServices(
  samples: readonly DeploymentMeasurementSample[],
): readonly MeasurementServiceAggregate[] {
  const services = new Map<
    string,
    {
      containers: Set<string>;
      idleMemory: number[];
      peakMemory: number[];
      idleCpu: number[];
      peakCpu: number[];
      peakCpuSeconds: number[];
    }
  >();
  const idlePhases = new Set<MeasurementPhase>(["bots-idle", "idle-hour"]);

  for (const sample of samples) {
    for (const container of sample.containers) {
      const aggregate = services.get(container.service) ?? {
        containers: new Set<string>(),
        idleMemory: [],
        peakMemory: [],
        idleCpu: [],
        peakCpu: [],
        peakCpuSeconds: [],
      };
      const currentMemory =
        container.cgroup.memoryCurrentBytes ?? container.stats.memoryCurrentBytes;
      const peakMemory = container.cgroup.memoryPeakBytes ?? currentMemory;
      const cpuPercent = container.stats.cpuPercent;

      aggregate.containers.add(container.containerId);
      if (idlePhases.has(sample.phase) && currentMemory !== null) {
        aggregate.idleMemory.push(currentMemory);
      }
      if (peakMemory !== null) {
        aggregate.peakMemory.push(peakMemory);
      }
      if (idlePhases.has(sample.phase) && cpuPercent !== null) {
        aggregate.idleCpu.push(cpuPercent);
      }
      if (cpuPercent !== null) {
        aggregate.peakCpu.push(cpuPercent);
      }
      if (container.cgroup.cpuUsageUsec !== null) {
        aggregate.peakCpuSeconds.push(container.cgroup.cpuUsageUsec / 1_000_000);
      }
      services.set(container.service, aggregate);
    }
  }

  const order = new Map<string, number>(measuredStackServices.map((name, index) => [name, index]));
  const entries = [...services.entries()].sort(
    ([left], [right]) =>
      (order.get(left) ?? measuredStackServices.length) -
        (order.get(right) ?? measuredStackServices.length) || left.localeCompare(right),
  );

  const maximum = (values: readonly number[]): number | null =>
    values.length === 0 ? null : Math.max(...values);

  return entries.map(([service, aggregate]) => ({
    service,
    containers: aggregate.containers.size,
    idleMemoryBytes: maximum(aggregate.idleMemory),
    peakMemoryBytes: maximum(aggregate.peakMemory),
    idleCpuPercent: maximum(aggregate.idleCpu),
    peakCpuPercent: maximum(aggregate.peakCpu),
    peakCpuSeconds: maximum(aggregate.peakCpuSeconds),
  }));
}

function sumNullable(values: readonly (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null);

  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0);
}

function phaseRecords(options: DeploymentMeasurementOptions): readonly MeasurementPhaseRecord[] {
  const phases: readonly Pick<MeasurementPhaseRecord, "id" | "description" | "requestedSeconds">[] =
    [
      { id: "cold-boot", description: phaseDescriptions["cold-boot"], requestedSeconds: null },
      { id: "migration", description: phaseDescriptions.migration, requestedSeconds: null },
      { id: "bots-idle", description: phaseDescriptions["bots-idle"], requestedSeconds: null },
      {
        id: "idle-hour",
        description: phaseDescriptions["idle-hour"],
        requestedSeconds: options.idleSeconds,
      },
      {
        id: "bots-offline-working",
        description: phaseDescriptions["bots-offline-working"],
        requestedSeconds: null,
      },
      {
        id: "bots-docker-working",
        description: phaseDescriptions["bots-docker-working"],
        requestedSeconds: null,
      },
      {
        id: "backup-restore-drill",
        description: phaseDescriptions["backup-restore-drill"],
        requestedSeconds: null,
      },
    ];

  return phases.map((phase) => ({ ...phase, completed: false }));
}

function markCompleted(
  records: readonly MeasurementPhaseRecord[],
  phase: MeasurementPhase,
): readonly MeasurementPhaseRecord[] {
  return records.map((record) => (record.id === phase ? { ...record, completed: true } : record));
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) {
    return "—";
  }

  if (bytes >= 1024 ** 3) {
    return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  }

  return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
}

function formatNumber(value: number | null, suffix = ""): string {
  return value === null ? "—" : `${value.toFixed(2)}${suffix}`;
}

function formatHostMemory(bytes: number | null): string {
  return bytes === null ? "unknown" : `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function renderMeasurementTable(report: DeploymentMeasurementReport): string {
  const lines = [
    "# Measured deployment floor",
    "",
    `Measured ${report.measuredAt} on ${report.host.architecture} with ${String(report.host.cpus ?? "unknown")} vCPU and ${formatHostMemory(report.host.memoryBytes)} of daemon memory.`,
    `The workload used ${String(report.botCount)} bot(s) per provider (offline and Docker), with a requested idle window of ${String(report.workload.requestedIdleSeconds)} seconds.`,
    report.host.dockerServerVersion === null
      ? ""
      : `Docker server: ${report.host.dockerServerVersion}.`,
    "",
    "This table is measured usage, not the Compose ceilings. The idle column is the largest current memory and CPU sample during the idle phases; peak is the largest cgroup peak or `docker stats` sample observed across the complete workload.",
    "The one-shot migration is covered by the workload phase and is not included in the persistent-service totals.",
    "",
    "<!-- prettier-ignore -->",
    "| service | idle memory | peak memory | idle CPU | peak CPU | peak CPU time |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
  ];

  for (const service of report.services) {
    lines.push(
      `| ${service.service} | ${formatBytes(service.idleMemoryBytes)} | ${formatBytes(service.peakMemoryBytes)} | ${formatNumber(service.idleCpuPercent, "%")} | ${formatNumber(service.peakCpuPercent, "%")} | ${formatNumber(service.peakCpuSeconds, " s")} |`,
    );
  }

  lines.push(
    `| **sum of measured services** | **${formatBytes(report.totals.idleMemoryBytes)}** | **${formatBytes(report.totals.peakMemoryBytes)}** | — | — | **${formatNumber(report.totals.peakCpuSeconds, " s")}** |`,
    "",
    `The raw samples are emitted as JSON by \`pnpm deploy:measure\`; the CI run uploads that file as the deployment-measurement artifact. Re-run the command with \`--table-path ${defaultMeasurementTablePath}\` when replacing this record with a new host measurement.`,
    "",
    "## Workload coverage",
    "",
    "<!-- prettier-ignore -->",
    "| phase | status |",
    "| --- | --- |",
  );

  for (const phase of report.workload.phases) {
    lines.push(
      `| ${phase.id} — ${phase.description} | ${phase.completed ? "complete" : "incomplete"} |`,
    );
  }

  lines.push("");

  return `${lines.join("\n")}\n`;
}

function writeOutputs(
  context: MeasurementContext,
  options: DeploymentMeasurementOptions,
  report: DeploymentMeasurementReport,
): void {
  const tablePath = path.isAbsolute(options.tablePath)
    ? options.tablePath
    : path.resolve(context.repoRoot, options.tablePath);
  const rawPath = path.isAbsolute(options.rawPath)
    ? options.rawPath
    : path.resolve(context.repoRoot, options.rawPath);

  mkdirSync(path.dirname(tablePath), { recursive: true });
  mkdirSync(path.dirname(rawPath), { recursive: true });
  writeFileSync(tablePath, renderMeasurementTable(report), { mode: 0o644 });
  writeFileSync(rawPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  context.out(
    `Wrote measured floor table to ${path.relative(context.repoRoot, tablePath) || tablePath}.`,
  );
  context.out(
    `Wrote raw measurement samples to ${path.relative(context.repoRoot, rawPath) || rawPath}.`,
  );
}

function restoreSupervisor(context: MeasurementContext, waitSeconds: string): void {
  const result = compose(
    context,
    [
      "up",
      "--detach",
      "--no-build",
      "--no-deps",
      "--wait",
      "--wait-timeout",
      waitSeconds,
      "supervisor",
    ],
    { inherit: true },
  );

  if (exitCode(result) !== 0) {
    context.err(
      "The measurement could not restore the supervisor's configured idle window; check the deployment before running another measurement.",
    );
  }
}

/** Runs the complete live-stack workload and writes the two measurement outputs. */
export function runDeploymentMeasure(
  context: MeasurementContext,
  options: DeploymentMeasurementOptions,
): number {
  if (exitCode(docker(context, ["version", "--format", "{{.Server.Version}}"])) !== 0) {
    context.err("Docker is not reachable; start the daemon before running deploy:measure.");

    return 1;
  }

  if (exitCode(docker(context, ["compose", "version"])) !== 0) {
    context.err("Docker Compose v2 is not available; install `docker compose` before measuring.");

    return 1;
  }

  const host = hostShape(context);
  const samples: DeploymentMeasurementSample[] = [];
  let records = phaseRecords(options);
  let startedProviders: ("offline" | "docker")[] = [];
  let result = 1;

  try {
    if (!runColdBoot(context, options.waitSeconds)) {
      return 1;
    }
    samples.push(captureSample(context, "cold-boot", options.botCount));
    records = markCompleted(records, "cold-boot");

    if (!runMigration(context)) {
      return 1;
    }
    samples.push(captureSample(context, "migration", options.botCount));
    records = markCompleted(records, "migration");

    context.out(`Provisioning ${String(options.botCount)} offline and Docker-provider bot(s).`);
    for (const provider of ["offline", "docker"] as const) {
      if (!runProviderAction(context, "start", provider, options.botCount)) {
        return 1;
      }
      startedProviders.push(provider);
    }

    samples.push(captureSample(context, "bots-idle", options.botCount));
    records = markCompleted(records, "bots-idle");

    const interval = Math.max(1, options.sampleIntervalSeconds);
    let remaining = validSeconds(options.idleSeconds);

    while (remaining > 0) {
      const step = Math.min(interval, remaining);

      if (!sleep(context, step)) {
        context.err("The measurement idle window could not be completed.");

        return 1;
      }

      remaining -= step;
      samples.push(captureSample(context, "idle-hour", options.botCount));
    }

    if (options.idleSeconds === 0) {
      samples.push(captureSample(context, "idle-hour", options.botCount));
    }
    records = markCompleted(records, "idle-hour");

    if (!runProviderAction(context, "work", "offline", options.botCount)) {
      return 1;
    }
    samples.push(captureSample(context, "bots-offline-working", options.botCount));
    records = markCompleted(records, "bots-offline-working");

    if (!runProviderAction(context, "work", "docker", options.botCount)) {
      return 1;
    }
    samples.push(captureSample(context, "bots-docker-working", options.botCount));
    records = markCompleted(records, "bots-docker-working");

    for (const provider of [...startedProviders].reverse()) {
      if (!runProviderAction(context, "destroy", provider, options.botCount)) {
        return 1;
      }
    }
    startedProviders = [];

    if (!runBackupDrill(context)) {
      return 1;
    }
    samples.push(captureSample(context, "backup-restore-drill", options.botCount));
    records = markCompleted(records, "backup-restore-drill");

    const services = aggregateServices(samples);
    const report: DeploymentMeasurementReport = {
      schemaVersion: measurementSchemaVersion,
      measuredAt: new Date().toISOString(),
      host,
      botCount: options.botCount,
      providers: [
        { kind: "offline", bots: options.botCount },
        { kind: "docker", bots: options.botCount },
      ],
      workload: {
        phases: records,
        requestedIdleSeconds: options.idleSeconds,
        sampleIntervalSeconds: options.sampleIntervalSeconds,
      },
      totals: {
        idleMemoryBytes: sumNullable(services.map((service) => service.idleMemoryBytes)),
        peakMemoryBytes: sumNullable(services.map((service) => service.peakMemoryBytes)),
        peakCpuSeconds: sumNullable(services.map((service) => service.peakCpuSeconds)),
      },
      services,
      samples,
    };

    writeOutputs(context, options, report);
    result = 0;

    return 0;
  } finally {
    for (const provider of [...startedProviders].reverse()) {
      runProviderAction(context, "destroy", provider, options.botCount);
    }
    restoreSupervisor(context, options.waitSeconds);

    if (result !== 0) {
      context.err("No measured floor table was written because the workload did not complete.");
    }
  }
}

/** Reads the generated report back for CI shape checks without trusting a cast. */
export function readMeasurementReport(filePath: string): DeploymentMeasurementReport {
  return JSON.parse(readFileSync(filePath, "utf8")) as DeploymentMeasurementReport;
}
