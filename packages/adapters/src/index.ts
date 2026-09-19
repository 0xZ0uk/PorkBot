export const moduleInfo = {
  name: "@porkbot/adapters",
  summary: "Provider implementations and offline emulators, one file per provider.",
} as const;

// Transactional mail (slice 3.5). The interface lives in @porkbot/adapter-kit;
// this package ships the two implementations the rule requires: the offline
// emulator whose mailbox tests read, and one real provider configured by URL
// and key. The auth flows depend on the interface, so neither is named there.
export { MailEmulator } from "./mail-emulator.ts";
export type { DeliveredMail } from "./mail-emulator.ts";
export { MailConfigurationError, MailDeliveryError } from "./mail-errors.ts";
export type { MailConfigurationReason, MailDeliveryFailure } from "./mail-errors.ts";
export { createHttpMailProvider } from "./http-mail.ts";
export type { HttpMailProviderOptions } from "./http-mail.ts";

// Model runtime (slice 5.4). The emulator owns a loopback OpenAI-compatible
// endpoint and drives it with deterministic scripts, so lifecycle tests cross
// the real HTTP/SSE boundary without a credential or an external connection.
export { ModelEmulator } from "./model-emulator.ts";
export type {
  ModelEmulatorExpectedRequest,
  ModelEmulatorGateReason,
  ModelEmulatorScript,
  ModelEmulatorStep,
  ModelEmulatorTurn,
  RecordedModelRequest,
} from "./model-emulator.ts";
export { ModelProviderError } from "./model-errors.ts";
// The real OpenAI-compatible provider (slice 9.2): one interface for a hosted
// provider and a self-hosted endpoint by URL and stored credential name, with
// the URL-safety module on the wire and no provider-specific environment
// variable. The wire client inside it is the same one the emulator's provider
// half drives, so the tested transport and the shipped transport are one.
export { createOpenAiCompatibleModelRuntime } from "./openai-compatible.ts";
export type { OpenAiCompatibleModelRuntimeOptions } from "./openai-compatible.ts";

// Credential stores. The provider resolves its key by name through the
// `CredentialStore` interface; these are the bootstrap (environment) and test
// (memory) implementations. Slice 9.1's encrypted store plugs in behind the
// same interface without touching a provider.
export { createEnvironmentCredentialStore, createMemoryCredentialStore } from "./credentials.ts";
export type { MemoryCredentialStore } from "./credentials.ts";

// The realtime fanout's in-process implementation (slice 4.3). It carries
// wake-ups only, so the API's SSE subscriptions resume from durable event rows
// whatever the fanout forgets; the durable cross-process implementation over
// Postgres LISTEN/NOTIFY lands in slice 6.1 behind the same interface.
export { InProcessRealtimeFanout } from "./realtime.ts";

// Storage (slice 7.7). The local provider is the self-hosting default: one
// directory, no endpoint, no key and no network, so nothing in the product
// requires the S3-compatible implementation to exist. That one signs its own
// requests (SigV4) over the URL-safety module's egress door and resolves its
// keys from the credential store by name; the offline emulator is the S3 wire
// the provider is conformance-tested against, over loopback with no keys that
// are real.
export { LocalStorageProvider } from "./local-storage.ts";
export type { LocalStorageProviderOptions } from "./local-storage.ts";
export { S3CompatibleStorageProvider } from "./s3-storage.ts";
export type { S3CompatibleStorageProviderOptions } from "./s3-storage.ts";
export { S3StorageEmulator } from "./s3-storage-emulator.ts";
export type {
  RecordedS3Request,
  S3StorageEmulatorOptions,
  StoredS3Object,
} from "./s3-storage-emulator.ts";
export { assertStorageKey } from "./storage-keys.ts";
export {
  StorageConfigurationError,
  StorageKeyError,
  StorageProtocolError,
  StorageProviderError,
} from "./storage-errors.ts";
export type { StorageConfigurationReason } from "./storage-errors.ts";

// The offline agent runtime (slice 5.2, PRD decision 13). It speaks the duplex
// `RunSession` seam from @porkbot/effect over deterministic mailboxes, so the
// whole run lifecycle — commands reaching a live run, fences interrupting it,
// cancellation and failure reports — is exercisable with no keys and no
// network. Slice 5.3 adapts Pi to the same seam in this package.
export { EmulatorScriptError, emulatorAgentRuntimeLayer } from "./agent-runtime-emulator.ts";
export type { EmulatorRuntimeOptions, EmulatorStep } from "./agent-runtime-emulator.ts";

// The Pi adapter (slice 5.3, PRD decision 13). Pi's async iterator of
// canonical events is adapted to the same duplex `RunSession` seam, through an
// explicit mapping table that fails typed on an unknown event, and tested
// against a golden corpus of recorded sessions on every pin change. The live
// launch that builds a `PiRunSource` from a real Pi `Agent` belongs with the
// run executor; `recordedPiRunSource` is the offline source the corpus replays.
export {
  MalformedPiEvent,
  PI_EVENT_MAPPING,
  PiEventError,
  PiEventSequenceError,
  PiRunTranslator,
  parsePiEvent,
  UnknownPiEventField,
  UnknownPiEventType,
  UnknownPiMessageEventType,
} from "./pi-events.ts";
export type {
  ParsedPiEvent,
  PiAssistantMessageEventType,
  PiEventMapping,
  PiEventParseResult,
  PiEventType,
  PiStopReason,
  PiTranslationBase,
  PiTranslationResult,
} from "./pi-events.ts";
export {
  piAgentRuntimeLayer,
  PiRunControlError,
  PiRunError,
  PiRunSourceEnded,
  PiRunSourceError,
  recordedPiRunSource,
} from "./pi-run-source.ts";
export type { PiApprovalDecision, PiRunControls, PiRunSource } from "./pi-run-source.ts";

