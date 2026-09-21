import { randomBytes as systemRandomBytes } from "node:crypto";

/**
 * The deployment value register (slice 12.1, PRD stories 1 and 2).
 *
 * Every value in deploy/porkbot.env.example that is not a plain operator
 * setting is a sentinel, and this register is the whole list: which key it
 * belongs to, which sentinel the template must carry for it, how it is
 * produced, and why it exists. `renderDeploymentEnv` refuses a key whose
 * template value is not this sentinel and refuses a sentinel whose key is not
 * here, so a typo cannot produce a deployment where a secret is the literal
 * text `@genrate`, and the template cannot quietly grow a hand-invented key.
 *
 * Generated material is deliberately dull and shell-safe:
 *
 *   - Database passwords are 24 random bytes as hex, because they are spliced
 *     into `postgres://` connection strings and a `+`, `/` or `=` would break
 *     the URL instead of failing loudly.
 *   - Tokens and signing keys are 32 random bytes as base64url, because they
 *     travel through Compose interpolation and container environments.
 *   - The credential keyring is one AES-256 key (32 bytes, base64) under the
 *     id `k1`, the shape `credentialKeyringFromEnvironment` in @porkbot/db
 *     parses. Rotation is adding `k2` and flipping the active id, not editing
 *     ciphertext.
 */

export type DeploymentValueKind =
  /** A generated 24-byte hex password; URL-safe by construction. */
  | "generated-password"
  /** A generated 32-byte base64url token or signing key. */
  | "generated-token"
  /** A generated `k1:<base64 32-byte key>` keyring (credentials or backups). */
  | "generated-keyring"
  /** The proxy capability token, generated only when the proxy is enabled. */
  | "generated-proxy-token"
  /** The public origin from `--origin`. */
  | "setup-origin"
  /** The web origin, defaulting to the public origin. */
  | "setup-web-origin"
  /** `<origin>/oauth/mcp/callback`, unless overridden. */
  | "setup-mcp-callback-url"
  /** The release tag from `--tag`, defaulting to the checkout's git SHA. */
  | "setup-image-tag"
  /** The machine image from `--computer-image`, when a real provider is enabled. */
  | "setup-computer-image"
  /** The credential-proxy image from `--proxy-image`, when enabled. */
  | "setup-proxy-image"
  /** The egress network from `--egress-network`, when enabled. */
  | "setup-proxy-egress-network";

/**
 * Kinds that are absent unless the operator enables them. The credential proxy
 * is the only one: the supervisor refuses a partial proxy configuration at
 * boot, so the template leaves all three settings empty and `setup` fills them
 * (generating the token) only when `--proxy-image` and `--egress-network` name
 * a proxy. The machine image is also optional because the default deployment
 * uses only the offline provider.
 */
export const optionalDeploymentValueKinds: ReadonlySet<DeploymentValueKind> = new Set([
  "generated-proxy-token",
  "setup-computer-image",
  "setup-proxy-image",
  "setup-proxy-egress-network",
]);

export interface DeploymentValuePlan {
  /** The environment variable the value is written to. */
  readonly key: string;
  /** The exact template value `deploy:setup` replaces. */
  readonly sentinel: string;
  readonly kind: DeploymentValueKind;
  /** Why the value exists, in the words the operator reads. */
  readonly why: string;
}

/** The sentinel for every simple generated secret. */
export const generatedSecretSentinel = "@generate";

/** The sentinel for the credential keyring, whose shape differs. */
export const generatedKeyringSentinel = "@generate-keyring";

/**
 * One register for every sentinel in the template. Order is the order the
 * `setup` command reports; it is not otherwise significant.
 */
