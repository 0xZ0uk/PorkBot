import type { FailureMapping } from "./failures.ts";
import { failureMapping as computerFailures } from "./computer.ts";
import { failureMapping as credentialFailures } from "./credentials.ts";
import { failureMapping as mailFailures } from "./mail.ts";
import { failureMapping as mcpFailures } from "./mcp.ts";
import { failureMapping as memoryFailures } from "./memory.ts";
import { failureMapping as modelRuntimeFailures } from "./model-runtime.ts";
import { failureMapping as notificationFailures } from "./notification.ts";
import { failureMapping as realtimeFailures } from "./realtime.ts";
import { failureMapping as storageFailures } from "./storage.ts";
import { failureMapping as webAccessFailures } from "./web-access.ts";

/**
 * The checked-in roadmap for every interface this package declares (PRD module
 * map: an interface with one implementation is a hypothesis).
 *
 * `@porkbot/adapter-kit` ships declarations and no implementations, so the
 * two-implementations rule cannot be proven from what this package contains:
 * it is proven against this register. Every seam names at least two planned
 * implementations, each pinned to the roadmap slice that lands it, and every
 * seam carries the `FailureMapping` documented beside its interface. A declared
 * interface that is missing here, a seam with fewer than two implementations,
 * or a mapping with an undocumented failure kind fails
 * `provider-plan.test.ts`, so the rule is a check rather than a convention.
 *
 * `status` says whether the implementation already exists in
 * `@porkbot/adapters` (`shipped`) or is still to land (`planned`). The status
 * changes as slices land; the count of implementations never drops below two,
 * which is the property the test enforces.
 *
 * Interfaces that are shapes rather than seams — messages, requests, results,
 * records — are listed in `PROVIDER_SHAPES` instead. Being in that list is the
 * deliberate choice "this describes data and needs no implementation", made
 * once and reviewed like everything else here.
 */

interface PlannedImplementation {
  /** The class or factory the slice is expected to export, as its users will name it. */
  readonly name: string;
  /** The roadmap slice that lands it, by its published id (for example `7.2`). */
  readonly slice: string;
  /** The workspace package that owns it; a slice that needs a new edge updates the module map. */
  readonly owner: string;
  readonly status: "shipped" | "planned";
  /** Why the owner is not `@porkbot/adapters`, where that needs saying. */
  readonly note?: string;
}

interface ProviderInterfacePlan {
  readonly interface: string;
  readonly module: string;
  /** The external capability this seam fronts, in one phrase. */
  readonly capability: string;
  /** The seam's documented mapping of its provider errors onto the shared vocabulary. */
  readonly failures: FailureMapping;
  readonly implementations: readonly PlannedImplementation[];
}

interface ProviderShape {
  readonly module: string;
  readonly interfaces: readonly string[];
}

