/**
 * The deployment env file's rules (slice 12.1, PRD stories 2 and 4).
 *
 * `deploy:check` and `deploy:up` run `validateDeploymentEnv` before anything
 * touches Docker, so a missing secret, a placeholder from the local stack, a
 * password that breaks its connection string or an unresolved template
 * sentinel fails by name instead of degrading into a stack that boots and then
 * cannot serve. The application processes still own their own boot checks;
 * this is the earlier, louder one.
 *
 * The rules mirror requirements the code already enforces, deliberately as a
 * second reading of the same facts:
 *
 *   - The required set is the compose file's `${NAME:?}` set, and the test
 *     suite reads deploy/compose.yaml and fails when the two drift.
 *   - The keyring shape and active-id rule mirror
 *     `credentialKeyringFromEnvironment` in @porkbot/db. That module is not
 *     importable from this package, and Node runs this CLI without an install
 *     on a fresh host, so the check is re-expressed rather than linked.
 */

export interface DeploymentProblem {
  /** The environment variable the problem is about. */
  readonly key: string;
  readonly message: string;
}

/**
 * Every value the stack cannot start without. This is the set of `${NAME:?}`
 * references in deploy/compose.yaml; `test/deployment.test.ts` compares them.
 */
export const requiredDeploymentKeys: readonly string[] = [
  "PORKBOT_IMAGE_TAG",
  "PORKBOT_POSTGRES_PASSWORD",
  "PORKBOT_API_DB_PASSWORD",
  "PORKBOT_WORKER_DB_PASSWORD",
  "PORKBOT_AUTH_SECRET",
  "PORKBOT_AUTH_ORIGIN",
  "PORKBOT_WEB_ORIGIN",
  "PORKBOT_SUPERVISOR_TOKEN",
  "PORKBOT_SCREEN_TOKEN_SECRET",
  "PORKBOT_CREDENTIAL_KEYS",
  "PORKBOT_CREDENTIAL_ACTIVE_KEY",
  "PORKBOT_BACKUP_KEYS",
  "PORKBOT_BACKUP_ACTIVE_KEY",
  "PORKBOT_BACKUP_ENVELOPE_PASSPHRASE",
  "PORKBOT_COMPUTER_PROVIDER",
];

/** Secrets a hand-written value is validated against. */
export const secretDeploymentKeys: readonly string[] = [
  "PORKBOT_POSTGRES_PASSWORD",
  "PORKBOT_API_DB_PASSWORD",
  "PORKBOT_WORKER_DB_PASSWORD",
  "PORKBOT_AUTH_SECRET",
  "PORKBOT_SUPERVISOR_TOKEN",
  "PORKBOT_SCREEN_TOKEN_SECRET",
  "PORKBOT_PROXY_TOKEN_SECRET",
  "PORKBOT_BACKUP_ENVELOPE_PASSPHRASE",
];

/** Passwords spliced into `postgres://` URLs must not need escaping. */
export const urlSafePasswordKeys: readonly string[] = [
  "PORKBOT_POSTGRES_PASSWORD",
  "PORKBOT_API_DB_PASSWORD",
  "PORKBOT_WORKER_DB_PASSWORD",
];

export const minimumSecretLength = 24;

const urlSafePattern = /^[A-Za-z0-9._~-]+$/;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const imageTagPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const credentialKeyIdPattern = /^[A-Za-z0-9_-]{1,32}$/;
const providerKinds = new Set(["offline", "docker", "daytona"]);
const logLevels = new Set(["debug", "info", "warn", "error"]);

/** Release tags are immutable names, never a moving `latest` pointer. */
export function isDeploymentImageTag(value: string): boolean {
  return imageTagPattern.test(value) && value.toLowerCase() !== "latest";
}

/**
 * Values that read as a decision nobody made: the local stack's placeholders
 * and the obvious filler. Exact matches only, so a random secret that happens
 * to contain a word is never refused.
 */
const placeholderValues = new Set([
  "porkbot-local",
  "porkbot-api-local",
  "porkbot-worker-local",
  "porkbot-supervisor-local",
  "porkbot-screen-local",
  "change-me",
  "changeme",
  "password",
  "passw0rd",
  "secret",
  "placeholder",
  "example",
  "test",
  "admin",
  "postgres",
]);