export const deploymentValuePlans: readonly DeploymentValuePlan[] = [
  {
    key: "PORKBOT_POSTGRES_PASSWORD",
    sentinel: generatedSecretSentinel,
    kind: "generated-password",
    why: "the Postgres superuser's password",
  },
  {
    key: "PORKBOT_API_DB_PASSWORD",
    sentinel: generatedSecretSentinel,
    kind: "generated-password",
    why: "the api database role's password",
  },
  {
    key: "PORKBOT_WORKER_DB_PASSWORD",
    sentinel: generatedSecretSentinel,
    kind: "generated-password",
    why: "the worker database role's password",
  },
  {
    key: "PORKBOT_AUTH_SECRET",
    sentinel: generatedSecretSentinel,
    kind: "generated-token",
    why: "signs operator sessions and tokens",
  },
  {
    key: "PORKBOT_SUPERVISOR_TOKEN",
    sentinel: generatedSecretSentinel,
    kind: "generated-token",
    why: "authenticates the API to the supervisor's internal surface",
  },
  {
    key: "PORKBOT_SCREEN_TOKEN_SECRET",
    sentinel: generatedSecretSentinel,
    kind: "generated-token",
    why: "signs short-lived screen capabilities",
  },
  {
    key: "PORKBOT_PROXY_TOKEN_SECRET",
    sentinel: "@generate-if-proxy",
    kind: "generated-proxy-token",
    why: "signs the credential proxy's run capabilities",
  },
  {
    key: "PORKBOT_CREDENTIAL_KEYS",
    sentinel: generatedKeyringSentinel,
    kind: "generated-keyring",
    why: "the AES-256 keyring that encrypts stored credentials at rest",
  },
  {
    key: "PORKBOT_BACKUP_KEYS",
    sentinel: generatedKeyringSentinel,
    kind: "generated-keyring",
    why: "the AES-256 keyring that encrypts backups at rest",
  },
  {
    key: "PORKBOT_BACKUP_ENVELOPE_PASSPHRASE",
    sentinel: generatedSecretSentinel,
    kind: "generated-token",
    why: "seals the backup key envelope an operator keeps off the host",
  },
  {
    key: "PORKBOT_AUTH_ORIGIN",
    sentinel: "@origin",
    kind: "setup-origin",
    why: "the one public origin sessions and links are bound to",
  },
  {
    key: "PORKBOT_WEB_ORIGIN",
    sentinel: "@web-origin",
    kind: "setup-web-origin",
    why: "the origin notification links point at",
  },
  {
    key: "PORKBOT_MCP_CALLBACK_URL",
    sentinel: "@mcp-callback-url",
    kind: "setup-mcp-callback-url",
    why: "the absolute URL the MCP OAuth consent flow returns to",
  },
  {
    key: "PORKBOT_IMAGE_TAG",
    sentinel: "@image-tag",
    kind: "setup-image-tag",
    why: "tags every built image with the release it came from",
  },
  {
    key: "PORKBOT_COMPUTER_IMAGE",
    sentinel: "@computer-image",
    kind: "setup-computer-image",
    why: "the machine image a Docker or cloud provider boots",
  },
  {
    key: "PORKBOT_COMPUTER_PROXY_IMAGE",
    sentinel: "@proxy-image",
    kind: "setup-proxy-image",
    why: "the credential proxy sidecar the deployment runs",
  },
  {
    key: "PORKBOT_COMPUTER_EGRESS_NETWORK",
    sentinel: "@proxy-egress-network",
    kind: "setup-proxy-egress-network",
    why: "the egress network the proxy sidecar's second leg joins",
  },
];

/** The credential key id the generated keyring writes under. */
export const generatedCredentialKeyId = "k1";

const planByKey = new Map(deploymentValuePlans.map((plan) => [plan.key, plan]));

export function deploymentValuePlanFor(key: string): DeploymentValuePlan | undefined {
  return planByKey.get(key);
}

/**
 * Generates every secret the register declares. The keyring is generated as a
 * unit so the key and the id the template names cannot disagree. The RNG is a
 * parameter so a test can pin the bytes it asserts on.
 */
export function generateDeploymentSecrets(
  randomBytes: (size: number) => Buffer = systemRandomBytes,
  options: { readonly credentialProxy?: boolean } = {},
): Map<string, string> {
  const values = new Map<string, string>();

  for (const plan of deploymentValuePlans) {
    switch (plan.kind) {
      case "generated-password":
        values.set(plan.key, randomBytes(24).toString("hex"));
        break;
      case "generated-token":
        values.set(plan.key, randomBytes(32).toString("base64url"));
        break;
      case "generated-keyring":
        values.set(plan.key, `${generatedCredentialKeyId}:${randomBytes(32).toString("base64")}`);
        break;
      case "generated-proxy-token":
        if (options.credentialProxy === true) {
          values.set(plan.key, randomBytes(32).toString("base64url"));
        }
        break;
      default:
        break;
    }
  }

  return values;
}