export const PROVIDER_INTERFACES: readonly ProviderInterfacePlan[] = [
  {
    interface: "TransactionalEmailProvider",
    module: "./mail.ts",
    capability: "transactional mail",
    failures: mailFailures,
    implementations: [
      {
        name: "MailEmulator",
        slice: "3.5",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createHttpMailProvider",
        slice: "3.5",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
    ],
  },
  {
    interface: "CredentialStore",
    module: "./credentials.ts",
    capability: "credential resolution",
    failures: credentialFailures,
    implementations: [
      {
        name: "createEnvironmentCredentialStore",
        slice: "3.5",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createMemoryCredentialStore",
        slice: "3.5",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createEncryptedCredentialStore",
        slice: "9.1",
        owner: "@porkbot/db",
        status: "shipped",
        note: "The encrypted rows need the database driver, which the module map gives to @porkbot/db. The store implements this interface through the `Credentials` seam in @porkbot/effect, which extends it.",
      },
    ],
  },
  {
    interface: "ComputerProvider",
    module: "./computer.ts",
    capability: "a bot's computer: shell, files, browser, snapshots",
    failures: computerFailures,
    implementations: [
      {
        name: "ComputerEmulator",
        slice: "6.9",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createSupervisorComputerProvider",
        slice: "7.1",
        owner: "@porkbot/adapters",
        status: "shipped",
        note: "The client half of the supervisor boundary: a process reaches a computer by speaking to the supervisor's authenticated lifecycle surface, so the caller holds neither the Docker socket nor a provider credential. The API holds one today; the worker's provider wiring lands with the Docker provider.",
      },
      {
        name: "createDockerComputerProvider",
        slice: "7.2",
        owner: "@porkbot/adapters",
        status: "shipped",
        note: "Runs inside the supervisor process only: the provider is the thing that holds the Docker socket, and the supervisor is the only process that may construct it. It speaks the Engine API over that socket, creates the per-computer internal network, bounds CPU, memory, an independent and smaller swap allowance, processes and (optionally) disk per bot, parks idle machines and keeps the home volume through stop, destroy and reset.",
      },
      {
        name: "createDaytonaComputerProvider",
        slice: "7.3",
        owner: "@porkbot/adapters",
        status: "shipped",
        note: "The cloud implementation, chosen over E2B and Box because its control plane and sandbox toolbox are plain REST + JSON with a published OpenAPI document, so the adapter and its offline emulator speak the real wire without a generated Connect client. It shares the lifecycle composition in computer-runtime.ts with the Docker runtime, is selected per bot through the bot's computer settings, and leaves the reserved frames()/input() path unimplemented.",
      },
    ],
  },
  {
    interface: "CredentialProxyAdmin",
    module: "./computer.ts",
    capability:
      "the run-scoped grant a computer's credential proxy holds, so no key ever enters a sandbox",
    failures: computerFailures,
    implementations: [
      {
        name: "ComputerEmulator",
        slice: "7.8",
        owner: "@porkbot/adapters",
        status: "shipped",
        note: "Runs the real credential-proxy server on loopback, so the grant file, the capability check and the upstream allowlist are exercised offline over real HTTP with no daemon and no keys.",
      },
      {
        name: "createDockerComputerProvider",
        slice: "7.8",
        owner: "@porkbot/adapters",
        status: "shipped",
        note: "Runs the proxy as a per-computer sidecar on the computer's own isolated network — the only network peer a sandbox can reach — plus the deployment's egress network for the upstream leg. Grants are written through the daemon's archive API, so the Docker socket holder is the only writer and the material never crosses the sandbox's boundary. The cloud provider joins this seam when its sandbox boundary can place a proxy peer.",
      },
    ],
  },
  {
    interface: "ModelRuntimeProvider",
    module: "./model-runtime.ts",
    capability: "the model endpoint the agent loop talks to",
    failures: modelRuntimeFailures,
    implementations: [
      {
        name: "ModelEmulator",
        slice: "5.4",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createOpenAiCompatibleModelRuntime",
        slice: "9.2",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
    ],
  },
  {
    interface: "McpServerProvider",
    module: "./mcp.ts",
    capability: "installing an MCP server by URL, discovering its tools and calling them",
    failures: mcpFailures,
    implementations: [
      {
        name: "McpServerEmulator",
        slice: "9.5",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createHttpMcpServerProvider",
        slice: "9.5",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
    ],
  },
  {
    interface: "MemoryProvider",
    module: "./memory.ts",
    capability: "memory document retrieval and ranking",
    failures: memoryFailures,
    implementations: [
      {
        name: "MemoryEmulator",
        slice: "8.1",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createHttpMemoryProvider",
        slice: "8.1",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
    ],
  },
  {
    interface: "NotificationProvider",
    module: "./notification.ts",
    capability: "operator notifications",
    failures: notificationFailures,
    implementations: [
      {
        name: "NotificationEmulator",
        slice: "8.6",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createHttpNotificationProvider",
        slice: "8.6",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
    ],
  },
  {
    interface: "RealtimeFanout",
    module: "./realtime.ts",
    capability: "live event wake-ups across processes",
    failures: realtimeFailures,
    implementations: [
      {
        name: "InProcessRealtimeFanout",
        slice: "4.3",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "PostgresRealtimeFanout",
        slice: "6.1",
        owner: "@porkbot/db",
        status: "planned",
        note: "LISTEN/NOTIFY needs the Postgres driver, which the module map gives to @porkbot/db; slice 6.1 adds the adapter-kit edge as its one-line map change.",
      },
    ],
  },
  {
    interface: "StorageProvider",
    module: "./storage.ts",
    capability: "homes, attachments, artifacts and backups",
    failures: storageFailures,
    implementations: [
      {
        name: "LocalStorageProvider",
        slice: "7.7",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "S3CompatibleStorageProvider",
        slice: "7.7",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
    ],
  },
  {
    interface: "WebAccessProvider",
    module: "./web-access.ts",
    capability: "web fetch and search",
    failures: webAccessFailures,
    implementations: [
      {
        name: "WebAccessEmulator",
        slice: "10.1",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
      {
        name: "createHttpWebAccessProvider",
        slice: "10.1",
        owner: "@porkbot/adapters",
        status: "shipped",
      },
    ],
  },
];

export const PROVIDER_SHAPES: readonly ProviderShape[] = [
  {
    module: "./failures.ts",
    interfaces: ["ProviderFailure"],
  },
  {
    module: "./mail.ts",
    interfaces: ["TransactionalEmailMessage", "TransactionalEmailReceipt"],
  },
  {
    module: "./computer.ts",
    interfaces: [
      "ComputerRef",
      "ComputerStatus",
      "ComputerExecRequest",
      "ComputerExecResult",
      "ComputerSnapshot",
      "ComputerFrame",
      "ComputerProxyGrant",
      "ComputerProxyEndpoint",
      "ProxyUpstreamGrant",
    ],
  },
  {
    module: "./model-runtime.ts",
    interfaces: [
      "ModelConnection",
      "ModelDescriptor",
      "ModelProbeResult",
      "ModelMessage",
      "ModelToolCall",
      "ModelToolDefinition",
      "ModelTurnRequest",
    ],
  },
  {
    module: "./mcp.ts",
    interfaces: [
      "McpToolDescriptor",
      "McpServerDescription",
      "McpDiscoverRequest",
      "McpCallRequest",
      "McpCallResult",
      "McpAuthorizationRequest",
      "McpCodeExchangeRequest",
      "McpOAuthTokens",
    ],
  },
  {
    module: "./memory.ts",
    interfaces: ["MemoryEntry", "MemorySearchRequest", "MemoryMatch"],
  },
  {
    module: "./notification.ts",
    interfaces: ["OperatorNotification", "NotificationReceipt"],
  },
  {
    module: "./realtime.ts",
    interfaces: ["ThreadSignal"],
  },
  {
    module: "./storage.ts",
    interfaces: ["StorageObject", "StoragePutRequest", "StorageBody"],
  },
  {
    module: "./home-sync.ts",
    interfaces: ["ComputerHomeSyncStory"],
  },
  {
    module: "./web-access.ts",
    interfaces: ["WebFetchRequest", "WebFetchResult", "WebSearchRequest", "WebSearchResult"],
  },
];