/** Hosts where plain http is a local surface rather than an exposure. */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function trimmed(
  env: ReadonlyMap<string, string>,
  key: string,
): { present: boolean; value: string } {
  const raw = env.get(key);

  return { present: raw !== undefined, value: raw?.trim() ?? "" };
}

function originProblem(raw: string): string | undefined {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return "must be an absolute URL, e.g. https://bots.example.com";
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return `must be http or https; it names the ${url.protocol.replace(":", "")} protocol`;
  }

  if (url.username !== "" || url.password !== "") {
    return "must not carry embedded credentials";
  }

  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return "must be an origin with no path, query or fragment";
  }

  // The proxy publishes 80 and 443 and nothing else; the WHATWG URL parser
  // drops a default port, so a non-empty one is a port Caddy would bind
  // inside the container and the host would never forward.
  if (url.port !== "") {
    return `must not name port ${url.port}; the reverse proxy publishes 80 and 443`;
  }

  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    return "must be https outside loopback; a cookie origin over plain http is a session leak";
  }

  return undefined;
}

function absoluteUrlProblem(raw: string): string | undefined {
  let url: URL;

  try {
    url = new URL(raw);
  } catch {
    return "must be an absolute URL";
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "must be http or https";
  }

  if (url.username !== "" || url.password !== "") {
    return "must not carry embedded credentials";
  }

  if (url.protocol === "http:" && !loopbackHosts.has(url.hostname)) {
    return "must be https outside loopback";
  }

  return undefined;
}

function portProblem(raw: string): string | undefined {
  if (!/^\d+$/.test(raw)) {
    return "must be a whole port number";
  }

  const port = Number(raw);

  return port >= 1 && port <= 65535 ? undefined : "must be between 1 and 65535";
}

function integerProblem(raw: string, minimum: number): string | undefined {
  if (!/^\d+$/.test(raw)) {
    return "must be a whole number";
  }

  return Number(raw) >= minimum ? undefined : `must be at least ${minimum}`;
}

/**
 * Validates a keyring the way its module does: `id:base64key` entries whose
 * keys decode to exactly 32 bytes, no duplicate ids, and an active id that
 * names one of them. The credential keyring and the backup keyring have the
 * same shape and different material, so both are checked, each under its own
 * variable names.
 */
function keyringProblemsFor(
  env: ReadonlyMap<string, string>,
  keysKey: string,
  activeKey: string,
): DeploymentProblem[] {
  const problems: DeploymentProblem[] = [];
  const keyring = trimmed(env, keysKey).value;
  const active = trimmed(env, activeKey).value;

  if (keyring === "") {
    return problems;
  }

  const entries = keyring
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length === 0) {
    return [
      {
        key: keysKey,
        message: "must declare at least one id:base64key entry",
      },
    ];
  }

  const ids = new Set<string>();

  entries.forEach((entry, index) => {
    const separator = entry.indexOf(":");
    const label = `entry ${String(index + 1)}`;

    if (separator <= 0 || separator === entry.length - 1) {
      problems.push({
        key: keysKey,
        message: `${label} must be id:base64key`,
      });
      return;
    }

    const id = entry.slice(0, separator).trim();
    const key = entry.slice(separator + 1).trim();

    if (!credentialKeyIdPattern.test(id)) {
      problems.push({
        key: keysKey,
        message: `${label} has id ${JSON.stringify(id)}, which must match ${credentialKeyIdPattern.source}`,
      });
      return;
    }

    if (ids.has(id)) {
      problems.push({
        key: keysKey,
        message: `id "${id}" appears twice; a duplicate id makes decryption depend on parse order`,
      });
      return;
    }

    ids.add(id);

    const normalized = key.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(normalized, "base64");
    const canonical =
      decoded.toString("base64").replace(/=+$/, "") === normalized.replace(/=+$/, "");

    if (decoded.length !== 32 || !canonical) {
      problems.push({
        key: keysKey,
        message:
          `key "${id}" must be a base64 32-byte key (openssl rand -base64 32); ` +
          `it decoded to ${String(decoded.length)} bytes`,
      });
    }
  });

  if (active !== "" && !ids.has(active)) {
    problems.push({
      key: activeKey,
      message: `"${active}" does not name a key in ${keysKey}`,
    });
  }

  return problems;
}

