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

// Credential stores. The provider resolves its key by name through the
// `CredentialStore` interface; these are the bootstrap (environment) and test
// (memory) implementations. Slice 9.1's encrypted store plugs in behind the
// same interface without touching a provider.
export { createEnvironmentCredentialStore, createMemoryCredentialStore } from "./credentials.ts";
export type { MemoryCredentialStore } from "./credentials.ts";