// Memory retrieval (slice 8.1, PRD decision 21). The interface lives in
// @porkbot/adapter-kit; this package ships the two implementations the rule
// requires plus the recall composition between them. The emulator is the
// deterministic lexical index the product runs on with no provider configured;
// the HTTP provider is reached by URL and credential name like every other
// seam; `MemoryRecall` prefers the real provider and degrades to the emulator
// on a classified provider failure, so no run depends on a hosted vendor to
// remember something.
export { MemoryEmulator } from "./memory-emulator.ts";
export { MemoryConfigurationError, MemoryProviderError } from "./memory-errors.ts";
export type { MemoryConfigurationReason } from "./memory-errors.ts";
export { createHttpMemoryProvider } from "./http-memory.ts";
export type { HttpMemoryProviderOptions } from "./http-memory.ts";
export { MemoryRecall } from "./memory-recall.ts";
export type { MemoryRecallOperation, MemoryRecallOptions } from "./memory-recall.ts";

// Operator notifications (slice 8.6, PRD decision 33; stories 35). The interface
// lives in @porkbot/adapter-kit; this package ships the two implementations the
// rule requires, held to one conformance suite. The emulator is the delivery
// path the product runs on with nothing configured; the HTTP provider reaches a
// webhook by URL and credential name like every other seam, and its request body
// is an allowlist of the three fields the interface names, so a credential or a
// raw tool argument can never ride along to a third party.
export { NotificationEmulator } from "./notification-emulator.ts";
export type { DeliveredNotification } from "./notification-emulator.ts";
export {
  NotificationConfigurationError,
  NotificationProviderError,
} from "./notification-errors.ts";
export type { NotificationConfigurationReason } from "./notification-errors.ts";
export { createHttpNotificationProvider } from "./http-notification.ts";
export type { HttpNotificationProviderOptions } from "./http-notification.ts";

// A bot's computer (slice 6.9, PRD decisions 20 and 30; stories 27–30). The
// interface lives in @porkbot/adapter-kit; this package ships the offline
// implementation the whole tool path runs on with no daemon, no key and no
// network, and the first of the seam's three named providers to land. Its
// filesystem, bounded shell and scripted browser are reached only through
// `exec`, exactly as a real container is, so the file, shell and browser tools
// in @porkbot/effect run unchanged against either. `computer-conformance.ts`
// is the suite every provider is held to, registered here and by the Docker
// provider when it lands.
export { ComputerEmulator, DEFAULT_COMPUTER_HOME } from "./computer-emulator.ts";
export type {
  ComputerEmulatorOptions,
  EmulatedBrowserAction,
  EmulatedComputerPage,
  RecordedBrowserAction,
} from "./computer-emulator.ts";
export { ComputerProviderError } from "./computer-errors.ts";

// Web access (slices 6.9 and 10.1, PRD decision 30). The interface lives in
// @porkbot/adapter-kit; this package ships the two implementations the rule
// requires, held to one conformance suite. The emulator is the deterministic
// scripted web the product runs on with nothing configured; the HTTP provider
// dials every page through the URL-safety module's `safeFetch` by default and
// reaches search by URL and credential name. Both return raw pages on purpose:
// the tool layer that consumes them labels the content untrusted and holds it
// out of the instruction channel (slice 10.1).
export { WebAccessEmulator } from "./web-access-emulator.ts";
export type { EmulatedFailure, EmulatedPage } from "./web-access-emulator.ts";
export { WebAccessConfigurationError, WebAccessProviderError } from "./web-access-errors.ts";
export type { WebAccessConfigurationReason } from "./web-access-errors.ts";
export { createHttpWebAccessProvider } from "./http-web-access.ts";
export type { HttpWebAccessOptions, HttpWebAccessSearchOptions } from "./http-web-access.ts";

// MCP servers (slice 9.5, PRD story 38). The interface lives in
// @porkbot/adapter-kit; this package ships the two implementations the rule
// requires, held to one conformance suite. The emulator is the scripted server
// the product runs on with nothing configured — it is what install, discovery
// and the run path are exercised against offline — and the HTTP provider speaks
// the streamable-HTTP JSON-RPC transport through the URL-safety module by
// default, with OAuth metadata, authorization and token endpoints. Neither
// provider formats a credential: tokens are passed per request, so the
// encrypted store stays the only place a secret rests.
export { McpServerEmulator } from "./mcp-emulator.ts";
export type { EmulatedMcpAnswer, EmulatedMcpFailure, EmulatedMcpOAuth } from "./mcp-emulator.ts";
export { McpProviderError } from "./mcp-errors.ts";
export { createHttpMcpServerProvider } from "./http-mcp-server.ts";
export type { HttpMcpServerOptions } from "./http-mcp-server.ts";
export { mcpServerConformance } from "./mcp-conformance.ts";
export type {
  McpServerConformanceFactory,
  McpServerConformanceHarness,
} from "./mcp-conformance.ts";

// The adversarial fixtures for the injection-resistance suite (slice 10.1, for
// E10.4): hostile content as each ingestion path receives it, labelled through
// the same boundary the product uses, with a marker that must never surface as
// an instruction or an action. The coverage test beside them fails when an
// `INGESTION_PATHS` entry has no fixture. They live beside the emulators for
// the same reason the recorded Pi corpus does: a fixture that ships with the
// adapter is the one the offline suite can replay.
export { fixturesFor, INJECTION_FIXTURES, labelledFixture } from "./ingestion-fixtures.ts";
export type { InjectionFixture } from "./ingestion-fixtures.ts";