/**
 * Every problem with the env file, in a stable order. The caller prints them
 * and refuses to continue; an empty array is the only green.
 */
export function validateDeploymentEnv(env: ReadonlyMap<string, string>): DeploymentProblem[] {
  const problems: DeploymentProblem[] = [];
  const valueOf = (key: string): string => trimmed(env, key).value;

  for (const key of requiredDeploymentKeys) {
    if (valueOf(key) === "") {
      problems.push({ key, message: "is required; run `pnpm deploy:setup` to render it" });
    }
  }

  for (const [key, raw] of env) {
    if (raw.trim().startsWith("@")) {
      problems.push({
        key,
        message: `still carries the template sentinel "${raw.trim()}"; render the file with \`pnpm deploy:setup\``,
      });
    }
  }

  for (const key of secretDeploymentKeys) {
    const value = valueOf(key);

    if (value === "") {
      continue;
    }

    if (placeholderValues.has(value.toLowerCase())) {
      problems.push({
        key,
        message: `is the placeholder "${value}"; generate a real secret`,
      });
      continue;
    }

    if (value.length < minimumSecretLength) {
      problems.push({
        key,
        message: `is shorter than ${String(minimumSecretLength)} characters; generate at least 24 random bytes`,
      });
      continue;
    }

    if (urlSafePasswordKeys.includes(key) && !urlSafePattern.test(value)) {
      problems.push({
        key,
        message:
          "must be URL-safe (hex or base64url); it is spliced into a postgres:// connection string",
      });
    }
  }

  // Distinct secrets are the point of separate roles: one leaked token must
  // not be every token.
  const seenSecretValues = new Map<string, string>();

  for (const key of secretDeploymentKeys) {
    const value = valueOf(key);

    if (value === "") {
      continue;
    }

    const firstKey = seenSecretValues.get(value);

    if (firstKey !== undefined) {
      problems.push({
        key,
        message: `reuses the value of ${firstKey}; every secret must be independent`,
      });
      continue;
    }

    seenSecretValues.set(value, key);
  }

  problems.push(
    ...keyringProblemsFor(env, "PORKBOT_CREDENTIAL_KEYS", "PORKBOT_CREDENTIAL_ACTIVE_KEY"),
    ...keyringProblemsFor(env, "PORKBOT_BACKUP_KEYS", "PORKBOT_BACKUP_ACTIVE_KEY"),
  );

  for (const key of ["PORKBOT_AUTH_ORIGIN", "PORKBOT_WEB_ORIGIN"]) {
    const value = valueOf(key);

    if (value === "") {
      continue;
    }

    const problem = originProblem(value);

    if (problem !== undefined) {
      problems.push({ key, message: problem });
    }
  }

  const callback = valueOf("PORKBOT_MCP_CALLBACK_URL");

  if (callback !== "") {
    const problem = absoluteUrlProblem(callback);

    if (problem !== undefined) {
      problems.push({ key: "PORKBOT_MCP_CALLBACK_URL", message: problem });
    }
  }

  const logLevel = valueOf("LOG_LEVEL");

  if (logLevel !== "" && !logLevels.has(logLevel)) {
    problems.push({
      key: "LOG_LEVEL",
      message: `must be one of ${[...logLevels].join(", ")}; the logger refuses to boot otherwise`,
    });
  }

  for (const key of ["PORKBOT_API_PORT"]) {
    const value = valueOf(key);

    if (value === "") {
      continue;
    }

    const problem = portProblem(value);

    if (problem !== undefined) {
      problems.push({ key, message: problem });
    }
  }

  const postgresUser = valueOf("PORKBOT_POSTGRES_USER");

  if (postgresUser !== "" && !identifierPattern.test(postgresUser)) {
    problems.push({
      key: "PORKBOT_POSTGRES_USER",
      message: "must be a valid Postgres role name (letters, digits and underscores)",
    });
  }

  const postgresDb = valueOf("PORKBOT_POSTGRES_DB");

  if (postgresDb !== "" && !identifierPattern.test(postgresDb)) {
    problems.push({
      key: "PORKBOT_POSTGRES_DB",
      message: "must be a valid Postgres database name (letters, digits and underscores)",
    });
  }

  const imageTag = valueOf("PORKBOT_IMAGE_TAG");

  if (imageTag !== "") {
    if (imageTag.toLowerCase() === "latest") {
      problems.push({
        key: "PORKBOT_IMAGE_TAG",
        message: "must not be `latest`; images are tagged with the release they were built from",
      });
    } else if (!isDeploymentImageTag(imageTag)) {
      problems.push({
        key: "PORKBOT_IMAGE_TAG",
        message: "must be a Docker tag: letters, digits, dots, underscores and hyphens",
      });
    }
  }

  const socket = valueOf("PORKBOT_DOCKER_SOCKET");

  if (socket !== "" && !socket.startsWith("/")) {
    problems.push({ key: "PORKBOT_DOCKER_SOCKET", message: "must be an absolute host path" });
  }

  const socketGid = valueOf("PORKBOT_DOCKER_SOCKET_GID");

  if (socketGid !== "" && (!/^\d+$/.test(socketGid) || Number(socketGid) > 2_147_483_647)) {
    problems.push({
      key: "PORKBOT_DOCKER_SOCKET_GID",
      message: "must be a numeric group id between 0 and 2147483647",
    });
  }

  const provider = valueOf("PORKBOT_COMPUTER_PROVIDER");

  if (provider !== "" && !providerKinds.has(provider)) {
    problems.push({
      key: "PORKBOT_COMPUTER_PROVIDER",
      message: `must be one of ${[...providerKinds].join(", ")}`,
    });
  }

  if (provider === "docker" || provider === "daytona") {
    if (valueOf("PORKBOT_COMPUTER_IMAGE") === "") {
      problems.push({
        key: "PORKBOT_COMPUTER_IMAGE",
        message: `is required by the ${provider} provider`,
      });
    }
  }

  if (provider === "daytona") {
    for (const key of ["PORKBOT_COMPUTER_ENDPOINT", "PORKBOT_COMPUTER_TOKEN"]) {
      if (valueOf(key) === "") {
        problems.push({ key, message: "is required by the daytona provider" });
      }
    }
  }

  const cpus = valueOf("PORKBOT_COMPUTER_CPUS");

  if (cpus !== "" && !(/^\d+(\.\d+)?$/.test(cpus) && Number(cpus) > 0)) {
    problems.push({
      key: "PORKBOT_COMPUTER_CPUS",
      message: "must be a positive number of CPUs",
    });
  }

  for (const key of ["PORKBOT_COMPUTER_MEMORY_MB", "PORKBOT_COMPUTER_DISK_MB"]) {
    const value = valueOf(key);

    if (value === "") {
      continue;
    }

    const problem = integerProblem(value, 1);

    if (problem !== undefined) {
      problems.push({ key, message: problem });
    }
  }

  // Swap is a bound rather than a requirement: zero disables it.
  const swapMb = valueOf("PORKBOT_COMPUTER_SWAP_MB");

  if (swapMb !== "") {
    const problem = integerProblem(swapMb, 0);

    if (problem !== undefined) {
      problems.push({ key: "PORKBOT_COMPUTER_SWAP_MB", message: problem });
    }
  }

  // The disk budget's enforcement mode and its snapshot retention. The
  // supervisor refuses an unknown value at boot; checking the same two here is
  // what makes `deploy:check` catch a typo before a restart.
  const diskQuota = valueOf("PORKBOT_COMPUTER_DISK_QUOTA");

  if (diskQuota !== "" && !["auto", "none", "storage-opt"].includes(diskQuota)) {
    problems.push({
      key: "PORKBOT_COMPUTER_DISK_QUOTA",
      message: "must be one of auto, none, storage-opt",
    });
  }

  const snapshotKeep = valueOf("PORKBOT_COMPUTER_SNAPSHOT_KEEP");

  if (snapshotKeep !== "") {
    const problem = integerProblem(snapshotKeep, 0);

    if (problem !== undefined) {
      problems.push({ key: "PORKBOT_COMPUTER_SNAPSHOT_KEEP", message: problem });
    }
  }

  const idleMs = valueOf("PORKBOT_COMPUTER_IDLE_MS");

  if (idleMs !== "") {
    const problem = integerProblem(idleMs, 0);

    if (problem !== undefined) {
      problems.push({ key: "PORKBOT_COMPUTER_IDLE_MS", message: problem });
    }
  }

  // The three all-or-nothing families the application enforces at boot. The
  // operator learns here instead of from a restarted process.
  const mail = ["PORKBOT_MAIL_ENDPOINT", "PORKBOT_MAIL_FROM", "PORKBOT_MAIL_KEY"];
  const mailConfigured = mail.filter((key) => valueOf(key) !== "").length;

  if (mailConfigured !== 0 && mailConfigured !== mail.length) {
    for (const key of mail) {
      problems.push({ key, message: "must be set together with the other mail settings" });
    }
  }

  const proxy = [
    "PORKBOT_COMPUTER_PROXY_IMAGE",
    "PORKBOT_PROXY_TOKEN_SECRET",
    "PORKBOT_COMPUTER_EGRESS_NETWORK",
  ];
  const proxyConfigured = proxy.filter((key) => valueOf(key) !== "").length;

  if (proxyConfigured !== 0 && proxyConfigured !== proxy.length) {
    for (const key of proxy) {
      problems.push({
        key,
        message: "must be set together with the other credential-proxy settings",
      });
    }
  }

  const backupHour = valueOf("PORKBOT_BACKUP_SCHEDULE_HOUR_UTC");

  if (
    backupHour !== "" &&
    !(integerProblem(backupHour, 0) === undefined && Number(backupHour) <= 23)
  ) {
    problems.push({
      key: "PORKBOT_BACKUP_SCHEDULE_HOUR_UTC",
      message: "must be an hour 0-23 in UTC",
    });
  }

  const backupMinute = valueOf("PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC");

  if (
    backupMinute !== "" &&
    !(integerProblem(backupMinute, 0) === undefined && Number(backupMinute) <= 59)
  ) {
    problems.push({
      key: "PORKBOT_BACKUP_SCHEDULE_MINUTE_UTC",
      message: "must be a minute 0-59",
    });
  }

  for (const key of ["PORKBOT_BACKUP_RETENTION_DAYS", "PORKBOT_BACKUP_DRILL_INTERVAL_DAYS"]) {
    const value = valueOf(key);

    if (value === "") {
      continue;
    }

    const problem = integerProblem(value, 1);

    if (problem !== undefined) {
      problems.push({ key, message: problem });
    }
  }

  const backupS3 = [
    "PORKBOT_BACKUP_S3_ENDPOINT",
    "PORKBOT_BACKUP_S3_BUCKET",
    "PORKBOT_BACKUP_S3_ACCESS_KEY_ID",
    "PORKBOT_BACKUP_S3_SECRET_ACCESS_KEY",
  ];
  const backupS3Configured = backupS3.filter((key) => valueOf(key) !== "").length;

  if (backupS3Configured !== 0 && backupS3Configured !== backupS3.length) {
    for (const key of backupS3) {
      problems.push({
        key,
        message: "must be set together with the other backup S3 settings",
      });
    }
  }

  const webhookUrl = valueOf("PORKBOT_NOTIFICATION_WEBHOOK_URL");
  const webhookKey = valueOf("PORKBOT_NOTIFICATION_WEBHOOK_KEY");

  if (webhookUrl !== "" && webhookKey === "") {
    problems.push({
      key: "PORKBOT_NOTIFICATION_WEBHOOK_KEY",
      message: "is required when PORKBOT_NOTIFICATION_WEBHOOK_URL is set",
    });
  }

  if (webhookKey !== "" && webhookUrl === "") {
    problems.push({
      key: "PORKBOT_NOTIFICATION_WEBHOOK_URL",
      message: "is required when PORKBOT_NOTIFICATION_WEBHOOK_KEY is set",
    });
  }

  return problems;
}
